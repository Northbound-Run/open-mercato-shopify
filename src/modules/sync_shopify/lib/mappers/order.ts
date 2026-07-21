import { createHash } from 'node:crypto'

/**
 * Shopify `Order` → Open Mercato sales command inputs, as pure data.
 *
 * No framework import, no network, no clock: every value returned is a function of the argument, so
 * the reconciliation rules can be exercised against fixtures without a container or a store. The
 * adapter owns all I/O and all id resolution; this file owns every decision about what a number MEANS.
 *
 * THE ONE THING THAT DECIDES CORRECTNESS — how order totals are made to reconcile with Shopify.
 *
 * `sales.orders.create` does NOT accept totals. It discards them, then recomputes every total from
 * the `lines[]` and `adjustments[]` it is given (verified in core's `documents.ts` +
 * `lib/calculations.ts`). So the only way to make the persisted grand/tax/discount totals equal
 * Shopify's is to feed core inputs whose computed totals ARE Shopify's. Two facts from that engine
 * shape everything below:
 *
 *   1. A line's net is `unitPriceNet × quantity − (discountAmount × quantity)`; its tax is the
 *      explicit `taxAmount`; its gross is `net + tax`. `totalNetAmount` on the input is ignored.
 *   2. The document grand total equals the running subtotal after order-scoped adjustments:
 *      `discount` subtracts, `shipping`/`surcharge` add, `tax` adds to tax-and-gross only.
 *
 * So we represent each line at its ORIGINAL (pre-discount) net, carry each line's own tax, and push
 * every discount, the shipping, and any tax not attributable to a line to ORDER-LEVEL adjustments:
 *
 *   grandGross = Σ(lineNet) − D + S + X          discount D, shipping S, tax X
 *   grandNet   = Σ(lineNet) − D + S    (= G − X)
 *   taxTotal   = Σ(lineTax) + taxResidual = X
 *   discount   = Σ(discount adjustments) = D
 *
 * which is exactly Shopify's own order identity `G = ΣoriginalLineTotal − D + S + X`. Discounts are
 * kept at order level rather than per line because core multiplies a per-unit line discount by
 * quantity — an amount that does not divide evenly by quantity would then drift by a cent. An
 * order-level adjustment carries the exact figure Shopify reported and cannot drift.
 *
 * WHY NOT PERSIST `shopMoney` INTO THE TOTAL COLUMNS DIRECTLY (as §5.4 implies): the command ignores
 * them. `presentmentMoney` — what the customer actually saw and paid, and unreconstructable once
 * dropped — is kept in `metadata.shopify` alongside every persisted `shopMoney` figure.
 *
 * MONEY IS A DECIMAL STRING AND NEVER A FLOAT HERE. Shopify's `Decimal` serialises as a string and
 * core's numeric columns are `numeric(18,4)`. All arithmetic in this file is done on integers scaled
 * by 1e4 (`scaleMoney`), so `0.1 + 0.2` can never appear. Core coerces the strings we hand it and
 * rounds to 1e4 internally, so a 2-decimal figure survives that round trip to the cent.
 */

// ── Shopify wire shapes (Admin GraphQL 2026-07) ──────────────────────────────────────────────
// Deliberately all-optional: a field the query did not ask for is absent rather than null, and the
// bulk and delta paths select overlapping-but-different subsets. `*Set` fields are MoneyBags —
// ANALYSIS-005's flat `totalPrice`/`subtotalPrice`/`totalTax` names are all deprecated.

export type ShopifyMoneyV2 = { amount?: string | null; currencyCode?: string | null }
export type ShopifyMoneyBag = {
  shopMoney?: ShopifyMoneyV2 | null
  presentmentMoney?: ShopifyMoneyV2 | null
}

export type ShopifyOrderAddress = {
  firstName?: string | null
  lastName?: string | null
  name?: string | null
  company?: string | null
  address1?: string | null
  address2?: string | null
  city?: string | null
  province?: string | null
  provinceCode?: string | null
  country?: string | null
  countryCodeV2?: string | null
  zip?: string | null
  phone?: string | null
}

export type ShopifyTaxLine = {
  title?: string | null
  ratePercentage?: number | null
  priceSet?: ShopifyMoneyBag | null
}

export type ShopifyDiscountApplication = {
  /** Present on the allocation in bulk; the connection index otherwise. */
  code?: string | null
  title?: string | null
  /** `DISCOUNT_CODE` | `MANUAL` | `SCRIPT` | `AUTOMATIC`. */
  __typename?: string | null
}

export type ShopifyDiscountAllocation = {
  allocatedAmountSet?: ShopifyMoneyBag | null
  discountApplication?: ShopifyDiscountApplication | null
}

export type ShopifyLineVariant = {
  id?: string | null
  sku?: string | null
}

export type ShopifyOrderLine = {
  id?: string | null
  name?: string | null
  title?: string | null
  sku?: string | null
  quantity?: number | null
  variant?: ShopifyLineVariant | null
  /** Per-unit, pre-discount. Net when the store prices tax-exclusively. */
  originalUnitPriceSet?: ShopifyMoneyBag | null
  discountedUnitPriceSet?: ShopifyMoneyBag | null
  taxLines?: (ShopifyTaxLine | null)[] | null
  discountAllocations?: (ShopifyDiscountAllocation | null)[] | null
}

export type ShopifyShippingLine = {
  /** Selected so the bulk export's flattened `ShippingLine` line carries a GID to key on — see
   *  `SHIPPING_SELECTION`. Not otherwise mapped. */
  id?: string | null
  title?: string | null
  originalPriceSet?: ShopifyMoneyBag | null
  priceSet?: ShopifyMoneyBag | null
  taxLines?: (ShopifyTaxLine | null)[] | null
}

export type ShopifyTransaction = {
  id?: string | null
  kind?: string | null
  status?: string | null
  gateway?: string | null
  processedAt?: string | null
  amountSet?: ShopifyMoneyBag | null
}

export type ShopifyRefund = {
  id?: string | null
  createdAt?: string | null
  totalRefundedSet?: ShopifyMoneyBag | null
}

export type ShopifyFulfillment = {
  id?: string | null
  status?: string | null
  displayStatus?: string | null
  createdAt?: string | null
  deliveredAt?: string | null
  estimatedDeliveryAt?: string | null
  trackingInfo?: ({ company?: string | null; number?: string | null; url?: string | null } | null)[] | null
  /** Recorded in metadata — we have no local line ids at import time. */
  fulfillmentLineItems?:
    | { nodes?: ({ lineItem?: { id?: string | null } | null; quantity?: number | null } | null)[] | null }
    | null
}

export type ShopifyOrderNode = {
  id: string
  name?: string | null
  email?: string | null
  note?: string | null
  tags?: string[] | null
  createdAt?: string | null
  processedAt?: string | null
  updatedAt?: string | null
  cancelledAt?: string | null
  cancelReason?: string | null
  currencyCode?: string | null
  presentmentCurrencyCode?: string | null
  /** Whether line prices already include tax. Drives the tax-inclusive branch. */
  taxesIncluded?: boolean | null
  displayFinancialStatus?: string | null
  displayFulfillmentStatus?: string | null
  customer?: { id?: string | null; email?: string | null } | null
  billingAddress?: ShopifyOrderAddress | null
  shippingAddress?: ShopifyOrderAddress | null
  totalPriceSet?: ShopifyMoneyBag | null
  subtotalPriceSet?: ShopifyMoneyBag | null
  totalTaxSet?: ShopifyMoneyBag | null
  totalDiscountsSet?: ShopifyMoneyBag | null
  totalShippingPriceSet?: ShopifyMoneyBag | null
  lineItems?: { nodes?: (ShopifyOrderLine | null)[] | null } | null
  shippingLines?: { nodes?: (ShopifyShippingLine | null)[] | null } | null
  transactions?: (ShopifyTransaction | null)[] | null
  refunds?: (ShopifyRefund | null)[] | null
  fulfillments?: (ShopifyFulfillment | null)[] | null
}

// ── Mapped output ────────────────────────────────────────────────────────────────────────────

export type OrderMappingNote =
  | 'variant_unresolved'
  | 'line_dropped_no_price'
  | 'taxes_included_approximated'
  | 'discount_residual_reconciled'
  | 'tax_residual_added'
  | 'no_line_items'

/** A line the adapter still has to resolve a `productVariantId` for before dispatch. */
export type MappedOrderLine = {
  /** Shopify LineItem GID — the line's identity, kept for reconciliation and diagnostics. */
  externalId: string
  /** Shopify ProductVariant GID, or null when the line has no variant (custom/deleted). */
  variantExternalId: string | null
  sku: string | null
  name: string
  /** Whole units. */
  quantity: number
  currencyCode: string
  /** Per-unit net, decimal string, exactly as Shopify sent it. */
  unitPriceNet: string
  /** Total tax on the line, decimal string. */
  taxAmount: string
  /** Preserved so a dropped/renamed variant is visible rather than silently lost. */
  metadata: Record<string, unknown>
}

export type MappedOrderAdjustment = {
  kind: 'discount' | 'shipping' | 'tax'
  label: string
  code: string | null
  amount: string
  position: number
  metadata?: Record<string, unknown>
}

export type MappedPayment = {
  externalId: string
  amount: string
  currencyCode: string
  capturedAmount: string | null
  refundedAmount: string | null
  receivedAt: string | null
  paymentReference: string | null
  metadata: Record<string, unknown>
}

export type MappedShipment = {
  externalId: string
  carrierName: string | null
  trackingNumbers: string[]
  shippedAt: string | null
  deliveredAt: string | null
  status: string | null
  metadata: Record<string, unknown>
}

/** The totals Shopify reported, in shop currency — the target the persisted order must reconcile to. */
export type OrderReconciliation = {
  grandTotalGross: string
  grandTotalNet: string
  taxTotal: string
  discountTotal: string
  shippingTotal: string
}

export type MappedOrder = {
  externalId: string
  orderNumber: string | null
  currencyCode: string
  /** Shopify customer GID, resolved to a local id by the adapter. */
  customerExternalId: string | null
  customerEmail: string | null
  /** Raw Shopify statuses; native columns need dictionary ids, so the adapter resolves or stores these. */
  financialStatus: string | null
  fulfillmentStatus: string | null
  cancelledAt: string | null
  placedAt: string | null
  updatedAt: string | null
  /** Header fields for the order command, minus id/customer/status which the adapter injects. */
  header: Record<string, unknown>
  lines: MappedOrderLine[]
  adjustments: MappedOrderAdjustment[]
  payments: MappedPayment[]
  shipments: MappedShipment[]
  reconciliation: OrderReconciliation
  contentHash: string
  notes: OrderMappingNote[]
}

export class OrderMappingError extends Error {
  constructor(
    readonly externalId: string,
    message: string,
  ) {
    super(message)
    this.name = 'OrderMappingError'
  }
}

// ── Money as scaled integers ─────────────────────────────────────────────────────────────────
// Every figure is carried at 1e4 (four decimals — the width of core's numeric columns and its
// internal rounding). Working in integers is what keeps the reconciliation exact: a float sum of
// decimals could differ from Shopify's by a cent, and a cent is the whole game here.

const MONEY_SCALE = 10_000n
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/

/** Parse a decimal string to a 1e4-scaled bigint. Null for anything that is not a plain decimal. */
export function scaleMoney(value: unknown): bigint | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!DECIMAL_PATTERN.test(text)) return null
  const negative = text.startsWith('-')
  const [intPart, fracPart = ''] = (negative ? text.slice(1) : text).split('.')
  // More than four decimals would silently lose precision against the 1e4 scale; refuse rather
  // than truncate, so a malformed figure surfaces instead of quietly reconciling to the wrong cent.
  if (fracPart.length > 4) return null
  const scaled = BigInt(intPart) * MONEY_SCALE + BigInt(fracPart.padEnd(4, '0'))
  return negative ? -scaled : scaled
}

/** Render a 1e4-scaled bigint back to a trimmed decimal string core will accept. */
export function formatMoney(scaled: bigint): string {
  const negative = scaled < 0n
  const abs = negative ? -scaled : scaled
  const whole = abs / MONEY_SCALE
  const frac = (abs % MONEY_SCALE).toString().padStart(4, '0').replace(/0+$/, '')
  const body = frac.length > 0 ? `${whole}.${frac}` : `${whole}`
  return negative ? `-${body}` : body
}

/** Read the shop-currency amount from a MoneyBag; null when absent or unparseable. */
export function shopAmount(bag: ShopifyMoneyBag | null | undefined): bigint | null {
  return scaleMoney(bag?.shopMoney?.amount ?? null)
}

/** Read the presentment (customer-facing) side, kept alongside every persisted shopMoney figure. */
function presentmentOf(bag: ShopifyMoneyBag | null | undefined): {
  amount: string
  currencyCode: string
} | null {
  const amount = bag?.presentmentMoney?.amount
  const currencyCode = bag?.presentmentMoney?.currencyCode
  if (typeof amount !== 'string' || typeof currencyCode !== 'string') return null
  return { amount, currencyCode }
}

// ── Primitives ───────────────────────────────────────────────────────────────────────────────

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

function wholeUnits(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function sumBags(bags: (ShopifyMoneyBag | null | undefined)[] | null | undefined): bigint {
  let total = 0n
  for (const bag of bags ?? []) total += shopAmount(bag) ?? 0n
  return total
}

const MAX_NAME = 255
const MAX_LABEL = 255
const MAX_STATUS = 100

// ── Addresses ────────────────────────────────────────────────────────────────────────────────

/**
 * A Shopify order address → the jsonb snapshot column.
 *
 * These are snapshots, not `SalesDocumentAddress` rows: the order command accepts
 * `billing/shipping_address_snapshot` directly, whereas a document-address row needs a second
 * command and a resolved id we do not have at import time. The snapshot preserves the full address.
 */
export function mapAddressSnapshot(
  address: ShopifyOrderAddress | null | undefined,
): Record<string, unknown> | null {
  if (!address) return null
  const line1 = text(address.address1)
  const snapshot: Record<string, unknown> = {}
  const put = (key: string, value: string | null) => {
    if (value !== null) snapshot[key] = value
  }
  put('name', text(address.name) ?? ([text(address.firstName), text(address.lastName)].filter(Boolean).join(' ') || null))
  put('companyName', text(address.company))
  put('addressLine1', line1)
  put('addressLine2', text(address.address2))
  put('city', text(address.city))
  put('region', text(address.province) ?? text(address.provinceCode))
  put('postalCode', text(address.zip))
  put('country', text(address.country) ?? text(address.countryCodeV2))
  put('phone', text(address.phone))
  return Object.keys(snapshot).length > 0 ? snapshot : null
}

// ── Discounts ────────────────────────────────────────────────────────────────────────────────

/**
 * Build the order-level discount adjustments, guaranteed to sum to Shopify's `totalDiscounts`.
 *
 * This is the highest-risk mapping in the workstream, so it is engineered to be provably exact
 * rather than merely plausible. Shopify allocates each discount to the lines it touches; we group
 * those allocations by the discount that produced them so each code or automatic discount becomes
 * its own visible adjustment. Whatever the allocations sum to, a residual line closes any gap to the
 * authoritative `totalDiscounts` — so the discount total always reconciles to the cent even when a
 * discount was allocated somewhere our line selection did not capture (e.g. a shipping discount).
 */
function buildDiscountAdjustments(
  node: ShopifyOrderNode,
  discountTotal: bigint,
  notes: OrderMappingNote[],
  position: number,
): MappedOrderAdjustment[] {
  if (discountTotal <= 0n) return []

  // Group allocations by a stable key drawn from the discount that caused them.
  const groups = new Map<string, { label: string; code: string | null; amount: bigint }>()
  let allocated = 0n
  for (const line of node.lineItems?.nodes ?? []) {
    for (const allocation of line?.discountAllocations ?? []) {
      const amount = shopAmount(allocation?.allocatedAmountSet)
      if (amount === null || amount <= 0n) continue
      allocated += amount
      const app = allocation?.discountApplication
      const code = text(app?.code)
      const label = text(app?.title) ?? code ?? 'Discount'
      const key = code ?? label
      const group = groups.get(key) ?? { label, code, amount: 0n }
      group.amount += amount
      groups.set(key, group)
    }
  }

  const adjustments: MappedOrderAdjustment[] = []
  let pos = position
  for (const group of groups.values()) {
    adjustments.push({
      kind: 'discount',
      label: clamp(group.label, MAX_LABEL),
      code: group.code,
      amount: formatMoney(group.amount),
      position: pos++,
    })
  }

  // The order-level total is authoritative. If the per-line allocations do not add up to it — a
  // shipping discount, or a discount Shopify did not allocate to a captured line — close the gap so
  // `discountTotalAmount` still equals Shopify's figure exactly.
  const residual = discountTotal - allocated
  if (residual === 0n) return adjustments

  notes.push('discount_residual_reconciled')
  if (residual > 0n && adjustments.length > 0) {
    // The common case: allocations under-count the total. Fold the gap into the last visible group
    // rather than invent a line, so the reported codes stay honest and every amount stays positive.
    const last = adjustments[adjustments.length - 1]
    last.amount = formatMoney((scaleMoney(last.amount) ?? 0n) + residual)
    return adjustments
  }

  // Either there were no groups, or the allocations over-counted the authoritative total (which would
  // make a group negative — a value core's `decimal({ min: 0 })` rejects). Collapse to one adjustment
  // carrying exactly `totalDiscounts`, so the discount total reconciles and no amount goes negative.
  return [
    {
      kind: 'discount',
      label: 'Order discount',
      code: null,
      amount: formatMoney(discountTotal),
      position,
      metadata: { reason: 'reconciled_to_total_discounts' },
    },
  ]
}

// ── Lines ────────────────────────────────────────────────────────────────────────────────────

/**
 * One Shopify line → one core line at its ORIGINAL net, carrying its own tax.
 *
 * Discounts are deliberately not applied here (they live in order-level adjustments — see the file
 * header), so `unitPriceNet` is Shopify's pre-discount unit price passed through verbatim. A line
 * whose price cannot be read is still returned with a zero price and a note rather than dropped: an
 * order missing a line reconciles to the wrong total silently, which is worse than a visible zero.
 */
function mapLine(
  line: ShopifyOrderLine,
  currencyCode: string,
  notes: OrderMappingNote[],
): MappedOrderLine | null {
  const externalId = text(line.id)
  if (externalId === null) return null

  const quantity = wholeUnits(line.quantity)
  if (quantity <= 0) return null

  const unitPriceScaled = shopAmount(line.originalUnitPriceSet)
  const lineTax = sumBags((line.taxLines ?? []).map((t) => t?.priceSet))

  const variantExternalId = text(line.variant?.id)
  const sku = text(line.sku) ?? text(line.variant?.sku)
  const name = clamp(text(line.name) ?? text(line.title) ?? sku ?? 'Line item', MAX_NAME)

  const metadata: Record<string, unknown> = {
    lineGid: externalId,
    variantGid: variantExternalId,
    sku,
    originalUnitPrice: line.originalUnitPriceSet?.shopMoney?.amount ?? null,
    discountedUnitPrice: line.discountedUnitPriceSet?.shopMoney?.amount ?? null,
    taxAmount: formatMoney(lineTax),
    presentment: {
      originalUnitPrice: presentmentOf(line.originalUnitPriceSet),
      tax: (line.taxLines ?? [])
        .map((t) => presentmentOf(t?.priceSet))
        .filter((v): v is { amount: string; currencyCode: string } => v !== null),
    },
    // Every discount allocated to this line, so per-line discount detail survives even though the
    // amount is applied at order level for exactness.
    discountAllocations: (line.discountAllocations ?? [])
      .map((a) => ({
        amount: a?.allocatedAmountSet?.shopMoney?.amount ?? null,
        code: text(a?.discountApplication?.code),
        title: text(a?.discountApplication?.title),
      }))
      .filter((a) => a.amount !== null),
  }

  if (unitPriceScaled === null) notes.push('line_dropped_no_price')

  return {
    externalId,
    variantExternalId,
    sku,
    name,
    quantity,
    currencyCode,
    unitPriceNet: formatMoney(unitPriceScaled ?? 0n),
    taxAmount: formatMoney(lineTax),
    metadata,
  }
}

// ── Payments and shipments ───────────────────────────────────────────────────────────────────

const REFUND_KINDS = new Set(['REFUND', 'VOID'])

function mapPayments(node: ShopifyOrderNode, currencyCode: string): MappedPayment[] {
  const payments: MappedPayment[] = []

  for (const tx of node.transactions ?? []) {
    const externalId = text(tx?.id)
    const amount = shopAmount(tx?.amountSet)
    if (externalId === null || amount === null) continue
    // Only settled money movements are real payments; an authorization or a failed attempt is not.
    if (text(tx?.status)?.toUpperCase() !== 'SUCCESS') continue

    const isRefund = REFUND_KINDS.has(text(tx?.kind)?.toUpperCase() ?? '')
    payments.push({
      externalId,
      amount: formatMoney(amount),
      currencyCode,
      capturedAmount: isRefund ? null : formatMoney(amount),
      refundedAmount: isRefund ? formatMoney(amount) : null,
      receivedAt: text(tx?.processedAt),
      paymentReference: text(tx?.gateway) ?? externalId,
      metadata: {
        gid: externalId,
        kind: text(tx?.kind),
        gateway: text(tx?.gateway),
        presentment: presentmentOf(tx?.amountSet),
      },
    })
  }

  // Refund objects that did not surface as transactions (older orders) still record the money back.
  for (const refund of node.refunds ?? []) {
    const externalId = text(refund?.id)
    const amount = shopAmount(refund?.totalRefundedSet)
    if (externalId === null || amount === null || amount <= 0n) continue
    if (payments.some((p) => p.externalId === externalId)) continue
    payments.push({
      externalId,
      amount: formatMoney(amount),
      currencyCode,
      capturedAmount: null,
      refundedAmount: formatMoney(amount),
      receivedAt: text(refund?.createdAt),
      paymentReference: externalId,
      metadata: { gid: externalId, kind: 'REFUND', presentment: presentmentOf(refund?.totalRefundedSet) },
    })
  }

  return payments
}

function mapShipments(node: ShopifyOrderNode): MappedShipment[] {
  const shipments: MappedShipment[] = []
  for (const fulfillment of node.fulfillments ?? []) {
    const externalId = text(fulfillment?.id)
    if (externalId === null) continue

    const tracking = (fulfillment?.trackingInfo ?? [])
      .map((info) => text(info?.number))
      .filter((n): n is string => n !== null)
    const carrier = (fulfillment?.trackingInfo ?? [])
      .map((info) => text(info?.company))
      .find((c): c is string => c !== null)

    shipments.push({
      externalId,
      carrierName: carrier ?? null,
      trackingNumbers: tracking,
      shippedAt: text(fulfillment?.createdAt),
      deliveredAt: text(fulfillment?.deliveredAt),
      status: text(fulfillment?.displayStatus) ?? text(fulfillment?.status),
      metadata: {
        gid: externalId,
        status: text(fulfillment?.status),
        estimatedDeliveryAt: text(fulfillment?.estimatedDeliveryAt),
        // No local line ids at import time, so the fulfilled lines are recorded by Shopify GID.
        lineItems: (fulfillment?.fulfillmentLineItems?.nodes ?? [])
          .map((n) => ({ lineGid: text(n?.lineItem?.id), quantity: wholeUnits(n?.quantity) }))
          .filter((n) => n.lineGid !== null),
        trackingUrls: (fulfillment?.trackingInfo ?? [])
          .map((info) => text(info?.url))
          .filter((u): u is string => u !== null),
      },
    })
  }
  return shipments
}

// ── Change detection ─────────────────────────────────────────────────────────────────────────

/**
 * Stable digest of everything a sync would write for this order.
 *
 * `updatedAt` is excluded — Shopify bumps it for changes that touch none of the mapped fields, and
 * including it would force a pointless rewrite on every such touch. The watermark still advances
 * from the raw `updatedAt`, so excluding it here costs no incremental progress.
 */
export function orderContentHash(input: {
  header: Record<string, unknown>
  lines: MappedOrderLine[]
  adjustments: MappedOrderAdjustment[]
  payments: MappedPayment[]
  shipments: MappedShipment[]
  financialStatus: string | null
  fulfillmentStatus: string | null
}): string {
  const canonical = {
    header: input.header,
    financialStatus: input.financialStatus,
    fulfillmentStatus: input.fulfillmentStatus,
    lines: input.lines.map((l) => [l.externalId, l.variantExternalId, l.sku, l.quantity, l.unitPriceNet, l.taxAmount]),
    adjustments: [...input.adjustments]
      .map((a) => [a.kind, a.code, a.label, a.amount])
      .sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)),
    payments: [...input.payments]
      .map((p) => [p.externalId, p.amount, p.capturedAmount, p.refundedAmount])
      .sort((x, y) => (x[0]! < y[0]! ? -1 : 1)),
    shipments: [...input.shipments]
      .map((s) => [s.externalId, s.status, s.carrierName, [...s.trackingNumbers].sort()])
      .sort((x, y) => ((x[0] as string) < (y[0] as string) ? -1 : 1)),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

// ── The mapper ───────────────────────────────────────────────────────────────────────────────

export const ORDER_METADATA_NAMESPACE = 'shopify'

export function mapOrder(node: ShopifyOrderNode): MappedOrder {
  const currencyCode = text(node.currencyCode)?.toUpperCase() ?? null
  if (currencyCode === null || !/^[A-Z]{3}$/.test(currencyCode)) {
    // A wrong currency writes an order that reconciles against nothing; there is no safe default.
    throw new OrderMappingError(node.id, `order ${node.id} has no usable currency code`)
  }

  const notes: OrderMappingNote[] = []

  const grand = shopAmount(node.totalPriceSet) ?? 0n
  const tax = shopAmount(node.totalTaxSet) ?? 0n
  const discount = shopAmount(node.totalDiscountsSet) ?? 0n
  const shipping = shopAmount(node.totalShippingPriceSet) ?? 0n
  const taxesIncluded = node.taxesIncluded === true
  if (taxesIncluded) {
    // Tax-inclusive stores embed tax in the unit price, so a line's net cannot be read directly.
    // We keep grand/discount/shipping exact and approximate the tax split; the flag makes it visible.
    notes.push('taxes_included_approximated')
  }

  // Lines at original net, carrying their own tax.
  const rawLines = (node.lineItems?.nodes ?? []).filter((l): l is ShopifyOrderLine => l != null)
  const lines: MappedOrderLine[] = []
  let lineTaxTotal = 0n
  for (const raw of rawLines) {
    const mapped = mapLine(raw, currencyCode, notes)
    if (mapped) {
      lines.push(mapped)
      lineTaxTotal += scaleMoney(mapped.taxAmount) ?? 0n
    }
  }
  if (lines.length === 0) notes.push('no_line_items')

  // Order-level adjustments: discounts (Σ = D), shipping (= S), residual tax (= X − Σ line tax).
  const adjustments: MappedOrderAdjustment[] = []
  adjustments.push(...buildDiscountAdjustments(node, discount, notes, adjustments.length))
  if (shipping > 0n) {
    adjustments.push({
      kind: 'shipping',
      label: clamp(text(node.shippingLines?.nodes?.[0]?.title) ?? 'Shipping', MAX_LABEL),
      code: null,
      amount: formatMoney(shipping),
      position: adjustments.length,
    })
  }
  const taxResidual = tax - lineTaxTotal
  if (taxResidual > 0n) {
    // Tax Shopify charged that no line carries — shipping and duty tax. A `tax` adjustment adds it to
    // the tax total (and gross) without disturbing the discount or the net, so the tax total lands on
    // Shopify's figure exactly.
    notes.push('tax_residual_added')
    adjustments.push({
      kind: 'tax',
      label: 'Shipping & duty tax',
      code: null,
      amount: formatMoney(taxResidual),
      position: adjustments.length,
      metadata: { reason: 'tax_not_attributable_to_a_line' },
    })
  }

  const placedAt = text(node.processedAt) ?? text(node.createdAt)
  const financialStatus = text(node.displayFinancialStatus)
  const fulfillmentStatus = text(node.displayFulfillmentStatus)
  const orderNumber = text(node.name)

  const namespace: Record<string, unknown> = {
    gid: node.id,
    name: orderNumber,
    financialStatus,
    fulfillmentStatus,
    cancelledAt: text(node.cancelledAt),
    cancelReason: text(node.cancelReason),
    taxesIncluded,
    presentmentCurrencyCode: text(node.presentmentCurrencyCode),
    // Every persisted shopMoney total, with its presentment twin — the only figure that is
    // unreconstructable once discarded.
    totals: {
      shopMoney: {
        grandTotal: formatMoney(grand),
        tax: formatMoney(tax),
        discount: formatMoney(discount),
        shipping: formatMoney(shipping),
      },
      presentment: {
        grandTotal: presentmentOf(node.totalPriceSet),
        tax: presentmentOf(node.totalTaxSet),
        discount: presentmentOf(node.totalDiscountsSet),
        shipping: presentmentOf(node.totalShippingPriceSet),
      },
    },
  }

  const billingSnapshot = mapAddressSnapshot(node.billingAddress)
  const shippingSnapshot = mapAddressSnapshot(node.shippingAddress)

  const header: Record<string, unknown> = {
    externalReference: node.id,
    orderNumber: orderNumber ?? undefined,
    currencyCode,
    placedAt: placedAt ?? undefined,
    billingAddressSnapshot: billingSnapshot ?? undefined,
    shippingAddressSnapshot: shippingSnapshot ?? undefined,
    comments: text(node.note) ?? undefined,
    metadata: { [ORDER_METADATA_NAMESPACE]: namespace },
  }

  const reconciliation: OrderReconciliation = {
    grandTotalGross: formatMoney(grand),
    grandTotalNet: formatMoney(grand - tax),
    taxTotal: formatMoney(tax),
    discountTotal: formatMoney(discount),
    shippingTotal: formatMoney(shipping),
  }

  const payments = mapPayments(node, currencyCode)
  const shipments = mapShipments(node)

  const contentHash = orderContentHash({
    header,
    lines,
    adjustments,
    payments,
    shipments,
    financialStatus,
    fulfillmentStatus,
  })

  return {
    externalId: node.id,
    orderNumber,
    currencyCode,
    customerExternalId: text(node.customer?.id),
    customerEmail: text(node.customer?.email) ?? text(node.email),
    financialStatus,
    fulfillmentStatus,
    cancelledAt: text(node.cancelledAt),
    placedAt,
    updatedAt: text(node.updatedAt),
    header,
    lines,
    adjustments,
    payments,
    shipments,
    reconciliation,
    contentHash,
    notes,
  }
}
