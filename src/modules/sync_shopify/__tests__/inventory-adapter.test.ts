/**
 * Inventory snapshot adapter and mapper.
 *
 * The assertions worth reading twice are the *negative* ones. Every failure this feature is shaped
 * to prevent produces a confident wrong number rather than an error, so the tests that matter check
 * that something was NOT written: no phantom zero for an unobserved `available`, no `oos_ratio` when
 * the evidence does not support one, no blanked `unit_cost` when Shopify has none.
 *
 * The `ShopifyClient` stub is taken at the `request()` seam — past the wire-format handling in
 * `lib/client.ts` — so it returns `data` directly rather than a `{ data, errors }` envelope. Error
 * handling is `client.test.ts`'s subject, not this file's.
 */

import {
  BULK_VARIANT_THRESHOLD,
  DEFAULT_PAGE_SIZE,
  INVENTORY_CUSTOM_FIELD,
  MAX_INVENTORY_LEVELS,
  bulkReassemblyError,
  createShopifyInventoryAdapter,
  decideFetchMode,
  parseInventoryCursor,
  serializeInventoryCursor,
  variantFromBulkNode,
  type InventoryAnomaly,
  type InventorySnapshotStore,
  type SnapshotUpsertOutcome,
} from '../lib/adapters/inventory'
import {
  mapVariantInventory,
  readQuantity,
  type InventorySnapshotDraft,
  type ShopifyVariantNode,
} from '../lib/mappers/inventory'
import { addDays, type InventoryHistoryScope, type InventorySnapshotRow } from '../lib/inventory-history'
import { OOS_MIN_OBSERVED_DAYS } from '../lib/constants'
import { INTEGRATION_ID, MAPPING_ENTITY_TYPE, OM_ENTITY_ID } from '../lib/constants'
import { CostTracker } from '../lib/throttle'
import type { ShopifyClient } from '../lib/client'
import type { BulkNode } from '../lib/bulk'
import type { StreamImportInput } from '@open-mercato/core/modules/data_sync/lib/adapter'

const SCOPE: InventoryHistoryScope = {
  organizationId: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
}

const VARIANT = 'gid://shopify/ProductVariant/1'
const OTHER_VARIANT = 'gid://shopify/ProductVariant/2'
const LOCATION_A = 'gid://shopify/Location/10'
const LOCATION_B = 'gid://shopify/Location/20'
const LOCAL_VARIANT_ID = '33333333-3333-3333-3333-333333333333'

/** 2026-07-20 19:00 in Los Angeles, which is already 2026-07-21 in Auckland. */
const CAPTURED_AT = new Date('2026-07-21T02:00:00Z')
const LA = 'America/Los_Angeles'
const AUCKLAND = 'Pacific/Auckland'
const LA_DAY = '2026-07-20'

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

type LevelFixture = {
  locationId?: string | null
  available?: number | null
  onHand?: number | null
  committed?: number | null
  incoming?: number | null
}

/**
 * A quantity list holding only the names actually supplied.
 *
 * Omission is the case under test: `quantities(names:)` returns the names Shopify has, so an absent
 * `available` means unobserved. A fixture that always emitted every name could not express that.
 */
function quantities(level: LevelFixture) {
  const entries: { name: string; quantity: number }[] = []
  if (level.available !== null && level.available !== undefined) {
    entries.push({ name: 'available', quantity: level.available })
  }
  if (level.onHand !== null && level.onHand !== undefined) {
    entries.push({ name: 'on_hand', quantity: level.onHand })
  }
  if (level.committed !== null && level.committed !== undefined) {
    entries.push({ name: 'committed', quantity: level.committed })
  }
  if (level.incoming !== null && level.incoming !== undefined) {
    entries.push({ name: 'incoming', quantity: level.incoming })
  }
  return entries
}

function variantNode(options: {
  id?: string
  sku?: string | null
  title?: string
  status?: string
  productType?: string | null
  isGiftCard?: boolean | null
  requiresShipping?: boolean | null
  unitCost?: string | null
  levels?: LevelFixture[]
  hasNextPage?: boolean
} = {}): ShopifyVariantNode {
  const levels = options.levels ?? [{ locationId: LOCATION_A, available: 5, onHand: 7, committed: 2, incoming: 3 }]
  return {
    id: options.id ?? VARIANT,
    sku: options.sku === undefined ? 'SKU-1' : options.sku,
    product: {
      title: options.title ?? 'Merino Crew',
      status: options.status ?? 'ACTIVE',
      productType: options.productType === undefined ? 'Knitwear' : options.productType,
      isGiftCard: options.isGiftCard ?? false,
    },
    inventoryItem: {
      unitCost: options.unitCost === undefined ? { amount: '12.5000' } : options.unitCost === null ? null : { amount: options.unitCost },
      requiresShipping: options.requiresShipping ?? true,
      inventoryLevels: {
        edges: levels.map((level) => ({
          node: {
            location: level.locationId === null ? null : { id: level.locationId ?? LOCATION_A, name: 'Warehouse' },
            quantities: quantities(level),
          },
        })),
        pageInfo: { hasNextPage: options.hasNextPage ?? false },
      },
    },
  }
}

// ── Fake store: models the unique key, so idempotency is really exercised ────────────────────────

type FakeStore = InventorySnapshotStore & {
  all(): InventorySnapshotDraft[]
  seedDays(args: { variantExternal: string; locationId: string; from: string; days: number; available: (index: number) => number }): void
}

function createFakeStore(): FakeStore {
  // Keyed exactly as the table's unique constraint is, so a same-day re-run must collide. NUL
  // separates the parts for the same reason `planRetention` uses it: it cannot occur in a Shopify
  // GID or a location id. Written as an escape — a raw NUL byte in the source makes the whole file
  // binary to grep and diff, which hides every test in it from tooling.
  const byDayKey = new Map<string, InventorySnapshotDraft>()
  const keyOf = (row: { snapshotDate: string; variantExternal: string; locationId: string }, scope: InventoryHistoryScope) =>
    [row.snapshotDate, row.variantExternal, row.locationId, scope.organizationId, scope.tenantId].join('\u0000')

  return {
    async upsertSnapshots({ rows, scope }) {
      const outcomes = new Map<string, SnapshotUpsertOutcome>()
      for (const row of rows) {
        const key = keyOf(row, scope)
        const outcome: SnapshotUpsertOutcome = byDayKey.has(key) ? 'update' : 'create'
        byDayKey.set(key, { ...row })
        // A variant split across outcomes counts as `create`: some part of it is genuinely new.
        if (outcome === 'create' || !outcomes.has(row.variantExternal)) {
          outcomes.set(row.variantExternal, outcomes.get(row.variantExternal) === 'create' ? 'create' : outcome)
        }
      }
      return outcomes
    },

    async findDailyRows({ variantExternal, from, to }) {
      return [...byDayKey.values()]
        .filter(
          (row) =>
            row.variantExternal === variantExternal && row.snapshotDate >= from && row.snapshotDate <= to,
        )
        .map(
          (row): InventorySnapshotRow => ({
            snapshotDate: row.snapshotDate,
            variantExternal: row.variantExternal,
            locationId: row.locationId,
            available: row.available,
            outOfStock: row.outOfStock,
          }),
        )
    },

    all() {
      return [...byDayKey.values()]
    },

    seedDays({ variantExternal, locationId, from, days, available }) {
      for (let index = 0; index < days; index += 1) {
        const value = available(index)
        const row: InventorySnapshotDraft = {
          snapshotDate: addDays(from, index),
          capturedAt: CAPTURED_AT,
          variantExternal,
          sku: 'SKU-1',
          productType: 'Knitwear',
          productStatus: 'ACTIVE',
          locationId,
          onHand: Math.max(0, value),
          available: value,
          committed: null,
          incoming: null,
          outOfStock: value <= 0,
          isPhysical: true,
        }
        byDayKey.set(keyOf(row, SCOPE), row)
      }
    },
  }
}

// ── Fake client ─────────────────────────────────────────────────────────────────────────────────

type ClientPage = { nodes: ShopifyVariantNode[]; endCursor: string | null; hasNextPage: boolean }

function createFakeClient(options: {
  timezone?: string
  variantCount?: number | null
  pages?: ClientPage[]
}) {
  const pages = options.pages ?? []
  const requests: { query: string; variables: Record<string, unknown> | undefined }[] = []
  let pageIndex = 0

  const client = {
    shopDomain: 'test.myshopify.com',
    apiVersion: '2026-07',
    cost: new CostTracker(),
    async request<TData>(query: string, requestOptions?: { variables?: Record<string, unknown> }): Promise<TData> {
      requests.push({ query, variables: requestOptions?.variables })

      if (query.includes('SyncShopifyShopTimezone')) {
        return { shop: { ianaTimezone: options.timezone ?? LA } } as TData
      }
      if (query.includes('SyncShopifyProductVariantsCount')) {
        if (options.variantCount === null) throw new Error('Field productVariantsCount does not exist')
        return { productVariantsCount: { count: options.variantCount ?? 195 } } as TData
      }
      if (query.includes('SyncShopifyInventoryVariants')) {
        const page = pages[pageIndex] ?? { nodes: [], endCursor: null, hasNextPage: false }
        pageIndex += 1
        return {
          productVariants: {
            edges: page.nodes.map((node) => ({ node })),
            pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
          },
        } as TData
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`)
    },
  }

  return { client: client as unknown as ShopifyClient, requests, reset: () => { pageIndex = 0 } }
}

// ── Adapter harness ─────────────────────────────────────────────────────────────────────────────

type CustomFieldCall = { recordId: string; entityId: string; values: Record<string, unknown> }

function createHarness(options: {
  pages?: ClientPage[]
  store?: FakeStore
  variantCount?: number | null
  timezone?: string
  localVariantId?: string | null
  withCustomFields?: boolean
}) {
  const store = options.store ?? createFakeStore()
  const { client, requests } = createFakeClient({
    timezone: options.timezone,
    variantCount: options.variantCount,
    pages: options.pages,
  })
  const customFieldCalls: CustomFieldCall[] = []
  const anomalies: InventoryAnomaly[] = []
  const lookups: { integrationId: string; entityType: string; externalId: string }[] = []

  const adapter = createShopifyInventoryAdapter({
    createClient: () => client,
    store,
    externalIdMapping: {
      async lookupLocalId(integrationId, entityType, externalId) {
        lookups.push({ integrationId, entityType, externalId })
        return options.localVariantId === undefined ? LOCAL_VARIANT_ID : options.localVariantId
      },
      async storeExternalIdMapping() {
        throw new Error('the inventory adapter must never write a mapping')
      },
    },
    writeCustomFields:
      options.withCustomFields === false
        ? undefined
        : async (input) => {
            customFieldCalls.push({ recordId: input.recordId, entityId: input.entityId, values: input.values })
          },
    now: () => CAPTURED_AT,
    onAnomaly: (anomaly) => anomalies.push(anomaly),
  })

  return { adapter, store, customFieldCalls, anomalies, lookups, requests }
}

function importInput(overrides: Partial<StreamImportInput> = {}): StreamImportInput {
  return {
    entityType: 'shopify.inventory_level',
    batchSize: 50,
    credentials: { shopDomain: 'test.myshopify.com' },
    mapping: { entityType: 'shopify.inventory_level', fields: [], matchStrategy: 'externalId' },
    scope: SCOPE,
    ...overrides,
  }
}

async function drain(adapter: ReturnType<typeof createShopifyInventoryAdapter>, input: StreamImportInput) {
  const batches = []
  for await (const batch of adapter.streamImport!(input)) batches.push(batch)
  return batches
}

function onePage(nodes: ShopifyVariantNode[]): ClientPage[] {
  return [{ nodes, endCursor: 'cursor-1', hasNextPage: false }]
}

// ── Mapper ──────────────────────────────────────────────────────────────────────────────────────

describe('readQuantity', () => {
  it('reads a present quantity, including a genuine zero', () => {
    const list = [{ name: 'available', quantity: 0 }]
    // The distinction the whole feature rests on: 0 is an observation, absence is not.
    expect(readQuantity(list, 'available')).toBe(0)
  })

  it('returns null — never 0 — for a name Shopify did not return', () => {
    expect(readQuantity([{ name: 'on_hand', quantity: 4 }], 'available')).toBeNull()
    expect(readQuantity([], 'available')).toBeNull()
    expect(readQuantity(null, 'available')).toBeNull()
  })

  it('returns null for a non-numeric quantity rather than coercing it', () => {
    expect(readQuantity([{ name: 'available', quantity: null }], 'available')).toBeNull()
  })
})

describe('mapVariantInventory', () => {
  const options = { capturedAt: CAPTURED_AT, ianaTimezone: LA }

  it('produces one row per location', () => {
    const mapped = mapVariantInventory(
      variantNode({
        levels: [
          { locationId: LOCATION_A, available: 5, onHand: 7, committed: 2, incoming: 3 },
          { locationId: LOCATION_B, available: 0, onHand: 0 },
        ],
      }),
      options,
    )!

    expect(mapped.rows).toHaveLength(2)
    expect(mapped.rows.map((row) => row.locationId)).toEqual([LOCATION_A, LOCATION_B])
    // Same variant, same day, two rows — which is exactly what the unique key must permit.
    expect(new Set(mapped.rows.map((row) => row.snapshotDate))).toEqual(new Set([LA_DAY]))
  })

  it('parses every quantity state, keeping absent ones null', () => {
    const mapped = mapVariantInventory(
      variantNode({ levels: [{ locationId: LOCATION_A, available: 5, onHand: 7, committed: 2 }] }),
      options,
    )!

    expect(mapped.rows[0]).toMatchObject({
      available: 5,
      onHand: 7,
      committed: 2,
      incoming: null,
      sku: 'SKU-1',
      productType: 'Knitwear',
      isPhysical: true,
    })
  })

  it('derives out_of_stock from available <= 0', () => {
    const rows = mapVariantInventory(
      variantNode({
        levels: [
          { locationId: LOCATION_A, available: 1 },
          { locationId: LOCATION_B, available: 0 },
          { locationId: 'gid://shopify/Location/30', available: -3 },
        ],
      }),
      options,
    )!.rows

    expect(rows.map((row) => row.outOfStock)).toEqual([false, true, true])
  })

  it('does NOT write a missing available as 0 — it skips the level', () => {
    // The single most important rule here. A phantom zero is a phantom stockout, which inflates the
    // OOS ratio, which inflates the purchase order this feature exists to get right.
    const mapped = mapVariantInventory(
      variantNode({
        levels: [
          { locationId: LOCATION_A, onHand: 4, committed: 1 },
          { locationId: LOCATION_B, available: 2 },
        ],
      }),
      options,
    )!

    expect(mapped.rows).toHaveLength(1)
    expect(mapped.rows[0].locationId).toBe(LOCATION_B)
    expect(mapped.rows.some((row) => row.available === 0)).toBe(false)
    expect(mapped.skipped).toEqual([
      { variantExternal: VARIANT, locationId: LOCATION_A, reason: 'unobserved_available' },
    ])
  })

  it('falls back to available for a missing on_hand, which never feeds the ratio', () => {
    const mapped = mapVariantInventory(
      variantNode({ levels: [{ locationId: LOCATION_A, available: 6 }] }),
      options,
    )!
    expect(mapped.rows[0]).toMatchObject({ available: 6, onHand: 6, outOfStock: false })
  })

  it('excludes a gift card via isGiftCard, whatever language its title is in', () => {
    const mapped = mapVariantInventory(
      variantNode({ title: 'Geschenkkarte', isGiftCard: true, levels: [{ locationId: LOCATION_A, available: 99 }] }),
      options,
    )!

    expect(mapped.isPhysical).toBe(false)
    expect(mapped.rows).toHaveLength(0)
    expect(mapped.skipped).toEqual([{ variantExternal: VARIANT, locationId: null, reason: 'not_physical' }])
  })

  it('excludes a non-shipping item via requiresShipping: false', () => {
    const mapped = mapVariantInventory(
      variantNode({ title: 'Carte Cadeau électronique', isGiftCard: false, requiresShipping: false }),
      options,
    )!

    expect(mapped.isPhysical).toBe(false)
    expect(mapped.rows).toHaveLength(0)
  })

  it('keeps a physical product whose title merely contains "gift card"', () => {
    // The inverse of the prototype's bug: string matching would have dropped this real SKU, and a
    // wrongly excluded variant is gone from history for good.
    const mapped = mapVariantInventory(
      variantNode({ title: 'Gift Card Holder Wallet', productType: 'Accessories', isGiftCard: false }),
      options,
    )!

    expect(mapped.isPhysical).toBe(true)
    expect(mapped.rows).toHaveLength(1)
  })

  it('reports unit cost verbatim and null when Shopify has none', () => {
    expect(mapVariantInventory(variantNode({ unitCost: '12.5000' }), options)!.unitCost).toBe('12.5000')
    expect(mapVariantInventory(variantNode({ unitCost: null }), options)!.unitCost).toBeNull()
  })

  it('skips a level with no identifiable location', () => {
    const mapped = mapVariantInventory(
      variantNode({ levels: [{ locationId: null, available: 4 }] }),
      options,
    )!
    expect(mapped.rows).toHaveLength(0)
    expect(mapped.skipped[0].reason).toBe('unidentified_location')
  })

  it('snapshots an archived product by default, recording its status', () => {
    // Archiving off-season and restoring in-season is normal for this brand; excluding the
    // archived stretch would leave a hole no backfill can fill, and the restored variant would
    // then have no usable ratio until it re-accrued past the thresholds.
    const mapped = mapVariantInventory(variantNode({ status: 'ARCHIVED' }), options)!
    expect(mapped.rows).toHaveLength(1)
    expect(mapped.rows[0].productStatus).toBe('ARCHIVED')
  })

  it('records product status on every row so consumers can filter at read time', () => {
    expect(mapVariantInventory(variantNode({ status: 'ACTIVE' }), options)!.rows[0].productStatus).toBe('ACTIVE')
    expect(mapVariantInventory(variantNode({ status: 'DRAFT' }), options)!.rows[0].productStatus).toBe('DRAFT')
  })

  it('excludes inactive products only when explicitly asked', () => {
    const archived = variantNode({ status: 'ARCHIVED' })
    const excluded = mapVariantInventory(archived, { ...options, includeInactiveProducts: false })!
    expect(excluded.rows).toHaveLength(0)
    expect(excluded.skipped[0].reason).toBe('product_not_active')
  })

  it('treats an absent product status as active when exclusion is enabled', () => {
    const noStatus = { ...variantNode(), product: { isGiftCard: false } }
    const mapped = mapVariantInventory(noStatus, { ...options, includeInactiveProducts: false })!
    expect(mapped.rows).toHaveLength(1)
    expect(mapped.rows[0].productStatus).toBeNull()
  })

  it('flags a truncated inventoryLevels connection instead of losing the locations silently', () => {
    expect(mapVariantInventory(variantNode({ hasNextPage: true }), options)!.locationsTruncated).toBe(true)
  })

  it('returns null for a node with no variant GID', () => {
    expect(mapVariantInventory({ id: null }, options)).toBeNull()
  })

  it('buckets one instant to different snapshot days by store timezone', () => {
    // §12.10: the same capture is 2026-07-20 in Los Angeles and already 2026-07-21 in Auckland.
    const la = mapVariantInventory(variantNode(), { capturedAt: CAPTURED_AT, ianaTimezone: LA })!
    const auckland = mapVariantInventory(variantNode(), { capturedAt: CAPTURED_AT, ianaTimezone: AUCKLAND })!

    expect(la.rows[0].snapshotDate).toBe('2026-07-20')
    expect(auckland.rows[0].snapshotDate).toBe('2026-07-21')
  })
})

// ── Fetch strategy and cursor ───────────────────────────────────────────────────────────────────

describe('decideFetchMode', () => {
  it('pages a small catalog and bulk-exports a large one', () => {
    expect(decideFetchMode(195)).toBe('paged')
    expect(decideFetchMode(BULK_VARIANT_THRESHOLD)).toBe('bulk')
    expect(decideFetchMode(50_000)).toBe('bulk')
  })

  it('falls back to paging when the count cannot be read', () => {
    expect(decideFetchMode(null)).toBe('paged')
  })
})

describe('inventory cursor', () => {
  it('round-trips a resumable cursor for the same day', () => {
    const raw = serializeInventoryCursor({ snapshotDate: LA_DAY, endCursor: 'abc' })
    expect(parseInventoryCursor(raw, LA_DAY)).toEqual({ snapshotDate: LA_DAY, endCursor: 'abc' })
  })

  it('refuses to resume across a day boundary', () => {
    // Resuming would write the rest of the catalog under a new snapshot_date, leaving a
    // half-and-half day that no backfill can repair.
    const raw = serializeInventoryCursor({ snapshotDate: LA_DAY, endCursor: 'abc' })
    expect(parseInventoryCursor(raw, '2026-07-21')).toBeNull()
  })

  it('discards a bulk, malformed, or version-mismatched cursor', () => {
    expect(parseInventoryCursor(serializeInventoryCursor({ snapshotDate: LA_DAY, endCursor: null }), LA_DAY)).toBeNull()
    expect(parseInventoryCursor('{not json', LA_DAY)).toBeNull()
    expect(parseInventoryCursor(JSON.stringify({ v: 99, snapshotDate: LA_DAY, endCursor: 'abc' }), LA_DAY)).toBeNull()
    expect(parseInventoryCursor(null, LA_DAY)).toBeNull()
  })
})

describe('bulkReassemblyError', () => {
  it('names the unexpected parent GID type so a large-store failure diagnoses in one read', () => {
    // The specific latent risk on the bulk path: `inventoryLevels` hangs off `inventoryItem`, an
    // inline object with no JSONL line of its own, so if Shopify links levels by the InventoryItem
    // GID rather than the ProductVariant GID every level orphans.
    const error = bulkReassemblyError([
      { kind: 'orphan_child', lineNumber: 2, id: 'gid://shopify/InventoryLevel/1', parentId: 'gid://shopify/InventoryItem/9' },
      { kind: 'orphan_child', lineNumber: 3, id: 'gid://shopify/InventoryLevel/2', parentId: 'gid://shopify/InventoryItem/9' },
    ])

    expect(error.message).toMatch(/2 unusable line\(s\)/)
    expect(error.message).toMatch(/unexpected parent GID type\(s\): InventoryItem/)
    expect(error.message).toMatch(/expects InventoryLevel lines to carry __parentId of the ProductVariant/)
    expect(error.message).toMatch(/variantFromBulkNode/)
  })

  it('still reports non-orphan anomalies without inventing a parent type', () => {
    const error = bulkReassemblyError([{ kind: 'missing_id', lineNumber: 7, line: '{}' }])
    expect(error.message).toMatch(/missing_id/)
    expect(error.message).not.toMatch(/parent GID type/)
  })
})

describe('variantFromBulkNode', () => {
  it('reattaches inventory levels that arrived as separate JSONL lines', () => {
    const node: BulkNode = {
      id: VARIANT,
      type: 'ProductVariant',
      fields: {
        id: VARIANT,
        sku: 'SKU-1',
        product: { title: 'Merino Crew', status: 'ACTIVE', productType: 'Knitwear', isGiftCard: false },
        inventoryItem: { unitCost: { amount: '9.0000' }, requiresShipping: true },
      },
      children: {
        InventoryLevel: [
          {
            id: 'gid://shopify/InventoryLevel/1',
            type: 'InventoryLevel',
            fields: { location: { id: LOCATION_A }, quantities: [{ name: 'available', quantity: 3 }] },
            children: {},
          },
          {
            id: 'gid://shopify/InventoryLevel/2',
            type: 'InventoryLevel',
            fields: { location: { id: LOCATION_B }, quantities: [{ name: 'available', quantity: 0 }] },
            children: {},
          },
        ],
      },
    }

    const mapped = mapVariantInventory(variantFromBulkNode(node), { capturedAt: CAPTURED_AT, ianaTimezone: LA })!
    expect(mapped.rows).toHaveLength(2)
    expect(mapped.unitCost).toBe('9.0000')
    expect(mapped.rows.map((row) => row.outOfStock)).toEqual([false, true])
  })
})

// ── Adapter ─────────────────────────────────────────────────────────────────────────────────────

describe('createShopifyInventoryAdapter', () => {
  it('declares the inventory provider as an importer', () => {
    const { adapter } = createHarness({ pages: onePage([]) })
    expect(adapter.providerKey).toBe('shopify_inventory')
    expect(adapter.direction).toBe('import')
    expect(adapter.supportedEntities).toEqual(['shopify.inventory_level'])
  })

  it('carries no watermark — every run is a full snapshot', async () => {
    const { adapter } = createHarness({ pages: onePage([]) })
    expect(await adapter.getInitialCursor!({ entityType: 'shopify.inventory_level', scope: SCOPE })).toBeNull()
  })

  it('writes one row per location and reports the snapshot day', async () => {
    const { adapter, store } = createHarness({
      pages: onePage([
        variantNode({
          levels: [
            { locationId: LOCATION_A, available: 5, onHand: 7 },
            { locationId: LOCATION_B, available: 0 },
          ],
        }),
      ]),
    })

    const batches = await drain(adapter, importInput())

    expect(store.all()).toHaveLength(2)
    expect(batches[0].items).toHaveLength(1)
    expect(batches[0].items[0]).toMatchObject({ externalId: VARIANT, action: 'create' })
    expect(batches[0].items[0].data).toMatchObject({ snapshotDate: LA_DAY, locationCount: 2 })
    expect(batches[0].refreshCoverageEntityTypes).toEqual([OM_ENTITY_ID.productVariant])
  })

  it('is idempotent for a re-run on the same day', async () => {
    const store = createFakeStore()
    const nodes = [variantNode({ levels: [{ locationId: LOCATION_A, available: 5 }] })]

    const first = createHarness({ pages: onePage(nodes), store })
    await drain(first.adapter, importInput())
    expect(first.store.all()).toHaveLength(1)

    const second = createHarness({ pages: onePage(nodes), store })
    const batches = await drain(second.adapter, importInput())

    // The unique key absorbed the second write: one row, reported as an update, not a duplicate.
    expect(store.all()).toHaveLength(1)
    expect(batches[0].items[0].action).toBe('update')
  })

  it('excludes gift cards from the snapshot entirely', async () => {
    const { adapter, store } = createHarness({
      pages: onePage([
        variantNode({ id: VARIANT, title: 'Geschenkkarte', isGiftCard: true }),
        variantNode({ id: OTHER_VARIANT, title: 'Merino Crew' }),
      ]),
    })

    const batches = await drain(adapter, importInput())

    expect(store.all().map((row) => row.variantExternal)).toEqual([OTHER_VARIANT])
    const giftCard = batches[0].items.find((item) => item.externalId === VARIANT)!
    expect(giftCard.action).toBe('skip')
    expect(giftCard.data).toMatchObject({ isPhysical: false, skipReasons: ['not_physical'] })
  })

  it('records a variant whose availability was never observed as a skip, not a stockout', async () => {
    const { adapter, store } = createHarness({
      pages: onePage([variantNode({ levels: [{ locationId: LOCATION_A, onHand: 4 }] })]),
    })

    const batches = await drain(adapter, importInput())

    expect(store.all()).toHaveLength(0)
    expect(batches[0].items[0]).toMatchObject({ action: 'skip' })
    expect(batches[0].items[0].data).toMatchObject({ skipReasons: ['unobserved_available'] })
  })

  it('writes unit_cost when present', async () => {
    const { adapter, customFieldCalls } = createHarness({
      pages: onePage([variantNode({ unitCost: '12.5000' })]),
    })

    await drain(adapter, importInput())

    expect(customFieldCalls).toHaveLength(1)
    expect(customFieldCalls[0]).toMatchObject({ recordId: LOCAL_VARIANT_ID, entityId: OM_ENTITY_ID.productVariant })
    expect(customFieldCalls[0].values[INVENTORY_CUSTOM_FIELD.unitCost]).toBe('12.5000')
  })

  // Current-state stock is the consumer seam a downstream PO-drafting module reads instead of this
  // connector's private snapshot table.
  it('writes current on_hand and available for a single-location variant', async () => {
    const { adapter, customFieldCalls } = createHarness({
      pages: onePage([variantNode({ levels: [{ locationId: LOCATION_A, available: 5, onHand: 7 }] })]),
    })

    await drain(adapter, importInput())

    const values = customFieldCalls[0].values
    expect(values[INVENTORY_CUSTOM_FIELD.onHand]).toBe(7)
    expect(values[INVENTORY_CUSTOM_FIELD.available]).toBe(5)
  })

  it('sums current on_hand and available across a variant stocked at two locations', async () => {
    const { adapter, customFieldCalls } = createHarness({
      pages: onePage([
        variantNode({
          levels: [
            { locationId: LOCATION_A, available: 5, onHand: 7 },
            { locationId: LOCATION_B, available: 3, onHand: 4 },
          ],
        }),
      ]),
    })

    await drain(adapter, importInput())

    const values = customFieldCalls[0].values
    expect(values[INVENTORY_CUSTOM_FIELD.onHand]).toBe(11)
    expect(values[INVENTORY_CUSTOM_FIELD.available]).toBe(8)
  })

  it('never writes current stock for a variant that produced no rows (no phantom zero)', async () => {
    // A gift card is not physical inventory, so it yields no rows. Its unit cost still travels (a
    // cost is a catalog fact), which gives us a custom-field call to inspect — and that call must
    // carry NO on_hand/available, because a stored 0 would read as real, empty stock.
    const { adapter, customFieldCalls } = createHarness({
      pages: onePage([variantNode({ isGiftCard: true, unitCost: '5.0000' })]),
    })

    await drain(adapter, importInput())

    const values = customFieldCalls[0].values
    expect(values[INVENTORY_CUSTOM_FIELD.unitCost]).toBe('5.0000')
    expect(values).not.toHaveProperty(INVENTORY_CUSTOM_FIELD.onHand)
    expect(values).not.toHaveProperty(INVENTORY_CUSTOM_FIELD.available)
  })

  it('omits unit_cost rather than blanking it when Shopify has none', async () => {
    const { adapter, customFieldCalls } = createHarness({
      pages: onePage([variantNode({ unitCost: null })]),
    })

    await drain(adapter, importInput())

    // `unit_cost` is omitted, not blanked: a per-key null would blank the stored value, so a null
    // cost must never reach `setCustomFieldsIfAny`. The variant is still physical with observed
    // stock, so on_hand/available are written — the cost is simply absent from that map.
    const values = customFieldCalls[0].values
    expect(values).not.toHaveProperty(INVENTORY_CUSTOM_FIELD.unitCost)
    expect(values[INVENTORY_CUSTOM_FIELD.onHand]).toBe(7)
    expect(values[INVENTORY_CUSTOM_FIELD.available]).toBe(5)
  })

  it('does NOT write oos_ratio when the evidence is insufficient', async () => {
    const { adapter, customFieldCalls } = createHarness({
      pages: onePage([variantNode({ unitCost: '12.5000' })]),
    })

    await drain(adapter, importInput())

    const values = customFieldCalls[0].values
    // Absence, not zero. A stored 0 reads as "never out of stock" and feeds a purchase order.
    expect(values).not.toHaveProperty(INVENTORY_CUSTOM_FIELD.oosRatio)
    expect(values).not.toHaveProperty(INVENTORY_CUSTOM_FIELD.daysOutOfStock)
    expect(values[INVENTORY_CUSTOM_FIELD.unitCost]).toBe('12.5000')
  })

  it('writes oos_ratio once enough days have accrued, including today', async () => {
    const store = createFakeStore()
    // 89 prior days, every third one a stockout, plus today's capture = 90 observed over a
    // 90-day window: past both the 14-day floor and the 50% coverage floor.
    store.seedDays({
      variantExternal: VARIANT,
      locationId: LOCATION_A,
      from: addDays(LA_DAY, -89),
      days: 89,
      available: (index) => (index % 3 === 0 ? 0 : 4),
    })

    const { adapter, customFieldCalls } = createHarness({
      pages: onePage([variantNode({ levels: [{ locationId: LOCATION_A, available: 0 }] })]),
      store,
    })

    await drain(adapter, importInput())

    const values = customFieldCalls[0].values
    // 30 of the seeded 89 days, plus today's stockout — proving the ratio is computed AFTER the
    // capture is persisted rather than from yesterday's history.
    expect(values[INVENTORY_CUSTOM_FIELD.daysOutOfStock]).toBe(31)
    expect(values[INVENTORY_CUSTOM_FIELD.oosRatio]).toBeCloseTo(31 / 90, 10)
  })

  it('withholds oos_ratio when missed runs left the window sparsely covered', async () => {
    const store = createFakeStore()
    // 29 prior days plus today = 30 observed. Past the 14-day floor, but only a third of a 90-day
    // window — the "worker was down for two months" failure mode, which would otherwise return a
    // tidy ratio computed from whatever days happened to survive.
    store.seedDays({
      variantExternal: VARIANT,
      locationId: LOCATION_A,
      from: addDays(LA_DAY, -29),
      days: 29,
      available: (index) => (index % 3 === 0 ? 0 : 4),
    })

    const { adapter, customFieldCalls } = createHarness({
      pages: onePage([variantNode({ levels: [{ locationId: LOCATION_A, available: 0 }] })]),
      store,
    })

    await drain(adapter, importInput())

    expect(30).toBeGreaterThanOrEqual(OOS_MIN_OBSERVED_DAYS)
    expect(customFieldCalls[0].values).not.toHaveProperty(INVENTORY_CUSTOM_FIELD.oosRatio)
  })

  it('looks the local variant up under the PRODUCTS integration, which wrote the mapping', async () => {
    const { adapter, lookups } = createHarness({ pages: onePage([variantNode()]) })

    await drain(adapter, importInput())

    expect(lookups[0]).toEqual({
      integrationId: INTEGRATION_ID.products,
      entityType: MAPPING_ENTITY_TYPE.productVariant,
      externalId: VARIANT,
    })
  })

  it('still snapshots when the catalog mapping lags, skipping only the write-back', async () => {
    const { adapter, store, customFieldCalls } = createHarness({
      pages: onePage([variantNode()]),
      localVariantId: null,
    })

    const batches = await drain(adapter, importInput())

    // A skipped day is lost forever; a missing local id is repaired by the next products run.
    expect(store.all()).toHaveLength(1)
    expect(customFieldCalls).toHaveLength(0)
    expect(batches[0].items[0]).toMatchObject({ action: 'create' })
    expect(batches[0].items[0].data).toMatchObject({ localId: null, wroteCustomFields: false })
  })

  it('pages until hasNextPage is false, carrying the endCursor forward', async () => {
    const { adapter, requests } = createHarness({
      pages: [
        { nodes: [variantNode({ id: VARIANT })], endCursor: 'page-1', hasNextPage: true },
        { nodes: [variantNode({ id: OTHER_VARIANT })], endCursor: 'page-2', hasNextPage: false },
      ],
    })

    const batches = await drain(adapter, importInput())

    expect(batches).toHaveLength(2)
    expect(batches[0].hasMore).toBe(true)
    expect(batches[1].hasMore).toBe(false)
    expect(batches[1].processedCount).toBe(2)

    const variantRequests = requests.filter((request) => request.query.includes('SyncShopifyInventoryVariants'))
    expect(variantRequests[0].variables).toMatchObject({ first: DEFAULT_PAGE_SIZE, after: null })
    expect(variantRequests[1].variables).toMatchObject({ after: 'page-1' })
  })

  it('resumes from a same-day cursor and restarts after a day rollover', async () => {
    const resumable = createHarness({ pages: onePage([variantNode()]) })
    await drain(resumable.adapter, importInput({ cursor: serializeInventoryCursor({ snapshotDate: LA_DAY, endCursor: 'page-1' }) }))
    expect(
      resumable.requests.find((request) => request.query.includes('SyncShopifyInventoryVariants'))!.variables,
    ).toMatchObject({ after: 'page-1' })

    const stale = createHarness({ pages: onePage([variantNode()]) })
    await drain(stale.adapter, importInput({ cursor: serializeInventoryCursor({ snapshotDate: '2026-07-19', endCursor: 'page-1' }) }))
    expect(
      stale.requests.find((request) => request.query.includes('SyncShopifyInventoryVariants'))!.variables,
    ).toMatchObject({ after: null })
  })

  it('reports a truncated location connection as an anomaly', async () => {
    const { adapter, anomalies } = createHarness({ pages: onePage([variantNode({ hasNextPage: true })]) })

    await drain(adapter, importInput())

    expect(anomalies).toContainEqual({
      kind: 'locations_truncated',
      variantExternal: VARIANT,
      limit: MAX_INVENTORY_LEVELS,
    })
  })

  it('pages on when the variant count is unreadable, and says so', async () => {
    const { adapter, anomalies } = createHarness({ pages: onePage([variantNode()]), variantCount: null })

    const batches = await drain(adapter, importInput())

    expect(anomalies.some((anomaly) => anomaly.kind === 'variant_count_unavailable')).toBe(true)
    expect(batches[0].items[0].action).toBe('create')
    expect(batches[0].totalEstimate).toBeUndefined()
  })

  it('fails the run rather than guessing a timezone', async () => {
    const { adapter } = createHarness({ pages: onePage([variantNode()]), timezone: '   ' })

    // Mis-bucketed rows can never be corrected; a failed run can simply be re-run.
    await expect(drain(adapter, importInput())).rejects.toThrow(/ianaTimezone/)
  })

  it('does NOT fail an item when only the custom-field write-back failed', async () => {
    const store = createFakeStore()
    const anomalies: InventoryAnomaly[] = []
    // Both variants resolve to the same local id, so the first attempt is the one that fails.
    let customFieldAttempts = 0
    const adapter = createShopifyInventoryAdapter({
      createClient: () =>
        createFakeClient({ pages: onePage([variantNode({ id: VARIANT }), variantNode({ id: OTHER_VARIANT })]) }).client,
      store,
      externalIdMapping: {
        async lookupLocalId() {
          return LOCAL_VARIANT_ID
        },
        async storeExternalIdMapping() {
          throw new Error('unreachable')
        },
      },
      writeCustomFields: async (input) => {
        if (input.recordId === LOCAL_VARIANT_ID && customFieldAttempts++ === 0) {
          throw new Error('no custom field definition for unit_cost')
        }
      },
      now: () => CAPTURED_AT,
      onAnomaly: (anomaly) => anomalies.push(anomaly),
    })

    const batches = await drain(adapter, importInput())

    // The snapshot row is the primary artifact; the custom fields are decoration on top of it. On
    // a fresh install with no cf definitions, failing the item would report a working integration
    // as catastrophic on its very first run.
    expect(batches[0].items.map((item) => item.action)).toEqual(['create', 'create'])
    expect(batches[0].items[0].data).toMatchObject({
      writeBackError: 'no custom field definition for unit_cost',
      wroteCustomFields: false,
    })
    expect(batches[0].items[0].data).not.toHaveProperty('errorMessage')
    expect(store.all()).toHaveLength(2)

    // Not silent, though: the run log and the anomaly stream both carry it.
    expect(anomalies).toContainEqual({
      kind: 'write_back_failed',
      variantExternal: VARIANT,
      message: 'no custom field definition for unit_cost',
    })
    expect(batches[0].message).toMatch(/1 custom-field write-back\(s\) failed/)
  })

  it('does NOT fail an item when the history read behind oosRatio throws', async () => {
    // The other throw source inside the write-back: `oosRatio` reads the snapshot table, and a
    // failing read must be tolerated exactly like a failing custom-field write.
    const store = createFakeStore()
    const anomalies: InventoryAnomaly[] = []
    const readFailing: InventorySnapshotStore = {
      ...store,
      async findDailyRows() {
        throw new Error('history read timed out')
      },
    }
    const adapter = createShopifyInventoryAdapter({
      createClient: () => createFakeClient({ pages: onePage([variantNode()]) }).client,
      store: readFailing,
      externalIdMapping: {
        async lookupLocalId() {
          return LOCAL_VARIANT_ID
        },
        async storeExternalIdMapping() {
          throw new Error('unreachable')
        },
      },
      writeCustomFields: async () => {},
      now: () => CAPTURED_AT,
      onAnomaly: (anomaly) => anomalies.push(anomaly),
    })

    const batches = await drain(adapter, importInput())

    expect(batches[0].items[0]).toMatchObject({ action: 'create' })
    expect(batches[0].items[0].data).toMatchObject({ writeBackError: 'history read timed out' })
    expect(batches[0].items[0].data).not.toHaveProperty('errorMessage')
    expect(anomalies).toContainEqual({
      kind: 'write_back_failed',
      variantExternal: VARIANT,
      message: 'history read timed out',
    })
    // The snapshot itself was written before the ratio was ever consulted.
    expect(store.all()).toHaveLength(1)
  })

  it('does NOT fail an item when the mapping lookup itself throws', async () => {
    const store = createFakeStore()
    const adapter = createShopifyInventoryAdapter({
      createClient: () => createFakeClient({ pages: onePage([variantNode()]) }).client,
      store,
      externalIdMapping: {
        async lookupLocalId() {
          throw new Error('mapping lookup exploded')
        },
        async storeExternalIdMapping() {
          throw new Error('unreachable')
        },
      },
      now: () => CAPTURED_AT,
    })

    const batches = await drain(adapter, importInput())

    expect(batches[0].items[0]).toMatchObject({ action: 'create' })
    expect(batches[0].items[0].data).toMatchObject({ writeBackError: 'mapping lookup exploded', localId: null })
    expect(store.all()).toHaveLength(1)
  })

  it('marks a page failed when the snapshot upsert itself fails', async () => {
    const store = createFakeStore()
    const broken: InventorySnapshotStore = {
      ...store,
      async upsertSnapshots() {
        throw new Error('unique violation')
      },
    }
    const { client } = createFakeClient({ pages: onePage([variantNode()]) })
    const adapter = createShopifyInventoryAdapter({
      createClient: () => client,
      store: broken,
      externalIdMapping: {
        async lookupLocalId() {
          return LOCAL_VARIANT_ID
        },
        async storeExternalIdMapping() {
          throw new Error('unreachable')
        },
      },
      now: () => CAPTURED_AT,
    })

    const batches = await drain(adapter, importInput())

    // The boundary that matters: a decoration failure is tolerated, a primary-artifact failure is
    // not. This is the ONLY path to `action: 'failed'`.
    expect(batches[0].items[0]).toMatchObject({ action: 'failed' })
    expect(batches[0].items[0].data.errorMessage).toMatch(/snapshot upsert failed: unique violation/)
    expect(store.all()).toHaveLength(0)
  })

  it('snapshots without a custom-field writer', async () => {
    const { adapter, store } = createHarness({ pages: onePage([variantNode()]), withCustomFields: false })

    const batches = await drain(adapter, importInput())

    expect(store.all()).toHaveLength(1)
    expect(batches[0].items[0].data).toMatchObject({ wroteCustomFields: false })
  })

  it('validates the connection by proving locations are readable', async () => {
    const { client } = createFakeClient({})
    const okAdapter = createShopifyInventoryAdapter({
      createClient: () => ({
        ...client,
        async request() {
          return { shop: { ianaTimezone: LA }, locations: { edges: [{ node: { id: LOCATION_A } }] } }
        },
      }) as unknown as ShopifyClient,
      store: createFakeStore(),
      externalIdMapping: {
        async lookupLocalId() {
          return null
        },
        async storeExternalIdMapping() {
          throw new Error('unreachable')
        },
      },
    })

    const result = await okAdapter.validateConnection!({
      entityType: 'shopify.inventory_level',
      credentials: {},
      mapping: { entityType: 'shopify.inventory_level', fields: [], matchStrategy: 'externalId' },
      scope: SCOPE,
    })

    // The shipped contract is `{ ok }` — `data_sync/AGENTS.md`'s `{ valid }` snippet is stale.
    expect(result.ok).toBe(true)
    expect(result.details).toMatchObject({ ianaTimezone: LA })
  })

  it('reports a connection with no visible locations as a scope problem', async () => {
    const { client } = createFakeClient({})
    const adapter = createShopifyInventoryAdapter({
      createClient: () => ({
        ...client,
        async request() {
          return { shop: { ianaTimezone: LA }, locations: { edges: [] } }
        },
      }) as unknown as ShopifyClient,
      store: createFakeStore(),
      externalIdMapping: {
        async lookupLocalId() {
          return null
        },
        async storeExternalIdMapping() {
          throw new Error('unreachable')
        },
      },
    })

    const result = await adapter.validateConnection!({
      entityType: 'shopify.inventory_level',
      credentials: {},
      mapping: { entityType: 'shopify.inventory_level', fields: [], matchStrategy: 'externalId' },
      scope: SCOPE,
    })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/read_locations/)
  })
})
