import type { ShopifyClient } from '../lib/client'
import { CostTracker } from '../lib/throttle'
import {
  BULK_MUTATION_COST,
  bulkResultUrl,
  childrenOfType,
  fetchBulkOperation,
  fetchJsonlLines,
  findBulkOperations,
  isTerminalStatus,
  parseGid,
  pollBulkOperation,
  readLines,
  reassembleBulkStream,
  runBulkExport,
  ShopifyBulkError,
  submitBulkQuery,
  type BulkAnomaly,
  type BulkNode,
} from '../lib/bulk'

const gid = (type: string, id: string | number) => `gid://shopify/${type}/${id}`
const line = (record: Record<string, unknown>) => JSON.stringify(record)

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of source) items.push(item)
  return items
}

type RecordedCall = { query: string; variables?: Record<string, unknown>; estimatedCost?: number }

/** Minimal ShopifyClient standing in for the SDK. Responses are keyed by call order. */
function stubClient(responses: unknown[] | ((index: number) => unknown)) {
  const calls: RecordedCall[] = []
  const pick = typeof responses === 'function' ? responses : (i: number) => responses[i]

  const client: ShopifyClient = {
    shopDomain: 'test.myshopify.com',
    apiVersion: '2026-07',
    cost: new CostTracker(),
    async request<TData>(
      query: string,
      options?: { variables?: Record<string, unknown>; estimatedCost?: number },
    ): Promise<TData> {
      calls.push({ query, variables: options?.variables, estimatedCost: options?.estimatedCost })
      return pick(calls.length - 1) as TData
    },
  }
  return { client, calls }
}

/** UnsignedInt64 fields arrive as strings on the wire — the fixture keeps that honest. */
const operation = (overrides: Record<string, unknown> = {}) => ({
  id: gid('BulkOperation', 1),
  status: 'COMPLETED',
  errorCode: null,
  createdAt: '2026-07-20T10:00:00Z',
  completedAt: '2026-07-20T10:05:00Z',
  objectCount: '1234',
  fileSize: '99999',
  url: 'https://storage.example/result.jsonl?sig=abc',
  partialDataUrl: null,
  ...overrides,
})

/** Advancing the clock inside `sleep` keeps the timeout tests deterministic and instant. */
function fakeClock() {
  let nowMs = 0
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms
    },
  }
}

describe('parseGid', () => {
  it('splits a Shopify GID into its type and id', () => {
    expect(parseGid('gid://shopify/ProductVariant/19435458986123')).toEqual({
      type: 'ProductVariant',
      id: '19435458986123',
    })
  })

  it('keeps the query string some GIDs carry', () => {
    expect(parseGid('gid://shopify/Metafield/1?namespace=custom')?.id).toBe('1?namespace=custom')
  })

  it.each([['a bare id', '12345'], ['another scheme', 'gid://other/Product/1'], ['empty', '']])(
    'returns null for %s',
    (_label, input) => {
      expect(parseGid(input)).toBeNull()
    },
  )
})

describe('reassembleBulkStream', () => {
  it('attaches each child to the parent that precedes it', async () => {
    const nodes = await collect(
      reassembleBulkStream([
        line({ id: gid('Product', 1921569226808) }),
        line({ id: gid('ProductVariant', 19435458986123), title: '52', __parentId: gid('Product', 1921569226808) }),
        line({ id: gid('ProductVariant', 19435458986040), title: '70', __parentId: gid('Product', 1921569226808) }),
        line({ id: gid('Product', 1921569259576) }),
        line({ id: gid('ProductVariant', 5), title: 'S', __parentId: gid('Product', 1921569259576) }),
      ]),
    )

    expect(nodes.map((n) => n.id)).toEqual([gid('Product', 1921569226808), gid('Product', 1921569259576)])
    expect(childrenOfType(nodes[0], 'ProductVariant').map((v) => v.fields.title)).toEqual(['52', '70'])
    expect(childrenOfType(nodes[1], 'ProductVariant').map((v) => v.fields.title)).toEqual(['S'])
  })

  it('emits a parent that has no children at all', async () => {
    const nodes = await collect(
      reassembleBulkStream([line({ id: gid('Product', 1) }), line({ id: gid('Product', 2) })]),
    )
    expect(nodes).toHaveLength(2)
    expect(nodes[0].children).toEqual({})
    expect(childrenOfType(nodes[0], 'ProductVariant')).toEqual([])
  })

  it('branches interleaved child types by their GID prefix', async () => {
    const [product] = await collect(
      reassembleBulkStream([
        line({ id: gid('Product', 1) }),
        line({ id: gid('ProductVariant', 10), __parentId: gid('Product', 1) }),
        line({ id: gid('Metafield', 20), key: 'colour', __parentId: gid('Product', 1) }),
        line({ id: gid('ProductVariant', 11), __parentId: gid('Product', 1) }),
        line({ id: gid('Metafield', 21), key: 'fit', __parentId: gid('Product', 1) }),
      ]),
    )

    expect(Object.keys(product.children).sort()).toEqual(['Metafield', 'ProductVariant'])
    expect(childrenOfType(product, 'ProductVariant').map((n) => n.id)).toEqual([
      gid('ProductVariant', 10),
      gid('ProductVariant', 11),
    ])
    expect(childrenOfType(product, 'Metafield').map((n) => n.fields.key)).toEqual(['colour', 'fit'])
  })

  it('nests a grandchild under the child it names, not under the root', async () => {
    const [product] = await collect(
      reassembleBulkStream([
        line({ id: gid('Product', 1) }),
        line({ id: gid('ProductVariant', 10), __parentId: gid('Product', 1) }),
        line({ id: gid('Metafield', 100), key: 'weight', __parentId: gid('ProductVariant', 10) }),
        line({ id: gid('ProductVariant', 11), __parentId: gid('Product', 1) }),
      ]),
    )

    const variants = childrenOfType(product, 'ProductVariant')
    expect(variants).toHaveLength(2)
    expect(childrenOfType(variants[0], 'Metafield').map((n) => n.fields.key)).toEqual(['weight'])
    expect(childrenOfType(variants[1], 'Metafield')).toEqual([])
    expect(product.children.Metafield).toBeUndefined()
  })

  it('strips the synthetic __parentId from the record it exposes', async () => {
    const [product] = await collect(
      reassembleBulkStream([
        line({ id: gid('Product', 1) }),
        line({ id: gid('ProductVariant', 10), title: 'S', __parentId: gid('Product', 1) }),
      ]),
    )
    expect(childrenOfType(product, 'ProductVariant')[0].fields).toEqual({
      id: gid('ProductVariant', 10),
      title: 'S',
    })
  })

  it('treats a trailing newline and blank lines as formatting, not as anomalies', async () => {
    const anomalies: BulkAnomaly[] = []
    const jsonl = `${line({ id: gid('Product', 1) })}\n\n${line({ id: gid('Product', 2) })}\n`
    const nodes = await collect(
      reassembleBulkStream(jsonl.split('\n'), { onAnomaly: (a) => anomalies.push(a) }),
    )
    expect(nodes.map((n) => n.id)).toEqual([gid('Product', 1), gid('Product', 2)])
    expect(anomalies).toEqual([])
  })

  it('reports a truncated final line and still emits the records before it', async () => {
    const anomalies: BulkAnomaly[] = []
    const nodes = await collect(
      reassembleBulkStream([line({ id: gid('Product', 1) }), '{"id":"gid://shopify/Prod'], {
        onAnomaly: (a) => anomalies.push(a),
      }),
    )

    expect(nodes.map((n) => n.id)).toEqual([gid('Product', 1)])
    expect(anomalies).toEqual([
      { kind: 'truncated_line', lineNumber: 2, line: '{"id":"gid://shopify/Prod' },
    ])
  })

  it('distinguishes corruption mid-file from truncation at the end', async () => {
    const anomalies: BulkAnomaly[] = []
    const nodes = await collect(
      reassembleBulkStream([line({ id: gid('Product', 1) }), '{ oops', line({ id: gid('Product', 2) })], {
        onAnomaly: (a) => anomalies.push(a),
      }),
    )

    expect(nodes.map((n) => n.id)).toEqual([gid('Product', 1), gid('Product', 2)])
    expect(anomalies).toHaveLength(1)
    expect(anomalies[0].kind).toBe('invalid_line')
    expect(anomalies[0].lineNumber).toBe(2)
  })

  it('rejects a JSON line that is not an object', async () => {
    const anomalies: BulkAnomaly[] = []
    await collect(reassembleBulkStream(['[1,2,3]', '"text"'], { onAnomaly: (a) => anomalies.push(a) }))
    expect(anomalies.map((a) => a.kind)).toEqual(['invalid_line', 'truncated_line'])
  })

  it('reports a record with no id rather than assembling around it', async () => {
    const anomalies: BulkAnomaly[] = []
    const nodes = await collect(
      reassembleBulkStream([line({ title: 'no id here' }), line({ id: gid('Product', 1) })], {
        onAnomaly: (a) => anomalies.push(a),
      }),
    )
    expect(nodes.map((n) => n.id)).toEqual([gid('Product', 1)])
    expect(anomalies).toEqual([{ kind: 'missing_id', lineNumber: 1, line: line({ title: 'no id here' }) }])
  })

  it('surfaces a child whose parent was never seen', async () => {
    const anomalies: BulkAnomaly[] = []
    const [product] = await collect(
      reassembleBulkStream(
        [
          line({ id: gid('Product', 1) }),
          line({ id: gid('ProductVariant', 99), __parentId: gid('Product', 404) }),
        ],
        { onAnomaly: (a) => anomalies.push(a) },
      ),
    )

    expect(childrenOfType(product, 'ProductVariant')).toEqual([])
    expect(anomalies).toEqual([
      { kind: 'orphan_child', lineNumber: 2, id: gid('ProductVariant', 99), parentId: gid('Product', 404) },
    ])
  })

  it('treats a back-reference to an earlier parent as an orphan — the cost of one-parent memory', async () => {
    const anomalies: BulkAnomaly[] = []
    await collect(
      reassembleBulkStream(
        [
          line({ id: gid('Product', 1) }),
          line({ id: gid('Product', 2) }),
          line({ id: gid('ProductVariant', 10), __parentId: gid('Product', 1) }),
        ],
        { onAnomaly: (a) => anomalies.push(a) },
      ),
    )
    expect(anomalies.map((a) => a.kind)).toEqual(['orphan_child'])
  })

  it('throws by default, so tolerating a bad line has to be a deliberate choice', async () => {
    const stream = reassembleBulkStream([line({ id: gid('Product', 1) }), '{ oops', line({ id: gid('Product', 2) })])
    await expect(collect(stream)).rejects.toMatchObject({
      name: 'ShopifyBulkError',
      code: 'malformed_jsonl',
    })
  })

  it('throws by default on an orphaned child', async () => {
    const stream = reassembleBulkStream([
      line({ id: gid('Product', 1) }),
      line({ id: gid('ProductVariant', 9), __parentId: gid('Product', 404) }),
    ])
    await expect(collect(stream)).rejects.toBeInstanceOf(ShopifyBulkError)
  })

  it('yields nothing for an empty stream', async () => {
    expect(await collect(reassembleBulkStream([]))).toEqual([])
    expect(await collect(reassembleBulkStream(['', '   ']))).toEqual([])
  })
})

describe('reassembleBulkStream memory discipline', () => {
  // The proof that matters: a parent leaves the reassembler the instant the next parent's line is
  // read, so at most one parent's subtree is ever held. Anything else and a gigabyte-scale export
  // would not fit in memory.
  it('emits each parent before reading the next parent’s children', async () => {
    const trace: string[] = []
    async function* lines() {
      for (let p = 0; p < 3; p += 1) {
        trace.push(`read:P${p}`)
        yield line({ id: gid('Product', p) })
        for (let c = 0; c < 2; c += 1) {
          trace.push(`read:P${p}C${c}`)
          yield line({ id: gid('ProductVariant', `${p}${c}`), __parentId: gid('Product', p) })
        }
      }
    }

    for await (const node of reassembleBulkStream(lines())) trace.push(`emit:${node.fields.id}`)

    expect(trace).toEqual([
      'read:P0', 'read:P0C0', 'read:P0C1',
      'read:P1', `emit:${gid('Product', 0)}`, 'read:P1C0', 'read:P1C1',
      'read:P2', `emit:${gid('Product', 1)}`, 'read:P2C0', 'read:P2C1',
      `emit:${gid('Product', 2)}`,
    ])
  })

  it('has already emitted half the parents halfway through a large file', async () => {
    const PARENTS = 5_000
    const CHILDREN = 4
    let emitted = 0
    let emittedAtMidpoint = -1

    async function* lines() {
      for (let p = 0; p < PARENTS; p += 1) {
        if (p === PARENTS / 2) emittedAtMidpoint = emitted
        yield line({ id: gid('Product', p) })
        for (let c = 0; c < CHILDREN; c += 1) {
          yield line({ id: gid('ProductVariant', `${p}-${c}`), __parentId: gid('Product', p) })
        }
      }
    }

    for await (const node of reassembleBulkStream(lines())) {
      expect(childrenOfType(node, 'ProductVariant')).toHaveLength(CHILDREN)
      emitted += 1
    }

    expect(emitted).toBe(PARENTS)
    // Every parent but the one still being assembled is already downstream — nothing accumulates.
    expect(emittedAtMidpoint).toBe(PARENTS / 2 - 1)
  })

  it('reads no further than the consumer asks for', async () => {
    let produced = 0
    async function* lines() {
      for (let p = 0; p < 100_000; p += 1) {
        produced += 1
        yield line({ id: gid('Product', p) })
      }
    }

    const seen: BulkNode[] = []
    for await (const node of reassembleBulkStream(lines())) {
      seen.push(node)
      if (seen.length === 10) break
    }

    expect(seen).toHaveLength(10)
    // 11 lines: the eleventh is what proves the tenth parent had ended.
    expect(produced).toBe(11)
  })
})

describe('readLines', () => {
  const encode = (text: string) => new TextEncoder().encode(text)

  async function* chunks(...parts: Uint8Array[]) {
    for (const part of parts) yield part
  }

  it('splits on newlines and flushes a final line with no trailing newline', async () => {
    const lines = await collect(readLines(chunks(encode('one\ntwo\nthree'))))
    expect(lines).toEqual(['one', 'two', 'three'])
  })

  it('yields an empty final segment for a trailing newline rather than inventing a line', async () => {
    expect(await collect(readLines(chunks(encode('one\ntwo\n'))))).toEqual(['one', 'two'])
  })

  it('reassembles a line split across chunk boundaries', async () => {
    const lines = await collect(readLines(chunks(encode('{"id":"A"}\n{"id"'), encode(':"B"}\n'))))
    expect(lines).toEqual(['{"id":"A"}', '{"id":"B"}'])
  })

  it('keeps a multi-byte character intact when the chunk boundary lands inside it', async () => {
    const bytes = encode('{"title":"Café"}\n')
    const split = bytes.indexOf(0xc3) + 1 // between the two bytes of "é"
    const lines = await collect(readLines(chunks(bytes.slice(0, split), bytes.slice(split))))
    expect(lines).toEqual(['{"title":"Café"}'])
  })

  it('reads a ReadableStream that exposes only getReader', async () => {
    const parts = [encode('one\n'), encode('two\n')]
    let cursor = 0
    let released = 0
    const stream = {
      getReader: () => ({
        read: async () =>
          cursor < parts.length ? { done: false, value: parts[cursor++] } : { done: true, value: undefined },
        releaseLock: () => {
          released += 1
        },
      }),
    } as unknown as ReadableStream<Uint8Array>

    expect(await collect(readLines(stream))).toEqual(['one', 'two'])
    expect(released).toBe(1)
  })
})

describe('fetchJsonlLines', () => {
  const jsonl = `${line({ id: gid('Product', 1) })}\n${line({ id: gid('ProductVariant', 2), __parentId: gid('Product', 1) })}\n`

  it('streams and reassembles a downloaded result', async () => {
    const fetchImpl = async () => new Response(jsonl, { status: 200 })
    const [product] = await collect(
      reassembleBulkStream(fetchJsonlLines('https://storage.example/r.jsonl', { fetchImpl })),
    )
    expect(childrenOfType(product, 'ProductVariant')).toHaveLength(1)
  })

  it('reads a 403 as the week-long signature having lapsed', async () => {
    const fetchImpl = async () => new Response('', { status: 403 })
    await expect(collect(fetchJsonlLines('https://storage.example/r.jsonl', { fetchImpl }))).rejects.toMatchObject({
      code: 'result_url_expired',
    })
  })

  it('reports any other HTTP failure as a download failure', async () => {
    const fetchImpl = async () => new Response('', { status: 500 })
    await expect(collect(fetchJsonlLines('https://x/r.jsonl', { fetchImpl }))).rejects.toMatchObject({
      code: 'download_failed',
    })
  })

  it('wraps a network-level throw', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNRESET')
    }
    await expect(collect(fetchJsonlLines('https://x/r.jsonl', { fetchImpl }))).rejects.toMatchObject({
      code: 'download_failed',
    })
  })

  it('rejects a 200 with no body instead of reporting an empty export', async () => {
    const fetchImpl = async () => new Response(null, { status: 200 })
    await expect(collect(fetchJsonlLines('https://x/r.jsonl', { fetchImpl }))).rejects.toMatchObject({
      code: 'download_failed',
    })
  })
})

describe('submitBulkQuery', () => {
  const query = '{ products { edges { node { id } } } }'

  it('returns the created operation and prices the mutation at 10 points', async () => {
    const { client, calls } = stubClient([
      { bulkOperationRunQuery: { bulkOperation: operation({ status: 'CREATED', url: null }), userErrors: [] } },
    ])

    const created = await submitBulkQuery(client, query)
    expect(created.id).toBe(gid('BulkOperation', 1))
    expect(created.status).toBe('CREATED')
    expect(calls[0].variables).toEqual({ query })
    expect(calls[0].estimatedCost).toBe(BULK_MUTATION_COST)
  })

  it('names the already-running collision, which the caller can wait out', async () => {
    const { client } = stubClient([
      {
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [{ field: null, message: 'A bulk query operation for this app and shop is already in progress: 123.' }],
        },
      },
    ])
    await expect(submitBulkQuery(client, query)).rejects.toMatchObject({ code: 'operation_in_progress' })
  })

  it('rejects a query Shopify will not accept', async () => {
    const { client } = stubClient([
      {
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [{ field: ['query'], message: 'Bulk queries must contain exactly one connection' }],
        },
      },
    ])
    await expect(submitBulkQuery(client, query)).rejects.toMatchObject({ code: 'submit_rejected' })
  })

  it('rejects a response carrying neither an operation nor an error', async () => {
    const { client } = stubClient([{ bulkOperationRunQuery: { bulkOperation: null, userErrors: [] } }])
    await expect(submitBulkQuery(client, query)).rejects.toMatchObject({ code: 'submit_rejected' })
  })
})

describe('fetchBulkOperation', () => {
  it('coerces the UnsignedInt64 counters Shopify sends as strings', async () => {
    const { client } = stubClient([{ bulkOperation: operation() }])
    const op = await fetchBulkOperation(client, gid('BulkOperation', 1))
    expect(op?.objectCount).toBe(1234)
    expect(op?.fileSize).toBe(99999)
  })

  it('returns null when Shopify does not know the id', async () => {
    const { client } = stubClient([{ bulkOperation: null }])
    expect(await fetchBulkOperation(client, gid('BulkOperation', 9))).toBeNull()
  })
})

describe('pollBulkOperation', () => {
  const id = gid('BulkOperation', 1)

  it('polls until COMPLETED', async () => {
    const clock = fakeClock()
    const { client, calls } = stubClient([
      { bulkOperation: operation({ status: 'RUNNING', url: null, objectCount: '10' }) },
      { bulkOperation: operation({ status: 'RUNNING', url: null, objectCount: '900' }) },
      { bulkOperation: operation() },
    ])

    const progress: (number | null)[] = []
    const op = await pollBulkOperation(client, id, {
      intervalMs: 1000,
      ...clock,
      onPoll: (o) => progress.push(o.objectCount),
    })

    expect(op.status).toBe('COMPLETED')
    expect(op.url).toContain('result.jsonl')
    expect(calls).toHaveLength(3)
    expect(progress).toEqual([10, 900, 1234])
  })

  it('returns a FAILED operation with its partial data rather than throwing it away', async () => {
    const { client } = stubClient([
      {
        bulkOperation: operation({
          status: 'FAILED',
          errorCode: 'TIMEOUT',
          url: null,
          partialDataUrl: 'https://storage.example/partial.jsonl',
        }),
      },
    ])

    const op = await pollBulkOperation(client, id, { ...fakeClock() })
    expect(op.status).toBe('FAILED')
    expect(op.errorCode).toBe('TIMEOUT')
    expect(bulkResultUrl(op)).toEqual({ url: 'https://storage.example/partial.jsonl', partial: true })
  })

  it('returns EXPIRED as a terminal outcome', async () => {
    const { client } = stubClient([{ bulkOperation: operation({ status: 'EXPIRED', url: null }) }])
    const op = await pollBulkOperation(client, id, { ...fakeClock() })
    expect(op.status).toBe('EXPIRED')
    expect(bulkResultUrl(op)).toBeNull()
  })

  it('keeps polling through CANCELING until it settles on CANCELED', async () => {
    const { client, calls } = stubClient([
      { bulkOperation: operation({ status: 'CANCELING', url: null }) },
      { bulkOperation: operation({ status: 'CANCELED', url: null, partialDataUrl: 'https://x/p.jsonl' }) },
    ])
    const op = await pollBulkOperation(client, id, { intervalMs: 10, ...fakeClock() })
    expect(op.status).toBe('CANCELED')
    expect(calls).toHaveLength(2)
  })

  it('gives up once the wait outruns its budget, keeping the last state for a resume', async () => {
    const { client } = stubClient(() => ({ bulkOperation: operation({ status: 'RUNNING', url: null }) }))
    const promise = pollBulkOperation(client, id, { intervalMs: 1000, timeoutMs: 5000, ...fakeClock() })

    await expect(promise).rejects.toMatchObject({ code: 'poll_timeout' })
    await promise.catch((error: ShopifyBulkError) => {
      expect(error.operation?.status).toBe('RUNNING')
    })
  })

  it('fails fast on an unknown operation id', async () => {
    const { client } = stubClient([{ bulkOperation: null }])
    await expect(pollBulkOperation(client, id, { ...fakeClock() })).rejects.toMatchObject({
      code: 'operation_not_found',
    })
  })

  it('treats an unrecognised status as still running rather than as finished', async () => {
    const { client } = stubClient(() => ({ bulkOperation: operation({ status: 'SOMETHING_NEW', url: null }) }))
    await expect(
      pollBulkOperation(client, id, { intervalMs: 1000, timeoutMs: 2000, ...fakeClock() }),
    ).rejects.toMatchObject({ code: 'poll_timeout' })
  })
})

describe('isTerminalStatus', () => {
  it.each(['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'] as const)('%s is terminal', (status) => {
    expect(isTerminalStatus(status)).toBe(true)
  })

  it.each(['CREATED', 'RUNNING', 'CANCELING'] as const)('%s is not terminal', (status) => {
    expect(isTerminalStatus(status)).toBe(false)
  })
})

describe('bulkResultUrl', () => {
  const op = (overrides: Record<string, unknown>) => ({
    id: gid('BulkOperation', 1),
    status: 'COMPLETED' as const,
    errorCode: null,
    createdAt: null,
    completedAt: null,
    objectCount: 0,
    fileSize: null,
    url: null,
    partialDataUrl: null,
    ...overrides,
  })

  it('reads a COMPLETED operation with no url as an empty result, not a failure', () => {
    expect(bulkResultUrl(op({ objectCount: 0 }))).toBeNull()
  })

  it('marks a completed download as whole', () => {
    expect(bulkResultUrl(op({ url: 'https://x/r.jsonl' }))).toEqual({ url: 'https://x/r.jsonl', partial: false })
  })

  it('offers the partial data of a failed operation', () => {
    expect(bulkResultUrl(op({ status: 'FAILED', partialDataUrl: 'https://x/p.jsonl' }))).toEqual({
      url: 'https://x/p.jsonl',
      partial: true,
    })
  })

  it('has nothing to offer for a failure that wrote nothing', () => {
    expect(bulkResultUrl(op({ status: 'FAILED' }))).toBeNull()
  })
})

describe('findBulkOperations', () => {
  it('builds the status/type filter the deprecated currentBulkOperation used to answer', async () => {
    const { client, calls } = stubClient([
      { bulkOperations: { edges: [{ node: operation({ status: 'RUNNING', url: null }) }, { node: null }] } },
    ])

    const found = await findBulkOperations(client, { status: 'RUNNING', type: 'QUERY', first: 5 })
    expect(calls[0].variables).toEqual({ first: 5, query: 'status:RUNNING type:QUERY' })
    expect(found).toHaveLength(1)
    expect(found[0].status).toBe('RUNNING')
  })

  it('sends no filter when none is asked for', async () => {
    const { client, calls } = stubClient([{ bulkOperations: { edges: [] } }])
    expect(await findBulkOperations(client)).toEqual([])
    expect(calls[0].variables).toEqual({ first: 10, query: null })
  })
})

describe('runBulkExport', () => {
  const query = '{ products { edges { node { id } } } }'

  it('submits, waits, downloads and reassembles', async () => {
    const { client } = stubClient([
      { bulkOperationRunQuery: { bulkOperation: operation({ status: 'CREATED', url: null }), userErrors: [] } },
      { bulkOperation: operation({ status: 'RUNNING', url: null }) },
      { bulkOperation: operation() },
    ])

    const jsonl = [
      line({ id: gid('Product', 1) }),
      line({ id: gid('ProductVariant', 10), title: '52', __parentId: gid('Product', 1) }),
      line({ id: gid('Product', 2) }),
      '',
    ].join('\n')

    const requested: string[] = []
    const fetchImpl = async (url: string) => {
      requested.push(url)
      return new Response(jsonl, { status: 200 })
    }

    const exported = await runBulkExport(client, query, { intervalMs: 10, ...fakeClock(), fetchImpl })
    expect(exported.partial).toBe(false)
    expect(exported.operation.objectCount).toBe(1234)

    // Nothing is fetched until the caller iterates.
    expect(requested).toEqual([])
    const nodes = await collect(exported.nodes as AsyncIterable<BulkNode>)
    expect(requested).toEqual(['https://storage.example/result.jsonl?sig=abc'])
    expect(nodes.map((n) => n.id)).toEqual([gid('Product', 1), gid('Product', 2)])
    expect(childrenOfType(nodes[0], 'ProductVariant').map((v) => v.fields.title)).toEqual(['52'])
  })

  it('reports an empty export as completed with nothing to read', async () => {
    const { client } = stubClient([
      { bulkOperationRunQuery: { bulkOperation: operation({ status: 'CREATED', url: null }), userErrors: [] } },
      { bulkOperation: operation({ url: null, objectCount: '0' }) },
    ])

    const exported = await runBulkExport(client, query, { ...fakeClock() })
    expect(exported.nodes).toBeNull()
    expect(exported.partial).toBe(false)
  })

  it('hands back the salvageable rows of a failed operation, flagged as partial', async () => {
    const { client } = stubClient([
      { bulkOperationRunQuery: { bulkOperation: operation({ status: 'CREATED', url: null }), userErrors: [] } },
      {
        bulkOperation: operation({
          status: 'FAILED',
          errorCode: 'INTERNAL_SERVER_ERROR',
          url: null,
          partialDataUrl: 'https://storage.example/partial.jsonl',
        }),
      },
    ])

    const fetchImpl = async () => new Response(`${line({ id: gid('Product', 1) })}\n`, { status: 200 })
    const exported = await runBulkExport(client, query, { ...fakeClock(), fetchImpl })

    expect(exported.partial).toBe(true)
    expect(exported.operation.errorCode).toBe('INTERNAL_SERVER_ERROR')
    expect(await collect(exported.nodes as AsyncIterable<BulkNode>)).toHaveLength(1)
  })

  it('reports an ACCESS_DENIED failure with no partial data as nothing to read', async () => {
    const { client } = stubClient([
      { bulkOperationRunQuery: { bulkOperation: operation({ status: 'CREATED', url: null }), userErrors: [] } },
      { bulkOperation: operation({ status: 'FAILED', errorCode: 'ACCESS_DENIED', url: null }) },
    ])

    const exported = await runBulkExport(client, query, { ...fakeClock() })
    expect(exported.nodes).toBeNull()
    expect(exported.partial).toBe(true)
    expect(exported.operation.errorCode).toBe('ACCESS_DENIED')
  })
})
