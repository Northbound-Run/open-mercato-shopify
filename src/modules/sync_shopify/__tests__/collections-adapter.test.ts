import {
  buildCollectionsBulkQuery,
  buildCollectionsDeltaQuery,
  buildUpdatedAtFilter,
  createShopifyCollectionsAdapter,
  readSearchWarnings,
  type CollectionsAdapterDeps,
  type CollectionsRunContext,
} from '../lib/adapters/collections'
import { createEntityWriter, type EntityRow, type FindOnePort } from '../lib/writer'
import { parseCursor, serializeCursor } from '../lib/cursor'
import type { ShopifyClient } from '../lib/client'
import type { HeartbeatClock } from '../lib/heartbeat'
import type { ImportBatch, StreamImportInput } from '@open-mercato/core/modules/data_sync/lib/adapter'

/**
 * The framework never loads at test runtime, so every collaborator is an in-memory stub.
 *
 * The stub that earns its keep is the command bus: `catalog.products.update` REPLACES a product's
 * entire category set, and the stub reproduces exactly that. Any implementation that wrote a delta
 * instead of a merged set would pass a naive stub and lose data in production; here it fails.
 */

const SCOPE = { organizationId: 'org-1', tenantId: 'tenant-1' }
const CATEGORY_ENTITY = 'CatalogProductCategory'
const PRODUCTS_INTEGRATION = 'sync_shopify_products'

type CommandCall = { commandId: string; input: Record<string, unknown> }
type LookupCall = { integrationId: string; entityType: string; externalId: string }

type World = {
  categories: Map<string, EntityRow>
  /** Local product ids that exist. Nothing here may ever create one. */
  products: Set<string>
  /** The junction table: product → the categories it belongs to. */
  assignments: Map<string, Set<string>>
  mappings: Map<string, string>
  commandCalls: CommandCall[]
  lookupCalls: LookupCall[]
  runContext: CollectionsRunContext
}

function makeWorld(seed: { products?: string[]; assignments?: Record<string, string[]> } = {}): World {
  const categories = new Map<string, EntityRow>()
  const products = new Set<string>(seed.products ?? [])
  const assignments = new Map<string, Set<string>>()
  const mappings = new Map<string, string>()
  const commandCalls: CommandCall[] = []
  const lookupCalls: LookupCall[] = []
  let sequence = 0

  for (const [productId, categoryIds] of Object.entries(seed.assignments ?? {})) {
    assignments.set(productId, new Set(categoryIds))
  }

  const mappingKey = (integrationId: string, entityType: string, externalId: string) =>
    `${integrationId}|${entityType}|${externalId}`

  const externalIdMapping = {
    async lookupLocalId(integrationId: string, entityType: string, externalId: string) {
      lookupCalls.push({ integrationId, entityType, externalId })
      return mappings.get(mappingKey(integrationId, entityType, externalId)) ?? null
    },
    async storeExternalIdMapping(
      integrationId: string,
      entityType: string,
      localId: string,
      externalId: string,
    ) {
      mappings.set(mappingKey(integrationId, entityType, externalId), localId)
      return {}
    },
  }

  const commandBus = {
    async execute(commandId: string, options: { input: unknown }) {
      const input = options.input as Record<string, unknown>
      commandCalls.push({ commandId, input })

      if (commandId === 'catalog.categories.create') {
        const id = `cat-${(sequence += 1)}`
        categories.set(id, {
          id,
          name: input.name as string,
          slug: (input.slug as string | null) ?? null,
          description: (input.description as string) ?? '',
        })
        return { result: { categoryId: id } }
      }

      if (commandId === 'catalog.categories.update') {
        const row = categories.get(input.id as string)
        if (row) {
          if (input.name !== undefined) row.name = input.name as string
          if (input.slug !== undefined) row.slug = input.slug as string | null
          if (input.description !== undefined) row.description = input.description as string
        }
        return { result: { categoryId: input.id } }
      }

      if (commandId === 'catalog.products.update') {
        const productId = input.id as string
        const categoryIds = input.categoryIds as string[]
        // 🔴 The behaviour under test. `syncCategoryAssignments` removes every assignment absent
        // from `categoryIds`, so this array is the product's WHOLE set — never a delta.
        assignments.set(productId, new Set(categoryIds))
        return { result: { productId } }
      }

      throw new Error(`unexpected command ${commandId}`)
    },
  }

  const findOne: FindOnePort = async (_entityName, where) => {
    // A scoped read always asks for live rows; honouring that keeps soft-delete behaviour honest.
    if (where.deletedAt !== null) return null
    if (typeof where.id === 'string') return categories.get(where.id) ?? null
    if (typeof where.slug === 'string') {
      for (const row of categories.values()) if (row.slug === where.slug) return row
    }
    return null
  }

  const writer = createEntityWriter({
    container: { resolve: () => undefined } as never,
    scope: SCOPE,
    integrationId: 'sync_shopify_collections',
    commandBus,
    externalIdMapping,
    findOne,
  })

  const runContext: CollectionsRunContext = {
    writer,
    externalIdMapping,
    commandBus,
    categoryEntity: CATEGORY_ENTITY,
    assignments: {
      async productIdsForCategory(categoryLocalId) {
        return [...assignments.entries()]
          .filter(([, categoryIds]) => categoryIds.has(categoryLocalId))
          .map(([productId]) => productId)
      },
      async categoryIdsForProduct(productLocalId) {
        return [...(assignments.get(productLocalId) ?? [])]
      },
    },
  }

  return { categories, products, assignments, mappings, commandCalls, lookupCalls, runContext }
}

/** Map a Shopify product GID to a local id, under the PRODUCTS integration where it really lives. */
function mapProduct(world: World, externalId: string, localId: string): void {
  world.products.add(localId)
  world.mappings.set(`${PRODUCTS_INTEGRATION}|catalog_product|${externalId}`, localId)
}

// ── Shopify transport stubs ──────────────────────────────────────────────────────────────────

type Responder = (query: string, variables: Record<string, unknown>) => unknown

function makeClient(responder: Responder): ShopifyClient {
  return {
    shopDomain: 'test.myshopify.com',
    apiVersion: '2026-07',
    cost: {} as ShopifyClient['cost'],
    async request<TData>(query: string, options?: { variables?: Record<string, unknown> }) {
      return responder(query, options?.variables ?? {}) as TData
    },
    async requestDetailed<TData>(query: string, options?: { variables?: Record<string, unknown> }) {
      // No `extensions` by default — that is the ordinary case, and it keeps every other test off
      // the R-13 path. The search-warning test overrides this method to supply an envelope.
      return { data: responder(query, options?.variables ?? {}) as TData, extensions: undefined }
    },
  }
}

/** A JSONL body served as a byte stream, the way `fetchJsonlLines` consumes a real one. */
function jsonlBody(lines: string[]) {
  const bytes = new TextEncoder().encode(`${lines.join('\n')}\n`)
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      yield bytes
    })(),
  }
}

const BULK_RESULT_URL = 'https://storage.example/bulk-result.jsonl'

/**
 * Wire up the bulk path: submit → poll → download, with `lines` as the export.
 *
 * `partial` reproduces the FAILED-with-partialDataUrl case: Shopify hands back whatever the
 * operation managed to write before dying, which is worth importing but is NOT a complete picture.
 */
function makeBulkDeps(world: World, lines: string[], options: { partial?: boolean } = {}): CollectionsAdapterDeps {
  const client = makeClient((query) => {
    if (query.includes('bulkOperationRunQuery')) {
      return {
        bulkOperationRunQuery: {
          bulkOperation: { id: 'gid://shopify/BulkOperation/1', status: 'CREATED' },
          userErrors: [],
        },
      }
    }
    if (query.includes('bulkOperation(id:')) {
      return {
        bulkOperation: {
          id: 'gid://shopify/BulkOperation/1',
          ...(options.partial
            ? { status: 'FAILED', errorCode: 'TIMEOUT', partialDataUrl: BULK_RESULT_URL, url: null }
            : { status: 'COMPLETED', url: BULK_RESULT_URL }),
          objectCount: lines.length,
        },
      }
    }
    throw new Error(`unexpected bulk query: ${query.slice(0, 60)}`)
  })

  return {
    createClient: () => client,
    createRunContext: async () => world.runContext,
    bulkOptions: {
      sleep: async () => undefined,
      fetchImpl: (async () => jsonlBody(lines)) as never,
    },
  }
}

function streamInput(over: Partial<StreamImportInput> = {}): StreamImportInput {
  return {
    entityType: 'shopify.collection',
    batchSize: 100,
    credentials: { shopDomain: 'test.myshopify.com' },
    mapping: { entityType: 'shopify.collection', fields: [], matchStrategy: 'externalId' },
    scope: SCOPE,
    ...over,
  }
}

async function drain(batches: AsyncIterable<ImportBatch>): Promise<ImportBatch[]> {
  const collected: ImportBatch[] = []
  for await (const batch of batches) collected.push(batch)
  return collected
}

const collectionLine = (id: number, title: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: `gid://shopify/Collection/${id}`,
    title,
    handle: title.toLowerCase().replace(/\s+/g, '-'),
    descriptionHtml: `<p>${title}</p>`,
    updatedAt: '2026-07-19T10:00:00Z',
    sources: [],
    ...extra,
  })

const memberLine = (productId: number, collectionId: number) =>
  JSON.stringify({
    id: `gid://shopify/Product/${productId}`,
    __parentId: `gid://shopify/Collection/${collectionId}`,
  })

// ── Heartbeat test doubles ───────────────────────────────────────────────────────────────────

/** A promise whose settlement the test controls, for holding the bulk export open mid-run. */
function makeDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A `HeartbeatClock` whose bulk-poll timers fire only when the test says so. */
function makeFakeHeartbeatClock() {
  type Timer = { cb: () => void; dead: boolean }
  const timers: Timer[] = []
  const clock: HeartbeatClock = {
    setTimer: (_ms, cb) => {
      const timer: Timer = { cb, dead: false }
      timers.push(timer)
      return () => {
        timer.dead = true
      }
    },
  }
  return {
    clock,
    /** Fire the most recent live timer, mimicking one interval elapsing. */
    fireNext(): boolean {
      for (let i = timers.length - 1; i >= 0; i -= 1) {
        if (!timers[i].dead) {
          timers[i].dead = true
          timers[i].cb()
          return true
        }
      }
      return false
    },
  }
}

/** Hop the macrotask boundary so the adapter generator reaches its next await/yield. */
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function drainBatches(iterator: AsyncIterator<ImportBatch>): Promise<ImportBatch[]> {
  const out: ImportBatch[] = []
  for (;;) {
    const result = await iterator.next()
    if (result.done) break
    out.push(result.value)
  }
  return out
}

/**
 * Bulk deps whose poll response is deferred, holding `openBulkStream` open mid-poll.
 *
 * Collections has no `bulkExport` seam (it drives `openBulkStream` internally), so the poll is held
 * open at the transport: the `bulkOperation(id:)` query returns `poll`, which the test resolves
 * with the terminal operation once it has observed a heartbeat.
 */
function makeDeferredBulkDeps(world: World, lines: string[], poll: Promise<unknown>): CollectionsAdapterDeps {
  const client = makeClient((query) => {
    if (query.includes('bulkOperationRunQuery')) {
      return {
        bulkOperationRunQuery: {
          bulkOperation: { id: 'gid://shopify/BulkOperation/1', status: 'CREATED' },
          userErrors: [],
        },
      }
    }
    if (query.includes('bulkOperation(id:')) {
      // Held open until the test resolves `poll`, so the poll phase is observably in progress.
      return poll
    }
    throw new Error(`unexpected bulk query: ${query.slice(0, 60)}`)
  })

  return {
    createClient: () => client,
    createRunContext: async () => world.runContext,
    bulkOptions: {
      sleep: async () => undefined,
      fetchImpl: (async () => jsonlBody(lines)) as never,
    },
  }
}

/** The terminal poll response a deferred bulk export resolves with. */
const completedBulkOperation = (objectCount: number) => ({
  bulkOperation: {
    id: 'gid://shopify/BulkOperation/1',
    status: 'COMPLETED',
    url: BULK_RESULT_URL,
    objectCount,
  },
})

// ── Adapter shape ────────────────────────────────────────────────────────────────────────────

describe('adapter contract', () => {
  const adapter = createShopifyCollectionsAdapter({
    createClient: () => makeClient(() => ({})),
    createRunContext: async () => makeWorld().runContext,
  })

  it('declares the provider key the integration definition joins on', () => {
    // `getIntegration(id)?.providerKey ?? id` resolves the adapter, so this string must equal the
    // IntegrationDefinition's providerKey exactly or the engine finds no adapter at all.
    expect(adapter.providerKey).toBe('shopify_collections')
    expect(adapter.direction).toBe('import')
    expect(adapter.supportedEntities).toEqual(['shopify.collection'])
  })

  it('starts with no cursor, which is what routes the first run into the bulk backfill', async () => {
    await expect(adapter.getInitialCursor!({ entityType: 'shopify.collection', scope: SCOPE })).resolves.toBeNull()
  })

  it('describes the mapping, including what it deliberately does not map', async () => {
    const mapping = await adapter.getMapping({ entityType: 'shopify.collection', scope: SCOPE })
    expect(mapping.matchStrategy).toBe('externalId')
    const sources = mapping.fields.find((field) => field.externalField === 'sources')
    expect(sources?.mappingKind).toBe('ignore')
  })
})

describe('query construction', () => {
  it('builds the updated_at filter exactly, because a typo here is silent', () => {
    // 🔴 "If you specify an invalid field, then the query is ignored and all results are returned."
    // `updatedAt` instead of `updated_at` does not error — it turns every delta into a full scan
    // that still looks correct. This assertion is the only cheap defence available.
    expect(buildUpdatedAtFilter('2026-07-19T10:00:00.000Z')).toBe("updated_at:>'2026-07-19T10:00:00.000Z'")
    expect(buildUpdatedAtFilter(null)).toBeNull()
  })

  it('reports a delta filter Shopify silently ignored', async () => {
    // R-13: an invalid search field is not an error — "the query is ignored and all results are
    // returned". The only evidence is `extensions.search[].warnings`, so a delta run that scans the
    // whole catalog otherwise looks like a fast, correct one.
    const world = makeWorld()
    const client = makeClient(() => ({
      collections: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
    }))
    client.requestDetailed = (async () => ({
      data: { collections: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      extensions: { search: [{ warnings: [{ field: 'updated_at', message: 'Field is not supported' }] }] },
    })) as never

    const adapter = createShopifyCollectionsAdapter({
      createClient: () => client,
      createRunContext: async () => world.runContext,
    })

    const cursor = JSON.stringify({ v: 1, kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' })
    const items = (await drain(adapter.streamImport!(streamInput({ cursor })))).flatMap((batch) => batch.items)

    expect(items).toHaveLength(1)
    expect(items[0].action).toBe('failed')
    expect(items[0].data.errorMessage).toContain('ignored the delta filter')
    expect(items[0].data.sourceIdentifier).toBe("updated_at:>'2026-07-01T00:00:00.000Z'")
  })

  it('reads search warnings out of whatever shape the extensions envelope has', () => {
    expect(readSearchWarnings(undefined)).toEqual([])
    expect(readSearchWarnings({ search: 'not-an-array' })).toEqual([])
    expect(readSearchWarnings({ search: [{ warnings: [] }] })).toEqual([])
    expect(readSearchWarnings({ search: [{ warnings: ['plain string'] }] })).toEqual(['plain string'])
    expect(readSearchWarnings({ search: [{ warnings: [{ field: 'f', message: 'm' }] }] })).toEqual(['f: m'])
  })

  it('pairs the updated_at filter with the matching sort key', () => {
    // Without `sortKey: UPDATED_AT` a filtered collection query times out rather than paginating.
    expect(buildCollectionsDeltaQuery()).toContain('sortKey: UPDATED_AT')
  })

  it('reads `sources` and never the deprecated `ruleSet`', () => {
    // Collections on the 2026-07 multi-source model are silently filtered out of older versions;
    // querying `ruleSet` is the habit that keeps a connector pinned to a version that loses them.
    for (const query of [buildCollectionsBulkQuery(), buildCollectionsDeltaQuery()]) {
      expect(query).toContain('sources')
      expect(query).not.toContain('ruleSet')
    }
  })

  it('keeps the bulk query inside the two-connection, two-level limits', () => {
    const query = buildCollectionsBulkQuery()
    // A bulk query must contain a connection, may hold at most 5, and may nest at most 2 deep.
    expect(query.match(/collections|products/g)?.length).toBe(2)
  })
})

// ── Membership ───────────────────────────────────────────────────────────────────────────────

describe('membership', () => {
  it('gives a product in three collections three assignments', async () => {
    const world = makeWorld()
    mapProduct(world, 'gid://shopify/Product/10', 'prod-10')

    const adapter = createShopifyCollectionsAdapter(
      makeBulkDeps(world, [
        collectionLine(1, 'Summer'),
        memberLine(10, 1),
        collectionLine(2, 'Sale'),
        memberLine(10, 2),
        collectionLine(3, 'New In'),
        memberLine(10, 3),
      ]),
    )

    const batches = await drain(adapter.streamImport!(streamInput()))
    const items = batches.flatMap((batch) => batch.items)

    expect(items.filter((item) => item.action === 'create')).toHaveLength(3)
    expect([...world.assignments.get('prod-10')!]).toEqual(['cat-1', 'cat-2', 'cat-3'])

    // Each write carried the product's COMPLETE set — 1, then 2, then 3 — proving the
    // read-merge-write. A delta write would have sent a single id every time and the assertion
    // above would show one category, not three.
    const writes = world.commandCalls.filter((call) => call.commandId === 'catalog.products.update')
    expect(writes.map((call) => (call.input.categoryIds as string[]).length)).toEqual([1, 2, 3])
  })

  it('resolves members under the products integration, not its own', async () => {
    const world = makeWorld()
    mapProduct(world, 'gid://shopify/Product/10', 'prod-10')

    const adapter = createShopifyCollectionsAdapter(
      makeBulkDeps(world, [collectionLine(1, 'Summer'), memberLine(10, 1)]),
    )
    await drain(adapter.streamImport!(streamInput()))

    // The mapping table is partitioned by integration id. Looking a product up under
    // `sync_shopify_collections` returns null forever, which presents as "the products sync has
    // not run" and never as an error.
    const productLookups = world.lookupCalls.filter((call) => call.entityType === 'catalog_product')
    expect(productLookups).toHaveLength(1)
    expect(productLookups[0].integrationId).toBe(PRODUCTS_INTEGRATION)
  })

  it('removes exactly the assignment dropped upstream and leaves the product intact', async () => {
    const world = makeWorld({
      products: ['prod-10'],
      assignments: { 'prod-10': ['cat-1', 'cat-2', 'cat-3'] },
    })
    mapProduct(world, 'gid://shopify/Product/10', 'prod-10')
    // Pre-existing categories, already mapped, so this run updates rather than creates.
    for (const [index, name] of ['Summer', 'Sale', 'New In'].entries()) {
      const id = `cat-${index + 1}`
      world.categories.set(id, { id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), description: `<p>${name}</p>` })
      world.mappings.set(`sync_shopify_collections|catalog_product_category|gid://shopify/Collection/${index + 1}`, id)
    }

    // Collection 1 no longer lists the product; 2 and 3 still do.
    const adapter = createShopifyCollectionsAdapter(
      makeBulkDeps(world, [
        collectionLine(1, 'Summer'),
        collectionLine(2, 'Sale'),
        memberLine(10, 2),
        collectionLine(3, 'New In'),
        memberLine(10, 3),
      ]),
    )
    await drain(adapter.streamImport!(streamInput()))

    expect([...world.assignments.get('prod-10')!].sort()).toEqual(['cat-2', 'cat-3'])
    // Detaching a product from a category must never reach the product itself.
    expect(world.commandCalls.map((call) => call.commandId)).not.toContain('catalog.products.delete')
    expect(world.products.has('prod-10')).toBe(true)
  })

  it('withholds removals when a member could not be resolved', async () => {
    // An unresolvable member means OUR mapping is incomplete, not that Shopify dropped the product.
    // Removing on that basis would delete an assignment that is genuinely still upstream.
    const world = makeWorld({ assignments: { 'prod-10': ['cat-1'] } })
    mapProduct(world, 'gid://shopify/Product/10', 'prod-10')
    world.categories.set('cat-1', { id: 'cat-1', name: 'Summer', slug: 'summer', description: '<p>Summer</p>' })
    world.mappings.set('sync_shopify_collections|catalog_product_category|gid://shopify/Collection/1', 'cat-1')

    const adapter = createShopifyCollectionsAdapter(
      makeBulkDeps(world, [
        collectionLine(1, 'Summer'),
        // Product 10 is gone from the payload, but product 99 is present and unmapped.
        memberLine(99, 1),
      ]),
    )
    const batches = await drain(adapter.streamImport!(streamInput()))
    const item = batches.flatMap((batch) => batch.items)[0]

    expect(item.data.membershipReconciled).toBe(false)
    expect([...world.assignments.get('prod-10')!]).toEqual(['cat-1'])
  })
})

// ── The reconciliation guard ─────────────────────────────────────────────────────────────────

describe('the !input.cursor reconciliation guard', () => {
  /** Same world both ways: three categories, one product in all of them, all already mapped. */
  function seedReconciliationWorld(): World {
    const world = makeWorld({
      products: ['prod-10'],
      assignments: { 'prod-10': ['cat-1', 'cat-2', 'cat-3'] },
    })
    mapProduct(world, 'gid://shopify/Product/10', 'prod-10')
    for (const [index, name] of ['Summer', 'Sale', 'New In'].entries()) {
      const id = `cat-${index + 1}`
      world.categories.set(id, { id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), description: `<p>${name}</p>` })
      world.mappings.set(`sync_shopify_collections|catalog_product_category|gid://shopify/Collection/${index + 1}`, id)
    }
    return world
  }

  it('reconciles on a full run — no cursor means the whole catalog was read', async () => {
    const world = seedReconciliationWorld()
    const adapter = createShopifyCollectionsAdapter(makeBulkDeps(world, [collectionLine(1, 'Summer')]))

    const batches = await drain(adapter.streamImport!(streamInput()))

    expect(batches.at(-1)!.items.at(-1)!.data.membershipReconciled).toBe(true)
    expect([...world.assignments.get('prod-10')!].sort()).toEqual(['cat-2', 'cat-3'])
  })

  it('🔴 performs NO reconciliation on a delta run', async () => {
    // A delta run legitimately sees only the collections that changed. Reconciling on one would
    // strip the membership of every collection it did not happen to touch — the difference between
    // a correct sync and a catastrophic one.
    const world = seedReconciliationWorld()

    const client = makeClient((query) => {
      if (query.includes('SyncShopifyCollectionsPage')) {
        return {
          collections: {
            edges: [
              {
                node: {
                  id: 'gid://shopify/Collection/1',
                  title: 'Summer',
                  handle: 'summer',
                  descriptionHtml: '<p>Summer</p>',
                  updatedAt: '2026-07-19T10:00:00Z',
                  sources: [],
                  // Empty upstream membership — the exact payload that would strip assignments if
                  // the guard were missing.
                  products: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`)
    })

    const adapter = createShopifyCollectionsAdapter({
      createClient: () => client,
      createRunContext: async () => world.runContext,
    })

    const cursor = JSON.stringify({ v: 1, kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' })
    const batches = await drain(adapter.streamImport!(streamInput({ cursor })))

    // Nothing was removed…
    expect([...world.assignments.get('prod-10')!].sort()).toEqual(['cat-1', 'cat-2', 'cat-3'])
    // …and no assignment write was attempted at all.
    expect(world.commandCalls.filter((call) => call.commandId === 'catalog.products.update')).toHaveLength(0)
    expect(batches.at(-1)!.items[0].data.membershipReconciled).toBe(false)
    expect(batches.at(-1)!.message).toContain('Delta sync')
  })

  it('recovers from an unreadable cursor with a full backfill, and reconciles', async () => {
    // `parseCursor` returns null for anything it cannot trust — an older encoding, a truncated
    // write, a hand-edit. There is nowhere to resume from, so the honest move is to re-read
    // everything via bulk, which is also exactly what makes reconciling correct again.
    const world = seedReconciliationWorld()
    const adapter = createShopifyCollectionsAdapter(makeBulkDeps(world, [collectionLine(1, 'Summer')]))

    const batches = await drain(adapter.streamImport!(streamInput({ cursor: '{"v":99,"kind":"nonsense"}' })))

    expect(batches.at(-1)!.items[0].data.membershipReconciled).toBe(true)
    expect([...world.assignments.get('prod-10')!].sort()).toEqual(['cat-2', 'cat-3'])
  })

  it('does not reconcile when a backfill is resumed from a bulk cursor', async () => {
    // A resumed run carries a cursor, so it lands on the safe side of the guard: it adds without
    // removing, and the next clean full run reconciles.
    const world = seedReconciliationWorld()
    const deps = makeBulkDeps(world, [collectionLine(1, 'Summer')])
    const adapter = createShopifyCollectionsAdapter(deps)

    const cursor = JSON.stringify({
      v: 1,
      kind: 'bulk',
      bulkOperationId: 'gid://shopify/BulkOperation/1',
      updatedAfter: null,
      maxUpdatedAt: null,
    })
    await drain(adapter.streamImport!(streamInput({ cursor })))

    expect([...world.assignments.get('prod-10')!].sort()).toEqual(['cat-1', 'cat-2', 'cat-3'])
  })
})

// ── Products that do not exist locally ───────────────────────────────────────────────────────

describe('unmapped products', () => {
  it('records an unresolvable member and never fabricates a product for it', async () => {
    const world = makeWorld()
    // Deliberately no mapping for product 99 — the products sync has not run.

    const adapter = createShopifyCollectionsAdapter(
      makeBulkDeps(world, [collectionLine(1, 'Summer'), memberLine(10, 1), memberLine(99, 1)]),
    )
    const batches = await drain(adapter.streamImport!(streamInput()))
    const item = batches.flatMap((batch) => batch.items)[0]

    expect(item.data.unmappedProductCount).toBe(2)
    expect(item.data.unmappedProductExternalIds).toEqual([
      'gid://shopify/Product/10',
      'gid://shopify/Product/99',
    ])

    // Nothing invented a product to hang the assignment off…
    const commands = world.commandCalls.map((call) => call.commandId)
    expect(commands).not.toContain('catalog.products.create')
    expect(commands).not.toContain('catalog.products.update')
    expect(world.products.size).toBe(0)
    expect(world.assignments.size).toBe(0)

    // …and the collection itself still imported successfully: it is this install that is
    // incomplete, not the collection.
    expect(item.action).toBe('create')
    expect(batches.at(-1)!.message).toContain('not yet imported')
  })
})

// ── Paging a large collection ────────────────────────────────────────────────────────────────

describe('a collection with more members than one page', () => {
  it('pages the member connection instead of assuming one page', async () => {
    const world = makeWorld()
    for (const index of [1, 2, 3]) {
      mapProduct(world, `gid://shopify/Product/${index}`, `prod-${index}`)
    }

    const memberPages: Record<string, unknown> = {
      // Follow-up page one.
      'm-1': {
        pageInfo: { hasNextPage: true, endCursor: 'm-2' },
        edges: [{ node: { id: 'gid://shopify/Product/2' } }],
      },
      // Follow-up page two, the last.
      'm-2': {
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [{ node: { id: 'gid://shopify/Product/3' } }],
      },
    }
    const memberQueryCalls: (string | null)[] = []

    const client = makeClient((query, variables) => {
      if (query.includes('SyncShopifyCollectionsPage')) {
        return {
          collections: {
            edges: [
              {
                node: {
                  id: 'gid://shopify/Collection/1',
                  title: 'Everything',
                  handle: 'everything',
                  descriptionHtml: '<p>Everything</p>',
                  updatedAt: '2026-07-19T10:00:00Z',
                  sources: [],
                  products: {
                    pageInfo: { hasNextPage: true, endCursor: 'm-1' },
                    edges: [{ node: { id: 'gid://shopify/Product/1' } }],
                  },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }
      }
      if (query.includes('SyncShopifyCollectionMembers')) {
        memberQueryCalls.push(variables.after as string)
        return { collection: { products: memberPages[variables.after as string] } }
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`)
    })

    const adapter = createShopifyCollectionsAdapter({
      createClient: () => client,
      createRunContext: async () => world.runContext,
    })

    const cursor = JSON.stringify({ v: 1, kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' })
    const batches = await drain(adapter.streamImport!(streamInput({ cursor })))
    const item = batches.flatMap((batch) => batch.items)[0]

    // Both follow-up pages were fetched, in order.
    expect(memberQueryCalls).toEqual(['m-1', 'm-2'])
    expect(item.data.memberCount).toBe(3)
    // All three members landed — the inline page plus both follow-up pages.
    expect([...world.assignments.keys()].sort()).toEqual(['prod-1', 'prod-2', 'prod-3'])
  })

  it('reports a member list it could not finish reading as incomplete', async () => {
    // `hasNextPage` with no cursor to follow: there is no honest way to continue, so the collection
    // must be marked truncated rather than stopping quietly and looking complete.
    const world = makeWorld()
    mapProduct(world, 'gid://shopify/Product/1', 'prod-1')

    const client = makeClient((query) => {
      if (query.includes('SyncShopifyCollectionsPage')) {
        return {
          collections: {
            edges: [
              {
                node: {
                  id: 'gid://shopify/Collection/1',
                  title: 'Everything',
                  handle: 'everything',
                  descriptionHtml: '<p>Everything</p>',
                  updatedAt: '2026-07-19T10:00:00Z',
                  sources: [],
                  products: {
                    pageInfo: { hasNextPage: true, endCursor: null },
                    edges: [{ node: { id: 'gid://shopify/Product/1' } }],
                  },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`)
    })

    const adapter = createShopifyCollectionsAdapter({
      createClient: () => client,
      createRunContext: async () => world.runContext,
    })

    const cursor = JSON.stringify({ v: 1, kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' })
    const item = (await drain(adapter.streamImport!(streamInput({ cursor })))).flatMap((batch) => batch.items)[0]

    expect(item.data.membershipComplete).toBe(false)
    expect(item.data.membershipReconciled).toBe(false)
    // The member it did read still landed: a truncated list is fine to add from.
    expect([...world.assignments.get('prod-1')!]).toEqual(['cat-1'])
  })
})

// ── Partial bulk exports ─────────────────────────────────────────────────────────────────────

describe('a bulk export that did not finish cleanly', () => {
  it('🔴 does not reconcile from partial data even on a full run', async () => {
    // The one case where a full run holds an incomplete picture: a FAILED operation read via
    // `partialDataUrl`. Reconciling from a truncated export would delete assignments that are
    // still live upstream, and the run would report success while doing it.
    const world = makeWorld({
      products: ['prod-10'],
      assignments: { 'prod-10': ['cat-1'] },
    })
    mapProduct(world, 'gid://shopify/Product/10', 'prod-10')
    world.categories.set('cat-1', { id: 'cat-1', name: 'Summer', slug: 'summer', description: '<p>Summer</p>' })
    world.mappings.set('sync_shopify_collections|catalog_product_category|gid://shopify/Collection/1', 'cat-1')

    // The export was cut off before collection 1's member lines were written.
    const adapter = createShopifyCollectionsAdapter(
      makeBulkDeps(world, [collectionLine(1, 'Summer')], { partial: true }),
    )
    const batches = await drain(adapter.streamImport!(streamInput()))

    expect(batches.at(-1)!.items[0].data.membershipComplete).toBe(false)
    expect(batches.at(-1)!.items[0].data.membershipReconciled).toBe(false)
    expect([...world.assignments.get('prod-10')!]).toEqual(['cat-1'])
    // And the operator is told, rather than the run simply reporting success.
    expect(batches.at(-1)!.message).toContain('did not finish cleanly')
  })
})

// ── Failure containment ──────────────────────────────────────────────────────────────────────

describe('per-item failures', () => {
  it('reports a failed collection without aborting the run', async () => {
    const world = makeWorld()
    const original = world.runContext.commandBus.execute.bind(world.runContext.commandBus)
    world.runContext.commandBus.execute = async (commandId, options) => {
      const input = options.input as Record<string, unknown>
      if (commandId === 'catalog.categories.create' && input.name === 'Broken') {
        throw new Error('slug already exists for this organization')
      }
      return original(commandId, options)
    }

    const adapter = createShopifyCollectionsAdapter(
      makeBulkDeps(world, [
        collectionLine(1, 'Summer'),
        collectionLine(2, 'Broken'),
        collectionLine(3, 'New In'),
      ]),
    )

    const items = (await drain(adapter.streamImport!(streamInput()))).flatMap((batch) => batch.items)

    expect(items).toHaveLength(3)
    expect(items.map((item) => item.action)).toEqual(['create', 'failed', 'create'])

    const failed = items[1]
    // `logImportItemFailures` reads exactly these keys; an error recorded anywhere else counts as
    // failed but renders blank in the admin UI.
    expect(failed.data.errorMessage).toContain('slug already exists')
    expect(failed.data.sourceIdentifier).toBe('gid://shopify/Collection/2')
  })

  it('reports an unmappable payload rather than dropping it silently', async () => {
    const world = makeWorld()
    const adapter = createShopifyCollectionsAdapter(
      makeBulkDeps(world, [
        collectionLine(1, 'Summer'),
        // No title and no handle: nothing to name the category, and `name` is required.
        JSON.stringify({ id: 'gid://shopify/Collection/2', updatedAt: '2026-07-19T10:00:00Z' }),
      ]),
    )

    const items = (await drain(adapter.streamImport!(streamInput()))).flatMap((batch) => batch.items)
    expect(items.map((item) => item.action)).toEqual(['create', 'failed'])
    expect(items[1].data.errorMessage).toContain('could not be mapped')
  })
})

// ── Reporting ────────────────────────────────────────────────────────────────────────────────

describe('what the run reports', () => {
  it('says out loud that smart-collection rules are not preserved', async () => {
    const world = makeWorld()
    const adapter = createShopifyCollectionsAdapter(
      makeBulkDeps(world, [
        collectionLine(1, 'Smart', { sources: [{ __typename: 'CollectionConditionsSource' }] }),
      ]),
    )

    const item = (await drain(adapter.streamImport!(streamInput()))).flatMap((batch) => batch.items)[0]
    expect(item.data.hasUnpreservedSources).toBe(true)
    expect(item.data.ruleSource).toBe('sources')
    expect(item.data.membershipNote).toContain('not preserved')
  })

  it('skips an unchanged collection on a re-run instead of rewriting it', async () => {
    const world = makeWorld()
    const lines = [collectionLine(1, 'Summer')]

    await drain(createShopifyCollectionsAdapter(makeBulkDeps(world, lines)).streamImport!(streamInput()))
    world.commandCalls.length = 0

    const items = (
      await drain(createShopifyCollectionsAdapter(makeBulkDeps(world, lines)).streamImport!(streamInput()))
    ).flatMap((batch) => batch.items)

    expect(items[0].action).toBe('skip')
    expect(world.commandCalls).toHaveLength(0)
  })

  it('promotes the highest updatedAt into a cursor the next run can read', async () => {
    const world = makeWorld()
    const adapter = createShopifyCollectionsAdapter(
      makeBulkDeps(world, [
        collectionLine(1, 'Summer'),
        collectionLine(2, 'Sale', { updatedAt: '2026-07-20T09:00:00Z' }),
      ]),
    )

    const batches = await drain(adapter.streamImport!(streamInput()))
    const final = batches.at(-1)!

    expect(final.hasMore).toBe(false)
    const state = parseCursor(final.cursor)
    expect(state).toEqual({ kind: 'idle', updatedAfter: '2026-07-20T09:00:00.000Z' })
    expect(final.refreshCoverageEntityTypes).toEqual(['catalog:catalog_product_category'])
  })

  it('parks on the bulk operation id while an export is still streaming', async () => {
    const world = makeWorld()
    const adapter = createShopifyCollectionsAdapter(
      makeBulkDeps(world, [collectionLine(1, 'Summer'), collectionLine(2, 'Sale')]),
    )

    // One collection per batch, so the first batch is emitted mid-export.
    const batches = await drain(adapter.streamImport!(streamInput({ batchSize: 1 })))

    expect(batches[0].hasMore).toBe(true)
    const parked = parseCursor(batches[0].cursor)
    expect(parked?.kind).toBe('bulk')
    // A crash here resumes the same operation rather than paying for a new export.
    expect(parked).toMatchObject({ bulkOperationId: 'gid://shopify/BulkOperation/1' })
  })
})

// ── Liveness heartbeats + count accuracy ─────────────────────────────────────────────────────

describe('liveness heartbeats', () => {
  it('beats while the bulk export is still polling, before the first data batch', async () => {
    const world = makeWorld()
    mapProduct(world, 'gid://shopify/Product/10', 'prod-10')

    const poll = makeDeferred<unknown>()
    const fake = makeFakeHeartbeatClock()
    const adapter = createShopifyCollectionsAdapter({
      ...makeDeferredBulkDeps(world, [collectionLine(1, 'Summer'), memberLine(10, 1)], poll.promise),
      heartbeatClock: fake.clock,
    })

    const iterator = adapter.streamImport!(streamInput())[Symbol.asyncIterator]()

    // First pull: the poll has not resolved, so an empty heartbeat must arrive before any data.
    const firstPull = iterator.next()
    await flushAsync() // let the generator arm its heartbeat timer
    expect(fake.fireNext()).toBe(true)
    const beat = await firstPull

    expect(beat.done).toBe(false)
    expect(beat.value.items).toEqual([]) // empty — no created/updated/skipped/failed delta
    expect('processedCount' in beat.value).toBe(false) // adds 0 to the engine total
    expect(beat.value.message).toMatch(/rows scanned/)
    // The heartbeat carried the pre-export cursor unchanged (nothing to resume into mid-poll).
    expect(beat.value.cursor).toBe(serializeCursor({ kind: 'idle', updatedAfter: null }))

    // Let the poll finish; the remainder of the run imports the collection from the JSONL export.
    poll.resolve(completedBulkOperation(2))
    const rest = await drainBatches(iterator)

    const items = rest.flatMap((batch) => batch.items)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ action: 'create', externalId: 'gid://shopify/Collection/1' })
    // The whole pipeline resumed after the beat: the member landed as an assignment.
    expect([...world.assignments.get('prod-10')!]).toEqual(['cat-1'])
  })

  it('a fast-resolving bulk export yields NO heartbeat, so existing sequences are unchanged', async () => {
    const world = makeWorld()
    const fake = makeFakeHeartbeatClock()
    const batches = await drain(
      createShopifyCollectionsAdapter({
        ...makeBulkDeps(world, [collectionLine(1, 'Summer')]),
        heartbeatClock: fake.clock,
      }).streamImport!(streamInput()),
    )
    // The stubbed export settles on a microtask — long before any interval — so the timer is
    // cancelled unfired and no empty heartbeat batch enters the stream.
    const heartbeats = batches.filter((batch) => batch.items.length === 0 && /rows scanned/.test(batch.message ?? ''))
    expect(heartbeats).toHaveLength(0)
    expect(fake.fireNext()).toBe(false)
  })

  it('reports processedCount as a per-batch delta that sums to the true collection count', async () => {
    const world = makeWorld()
    const adapter = createShopifyCollectionsAdapter(
      makeBulkDeps(world, [collectionLine(1, 'Summer'), collectionLine(2, 'Sale'), collectionLine(3, 'New In')]),
    )

    // batchSize 2 over 3 collections → the backfill emits data batches of 2, then 1.
    const batches = await drain(adapter.streamImport!(streamInput({ batchSize: 2 })))

    // The engine SUMS processedCount across batches; a per-batch delta must total the real count
    // exactly, with no triangular inflation from a running cumulative.
    const totalProcessed = batches.reduce((sum, batch) => sum + (batch.processedCount ?? 0), 0)
    expect(totalProcessed).toBe(3)

    for (const batch of batches) {
      if (batch.items.length > 0) expect(batch.processedCount).toBe(batch.items.length)
    }
  })
})
