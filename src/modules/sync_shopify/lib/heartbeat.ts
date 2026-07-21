import type { ImportBatch } from '@open-mercato/core/modules/data_sync/lib/adapter'

/**
 * Liveness heartbeats for the bulk adapters.
 *
 * The import engine refreshes `ProgressJob.heartbeatAt` only when the adapter yields a batch
 * (`updateProgress` is the sole writer of that column). Two adapter phases yield nothing for long
 * stretches — the bulk-export poll (blocked on `await runBulkExport`) and the full-sync reconcile
 * sweeps (a loop that awaits per record) — so on any real catalog they run silent for well over a
 * minute. The progress module's watchdog (`markStaleJobsFailed`, fired on every active-jobs poll)
 * then marks the still-running job `failed` once `heartbeatAt` is older than
 * `STALE_JOB_TIMEOUT_SECONDS`, freezing the count at whatever it last reached. The fix is to emit a
 * lightweight, empty-items "heartbeat" batch periodically during those phases: it refreshes
 * `heartbeatAt` and fires a progress event, and — because it carries no items and no
 * `processedCount` — it adds nothing to any tally.
 */

/**
 * Beat interval, comfortably below the progress module's `STALE_JOB_TIMEOUT_SECONDS` (60s, in
 * `@open-mercato/core` `modules/progress/lib/progressService.ts`). The engine only refreshes
 * `heartbeatAt` when a batch is yielded, so a phase that runs silent for longer than that timeout
 * is marked `failed` by `markStaleJobsFailed`. 15s keeps the job alive with a wide margin (~4
 * beats per minute) while staying cheap.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000

/**
 * An empty, side-effect-light batch whose only jobs are to refresh `heartbeatAt` and fire a
 * progress event.
 *
 * It carries **no items** (no created/updated/skipped/failed counter delta via
 * `applyImportCounters`), **no `processedCount`** (so the engine's `+= processedCount ?? items.length`
 * adds 0), and **no `refreshCoverageEntityTypes`** (coverage is refreshed once, by the real terminal
 * batch). The cursor is passed through unchanged so `commitBatchProgress` re-persists the same value
 * idempotently.
 */
export function heartbeatBatch(input: { cursor: string; batchIndex: number; message?: string }): ImportBatch {
  return {
    items: [],
    cursor: input.cursor,
    hasMore: true,
    batchIndex: input.batchIndex,
    ...(input.message ? { message: input.message } : {}),
  }
}

export type HeartbeatClock = {
  /**
   * Schedule `cb` after `ms`, returning a function that cancels it. Defaults to
   * `setTimeout`/`clearTimeout`; injected in tests so beat timing is deterministic without real
   * waits.
   */
  setTimer?: (ms: number, cb: () => void) => () => void
}

/**
 * Yield `beat()` every `intervalMs` until `work` settles, then stop.
 *
 * The caller keeps ownership of `work`'s result: this helper never consumes it, so the caller
 * awaits `work` again after the loop to obtain the value (or re-throw). A rejection handler is
 * attached here purely so a rejecting `work` is not flagged as an unhandled rejection while the
 * loop is running — the caller's later `await work` still re-throws, because attaching a `.then`
 * handler does not consume the rejection for other consumers.
 *
 * The pending timer is cancelled the instant `work` settles, so no `setTimeout` handle outlives the
 * loop.
 */
export async function* heartbeatWhile(
  work: Promise<unknown>,
  beat: () => ImportBatch,
  opts: { intervalMs?: number; clock?: HeartbeatClock } = {},
): AsyncIterable<ImportBatch> {
  const intervalMs = opts.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const setTimer =
    opts.clock?.setTimer ??
    ((ms: number, cb: () => void) => {
      const timer = setTimeout(cb, ms)
      return () => clearTimeout(timer)
    })

  let settled = false
  // Both settle paths flip the same flag. The onRejected arm is what keeps a rejecting `work` from
  // surfacing as an unhandled rejection; `done` itself never rejects, and `work` stays rejectable
  // for the caller's trailing `await`.
  const done = work.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )

  while (!settled) {
    const ticked = await new Promise<boolean>((resolve) => {
      const cancel = setTimer(intervalMs, () => resolve(true))
      // The moment work settles, clear the still-pending timer and fall through without a beat.
      void done.then(() => {
        cancel()
        resolve(false)
      })
    })
    if (ticked && !settled) yield beat()
  }
}

/**
 * A time-gated "is a beat due?" predicate for reconcile loops that await per record.
 *
 * Unlike `heartbeatWhile` (which races a timer against a single long `await`), a reconcile sweep is
 * a tight loop, so it asks this gate once per iteration and yields a beat only when at least
 * `intervalMs` has elapsed since the last one. `now` is injectable for deterministic tests.
 */
export function makeReconcileHeartbeat(opts: { intervalMs?: number; now?: () => number } = {}): () => boolean {
  const intervalMs = opts.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const now = opts.now ?? (() => Date.now())
  let last = now()
  return (): boolean => {
    const current = now()
    if (current - last >= intervalMs) {
      last = current
      return true
    }
    return false
  }
}
