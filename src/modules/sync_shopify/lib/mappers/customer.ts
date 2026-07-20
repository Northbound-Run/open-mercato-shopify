import { createHash } from 'node:crypto'

/**
 * Shopify `Customer` → the Open Mercato customer graph, as pure data.
 *
 * No framework import, no network, no clock: every value returned is a function of the argument,
 * so the mapping rules can be exercised against fixtures without a container or a store. The
 * adapter owns all I/O; this file owns every decision about what a field MEANS.
 *
 * 🔒 PII. Everything passing through here is personal data — names, emails, phone numbers, postal
 * addresses. This module never logs, and callers must not log what it returns. The compromises it
 * records are reported as CODES (`email_dropped_invalid`), never as the offending value, because
 * those codes travel into the run log, which is retained and widely readable inside the tenant. A
 * value in a diagnostic is a leak that outlives the run that produced it.
 *
 * ACCESSORS — verified against the pinned 2026-07 schema rather than assumed:
 *
 *   `Customer.email`     deprecated → `defaultEmailAddress { emailAddress }`  (CustomerEmailAddress)
 *   `Customer.phone`     deprecated → `defaultPhoneNumber { phoneNumber }`    (CustomerPhoneNumber)
 *   `Customer.addresses` deprecated → `addressesV2`, a `MailingAddressConnection`
 *
 * Addresses are `MailingAddress`. The Admin API has **no `CustomerAddress` type** — that name
 * belongs to the separate Customer Account API, and querying for it fails outright.
 *
 * Each replacement is read with a fallback to the flat field. That is not hedging about the
 * schema: a deprecated field still RESOLVES, so a store pinned to an older version, a hand-written
 * fixture, or a replayed payload keeps mapping instead of silently turning every email into null.
 *
 * THREE CORE VALIDATORS DECIDE WHAT IS EMITTABLE, because `customers.people.create` parses its
 * input with Zod and THROWS — which would fail the entire customer:
 *
 *   - `firstName`/`lastName` are `min(1)`, and the handler re-checks them. Shopify permits a
 *     customer with neither, so a name is SYNTHESISED rather than letting a real customer fail.
 *   - `primaryEmail` is `z.string().email()`.
 *   - `primaryPhone` runs through `isValidPhoneNumber`, which demands a leading `+` and 7–15
 *     digits. Shopify does not guarantee E.164, so a phone that would be rejected is dropped.
 *
 * Dropping one unusable field still imports the customer; forwarding it loses them entirely. Both
 * drops are reported so the adapter can surface them without inventing a failed item.
 */

// ── Shopify wire shapes (Admin GraphQL 2026-07) ──────────────────────────────────────────────
// Deliberately all-optional: these describe what a payload MAY carry, and a field the query did
// not ask for is absent rather than null. Requiring anything here would turn a narrower query
// into a type error instead of a runtime null the mapper already handles.

export type ShopifyMailingAddress = {
  id?: string | null
  address1?: string | null
  address2?: string | null
  city?: string | null
  /** Full subdivision name. `provinceCode` is the ISO fallback. */
  province?: string | null
  provinceCode?: string | null
  /** Full country name. `countryCodeV2` is the fallback — note `countryCode` is the deprecated one. */
  country?: string | null
  countryCodeV2?: string | null
  zip?: string | null
  company?: string | null
  firstName?: string | null
  lastName?: string | null
  /** Shopify's precomposed recipient name. */
  name?: string | null
}

export type ShopifyCustomerNode = {
  id: string
  firstName?: string | null
  lastName?: string | null
  /** Shopify-computed; falls back to the email or a placeholder, so it is a hint, not a name. */
  displayName?: string | null
  /** 2026-07 accessor. */
  defaultEmailAddress?: { emailAddress?: string | null } | null
  /** Deprecated flat field — read only when the accessor above is absent. */
  email?: string | null
  /** 2026-07 accessor. */
  defaultPhoneNumber?: { phoneNumber?: string | null } | null
  /** Deprecated flat field — read only when the accessor above is absent. */
  phone?: string | null
  note?: string | null
  tags?: string[] | null
  /** `CustomerState`: DECLINED | DISABLED | ENABLED | INVITED. */
  state?: string | null
  updatedAt?: string | null
  /**
   * The customer's ENTIRE address set. Shopify sends every address every time, so an address
   * deleted upstream is simply absent — which is what makes per-customer reconciliation possible
   * (and necessary). The bulk path reassembles JSONL children into this same shape.
   */
  addressesV2?: { nodes?: (ShopifyMailingAddress | null)[] | null } | null
  /** Designates which member of `addressesV2` is primary. */
  defaultAddress?: ShopifyMailingAddress | null
}

// ── Mapped output ────────────────────────────────────────────────────────────────────────────

/**
 * A field-level compromise, as a code.
 *
 * Codes rather than messages so a note can be logged and counted freely: none of them can carry
 * the value that caused it, which is the property that makes them safe in a run log.
 */
export type MappingNote =
  | 'name_synthesized'
  | 'email_dropped_invalid'
  | 'phone_dropped_invalid'
  | 'address_dropped_unusable'

export type MappedAddress = {
  /** Mapping key. The `MailingAddress` GID when present — it is already globally unique. */
  externalId: string
  isPrimary: boolean
  /** Core requires a non-empty `addressLine1`, so this is guaranteed non-empty or the row is dropped. */
  addressLine1: string
  addressLine2: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  companyName: string | null
  name: string | null
}

export type MappedCustomer = {
  /** The Shopify customer GID. */
  externalId: string
  displayName: string
  firstName: string
  lastName: string
  primaryEmail: string | null
  primaryPhone: string | null
  /** Shopify's `note`. See `mapCustomer` for why it lands on `description`. */
  description: string | null
  status: string | null
  /**
   * Shopify's tag LABELS, carried for the content hash and for a future tag pass.
   *
   * Not writable as-is: `personCreateSchema.tags` is `z.array(uuid())` — CustomerTag row ids, not
   * labels — and no tag command is declared in `lib/constants.ts`. Passing labels through would
   * fail Zod and take the whole customer down with it, so the adapter deliberately omits them.
   */
  tags: string[]
  /** Drives the run watermark. Deliberately excluded from the content hash — see `customerContentHash`. */
  updatedAt: string | null
  addresses: MappedAddress[]
  notes: MappingNote[]
}

// ── Primitives ───────────────────────────────────────────────────────────────────────────────

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** First non-empty of several candidates — the shape almost every field below resolves through. */
function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const resolved = text(value)
    if (resolved) return resolved
  }
  return null
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

// Column widths from `customers/data/validators.ts`. Truncating here beats a Zod `max()` throw,
// which would cost the whole customer over a long note or an unusually long street line.
const MAX_EMAIL = 320
const MAX_PHONE = 50
const MAX_NAME = 120
const MAX_DISPLAY_NAME = 200
const MAX_DESCRIPTION = 4000
const MAX_ADDRESS_LINE = 300
const MAX_ADDRESS_CITY = 150
const MAX_ADDRESS_REGION = 150
const MAX_ADDRESS_POSTAL = 30
const MAX_ADDRESS_COUNTRY = 150
const MAX_ADDRESS_COMPANY = 200
const MAX_ADDRESS_NAME = 150
const MAX_STATUS = 100

/**
 * Read the current email accessor, falling back to the deprecated flat field.
 *
 * Exported because the adapter's GraphQL documents and this reader have to agree about which
 * fields are selected; keeping the read in one place is what stops them drifting apart.
 */
export function readEmail(node: ShopifyCustomerNode): string | null {
  return firstText(node.defaultEmailAddress?.emailAddress, node.email)
}

/** Read the current phone accessor, falling back to the deprecated flat field. */
export function readPhone(node: ShopifyCustomerNode): string | null {
  return firstText(node.defaultPhoneNumber?.phoneNumber, node.phone)
}

/**
 * Would `z.string().email()` accept this?
 *
 * Intentionally structural rather than exhaustive: the goal is to reject what core would throw on,
 * not to re-implement email validation. Shopify validates on write, so a rejection here is rare
 * and means the value was never usable.
 */
export function isStorableEmail(value: string): boolean {
  if (/\s/.test(value)) return false
  const at = value.indexOf('@')
  // Exactly one `@`, with a local part and a dotted domain either side.
  if (at <= 0 || at !== value.lastIndexOf('@')) return false
  const domain = value.slice(at + 1)
  return domain.length > 2 && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')
}

/**
 * Mirrors `@open-mercato/shared/lib/phone`'s `validatePhoneNumber`, which `primaryPhone` is
 * refined against.
 *
 * Mirrored rather than imported to keep this module free of framework imports — the same reason
 * `lib/writer.ts` mirrors its framework types. The rules are stable and few: one leading `+`,
 * 7–15 digits, and nothing outside the permitted punctuation. Shopify does NOT guarantee E.164,
 * so a national-format number reaching core unchecked would throw and lose the customer.
 */
export function isStorablePhone(value: string): boolean {
  if (!value.startsWith('+')) return false
  if (!/^[+\d\s\-().]+$/.test(value)) return false
  if ((value.match(/\+/g) ?? []).length !== 1) return false
  const digits = (value.match(/\d/g) ?? []).length
  return digits >= 7 && digits <= 15
}

/**
 * Fill core's mandatory `firstName`/`lastName` for a customer Shopify let through without either.
 *
 * The ladder prefers real data over invention: given names first, then the parts of Shopify's
 * computed `displayName`, then the email's local part, and only then a constant. Every rung is a
 * pure function of the payload, so the same customer synthesises the same name on every run —
 * which is what keeps the content hash stable and re-runs idempotent.
 *
 * `nameSynthesized` is true whenever either half did not come from `firstName`/`lastName`, so the
 * adapter can report how many customers arrived nameless without inspecting the names themselves.
 */
export function resolveNames(node: ShopifyCustomerNode): {
  firstName: string
  lastName: string
  displayName: string
  synthesized: boolean
} {
  const given = text(node.firstName)
  const family = text(node.lastName)

  if (given && family) {
    return {
      firstName: clamp(given, MAX_NAME),
      lastName: clamp(family, MAX_NAME),
      displayName: clamp(`${given} ${family}`, MAX_DISPLAY_NAME),
      synthesized: false,
    }
  }

  // `displayName` is Shopify-computed and may itself be a placeholder, so it is only ever used to
  // fill a gap — never to override a name the merchant actually entered.
  const displayParts = (text(node.displayName) ?? '').split(/\s+/).filter(Boolean)
  const email = readEmail(node)
  const emailLocalPart = email ? text(email.split('@')[0]) : null

  const firstName = given ?? firstText(displayParts[0], emailLocalPart) ?? 'Shopify'
  const lastName = family ?? firstText(displayParts.slice(1).join(' ')) ?? 'Customer'

  return {
    firstName: clamp(firstName, MAX_NAME),
    lastName: clamp(lastName, MAX_NAME),
    displayName: clamp(`${firstName} ${lastName}`, MAX_DISPLAY_NAME),
    synthesized: true,
  }
}

/**
 * Map one `MailingAddress`. Null when there is nothing worth storing.
 *
 * `addressLine1` is `min(1)` in core, and Shopify's `address1` is nullable, so the street line
 * falls through `address1 → address2 → city → zip`. An address with none of those carries no
 * locatable information at all and is dropped rather than stored as a placeholder row.
 */
export function mapAddress(
  raw: ShopifyMailingAddress,
  options: { customerExternalId: string; index: number; isPrimary: boolean },
): MappedAddress | null {
  const addressLine1 = firstText(raw.address1, raw.address2, raw.city, raw.zip)
  if (!addressLine1) return null

  // `address2` only becomes the second line when it did not already get promoted to the first.
  const addressLine2 = raw.address1 ? text(raw.address2) : null

  return {
    // A MailingAddress GID is globally unique, so it is its own mapping key. The composite is the
    // fallback for a payload that omits the id: positional, but stable for a given payload, and
    // scoped to the customer so it can never collide with another customer's address.
    externalId: text(raw.id) ?? `${options.customerExternalId}:address:${options.index}`,
    isPrimary: options.isPrimary,
    addressLine1: clamp(addressLine1, MAX_ADDRESS_LINE),
    addressLine2: addressLine2 ? clamp(addressLine2, MAX_ADDRESS_LINE) : null,
    city: mapOptional(raw.city, MAX_ADDRESS_CITY),
    region: mapOptional(firstText(raw.province, raw.provinceCode), MAX_ADDRESS_REGION),
    postalCode: mapOptional(raw.zip, MAX_ADDRESS_POSTAL),
    country: mapOptional(firstText(raw.country, raw.countryCodeV2), MAX_ADDRESS_COUNTRY),
    companyName: mapOptional(raw.company, MAX_ADDRESS_COMPANY),
    name: mapOptional(
      firstText(raw.name, [text(raw.firstName), text(raw.lastName)].filter(Boolean).join(' ')),
      MAX_ADDRESS_NAME,
    ),
  }
}

function mapOptional(value: unknown, max: number): string | null {
  const resolved = text(value)
  return resolved ? clamp(resolved, max) : null
}

/**
 * Decide which address is primary, and guarantee exactly one.
 *
 * `defaultAddress` designates it, matched by GID. Two failure modes are guarded here rather than
 * left to the write path, because both are silent:
 *
 *  - ZERO primaries — `defaultAddress` absent, or pointing at an address that was dropped or is
 *    not in the set. The first address is promoted, so a customer with addresses always has one.
 *  - TWO primaries — impossible by construction: exactly one index is chosen, and the flag is
 *    derived from that index rather than accumulated per address.
 */
function choosePrimaryIndex(
  addresses: ShopifyMailingAddress[],
  defaultAddress: ShopifyMailingAddress | null | undefined,
): number {
  if (addresses.length === 0) return -1
  const defaultId = text(defaultAddress?.id)
  if (defaultId) {
    const match = addresses.findIndex((address) => text(address.id) === defaultId)
    if (match !== -1) return match
  }
  return 0
}

/**
 * Map a Shopify customer onto the shape the adapter writes.
 *
 * `note` lands on `CustomerEntity.description` rather than the `CustomerComment` the plan names:
 * there is no comment command in `lib/constants.ts`, and every write must go through the command
 * bus. `description` is free text on the same row, so nothing is lost but the comment's separate
 * timeline entry. Revisit if a comment command is added.
 */
export function mapCustomer(node: ShopifyCustomerNode): MappedCustomer {
  const notes: MappingNote[] = []
  const names = resolveNames(node)
  if (names.synthesized) notes.push('name_synthesized')

  const rawEmail = readEmail(node)
  // Lowercased to match the command's own `normalizeEmail`, so a re-run does not see a change the
  // database would have normalised away anyway.
  const email = rawEmail ? clamp(rawEmail.toLowerCase(), MAX_EMAIL) : null
  const primaryEmail = email && isStorableEmail(email) ? email : null
  if (email && !primaryEmail) notes.push('email_dropped_invalid')

  const rawPhone = readPhone(node)
  const phone = rawPhone ? clamp(rawPhone, MAX_PHONE) : null
  const primaryPhone = phone && isStorablePhone(phone) ? phone : null
  if (phone && !primaryPhone) notes.push('phone_dropped_invalid')

  const rawAddresses = (node.addressesV2?.nodes ?? []).filter(
    (address): address is ShopifyMailingAddress => address != null,
  )
  const primaryIndex = choosePrimaryIndex(rawAddresses, node.defaultAddress)

  const addresses: MappedAddress[] = []
  let droppedAddress = false
  for (const [index, raw] of rawAddresses.entries()) {
    const mapped = mapAddress(raw, {
      customerExternalId: node.id,
      index,
      isPrimary: index === primaryIndex,
    })
    if (mapped) addresses.push(mapped)
    else droppedAddress = true
  }
  if (droppedAddress) notes.push('address_dropped_unusable')

  // Promoting the primary is deferred until here so it survives the designated address being
  // dropped for having no usable street line — otherwise the customer would end up with none.
  if (addresses.length > 0 && !addresses.some((address) => address.isPrimary)) {
    addresses[0] = { ...addresses[0], isPrimary: true }
  }

  const state = text(node.state)

  return {
    externalId: node.id,
    displayName: names.displayName,
    firstName: names.firstName,
    lastName: names.lastName,
    primaryEmail,
    primaryPhone,
    description: mapOptional(node.note, MAX_DESCRIPTION),
    // Lowercased because `CustomerEntity.status` is free text that also seeds a dictionary entry —
    // `ENABLED` and `enabled` would otherwise accumulate as two distinct statuses.
    status: state ? clamp(state.toLowerCase(), MAX_STATUS) : null,
    tags: (node.tags ?? []).map((tag) => text(tag)).filter((tag): tag is string => tag !== null),
    updatedAt: text(node.updatedAt),
    addresses,
    notes,
  }
}

// ── Change detection ─────────────────────────────────────────────────────────────────────────

/**
 * Stable digest of everything this sync would write.
 *
 * Compared only against the same customer's previous digest, so this answers "did this customer
 * change?" and nothing else. `updatedAt` is EXCLUDED on purpose: Shopify bumps it for changes that
 * touch none of the fields mapped above, and including it would turn every such touch into a
 * pointless write — the very thing the hash exists to prevent. The watermark still advances from
 * the raw `updatedAt`, so excluding it here costs no incremental progress.
 *
 * Addresses are sorted by external id first: Shopify's ordering within `addressesV2` is not
 * contractual, and a reordered-but-identical set must not read as a change.
 *
 * SHA-256 rather than a short non-cryptographic hash because a collision here does not merely cost
 * a retry — it makes a real upstream change invisible until something else about the customer
 * moves. The cost is a hash per record, against a network round trip already paid.
 */
export function customerContentHash(mapped: MappedCustomer): string {
  const canonical = {
    displayName: mapped.displayName,
    firstName: mapped.firstName,
    lastName: mapped.lastName,
    primaryEmail: mapped.primaryEmail,
    primaryPhone: mapped.primaryPhone,
    description: mapped.description,
    status: mapped.status,
    tags: [...mapped.tags].sort(),
    addresses: [...mapped.addresses]
      .sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0))
      .map((address) => [
        address.externalId,
        address.isPrimary,
        address.addressLine1,
        address.addressLine2,
        address.city,
        address.region,
        address.postalCode,
        address.country,
        address.companyName,
        address.name,
      ]),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
