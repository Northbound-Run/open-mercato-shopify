import { createHash } from 'node:crypto'

/**
 * Shopify product node → Open Mercato command inputs.
 *
 * Pure by construction: no framework imports, no network, no clock. The bulk path and the delta
 * path produce structurally identical nodes, so both feed the same functions here and the adapter
 * above only orchestrates. That split is what makes the field mapping exhaustively testable —
 * every rule below is a rule Shopify or Open Mercato actually enforces, and getting one wrong
 * fails at the command boundary rather than here unless it is checked up front.
 *
 * THREE CONSTRAINTS THAT ARE NOT OBVIOUS FROM EITHER SIDE'S DOCS:
 *
 * 1. MONEY IS A DECIMAL STRING AND MUST STAY ONE. Shopify's `Decimal` scalar serialises as a
 *    string, and core's `catalogPriceAmountSchema` validates the *string* form (digit counts are
 *    counted on it) before converting once, internally. Passing the string straight through is
 *    therefore both accepted and lossless; parsing it to a float here would round `0.1 + 0.2`
 *    style values before core ever saw them. `normalizeMoney` refuses a `number` outright for
 *    exactly that reason — by the time one arrives the precision loss has already happened, and
 *    accepting it would launder the very bug this rule exists to prevent.
 *
 * 2. `productType` MEANS DIFFERENT THINGS ON EACH SIDE. Shopify's is free text ("Snowboard").
 *    Open Mercato's is a closed enum (`simple` | `configurable` | `virtual` | `downloadable` |
 *    `bundle` | `grouped`) that drives product behaviour. Mapping one onto the other — which the
 *    plan's §5.1 table reads as if you should — fails validation on the first real product. We
 *    never send the field at all: omitted on create it defaults to `simple`, and omitted on update
 *    it leaves an operator's deliberate choice alone. Shopify's string is kept in metadata.
 *
 * 3. OPEN MERCATO VALIDATES SHAPES SHOPIFY DOES NOT. `sku` must match `[A-Za-z0-9\-_.]+` and
 *    `handle` must be lowercase alphanumeric; Shopify allows spaces and slashes in both. A value
 *    that would be rejected is dropped rather than sent, because losing a sku costs a natural-key
 *    fallback whereas failing the item loses the whole variant. Dropped originals are preserved in
 *    metadata so the loss is visible instead of silent.
 */

// ── Source shapes ────────────────────────────────────────────────────────────────────────────
// Deliberately permissive: every field optional and nullable, because these are reassembled from
// JSONL or a GraphQL page and a missing field is normal rather than exceptional.

export type ShopifySelectedOption = {
  name?: string | null
  value?: string | null
}

export type ShopifyVariantNode = {
  id: string
  title?: string | null
  sku?: string | null
  barcode?: string | null
  /** Decimal string. What the customer pays today. */
  price?: string | null
  /** Decimal string. The "was" price — present only while the variant is on sale. */
  compareAtPrice?: string | null
  selectedOptions?: ShopifySelectedOption[] | null
  updatedAt?: string | null
}

export type ShopifyProductNode = {
  id: string
  title?: string | null
  /** ⚠ `descriptionHtml`, not the deprecated `bodyHtml`. */
  descriptionHtml?: string | null
  handle?: string | null
  /** `ACTIVE` | `DRAFT` | `ARCHIVED`. */
  status?: string | null
  /** Free text on Shopify's side — see the note above; never mapped to OM's `productType`. */
  productType?: string | null
  vendor?: string | null
  tags?: string[] | null
  updatedAt?: string | null
  /** ⚠ `priceRangeV2`, not the deprecated `priceRange`. Read only for its currency code. */
  priceRangeV2?: {
    maxVariantPrice?: { amount?: string | null; currencyCode?: string | null } | null
  } | null
  variants: ShopifyVariantNode[]
  /**
   * Whether `variants` is the product's COMPLETE set.
   *
   * Load-bearing for reconciliation: a truncated variant connection looks exactly like a product
   * whose variants were deleted upstream, and acting on it would deactivate every variant past
   * the page boundary. Bulk exports always set this true; the paged path reads it from
   * `variants.pageInfo.hasNextPage`.
   */
  variantsComplete: boolean
}

// ── Open Mercato constraints (mirrored from core's `catalog/data/validators.ts`) ──────────────
// Mirrored rather than imported so this module stays runtime-dependency-free. Each limit is the
// exact value core enforces; a drift shows up as a command rejection naming the same field.

const MAX_TITLE = 255
const MAX_DESCRIPTION = 4000
const MAX_HANDLE = 150
const MAX_SKU = 191
const MAX_BARCODE = 191
const MAX_TAGS = 100
const MAX_TAG_LABEL = 100
const MAX_OPTION_NAME = 191
const MAX_OPTION_VALUE = 255

const SKU_PATTERN = /^[A-Za-z0-9\-_.]+$/
const HANDLE_PATTERN = /^[a-z0-9\-_]+$/
/** Unsigned decimal, no exponent, no separators — the only form core accepts. */
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/

/**
 * Price-kind codes, matching what core's `seedCatalogPriceKinds` installs.
 *
 * These live here rather than in `lib/constants.ts` because they are catalog seed data, not
 * identifiers of ours, and because that file is shared and append-only. Both MUST already exist in
 * the tenant: core looks price kinds up and never creates them, so a missing one otherwise yields
 * a sync that reports success and writes no prices at all.
 */
export const PRICE_KIND_CODE = {
  regular: 'regular',
  sale: 'sale',
} as const

export type PriceKindCode = (typeof PRICE_KIND_CODE)[keyof typeof PRICE_KIND_CODE]

/** Where our bookkeeping lives inside the entity's `metadata` jsonb. */
export const METADATA_NAMESPACE = 'shopify'

export class ProductMappingError extends Error {
  constructor(
    readonly externalId: string,
    message: string,
  ) {
    super(message)
    this.name = 'ProductMappingError'
  }
}

// ── Primitives ───────────────────────────────────────────────────────────────────────────────

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 ? text : null
}

/** Clip to a column's width. Returns null for a value that was empty to begin with. */
function clip(value: unknown, max: number): string | null {
  const text = trimmed(value)
  return text === null ? null : text.slice(0, max)
}

/**
 * A money value, preserved exactly as Shopify sent it.
 *
 * Returns null for anything that is not an unsigned decimal string — including a `number`, which
 * is rejected on principle rather than coerced (see the module note). Null means "no price",
 * which the caller reports rather than silently writing a zero.
 */
export function normalizeMoney(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return DECIMAL_PATTERN.test(text) ? text : null
}

/**
 * Order two decimal strings without touching a float.
 *
 * Only used to decide whether a variant is on sale, but doing it numerically would reintroduce
 * the rounding this module exists to avoid — and `'10' < '9'` lexically, so the naive comparison
 * is wrong too. Returns a negative number, zero, or a positive number, like a comparator.
 */
export function compareDecimalStrings(a: string, b: string): number {
  const [aInt = '', aFrac = ''] = a.split('.')
  const [bInt = '', bFrac = ''] = b.split('.')

  const leftInt = aInt.replace(/^0+(?=\d)/, '')
  const rightInt = bInt.replace(/^0+(?=\d)/, '')
  if (leftInt.length !== rightInt.length) return leftInt.length - rightInt.length
  if (leftInt !== rightInt) return leftInt < rightInt ? -1 : 1

  // Right-pad so the fractions compare position by position rather than by length.
  const width = Math.max(aFrac.length, bFrac.length)
  const leftFrac = aFrac.padEnd(width, '0')
  const rightFrac = bFrac.padEnd(width, '0')
  if (leftFrac === rightFrac) return 0
  return leftFrac < rightFrac ? -1 : 1
}

/** `ACTIVE` is the only Shopify status that means live; `DRAFT` and `ARCHIVED` both mean not. */
export function isActiveStatus(status: unknown): boolean {
  return trimmed(status)?.toUpperCase() === 'ACTIVE'
}

/**
 * Deterministic JSON, with object keys sorted at every depth.
 *
 * `JSON.stringify` preserves insertion order, so two payloads that differ only in the order
 * Shopify happened to return their fields would hash differently and force an endless stream of
 * no-op updates. Sorting is what makes the hash a statement about content.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

export function computeContentHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

// ── Metadata bookkeeping ─────────────────────────────────────────────────────────────────────

type ShopifyMetadata = {
  contentHash?: string
  [key: string]: unknown
}

function readNamespace(row: Record<string, unknown> | null | undefined): ShopifyMetadata {
  const metadata = row?.metadata
  if (!metadata || typeof metadata !== 'object') return {}
  const namespace = (metadata as Record<string, unknown>)[METADATA_NAMESPACE]
  return namespace && typeof namespace === 'object' ? (namespace as ShopifyMetadata) : {}
}

/** The hash the last successful sync wrote for this row, if any. */
export function readContentHash(row: Record<string, unknown> | null | undefined): string | null {
  const hash = readNamespace(row).contentHash
  return typeof hash === 'string' && hash.length > 0 ? hash : null
}

/**
 * Merge our namespace into whatever metadata the row already carries.
 *
 * Replacing `metadata` wholesale would discard keys written by an operator or another
 * integration, so only the `shopify` key is ever touched.
 */
export function mergeMetadata(
  existing: Record<string, unknown> | null | undefined,
  namespace: Record<string, unknown>,
): Record<string, unknown> {
  const current = existing?.metadata
  const base = current && typeof current === 'object' ? { ...(current as Record<string, unknown>) } : {}
  base[METADATA_NAMESPACE] = namespace
  return base
}

// ── Products ─────────────────────────────────────────────────────────────────────────────────

export type MappingScope = {
  organizationId: string
  tenantId: string
}

export type MappedProduct = {
  /** Command input, minus `id` — the writer merges that in on the update branch. */
  input: Record<string, unknown>
  /** Changes whenever anything we would write changes. Drives the skip path. */
  contentHash: string
  /** Natural key for the writer's fallback lookup. Null when Shopify's handle is unusable. */
  handle: string | null
}

/**
 * Normalise Shopify's tag list.
 *
 * Core caps the array at 100 and each label at 100 characters. Duplicates are dropped because
 * Shopify's list is case-preserving but effectively case-insensitive, and two labels differing
 * only in case would otherwise create two tags.
 */
function mapTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    const label = clip(raw, MAX_TAG_LABEL)
    if (label === null) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(label)
    if (result.length === MAX_TAGS) break
  }
  return result
}

/** Shopify handles are already url-safe, but a legacy store can hold one core would reject. */
function mapHandle(handle: unknown): string | null {
  const value = clip(handle, MAX_HANDLE)?.toLowerCase() ?? null
  return value !== null && HANDLE_PATTERN.test(value) ? value : null
}

export function mapProduct(node: ShopifyProductNode, scope: MappingScope): MappedProduct {
  const title = clip(node.title, MAX_TITLE)
  if (title === null) {
    // Core requires a non-empty title and there is no defensible substitute — a placeholder would
    // put an unidentifiable row in the operator's catalog.
    throw new ProductMappingError(node.id, `product ${node.id} has no title`)
  }

  const handle = mapHandle(node.handle)
  const description = clip(node.descriptionHtml, MAX_DESCRIPTION)
  const tags = mapTags(node.tags)
  const isActive = isActiveStatus(node.status)

  // What Shopify holds that has no native column. `status` is kept because the boolean mapping is
  // lossy in both directions: DRAFT and ARCHIVED both land on `isActive: false` and cannot be told
  // apart afterwards.
  const namespace: Record<string, unknown> = {
    gid: node.id,
    status: trimmed(node.status),
    vendor: trimmed(node.vendor),
    productType: trimmed(node.productType),
    handle: trimmed(node.handle),
    updatedAt: trimmed(node.updatedAt),
  }
  if (description !== null && (node.descriptionHtml ?? '').trim().length > MAX_DESCRIPTION) {
    // Core's `description` column stops at 4000 characters and Shopify's HTML routinely exceeds
    // it. Recording the truncation keeps a shortened description from reading as the whole one.
    namespace.descriptionTruncated = true
  }

  const core: Record<string, unknown> = {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    title,
    isActive,
  }
  if (description !== null) core.description = description
  if (handle !== null) core.handle = handle
  // Always sent, empty included: an omitted `tags` leaves the existing set alone, so a product
  // whose last tag was removed upstream would keep it locally forever.
  core.tags = tags

  // Hashed before metadata is attached: the hash must describe the payload, not contain itself.
  const contentHash = computeContentHash({ core, namespace })

  return {
    input: { ...core, metadata: { [METADATA_NAMESPACE]: { ...namespace, contentHash } } },
    contentHash,
    handle,
  }
}

// ── Variants ─────────────────────────────────────────────────────────────────────────────────

export type MappedVariant = {
  input: Record<string, unknown>
  contentHash: string
  /** Natural key for the writer's fallback. Null when Shopify's sku is unusable or absent. */
  sku: string | null
}

/**
 * `selectedOptions` → core's `optionValues` record.
 *
 * Shopify sends an ordered list of `{name, value}`; core stores a map. An option with no name has
 * nowhere to go, so it is dropped rather than keyed under a placeholder that would collide.
 */
function mapOptionValues(options: unknown): Record<string, string> {
  if (!Array.isArray(options)) return {}
  const values: Record<string, string> = {}
  for (const option of options as ShopifySelectedOption[]) {
    const name = clip(option?.name, MAX_OPTION_NAME)
    if (name === null) continue
    values[name] = clip(option?.value, MAX_OPTION_VALUE) ?? ''
  }
  return values
}

export function mapVariant(
  variant: ShopifyVariantNode,
  productLocalId: string,
  scope: MappingScope,
): MappedVariant {
  const rawSku = clip(variant.sku, MAX_SKU)
  // Core's sku pattern excludes the spaces and slashes Shopify permits. Dropping the value keeps
  // the variant; sending it would fail the whole item on a field that is only a fallback key.
  const sku = rawSku !== null && SKU_PATTERN.test(rawSku) ? rawSku : null
  const optionValues = mapOptionValues(variant.selectedOptions)

  const namespace: Record<string, unknown> = {
    gid: variant.id,
    updatedAt: trimmed(variant.updatedAt),
    price: normalizeMoney(variant.price),
    compareAtPrice: normalizeMoney(variant.compareAtPrice),
  }
  if (rawSku !== null && sku === null) namespace.rejectedSku = rawSku

  const core: Record<string, unknown> = {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    productId: productLocalId,
    isActive: true,
  }
  const name = clip(variant.title, MAX_TITLE)
  if (name !== null) core.name = name
  if (sku !== null) core.sku = sku
  const barcode = clip(variant.barcode, MAX_BARCODE)
  if (barcode !== null) core.barcode = barcode
  if (Object.keys(optionValues).length > 0) core.optionValues = optionValues

  // `productId` is excluded from the hash: it is a local id that differs between installs, and
  // including it would make the hash unstable across a re-mapped product without any upstream
  // change having occurred.
  const { productId: _productId, ...hashable } = core
  const contentHash = computeContentHash({ core: hashable, namespace })

  return {
    input: { ...core, metadata: { [METADATA_NAMESPACE]: { ...namespace, contentHash } } },
    contentHash,
    sku,
  }
}

// ── Prices ───────────────────────────────────────────────────────────────────────────────────

export type PriceIntent = {
  kindCode: PriceKindCode
  /** Decimal string, exactly as Shopify sent it. */
  amount: string
  currencyCode: string
  /** Composite external id, per plan §4.8. */
  externalId: string
}

/**
 * Which price rows a variant should have.
 *
 * ⚠ The direction here is the opposite of how plan §5.1 reads. Shopify's `price` is what the
 * customer pays *now*; `compareAtPrice` is the struck-through "was" price, present only during a
 * sale and always the higher of the two. Core's `selectBestPrice` scores a promotional kind above
 * a regular one, so filing `compareAtPrice` under the promotional kind — the literal reading of
 * §5.1 — makes the *higher* price win and overcharges the customer. Hence:
 *
 *   on sale   → regular = compareAtPrice (the list price), sale = price (what is charged)
 *   otherwise → regular = price, and no sale row at all
 *
 * A `compareAtPrice` that is not strictly greater than `price` is a stale leftover Shopify keeps
 * returning after a sale ends, and is ignored.
 */
export function toPriceIntents(
  variant: ShopifyVariantNode,
  currencyCode: string,
): PriceIntent[] {
  const price = normalizeMoney(variant.price)
  if (price === null) return []

  const compareAt = normalizeMoney(variant.compareAtPrice)
  const onSale = compareAt !== null && compareDecimalStrings(compareAt, price) > 0

  const intent = (kindCode: PriceKindCode, amount: string): PriceIntent => ({
    kindCode,
    amount,
    currencyCode,
    externalId: `${variant.id}:price:${kindCode}::${currencyCode}`,
  })

  return onSale
    ? [intent(PRICE_KIND_CODE.regular, compareAt), intent(PRICE_KIND_CODE.sale, price)]
    : [intent(PRICE_KIND_CODE.regular, price)]
}

export function mapPrice(
  intent: PriceIntent,
  variantLocalId: string,
  priceKindId: string,
  scope: MappingScope,
): Record<string, unknown> {
  return {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    variantId: variantLocalId,
    priceKindId,
    currencyCode: intent.currencyCode,
    // The decimal string goes through untouched: core validates digit counts on this exact text.
    unitPriceGross: intent.amount,
  }
}

/**
 * The currency every price on this product is denominated in.
 *
 * `variant.price` carries no currency of its own — only `priceRangeV2` does — so it is read from
 * the product and falls back to the shop's currency for a product with no priced variants.
 */
export function resolveCurrencyCode(node: ShopifyProductNode, fallback: string): string {
  const code = trimmed(node.priceRangeV2?.maxVariantPrice?.currencyCode)
  return code !== null && /^[A-Z]{3}$/.test(code.toUpperCase()) ? code.toUpperCase() : fallback
}
