/**
 * Cursor codec for the Shopify sync adapters.
 *
 * Core owns cursor *persistence* — `SyncCursor` rows, rewritten by `commitBatchProgress` after
 * every batch — so all we own is the encoding. Outside this file a cursor is an opaque string.
 *
 * Shopify needs a wider shape than Akeneo's `nextUrl`, because there are two ways to read a
 * collection and a run can die inside either:
 *
 *   `paging`  mid-pagination, holding a GraphQL `endCursor`
 *   `bulk`    a bulk operation still running server-side, held by its GID
 *   `idle`    neither — just the watermark that makes the NEXT run incremental
 *
 * The transition that matters is `paging|bulk → idle`. When a run ends, the highest `updatedAt` it
 * observed is promoted into `updatedAfter` and becomes the next run's `updated_at:>…` filter. Both
 * ways of getting that wrong are quiet: too high skips records permanently, too low turns every
 * delta into a full scan that still reports success.
 *
 * Nothing here trusts what it reads back. A persisted cursor may have been written by an older
 * version of this package, truncated, or hand-edited, so every field is re-validated on the way in
 * and a cursor that fails is discarded whole rather than half-believed.
 */

/**
 * Stamped into every serialized cursor. Bump it when the state shape changes incompatibly — older
 * cursors then parse as null, which costs one full re-scan instead of being misread as valid.
 */
export const CURSOR_VERSION = 1

/** Bulk operation GIDs are stable API surface. A wrong id here polls for something never found. */
export const BULK_OPERATION_GID_PREFIX = 'gid://shopify/BulkOperation/'

/**
 * Ceiling on the tracked page count. No real run approaches it; it exists so a corrupted number
 * cannot be carried forward as `Infinity` and read as progress.
 */
const MAX_TRACKED_PAGES = 1_000_000

/**
 * ISO-8601, and a time component MUST carry an explicit zone.
 *
 * `Date.parse('2026-07-20T10:30')` resolves against the *host's* timezone, so an unzoned cursor
 * would name a different instant on the worker that reads it than on the one that wrote it. Shopify
 * always returns a zoned timestamp, so anything unzoned is corruption. A bare date is allowed
 * because the spec pins date-only forms to UTC.
 *
 * Full anchoring also keeps `Date.parse`'s legacy fallback — which happily accepts `2026` and
 * `March 5, 2026` — from smuggling in a watermark we never wrote.
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/

type Watermark = {
  /** Lower bound of the window this run is reading. Fixed for the run's duration. */
  updatedAfter: string | null
  /** Highest `updatedAt` seen so far in this run; becomes `updatedAfter` once the run ends. */
  maxUpdatedAt: string | null
}

export type ShopifyCursorState =
  | ({
      kind: 'paging'
      endCursor: string
      /**
       * Deep pagination saturates at 25,001 objects, past which the adapter must switch to a bulk
       * operation. The count lives in the cursor because a run resumed in a fresh worker would
       * otherwise restart it at zero and never notice the ceiling coming.
       */
      pagesFetched: number
    } & Watermark)
  | ({ kind: 'bulk'; bulkOperationId: string } & Watermark)
  | { kind: 'idle'; updatedAfter: string | null }

/** Where a run has got to, or `null`/absent for "finished" — which is what triggers promotion. */
export type CursorPointer =
  | { kind: 'paging'; endCursor: string }
  | { kind: 'bulk'; bulkOperationId: string }

export type CursorAdvance = {
  next?: CursorPointer | null
  /** Highest `updatedAt` observed in the batch just processed. */
  maxUpdatedAt?: string | null
}

/**
 * Canonical UTC, because comparison decides what gets skipped. `2026-07-20T10:00:00Z` and
 * `2026-07-20T11:00:00+01:00` are the same instant yet order wrongly as strings, so every
 * timestamp is rewritten to one form before it is ever compared or stored.
 */
export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!ISO_TIMESTAMP.test(trimmed)) return null
  const ms = Date.parse(trimmed)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** Later of two timestamps, tolerating either being absent or unparseable. */
function maxTimestamp(a: unknown, b: unknown): string | null {
  const left = normalizeTimestamp(a)
  const right = normalizeTimestamp(b)
  if (!left) return right
  if (!right) return left
  return Date.parse(left) >= Date.parse(right) ? left : right
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeBulkOperationId(value: unknown): string | null {
  const id = normalizeString(value)
  return id && id.startsWith(BULK_OPERATION_GID_PREFIX) ? id : null
}

function clampPageCount(value: unknown): number {
  const count = Number(value)
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.min(MAX_TRACKED_PAGES, Math.floor(count))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rebuild a state field by field from untrusted input, dropping anything unrecognised.
 *
 * A missing pointer collapses the whole cursor to null rather than degrading to a watermark: we
 * cannot resume where we left off, and pretending the window was fully read would step over every
 * record the interrupted run never reached. Restarting re-reads work; it cannot lose any.
 */
function normalizeState(value: unknown): ShopifyCursorState | null {
  if (!isRecord(value)) return null

  const updatedAfter = normalizeTimestamp(value.updatedAfter)
  const maxUpdatedAt = normalizeTimestamp(value.maxUpdatedAt)

  switch (value.kind) {
    case 'paging': {
      const endCursor = normalizeString(value.endCursor)
      if (!endCursor) return null
      return {
        kind: 'paging',
        endCursor,
        pagesFetched: clampPageCount(value.pagesFetched),
        updatedAfter,
        maxUpdatedAt,
      }
    }
    case 'bulk': {
      const bulkOperationId = normalizeBulkOperationId(value.bulkOperationId)
      if (!bulkOperationId) return null
      return { kind: 'bulk', bulkOperationId, updatedAfter, maxUpdatedAt }
    }
    case 'idle':
      return { kind: 'idle', updatedAfter }
    default:
      return null
  }
}

/**
 * Encode for persistence. Normalises on the way out too, so `parseCursor(serializeCursor(s))` is
 * stable for any state a caller can construct.
 */
export function serializeCursor(state: ShopifyCursorState): string {
  // A typed state can still hold a value TypeScript cannot reject — a blank `endCursor`, a
  // timestamp from a hand-written fixture. Writing it through unchanged makes the next parse
  // reject it, which restarts the run: wasteful, never lossy.
  return JSON.stringify({ v: CURSOR_VERSION, ...(normalizeState(state) ?? state) })
}

/** Decode a persisted cursor. Returns null — "start fresh" — for anything it cannot fully trust. */
export function parseCursor(raw: string | null | undefined): ShopifyCursorState | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return null
  }

  if (!isRecord(decoded)) return null
  if (decoded.v !== CURSOR_VERSION) return null
  return normalizeState(decoded)
}

/** `maxUpdatedAt` only exists while a run is in flight; an `idle` cursor has already promoted it. */
function inFlightMaxUpdatedAt(state: ShopifyCursorState | null): string | null {
  return state && state.kind !== 'idle' ? state.maxUpdatedAt : null
}

function pagesFetched(state: ShopifyCursorState | null): number {
  return state?.kind === 'paging' ? state.pagesFetched : 0
}

/**
 * Fold one batch into the cursor. This is where paging becomes incremental.
 *
 * Pass `next` while the run continues and omit it when it ends; the watermark is promoted on that
 * transition and only then. `current` may be null on a first-ever run.
 */
export function advanceCursor(current: ShopifyCursorState | null, advance: CursorAdvance): ShopifyCursorState {
  const updatedAfter = normalizeTimestamp(current?.updatedAfter)
  const seen = maxTimestamp(inFlightMaxUpdatedAt(current), advance.maxUpdatedAt)

  if (advance.next) {
    if (advance.next.kind === 'paging') {
      const endCursor = normalizeString(advance.next.endCursor)
      if (endCursor) {
        return {
          kind: 'paging',
          endCursor,
          pagesFetched: clampPageCount(pagesFetched(current) + 1),
          updatedAfter,
          maxUpdatedAt: seen,
        }
      }
    } else {
      const bulkOperationId = normalizeBulkOperationId(advance.next.bulkOperationId)
      if (bulkOperationId) {
        return { kind: 'bulk', bulkOperationId, updatedAfter, maxUpdatedAt: seen }
      }
    }
    // The caller says the run continues but handed over a pointer we cannot resume from. Park
    // without promoting, so the next run repeats this window rather than stepping over the
    // records it never reached.
    return { kind: 'idle', updatedAfter }
  }

  // Run finished. `maxTimestamp` rather than a plain overwrite keeps the watermark monotonic: a
  // run that matched nothing leaves it untouched, and a batch reporting a stale `updatedAt` — the
  // shape an invalid search filter produces when Shopify silently returns the whole catalog —
  // cannot rewind it into re-importing everything.
  return { kind: 'idle', updatedAfter: maxTimestamp(updatedAfter, seen) }
}
