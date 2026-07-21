/**
 * Shopify inventory snapshot adapter — a daily full capture, not a delta.
 *
 * WHY THIS IS ITS OWN INTEGRATION. `product.updated_at` does **not** bump when stock moves, so an
 * `updated_at` cursor would never observe a stock change; inventory folded into the products pass
 * would report success and record nothing (§12.1). It therefore polls on its own schedule with no
 * search filter at all — which also sidesteps R-13, the invalid-search-field trap where Shopify
 * *ignores* a bad filter and silently returns the whole catalog.
 *
 * WHY IT WRITES A TABLE. Demand planning must correct a SKU's trailing sales for the periods it was
 * out of stock; a sold-out item's recorded sales are artificially low, so naive 90-day arithmetic
 * under-orders exactly the best sellers. That needs inventory **over time**, and custom fields are
 * overwritten every sync, so they cannot hold a time series. This is the connector's one argued
 * exception to the zero-tables rule (§12.2) — do not generalise it.
 *
 * FOUR THINGS THAT ARE EASY TO GET WRONG HERE, all of which fail as a confident wrong number:
 *
 *  1. **A missing `available` is never written as 0.** Enforced in `mappers/inventory.ts`; the
 *     level is skipped and counted. A phantom zero is a phantom stockout, which inflates
 *     `oos_ratio`, which inflates the purchase order.
 *  2. **`oos_ratio` is written only when `oosRatio` returns a number.** Null means "not enough
 *     evidence", and a stored 0 reads as "never out of stock". History accrues only forward, so a
 *     fresh install has no valid ratio for ~90 days while looking authoritative.
 *  3. **`snapshot_date` comes from `shop { ianaTimezone }`**, fetched once per run. Day boundaries
 *     define row identity; a wrong zone mis-buckets history and no backfill can repair it. An
 *     unknown zone fails the run rather than guessing — a failed run can simply be re-run.
 *  4. **Writes go direct to the ORM, not the CommandBus** — there is no `inventory.*` command and
 *     this is module-owned data, the same exception Akeneo makes for its raw writes. Every row is
 *     scoped with `organizationId` + `tenantId`; reads go through `findWithDecryption`.
 *
 * Everything with a runtime dependency arrives as an injected port, so the whole pipeline is
 * testable without a network, a container or a database.
 */

import type {
  DataMapping,
  DataSyncAdapter,
  ImportBatch,
  ImportItem,
  StreamImportInput,
  TenantScope,
  ValidationResult,
} from '@open-mercato/core/modules/data_sync/lib/adapter'
import type { ShopifyClient } from '../client'
import {
  childrenOfType,
  parseGid,
  runBulkExport,
  type BulkAnomaly,
  type BulkExportOptions,
  type BulkNode,
  type BulkOperation,
} from '../bulk'
import {
  ENTITY_TYPE,
  INTEGRATION_ID,
  MAPPING_ENTITY_TYPE,
  OM_ENTITY_ID,
  OOS_DEFAULT_WINDOW_DAYS,
  PROVIDER_KEY,
} from '../constants'
import {
  createInventoryHistoryService,
  snapshotDateFor,
  type InventoryHistoryScope,
  type InventoryHistoryStore,
} from '../inventory-history'
import {
  mapVariantInventory,
  REQUESTED_QUANTITY_NAMES,
  readInventoryLevels,
  type InventoryMapSkip,
  type InventorySnapshotDraft,
  type MappedVariantInventory,
  type ShopifyInventoryLevelNode,
  type ShopifyVariantNode,
} from '../mappers/inventory'
import {
  writeCustomFields as writeCustomFieldValues,
  type CustomFieldWriterPort,
  type ExternalIdMappingPort,
} from '../writer'
import { heartbeatBatch, heartbeatWhile, type HeartbeatClock } from '../heartbeat'

// ── Tuning ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Locations read per variant.
 *
 * Ten covers every store this connector realistically meets. `pageInfo.hasNextPage` is queried
 * alongside so a store that exceeds it is *reported* rather than silently losing locations — a
 * truncated connection is indistinguishable from a variant that simply is not stocked elsewhere.
 */
export const MAX_INVENTORY_LEVELS = 10

/**
 * Variants per page.
 *
 * Deliberately below the usual 100. A query's cost is computed from the `first` arguments, not from
 * what comes back, so `first: 100` nesting `inventoryLevels(first: 10)` requests ~1,100 objects and
 * trips the 1,000-point per-query ceiling. 50 x 11 leaves comfortable headroom. Raising this
 * without lowering `MAX_INVENTORY_LEVELS` fails loudly as `max_cost_exceeded` from `lib/client.ts`.
 */
export const DEFAULT_PAGE_SIZE = 50

/** Above this many variants, page-by-page saturates deep pagination; switch to a bulk export. */
export const BULK_VARIANT_THRESHOLD = 2000

/**
 * Custom fields written back onto `catalog:catalog_product_variant`.
 *
 * The `90d` suffix is pinned to `OOS_DEFAULT_WINDOW_DAYS`; changing that constant without renaming
 * these leaves the field names lying about their own window.
 */
export const INVENTORY_CUSTOM_FIELD = {
  unitCost: 'unit_cost',
  oosRatio: 'oos_ratio_90d',
  daysOutOfStock: 'days_out_of_stock_90d',
  // Current-state on-hand and available, written on the same pass as the snapshot. These exist so a
  // downstream consumer (e.g. a purchasing / PO-drafting module) reads current stock off a stable
  // `cf:` seam on the native variant, and never has to reach into this connector's private snapshot
  // table. Aggregated across the variant's locations — see `writeBackCustomFields`.
  onHand: 'on_hand',
  available: 'available',
} as const

// ── GraphQL ─────────────────────────────────────────────────────────────────────────────────────

const QUANTITY_NAME_ARGS = REQUESTED_QUANTITY_NAMES.map((name) => `"${name}"`).join(', ')

/**
 * The variant projection, shared by the paged and bulk documents so the two cannot drift.
 *
 * `variant.inventoryQuantity` is conspicuously absent. The prototype used it, and it collapses
 * every location into a single number — which makes the `(date, variant, location)` unique key
 * meaningless and the multi-location model unrepresentable (§12.5).
 */
function variantFields(levelsArg: string): string {
  return `
    id
    sku
    product { title status productType isGiftCard }
    inventoryItem {
      id
      unitCost { amount }
      requiresShipping
      inventoryLevels${levelsArg} {
        edges { node {
          location { id name }
          quantities(names: [${QUANTITY_NAME_ARGS}]) { name quantity }
        } }
        pageInfo { hasNextPage }
      }
    }
  `
}

const VARIANTS_PAGE_QUERY = `#graphql
  query SyncShopifyInventoryVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      edges { node {${variantFields(`(first: ${MAX_INVENTORY_LEVELS})`)}      } }
      pageInfo { hasNextPage endCursor }
    }
  }
`

/**
 * Bulk form: no `first`/`after` anywhere — bulk operations reject pagination arguments and stream
 * the whole connection instead.
 */
const VARIANTS_BULK_QUERY = `#graphql
  {
    productVariants {
      edges { node {${variantFields('')}      } }
    }
  }
`

const SHOP_TIMEZONE_QUERY = `#graphql
  query SyncShopifyShopTimezone { shop { ianaTimezone } }
`

/** Separate request on purpose — see `fetchVariantCount`. */
const VARIANT_COUNT_QUERY = `#graphql
  query SyncShopifyProductVariantsCount { productVariantsCount { count } }
`

const CONNECTION_CHECK_QUERY = `#graphql
  query SyncShopifyInventoryCheck {
    shop { ianaTimezone }
    locations(first: 1) { edges { node { id name } } }
  }
`

// ── Cursor ──────────────────────────────────────────────────────────────────────────────────────
//
// Not `lib/cursor.ts`: that codec is watermark-shaped (`updatedAfter` / `maxUpdatedAt`) for the
// delta adapters, and inventory has no watermark. What it needs instead is a *day anchor*. A run
// interrupted before midnight and resumed after it would otherwise write the first half of the
// catalog under one `snapshot_date` and the rest under the next — a half-and-half day that reads as
// two partial observations forever, since history cannot be repaired. Carrying the date in the
// cursor lets a resume detect the rollover and start the new day cleanly instead.

export const INVENTORY_CURSOR_VERSION = 1

export type InventoryCursorState = {
  /** The day this run is capturing, in the store's timezone. */
  snapshotDate: string
  /** GraphQL `endCursor`, or null for a run that cannot be resumed mid-stream (bulk). */
  endCursor: string | null
}

export function serializeInventoryCursor(state: InventoryCursorState): string {
  return JSON.stringify({
    v: INVENTORY_CURSOR_VERSION,
    snapshotDate: state.snapshotDate,
    endCursor: state.endCursor,
  })
}

/**
 * Decode a persisted cursor, or null for "start this day from the beginning".
 *
 * Null is returned for anything not fully trusted *and* for a cursor from a different day. The
 * second case is the one that matters: re-reading a catalog costs time, whereas splitting a day
 * across two `snapshot_date`s costs an observation that can never be recovered.
 */
export function parseInventoryCursor(
  raw: string | null | undefined,
  expectedSnapshotDate: string,
): InventoryCursorState | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return null
  }

  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null
  const record = decoded as Record<string, unknown>
  if (record.v !== INVENTORY_CURSOR_VERSION) return null
  if (record.snapshotDate !== expectedSnapshotDate) return null
  const endCursor = typeof record.endCursor === 'string' ? record.endCursor.trim() : ''
  if (endCursor === '') return null

  return { snapshotDate: expectedSnapshotDate, endCursor }
}

// ── Ports ───────────────────────────────────────────────────────────────────────────────────────

export type SnapshotUpsertOutcome = 'create' | 'update'

/**
 * The database surface this adapter needs, beyond the read the statistics already define.
 *
 * `upsertSnapshots` must conflict on the full day key — `(snapshot_date, variant_external,
 * location_id, organization_id, tenant_id)` — which is what makes re-running a day an update rather
 * than a duplicate. It reports per-variant so the engine's tally distinguishes a first capture from
 * a re-run; a variant whose locations split across both outcomes counts as `create`, since some
 * part of it is genuinely new.
 */
export type InventorySnapshotStore = InventoryHistoryStore & {
  upsertSnapshots(args: {
    rows: readonly InventorySnapshotDraft[]
    scope: InventoryHistoryScope
  }): Promise<Map<string, SnapshotUpsertOutcome>>
}

/** Something worth seeing in run telemetry that is not, on its own, a failed item. */
export type InventoryAnomaly =
  | ({ kind: 'skipped_level' } & InventoryMapSkip)
  | { kind: 'unidentified_variant'; batchIndex: number }
  | { kind: 'locations_truncated'; variantExternal: string; limit: number }
  | { kind: 'variant_count_unavailable'; message: string }
  /**
   * The snapshot row landed but `cf:unit_cost` / `cf:oos_ratio_90d` did not.
   *
   * Deliberately NOT a failed item. The snapshot row is the primary artifact and the custom fields
   * are decoration on top of it, so a store whose custom-field definitions have not been seeded yet
   * would otherwise report every variant as failed on its first run — a working integration that
   * looks catastrophic. The problem still surfaces here and in the batch message.
   */
  | { kind: 'write_back_failed'; variantExternal: string; message: string }

export type InventoryAdapterDeps = {
  /** Build a Shopify client for a connection's credentials. Injected so tests need no network. */
  createClient(credentials: Record<string, unknown>): ShopifyClient | Promise<ShopifyClient>
  store: InventorySnapshotStore
  /**
   * Used to resolve the LOCAL variant id for the custom-field write-back.
   *
   * Note which integration is queried below: the mapping table is partitioned by integration, and
   * the row was written by the **products** sync, not by this one. Looking it up under the
   * inventory integration id finds nothing and silently disables every write-back.
   */
  externalIdMapping: ExternalIdMappingPort
  /**
   * `setCustomFieldsIfAny`, bound to the data engine. Omit to snapshot without writing back —
   * history still accrues, `cf:unit_cost` and `cf:oos_ratio_90d` simply are not maintained.
   */
  writeCustomFields?: CustomFieldWriterPort
  now?: () => Date
  pageSize?: number
  bulkThreshold?: number
  /**
   * Defaults to true — ARCHIVED and DRAFT products are snapshotted and their status recorded, so a
   * product archived off-season and restored in-season keeps an unbroken history. Set `false` only
   * for a store with a large archived tail it never restores.
   */
  includeInactiveProducts?: boolean
  onAnomaly?: (anomaly: InventoryAnomaly) => void
  /**
   * Beat cadence for the bulk-poll liveness heartbeat. Defaults to `DEFAULT_HEARTBEAT_INTERVAL_MS`
   * (15s). Production omits it; tests set it small. There is no reconcile sweep here — inventory is
   * a full snapshot with no owned-record deactivation — so the only silent phase to cover is the
   * export/first-page poll.
   */
  heartbeatIntervalMs?: number
  /** Injectable timer for the bulk-poll heartbeat; defaults to real `setTimeout`. Tests only. */
  heartbeatClock?: HeartbeatClock
}

// ── Fetch strategy ──────────────────────────────────────────────────────────────────────────────

export type InventoryFetchMode = 'paged' | 'bulk'

/**
 * Paged or bulk.
 *
 * An unknown count resolves to `paged`, which is right for the overwhelming majority of stores and
 * degrades safely for the rest: the paged loop refuses to run past `MAX_PAGED_PAGES` and says why,
 * rather than grinding into the deep-pagination ceiling and failing with something unrelated.
 */
export function decideFetchMode(
  variantCount: number | null,
  threshold: number = BULK_VARIANT_THRESHOLD,
): InventoryFetchMode {
  if (variantCount === null || !Number.isFinite(variantCount)) return 'paged'
  return variantCount >= threshold ? 'bulk' : 'paged'
}

/** Deep pagination saturates around 25,000 objects; stop before Shopify does and explain why. */
export const MAX_PAGED_PAGES = 500

type VariantPage = {
  nodes: ShopifyVariantNode[]
  endCursor: string | null
  hasMore: boolean
}

type VariantsPageData = {
  productVariants?: {
    edges?: readonly ({ node?: ShopifyVariantNode | null } | null)[] | null
    pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null
  } | null
}

async function* pagedVariantPages(
  client: ShopifyClient,
  options: { pageSize: number; after: string | null },
): AsyncIterable<VariantPage> {
  let after = options.after
  // Requested cost is driven by the `first` arguments; keeping the estimate honest lets the
  // throttle pace ahead of the bucket instead of discovering it empty.
  const estimatedCost = options.pageSize * (1 + MAX_INVENTORY_LEVELS) + 2

  for (let page = 0; page < MAX_PAGED_PAGES; page += 1) {
    const data = await client.request<VariantsPageData>(VARIANTS_PAGE_QUERY, {
      variables: { first: options.pageSize, after },
      estimatedCost,
    })

    const connection = data?.productVariants
    const nodes = (connection?.edges ?? [])
      .map((edge) => edge?.node)
      .filter((node): node is ShopifyVariantNode => !!node)
    const endCursor =
      typeof connection?.pageInfo?.endCursor === 'string' ? connection.pageInfo.endCursor : null
    const hasMore = connection?.pageInfo?.hasNextPage === true && endCursor !== null

    yield { nodes, endCursor, hasMore }
    if (!hasMore) return
    after = endCursor
  }

  throw new Error(
    `[internal] inventory paging exceeded ${MAX_PAGED_PAGES} pages; this store needs the bulk path — ` +
      'raise `bulkThreshold` awareness or check that productVariantsCount is readable',
  )
}

/**
 * Rebuild a variant node from a reassembled bulk record.
 *
 * `inventoryLevels` arrives as separate JSONL lines linked by `__parentId`, so the levels come back
 * as children of the variant rather than nested inside `inventoryItem`. Everything else — including
 * `inventoryItem` itself, which is an inline object rather than a connection — is on the parent
 * line already.
 */
export function variantFromBulkNode(node: BulkNode): ShopifyVariantNode {
  const fields = node.fields as ShopifyVariantNode
  const levels = childrenOfType(node, 'InventoryLevel').map(
    (child) => child.fields as ShopifyInventoryLevelNode,
  )

  return {
    id: node.id,
    sku: fields.sku ?? null,
    product: fields.product ?? null,
    inventoryItem: {
      unitCost: fields.inventoryItem?.unitCost ?? null,
      requiresShipping: fields.inventoryItem?.requiresShipping ?? null,
      // Levels nested inline (a small store exported without splitting) are preserved; otherwise
      // the children collected above are the whole set. Bulk never truncates a connection, so
      // `hasNextPage` is deliberately not carried over.
      inventoryLevels: {
        nodes: levels.length > 0 ? levels : readInventoryLevels(fields.inventoryItem?.inventoryLevels),
      },
    },
  }
}

/**
 * Turn reassembly anomalies into an error someone can act on in one read.
 *
 * The expected failure is specific and worth naming outright: this code assumes Shopify links an
 * `InventoryLevel` line to its **ProductVariant**. `inventoryLevels` hangs off `inventoryItem`,
 * which is an inline object rather than a line of its own, so if Shopify instead sets `__parentId`
 * to the InventoryItem GID every level orphans against a parent the reassembler never saw. That is
 * unverified above the bulk threshold — our validated store is 195 variants and never takes this
 * path — so the message reports which parent type actually turned up rather than leaving the next
 * person to infer it from a generic "malformed JSONL".
 */
export function bulkReassemblyError(anomalies: readonly BulkAnomaly[]): Error {
  const parentTypes = [
    ...new Set(
      anomalies
        .filter((anomaly): anomaly is Extract<BulkAnomaly, { kind: 'orphan_child' }> => anomaly.kind === 'orphan_child')
        .map((anomaly) => parseGid(anomaly.parentId)?.type ?? 'unparseable'),
    ),
  ]
  const kinds = [...new Set(anomalies.map((anomaly) => anomaly.kind))].join(', ')

  const diagnosis =
    parentTypes.length > 0
      ? ` Children referenced unexpected parent GID type(s): ${parentTypes.join(', ')} — this adapter ` +
        'expects InventoryLevel lines to carry __parentId of the ProductVariant. Adjust ' +
        '`variantFromBulkNode` and the bulk query nesting to match what Shopify actually emits.'
      : ''

  return new Error(
    `[internal] bulk inventory export produced ${anomalies.length} unusable line(s) (${kinds}); ` +
      `refusing to write a snapshot that may be missing locations.${diagnosis}`,
  )
}

async function* bulkVariantPages(
  client: ShopifyClient,
  options: { pageSize: number; onPoll?: BulkExportOptions['onPoll'] },
): AsyncIterable<VariantPage> {
  const orphans: BulkAnomaly[] = []
  const exported = await runBulkExport(client, VARIANTS_BULK_QUERY, {
    onAnomaly: (anomaly) => {
      // Losing a level silently would drop a location from the snapshot and read exactly like a
      // variant that is not stocked there. Collect and fail after the stream so the message can
      // say how many, of what kind, and — for the case actually expected here — which parent GID
      // type turned up, rather than dying on the first one with no context.
      orphans.push(anomaly)
    },
    // The bulk poll blocks for well over a minute on a real catalog; `onPoll` lets `streamImport`
    // stash the live operation so its heartbeat can report scan progress (object counts only).
    ...(options.onPoll ? { onPoll: options.onPoll } : {}),
  })

  if (!exported.nodes) {
    yield { nodes: [], endCursor: null, hasMore: false }
    return
  }

  let buffer: ShopifyVariantNode[] = []
  let pending: VariantPage | null = null

  // One page of look-ahead: `hasMore` must be exact, and the only way to know a chunk is the last
  // one is to have failed to fill the next.
  for await (const node of exported.nodes) {
    if (node.type !== 'ProductVariant') continue
    buffer.push(variantFromBulkNode(node))
    if (buffer.length >= options.pageSize) {
      if (pending) yield pending
      pending = { nodes: buffer, endCursor: null, hasMore: true }
      buffer = []
    }
  }
  if (buffer.length > 0) {
    if (pending) yield pending
    pending = { nodes: buffer, endCursor: null, hasMore: true }
  }

  if (orphans.length > 0) throw bulkReassemblyError(orphans)

  yield pending ? { ...pending, hasMore: false } : { nodes: [], endCursor: null, hasMore: false }
}

// ── Run preamble ────────────────────────────────────────────────────────────────────────────────

/**
 * The store's own timezone, fetched once per run.
 *
 * Mandatory. There is no default and no fallback: `America/Los_Angeles` is what the prototype
 * hardcoded, and a wrong zone silently mis-buckets every row it writes.
 */
export async function fetchShopTimezone(client: ShopifyClient): Promise<string> {
  const data = await client.request<{ shop?: { ianaTimezone?: string | null } | null }>(
    SHOP_TIMEZONE_QUERY,
    { estimatedCost: 1 },
  )
  const zone = data?.shop?.ianaTimezone
  if (typeof zone !== 'string' || zone.trim() === '') {
    throw new Error('[internal] shop { ianaTimezone } was empty; cannot bucket a snapshot day without it')
  }
  return zone.trim()
}

/**
 * Variant count, or null when it cannot be read.
 *
 * Its own request rather than a field on the timezone query: a GraphQL error on one field fails the
 * whole document, and the count is a *hint* that picks a fetch strategy, while the timezone is a
 * hard prerequisite. Coupling them would let an optional field block a mandatory one.
 */
export async function fetchVariantCount(
  client: ShopifyClient,
  onAnomaly?: (anomaly: InventoryAnomaly) => void,
): Promise<number | null> {
  try {
    const data = await client.request<{ productVariantsCount?: { count?: number | null } | null }>(
      VARIANT_COUNT_QUERY,
      { estimatedCost: 1 },
    )
    const count = data?.productVariantsCount?.count
    return typeof count === 'number' && Number.isFinite(count) ? count : null
  } catch (error) {
    onAnomaly?.({
      kind: 'variant_count_unavailable',
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

// ── The adapter ─────────────────────────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createShopifyInventoryAdapter(deps: InventoryAdapterDeps): DataSyncAdapter {
  const now = deps.now ?? (() => new Date())
  const pageSize = Math.max(1, Math.min(deps.pageSize ?? DEFAULT_PAGE_SIZE, 250))
  const bulkThreshold = deps.bulkThreshold ?? BULK_VARIANT_THRESHOLD
  const historyService = createInventoryHistoryService(deps.store)

  const report = (anomaly: InventoryAnomaly) => deps.onAnomaly?.(anomaly)

  /**
   * Local `CatalogProductVariant` id for a Shopify variant GID, or null when the catalog mapping
   * has not caught up. Null is normal, not an error: the snapshot is still written (with a null
   * `variant_id`) because a skipped day is lost forever, whereas a missing local id is repaired by
   * the next products run.
   */
  async function resolveLocalVariantId(
    variantExternal: string,
    scope: TenantScope,
  ): Promise<string | null> {
    return deps.externalIdMapping.lookupLocalId(
      INTEGRATION_ID.products,
      MAPPING_ENTITY_TYPE.productVariant,
      variantExternal,
      scope,
    )
  }

  /**
   * Write `cf:unit_cost` and, when the evidence supports it, the out-of-stock pair.
   *
   * Returns whether anything was written. The ratio is read AFTER today's rows are persisted, so
   * the window includes the capture that just happened.
   */
  async function writeBackCustomFields(
    mapped: MappedVariantInventory,
    context: { localId: string; scope: InventoryHistoryScope; snapshotDate: string; hasRows: boolean },
  ): Promise<boolean> {
    const write = deps.writeCustomFields
    if (!write) return false

    const values: Record<string, unknown> = {}
    // Null is left out rather than passed through: `setCustomFieldsIfAny` short-circuits only on a
    // wholly empty map, so a per-key null is written and BLANKS the stored value. `writeCustomFields`
    // prunes as well; keeping it out here means the map is honestly empty when there is nothing.
    if (mapped.unitCost !== null) values[INVENTORY_CUSTOM_FIELD.unitCost] = mapped.unitCost

    if (context.hasRows) {
      // Current-state stock, summed across the variant's locations. `hasRows` guarantees every row
      // carries a real `available`/`onHand` — a location that reported no `available` was skipped
      // upstream, never written as 0 — so this sums only OBSERVED locations and never fabricates a
      // phantom zero. For a single-location store it is simply that location's value.
      let onHand = 0
      let available = 0
      for (const row of mapped.rows) {
        onHand += row.onHand
        available += row.available
      }
      values[INVENTORY_CUSTOM_FIELD.onHand] = onHand
      values[INVENTORY_CUSTOM_FIELD.available] = available

      const result = await historyService.oosRatio(mapped.variantExternal, {
        scope: context.scope,
        asOf: context.snapshotDate,
        windowDays: OOS_DEFAULT_WINDOW_DAYS,
      })
      // The guard, stated once: null means "not enough evidence to say", and it must produce NO
      // custom field. A stored 0 reads as "never out of stock" and feeds straight into a purchase
      // order. A ratio of 0 is a different answer entirely — observed enough, never stocked out —
      // and is written like any other number.
      if (result.ratio !== null) {
        values[INVENTORY_CUSTOM_FIELD.oosRatio] = result.ratio
        values[INVENTORY_CUSTOM_FIELD.daysOutOfStock] = result.daysOutOfStock
      }
    }

    return writeCustomFieldValues({
      write,
      entityId: OM_ENTITY_ID.productVariant,
      recordId: context.localId,
      scope: context.scope,
      values,
    })
  }

  async function* streamImport(input: StreamImportInput): AsyncIterable<ImportBatch> {
    const scope: InventoryHistoryScope = {
      organizationId: input.scope.organizationId,
      tenantId: input.scope.tenantId,
    }

    const client = await deps.createClient(input.credentials)
    const capturedAt = now()
    const ianaTimezone = await fetchShopTimezone(client)
    const snapshotDate = snapshotDateFor(capturedAt, ianaTimezone)

    const resumed = parseInventoryCursor(input.cursor, snapshotDate)
    const variantCount = await fetchVariantCount(client, report)
    const mode = decideFetchMode(variantCount, bulkThreshold)

    // A bulk export cannot be resumed part-way through its stream, so a resume request falls back
    // to a fresh export. Re-reading is wasteful; writing half a day under the wrong date is not
    // recoverable.
    //
    // The live bulk operation is stashed via `onPoll` so the heartbeat below can report scan
    // progress — object counts only, never a value. Only the bulk path polls; the paged path makes
    // an ordinary request whose `onPoll` is never called, and `lastOp` simply stays null there.
    let lastOp: BulkOperation | null = null
    const pages =
      mode === 'bulk'
        ? bulkVariantPages(client, { pageSize, onPoll: (op) => { lastOp = op } })
        : pagedVariantPages(client, { pageSize, after: resumed?.endCursor ?? null })

    // The cursor a beat re-persists: wherever this run will actually resume from. Bulk cannot resume
    // mid-stream, so it round-trips to "start this day over" — exactly where the poll still is.
    const pollCursor = serializeInventoryCursor({ snapshotDate, endCursor: resumed?.endCursor ?? null })

    let batchIndex = 0

    // Drive the source by hand so the FIRST pull — the one blocked on the bulk export poll (up to an
    // hour of silence that would otherwise trip the 60s stale-job watchdog) — can be raced against a
    // heartbeat timer. Later pulls stream from an already-running download and each yields a data
    // batch, which refreshes the job's heartbeat on its own; only the first pull can run silent.
    const iterator = pages[Symbol.asyncIterator]()
    let firstPull = true

    for (;;) {
      const advance = iterator.next()
      if (firstPull) {
        firstPull = false
        yield* heartbeatWhile(
          advance,
          () =>
            heartbeatBatch({
              cursor: pollCursor,
              batchIndex: batchIndex++,
              message: `Exporting Shopify inventory… ${lastOp?.objectCount ?? 0} rows scanned`,
            }),
          { intervalMs: deps.heartbeatIntervalMs, clock: deps.heartbeatClock },
        )
      }
      const result = await advance
      if (result.done) break
      const page = result.value
      const items: ImportItem[] = []
      const mappedByVariant: MappedVariantInventory[] = []
      const rows: InventorySnapshotDraft[] = []
      let writeBackFailures = 0

      for (const node of page.nodes) {
        const mapped = mapVariantInventory(node, {
          capturedAt,
          ianaTimezone,
          includeInactiveProducts: deps.includeInactiveProducts,
        })
        if (!mapped) {
          // No variant GID means no key to record it under. Nothing can be written; say so.
          report({ kind: 'unidentified_variant', batchIndex })
          continue
        }
        if (mapped.locationsTruncated) {
          report({
            kind: 'locations_truncated',
            variantExternal: mapped.variantExternal,
            limit: MAX_INVENTORY_LEVELS,
          })
        }
        for (const skip of mapped.skipped) report({ kind: 'skipped_level', ...skip })

        mappedByVariant.push(mapped)
        rows.push(...mapped.rows)
      }

      // One upsert for the whole page. Per-item containment still holds: a failure here is
      // attributed to every item in the page, because that is exactly what it affected.
      let outcomes: Map<string, SnapshotUpsertOutcome>
      let upsertError: unknown = null
      try {
        outcomes =
          rows.length > 0 ? await deps.store.upsertSnapshots({ rows, scope }) : new Map()
      } catch (error) {
        outcomes = new Map()
        upsertError = error
      }

      for (const mapped of mappedByVariant) {
        const hasRows = mapped.rows.length > 0

        if (upsertError && hasRows) {
          items.push({
            externalId: mapped.variantExternal,
            action: 'failed',
            data: {
              sourceIdentifier: mapped.variantExternal,
              errorMessage: `snapshot upsert failed: ${errorMessage(upsertError)}`,
            },
          })
          continue
        }

        // The write-back is secondary to the snapshot and cannot fail the item. A throw here would
        // also abort the engine's whole run and lose every item that succeeded, so nothing escapes.
        let localId: string | null = null
        let wroteCustomFields = false
        let writeBackError: string | null = null
        try {
          localId = await resolveLocalVariantId(mapped.variantExternal, scope)
          if (localId !== null) {
            wroteCustomFields = await writeBackCustomFields(mapped, {
              localId,
              scope,
              snapshotDate,
              hasRows,
            })
          }
        } catch (error) {
          writeBackError = errorMessage(error)
          writeBackFailures += 1
          report({ kind: 'write_back_failed', variantExternal: mapped.variantExternal, message: writeBackError })
        }

        items.push({
          externalId: mapped.variantExternal,
          // A variant with no rows is a genuine skip, not a failure: either it is not physical
          // stock, or no level reported an `available` we are willing to record. In every case the
          // honest outcome is "nothing observed".
          action: hasRows ? (outcomes.get(mapped.variantExternal) ?? 'update') : 'skip',
          data: {
            snapshotDate,
            locationCount: mapped.rows.length,
            localId,
            isPhysical: mapped.isPhysical,
            wroteCustomFields,
            // Not `errorMessage`: that key is what `logImportItemFailures` reads for FAILED items,
            // and this item did not fail.
            ...(writeBackError === null ? {} : { writeBackError }),
            ...(hasRows ? {} : { skipReasons: mapped.skipped.map((skip) => skip.reason) }),
          },
        })
      }

      yield {
        items,
        cursor: serializeInventoryCursor({ snapshotDate, endCursor: page.endCursor }),
        hasMore: page.hasMore,
        batchIndex,
        // Per-batch delta (matching products.ts), NOT a running cumulative: the engine SUMS
        // processedCount across batches, so a cumulative here would triangular-inflate the total.
        // Empty heartbeat batches omit the key entirely, so they add 0 and never double-count.
        processedCount: items.length,
        ...(variantCount !== null ? { totalEstimate: variantCount } : {}),
        // Custom-field values landed on the variant, so its coverage needs refreshing.
        refreshCoverageEntityTypes: [OM_ENTITY_ID.productVariant],
        message:
          `inventory snapshot ${snapshotDate} (${ianaTimezone}, ${mode}): ${rows.length} row(s) across ${items.length} variant(s)` +
          // Surfaced here because these are not failed items: without it, a store whose custom-field
          // definitions are missing would show a clean run and silently stop maintaining unit cost.
          (writeBackFailures > 0 ? `; ${writeBackFailures} custom-field write-back(s) failed` : ''),
      }

      batchIndex += 1
    }
  }

  return {
    providerKey: PROVIDER_KEY.inventory,
    direction: 'import',
    supportedEntities: [ENTITY_TYPE.inventoryLevel],
    operationalTelemetry: true,

    streamImport,

    /**
     * Always null. There is no watermark to carry: `product.updated_at` does not move for stock, so
     * every run is a full capture of the current day (§12.3).
     */
    async getInitialCursor(): Promise<string | null> {
      return null
    },

    async getMapping(): Promise<DataMapping> {
      return {
        entityType: ENTITY_TYPE.inventoryLevel,
        matchStrategy: 'externalId',
        fields: [
          { externalField: 'id', localField: 'variant_external', mappingKind: 'external_id', required: true, dedupeRole: 'primary' },
          { externalField: 'sku', localField: 'sku', mappingKind: 'core' },
          { externalField: 'product.productType', localField: 'product_type', mappingKind: 'core' },
          { externalField: 'inventoryItem.inventoryLevels.location.id', localField: 'location_id', mappingKind: 'core', required: true, dedupeRole: 'secondary' },
          { externalField: `inventoryItem.inventoryLevels.quantities.available`, localField: 'available', mappingKind: 'core', required: true },
          { externalField: `inventoryItem.inventoryLevels.quantities.on_hand`, localField: 'on_hand', mappingKind: 'core' },
          { externalField: `inventoryItem.inventoryLevels.quantities.committed`, localField: 'committed', mappingKind: 'core' },
          { externalField: `inventoryItem.inventoryLevels.quantities.incoming`, localField: 'incoming', mappingKind: 'core' },
          { externalField: 'inventoryItem.unitCost.amount', localField: INVENTORY_CUSTOM_FIELD.unitCost, mappingKind: 'custom_field' },
        ],
      }
    },

    /**
     * Proves the two scopes this integration needs but the others do not.
     *
     * `shop { ianaTimezone }` is free with any token; `locations` requires `read_locations`, and the
     * inventory levels inside the main query require `read_inventory`. Checking locations here is
     * what turns "the first run returned nothing" into a legible connection error.
     */
    async validateConnection(check: {
      credentials: Record<string, unknown>
    }): Promise<ValidationResult> {
      try {
        const client = await deps.createClient(check.credentials)
        const data = await client.request<{
          shop?: { ianaTimezone?: string | null } | null
          locations?: { edges?: readonly unknown[] | null } | null
        }>(CONNECTION_CHECK_QUERY, { estimatedCost: 3 })

        const zone = data?.shop?.ianaTimezone
        if (typeof zone !== 'string' || zone.trim() === '') {
          return { ok: false, message: 'Shop timezone unavailable; snapshot days cannot be bucketed.' }
        }
        const locationCount = data?.locations?.edges?.length ?? 0
        if (locationCount === 0) {
          return {
            ok: false,
            message: 'No locations visible. Inventory sync needs read_locations and read_inventory.',
          }
        }
        return { ok: true, message: `Connected. Store timezone ${zone}.`, details: { ianaTimezone: zone } }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },
  }
}
