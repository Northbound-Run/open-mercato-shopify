import type { ImportBatch, StreamImportInput } from '@open-mercato/core/modules/data_sync/lib/adapter'
import type { ShopifyClient } from '../lib/client'
import { parseCursor } from '../lib/cursor'
import { createShopifyProductsAdapter, type ProductsRuntime } from '../lib/adapters/products'
import type { EntityRow, EntityWriter, UpsertSpec, WriteOutcome } from '../lib/writer'

// The framework never loads at test runtime. The writer stub below is a faithful miniature of
// `createEntityWriter` — mapping-first resolution, a `null` update meaning skip, error containment
// — because the behaviours under test here (content-hash skips, reconciliation, per-item failure)
// are all defined by how the adapter drives that contract.
//
// A second run against the same store is modelled by building a fresh harness over the SAME row
// and mapping maps (`makeHarness(script, previous)`), which is what makes "the variant was there
// yesterday and is gone today" expressible at all.

const SCOPE = { organizationId: 'org-1', tenantId: 'tenant-1' }
const CREDENTIALS = { shopDomain: 'test.myshopify.com', clientId: 'id', clientSecret: 'secret' }

type Store = { rows: Map<string, EntityRow>; mappings: Map<string, string> }
type Harness = ReturnType<typeof makeHarness>

const storeKey = (entityType: string, externalId: string) => `${entityType}::${externalId}`

function makeWriter(store: Store) {
  const { rows, mappings } = store
  let sequence = rows.size

  const writer: EntityWriter = {
    commandContext: {} as EntityWriter['commandContext'],
    rowReader: () => async (localId) => rows.get(localId) ?? null,
    naturalKeyLookup: () => async () => null,

    async upsert(spec: UpsertSpec): Promise<WriteOutcome> {
      try {
        const mapped = mappings.get(storeKey(spec.mappingEntityType, spec.externalId))
        const existing = mapped ? rows.get(mapped) : undefined

        if (mapped && existing) {
          const update = await spec.buildUpdateInput({ localId: mapped, row: existing })
          if (update === null) {
            return { ok: true, action: 'skip', externalId: spec.externalId, localId: mapped, resolvedVia: 'mapping' }
          }
          rows.set(mapped, { ...existing, ...update, id: mapped })
          return { ok: true, action: 'update', externalId: spec.externalId, localId: mapped, resolvedVia: 'mapping' }
        }

        const input = await spec.buildCreateInput()
        const localId = `local-${++sequence}`
        rows.set(localId, { ...input, id: localId })
        mappings.set(storeKey(spec.mappingEntityType, spec.externalId), localId)
        return { ok: true, action: 'create', externalId: spec.externalId, localId, resolvedVia: 'created' }
      } catch (error) {
        return {
          ok: false,
          action: 'failed',
          externalId: spec.externalId,
          errorMessage: error instanceof Error ? error.message : String(error),
          cause: error,
        }
      }
    },
  }

  return writer
}

type ClientScript = {
  jsonl?: string
  deltaPages?: { nodes: unknown[]; hasNextPage?: boolean; endCursor?: string }[]
  currencyCode?: string | null
  extensions?: Record<string, unknown>
}

function makeClient(script: ClientScript) {
  const requests: {
    query: string
    variables: Record<string, unknown>
    headers?: Record<string, string>
  }[] = []
  let deltaPage = 0

  const client = {
    shopDomain: 'test.myshopify.com',
    apiVersion: '2026-07',
    cost: {} as ShopifyClient['cost'],
    async request<TData>(
      query: string,
      options?: { variables?: Record<string, unknown>; headers?: Record<string, string> },
    ): Promise<TData> {
      requests.push({ query, variables: options?.variables ?? {}, headers: options?.headers })

      if (query.includes('SyncShopifyShopCurrency')) {
        return { shop: { currencyCode: script.currencyCode === undefined ? 'GBP' : script.currencyCode } } as TData
      }
      if (query.includes('bulkOperationRunQuery')) {
        return {
          bulkOperationRunQuery: {
            bulkOperation: { id: 'gid://shopify/BulkOperation/7', status: 'CREATED' },
            userErrors: [],
          },
        } as TData
      }
      if (query.includes('SyncShopifyBulkOperation')) {
        return {
          bulkOperation: {
            id: 'gid://shopify/BulkOperation/7',
            status: 'COMPLETED',
            // A COMPLETED operation that matched nothing carries no url at all.
            url: script.jsonl ? 'https://storage.test/result.jsonl' : null,
            objectCount: 1,
          },
        } as TData
      }
      if (query.includes('SyncShopifyProductsDelta')) {
        const page = script.deltaPages?.[deltaPage++] ?? { nodes: [] }
        return {
          products: {
            pageInfo: { hasNextPage: page.hasNextPage === true, endCursor: page.endCursor ?? null },
            edges: page.nodes.map((node) => ({ node })),
          },
        } as TData
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`)
    },
    async requestDetailed<TData>(
      query: string,
      options?: { variables?: Record<string, unknown>; headers?: Record<string, string> },
    ) {
      return {
        data: (await client.request(query, options)) as TData,
        // Real Shopify only fills `search[].warnings` when the request carried the debug header;
        // the header assertion below is what stops us relying on a check that would never fire.
        extensions: script.extensions,
      }
    },
  } as unknown as ShopifyClient

  return { client, requests }
}

/** `previous` continues an earlier run against the same store. Omit it for a fresh install. */
function makeHarness(script: ClientScript = {}, previous?: { store: Store }) {
  const store: Store = previous?.store ?? { rows: new Map(), mappings: new Map() }
  const writer = makeWriter(store)
  const { client, requests } = makeClient(script)
  const priceKinds = new Map<string, EntityRow>([
    ['regular', { id: 'kind-regular' }],
    ['sale', { id: 'kind-sale' }],
  ])
  const calls = {
    listOwnedLocalIds: 0,
    findVariantsByProductId: [] as string[],
    execute: [] as { commandId: string; input: Record<string, unknown> }[],
  }

  const runtime: ProductsRuntime = {
    writer,
    mapping: {
      async lookupLocalId(_integrationId, entityType, externalId) {
        return store.mappings.get(storeKey(entityType, externalId)) ?? null
      },
      async storeExternalIdMapping(_integrationId, entityType, localId, externalId) {
        store.mappings.set(storeKey(entityType, externalId), localId)
        return {}
      },
      async lookupExternalId(_integrationId, entityType, localId) {
        const prefix = `${entityType}::`
        for (const [key, value] of store.mappings) {
          if (value === localId && key.startsWith(prefix)) return key.slice(prefix.length)
        }
        return null
      },
      async deleteExternalIdMapping(_integrationId, entityType, localId) {
        const prefix = `${entityType}::`
        for (const [key, value] of store.mappings) {
          if (value === localId && key.startsWith(prefix)) {
            store.mappings.delete(key)
            return true
          }
        }
        return false
      },
    },
    readProduct: async (id) => store.rows.get(id) ?? null,
    readVariant: async (id) => store.rows.get(id) ?? null,
    readPrice: async (id) => store.rows.get(id) ?? null,
    findProductByHandle: async () => null,
    findVariantBySku: async () => null,
    findPriceKindByCode: async (code) => priceKinds.get(code) ?? null,
    findVariantsByProductId: async (productLocalId) => {
      calls.findVariantsByProductId.push(productLocalId)
      return [...store.rows.values()].filter((row) => row.productId === productLocalId)
    },
    listOwnedLocalIds: async (entityType) => {
      calls.listOwnedLocalIds += 1
      const prefix = `${entityType}::`
      return [...store.mappings.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v)
    },
    execute: async (commandId, input) => {
      calls.execute.push({ commandId, input })
      // The real bus removes the row; modelling that is what makes the sale-ended assertions
      // about the surviving price set meaningful rather than circular.
      if (commandId === 'catalog.prices.delete') store.rows.delete(input.id as string)
    },
  }

  const adapter = createShopifyProductsAdapter({
    createClient: () => client,
    createRuntime: () => runtime,
    bulkOptions: {
      sleep: async () => {},
      fetchImpl: async () => new Response(script.jsonl ?? '') as unknown as Response,
    },
  })

  return { adapter, store, writer, requests, runtime, priceKinds, calls }
}

async function collect(h: Harness, over: Partial<StreamImportInput> = {}): Promise<ImportBatch[]> {
  const input: StreamImportInput = {
    entityType: 'shopify.product',
    batchSize: 50,
    credentials: CREDENTIALS,
    mapping: await h.adapter.getMapping({ entityType: 'shopify.product', scope: SCOPE }),
    scope: SCOPE,
    ...over,
  }
  const batches: ImportBatch[] = []
  for await (const batch of h.adapter.streamImport!(input)) batches.push(batch)
  return batches
}

const items = (batches: ImportBatch[]) => batches.flatMap((b) => b.items)
const actionsFor = (batches: ImportBatch[], externalId: string) =>
  items(batches).filter((i) => i.externalId === externalId).map((i) => i.action)
const localIdOf = (h: Harness, entityType: string, externalId: string) =>
  h.store.mappings.get(storeKey(entityType, externalId))!
const rowOf = (h: Harness, entityType: string, externalId: string) =>
  h.store.rows.get(localIdOf(h, entityType, externalId))!

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

const PRODUCT_1 = {
  id: 'gid://shopify/Product/1',
  title: 'Merino Beanie',
  descriptionHtml: '<p>Warm.</p>',
  handle: 'merino-beanie',
  status: 'ACTIVE',
  vendor: 'Northbound',
  productType: 'Hats',
  tags: ['winter'],
  updatedAt: '2026-07-20T10:00:00Z',
  priceRangeV2: { maxVariantPrice: { amount: '29.00', currencyCode: 'GBP' } },
}

const VARIANT_A = {
  id: 'gid://shopify/ProductVariant/11',
  title: 'Small',
  sku: 'BEANIE-S',
  price: '29.00',
  compareAtPrice: null,
  updatedAt: '2026-07-20T10:00:00Z',
  selectedOptions: [{ name: 'Size', value: 'Small' }],
}

const VARIANT_B = {
  id: 'gid://shopify/ProductVariant/12',
  title: 'Large',
  sku: 'BEANIE-L',
  price: '31.00',
  compareAtPrice: null,
  updatedAt: '2026-07-20T10:00:00Z',
  selectedOptions: [{ name: 'Size', value: 'Large' }],
}

const PRODUCT_2 = { ...PRODUCT_1, id: 'gid://shopify/Product/2', handle: 'other', title: 'Other' }

/** JSONL as a bulk export emits it: a parent line, then its children carrying `__parentId`. */
function jsonl(product: { id: string }, variants: object[]): string {
  return [
    JSON.stringify(product),
    ...variants.map((v) => JSON.stringify({ ...v, __parentId: product.id })),
  ].join('\n')
}

function delta(product: object, variants: object[], variantsHasNextPage = false) {
  return {
    ...product,
    variants: {
      pageInfo: { hasNextPage: variantsHasNextPage },
      edges: variants.map((node) => ({ node })),
    },
  }
}

const IDLE_CURSOR = JSON.stringify({ v: 1, kind: 'idle', updatedAfter: '2026-07-19T00:00:00.000Z' })

// ── Adapter identity ─────────────────────────────────────────────────────────────────────────

describe('shopify products adapter — contract', () => {
  it('declares the provider key the engine resolves it by', () => {
    const { adapter } = makeHarness()
    expect(adapter.providerKey).toBe('shopify_products')
    expect(adapter.direction).toBe('import')
    expect(adapter.supportedEntities).toEqual(['shopify.product'])
  })

  it('returns a mapping that matches on external id and never maps productType to a column', async () => {
    const { adapter } = makeHarness()
    const mapping = await adapter.getMapping({ entityType: 'shopify.product', scope: SCOPE })

    expect(mapping.matchStrategy).toBe('externalId')
    expect(mapping.fields.find((f) => f.externalField === 'productType')?.localField).toBe(
      'metadata.shopify.productType',
    )
    // ⚠ descriptionHtml, never the deprecated bodyHtml.
    const external = mapping.fields.map((f) => f.externalField)
    expect(external).toContain('descriptionHtml')
    expect(external).not.toContain('bodyHtml')
    expect(external).not.toContain('images')
  })
})

// ── Backfill ─────────────────────────────────────────────────────────────────────────────────

describe('backfill (no cursor) — bulk path', () => {
  it('runs a bulk export and writes product, variants and prices', async () => {
    const h = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A, VARIANT_B]) })
    const batches = await collect(h)

    expect(actionsFor(batches, PRODUCT_1.id)).toEqual(['create'])
    expect(actionsFor(batches, VARIANT_A.id)).toEqual(['create'])
    expect(actionsFor(batches, VARIANT_B.id)).toEqual(['create'])
    expect(actionsFor(batches, `${VARIANT_A.id}:price:regular::GBP`)).toEqual(['create'])

    expect(h.requests.some((r) => r.query.includes('bulkOperationRunQuery'))).toBe(true)
    expect(h.requests.some((r) => r.query.includes('SyncShopifyProductsDelta'))).toBe(false)
  })

  it('attaches variants to their parent product', async () => {
    const h = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A, VARIANT_B]) })
    await collect(h)

    const productId = localIdOf(h, 'catalog_product', PRODUCT_1.id)
    expect(rowOf(h, 'catalog_product_variant', VARIANT_A.id).productId).toBe(productId)
    expect(rowOf(h, 'catalog_product_variant', VARIANT_B.id).productId).toBe(productId)
  })

  it('stores the price as the exact decimal string, never a float', async () => {
    const h = makeHarness({
      jsonl: jsonl(PRODUCT_1, [{ ...VARIANT_A, price: '1.10', compareAtPrice: '2.00' }]),
    })
    await collect(h)

    const prices = [...h.store.rows.values()].filter((r) => r.priceKindId)
    expect(prices.map((p) => p.unitPriceGross).sort()).toEqual(['1.10', '2.00'])
    for (const price of prices) expect(typeof price.unitPriceGross).toBe('string')
  })

  it('files a sale so the promotional kind holds what the customer is charged', async () => {
    const h = makeHarness({
      jsonl: jsonl(PRODUCT_1, [{ ...VARIANT_A, price: '19.00', compareAtPrice: '29.00' }]),
    })
    await collect(h)

    const byKind = new Map(
      [...h.store.rows.values()].filter((r) => r.priceKindId).map((r) => [r.priceKindId, r.unitPriceGross]),
    )
    expect(byKind.get('kind-regular')).toBe('29.00')
    expect(byKind.get('kind-sale')).toBe('19.00')
  })

  it('promotes the highest updatedAt into the cursor so the next run is incremental', async () => {
    const h = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) })
    const batches = await collect(h)

    expect(parseCursor(batches[batches.length - 1]!.cursor)).toEqual({
      kind: 'idle',
      updatedAfter: '2026-07-20T10:00:00.000Z',
    })
  })

  it('splits into batches of batchSize and reports hasMore until the reconcile pass is done', async () => {
    const h = makeHarness({ jsonl: [jsonl(PRODUCT_1, [VARIANT_A]), jsonl(PRODUCT_2, [])].join('\n') })
    const batches = await collect(h, { batchSize: 1 })

    expect(batches.map((b) => b.batchIndex)).toEqual([0, 1, 2, 3])
    // Everything before the last says there is more to come — the reconcile pass is still due.
    expect(batches.map((b) => b.hasMore)).toEqual([true, true, true, false])
    expect(batches[batches.length - 1]!.message).toMatch(/Reconciling/)
  })

  it('yields a promoted cursor even when the export matched nothing', async () => {
    const h = makeHarness({})
    const batches = await collect(h)

    expect(items(batches)).toEqual([])
    expect(parseCursor(batches[0]!.cursor)).toEqual({ kind: 'idle', updatedAfter: null })
  })

  it('skips an unchanged product, variant and price on a second identical run', async () => {
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) })
    await collect(first)

    const second = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) }, first)
    const batches = await collect(second)

    expect(actionsFor(batches, PRODUCT_1.id)).toEqual(['skip'])
    expect(actionsFor(batches, VARIANT_A.id)).toEqual(['skip'])
    expect(actionsFor(batches, `${VARIANT_A.id}:price:regular::GBP`)).toEqual(['skip'])
  })

  it('updates a product whose title changed upstream', async () => {
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) })
    await collect(first)

    const renamed = { ...PRODUCT_1, title: 'Merino Beanie II' }
    const second = makeHarness({ jsonl: jsonl(renamed, [VARIANT_A]) }, first)
    const batches = await collect(second)

    expect(actionsFor(batches, PRODUCT_1.id)).toEqual(['update'])
    expect(rowOf(second, 'catalog_product', PRODUCT_1.id).title).toBe('Merino Beanie II')
  })
})

// ── Delta ────────────────────────────────────────────────────────────────────────────────────

describe('delta (cursor present) — paged path', () => {
  it('pages with the updated_at filter and the matching sort key', async () => {
    const h = makeHarness({ deltaPages: [{ nodes: [delta(PRODUCT_1, [VARIANT_A])] }] })
    await collect(h, { cursor: IDLE_CURSOR })

    const request = h.requests.find((r) => r.query.includes('SyncShopifyProductsDelta'))!
    expect(request.variables.query).toBe("updated_at:>'2026-07-19T00:00:00.000Z'")
    // Without the matching sortKey a large collection times out instead of paginating.
    expect(request.query).toContain('sortKey: UPDATED_AT')
    expect(h.requests.some((r) => r.query.includes('bulkOperationRunQuery'))).toBe(false)
  })

  it('writes through the same path as a backfill', async () => {
    const h = makeHarness({ deltaPages: [{ nodes: [delta(PRODUCT_1, [VARIANT_A])] }] })
    const batches = await collect(h, { cursor: IDLE_CURSOR })

    expect(actionsFor(batches, PRODUCT_1.id)).toEqual(['create'])
    expect(actionsFor(batches, VARIANT_A.id)).toEqual(['create'])
  })

  it('follows endCursor across pages and emits a resumable cursor for each', async () => {
    const h = makeHarness({
      deltaPages: [
        { nodes: [delta(PRODUCT_1, [VARIANT_A])], hasNextPage: true, endCursor: 'CUR-1' },
        { nodes: [delta(PRODUCT_2, [])] },
      ],
    })
    const batches = await collect(h, { cursor: IDLE_CURSOR })

    expect(batches).toHaveLength(2)
    expect(batches.map((b) => b.hasMore)).toEqual([true, false])
    expect(parseCursor(batches[0]!.cursor)).toMatchObject({ kind: 'paging', endCursor: 'CUR-1' })
    expect(parseCursor(batches[1]!.cursor)).toMatchObject({ kind: 'idle' })

    const requests = h.requests.filter((r) => r.query.includes('SyncShopifyProductsDelta'))
    expect(requests.map((r) => r.variables.after)).toEqual([null, 'CUR-1'])
  })

  it('resumes mid-pagination from a paging cursor', async () => {
    const h = makeHarness({ deltaPages: [{ nodes: [] }] })
    await collect(h, {
      cursor: JSON.stringify({
        v: 1,
        kind: 'paging',
        endCursor: 'CUR-9',
        pagesFetched: 3,
        updatedAfter: '2026-07-19T00:00:00.000Z',
        maxUpdatedAt: null,
      }),
    })

    expect(h.requests.find((r) => r.query.includes('SyncShopifyProductsDelta'))!.variables.after).toBe('CUR-9')
  })

  it('fails loudly when Shopify ignores the search filter and returns everything', async () => {
    // "If you specify an invalid field, then the query is ignored and all results are returned."
    // The only visible symptom is a record older than the window we asked for.
    const stale = { ...PRODUCT_1, updatedAt: '2020-01-01T00:00:00Z' }
    const h = makeHarness({ deltaPages: [{ nodes: [delta(stale, [])] }] })

    await expect(collect(h, { cursor: IDLE_CURSOR })).rejects.toThrow(/search filter was ignored/)
  })

  it('keeps the watermark monotonic across an empty delta run', async () => {
    const h = makeHarness({ deltaPages: [{ nodes: [] }] })
    const batches = await collect(h, { cursor: IDLE_CURSOR })

    expect(parseCursor(batches[0]!.cursor)).toEqual({
      kind: 'idle',
      updatedAfter: '2026-07-19T00:00:00.000Z',
    })
  })
})

// ── 🔴 Per-product variant reconciliation ────────────────────────────────────────────────────

describe('per-product variant reconciliation', () => {
  it('deactivates exactly the variant that vanished, leaving siblings and the parent alone', async () => {
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A, VARIANT_B]) })
    await collect(first)

    // Shopify sends no deletion signal — B is simply absent from a product we already hold in full.
    const second = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) }, first)
    const batches = await collect(second)

    expect(rowOf(second, 'catalog_product_variant', VARIANT_B.id).isActive).toBe(false)
    expect(rowOf(second, 'catalog_product_variant', VARIANT_A.id).isActive).toBe(true)
    expect(rowOf(second, 'catalog_product', PRODUCT_1.id).isActive).toBe(true)

    expect(items(batches).find((i) => i.externalId === VARIANT_B.id)).toMatchObject({
      action: 'update',
      data: { reason: 'absent_from_shopify_payload' },
    })
  })

  it('reconciles on a delta run too — a product we are given comes with all its variants', async () => {
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A, VARIANT_B]) })
    await collect(first)

    const second = makeHarness({ deltaPages: [{ nodes: [delta(PRODUCT_1, [VARIANT_A])] }] }, first)
    await collect(second, { cursor: IDLE_CURSOR })

    expect(rowOf(second, 'catalog_product_variant', VARIANT_B.id).isActive).toBe(false)
  })

  it('🔴 does NOT reconcile when the variant connection was truncated', async () => {
    // A truncated page is indistinguishable from a deleted variant set. Acting on it would
    // deactivate every variant past the page boundary of a 2048-variant product.
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A, VARIANT_B]) })
    await collect(first)

    const second = makeHarness(
      { deltaPages: [{ nodes: [delta(PRODUCT_1, [VARIANT_A], /* variantsHasNextPage */ true)] }] },
      first,
    )
    await collect(second, { cursor: IDLE_CURSOR })

    expect(rowOf(second, 'catalog_product_variant', VARIANT_B.id).isActive).toBe(true)
    expect(second.calls.findVariantsByProductId).toEqual([])
  })

  it('never touches a variant this integration does not own', async () => {
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) })
    await collect(first)

    // A variant an operator added by hand: live, on the same product, with no external-id mapping.
    const productId = localIdOf(first, 'catalog_product', PRODUCT_1.id)
    first.store.rows.set('hand-made', { id: 'hand-made', productId, isActive: true })

    const second = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) }, first)
    const batches = await collect(second)

    expect(second.store.rows.get('hand-made')!.isActive).toBe(true)
    // Not merely left intact — never written to at all. Without this the test would still pass
    // when the gate is removed, because the refuse-to-recreate guard would turn the attempt into
    // a `failed` item instead of a mutation.
    expect(items(batches).map((i) => i.action)).not.toContain('failed')
    expect(items(batches).some((i) => i.data.reason === 'absent_from_shopify_payload')).toBe(false)
  })

  it('reports a skip rather than rewriting an already-deactivated variant every run', async () => {
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A, VARIANT_B]) })
    await collect(first)

    const second = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) }, first)
    await collect(second)

    const third = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) }, second)
    expect(actionsFor(await collect(third), VARIANT_B.id)).toEqual(['skip'])
  })

  it('leaves a product with no variants at all alone', async () => {
    const h = makeHarness({ jsonl: jsonl(PRODUCT_1, []) })
    const batches = await collect(h)

    expect(actionsFor(batches, PRODUCT_1.id)).toEqual(['create'])
    expect(rowOf(h, 'catalog_product', PRODUCT_1.id).isActive).toBe(true)
  })
})

// ── 🔴 The catastrophic case ─────────────────────────────────────────────────────────────────

describe('full-sync product reconciliation', () => {
  it('deactivates a product a FULL run never saw', async () => {
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) })
    await collect(first)

    // The catalog now reports a different product entirely; product 1 is gone upstream.
    const second = makeHarness({ jsonl: jsonl(PRODUCT_2, []) }, first)
    const batches = await collect(second)

    expect(rowOf(second, 'catalog_product', PRODUCT_1.id).isActive).toBe(false)
    expect(items(batches).find((i) => i.externalId === PRODUCT_1.id)).toMatchObject({
      data: { reason: 'absent_from_shopify_full_sync' },
    })
  })

  it('🔴 performs NO reconciliation on a delta run', async () => {
    // A delta legitimately sees only what changed. Reconciling against it would soft-delete the
    // entire catalog — the single most destructive thing this adapter could do.
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) })
    await collect(first)

    const second = makeHarness({ deltaPages: [{ nodes: [delta(PRODUCT_2, [])] }] }, first)
    const batches = await collect(second, { cursor: IDLE_CURSOR })

    expect(rowOf(second, 'catalog_product', PRODUCT_1.id).isActive).toBe(true)
    // The sweep is not merely harmless here — it is never even started.
    expect(second.calls.listOwnedLocalIds).toBe(0)
    expect(batches.some((b) => b.message)).toBe(false)
  })

  it('🔴 treats a malformed cursor as a delta, not as a licence to reconcile', async () => {
    // parseCursor returns null for junk. Deriving the guard from the parsed state rather than from
    // the raw `input.cursor` would let that null masquerade as a full run.
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) })
    await collect(first)

    const second = makeHarness({ deltaPages: [{ nodes: [] }] }, first)
    await collect(second, { cursor: 'not-json-at-all' })

    expect(rowOf(second, 'catalog_product', PRODUCT_1.id).isActive).toBe(true)
    expect(second.calls.listOwnedLocalIds).toBe(0)
  })

  it('reports a skip for a product already deactivated by an earlier sweep', async () => {
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) })
    await collect(first)

    const second = makeHarness({ jsonl: jsonl(PRODUCT_2, []) }, first)
    await collect(second)

    const third = makeHarness({ jsonl: jsonl(PRODUCT_2, []) }, second)
    expect(actionsFor(await collect(third), PRODUCT_1.id)).toEqual(['skip'])
  })
})

// ── 🔴 Sale lifecycle ────────────────────────────────────────────────────────────────────────

/** Every surviving price row for a variant, as `{ kindId: amount }`. */
function pricesFor(h: Harness, variantExternalId: string): Record<string, unknown> {
  const variantLocalId = localIdOf(h, 'catalog_product_variant', variantExternalId)
  return Object.fromEntries(
    [...h.store.rows.values()]
      .filter((row) => row.priceKindId && row.variantId === variantLocalId)
      .map((row) => [row.priceKindId as string, row.unitPriceGross]),
  )
}

const ON_SALE = { ...VARIANT_A, price: '19.00', compareAtPrice: '29.00' }
const OFF_SALE = { ...VARIANT_A, price: '29.00', compareAtPrice: null }

describe('sale lifecycle — on sale, then off sale', () => {
  it('🔴 removes the sale row when the sale ends, leaving only the regular price', async () => {
    // The bug this closes: `selectBestPrice` scores a promotional kind ABOVE a regular one, so a
    // sale row left behind keeps winning and the customer keeps paying the sale price forever.
    // Nothing surfaces it — the run reports success and the regular price is updated correctly.
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [ON_SALE]) })
    await collect(first)

    expect(pricesFor(first, VARIANT_A.id)).toEqual({ 'kind-regular': '29.00', 'kind-sale': '19.00' })

    const second = makeHarness({ jsonl: jsonl(PRODUCT_1, [OFF_SALE]) }, first)
    const batches = await collect(second)

    // Exactly one row survives, it is the regular kind, and it holds the post-sale price. That is
    // the precondition `selectBestPrice` resolves against — with no promotional row in the set it
    // has nothing to prefer, so the charged price is 29.00.
    expect(pricesFor(second, VARIANT_A.id)).toEqual({ 'kind-regular': '29.00' })

    expect(second.calls.execute).toEqual([
      {
        commandId: 'catalog.prices.delete',
        input: { id: expect.any(String), organizationId: 'org-1', tenantId: 'tenant-1' },
      },
    ])
    expect(items(batches).find((i) => i.externalId.endsWith(':price:sale::GBP'))).toMatchObject({
      action: 'update',
      data: { reason: 'price_kind_no_longer_offered' },
    })
  })

  it('drops the mapping too, so the next run cannot resurrect the row', async () => {
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [ON_SALE]) })
    await collect(first)

    const second = makeHarness({ jsonl: jsonl(PRODUCT_1, [OFF_SALE]) }, first)
    await collect(second)

    // A surviving mapping would route the next run into the update branch against a deleted row.
    expect([...second.store.mappings.keys()]).not.toContain(
      `catalog_product_price::${VARIANT_A.id}:price:sale::GBP`,
    )

    const third = makeHarness({ jsonl: jsonl(PRODUCT_1, [OFF_SALE]) }, second)
    await collect(third)
    expect(pricesFor(third, VARIANT_A.id)).toEqual({ 'kind-regular': '29.00' })
    // Nothing left to delete — the cleanup does not repeat on every subsequent run.
    expect(third.calls.execute).toEqual([])
  })

  it('restores the sale row when the product goes on sale again', async () => {
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [ON_SALE]) })
    await collect(first)
    const second = makeHarness({ jsonl: jsonl(PRODUCT_1, [OFF_SALE]) }, first)
    await collect(second)

    const third = makeHarness({ jsonl: jsonl(PRODUCT_1, [ON_SALE]) }, second)
    await collect(third)

    expect(pricesFor(third, VARIANT_A.id)).toEqual({ 'kind-regular': '29.00', 'kind-sale': '19.00' })
  })

  it('deletes nothing while a sale is still running', async () => {
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [ON_SALE]) })
    await collect(first)

    const second = makeHarness({ jsonl: jsonl(PRODUCT_1, [ON_SALE]) }, first)
    await collect(second)

    expect(second.calls.execute).toEqual([])
    expect(pricesFor(second, VARIANT_A.id)).toEqual({ 'kind-regular': '29.00', 'kind-sale': '19.00' })
  })

  it('never deletes a price row this integration does not own', async () => {
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [ON_SALE]) })
    await collect(first)

    // A promotional price an operator set by hand: no external-id mapping, so invisible to us.
    const variantLocalId = localIdOf(first, 'catalog_product_variant', VARIANT_A.id)
    first.store.rows.set('hand-priced', {
      id: 'hand-priced',
      variantId: variantLocalId,
      priceKindId: 'kind-manual',
      unitPriceGross: '12.00',
    })

    const second = makeHarness({ jsonl: jsonl(PRODUCT_1, [OFF_SALE]) }, first)
    await collect(second)

    expect(second.store.rows.get('hand-priced')).toMatchObject({ unitPriceGross: '12.00' })
    expect(second.calls.execute.map((c) => c.input.id)).not.toContain('hand-priced')
  })

  it('🔴 deletes nothing when the price could not be read at all', async () => {
    // An unparseable price is indistinguishable from "no price" here. Treating that as "remove
    // everything" would turn a mapping bug of ours into silent data loss.
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [ON_SALE]) })
    await collect(first)

    const broken = { ...VARIANT_A, price: 'not-a-number', compareAtPrice: null }
    const second = makeHarness({ jsonl: jsonl(PRODUCT_1, [broken]) }, first)
    await collect(second)

    expect(second.calls.execute).toEqual([])
    expect(pricesFor(second, VARIANT_A.id)).toEqual({ 'kind-regular': '29.00', 'kind-sale': '19.00' })
  })

  it('reports a failed delete without aborting the run', async () => {
    const first = makeHarness({ jsonl: jsonl(PRODUCT_1, [ON_SALE]) })
    await collect(first)

    const second = makeHarness({ jsonl: jsonl(PRODUCT_1, [OFF_SALE]) }, first)
    second.runtime.execute = async () => {
      throw new Error('price delete rejected')
    }
    const batches = await collect(second)

    expect(items(batches).find((i) => i.externalId.endsWith(':price:sale::GBP'))).toMatchObject({
      action: 'failed',
      data: { errorMessage: 'price delete rejected' },
    })
    // The rest of the run still landed. The regular row reports `skip` rather than `update`
    // because its amount genuinely did not move — 29.00 was the list price during the sale and is
    // the plain price after it. Only the sale row needed removing, which is the whole point.
    expect(actionsFor(batches, `${VARIANT_A.id}:price:regular::GBP`)).toEqual(['skip'])
  })
})

// ── R-13 second belt ─────────────────────────────────────────────────────────────────────────

describe('search warnings', () => {
  it('fails when Shopify reports that it did not understand the search query', async () => {
    const h = makeHarness({
      deltaPages: [{ nodes: [delta(PRODUCT_1, [VARIANT_A])] }],
      extensions: { search: [{ warnings: [{ message: 'Unknown field updatd_at' }] }] },
    })

    await expect(collect(h, { cursor: IDLE_CURSOR })).rejects.toThrow(/search warnings/)
  })

  it('asks Shopify to report them — without the header the check is silently dead', async () => {
    const h = makeHarness({ deltaPages: [{ nodes: [delta(PRODUCT_1, [VARIANT_A])] }] })
    await collect(h, { cursor: IDLE_CURSOR })

    const request = h.requests.find((r) => r.query.includes('SyncShopifyProductsDelta'))!
    expect(request.headers).toMatchObject({ 'Shopify-Search-Query-Debug': '1' })
  })

  it('passes cleanly when Shopify reports no warnings', async () => {
    const h = makeHarness({
      deltaPages: [{ nodes: [delta(PRODUCT_1, [VARIANT_A])] }],
      extensions: { search: [{ warnings: [] }] },
    })
    await expect(collect(h, { cursor: IDLE_CURSOR })).resolves.toBeDefined()
  })
})

// ── Failure handling ─────────────────────────────────────────────────────────────────────────

describe('failure handling', () => {
  it('fails the run loudly when a price kind is missing, naming it', async () => {
    // Akeneo `continue`s here, producing a run that reports success and writes zero prices.
    const h = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) })
    h.priceKinds.delete('sale')

    await expect(collect(h)).rejects.toThrow(/CatalogPriceKind 'sale' does not exist/)
  })

  it('checks price kinds before writing anything, not per variant', async () => {
    const h = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) })
    h.priceKinds.delete('regular')

    await expect(collect(h)).rejects.toThrow(/regular/)
    expect(h.store.rows.size).toBe(0)
  })

  it('reports a per-item failure and keeps importing the rest of the batch', async () => {
    const untitled = { ...PRODUCT_1, id: 'gid://shopify/Product/3', title: '', handle: 'untitled' }
    const h = makeHarness({ jsonl: [jsonl(untitled, []), jsonl(PRODUCT_1, [VARIANT_A])].join('\n') })
    const batches = await collect(h)

    const failure = items(batches).find((i) => i.action === 'failed')!
    expect(failure.externalId).toBe(untitled.id)
    // The exact shape `logImportItemFailures` reads — anything else counts as failed but shows blank.
    expect(failure.data).toMatchObject({
      sourceIdentifier: untitled.id,
      errorMessage: expect.stringContaining('no title'),
    })

    // The run continued: the healthy product still landed.
    expect(actionsFor(batches, PRODUCT_1.id)).toEqual(['create'])
  })

  it('skips a variant whose write failed without abandoning its siblings', async () => {
    const h = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A, VARIANT_B]) })
    const real = h.writer.upsert.bind(h.writer)
    h.writer.upsert = async (spec) =>
      spec.externalId === VARIANT_A.id
        ? { ok: false, action: 'failed', externalId: spec.externalId, errorMessage: 'variant rejected', cause: null }
        : real(spec)

    const batches = await collect(h)

    expect(actionsFor(batches, VARIANT_A.id)).toEqual(['failed'])
    expect(actionsFor(batches, VARIANT_B.id)).toEqual(['create'])
    // No price rows for the failed variant: there is no local id to hang them off.
    expect(items(batches).some((i) => i.externalId.startsWith(`${VARIANT_A.id}:price`))).toBe(false)
  })

  it('writes no variants when the product itself failed', async () => {
    const h = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]) })
    const real = h.writer.upsert.bind(h.writer)
    h.writer.upsert = async (spec) =>
      spec.externalId === PRODUCT_1.id
        ? { ok: false, action: 'failed', externalId: spec.externalId, errorMessage: 'product rejected', cause: null }
        : real(spec)

    const batches = await collect(h)

    expect(actionsFor(batches, PRODUCT_1.id)).toEqual(['failed'])
    expect(items(batches).some((i) => i.externalId === VARIANT_A.id)).toBe(false)
  })

  it('refuses to guess a currency when the shop reports none', async () => {
    const h = makeHarness({ jsonl: jsonl(PRODUCT_1, [VARIANT_A]), currencyCode: null })
    await expect(collect(h)).rejects.toThrow(/refusing to guess/)
  })
})
