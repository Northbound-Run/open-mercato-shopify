import type {
  DataMapping,
  DataSyncAdapter,
  ImportBatch,
  ImportItem,
  StreamImportInput,
  TenantScope,
} from '@open-mercato/core/modules/data_sync/lib/adapter'
import { SEARCH_DEBUG_HEADER, type ShopifyClient } from '../client'
import type { BulkExport, BulkExportOptions, BulkNode, BulkOperation } from '../bulk'
import { childrenOfType, runBulkExport } from '../bulk'
import {
  COMMAND,
  COMMAND_RESULT_KEY,
  ENTITY_TYPE,
  INTEGRATION_ID,
  MAPPING_ENTITY_TYPE,
  OM_ENTITY_ID,
  PROVIDER_KEY,
} from '../constants'
import {
  advanceCursor,
  normalizeTimestamp,
  parseCursor,
  serializeCursor,
  type ShopifyCursorState,
} from '../cursor'
import { orderHistoryWindow as deriveOrderWindow } from '../shop-domain'
import { toImportItem, type EntityRow, type EntityWriter, type ExternalIdMappingPort } from '../writer'
import {
  mapOrder,
  type MappedOrder,
  type MappedOrderLine,
  type MappedPayment,
  type MappedShipment,
  type ShopifyOrderLine,
  type ShopifyOrderNode,
} from '../mappers/order'
import {
  heartbeatBatch,
  heartbeatWhile,
  makeReconcileHeartbeat,
  type HeartbeatClock,
} from '../heartbeat'

/**
 * The Shopify orders import adapter — the largest and the one where correctness is hardest to prove.
 *
 * Core owns the run record, counters, cursor persistence and cancellation; this file owns the async
 * generator, the id resolution the pure mapper cannot do, and the two guards that keep an order
 * history sync from destroying data.
 *
 * SEVEN THINGS THAT DECIDE WHETHER THIS IS CORRECT OR CATASTROPHIC:
 *
 * 1. 🔴 THE 60-DAY WINDOW GATES RECONCILIATION. `read_all_orders` is not granted, so Shopify's
 *    `Order` query returns only the last 60 days. A full-set reconciliation on a backfill that only
 *    saw 60 days would soft-delete every order older than that. So reconciliation runs ONLY when the
 *    credential reports a `full` order window AND this is a full run. The default when the window is
 *    unknown is `sixty_days` — the safe direction — because guessing `full` deletes history.
 *
 * 2. 🔴 FULL-SET RECONCILIATION IS DOUBLE-GUARDED: `!input.cursor` (a delta legitimately sees only
 *    changed orders) AND `window === 'full'` (#1). Either guard alone is insufficient.
 *
 * 3. TOTALS ARE RECONCILED BY CONSTRUCTION, NOT ASSERTED AFTER. The order command recomputes every
 *    total from the lines and adjustments it is handed, so the mapper shapes those inputs to make
 *    core's arithmetic land on Shopify's figures (see `lib/mappers/order.ts`). This file only
 *    resolves ids and dispatches.
 *
 * 4. LINE VARIANTS RESOLVE UNDER THE PRODUCTS INTEGRATION, THEN SKU. The variant was mapped by the
 *    products sync, so its GID lives in the mapping table partitioned by `INTEGRATION_ID.products` —
 *    not this one. A line whose variant cannot be resolved is RECORDED with no variant, never
 *    dropped and never given a fabricated one.
 *
 * 5. PAYMENTS AND SHIPMENTS ARE READ-ONLY CHILDREN via a direct `execute` port, mapped by their own
 *    GID so a re-run neither duplicates nor rewrites them. A child failure is reported, never thrown.
 *
 * 6. R-13: the delta query is a filtered `updated_at` query, so it sends `SEARCH_DEBUG_HEADER` and
 *    asserts `extensions.search[].warnings` is empty — an ignored filter silently returns the whole
 *    (windowed) order set and would drive the reconcile into deleting everything the "delta" missed.
 *
 * 7. PER-ITEM FAILURES ARE REPORTED, NEVER THROWN. A throw aborts the run via `finalizeRun('failed')`,
 *    losing every order that had already succeeded.
 */

// ── Injected runtime ─────────────────────────────────────────────────────────────────────────

/** The bus envelope, so a child create can read the id it returns. */
export type OrdersExecuteResult = { result: unknown }

export type OrdersMappingPort = ExternalIdMappingPort & {
  /** Ownership gate for reconciliation: which Shopify order a local row came from, or null. */
  lookupExternalId(
    integrationId: string,
    entityType: string,
    localId: string,
    scope: TenantScope,
  ): Promise<string | null>
}

export type OrderSyncRuntime = {
  client: ShopifyClient
  /** Built by di for `INTEGRATION_ID.orders`. */
  writer: EntityWriter
  mapping: OrdersMappingPort
  /** Scoped id read for `SalesOrder`. */
  readOrder(localId: string): Promise<EntityRow | null>
  /** Natural-key heal: an order whose GID is already on `external_reference` but lost its mapping. */
  findOrderByExternalReference(externalReference: string): Promise<EntityRow | null>
  /**
   * Resolve a Shopify variant GID to a local `CatalogProductVariant` id, then fall back to SKU.
   *
   * The lookup is partitioned by `INTEGRATION_ID.products` — the variant was mapped by the products
   * sync, so resolving it under this integration would always miss.
   */
  resolveVariantLocalId(variantExternalId: string | null, sku: string | null): Promise<string | null>
  /** Resolve a Shopify customer GID to a local `CustomerEntity` id, under `INTEGRATION_ID.customers`. */
  resolveCustomerLocalId(customerExternalId: string): Promise<string | null>
  /**
   * Natural-key heal for the customer link: resolve a local `CustomerEntity` id by its
   * `primaryEmail`. Reached ONLY when the GID mapping is absent — the customers sync ran after this
   * order, or has not run yet — mirroring how the customers adapter itself adopts a row by email.
   * The order link lives in a column the content hash cannot see, so this is what lets a re-run
   * attach a customer to an order that was first imported before that customer existed locally.
   */
  resolveCustomerLocalIdByEmail(email: string): Promise<string | null>
  /**
   * OPTIONAL. Map Shopify's display statuses to dictionary entry ids for the native
   * `payment_status`/`fulfillment_status` columns. Absent by default: the order command populates
   * those columns only from `*EntryId`s (never raw text), so without this port the statuses are kept
   * in `metadata.shopify` and the native columns stay null. Wire it once a status dictionary exists.
   */
  resolveStatusEntryIds?(input: {
    financialStatus: string | null
    fulfillmentStatus: string | null
  }): Promise<{ paymentStatusEntryId?: string; fulfillmentStatusEntryId?: string }>
  /** Direct command dispatch for children (payments, shipments) and order soft-delete. */
  execute(commandId: string, input: Record<string, unknown>): Promise<OrdersExecuteResult>
  /** Every order local id this integration has mapped — the left-hand side of full-set reconciliation. */
  listOwnedOrderIds(): Promise<string[]>
}

export type OrderSyncLogEvent =
  | { kind: 'batch'; batchIndex: number; items: number; mode: 'backfill' | 'delta' }
  | { kind: 'window'; window: 'full' | 'sixty_days'; reconcile: boolean }
  | { kind: 'mapping_notes'; externalId: string; notes: string[] }
  | { kind: 'reconciled'; deactivated: number; skippedNotOwned: number }
  | { kind: 'bulk_partial'; objectCount: number | null }

export type OrdersAdapterOptions = {
  createRuntime(input: {
    credentials: Record<string, unknown>
    scope: TenantScope
  }): Promise<OrderSyncRuntime>
  log?: (event: OrderSyncLogEvent) => void
  /**
   * Overridden in tests so the backfill path runs without a real bulk operation. Accepts the real
   * `BulkExportOptions` so the bulk-poll heartbeat can compose an `onPoll` callback onto it; the
   * existing 2-arg test stubs remain assignable.
   */
  bulkExport?: (client: ShopifyClient, query: string, options?: BulkExportOptions) => Promise<BulkExport>
  /**
   * Beat cadence for the liveness heartbeats (bulk-poll and reconcile sweep). Defaults to
   * `DEFAULT_HEARTBEAT_INTERVAL_MS`. Production omits it; tests set it small.
   */
  heartbeatIntervalMs?: number
  /** Injectable timer for the bulk-poll heartbeat; defaults to real `setTimeout`. Tests only. */
  heartbeatClock?: HeartbeatClock
  /** Injectable clock for the reconcile-sweep heartbeat gate; defaults to `Date.now`. Tests only. */
  now?: () => number
}

/** Shopify caps a page at 250; orders are heavy, so the delta default is smaller. */
const MAX_PAGE_SIZE = 250
const DEFAULT_ORDER_PAGE_SIZE = 25
const LINE_PAGE_SIZE = 50

// ── The order window ─────────────────────────────────────────────────────────────────────────

/**
 * How far back this connection can see orders — and therefore whether a full run may reconcile.
 *
 * Read from the credential first; fall back to deriving it from the granted scopes. When neither is
 * present the answer is `sixty_days`, the SAFE default: a full-set reconcile scoped to 60 days would
 * delete every order older than that, so an unknown window must never be treated as `full`.
 */
export function resolveOrderWindow(credentials: Record<string, unknown>): 'full' | 'sixty_days' {
  const declared = credentials.orderHistoryWindow
  if (declared === 'full' || declared === 'sixty_days') return declared
  const granted = credentials.grantedScopes
  if (Array.isArray(granted)) return deriveOrderWindow(granted.filter((s): s is string => typeof s === 'string'))
  return 'sixty_days'
}

// ── R-13: the silently-ignored search filter ─────────────────────────────────────────────────

export class OrdersSyncError extends Error {
  constructor(
    readonly code: 'search_filter_ignored',
    message: string,
  ) {
    super(message)
    this.name = 'OrdersSyncError'
  }
}

export function readSearchWarnings(extensions: Record<string, unknown> | undefined): string[] {
  const search = extensions?.search
  if (!Array.isArray(search)) return []
  const warnings: string[] = []
  for (const entry of search) {
    const raw = (entry as Record<string, unknown> | null)?.warnings
    if (!Array.isArray(raw)) continue
    for (const warning of raw) {
      if (typeof warning === 'string') {
        warnings.push(warning)
        continue
      }
      const record = warning as Record<string, unknown> | null
      const field = typeof record?.field === 'string' ? record.field : null
      const message = typeof record?.message === 'string' ? record.message : null
      if (field || message) warnings.push([field, message].filter(Boolean).join(': '))
    }
  }
  return warnings
}

export function assertSearchWarningsEmpty(extensions: Record<string, unknown> | undefined): void {
  const warnings = readSearchWarnings(extensions)
  if (warnings.length === 0) return
  throw new OrdersSyncError(
    'search_filter_ignored',
    `[internal] Shopify reported search warnings for the order delta query: ${JSON.stringify(warnings)}; ` +
      'an unrecognised field is ignored rather than rejected, so this run would rescan every order',
  )
}

/**
 * The header-independent belt: a returned order older than the window we asked for proves the filter
 * was ignored in effect, even if Shopify emitted no warning.
 */
export function assertDeltaWindowRespected(nodes: ShopifyOrderNode[], updatedAfter: string): void {
  const floor = Date.parse(updatedAfter)
  if (!Number.isFinite(floor)) return
  for (const node of nodes) {
    const seen = normalizeTimestamp(node.updatedAt)
    if (seen !== null && Date.parse(seen) < floor) {
      throw new OrdersSyncError(
        'search_filter_ignored',
        `[internal] order delta asked for updated_at > ${updatedAfter} but Shopify returned ` +
          `${node.id} updated at ${seen}; the filter was ignored and this run would rescan every order`,
      )
    }
  }
}

// ── GraphQL ──────────────────────────────────────────────────────────────────────────────────

const MONEY_BAG = `{ shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }`

const ORDER_SCALARS = `
    id
    name
    email
    note
    createdAt
    processedAt
    updatedAt
    cancelledAt
    cancelReason
    currencyCode
    presentmentCurrencyCode
    taxesIncluded
    displayFinancialStatus
    displayFulfillmentStatus
    customer { id email }
    billingAddress { firstName lastName name company address1 address2 city province provinceCode country countryCodeV2 zip phone }
    shippingAddress { firstName lastName name company address1 address2 city province provinceCode country countryCodeV2 zip phone }
    totalPriceSet ${MONEY_BAG}
    subtotalPriceSet ${MONEY_BAG}
    totalTaxSet ${MONEY_BAG}
    totalDiscountsSet ${MONEY_BAG}
    totalShippingPriceSet ${MONEY_BAG}`

const LINE_SELECTION = `
      id
      name
      sku
      quantity
      variant { id sku }
      originalUnitPriceSet ${MONEY_BAG}
      discountedUnitPriceSet ${MONEY_BAG}
      taxLines { title ratePercentage priceSet ${MONEY_BAG} }
      discountAllocations { allocatedAmountSet ${MONEY_BAG} }`

// `id` is REQUIRED, not cosmetic: in the bulk export `shippingLines` is a connection
// (`ShippingLineConnection`), so each line arrives as its OWN JSONL record, and the reassembler
// keys a child to its parent by the type segment of its GID. A shipping line selected without `id`
// reassembles as an id-less line, which the reassembler rejects as `missing_id` — failing the whole
// export. The delta path nests these under the order so it never needed the id, which is exactly how
// the omission survived. `ShippingLine` implements Node, so the field is available on both paths.
const SHIPPING_SELECTION = `id title originalPriceSet ${MONEY_BAG} taxLines { title priceSet ${MONEY_BAG} }`

/**
 * Backfill document.
 *
 * `lineItems` and `shippingLines` are the only connections (max 5, we use 2); `taxLines` and
 * `discountAllocations` are inline lists, not connections, so they cost nothing against that budget
 * and arrive on the parent's own JSONL line. Transactions, refunds and fulfillments are NOT in the
 * backfill: they would push past the connection budget, and they carry no total, so a backfilled
 * order still reconciles exactly and gains its payments/shipments on the next delta.
 */
export function buildOrderBulkQuery(): string {
  return `{
  orders {
    edges {
      node {${ORDER_SCALARS}
        lineItems {
          edges { node {${LINE_SELECTION}
          } }
        }
        shippingLines {
          edges { node { ${SHIPPING_SELECTION} } }
        }
      }
    }
  }
}`
}

/**
 * Delta document.
 *
 * A normal query is bounded by cost, not the bulk connection budget, so it can also pull the
 * transactions, refunds and fulfillments a backfill cannot. `sortKey: UPDATED_AT` paired with the
 * `updated_at` filter is what lets Shopify walk an index instead of timing out.
 */
const ORDERS_DELTA_QUERY = `#graphql
  query SyncShopifyOrdersDelta($first: Int!, $after: String, $query: String, $lines: Int!) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {${ORDER_SCALARS}
          lineItems(first: $lines) {
            nodes {${LINE_SELECTION}
            }
          }
          shippingLines(first: 10) { nodes { ${SHIPPING_SELECTION} } }
          transactions(first: 20) { id kind status gateway processedAt amountSet ${MONEY_BAG} }
          refunds(first: 20) { id createdAt totalRefundedSet ${MONEY_BAG} }
          fulfillments(first: 20) {
            id status displayStatus createdAt deliveredAt estimatedDeliveryAt
            trackingInfo { company number url }
            fulfillmentLineItems(first: 50) { nodes { quantity lineItem { id } } }
          }
        }
      }
    }
  }
`

export function buildUpdatedAtFilter(updatedAfter: string | null): string | null {
  if (!updatedAfter) return null
  return `updated_at:>'${updatedAfter}'`
}

// ── Payload normalisation ────────────────────────────────────────────────────────────────────

type DeltaResponse = {
  orders?: {
    edges?: ({ node?: ShopifyOrderNode | null } | null)[] | null
    pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null
  } | null
}

/**
 * Fold a reassembled bulk node back into the shape the mapper expects.
 *
 * Bulk JSONL delivers `lineItems` and `shippingLines` as `__parentId`-linked children; the mapper
 * consumes them as `{ nodes: [...] }`, so normalising here means the two paths cannot import
 * different data.
 */
export function bulkNodeToOrder(node: BulkNode): ShopifyOrderNode {
  const fields = node.fields as Omit<ShopifyOrderNode, 'id' | 'lineItems' | 'shippingLines'>
  const lineItems = childrenOfType(node, 'LineItem').map(
    (child) => ({ id: child.id, ...child.fields }) as ShopifyOrderLine,
  )
  const shippingLines = childrenOfType(node, 'ShippingLine').map((child) => ({ ...child.fields }))
  return {
    ...fields,
    id: node.id,
    lineItems: { nodes: lineItems },
    shippingLines: { nodes: shippingLines },
  }
}

function deltaNodeToOrder(node: ShopifyOrderNode): ShopifyOrderNode {
  // The delta query already returns `{ nodes }` for the list fields; nothing to reshape.
  return node
}

// ── Failure reporting ────────────────────────────────────────────────────────────────────────

function failedItem(externalId: string, stage: string, message: string): ImportItem {
  return {
    externalId,
    action: 'failed',
    data: { sourceIdentifier: externalId, errorMessage: `Shopify order ${externalId} failed at ${stage}: ${message}` },
  }
}

function readCreatedId(result: unknown, key: string): string | null {
  const payload = (result ?? {}) as Record<string, unknown>
  const id = payload[key] ?? payload.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function readStoredHash(row: EntityRow | null | undefined): string | null {
  const metadata = row?.metadata
  if (!metadata || typeof metadata !== 'object') return null
  const namespace = (metadata as Record<string, unknown>).shopify
  if (!namespace || typeof namespace !== 'object') return null
  const hash = (namespace as Record<string, unknown>).contentHash
  return typeof hash === 'string' && hash.length > 0 ? hash : null
}

/** The stored order's current customer link, or null — the signal the self-heal re-link keys on. */
function readCustomerEntityId(row: EntityRow | null | undefined): string | null {
  const value = row?.customerEntityId
  return typeof value === 'string' && value.length > 0 ? value : null
}

// ── Order input assembly ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the local customer id for an order — GID mapping first, email second.
 *
 * Only an order Shopify itself attributed to a customer is ever linked: a guest order (no
 * `customer`) is left unlinked even when its email matches a local customer, matching Shopify's own
 * model. When the customer exists on Shopify but its GID mapping is not present yet — the customers
 * sync ran after this order, or has not run — the email natural key heals the link, exactly as the
 * customers adapter adopts a row by `primaryEmail`.
 *
 * Hoisted out of `buildOrderInput` on purpose: the update path compares this against the stored
 * order so a customer-less order can be RE-LINKED later. The link sits in no column the content hash
 * covers, so without that comparison an order imported before its customer existed would be skipped
 * on every subsequent run and never gain the link.
 */
async function resolveCustomerEntityId(
  runtime: OrderSyncRuntime,
  mapped: MappedOrder,
): Promise<string | null> {
  if (!mapped.customerExternalId) return null
  const byGid = await runtime.resolveCustomerLocalId(mapped.customerExternalId)
  if (byGid) return byGid
  if (mapped.customerEmail) {
    const byEmail = await runtime.resolveCustomerLocalIdByEmail(mapped.customerEmail)
    if (byEmail) return byEmail
  }
  return null
}

/**
 * Turn a mapped order into the `sales.orders.create`/`update` payload.
 *
 * This is where the pure mapper's outputs meet the ids only the runtime can resolve: the customer,
 * every line's variant, and — when wired — the status dictionary entries. The lines and adjustments
 * are passed inline so core computes and reconciles the totals atomically, and full-replaces the
 * lines on update (an order edited upstream keeps only the lines it still has).
 */
async function buildOrderInput(
  mapped: MappedOrder,
  runtime: OrderSyncRuntime,
  scope: TenantScope,
  notes: string[],
  customerEntityId: string | null,
): Promise<Record<string, unknown>> {
  const lines: Record<string, unknown>[] = []
  for (const line of mapped.lines) {
    const variantLocalId = await runtime.resolveVariantLocalId(line.variantExternalId, line.sku)
    if (line.variantExternalId !== null && variantLocalId === null) {
      // Recorded, never dropped and never fabricated: the line is kept with no variant so the order
      // still reconciles and the missing variant is visible in the line metadata.
      notes.push('variant_unresolved')
    }
    lines.push(buildLineInput(line, variantLocalId))
  }

  const adjustments = mapped.adjustments.map((adj) => ({
    kind: adj.kind,
    label: adj.label,
    ...(adj.code ? { code: adj.code } : {}),
    amountNet: adj.amount,
    amountGross: adj.amount,
    position: adj.position,
    ...(adj.metadata ? { metadata: adj.metadata } : {}),
  }))

  const statusEntryIds = runtime.resolveStatusEntryIds
    ? await runtime.resolveStatusEntryIds({
        financialStatus: mapped.financialStatus,
        fulfillmentStatus: mapped.fulfillmentStatus,
      })
    : {}

  // The content hash is embedded in the same namespace the mapper populated, so the next run can read
  // it back off the persisted row and skip an unchanged order.
  const header = { ...mapped.header }
  const metadata = { ...(header.metadata as Record<string, unknown>) }
  const namespace = { ...((metadata.shopify as Record<string, unknown>) ?? {}), contentHash: mapped.contentHash }
  metadata.shopify = namespace
  header.metadata = metadata

  return {
    ...header,
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    ...(customerEntityId ? { customerEntityId } : {}),
    ...(statusEntryIds.paymentStatusEntryId ? { paymentStatusEntryId: statusEntryIds.paymentStatusEntryId } : {}),
    ...(statusEntryIds.fulfillmentStatusEntryId
      ? { fulfillmentStatusEntryId: statusEntryIds.fulfillmentStatusEntryId }
      : {}),
    lines,
    adjustments,
  }
}

function buildLineInput(line: MappedOrderLine, variantLocalId: string | null): Record<string, unknown> {
  return {
    kind: 'product',
    name: line.name,
    quantity: String(line.quantity),
    currencyCode: line.currencyCode,
    unitPriceNet: line.unitPriceNet,
    taxAmount: line.taxAmount,
    ...(variantLocalId ? { productVariantId: variantLocalId } : {}),
    metadata: { shopify: line.metadata },
  }
}

// ── Children: payments and shipments ─────────────────────────────────────────────────────────

/**
 * Create a read-only child (payment or shipment) once, keyed by its own GID.
 *
 * Mapping-gated idempotency: a child already mapped by this integration is left untouched, so a
 * re-run neither duplicates nor rewrites imported records. A failure is returned as a failed item —
 * never thrown, so one bad transaction cannot abort the order run.
 */
async function upsertChild(
  runtime: OrderSyncRuntime,
  scope: TenantScope,
  input: {
    externalId: string
    mappingEntityType: string
    createCommand: string
    resultKey: string
    buildInput: () => Record<string, unknown>
  },
): Promise<ImportItem> {
  try {
    const existing = await runtime.mapping.lookupLocalId(
      INTEGRATION_ID.orders,
      input.mappingEntityType,
      input.externalId,
      scope,
    )
    if (existing) {
      return { externalId: input.externalId, action: 'skip', data: { localId: existing } }
    }
    const created = await runtime.execute(input.createCommand, input.buildInput())
    const localId = readCreatedId(created.result, input.resultKey)
    if (localId === null) {
      return failedItem(input.externalId, input.createCommand, 'command returned no id')
    }
    await runtime.mapping.storeExternalIdMapping(
      INTEGRATION_ID.orders,
      input.mappingEntityType,
      localId,
      input.externalId,
      scope,
    )
    return { externalId: input.externalId, action: 'create', data: { localId } }
  } catch (error) {
    return failedItem(input.externalId, input.createCommand, error instanceof Error ? error.message : String(error))
  }
}

function paymentInput(payment: MappedPayment, orderLocalId: string, scope: TenantScope): Record<string, unknown> {
  return {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    orderId: orderLocalId,
    amount: payment.amount,
    currencyCode: payment.currencyCode,
    ...(payment.capturedAmount ? { capturedAmount: payment.capturedAmount } : {}),
    ...(payment.refundedAmount ? { refundedAmount: payment.refundedAmount } : {}),
    ...(payment.receivedAt ? { receivedAt: payment.receivedAt } : {}),
    ...(payment.paymentReference ? { paymentReference: payment.paymentReference } : {}),
    metadata: { shopify: payment.metadata },
  }
}

function shipmentInput(shipment: MappedShipment, orderLocalId: string, scope: TenantScope): Record<string, unknown> {
  return {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    orderId: orderLocalId,
    ...(shipment.carrierName ? { carrierName: shipment.carrierName } : {}),
    ...(shipment.trackingNumbers.length > 0 ? { trackingNumbers: shipment.trackingNumbers } : {}),
    ...(shipment.shippedAt ? { shippedAt: shipment.shippedAt } : {}),
    ...(shipment.deliveredAt ? { deliveredAt: shipment.deliveredAt } : {}),
    metadata: { shopify: shipment.metadata },
  }
}

async function syncChildren(
  runtime: OrderSyncRuntime,
  scope: TenantScope,
  orderLocalId: string,
  mapped: MappedOrder,
): Promise<ImportItem[]> {
  const items: ImportItem[] = []
  for (const payment of mapped.payments) {
    items.push(
      await upsertChild(runtime, scope, {
        externalId: payment.externalId,
        mappingEntityType: MAPPING_ENTITY_TYPE.salesPayment,
        createCommand: COMMAND.paymentCreate,
        resultKey: COMMAND_RESULT_KEY.payment,
        buildInput: () => paymentInput(payment, orderLocalId, scope),
      }),
    )
  }
  for (const shipment of mapped.shipments) {
    items.push(
      await upsertChild(runtime, scope, {
        externalId: shipment.externalId,
        mappingEntityType: MAPPING_ENTITY_TYPE.salesShipment,
        createCommand: COMMAND.shipmentCreate,
        resultKey: COMMAND_RESULT_KEY.shipment,
        buildInput: () => shipmentInput(shipment, orderLocalId, scope),
      }),
    )
  }
  return items
}

// ── One order ────────────────────────────────────────────────────────────────────────────────

async function importOrder(
  runtime: OrderSyncRuntime,
  scope: TenantScope,
  node: ShopifyOrderNode,
  log: ((event: OrderSyncLogEvent) => void) | undefined,
): Promise<{ items: ImportItem[]; localId: string | null; updatedAt: string | null }> {
  let mapped: MappedOrder
  try {
    mapped = mapOrder(node)
  } catch (error) {
    return {
      items: [failedItem(node.id, 'mapping', error instanceof Error ? error.message : String(error))],
      localId: null,
      updatedAt: null,
    }
  }

  const notes = [...mapped.notes]

  // Resolve the customer ONCE, up front, so the update path can compare it against the stored order.
  // The link is written into `customer_entity_id`, a column no content-hash field covers, so an order
  // first imported before its customer's mapping existed carries a null the hash cannot see. Holding
  // the resolved id here is what lets the update branch below re-link it on a later run.
  const customerEntityId = await resolveCustomerEntityId(runtime, mapped)

  const outcome = await runtime.writer.upsert({
    externalId: mapped.externalId,
    mappingEntityType: MAPPING_ENTITY_TYPE.salesOrder,
    createCommand: COMMAND.orderCreate,
    updateCommand: COMMAND.orderUpdate,
    resultKey: COMMAND_RESULT_KEY.order,
    readById: runtime.readOrder,
    findByNaturalKey: () => runtime.findOrderByExternalReference(mapped.externalId),
    buildCreateInput: () => buildOrderInput(mapped, runtime, scope, notes, customerEntityId),
    // The hash sits in the persisted order's `metadata.shopify.contentHash`; an unchanged order costs
    // one read and no write, and its children are then left alone — UNLESS we can now attach a
    // customer the stored row is missing. A resolvable customer the order lacks forces the one rewrite
    // that finally lands the link (the hash can't see it); when the customer still cannot be resolved
    // the run falls through to the skip, so there is no churn while customers are yet to sync.
    buildUpdateInput: async ({ row }) => {
      if (readStoredHash(row) === mapped.contentHash) {
        const canRelinkCustomer = customerEntityId !== null && readCustomerEntityId(row) === null
        if (!canRelinkCustomer) return null
      }
      return buildOrderInput(mapped, runtime, scope, notes, customerEntityId)
    },
  })

  if (notes.length > 0) log?.({ kind: 'mapping_notes', externalId: mapped.externalId, notes })

  const items = [toImportItem(outcome, { lineCount: mapped.lines.length, notes })]
  if (!outcome.ok) return { items, localId: null, updatedAt: mapped.updatedAt }

  // Children are only touched when the order itself was written; an unchanged order's payments and
  // shipments are already imported and idempotent under the mapping gate anyway.
  if (outcome.action !== 'skip') {
    items.push(...(await syncChildren(runtime, scope, outcome.localId, mapped)))
  }

  return { items, localId: outcome.localId, updatedAt: mapped.updatedAt }
}

// ── Reconciliation ───────────────────────────────────────────────────────────────────────────

/**
 * Soft-delete orders this integration owns that a full run did not see.
 *
 * 🔴 Only ever reached behind BOTH guards: `!input.cursor` and `window === 'full'`. Orders are the
 * customer's financial history — a reconcile that ran against a 60-day-limited backfill would delete
 * every order older than 60 days. Ownership-gated the same way every other reconcile is.
 *
 * A generator, not a plain async function: a large owned-order set makes this sweep run silent for
 * well past the 60s watchdog, so it yields a time-gated heartbeat to keep the job alive. The
 * soft-delete items it produces are handed back through the generator's RETURN value, which the
 * caller captures via `yield*` and emits on the terminal reconcile batch exactly as before.
 */
async function* reconcileOrders(
  runtime: OrderSyncRuntime,
  scope: TenantScope,
  seenLocalIds: Set<string>,
  log: ((event: OrderSyncLogEvent) => void) | undefined,
  due: () => boolean,
  cursor: string,
  nextBatchIndex: () => number,
): AsyncGenerator<ImportBatch, ImportItem[]> {
  const items: ImportItem[] = []
  let deactivated = 0
  let skippedNotOwned = 0
  let checked = 0

  for (const localId of await runtime.listOwnedOrderIds()) {
    checked += 1
    // Beat BEFORE the ownership branches, and time-gated, so the job stays alive during a long
    // sweep regardless of how many orders are skipped as already-seen or not-owned. The cursor is
    // unchanged (nothing to resume mid-sweep) and no items ride along, so no tally moves.
    if (due()) {
      yield heartbeatBatch({
        cursor,
        batchIndex: nextBatchIndex(),
        message: `Reconciling Shopify orders… ${checked} checked`,
      })
    }

    if (seenLocalIds.has(localId)) continue
    const externalId = await runtime.mapping.lookupExternalId(
      INTEGRATION_ID.orders,
      MAPPING_ENTITY_TYPE.salesOrder,
      localId,
      scope,
    )
    if (!externalId) {
      skippedNotOwned += 1
      continue
    }
    try {
      await runtime.execute(COMMAND.orderDelete, {
        id: localId,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
      })
      deactivated += 1
      items.push({ externalId, action: 'update', data: { localId, reason: 'absent_from_shopify_full_sync' } })
    } catch (error) {
      items.push(failedItem(externalId, COMMAND.orderDelete, error instanceof Error ? error.message : String(error)))
    }
  }

  log?.({ kind: 'reconciled', deactivated, skippedNotOwned })
  return items
}

// ── Adapter ──────────────────────────────────────────────────────────────────────────────────

const ORDER_MAPPING: DataMapping = {
  entityType: ENTITY_TYPE.order,
  matchStrategy: 'externalId',
  fields: [
    { externalField: 'id', localField: 'externalReference', mappingKind: 'external_id', dedupeRole: 'primary' },
    { externalField: 'name', localField: 'orderNumber', mappingKind: 'core' },
    { externalField: 'customer.id', localField: 'customerEntityId', mappingKind: 'relation' },
    { externalField: 'displayFinancialStatus', localField: 'metadata.shopify.financialStatus', mappingKind: 'metadata' },
    { externalField: 'displayFulfillmentStatus', localField: 'metadata.shopify.fulfillmentStatus', mappingKind: 'metadata' },
    { externalField: 'billingAddress', localField: 'billingAddressSnapshot', mappingKind: 'core' },
    { externalField: 'shippingAddress', localField: 'shippingAddressSnapshot', mappingKind: 'core' },
    { externalField: 'totalPriceSet.shopMoney', localField: 'grandTotalGrossAmount', mappingKind: 'core', transform: 'derived from lines + adjustments' },
    { externalField: 'totalTaxSet.shopMoney', localField: 'taxTotalAmount', mappingKind: 'core', transform: 'tax adjustment' },
    { externalField: 'totalDiscountsSet.shopMoney', localField: 'discountTotalAmount', mappingKind: 'core', transform: 'discount adjustments' },
    { externalField: 'lineItems', localField: 'lines', mappingKind: 'relation' },
    { externalField: 'transactions', localField: 'payments', mappingKind: 'relation' },
    { externalField: 'fulfillments', localField: 'shipments', mappingKind: 'relation' },
  ],
}

export function createOrdersAdapter(options: OrdersAdapterOptions): DataSyncAdapter {
  const log = options.log

  async function* streamImport(input: StreamImportInput): AsyncIterable<ImportBatch> {
    const runtime = await options.createRuntime({ credentials: input.credentials, scope: input.scope })

    // 🔴 THE TWO GUARDS. A delta sees only changed orders (reconciling would wipe the rest); a
    // 60-day-limited backfill sees only recent orders (reconciling would wipe history). Both must be
    // clear before the full-set reconcile may run. Keyed on the RAW cursor: a cursor too malformed to
    // parse still means a previous run existed, so treat it as "not a first full run".
    const isFullSync = !input.cursor
    const window = resolveOrderWindow(input.credentials)
    const mayReconcile = isFullSync && window === 'full'
    log?.({ kind: 'window', window, reconcile: mayReconcile })

    let state = parseCursor(input.cursor)
    const pageSize = Math.min(Math.max(input.batchSize || DEFAULT_ORDER_PAGE_SIZE, 1), MAX_PAGE_SIZE)
    const seenLocalIds = new Set<string>()

    let batchIndex = 0
    let pending: ImportItem[] = []

    const emit = (next: ShopifyCursorState, hasMore: boolean, message?: string): ImportBatch => {
      const batch: ImportBatch = {
        items: pending,
        cursor: serializeCursor(next),
        hasMore,
        batchIndex,
        // Per-batch delta (matching products.ts / customers.ts), NOT a running cumulative: the engine
        // SUMS `processedCount` across batches, so a cumulative here triangular-inflates the total.
        processedCount: pending.length,
        ...(message ? { message } : {}),
      }
      pending = []
      batchIndex += 1
      return batch
    }

    async function handle(node: ShopifyOrderNode): Promise<void> {
      const result = await importOrder(runtime, input.scope, node, log)
      pending.push(...result.items)
      if (result.localId !== null) seenLocalIds.add(result.localId)
      state = advanceCursor(state, { maxUpdatedAt: result.updatedAt })
    }

    const mode: 'backfill' | 'delta' = isFullSync || state?.kind === 'bulk' ? 'backfill' : 'delta'

    if (mode === 'backfill') {
      // The bulk export blocks on a poll loop (up to an hour) that yields nothing. Stash the live
      // operation via `onPoll` and beat while it runs, so the job's heartbeat stays fresh past the
      // 60s watchdog and the run log shows scan progress — object counts only, never PII (and an
      // order's object count never reveals the customer behind it).
      let lastOp: BulkOperation | null = null
      const exportPromise = (options.bulkExport ?? runBulkExport)(runtime.client, buildOrderBulkQuery(), {
        onPoll: (op) => {
          lastOp = op
        },
      })
      yield* heartbeatWhile(
        exportPromise,
        () =>
          heartbeatBatch({
            cursor: serializeCursor(state ?? { kind: 'idle', updatedAfter: null }),
            batchIndex: batchIndex++,
            message: `Exporting Shopify orders… ${lastOp?.objectCount ?? 0} rows scanned`,
          }),
        { intervalMs: options.heartbeatIntervalMs, clock: options.heartbeatClock },
      )
      const exported = await exportPromise
      if (exported.partial) log?.({ kind: 'bulk_partial', objectCount: exported.operation.objectCount })

      if (exported.nodes) {
        for await (const node of exported.nodes) {
          // Children (line items, shipping lines) arrive on their own lines; only a top-level order
          // starts a record.
          if (node.type !== 'Order') continue
          await handle(bulkNodeToOrder(node))
          if (pending.length >= pageSize) {
            log?.({ kind: 'batch', batchIndex, items: pending.length, mode })
            // A bulk export cannot resume mid-stream, so intermediate batches carry the state
            // unchanged: a crash restarts the export rather than resuming into a gap.
            yield emit(state ?? { kind: 'idle', updatedAfter: null }, true)
          }
        }
      }
    } else {
      const updatedAfter = state?.updatedAfter ?? null
      const filter = buildUpdatedAtFilter(updatedAfter)
      let after = state?.kind === 'paging' ? state.endCursor : null

      for (;;) {
        const { data, extensions } = await runtime.client.requestDetailed<DeltaResponse>(ORDERS_DELTA_QUERY, {
          variables: { first: pageSize, after, query: filter, lines: LINE_PAGE_SIZE },
          estimatedCost: pageSize * 2,
          // Without this header Shopify never populates `extensions.search`, and the R-13 guard below
          // is wired but permanently silent.
          headers: SEARCH_DEBUG_HEADER,
        })

        const edges = data?.orders?.edges ?? []
        const nodes = edges
          .map((edge) => edge?.node)
          .filter((node): node is ShopifyOrderNode => node != null)
          .map(deltaNodeToOrder)

        // 🔴 R-13, asserted BEFORE any write: an ignored `updated_at` returns the whole (windowed)
        // order set — a silent full scan that would look complete and drive the reconcile into
        // deleting everything the "delta" did not include. Guarded on `filter` because an unfiltered
        // first page has nothing to warn about.
        if (filter) assertSearchWarningsEmpty(extensions)
        if (updatedAfter) assertDeltaWindowRespected(nodes, updatedAfter)

        for (const node of nodes) await handle(node)

        const pageInfo = data?.orders?.pageInfo
        const endCursor = pageInfo?.endCursor ?? null
        after = endCursor
        if (pageInfo?.hasNextPage && endCursor) {
          state = advanceCursor(state, { next: { kind: 'paging', endCursor } })
          log?.({ kind: 'batch', batchIndex, items: pending.length, mode })
          yield emit(state, true)
          continue
        }
        break
      }
    }

    // Run over: promote the watermark so the next run is incremental.
    state = advanceCursor(state, {})

    if (mayReconcile) {
      if (pending.length > 0) {
        log?.({ kind: 'batch', batchIndex, items: pending.length, mode })
        yield emit(state, true)
      }
      // `yield*` delegates the reconcile sweep's heartbeats into this stream and, at the end, hands
      // back the soft-delete items via the generator's return value.
      const reconcileItems = yield* reconcileOrders(
        runtime,
        input.scope,
        seenLocalIds,
        log,
        makeReconcileHeartbeat({ intervalMs: options.heartbeatIntervalMs, now: options.now }),
        serializeCursor(state),
        () => batchIndex++,
      )
      pending.push(...reconcileItems)
      yield {
        ...emit(state, false, 'Reconciling Shopify orders after the final batch'),
        // Reconcile soft-deletes are not "processed source orders": the terminal batch carries them
        // for reporting but contributes 0 to the engine's running total.
        processedCount: 0,
        refreshCoverageEntityTypes: [OM_ENTITY_ID.salesOrder],
      }
      return
    }

    log?.({ kind: 'batch', batchIndex, items: pending.length, mode })
    yield { ...emit(state, false), refreshCoverageEntityTypes: [OM_ENTITY_ID.salesOrder] }
  }

  return {
    providerKey: PROVIDER_KEY.orders,
    direction: 'import',
    supportedEntities: [ENTITY_TYPE.order],
    operationalTelemetry: true,
    streamImport,
    async getInitialCursor() {
      // Null routes the first run down the bulk backfill.
      return null
    },
    async getMapping() {
      return ORDER_MAPPING
    },
  }
}

/** The integration this adapter's mappings are partitioned by. */
export const ORDERS_INTEGRATION_ID = INTEGRATION_ID.orders
