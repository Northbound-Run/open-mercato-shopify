import type { ImportBatch, StreamImportInput } from '@open-mercato/core/modules/data_sync/lib/adapter'
import { reassembleBulkStream, type BulkAnomaly, type BulkExport, type BulkNode } from '../lib/bulk'
import { SEARCH_DEBUG_HEADER, type ShopifyClient } from '../lib/client'
import { COMMAND, COMMAND_RESULT_KEY, ENTITY_TYPE, INTEGRATION_ID, MAPPING_ENTITY_TYPE, OM_ENTITY_ID, PROVIDER_KEY } from '../lib/constants'
import { parseCursor, serializeCursor } from '../lib/cursor'
import { createEntityWriter, type CommandBusPort, type EntityRow, type FindOnePort } from '../lib/writer'
import {
  assertDeltaWindowRespected,
  assertSearchWarningsEmpty,
  buildOrderBulkQuery,
  buildUpdatedAtFilter,
  bulkNodeToOrder,
  createOrdersAdapter,
  OrdersSyncError,
  readSearchWarnings,
  resolveOrderWindow,
  type OrderSyncLogEvent,
  type OrderSyncRuntime,
} from '../lib/adapters/orders'
import type { ShopifyMoneyBag, ShopifyOrderLine, ShopifyOrderNode } from '../lib/mappers/order'
import type { HeartbeatClock } from '../lib/heartbeat'

// The framework is stubbed but the WRITER IS REAL: the order result key (`orderId`), the
// mapping-first/natural-key resolution, and the content-hash skip all live inside the writer, so
// stubbing it away would test a fiction. The command bus returns the REAL result shape.

const SCOPE = { organizationId: 'org-1', tenantId: 'tenant-1' }
const CONTAINER = { resolve: () => undefined } as never

type CommandCall = { commandId: string; input: Record<string, unknown> }

function bag(amount: string): ShopifyMoneyBag {
  return { shopMoney: { amount, currencyCode: 'USD' }, presentmentMoney: { amount, currencyCode: 'USD' } }
}

function orderLine(over: Partial<ShopifyOrderLine> = {}): ShopifyOrderLine {
  return {
    id: 'gid://shopify/LineItem/1',
    name: 'A hat',
    sku: 'HAT-1',
    quantity: 1,
    variant: { id: 'gid://shopify/ProductVariant/1', sku: 'HAT-1' },
    originalUnitPriceSet: bag('20.00'),
    taxLines: [],
    discountAllocations: [],
    ...over,
  }
}

function orderNode(over: Partial<ShopifyOrderNode> = {}): ShopifyOrderNode {
  return {
    id: 'gid://shopify/Order/5001',
    name: '#1001',
    currencyCode: 'USD',
    taxesIncluded: false,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    updatedAt: '2026-07-18T12:00:00Z',
    processedAt: '2026-07-15T09:00:00Z',
    customer: { id: 'gid://shopify/Customer/9001' },
    lineItems: { nodes: [orderLine()] },
    totalPriceSet: bag('20.00'),
    subtotalPriceSet: bag('20.00'),
    totalTaxSet: bag('0'),
    totalDiscountsSet: bag('0'),
    totalShippingPriceSet: bag('0'),
    ...over,
  }
}

/** Rebuild the JSONL reassembly shape `lib/bulk.ts` hands the adapter for the backfill path. */
function toOrderBulkNode(node: ShopifyOrderNode): BulkNode {
  const { lineItems, shippingLines, ...fields } = node
  const lineChildren = (lineItems?.nodes ?? [])
    .filter((l): l is NonNullable<typeof l> => l != null)
    .map((l) => {
      const { id, ...rest } = l
      return { id: id as string, type: 'LineItem', fields: rest as Record<string, unknown>, children: {} }
    })
  const shipChildren = (shippingLines?.nodes ?? [])
    .filter((sl): sl is NonNullable<typeof sl> => sl != null)
    .map((sl, i) => ({ id: `gid://shopify/ShippingLine/${i}`, type: 'ShippingLine', fields: sl as Record<string, unknown>, children: {} }))
  const children: Record<string, BulkNode[]> = {}
  if (lineChildren.length > 0) children.LineItem = lineChildren
  if (shipChildren.length > 0) children.ShippingLine = shipChildren
  return { id: node.id, type: 'Order', fields: fields as Record<string, unknown>, children }
}

type HarnessOptions = {
  failCommand?: (call: CommandCall) => boolean
  /** gid → local id, for variant resolution under the products integration. */
  variants?: Record<string, string>
  /** sku → local id, the variant fallback. */
  variantsBySku?: Record<string, string>
  /** customer gid → local id, under the customers integration. */
  customers?: Record<string, string>
  /** Local ids this integration owns, for reconciliation. */
  ownedOrders?: string[]
  /** local id → external gid, the reconciliation ownership gate. */
  ownership?: Record<string, string>
  resolveStatus?: boolean
}

function makeHarness(options: HarnessOptions = {}) {
  const commandCalls: CommandCall[] = []
  const rows = new Map<string, EntityRow>()
  const mappings = new Map<string, string>()
  let seq = 0
  const key = (entityType: string, externalId: string) => `${entityType}::${externalId}`

  const commandBus: CommandBusPort = {
    async execute(commandId, executeOptions) {
      const input = executeOptions.input as Record<string, unknown>
      const call = { commandId, input }
      commandCalls.push(call)
      if (options.failCommand?.(call)) throw new Error(`command ${commandId} failed`)

      if (commandId === COMMAND.orderCreate) {
        const id = `order-${(seq += 1)}`
        rows.set(id, { id, metadata: input.metadata, externalReference: input.externalReference as string })
        return { result: { orderId: id } }
      }
      if (commandId === COMMAND.orderUpdate) {
        const id = input.id as string
        rows.set(id, { ...(rows.get(id) ?? { id }), metadata: input.metadata })
        return { result: { orderId: id } }
      }
      if (commandId === COMMAND.orderDelete) return { result: { orderId: input.id } }
      if (commandId === COMMAND.paymentCreate) return { result: { paymentId: `pay-${(seq += 1)}` } }
      if (commandId === COMMAND.shipmentCreate) return { result: { shipmentId: `ship-${(seq += 1)}` } }
      return { result: { id: (input.id as string) ?? 'unknown' } }
    },
  }

  const findOne: FindOnePort = async (_entity, where) => {
    if (where.deletedAt !== null) return null
    if (typeof where.id === 'string') return rows.get(where.id) ?? null
    if (typeof where.externalReference === 'string') {
      for (const row of rows.values()) if (row.externalReference === where.externalReference) return row
    }
    return null
  }

  const externalIdMapping = {
    async lookupLocalId(_integrationId: string, entityType: string, externalId: string) {
      return mappings.get(key(entityType, externalId)) ?? null
    },
    async storeExternalIdMapping(_integrationId: string, entityType: string, localId: string, externalId: string) {
      mappings.set(key(entityType, externalId), localId)
      return {}
    },
  }

  const writer = createEntityWriter({
    container: CONTAINER,
    scope: SCOPE,
    integrationId: INTEGRATION_ID.orders,
    commandBus,
    externalIdMapping,
    findOne,
  })

  const runtime: OrderSyncRuntime = {
    client: { request: async () => ({}) } as unknown as ShopifyClient,
    writer,
    mapping: {
      ...externalIdMapping,
      async lookupExternalId(_integrationId, _entityType, localId) {
        return options.ownership?.[localId] ?? null
      },
    },
    readOrder: async (localId) => findOne('SalesOrder', { id: localId, deletedAt: null }, undefined, SCOPE),
    findOrderByExternalReference: async (ref) => findOne('SalesOrder', { externalReference: ref, deletedAt: null }, undefined, SCOPE),
    resolveVariantLocalId: async (variantExternalId, sku) => {
      if (variantExternalId && options.variants?.[variantExternalId]) return options.variants[variantExternalId]
      if (sku && options.variantsBySku?.[sku]) return options.variantsBySku[sku]
      return null
    },
    resolveCustomerLocalId: async (gid) => options.customers?.[gid] ?? null,
    execute: async (commandId, input) => commandBus.execute(commandId, { input, ctx: writer.commandContext }),
    listOwnedOrderIds: async () => options.ownedOrders ?? [],
    ...(options.resolveStatus
      ? {
          resolveStatusEntryIds: async () => ({
            paymentStatusEntryId: '11111111-1111-1111-1111-111111111111',
            fulfillmentStatusEntryId: '22222222-2222-2222-2222-222222222222',
          }),
        }
      : {}),
  }

  return { runtime, commandCalls, rows, mappings }
}

function bulkExportOf(nodes: BulkNode[]): (client: ShopifyClient, query: string) => Promise<BulkExport> {
  return async () => ({
    operation: {
      id: 'gid://shopify/BulkOperation/1',
      status: 'COMPLETED',
      errorCode: null,
      createdAt: null,
      completedAt: null,
      objectCount: nodes.length,
      fileSize: null,
      url: 'https://example.invalid/result.jsonl',
      partialDataUrl: null,
    },
    partial: false,
    nodes: (async function* () {
      for (const node of nodes) yield node
    })(),
  })
}

function importInput(over: Partial<StreamImportInput> = {}): StreamImportInput {
  return {
    entityType: ENTITY_TYPE.order,
    batchSize: 25,
    credentials: {},
    mapping: { entityType: ENTITY_TYPE.order, fields: [], matchStrategy: 'externalId' },
    scope: SCOPE,
    ...over,
  }
}

async function collect(iterable: AsyncIterable<ImportBatch>): Promise<ImportBatch[]> {
  const batches: ImportBatch[] = []
  for await (const batch of iterable) batches.push(batch)
  return batches
}

function runBackfill(
  harness: ReturnType<typeof makeHarness>,
  nodes: ShopifyOrderNode[],
  input: Partial<StreamImportInput> = {},
  log?: (e: OrderSyncLogEvent) => void,
): Promise<ImportBatch[]> {
  const adapter = createOrdersAdapter({
    createRuntime: async () => harness.runtime,
    bulkExport: bulkExportOf(nodes.map(toOrderBulkNode)),
    log,
  })
  return collect(adapter.streamImport!(importInput(input)))
}

/** Delta harness: stubs `requestDetailed` (the R-13 guard needs the `extensions` envelope). */
function deltaHarness(pages: ShopifyOrderNode[][], opts: { extensions?: Record<string, unknown> } = {}) {
  const harness = makeHarness()
  const headers: (Record<string, string> | undefined)[] = []
  const variables: Record<string, unknown>[] = []
  let page = 0
  harness.runtime.client = {
    requestDetailed: async (_query: string, requestOptions?: { variables?: Record<string, unknown>; headers?: Record<string, string> }) => {
      headers.push(requestOptions?.headers)
      variables.push(requestOptions?.variables ?? {})
      const nodes = pages[page] ?? []
      const hasNextPage = page < pages.length - 1
      page += 1
      return {
        data: { orders: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${page}` : null } } },
        extensions: opts.extensions,
      }
    },
  } as unknown as ShopifyClient
  return { harness, headers, variables }
}

function items(batches: ImportBatch[]) {
  return batches.flatMap((b) => b.items) as { action: string; externalId: string; data: Record<string, unknown> }[]
}

// ── Heartbeat test doubles ──────────────────────────────────────────────────────────────────

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

describe('liveness heartbeats', () => {
  it('beats while the bulk export is still running, before the first data batch', async () => {
    const harness = makeHarness()
    const work = makeDeferred<BulkExport>()
    const fake = makeFakeHeartbeatClock()
    const adapter = createOrdersAdapter({
      createRuntime: async () => harness.runtime,
      // Held open until the test resolves it, so the poll phase is observably in progress.
      bulkExport: () => work.promise,
      heartbeatClock: fake.clock,
    })

    const iterator = adapter.streamImport!(importInput())[Symbol.asyncIterator]()

    // First pull: the export has not resolved, so an empty heartbeat must arrive first.
    const firstPull = iterator.next()
    await flushAsync() // let the generator arm its heartbeat timer
    expect(fake.fireNext()).toBe(true)
    const beat = await firstPull

    expect(beat.done).toBe(false)
    expect(beat.value.items).toEqual([]) // empty — no created/updated/skipped/failed delta
    expect('processedCount' in beat.value).toBe(false) // adds 0 to the engine total
    // The heartbeat carried the pre-export cursor unchanged (nothing to resume into mid-poll).
    expect(beat.value.cursor).toBe(serializeCursor({ kind: 'idle', updatedAfter: null }))

    // Let the export finish; the remainder of the run carries the real order. The stub ignores its
    // arguments, but its type declares them, so pass the client + query through.
    work.resolve(await bulkExportOf([toOrderBulkNode(orderNode())])(harness.runtime.client, buildOrderBulkQuery()))
    const rest = await drainBatches(iterator)

    const dataItems = rest.flatMap((b) => b.items) as { action: string; externalId: string }[]
    expect(dataItems).toHaveLength(1)
    expect(dataItems[0]).toMatchObject({ action: 'create', externalId: 'gid://shopify/Order/5001' })
  })

  it('a fast-resolving bulk export yields NO heartbeat, so existing sequences are unchanged', async () => {
    const harness = makeHarness()
    const fake = makeFakeHeartbeatClock()
    const batches = await collect(
      createOrdersAdapter({
        createRuntime: async () => harness.runtime,
        bulkExport: bulkExportOf([toOrderBulkNode(orderNode())]),
        heartbeatClock: fake.clock,
      }).streamImport!(importInput()),
    )
    // The stubbed export settles on a microtask — long before any interval — so the timer is
    // cancelled unfired and no empty heartbeat batch enters the stream.
    const heartbeats = batches.filter((b) => b.items.length === 0 && /rows scanned/.test(b.message ?? ''))
    expect(heartbeats).toHaveLength(0)
    expect(fake.fireNext()).toBe(false)
  })

  it('beats during the reconcile sweep, and still emits the terminal reconcile batch', async () => {
    let clock = 0
    const harness = makeHarness({
      // Three owned ids the full run did not see, so the sweep walks all of them.
      ownedOrders: ['order-a', 'order-b', 'order-c'],
      ownership: {}, // none owned → all skipped, but the sweep still walks every id
    })
    const adapter = createOrdersAdapter({
      createRuntime: async () => harness.runtime,
      bulkExport: bulkExportOf([toOrderBulkNode(orderNode())]),
      heartbeatIntervalMs: 100,
      // Advances well past the interval on every call, so each swept id is "due".
      now: () => (clock += 1_000),
    })

    // A full window is the second guard that lets a full run reconcile at all.
    const batches = await collect(
      adapter.streamImport!(importInput({ credentials: { orderHistoryWindow: 'full' } })),
    )

    const reconcileBeats = batches.filter(
      (b) => b.items.length === 0 && (b.message ?? '').includes('checked'),
    )
    expect(reconcileBeats.length).toBeGreaterThanOrEqual(1)
    reconcileBeats.forEach((b) => expect('processedCount' in b).toBe(false))

    const last = batches[batches.length - 1]
    expect(last.hasMore).toBe(false)
    expect(last.message).toBe('Reconciling Shopify orders after the final batch')
    expect(last.refreshCoverageEntityTypes).toEqual([OM_ENTITY_ID.salesOrder])
    // The terminal reconcile batch reports 0 processed — its soft-deletes are not source orders.
    expect(last.processedCount).toBe(0)
  })

  it('reports processedCount as a per-batch delta that sums to the true order count', async () => {
    const harness = makeHarness()
    // Five distinct orders; the backfill carries no children, so each is exactly one item.
    const nodes = [1, 2, 3, 4, 5].map((n) => orderNode({ id: `gid://shopify/Order/${n}`, name: `#100${n}` }))

    // batchSize 2 over 5 orders → the backfill emits data batches of 2, 2, then 1.
    const batches = await collect(
      createOrdersAdapter({
        createRuntime: async () => harness.runtime,
        bulkExport: bulkExportOf(nodes.map(toOrderBulkNode)),
      }).streamImport!(importInput({ batchSize: 2 })),
    )

    // The engine SUMS processedCount across batches; a per-batch delta must total the real count
    // exactly, with no triangular inflation from a running cumulative.
    const totalProcessed = batches.reduce((sum, b) => sum + (b.processedCount ?? 0), 0)
    expect(totalProcessed).toBe(5)

    for (const b of batches) {
      if (b.items.length > 0) expect(b.processedCount).toBe(b.items.length)
    }
  })
})

// ── Adapter shape ────────────────────────────────────────────────────────────────────────────

describe('adapter shape', () => {
  it('declares the identifiers the sync engine resolves it by', () => {
    const adapter = createOrdersAdapter({ createRuntime: async () => makeHarness().runtime })
    expect(adapter.providerKey).toBe(PROVIDER_KEY.orders)
    expect(adapter.direction).toBe('import')
    expect(adapter.supportedEntities).toEqual([ENTITY_TYPE.order])
  })

  it('starts with no cursor, routing the first run down the backfill', async () => {
    const adapter = createOrdersAdapter({ createRuntime: async () => makeHarness().runtime })
    expect(await adapter.getInitialCursor!({ entityType: ENTITY_TYPE.order, scope: SCOPE })).toBeNull()
  })

  it('builds a bulk query within the connection budget and without pagination args', () => {
    const query = buildOrderBulkQuery()
    // Three connections — orders, lineItems, shippingLines — within the bulk ceiling of 5;
    // taxLines/discountAllocations are inline lists, not connections. A bulk query must not paginate.
    expect(query.match(/edges/g)).toHaveLength(3)
    expect(query).not.toContain('first:')
    expect(query).toContain('totalPriceSet')
  })

  it('selects id on shipping lines — the flattened child needs a GID or it fails as missing_id', () => {
    // shippingLines is a connection, so in the bulk export each line is its OWN JSONL record keyed to
    // the order by the type in its GID. Drop `id` here and every order with a shipping line dies at
    // reassembly. Both the line item and the shipping line inside the connection must select id.
    const query = buildOrderBulkQuery()
    expect(query).toMatch(/shippingLines\s*\{\s*edges\s*\{\s*node\s*\{\s*id\b/)
    expect(query).toMatch(/lineItems\s*\{\s*edges\s*\{\s*node\s*\{\s*id\b/)
  })

  it('reassembles a bulk order whose shipping line carries an id (regression: missing_id)', async () => {
    // The REAL Shopify JSONL shape for the fixed query: order, then its line item and shipping line
    // as separate `__parentId`-linked lines, each with its own GID. Exercised through the actual
    // reassembler — the coverage `toOrderBulkNode` could not give, since it synthesised the id.
    const jsonl = [
      JSON.stringify({ id: 'gid://shopify/Order/5001', name: '#5001' }),
      JSON.stringify({ id: 'gid://shopify/LineItem/1', quantity: 1, __parentId: 'gid://shopify/Order/5001' }),
      JSON.stringify({ id: 'gid://shopify/ShippingLine/9', title: 'Standard', __parentId: 'gid://shopify/Order/5001' }),
    ]
    const nodes: BulkNode[] = []
    for await (const node of reassembleBulkStream(jsonl)) nodes.push(node)
    expect(nodes).toHaveLength(1)

    const order = bulkNodeToOrder(nodes[0])
    expect(order.shippingLines?.nodes).toHaveLength(1)
    expect(order.shippingLines?.nodes?.[0]?.title).toBe('Standard')
  })

  it('an id-less shipping line is exactly what trips missing_id — the invariant the query satisfies', async () => {
    const anomalies: BulkAnomaly[] = []
    const jsonl = [
      JSON.stringify({ id: 'gid://shopify/Order/5001', name: '#5001' }),
      JSON.stringify({ title: 'Standard', __parentId: 'gid://shopify/Order/5001' }), // the bug: no id
    ]
    const drained: BulkNode[] = []
    for await (const node of reassembleBulkStream(jsonl, { onAnomaly: (a) => anomalies.push(a) })) drained.push(node)
    expect(anomalies).toContainEqual(expect.objectContaining({ kind: 'missing_id' }))
  })
})

// ── Order upsert: lines + adjustments inline ───────────────────────────────────────────────────

describe('order upsert routes lines and adjustments inline for atomic totals', () => {
  it('creates the order with resolved variant and customer ids, and maps the order GID', async () => {
    const harness = makeHarness({
      variants: { 'gid://shopify/ProductVariant/1': 'variant-local-1' },
      customers: { 'gid://shopify/Customer/9001': 'cust-local-1' },
    })
    const node = orderNode({
      lineItems: { nodes: [orderLine({ discountAllocations: [{ allocatedAmountSet: bag('5.00'), discountApplication: { code: 'FIVE' } }] })] },
      totalDiscountsSet: bag('5.00'),
      totalPriceSet: bag('15.00'),
    })
    await runBackfill(harness, [node])

    const create = harness.commandCalls.find((c) => c.commandId === COMMAND.orderCreate)!
    expect(create.input.externalReference).toBe('gid://shopify/Order/5001')
    expect(create.input.customerEntityId).toBe('cust-local-1')
    const lines = create.input.lines as Record<string, unknown>[]
    expect(lines[0].productVariantId).toBe('variant-local-1')
    expect(lines[0].unitPriceNet).toBe('20')
    const adjustments = create.input.adjustments as Record<string, unknown>[]
    expect(adjustments.find((a) => a.kind === 'discount')).toMatchObject({ code: 'FIVE', amountNet: '5', amountGross: '5' })
    // The order GID is mapped to the local id the command returned.
    expect(harness.mappings.get(`${MAPPING_ENTITY_TYPE.salesOrder}::gid://shopify/Order/5001`)).toBe('order-1')
  })

  it('resolves a variant by SKU when the GID has no mapping', async () => {
    const harness = makeHarness({ variantsBySku: { 'HAT-1': 'variant-by-sku' } })
    await runBackfill(harness, [orderNode()])
    const lines = harness.commandCalls.find((c) => c.commandId === COMMAND.orderCreate)!.input.lines as Record<string, unknown>[]
    expect(lines[0].productVariantId).toBe('variant-by-sku')
  })

  it('records an unresolvable variant without dropping the line or fabricating a variant', async () => {
    const harness = makeHarness() // no variant mappings at all
    const batches = await runBackfill(
      harness,
      [orderNode({ lineItems: { nodes: [orderLine({ variant: { id: 'gid://shopify/ProductVariant/gone', sku: null }, sku: null })] } })],
    )
    const lines = harness.commandCalls.find((c) => c.commandId === COMMAND.orderCreate)!.input.lines as Record<string, unknown>[]
    // Line kept, no productVariantId invented, and the original GID recorded in metadata.
    expect(lines).toHaveLength(1)
    expect(lines[0].productVariantId).toBeUndefined()
    expect((lines[0].metadata as any).shopify.variantGid).toBe('gid://shopify/ProductVariant/gone')
    expect(items(batches)[0].data.notes).toContain('variant_unresolved')
  })

  it('resolves native status columns to dictionary entry ids only when a resolver is wired', async () => {
    const withResolver = makeHarness({ resolveStatus: true })
    await runBackfill(withResolver, [orderNode()])
    const created = withResolver.commandCalls.find((c) => c.commandId === COMMAND.orderCreate)!
    expect(created.input.paymentStatusEntryId).toBe('11111111-1111-1111-1111-111111111111')

    const withoutResolver = makeHarness()
    await runBackfill(withoutResolver, [orderNode()])
    const created2 = withoutResolver.commandCalls.find((c) => c.commandId === COMMAND.orderCreate)!
    expect(created2.input.paymentStatusEntryId).toBeUndefined()
    // Statuses still preserved, in metadata.
    expect((created2.input.metadata as any).shopify.financialStatus).toBe('PAID')
  })
})

// ── Payments and shipments ─────────────────────────────────────────────────────────────────────

describe('read-only children (payments, shipments)', () => {
  const withChildren = () =>
    orderNode({
      transactions: [{ id: 'gid://shopify/OrderTransaction/1', kind: 'SALE', status: 'SUCCESS', gateway: 'stripe', processedAt: '2026-07-15T09:02:00Z', amountSet: bag('20.00') }],
      fulfillments: [{ id: 'gid://shopify/Fulfillment/1', status: 'SUCCESS', displayStatus: 'FULFILLED', createdAt: '2026-07-16T10:00:00Z', trackingInfo: [{ company: 'UPS', number: '1Z' }] }],
    })

  it('creates a payment and a shipment via the execute port and maps them by GID', async () => {
    const harness = makeHarness()
    await runBackfill(harness, [withChildren()])
    expect(harness.commandCalls.filter((c) => c.commandId === COMMAND.paymentCreate)).toHaveLength(1)
    expect(harness.commandCalls.filter((c) => c.commandId === COMMAND.shipmentCreate)).toHaveLength(1)
    expect(harness.mappings.get(`${MAPPING_ENTITY_TYPE.salesPayment}::gid://shopify/OrderTransaction/1`)).toBe('pay-2')
    expect(harness.mappings.get(`${MAPPING_ENTITY_TYPE.salesShipment}::gid://shopify/Fulfillment/1`)).toBe('ship-3')
  })

  it('does not re-create a child already mapped (idempotent under re-run)', async () => {
    const harness = makeHarness()
    await runBackfill(harness, [withChildren()])
    const before = harness.commandCalls.length
    // Second run: order GID already mapped, and so are its children.
    harness.mappings.set(`${MAPPING_ENTITY_TYPE.salesOrder}::gid://shopify/Order/5001`, 'order-1')
    await runBackfill(harness, [withChildren()])
    // The order updates (no hash store match here because metadata differs), but children are skipped.
    expect(harness.commandCalls.filter((c) => c.commandId === COMMAND.paymentCreate).length).toBe(1)
    expect(harness.commandCalls.filter((c) => c.commandId === COMMAND.shipmentCreate).length).toBe(1)
    expect(harness.commandCalls.length).toBeLessThan(before * 2)
  })

  it('reports a child failure without aborting the order run', async () => {
    const harness = makeHarness({ failCommand: (c) => c.commandId === COMMAND.paymentCreate })
    const batches = await runBackfill(harness, [withChildren()])
    const failed = items(batches).find((i) => i.action === 'failed')
    expect(failed?.externalId).toBe('gid://shopify/OrderTransaction/1')
    // The order and the shipment still landed.
    expect(harness.commandCalls.some((c) => c.commandId === COMMAND.orderCreate)).toBe(true)
    expect(harness.commandCalls.some((c) => c.commandId === COMMAND.shipmentCreate)).toBe(true)
  })
})

// ── 🔴 The 60-day window vs reconciliation ─────────────────────────────────────────────────────

describe('60-day window enforcement — the catastrophic case, tested both ways', () => {
  const reconcileHarness = () =>
    makeHarness({
      ownedOrders: ['order-1', 'order-orphan'],
      ownership: { 'order-orphan': 'gid://shopify/Order/999' },
    })

  it('a FULL-window backfill DOES reconcile (soft-deletes an unseen owned order)', async () => {
    const harness = reconcileHarness()
    const batches = await runBackfill(harness, [orderNode()], { credentials: { orderHistoryWindow: 'full' } })
    const deletes = harness.commandCalls.filter((c) => c.commandId === COMMAND.orderDelete)
    expect(deletes).toHaveLength(1)
    expect(deletes[0].input.id).toBe('order-orphan')
    const last = batches[batches.length - 1]
    expect(last.message).toMatch(/Reconciling/)
  })

  it('🔴 a SIXTY-DAY backfill does NOT reconcile — deleting older-than-60-day history would be catastrophic', async () => {
    const harness = reconcileHarness()
    await runBackfill(harness, [orderNode()], { credentials: { orderHistoryWindow: 'sixty_days' } })
    expect(harness.commandCalls.filter((c) => c.commandId === COMMAND.orderDelete)).toHaveLength(0)
  })

  it('an UNKNOWN window defaults to sixty_days (safe) and does not reconcile', async () => {
    const harness = reconcileHarness()
    await runBackfill(harness, [orderNode()], { credentials: {} })
    expect(harness.commandCalls.filter((c) => c.commandId === COMMAND.orderDelete)).toHaveLength(0)
  })

  it('derives the window from granted scopes when not stated explicitly', () => {
    expect(resolveOrderWindow({ grantedScopes: ['read_orders', 'read_all_orders'] })).toBe('full')
    expect(resolveOrderWindow({ grantedScopes: ['read_orders'] })).toBe('sixty_days')
    expect(resolveOrderWindow({})).toBe('sixty_days')
    expect(resolveOrderWindow({ orderHistoryWindow: 'full' })).toBe('full')
  })

  it('does NOT reconcile on a delta run even with a full window', async () => {
    const { harness } = deltaHarness([[orderNode()]])
    harness.runtime.listOwnedOrderIds = async () => {
      throw new Error('reconciliation must not be attempted on a delta run')
    }
    const cursor = serializeCursor({ kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' })
    await collect(
      createOrdersAdapter({ createRuntime: async () => harness.runtime }).streamImport!(
        importInput({ cursor, credentials: { orderHistoryWindow: 'full' } }),
      ),
    )
    expect(harness.commandCalls.filter((c) => c.commandId === COMMAND.orderDelete)).toHaveLength(0)
  })
})

// ── Delta path and R-13 ────────────────────────────────────────────────────────────────────────

describe('delta path', () => {
  function runDelta(harness: ReturnType<typeof makeHarness>, input: Partial<StreamImportInput> = {}) {
    return collect(createOrdersAdapter({ createRuntime: async () => harness.runtime }).streamImport!(importInput(input)))
  }

  it('filters on updated_at, pairs the sort key, and sends the search-debug header', async () => {
    const { harness, headers, variables } = deltaHarness([[orderNode()]])
    const cursor = serializeCursor({ kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' })
    await runDelta(harness, { cursor })
    expect(variables[0].query).toBe("updated_at:>'2026-07-01T00:00:00.000Z'")
    expect(headers[0]).toEqual(SEARCH_DEBUG_HEADER)
  })

  it('builds no filter for an empty watermark', () => {
    expect(buildUpdatedAtFilter(null)).toBeNull()
    expect(buildUpdatedAtFilter('2026-07-01T00:00:00.000Z')).toBe("updated_at:>'2026-07-01T00:00:00.000Z'")
  })

  it('🔴 aborts the run writing nothing when Shopify reports the filter was ignored', async () => {
    const { harness } = deltaHarness([[orderNode()]], {
      extensions: { search: [{ warnings: [{ field: 'updated_at', message: 'is not a valid field' }] }] },
    })
    const cursor = serializeCursor({ kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' })
    await expect(runDelta(harness, { cursor })).rejects.toBeInstanceOf(OrdersSyncError)
    expect(harness.commandCalls).toHaveLength(0)
  })

  it('catches a filter ignored in effect (a row older than the window) even with no warning', async () => {
    const { harness } = deltaHarness([[orderNode({ updatedAt: '2020-01-01T00:00:00Z' })]])
    const cursor = serializeCursor({ kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' })
    await expect(runDelta(harness, { cursor })).rejects.toBeInstanceOf(OrdersSyncError)
    expect(harness.commandCalls).toHaveLength(0)
  })

  it('proceeds and pages when warnings are empty and the window is respected', async () => {
    const { harness, variables } = deltaHarness(
      [[orderNode({ id: 'gid://shopify/Order/1' })], [orderNode({ id: 'gid://shopify/Order/2' })]],
      { extensions: { search: [{ warnings: [] }] } },
    )
    const batches = await runDelta(harness, { cursor: serializeCursor({ kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' }) })
    expect(variables[1].after).toBe('cursor-1')
    expect(parseCursor(batches[0].cursor as string)).toMatchObject({ kind: 'paging', endCursor: 'cursor-1' })
    expect(items(batches).map((i) => i.action)).toContain('create')
  })
})

describe('R-13 helpers', () => {
  it('reads warnings as strings or {field,message} objects, and throws only on a non-empty warning', () => {
    expect(readSearchWarnings({ search: [{ warnings: [{ field: 'updated_at', message: 'unknown' }] }] })).toEqual(['updated_at: unknown'])
    expect(() => assertSearchWarningsEmpty({ search: [{ warnings: [] }] })).not.toThrow()
    expect(() => assertSearchWarningsEmpty({ search: [{ warnings: ['ignored'] }] })).toThrow(OrdersSyncError)
  })

  it('window belt throws only when a row predates the floor', () => {
    const floor = '2026-07-01T00:00:00.000Z'
    expect(() => assertDeltaWindowRespected([orderNode({ updatedAt: '2026-07-05T00:00:00Z' })], floor)).not.toThrow()
    expect(() => assertDeltaWindowRespected([orderNode({ updatedAt: '2020-01-01T00:00:00Z' })], floor)).toThrow(OrdersSyncError)
  })
})

// ── Per-item failures and change detection ─────────────────────────────────────────────────────

describe('per-item failures are reported, never thrown', () => {
  it('records a failed order and keeps importing the rest of the run', async () => {
    const harness = makeHarness({ failCommand: (c) => c.commandId === COMMAND.orderCreate && (c.input.externalReference as string).endsWith('/1') })
    const batches = await runBackfill(harness, [orderNode({ id: 'gid://shopify/Order/1' }), orderNode({ id: 'gid://shopify/Order/2' })])
    const all = items(batches)
    const failed = all.find((i) => i.action === 'failed')!
    expect(failed.externalId).toBe('gid://shopify/Order/1')
    expect(failed.data).toMatchObject({ sourceIdentifier: 'gid://shopify/Order/1', errorMessage: expect.any(String) })
    expect(all.find((i) => i.externalId === 'gid://shopify/Order/2')?.action).toBe('create')
  })

  it('does not let a write error escape the generator', async () => {
    const harness = makeHarness({ failCommand: () => true })
    await expect(runBackfill(harness, [orderNode()])).resolves.toBeDefined()
  })
})

describe('content-hash skip on re-run', () => {
  it('skips an unchanged order and touches no children', async () => {
    const harness = makeHarness()
    await runBackfill(harness, [orderNode()])
    const before = harness.commandCalls.length
    // Second run: the order GID is already mapped and the persisted row carries the same hash.
    harness.mappings.set(`${MAPPING_ENTITY_TYPE.salesOrder}::gid://shopify/Order/5001`, 'order-1')
    const batches = await runBackfill(harness, [orderNode()])
    expect(items(batches)[0].action).toBe('skip')
    expect(harness.commandCalls.length).toBe(before)
  })

  it('rewrites when a mapped field changed', async () => {
    const harness = makeHarness()
    await runBackfill(harness, [orderNode()])
    harness.mappings.set(`${MAPPING_ENTITY_TYPE.salesOrder}::gid://shopify/Order/5001`, 'order-1')
    const batches = await runBackfill(harness, [orderNode({ displayFulfillmentStatus: 'FULFILLED' })])
    expect(items(batches)[0].action).toBe('update')
  })
})
