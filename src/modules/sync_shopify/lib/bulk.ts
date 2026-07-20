import type { ShopifyClient } from './client'
import type { FetchImpl } from './token'

/**
 * Shopify Bulk Operations — the backfill path.
 *
 * Submit a query, poll until it finishes, download the JSONL result from a signed URL, reassemble
 * it. Bulk operations are effectively exempt from the point-based limits `throttle.ts` exists to
 * manage — 10 points for the mutation, and the scan itself is free — which makes this the only
 * sane way to export a large catalog.
 *
 * Four facts shape the design, and each of them is easy to get wrong from stale documentation:
 *
 *  1. **`currentBulkOperation` is deprecated.** Poll `bulkOperation(id:)`, or list in-flight work
 *     via `bulkOperations(first:, query: "status:RUNNING type:QUERY")`.
 *  2. **Concurrency is 5 per type per shop** (it was 1 before 2026-01), so the products,
 *     collections, customers and orders backfills can run at the same time rather than in series.
 *  3. **A failed operation may still expose `partialDataUrl`.** Discarding it turns a recoverable
 *     partial backfill into a total loss, so failures are returned for inspection, not thrown.
 *  4. **The result URL expires after one week** and operations expire after ten days — so a URL is
 *     worth downloading promptly, and a 403 from the storage host means "expired", not "denied".
 *
 * The submitted query itself must satisfy constraints this module cannot check for you: it must
 * contain a connection, at most 5 connections and at most 2 levels of nesting, every type must
 * implement `Node`, and no top-level `node`/`nodes`. Validating GraphQL text with a regex produces
 * false positives on legitimate queries, so the constraints are documented here and enforced by
 * Shopify at submission time — a violation surfaces as a `submit_rejected` user error.
 *
 * Nothing here does I/O of its own: the GraphQL calls go through an injected `ShopifyClient` and
 * the download through an injected fetch, so the whole pipeline is testable without a network.
 */

// ── Operation shape ─────────────────────────────────────────────────────────────────────────

export type BulkOperationStatus =
  | 'CREATED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELING'
  | 'CANCELED'
  | 'EXPIRED'

export type BulkOperationErrorCode = 'ACCESS_DENIED' | 'INTERNAL_SERVER_ERROR' | 'TIMEOUT'

export type BulkOperation = {
  id: string
  status: BulkOperationStatus
  errorCode: BulkOperationErrorCode | null
  createdAt: string | null
  completedAt: string | null
  /** Rows written so far. Grows while RUNNING, so it doubles as a progress signal. */
  objectCount: number | null
  fileSize: number | null
  /** Signed result URL. Null while running, and null for a COMPLETED operation that matched nothing. */
  url: string | null
  /** Whatever the operation managed to write before failing or being cancelled. */
  partialDataUrl: string | null
}

export type BulkErrorCode =
  | 'submit_rejected'
  | 'operation_in_progress'
  | 'operation_not_found'
  | 'poll_timeout'
  | 'download_failed'
  | 'result_url_expired'
  | 'malformed_jsonl'

export class ShopifyBulkError extends Error {
  readonly code: BulkErrorCode
  /** Last known state of the operation, so a caller can resume or salvage rather than restart. */
  readonly operation: BulkOperation | null
  constructor(code: BulkErrorCode, message: string, operation: BulkOperation | null = null) {
    super(message)
    this.name = 'ShopifyBulkError'
    this.code = code
    this.operation = operation
  }
}

// ── Assembled records ───────────────────────────────────────────────────────────────────────

/**
 * One record from the export, with its children attached.
 *
 * Children are grouped by the type segment of their GID (`gid://shopify/ProductVariant/1` →
 * `ProductVariant`) because a parent routinely carries several child collections at once — a
 * product's variants and its metafields arrive interleaved on the same stream, distinguishable
 * only by that prefix.
 */
export type BulkNode = {
  id: string
  /** Type segment of the GID, e.g. `Product`. */
  type: string
  /** The record exactly as it appeared on the line, less the synthetic `__parentId`. */
  fields: Record<string, unknown>
  children: Record<string, BulkNode[]>
}

/**
 * A line the reassembler could not use. Never dropped silently — a bulk export that quietly loses
 * records still reports success, which is the failure mode worth engineering against.
 */
export type BulkAnomaly =
  | { kind: 'invalid_line'; lineNumber: number; line: string; error: string }
  | { kind: 'truncated_line'; lineNumber: number; line: string }
  | { kind: 'missing_id'; lineNumber: number; line: string }
  | { kind: 'orphan_child'; lineNumber: number; id: string; parentId: string }

// ── Tuning ──────────────────────────────────────────────────────────────────────────────────

/** Cost of `bulkOperationRunQuery` itself. The scan it starts is not metered. */
export const BULK_MUTATION_COST = 10

export const DEFAULT_POLL_INTERVAL_MS = 5_000

/**
 * Shopify allows an operation ten days; a caller waiting that long has other problems. An hour is
 * a sane library default for a catalog-sized export — raise it explicitly for a bigger one.
 */
export const DEFAULT_POLL_TIMEOUT_MS = 60 * 60 * 1000

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ── GraphQL documents ───────────────────────────────────────────────────────────────────────

const OPERATION_FIELDS = `
    id
    status
    errorCode
    createdAt
    completedAt
    objectCount
    fileSize
    url
    partialDataUrl
`

const BULK_RUN_QUERY = `#graphql
  mutation SyncShopifyBulkRunQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation {${OPERATION_FIELDS}      }
      userErrors { field message }
    }
  }
`

const BULK_OPERATION_QUERY = `#graphql
  query SyncShopifyBulkOperation($id: ID!) {
    bulkOperation(id: $id) {${OPERATION_FIELDS}    }
  }
`

const BULK_OPERATIONS_QUERY = `#graphql
  query SyncShopifyBulkOperations($first: Int!, $query: String) {
    bulkOperations(first: $first, query: $query) {
      edges { node {${OPERATION_FIELDS}      } }
    }
  }
`

// ── GID handling ────────────────────────────────────────────────────────────────────────────

const GID_PATTERN = /^gid:\/\/shopify\/([A-Za-z0-9_]+)\/(.+)$/

/** Split `gid://shopify/Product/123` into its type and id. Null for anything else. */
export function parseGid(gid: string): { type: string; id: string } | null {
  const match = GID_PATTERN.exec(gid)
  if (!match) return null
  return { type: match[1], id: match[2] }
}

/** Children of one GID type, or an empty array — saves every caller writing the `?? []`. */
export function childrenOfType(node: BulkNode, type: string): BulkNode[] {
  return node.children[type] ?? []
}

// ── Operation queries ───────────────────────────────────────────────────────────────────────

const KNOWN_STATUSES: readonly string[] = [
  'CREATED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELING',
  'CANCELED',
  'EXPIRED',
]

/** CANCELING is deliberately absent: it is a transition, and settles into CANCELED. */
const TERMINAL_STATUSES: readonly BulkOperationStatus[] = ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED']

export function isTerminalStatus(status: BulkOperationStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/**
 * Read an operation defensively, the way `parseCost` reads a cost block.
 *
 * `objectCount` and `fileSize` are `UnsignedInt64`, which JSON-encodes as a *string* — comparing
 * one numerically without coercion silently misbehaves.
 */
function normalizeOperation(raw: unknown): BulkOperation | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return null

  const rawStatus = typeof record.status === 'string' ? record.status.toUpperCase() : ''
  // An unrecognised status is treated as still running. That is the safe direction: polling
  // continues and eventually fails loudly on timeout, rather than declaring an unfinished export
  // complete and importing a truncated catalog.
  const status = (KNOWN_STATUSES.includes(rawStatus) ? rawStatus : 'RUNNING') as BulkOperationStatus

  const str = (key: string): string | null =>
    typeof record[key] === 'string' && record[key] !== '' ? (record[key] as string) : null
  const num = (key: string): number | null => {
    const value = Number(record[key])
    return Number.isFinite(value) ? value : null
  }

  return {
    id: record.id,
    status,
    errorCode: str('errorCode') as BulkOperationErrorCode | null,
    createdAt: str('createdAt'),
    completedAt: str('completedAt'),
    objectCount: num('objectCount'),
    fileSize: num('fileSize'),
    url: str('url'),
    partialDataUrl: str('partialDataUrl'),
  }
}

export type BulkRequestOptions = {
  signal?: AbortSignal
}

type RunQueryData = {
  bulkOperationRunQuery?: {
    bulkOperation?: unknown
    userErrors?: { field?: string[] | null; message?: string }[]
  }
}

/** Start a bulk export. Returns the created operation; the scan runs asynchronously from here. */
export async function submitBulkQuery(
  client: ShopifyClient,
  query: string,
  options: BulkRequestOptions = {},
): Promise<BulkOperation> {
  const data = await client.request<RunQueryData>(BULK_RUN_QUERY, {
    variables: { query },
    estimatedCost: BULK_MUTATION_COST,
    signal: options.signal,
  })

  const payload = data?.bulkOperationRunQuery
  const userErrors = payload?.userErrors ?? []
  if (userErrors.length > 0) {
    const message = userErrors.map((e) => e?.message).filter(Boolean).join('; ')
    // `UserError` carries no code here, so the message text is the only discriminator available.
    // Worth matching on precisely because this one is actionable: the caller can wait for the
    // in-flight operation and reuse its result rather than treating the run as failed.
    const inProgress = /already in progress|operation in progress/i.test(message)
    throw new ShopifyBulkError(
      inProgress ? 'operation_in_progress' : 'submit_rejected',
      `[internal] bulkOperationRunQuery rejected: ${message || 'unknown user error'}`,
    )
  }

  const operation = normalizeOperation(payload?.bulkOperation)
  if (!operation) {
    throw new ShopifyBulkError('submit_rejected', '[internal] bulkOperationRunQuery returned no operation')
  }
  return operation
}

/** Current state of one operation. Null when Shopify does not know the id. */
export async function fetchBulkOperation(
  client: ShopifyClient,
  id: string,
  options: BulkRequestOptions = {},
): Promise<BulkOperation | null> {
  const data = await client.request<{ bulkOperation?: unknown }>(BULK_OPERATION_QUERY, {
    variables: { id },
    estimatedCost: 1,
    signal: options.signal,
  })
  return normalizeOperation(data?.bulkOperation)
}

/**
 * In-flight operations, for resuming after a crash rather than submitting a duplicate.
 *
 * Concurrency is 5 per type per shop, so finding one running does not mean the shop is busy — it
 * means *this* export may already be underway.
 */
export async function findBulkOperations(
  client: ShopifyClient,
  options: BulkRequestOptions & {
    first?: number
    status?: BulkOperationStatus
    type?: 'QUERY' | 'MUTATION'
  } = {},
): Promise<BulkOperation[]> {
  const filters = [
    options.status ? `status:${options.status}` : null,
    options.type ? `type:${options.type}` : null,
  ].filter(Boolean)

  const data = await client.request<{ bulkOperations?: { edges?: { node?: unknown }[] } }>(
    BULK_OPERATIONS_QUERY,
    {
      variables: { first: options.first ?? 10, query: filters.length > 0 ? filters.join(' ') : null },
      estimatedCost: 2,
      signal: options.signal,
    },
  )

  const edges = data?.bulkOperations?.edges ?? []
  return edges
    .map((edge) => normalizeOperation(edge?.node))
    .filter((operation): operation is BulkOperation => operation !== null)
}

export type PollOptions = BulkRequestOptions & {
  intervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Called on every poll — `objectCount` climbs while RUNNING, which is the only progress signal. */
  onPoll?: (operation: BulkOperation) => void
}

/**
 * Poll until the operation reaches a terminal status.
 *
 * Returns FAILED, CANCELED and EXPIRED rather than throwing: each needs a different response from
 * the caller, and a FAILED operation is frequently still worth reading via `partialDataUrl`.
 * Only a genuine dead end — an unknown id, or a wait that outran its budget — raises.
 */
export async function pollBulkOperation(
  client: ShopifyClient,
  id: string,
  options: PollOptions = {},
): Promise<BulkOperation> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => Date.now())

  const startedAtMs = now()
  let last: BulkOperation | null = null

  for (;;) {
    options.signal?.throwIfAborted()

    const operation = await fetchBulkOperation(client, id, { signal: options.signal })
    if (!operation) {
      throw new ShopifyBulkError('operation_not_found', `[internal] no bulk operation with id ${id}`, last)
    }

    last = operation
    options.onPoll?.(operation)
    if (isTerminalStatus(operation.status)) return operation

    if (now() - startedAtMs >= timeoutMs) {
      throw new ShopifyBulkError(
        'poll_timeout',
        `[internal] bulk operation ${id} still ${operation.status} after ${timeoutMs}ms`,
        operation,
      )
    }
    await sleep(intervalMs)
  }
}

/**
 * Where to read this operation's rows, and whether they are complete.
 *
 * Two cases that look like failures but are not: a COMPLETED operation whose query matched nothing
 * has no `url` at all, and a FAILED one usually still has everything it wrote before dying.
 */
export function bulkResultUrl(operation: BulkOperation): { url: string; partial: boolean } | null {
  if (operation.status === 'COMPLETED') {
    return operation.url ? { url: operation.url, partial: false } : null
  }
  return operation.partialDataUrl ? { url: operation.partialDataUrl, partial: true } : null
}

// ── Downloading ─────────────────────────────────────────────────────────────────────────────

type ByteSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>

async function* readChunks(source: ByteSource): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in source) {
    yield* source as AsyncIterable<Uint8Array>
    return
  }
  const reader = (source as ReadableStream<Uint8Array>).getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Split a byte stream into lines without holding the whole thing.
 *
 * The decoder is stateful on purpose: a multi-byte character straddling two chunks would otherwise
 * decode as two replacement characters and corrupt the line it sits on.
 */
export async function* readLines(source: ByteSource): AsyncIterable<string> {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  for await (const chunk of readChunks(source)) {
    buffer += decoder.decode(chunk, { stream: true })
    let start = 0
    let newline = buffer.indexOf('\n', start)
    while (newline !== -1) {
      yield buffer.slice(start, newline)
      start = newline + 1
      newline = buffer.indexOf('\n', start)
    }
    if (start > 0) buffer = buffer.slice(start)
  }

  buffer += decoder.decode()
  if (buffer !== '') yield buffer
}

export type DownloadOptions = BulkRequestOptions & {
  fetchImpl?: FetchImpl
}

/**
 * Stream the JSONL result from its signed URL.
 *
 * No timeout is imposed: a large export legitimately takes minutes to download, and an
 * `AbortSignal.timeout` sized for a request would kill it mid-stream. Pass `signal` to bound it.
 */
export async function* fetchJsonlLines(url: string, options: DownloadOptions = {}): AsyncIterable<string> {
  const doFetch = options.fetchImpl ?? (globalThis.fetch as FetchImpl)

  let response: Response
  try {
    response = await doFetch(url, { signal: options.signal })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ShopifyBulkError('download_failed', `[internal] bulk result download failed: ${message}`)
  }

  if (!response.ok) {
    // The signature on the result URL lapses after a week, and the storage host answers an expired
    // one with a flat 403 — which reads as a permissions problem unless you know to expect it.
    const expired = response.status === 403 || response.status === 404
    throw new ShopifyBulkError(
      expired ? 'result_url_expired' : 'download_failed',
      `[internal] bulk result download returned HTTP ${response.status}`,
    )
  }
  if (!response.body) {
    throw new ShopifyBulkError('download_failed', '[internal] bulk result response carried no body')
  }

  yield* readLines(response.body as ReadableStream<Uint8Array>)
}

// ── Reassembly ──────────────────────────────────────────────────────────────────────────────

export type ReassembleOptions = {
  /**
   * Handle an unusable line. Omit it and anomalies throw — a bulk export that silently drops rows
   * still reports success, so tolerating one has to be a decision somebody made on purpose.
   */
  onAnomaly?: (anomaly: BulkAnomaly) => void
}

function throwOnAnomaly(anomaly: BulkAnomaly): never {
  const detail =
    anomaly.kind === 'orphan_child'
      ? `child ${anomaly.id} references unseen parent ${anomaly.parentId}`
      : `${anomaly.kind} at line ${anomaly.lineNumber}`
  throw new ShopifyBulkError('malformed_jsonl', `[internal] unusable bulk JSONL: ${detail}`)
}

function toNode(id: string, record: Record<string, unknown>): BulkNode {
  // `__parentId` is injected by Shopify and is not a queryable field, so it is structural rather
  // than data — dropping it keeps `fields` an honest picture of what the query asked for.
  const { __parentId: _parentId, ...fields } = record
  return { id, type: parseGid(id)?.type ?? 'Unknown', fields, children: {} }
}

/**
 * Reassemble flat JSONL into parents carrying their children, in a single pass.
 *
 * Shopify guarantees a parent precedes its children and preserves connection order, which is what
 * makes this possible without buffering: only the current parent's subtree is held, and it is
 * emitted the moment the next top-level record appears. A store's export runs to gigabytes, so
 * accumulating even the assembled parents would defeat the point of using bulk operations at all.
 *
 * The subtree index — rather than a single remembered id — is what supports the second level of
 * nesting the API permits, where a grandchild's `__parentId` points at a child rather than at the
 * top-level record. It is bounded by one parent's fan-out, which is the unit being emitted anyway.
 */
export async function* reassembleBulkStream(
  lines: AsyncIterable<string> | Iterable<string>,
  options: ReassembleOptions = {},
): AsyncIterable<BulkNode> {
  const onAnomaly = options.onAnomaly ?? throwOnAnomaly

  let root: BulkNode | null = null
  let index = new Map<string, BulkNode>()
  let held: { lineNumber: number; line: string; error: string } | null = null
  let lineNumber = 0

  for await (const raw of lines) {
    lineNumber += 1
    const line = raw.trim()
    // Blank lines and the trailing newline are formatting, not data.
    if (line === '') continue

    // A line that fails to parse is only *truncated* if nothing follows it, so judgement is
    // deferred by exactly one line. Anything else is corruption in the middle of the file.
    if (held) {
      onAnomaly({ kind: 'invalid_line', ...held })
      held = null
    }

    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('line is not a JSON object')
      }
      record = parsed as Record<string, unknown>
    } catch (error) {
      held = { lineNumber, line, error: error instanceof Error ? error.message : String(error) }
      continue
    }

    const id = typeof record.id === 'string' ? record.id : ''
    if (id === '') {
      // Every bulk-queryable type implements `Node`, so a record without an id is not something
      // the query could have produced.
      onAnomaly({ kind: 'missing_id', lineNumber, line })
      continue
    }

    const parentId = typeof record.__parentId === 'string' ? record.__parentId : null
    const node = toNode(id, record)

    if (!parentId) {
      if (root) yield root
      root = node
      index = new Map([[id, node]])
      continue
    }

    const parent = index.get(parentId)
    if (!parent) {
      // Parents always precede their children, so an unknown parent means the parent line was lost
      // or the stream was joined mid-file. Attaching the child anywhere else would invent data.
      onAnomaly({ kind: 'orphan_child', lineNumber, id, parentId })
      continue
    }

    ;(parent.children[node.type] ??= []).push(node)
    index.set(id, node)
  }

  if (held) onAnomaly({ kind: 'truncated_line', lineNumber: held.lineNumber, line: held.line })
  if (root) yield root
}

// ── End to end ──────────────────────────────────────────────────────────────────────────────

export type BulkExportOptions = PollOptions & DownloadOptions & ReassembleOptions

export type BulkExport = {
  operation: BulkOperation
  /** Rows came from `partialDataUrl`: the operation did not finish cleanly. */
  partial: boolean
  /** Null when there is nothing to read — an empty result set, or a failure with no partial data. */
  nodes: AsyncIterable<BulkNode> | null
}

/**
 * Submit, wait, and open the result for streaming.
 *
 * The stream is lazy — nothing is downloaded until the caller iterates `nodes` — so a caller that
 * inspects `operation` first and decides against a partial result pays nothing for it.
 */
export async function runBulkExport(
  client: ShopifyClient,
  query: string,
  options: BulkExportOptions = {},
): Promise<BulkExport> {
  const submitted = await submitBulkQuery(client, query, options)
  const operation = await pollBulkOperation(client, submitted.id, options)
  const result = bulkResultUrl(operation)

  if (!result) {
    return { operation, partial: operation.status !== 'COMPLETED', nodes: null }
  }
  return {
    operation,
    partial: result.partial,
    nodes: reassembleBulkStream(fetchJsonlLines(result.url, options), options),
  }
}
