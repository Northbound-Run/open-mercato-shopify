import type { ImportBatch, StreamImportInput } from '@open-mercato/core/modules/data_sync/lib/adapter'
import type { BulkExport, BulkNode } from '../lib/bulk'
import { SEARCH_DEBUG_HEADER, type ShopifyClient } from '../lib/client'
import { COMMAND, COMMAND_RESULT_KEY, ENTITY_TYPE, MAPPING_ENTITY_TYPE, OM_ENTITY_ID, PROVIDER_KEY } from '../lib/constants'
import { parseCursor, serializeCursor } from '../lib/cursor'
import { createEntityWriter, type CommandBusPort, type EntityRow, type FindOnePort } from '../lib/writer'
import {
  assertDeltaWindowRespected,
  assertSearchWarningsEmpty,
  buildUpdatedAtFilter,
  bulkNodeToCustomer,
  buildCustomerBulkQuery,
  classifyWriteFailure,
  createCustomersAdapter,
  CustomersSyncError,
  readSearchWarnings,
  type CustomerSyncLogEvent,
  type CustomerSyncRuntime,
} from '../lib/adapters/customers'
import type { ShopifyCustomerNode } from '../lib/mappers/customer'
import type { HeartbeatClock } from '../lib/heartbeat'

// The whole framework is stubbed, but the WRITER IS REAL: the `customers.people.*` result-key trap
// (`entityId`, not `personId`) only exists inside the writer's unwrapping, so stubbing it away
// would test a fiction. The stubs below therefore return the command bus's REAL result shape.

const SCOPE = { organizationId: 'org-1', tenantId: 'tenant-1' }
const CONTAINER = { resolve: () => undefined } as never

// Fixture PII. The assertions treat these as real values that must never escape into a log.
const EMAIL = 'ada.lovelace@example.com'
const PHONE = '+442071234567'
const STREET = '12 Riverside Walk'

type CommandCall = { commandId: string; input: Record<string, unknown> }

function customerNode(over: Partial<ShopifyCustomerNode> = {}): ShopifyCustomerNode {
  return {
    id: 'gid://shopify/Customer/1001',
    firstName: 'Ada',
    lastName: 'Lovelace',
    defaultEmailAddress: { emailAddress: EMAIL },
    defaultPhoneNumber: { phoneNumber: PHONE },
    note: 'Prefers courier delivery',
    tags: ['vip'],
    state: 'ENABLED',
    updatedAt: '2026-07-19T10:00:00Z',
    defaultAddress: { id: 'gid://shopify/MailingAddress/1' },
    addressesV2: {
      nodes: [{ id: 'gid://shopify/MailingAddress/1', address1: STREET, city: 'London', zip: 'SE1 9RT' }],
    },
    ...over,
  }
}

/** Rebuild the JSONL reassembly shape `lib/bulk.ts` hands the adapter. */
function toBulkNode(node: ShopifyCustomerNode): BulkNode {
  const { addressesV2, ...fields } = node
  const children = (addressesV2?.nodes ?? [])
    .filter((address): address is NonNullable<typeof address> => address != null)
    .map((address) => {
      const { id, ...rest } = address
      return { id: id as string, type: 'MailingAddress', fields: rest, children: {} }
    })
  return {
    id: node.id,
    type: 'Customer',
    fields: fields as Record<string, unknown>,
    children: children.length > 0 ? { MailingAddress: children } : {},
  }
}

type HarnessOptions = {
  /** Throw from the command bus for a chosen call, to exercise the per-item failure path. */
  failCommand?: (call: CommandCall) => boolean
  /**
   * When set, its return value (if not undefined) is thrown for a chosen call instead of the
   * default plain Error — used to feed the real error SHAPES (ZodError, driver exceptions) whose
   * classification the failure path must surface without leaking their message.
   */
  failCommandError?: (call: CommandCall) => unknown
  /** Local addresses already present, keyed by customer local id. */
  existingAddresses?: Record<string, EntityRow[]>
  /** Reverse-mapping answers: `${entityType}::${localId}` → external id. Absent means NOT owned. */
  owned?: Record<string, string>
  syncedCustomers?: { localId: string; externalId: string }[]
  storedHashes?: Map<string, string>
}

function makeHarness(options: HarnessOptions = {}) {
  const commandCalls: CommandCall[] = []
  const logEvents: CustomerSyncLogEvent[] = []
  const rows = new Map<string, EntityRow>()
  const mappings = new Map<string, string>()
  const addresses = new Map<string, EntityRow[]>(Object.entries(options.existingAddresses ?? {}))
  const hashes = options.storedHashes
  let seq = 0

  const key = (entityType: string, externalId: string) => `${entityType}::${externalId}`

  const commandBus: CommandBusPort = {
    async execute(commandId, executeOptions) {
      const input = executeOptions.input as Record<string, unknown>
      const call = { commandId, input }
      commandCalls.push(call)
      if (options.failCommand?.(call)) {
        const custom = options.failCommandError?.(call)
        if (custom !== undefined) throw custom
        // Zod quotes the value it rejected, which is exactly the PII shape that must not survive
        // into an item's errorMessage — so the stub throws one.
        throw new Error(`Invalid primaryEmail: received "${String(input.primaryEmail ?? '')}"`)
      }

      if (commandId === COMMAND.personCreate) {
        const id = `cust-${(seq += 1)}`
        rows.set(id, { id, primaryEmail: input.primaryEmail as string })
        // The REAL shape: both keys present, and `personId` is the wrong one to map.
        return { result: { entityId: id, personId: `profile-${id}` } }
      }
      if (commandId === COMMAND.addressCreate) {
        const id = `addr-${(seq += 1)}`
        const row: EntityRow = { id }
        rows.set(id, row)
        const owner = input.entityId as string
        addresses.set(owner, [...(addresses.get(owner) ?? []), row])
        return { result: { addressId: id } }
      }
      if (commandId === COMMAND.addressDelete) {
        const target = input.id as string
        for (const [owner, list] of addresses)
          addresses.set(
            owner,
            list.filter((row) => row.id !== target),
          )
        return { result: { addressId: target } }
      }
      return { result: { id: (input.id as string) ?? 'unknown' } }
    },
  }

  const findOne: FindOnePort = async (entityName, where) => {
    // Model production faithfully: `customer_addresses` has NO `deleted_at` column, so a read that
    // filters on it throws under MikroORM v7. This is what makes the second-sync regression real —
    // the buggy `writer.rowReader(customerAddress)` path forces `deletedAt: null` and lands here.
    if (entityName === 'CustomerAddress' && 'deletedAt' in where) {
      throw new Error('[test] column "deleted_at" does not exist on customer_addresses')
    }
    if (where.deletedAt !== null) return null
    if (typeof where.id === 'string') return rows.get(where.id) ?? null
    if (typeof where.primaryEmail === 'string') {
      for (const row of rows.values()) if (row.primaryEmail === where.primaryEmail) return row
    }
    return null
  }

  const writer = createEntityWriter({
    container: CONTAINER,
    scope: SCOPE,
    integrationId: 'sync_shopify_customers',
    commandBus,
    externalIdMapping: {
      async lookupLocalId(_integrationId, entityType, externalId) {
        return mappings.get(key(entityType, externalId)) ?? null
      },
      async storeExternalIdMapping(_integrationId, entityType, localId, externalId) {
        mappings.set(key(entityType, externalId), localId)
        return {}
      },
    },
    findOne,
  })

  const runtime: CustomerSyncRuntime = {
    client: { request: async () => ({}) } as unknown as ShopifyClient,
    writer,
    commandBus,
    customerEntity: 'CustomerEntity',
    customerAddress: 'CustomerAddress',
    findCustomerByEmail: async (email) => findOne('CustomerEntity', { primaryEmail: email, deletedAt: null }, undefined, SCOPE),
    listAddresses: async (customerLocalId) => addresses.get(customerLocalId) ?? [],
    // Org + tenant only — no `deletedAt`, mirroring runtime.ts. A read straight from the row store,
    // NOT through the `deletedAt`-forcing `findOne` above, which is exactly the point of the fix.
    readAddressById: async (localId) => rows.get(localId) ?? null,
    lookupExternalId: async (entityType, localId) => options.owned?.[`${entityType}::${localId}`] ?? null,
    listSyncedCustomers: async () => options.syncedCustomers ?? [],
    ...(hashes
      ? {
          contentHash: {
            read: async (localId: string) => hashes.get(localId) ?? null,
            write: async (localId: string, hash: string) => void hashes.set(localId, hash),
          },
        }
      : {}),
  }

  return { runtime, commandCalls, logEvents, rows, mappings, addresses, findOne }
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
    entityType: ENTITY_TYPE.customer,
    batchSize: 50,
    credentials: {},
    mapping: { entityType: ENTITY_TYPE.customer, fields: [], matchStrategy: 'externalId' },
    scope: SCOPE,
    ...over,
  }
}

async function collect(iterable: AsyncIterable<ImportBatch>): Promise<ImportBatch[]> {
  const batches: ImportBatch[] = []
  for await (const batch of iterable) batches.push(batch)
  return batches
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
    const adapter = createCustomersAdapter({
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

    // Let the export finish; the remainder of the run carries the real customer. The stub ignores
    // its arguments, but its type declares them, so pass the client + query through.
    work.resolve(await bulkExportOf([toBulkNode(customerNode())])(harness.runtime.client, buildCustomerBulkQuery()))
    const rest = await drainBatches(iterator)

    const dataItems = rest.flatMap((b) => b.items) as { action: string; externalId: string }[]
    expect(dataItems).toHaveLength(1)
    expect(dataItems[0]).toMatchObject({ action: 'create', externalId: 'gid://shopify/Customer/1001' })
  })

  it('a fast-resolving bulk export yields NO heartbeat, so existing sequences are unchanged', async () => {
    const harness = makeHarness()
    const fake = makeFakeHeartbeatClock()
    const batches = await collect(
      createCustomersAdapter({
        createRuntime: async () => harness.runtime,
        bulkExport: bulkExportOf([toBulkNode(customerNode())]),
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
      syncedCustomers: [
        { localId: 'cust-a', externalId: 'gid://shopify/Customer/9001' },
        { localId: 'cust-b', externalId: 'gid://shopify/Customer/9002' },
        { localId: 'cust-c', externalId: 'gid://shopify/Customer/9003' },
      ],
      owned: {}, // none owned → all skipped, but the sweep still walks every id
    })
    const adapter = createCustomersAdapter({
      createRuntime: async () => harness.runtime,
      bulkExport: bulkExportOf([toBulkNode(customerNode())]),
      heartbeatIntervalMs: 100,
      // Advances well past the interval on every call, so each swept id is "due".
      now: () => (clock += 1_000),
    })

    const batches = await collect(adapter.streamImport!(importInput()))

    const reconcileBeats = batches.filter(
      (b) => b.items.length === 0 && (b.message ?? '').includes('checked'),
    )
    expect(reconcileBeats.length).toBeGreaterThanOrEqual(1)
    reconcileBeats.forEach((b) => expect('processedCount' in b).toBe(false))

    const last = batches[batches.length - 1]
    expect(last.hasMore).toBe(false)
    expect(last.message).toBe('Reconciling Shopify customers after the final batch')
    expect(last.refreshCoverageEntityTypes).toEqual([OM_ENTITY_ID.customerEntity])
  })

  it('reports processedCount as a per-batch delta that sums to the true customer count', async () => {
    const harness = makeHarness()
    const nodes = [1, 2, 3, 4, 5].map((n) =>
      customerNode({
        id: `gid://shopify/Customer/${n}`,
        defaultEmailAddress: { emailAddress: `c${n}@example.com` },
        defaultAddress: { id: `gid://shopify/MailingAddress/${n}` },
        addressesV2: { nodes: [{ id: `gid://shopify/MailingAddress/${n}`, address1: STREET, city: 'London' }] },
      }),
    )

    // batchSize 2 over 5 customers → the backfill emits data batches of 2, 2, then 1.
    const batches = await collect(
      createCustomersAdapter({
        createRuntime: async () => harness.runtime,
        bulkExport: bulkExportOf(nodes.map(toBulkNode)),
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

function runAdapter(
  harness: ReturnType<typeof makeHarness>,
  nodes: ShopifyCustomerNode[],
  input: Partial<StreamImportInput> = {},
  log?: (event: CustomerSyncLogEvent) => void,
): Promise<ImportBatch[]> {
  const adapter = createCustomersAdapter({
    createRuntime: async () => harness.runtime,
    bulkExport: bulkExportOf(nodes.map(toBulkNode)),
    log,
  })
  return collect(adapter.streamImport!(importInput(input)))
}

/**
 * A delta-path harness: stubs `requestDetailed` (not `request` — the R-13 guard needs the
 * `extensions` envelope), records the variables and headers each page was requested with, and lets
 * a test inject the `extensions` Shopify would return.
 */
function deltaHarness(
  pages: { node: ShopifyCustomerNode }[][],
  opts: { extensions?: Record<string, unknown> } = {},
) {
  const harness = makeHarness()
  const requests: Record<string, unknown>[] = []
  const headers: (Record<string, string> | undefined)[] = []
  let page = 0
  harness.runtime.client = {
    requestDetailed: async (
      _query: string,
      requestOptions?: { variables?: Record<string, unknown>; headers?: Record<string, string> },
    ) => {
      requests.push(requestOptions?.variables ?? {})
      headers.push(requestOptions?.headers)
      const edges = pages[page] ?? []
      const hasNextPage = page < pages.length - 1
      page += 1
      return {
        data: {
          customers: { edges, pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${page}` : null } },
        },
        extensions: opts.extensions,
      }
    },
  } as unknown as ShopifyClient
  return { harness, requests, headers }
}

describe('adapter shape', () => {
  it('declares the identifiers the sync engine resolves it by', () => {
    const adapter = createCustomersAdapter({ createRuntime: async () => makeHarness().runtime })
    expect(adapter.providerKey).toBe(PROVIDER_KEY.customers)
    expect(adapter.direction).toBe('import')
    expect(adapter.supportedEntities).toEqual([ENTITY_TYPE.customer])
  })

  it('starts with no cursor, which routes the first run down the backfill', async () => {
    const adapter = createCustomersAdapter({ createRuntime: async () => makeHarness().runtime })
    expect(await adapter.getInitialCursor!({ entityType: ENTITY_TYPE.customer, scope: SCOPE })).toBeNull()
  })
})

describe('the result-key trap', () => {
  it('maps the CustomerEntity id, not the person profile id', async () => {
    const harness = makeHarness()
    await runAdapter(harness, [customerNode()])

    // `customers.people.*` returns BOTH `entityId` and `personId`; the row it creates is a
    // CustomerEntity. Mapping `personId` would poison every later lookup, silently.
    expect(COMMAND_RESULT_KEY.person).toBe('entityId')
    const mapped = harness.mappings.get(`${MAPPING_ENTITY_TYPE.customerEntity}::gid://shopify/Customer/1001`)
    expect(mapped).toBe('cust-1')
    expect(mapped).not.toMatch(/^profile-/)
  })

  it('maps addresses under their own entity type, not the customer one', async () => {
    const harness = makeHarness()
    await runAdapter(harness, [customerNode()])
    expect(
      harness.mappings.get(`${MAPPING_ENTITY_TYPE.customerAddress}::gid://shopify/MailingAddress/1`),
    ).toBe('addr-2')
  })
})

describe('backfill', () => {
  it('imports customers and their addresses, and reports a create', async () => {
    const harness = makeHarness()
    const batches = await runAdapter(harness, [customerNode()])

    const items = batches.flatMap((batch) => batch.items) as { action: string; externalId: string }[]
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ action: 'create', externalId: 'gid://shopify/Customer/1001' })

    const created = harness.commandCalls.filter((call) => call.commandId === COMMAND.personCreate)
    expect(created).toHaveLength(1)
    expect(created[0].input).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace', primaryEmail: EMAIL })
    expect(harness.commandCalls.filter((c) => c.commandId === COMMAND.addressCreate)).toHaveLength(1)
  })

  it('never passes Shopify tag labels to a command that wants tag UUIDs', async () => {
    const harness = makeHarness()
    await runAdapter(harness, [customerNode({ tags: ['vip', 'wholesale'] })])
    const create = harness.commandCalls.find((call) => call.commandId === COMMAND.personCreate)
    expect(create?.input.tags).toBeUndefined()
  })

  it('promotes the watermark into the final cursor so the next run is incremental', async () => {
    const harness = makeHarness()
    const batches = await runAdapter(harness, [customerNode({ updatedAt: '2026-07-19T10:00:00Z' })])
    const final = parseCursor(batches[batches.length - 1].cursor as string)
    expect(final).toEqual({ kind: 'idle', updatedAfter: '2026-07-19T10:00:00.000Z' })
  })

  it('builds a bulk query within the connection and nesting limits', () => {
    const query = buildCustomerBulkQuery()
    // Two connections, two nesting levels — the documented ceilings are 5 and 2.
    expect(query.match(/edges/g)).toHaveLength(2)
    expect(query).toContain('defaultEmailAddress { emailAddress }')
    expect(query).toContain('defaultPhoneNumber { phoneNumber }')
    expect(query).toContain('addressesV2')
    // A bulk query must not paginate — `first:` here silently truncates the backfill.
    expect(query).not.toContain('first:')
    // The deprecated accessors must not appear as bare selections.
    expect(query).not.toMatch(/^\s*email\s*$/m)
    expect(query).not.toMatch(/^\s*phone\s*$/m)
  })

  it('reassembles bulk children into the shape the mapper expects', () => {
    const node = bulkNodeToCustomer(toBulkNode(customerNode()))
    expect(node.id).toBe('gid://shopify/Customer/1001')
    expect(node.addressesV2?.nodes).toHaveLength(1)
    expect(node.addressesV2?.nodes?.[0]).toMatchObject({ id: 'gid://shopify/MailingAddress/1', address1: STREET })
  })
})

describe('full-sync reconciliation, and the guard that stops a delta doing it', () => {
  it('deactivates a mapped customer the full run did not see', async () => {
    const harness = makeHarness({
      syncedCustomers: [
        { localId: 'cust-gone', externalId: 'gid://shopify/Customer/9999' },
        { localId: 'cust-kept', externalId: 'gid://shopify/Customer/1001' },
      ],
      owned: { [`${MAPPING_ENTITY_TYPE.customerEntity}::cust-gone`]: 'gid://shopify/Customer/9999' },
    })
    await runAdapter(harness, [customerNode()])

    const deactivations = harness.commandCalls.filter(
      (call) => call.commandId === COMMAND.personUpdate && call.input.isActive === false,
    )
    expect(deactivations).toHaveLength(1)
    expect(deactivations[0].input.id).toBe('cust-gone')
  })

  it('deactivates rather than deletes, so orders are never orphaned', async () => {
    const harness = makeHarness({
      syncedCustomers: [{ localId: 'cust-gone', externalId: 'gid://shopify/Customer/9999' }],
      owned: { [`${MAPPING_ENTITY_TYPE.customerEntity}::cust-gone`]: 'gid://shopify/Customer/9999' },
    })
    await runAdapter(harness, [customerNode()])
    expect(harness.commandCalls.some((call) => call.commandId === COMMAND.personDelete)).toBe(false)
  })

  it('leaves a customer this integration does not own alone', async () => {
    const harness = makeHarness({
      syncedCustomers: [{ localId: 'human-made', externalId: 'gid://shopify/Customer/9999' }],
      owned: {}, // no mapping → another connector or a human created it
    })
    await runAdapter(harness, [customerNode()])
    expect(
      harness.commandCalls.filter((call) => call.commandId === COMMAND.personUpdate && call.input.isActive === false),
    ).toHaveLength(0)
  })

  it('🔴 performs NO reconciliation on a delta run', async () => {
    // A delta run legitimately sees only changed customers. Reconciling on one would deactivate
    // every customer that simply did not change — the difference between a correct sync and a
    // catastrophic one.
    const harness = makeHarness({
      syncedCustomers: [{ localId: 'cust-untouched', externalId: 'gid://shopify/Customer/9999' }],
      owned: { [`${MAPPING_ENTITY_TYPE.customerEntity}::cust-untouched`]: 'gid://shopify/Customer/9999' },
    })
    let listed = false
    harness.runtime.listSyncedCustomers = async () => {
      listed = true
      return [{ localId: 'cust-untouched', externalId: 'gid://shopify/Customer/9999' }]
    }
    harness.runtime.client = {
      requestDetailed: async () => ({
        data: {
          customers: { edges: [{ node: customerNode() }], pageInfo: { hasNextPage: false, endCursor: null } },
        },
        extensions: undefined,
      }),
    } as unknown as ShopifyClient

    const cursor = serializeCursor({ kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' })
    await runAdapter(harness, [], { cursor })

    expect(listed).toBe(false)
    expect(
      harness.commandCalls.filter((call) => call.commandId === COMMAND.personUpdate && call.input.isActive === false),
    ).toHaveLength(0)
  })

  it('skips reconciliation when a malformed cursor is present, rather than treating it as a full run', async () => {
    // The cursor does not parse, so the window restarts — but a previous run DID exist, and we
    // cannot tell what it synced. Reconciling on that assumption would be destructive.
    const harness = makeHarness({
      syncedCustomers: [{ localId: 'cust-untouched', externalId: 'gid://shopify/Customer/9999' }],
      owned: { [`${MAPPING_ENTITY_TYPE.customerEntity}::cust-untouched`]: 'gid://shopify/Customer/9999' },
    })
    harness.runtime.client = {
      requestDetailed: async () => ({
        data: { customers: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        extensions: undefined,
      }),
    } as unknown as ShopifyClient

    await runAdapter(harness, [], { cursor: 'not-json-at-all' })
    expect(
      harness.commandCalls.filter((call) => call.commandId === COMMAND.personUpdate && call.input.isActive === false),
    ).toHaveLength(0)
  })

  it('announces the reconcile phase so the admin UI does not look hung', async () => {
    const harness = makeHarness()
    const batches = await runAdapter(harness, [customerNode()])
    const last = batches[batches.length - 1] as { message?: string; hasMore: boolean }
    expect(last.message).toMatch(/Reconciling/)
    expect(last.hasMore).toBe(false)
  })
})

describe('per-customer address reconciliation', () => {
  const twoAddresses = customerNode({
    addressesV2: {
      nodes: [
        { id: 'gid://shopify/MailingAddress/1', address1: STREET, city: 'London' },
        { id: 'gid://shopify/MailingAddress/2', address1: '8 Hill Road', city: 'Bristol' },
      ],
    },
  })

  it('updates an already-mapped address on the SECOND sync instead of failing the customer', async () => {
    // The second-sync trap. An already-mapped address is re-read before its update. That re-read
    // must NOT force `deletedAt: null` — `customer_addresses` has no such column and the query
    // throws, flipping the whole customer to `failed`. First import hides it (unmapped → create
    // path, never re-reads); the bug only surfaces on run two. The harness models the missing column
    // (a CustomerAddress read carrying `deletedAt` throws), so this test fails against the buggy
    // `writer.rowReader(customerAddress)` wiring and passes only with `readAddressById`.
    const harness = makeHarness()
    await runAdapter(harness, [customerNode()])
    expect(harness.addresses.get('cust-1')).toHaveLength(1)

    // Run again with the customer and address already mapped from run one.
    const batches = await runAdapter(harness, [customerNode()])
    const items = batches.flatMap((batch) => batch.items) as { action: string; data: Record<string, unknown> }[]

    expect(items[0].action).not.toBe('failed')
    expect(items[0].action).toBe('update')
    // The address took the update branch — a re-read that threw would have prevented this and there
    // would be an addressCreate-then-fail instead.
    expect(harness.commandCalls.filter((call) => call.commandId === COMMAND.addressUpdate).length).toBeGreaterThan(0)
  })

  it('removes an address deleted upstream, and leaves its sibling and the customer intact', async () => {
    const harness = makeHarness()
    await runAdapter(harness, [twoAddresses])
    expect(harness.addresses.get('cust-1')).toHaveLength(2)

    // Second run: Shopify sends the customer's WHOLE address set, so the removed one is simply
    // absent. That absence is only meaningful within this customer.
    harness.mappings.set(`${MAPPING_ENTITY_TYPE.customerEntity}::gid://shopify/Customer/1001`, 'cust-1')
    const owned = harness.addresses.get('cust-1')!
    const survivor = owned[0]
    const removed = owned[1]
    harness.runtime.lookupExternalId = async (entityType, localId) =>
      entityType === MAPPING_ENTITY_TYPE.customerAddress && localId === removed.id ? 'gid://shopify/MailingAddress/2' : null

    await runAdapter(harness, [
      customerNode({
        addressesV2: { nodes: [{ id: 'gid://shopify/MailingAddress/1', address1: STREET, city: 'London' }] },
      }),
    ])

    const deletes = harness.commandCalls.filter((call) => call.commandId === COMMAND.addressDelete)
    expect(deletes).toHaveLength(1)
    expect(deletes[0].input.id).toBe(removed.id)

    const remaining = harness.addresses.get('cust-1') ?? []
    expect(remaining.map((row) => row.id)).toEqual([survivor.id])
    // The customer survives — reconciliation is scoped to addresses, not the record.
    expect(harness.rows.get('cust-1')).toBeDefined()
  })

  it('leaves an address this integration does not own alone', async () => {
    const harness = makeHarness()
    await runAdapter(harness, [customerNode()])
    // A human adds an address locally; it has no mapping from this integration.
    harness.addresses.get('cust-1')!.push({ id: 'addr-human' })
    harness.mappings.set(`${MAPPING_ENTITY_TYPE.customerEntity}::gid://shopify/Customer/1001`, 'cust-1')
    harness.runtime.lookupExternalId = async () => null

    await runAdapter(harness, [customerNode()])
    expect(harness.commandCalls.filter((call) => call.commandId === COMMAND.addressDelete)).toHaveLength(0)
    expect(harness.addresses.get('cust-1')!.some((row) => row.id === 'addr-human')).toBe(true)
  })

  it('does not delete anything when an address write failed, since absence is then ambiguous', async () => {
    let failNext = false
    const harness = makeHarness({ failCommand: (call) => failNext && call.commandId === COMMAND.addressCreate })
    await runAdapter(harness, [twoAddresses])

    harness.mappings.set(`${MAPPING_ENTITY_TYPE.customerEntity}::gid://shopify/Customer/1001`, 'cust-1')
    harness.runtime.lookupExternalId = async () => 'gid://shopify/MailingAddress/x'
    failNext = true

    await runAdapter(harness, [
      customerNode({
        addressesV2: { nodes: [{ id: 'gid://shopify/MailingAddress/3', address1: 'New Street' }] },
      }),
    ])
    expect(harness.commandCalls.filter((call) => call.commandId === COMMAND.addressDelete)).toHaveLength(0)
  })

  it('writes exactly one address as primary', async () => {
    const harness = makeHarness()
    await runAdapter(harness, [
      customerNode({
        defaultAddress: { id: 'gid://shopify/MailingAddress/2' },
        addressesV2: {
          nodes: [
            { id: 'gid://shopify/MailingAddress/1', address1: STREET },
            { id: 'gid://shopify/MailingAddress/2', address1: '8 Hill Road' },
            { id: 'gid://shopify/MailingAddress/3', address1: '9 Vale Close' },
          ],
        },
      }),
    ])

    const creates = harness.commandCalls.filter((call) => call.commandId === COMMAND.addressCreate)
    expect(creates).toHaveLength(3)
    expect(creates.filter((call) => call.input.isPrimary === true)).toHaveLength(1)
    expect(creates.filter((call) => call.input.isPrimary === false)).toHaveLength(2)
  })

  it('omits absent optional address fields rather than sending null', async () => {
    // Core's `addressCreateSchema` types these `.optional()` but NOT `.nullable()`, so a null is an
    // `invalid_type` reject that fails the whole customer. Shopify omits company and the second line
    // for almost every address, so the mapper's null MUST reach core as an ABSENT key, not a null.
    const harness = makeHarness()
    await runAdapter(harness, [customerNode()]) // default address: street, city, zip — no company/line2/country
    const create = harness.commandCalls.find((call) => call.commandId === COMMAND.addressCreate)!

    // Present fields are sent through untouched…
    expect(create.input.addressLine1).toBe(STREET)
    expect(create.input.city).toBe('London')
    expect(create.input.postalCode).toBe('SE1 9RT')
    // …absent ones are OMITTED, and NOTHING is ever sent as null.
    expect(create.input).not.toHaveProperty('companyName')
    expect(create.input).not.toHaveProperty('addressLine2')
    expect(create.input).not.toHaveProperty('country')
    expect(create.input).not.toHaveProperty('region')
    expect(create.input).not.toHaveProperty('name')
    expect(Object.values(create.input)).not.toContain(null)
  })
})

describe('per-item failures are reported, never thrown', () => {
  it('records a failed item and keeps importing the rest of the run', async () => {
    const harness = makeHarness({
      failCommand: (call) =>
        call.commandId === COMMAND.personCreate && call.input.primaryEmail === 'boom@example.com',
    })
    const batches = await runAdapter(harness, [
      customerNode({ id: 'gid://shopify/Customer/1', defaultEmailAddress: { emailAddress: 'boom@example.com' } }),
      customerNode({ id: 'gid://shopify/Customer/2', defaultEmailAddress: { emailAddress: 'fine@example.com' } }),
    ])

    const items = batches.flatMap((batch) => batch.items) as {
      action: string
      externalId: string
      data: Record<string, unknown>
    }[]
    expect(items).toHaveLength(2)

    const failed = items.find((item) => item.action === 'failed')!
    expect(failed.externalId).toBe('gid://shopify/Customer/1')
    // The exact shape `logImportItemFailures` reads.
    expect(failed.data).toMatchObject({
      sourceIdentifier: 'gid://shopify/Customer/1',
      errorMessage: expect.any(String),
    })

    // The run continued: the second customer imported.
    expect(items.find((item) => item.externalId === 'gid://shopify/Customer/2')?.action).toBe('create')
  })

  it('does not let a mapping or write error escape the generator', async () => {
    const harness = makeHarness({ failCommand: () => true })
    await expect(runAdapter(harness, [customerNode()])).resolves.toBeDefined()
  })
})

describe('PII containment', () => {
  it('🔒 a failure errorMessage carries no email, phone or address from the fixture', async () => {
    // The stub throws a Zod-shaped message that QUOTES the email, mimicking what core really does.
    // The item must still surface a message safe for a retained, widely-readable run log.
    const harness = makeHarness({ failCommand: (call) => call.commandId === COMMAND.personCreate })
    const batches = await runAdapter(harness, [customerNode()])

    const failed = (batches.flatMap((batch) => batch.items) as { data: Record<string, unknown> }[])[0]
    const message = String(failed.data.errorMessage)

    expect(message).not.toContain(EMAIL)
    expect(message).not.toContain('ada.lovelace')
    expect(message).not.toContain(PHONE)
    expect(message).not.toContain('442071234567')
    expect(message).not.toContain(STREET)
    expect(message).not.toContain('Ada')
    expect(message).not.toContain('Lovelace')
    // It does identify the record, or the failure would be unactionable.
    expect(message).toContain('gid://shopify/Customer/1001')
  })

  it('🔒 classifyWriteFailure surfaces a validator field and rule, never the rejected value', () => {
    // The exact shape core's Zod throw takes: `issues[]`, each a field `path` + rule `code`, with a
    // `message` that QUOTES the offending value. Only the path and code may survive.
    const zodLike = {
      name: 'ZodError',
      message: `String must contain at most 150 character(s): received "${STREET}"`,
      issues: [
        { path: ['country'], code: 'too_big', maximum: 150, message: `too big "${STREET}"` },
        { path: ['postalCode'], code: 'invalid_type', message: `expected string, got "${STREET}"` },
      ],
    }
    const classified = classifyWriteFailure(zodLike)
    expect(classified).toBe('validation country:too_big,postalCode:invalid_type')
    expect(classified).not.toContain(STREET)
  })

  it('classifyWriteFailure labels a non-Zod error by class and code, not its message', () => {
    class UniqueConstraintViolationException extends Error {
      code = '23505'
      constructor(msg: string) {
        super(msg)
        this.name = 'UniqueConstraintViolationException'
      }
    }
    const classified = classifyWriteFailure(new UniqueConstraintViolationException(`Key (email)=(${EMAIL}) exists`))
    expect(classified).toBe('UniqueConstraintViolationException code=23505')
    expect(classified).not.toContain(EMAIL)
  })

  it('🔒 an address-write failure surfaces the failure shape but withholds the address', async () => {
    // Reaches the address stage (person create succeeds), then the address write throws a Zod error
    // whose message quotes the street. The item must name WHAT failed without the value.
    const harness = makeHarness({
      failCommand: (call) => call.commandId === COMMAND.addressCreate,
      failCommandError: () => ({
        name: 'ZodError',
        message: `Invalid: received "${STREET}"`,
        issues: [{ path: ['postalCode'], code: 'too_big', message: `too big "${STREET}"` }],
      }),
    })
    const batches = await runAdapter(harness, [customerNode()])
    const failed = (batches.flatMap((batch) => batch.items) as { action: string; data: Record<string, unknown> }[]).find(
      (item) => item.action === 'failed',
    )!
    const message = String(failed.data.errorMessage)

    expect(message).toContain('failed at address write')
    expect(message).toContain('validation postalCode:too_big')
    expect(message).not.toContain(STREET)
    expect(message).toContain('gid://shopify/Customer/1001')
  })

  it('🔒 no log event carries a mapped value', async () => {
    const events: CustomerSyncLogEvent[] = []
    const harness = makeHarness({
      syncedCustomers: [{ localId: 'cust-gone', externalId: 'gid://shopify/Customer/9999' }],
      owned: { [`${MAPPING_ENTITY_TYPE.customerEntity}::cust-gone`]: 'gid://shopify/Customer/9999' },
    })
    await runAdapter(
      harness,
      [
        customerNode({
          firstName: null,
          lastName: null,
          defaultPhoneNumber: { phoneNumber: '0207 123 4567' },
        }),
      ],
      {},
      (event) => events.push(event),
    )

    expect(events.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(EMAIL)
    expect(serialized).not.toContain('ada.lovelace')
    expect(serialized).not.toContain('0207')
    expect(serialized).not.toContain(STREET)
    expect(serialized).not.toContain('Lovelace')
    // Compromises are still reported — as codes.
    expect(serialized).toContain('name_synthesized')
    expect(serialized).toContain('phone_dropped_invalid')
  })

  it('🔒 a successful item reports counts and codes, not values', async () => {
    const harness = makeHarness()
    const batches = await runAdapter(harness, [customerNode()])
    const item = (batches.flatMap((batch) => batch.items) as { data: Record<string, unknown> }[])[0]

    const serialized = JSON.stringify(item.data)
    expect(serialized).not.toContain(EMAIL)
    expect(serialized).not.toContain(PHONE)
    expect(serialized).not.toContain(STREET)
    expect(item.data.addressCount).toBe(1)
  })
})

describe('delta path', () => {
  it('filters on updated_at and pairs it with the matching sort key', async () => {
    const { harness, requests } = deltaHarness([[{ node: customerNode() }]])
    const cursor = serializeCursor({ kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' })
    await runAdapter(harness, [], { cursor })

    // A typo in the search field is IGNORED by Shopify and returns EVERYTHING, so the exact string
    // is pinned rather than merely checked for plausibility.
    expect(requests[0].query).toBe("updated_at:>'2026-07-01T00:00:00.000Z'")
  })

  it('builds no filter for an empty watermark', () => {
    expect(buildUpdatedAtFilter(null)).toBeNull()
    expect(buildUpdatedAtFilter('2026-07-01T00:00:00.000Z')).toBe("updated_at:>'2026-07-01T00:00:00.000Z'")
  })

  it('pages using the endCursor and carries it in the emitted cursor', async () => {
    const { harness, requests } = deltaHarness([
      [{ node: customerNode({ id: 'gid://shopify/Customer/1' }) }],
      [{ node: customerNode({ id: 'gid://shopify/Customer/2' }) }],
    ])
    const batches = await runAdapter(harness, [], {
      cursor: serializeCursor({ kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' }),
    })

    expect(requests).toHaveLength(2)
    expect(requests[1].after).toBe('cursor-1')
    expect(parseCursor(batches[0].cursor as string)).toMatchObject({ kind: 'paging', endCursor: 'cursor-1' })
    expect(parseCursor(batches[batches.length - 1].cursor as string)?.kind).toBe('idle')
  })

  it('resumes mid-pagination from a persisted paging cursor', async () => {
    const { harness, requests } = deltaHarness([[{ node: customerNode() }]])
    await runAdapter(harness, [], {
      cursor: serializeCursor({
        kind: 'paging',
        endCursor: 'resume-here',
        pagesFetched: 3,
        updatedAfter: '2026-07-01T00:00:00.000Z',
        maxUpdatedAt: null,
      }),
    })
    expect(requests[0].after).toBe('resume-here')
  })

  it('caps the page size at Shopify ceiling regardless of the requested batch size', async () => {
    const { harness, requests } = deltaHarness([[{ node: customerNode() }]])
    await runAdapter(harness, [], {
      batchSize: 5000,
      cursor: serializeCursor({ kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' }),
    })
    expect(requests[0].first).toBe(250)
  })

  it('sends the search-debug header so Shopify populates the R-13 warnings', async () => {
    // Without the header, `extensions.search` is never populated and the warning guard passes
    // vacuously forever. The header is the thing that makes the check live.
    const { harness, headers } = deltaHarness([[{ node: customerNode() }]])
    await runAdapter(harness, [], {
      cursor: serializeCursor({ kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' }),
    })
    expect(headers[0]).toEqual(SEARCH_DEBUG_HEADER)
  })
})

describe('R-13 — a silently-ignored search filter aborts the run', () => {
  const withWatermark = serializeCursor({ kind: 'idle', updatedAfter: '2026-07-01T00:00:00.000Z' })

  it('throws — not proceeds — when Shopify reports the filter was ignored', async () => {
    // A typo'd `updated_at` is IGNORED and the whole customer base comes back. For a PII entity a
    // silent full scan is the worst runaway: it looks like a complete sync and would drive the
    // reconcile into deactivating everyone the "delta" didn't happen to include. Halt loudly.
    const { harness } = deltaHarness([[{ node: customerNode() }]], {
      extensions: { search: [{ warnings: [{ field: 'updated_at', message: 'is not a valid field' }] }] },
    })
    await expect(runAdapter(harness, [], { cursor: withWatermark })).rejects.toBeInstanceOf(CustomersSyncError)
  })

  it('writes nothing before aborting on a warning', async () => {
    // The guard runs BEFORE any customer is handled, so a poisoned scan never touches the database.
    const { harness } = deltaHarness([[{ node: customerNode() }]], {
      extensions: { search: [{ warnings: ['updated_at ignored'] }] },
    })
    await expect(runAdapter(harness, [], { cursor: withWatermark })).rejects.toBeInstanceOf(CustomersSyncError)
    expect(harness.commandCalls).toHaveLength(0)
  })

  it('catches a filter ignored in effect even when no warning is emitted (header-independent belt)', async () => {
    // Second belt: a returned row older than the window we asked for proves the filter was ignored,
    // regardless of whether Shopify emitted a warning.
    const { harness } = deltaHarness([[{ node: customerNode({ updatedAt: '2020-01-01T00:00:00Z' }) }]])
    await expect(runAdapter(harness, [], { cursor: withWatermark })).rejects.toBeInstanceOf(CustomersSyncError)
    expect(harness.commandCalls).toHaveLength(0)
  })

  it('proceeds normally when warnings are empty and the window is respected', async () => {
    const { harness } = deltaHarness([[{ node: customerNode() }]], { extensions: { search: [{ warnings: [] }] } })
    const batches = await runAdapter(harness, [], { cursor: withWatermark })
    const items = batches.flatMap((batch) => batch.items) as { action: string }[]
    expect(items[0].action).toBe('create')
  })

  it('does NOT check warnings on an unfiltered delta page, even if extensions carry them', async () => {
    // No watermark yet → no filter sent → there is nothing for Shopify to have ignored. The header
    // is still sent (harmless), but the assertion is gated on a filter actually being present.
    const { harness } = deltaHarness([[{ node: customerNode() }]], {
      extensions: { search: [{ warnings: ['this must be ignored — no filter was sent'] }] },
    })
    const batches = await runAdapter(harness, [], {
      cursor: serializeCursor({ kind: 'idle', updatedAfter: null }),
    })
    const items = batches.flatMap((batch) => batch.items) as { action: string }[]
    expect(items[0].action).toBe('create')
  })

  it('does not run either guard on the backfill path', async () => {
    // Backfill is a bulk operation, not a filtered `query:` — R-13 does not apply, and the guards
    // must not fire on it. A full sync (no cursor) that would otherwise trip the window belt imports
    // cleanly.
    const harness = makeHarness()
    const batches = await runAdapter(harness, [customerNode({ updatedAt: '2020-01-01T00:00:00Z' })])
    const items = batches.flatMap((batch) => batch.items) as { action: string }[]
    expect(items[0].action).toBe('create')
  })
})

describe('R-13 helpers', () => {
  it('reads warnings whether they are bare strings or {field,message} objects', () => {
    expect(readSearchWarnings({ search: [{ warnings: ['plain warning'] }] })).toEqual(['plain warning'])
    expect(
      readSearchWarnings({ search: [{ warnings: [{ field: 'updated_at', message: 'unknown field' }] }] }),
    ).toEqual(['updated_at: unknown field'])
  })

  it('returns nothing for a clean or malformed envelope', () => {
    expect(readSearchWarnings(undefined)).toEqual([])
    expect(readSearchWarnings({})).toEqual([])
    expect(readSearchWarnings({ search: [{ warnings: [] }] })).toEqual([])
    expect(readSearchWarnings({ search: 'not-an-array' })).toEqual([])
  })

  it('assertSearchWarningsEmpty throws only on a non-empty warning', () => {
    expect(() => assertSearchWarningsEmpty({ search: [{ warnings: [] }] })).not.toThrow()
    expect(() => assertSearchWarningsEmpty({ search: [{ warnings: ['ignored'] }] })).toThrow(CustomersSyncError)
  })

  it('assertDeltaWindowRespected throws only when a row predates the floor', () => {
    const floor = '2026-07-01T00:00:00.000Z'
    expect(() => assertDeltaWindowRespected([{ id: 'gid://shopify/Customer/1', updatedAt: '2026-07-05T00:00:00Z' }], floor)).not.toThrow()
    expect(() => assertDeltaWindowRespected([{ id: 'gid://shopify/Customer/1', updatedAt: '2020-01-01T00:00:00Z' }], floor)).toThrow(
      CustomersSyncError,
    )
    // A row with no timestamp is not evidence either way — do not throw on it.
    expect(() => assertDeltaWindowRespected([{ id: 'gid://shopify/Customer/1' }], floor)).not.toThrow()
  })

  it('the abort message names the query fault, never customer data', () => {
    // The error lands in the run log. It must explain the fault (rescan risk) with only the query
    // field and GIDs — never a name, email, phone or address.
    try {
      assertSearchWarningsEmpty({ search: [{ warnings: ['updated_at is not a valid field'] }] })
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(CustomersSyncError)
      expect((error as CustomersSyncError).message).toMatch(/rescan every customer/)
    }
  })
})

describe('content-hash skip', () => {
  it('skips an unchanged customer, and touches no addresses, when a hash store is wired', async () => {
    const hashes = new Map<string, string>()
    const harness = makeHarness({ storedHashes: hashes })
    await runAdapter(harness, [customerNode()])
    expect(hashes.size).toBe(1)

    const before = harness.commandCalls.length
    harness.mappings.set(`${MAPPING_ENTITY_TYPE.customerEntity}::gid://shopify/Customer/1001`, 'cust-1')
    const batches = await runAdapter(harness, [customerNode()])

    const items = batches.flatMap((batch) => batch.items) as { action: string }[]
    expect(items[0].action).toBe('skip')
    // No further commands: not the person, and not its addresses.
    expect(harness.commandCalls.length).toBe(before)
  })

  it('rewrites when the content changed', async () => {
    const hashes = new Map<string, string>()
    const harness = makeHarness({ storedHashes: hashes })
    await runAdapter(harness, [customerNode()])
    harness.mappings.set(`${MAPPING_ENTITY_TYPE.customerEntity}::gid://shopify/Customer/1001`, 'cust-1')

    const batches = await runAdapter(harness, [customerNode({ note: 'Now prefers pickup' })])
    const items = batches.flatMap((batch) => batch.items) as { action: string }[]
    expect(items[0].action).toBe('update')
  })

  it('always rewrites when no hash store is wired, rather than guessing', async () => {
    const harness = makeHarness()
    await runAdapter(harness, [customerNode()])
    harness.mappings.set(`${MAPPING_ENTITY_TYPE.customerEntity}::gid://shopify/Customer/1001`, 'cust-1')

    const batches = await runAdapter(harness, [customerNode()])
    const items = batches.flatMap((batch) => batch.items) as { action: string }[]
    expect(items[0].action).toBe('update')
  })
})
