import type { ImportBatch } from '@open-mercato/core/modules/data_sync/lib/adapter'
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  heartbeatBatch,
  heartbeatWhile,
  makeReconcileHeartbeat,
  type HeartbeatClock,
} from '../lib/heartbeat'

// ── Test doubles ──────────────────────────────────────────────────────────────────────────────

/** A promise whose settlement the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * A `HeartbeatClock` whose timers only fire when the test says so.
 *
 * At most one timer is live at a time (the loop registers one per iteration and cancels it on
 * settle), so `fireNext` fires the most recently registered live timer, and `pending`/`cancels`
 * expose whether anything is left dangling.
 */
function makeFakeClock() {
  type Timer = { cb: () => void; dead: boolean }
  const timers: Timer[] = []
  let cancels = 0
  const clock: HeartbeatClock = {
    setTimer: (_ms, cb) => {
      const timer: Timer = { cb, dead: false }
      timers.push(timer)
      return () => {
        if (!timer.dead) {
          timer.dead = true
          cancels += 1
        }
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
    pending: () => timers.filter((t) => !t.dead).length,
    cancels: () => cancels,
  }
}

/** Drain the microtask queue by hopping the macrotask boundary — real timers, not the fake clock. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const beatOf = (cursor: string, batchIndex: number, message?: string) => () =>
  heartbeatBatch({ cursor, batchIndex, message })

// ── heartbeatBatch ──────────────────────────────────────────────────────────────────────────

describe('heartbeatBatch', () => {
  it('is empty, keeps the cursor, marks more to come, and sets NO processedCount', () => {
    const batch = heartbeatBatch({ cursor: 'cursor-xyz', batchIndex: 7 })

    expect(batch.items).toEqual([])
    expect(batch.hasMore).toBe(true)
    expect(batch.cursor).toBe('cursor-xyz')
    expect(batch.batchIndex).toBe(7)
    // A heartbeat must add nothing to the engine's running total, and must not claim to have
    // refreshed coverage — those are the terminal batch's job.
    expect('processedCount' in batch).toBe(false)
    expect('refreshCoverageEntityTypes' in batch).toBe(false)
  })

  it('includes a message only when one is provided', () => {
    expect('message' in heartbeatBatch({ cursor: 'c', batchIndex: 0 })).toBe(false)
    expect(heartbeatBatch({ cursor: 'c', batchIndex: 0, message: 'Exporting… 12 rows' }).message).toBe(
      'Exporting… 12 rows',
    )
  })
})

// ── heartbeatWhile ──────────────────────────────────────────────────────────────────────────

describe('heartbeatWhile', () => {
  it('emits exactly one beat per tick and stops when work settles', async () => {
    const fake = makeFakeClock()
    const work = deferred<string>()
    const iterator = heartbeatWhile(work.promise, beatOf('cursor-1', 0), { clock: fake.clock })[
      Symbol.asyncIterator
    ]()

    const beats: ImportBatch[] = []
    for (let i = 0; i < 3; i += 1) {
      const pull = iterator.next()
      await flush() // let the generator register this iteration's timer
      expect(fake.fireNext()).toBe(true)
      const result = await pull
      expect(result.done).toBe(false)
      beats.push(result.value as ImportBatch)
    }

    expect(beats).toHaveLength(3)
    expect(beats.every((b) => b.items.length === 0)).toBe(true)
    expect(beats.every((b) => b.cursor === 'cursor-1')).toBe(true)

    // Settle work; the next pull must terminate with no further beat.
    work.resolve('done')
    await flush()
    const end = await iterator.next()
    expect(end.done).toBe(true)
    expect(fake.pending()).toBe(0)
  })

  it('cancels the pending timer the moment work settles, leaving no dangling handle', async () => {
    const fake = makeFakeClock()
    const work = deferred<void>()
    const iterator = heartbeatWhile(work.promise, beatOf('c', 0), { clock: fake.clock })[
      Symbol.asyncIterator
    ]()

    const pull = iterator.next()
    await flush()
    expect(fake.pending()).toBe(1) // one timer armed, not yet fired

    work.resolve()
    const end = await pull // settles via the done-handler, not the timer
    expect(end.done).toBe(true)
    expect(fake.pending()).toBe(0) // the armed timer was cancelled
    expect(fake.cancels()).toBe(1)
  })

  it('re-throws a rejected work through a trailing await, with no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const fake = makeFakeClock()
      const work = deferred<void>()
      const beats: ImportBatch[] = []

      // Consume the whole heartbeat stream; it must terminate on rejection without a beat.
      const consume = (async () => {
        for await (const batch of heartbeatWhile(work.promise, beatOf('c', 0), { clock: fake.clock })) {
          beats.push(batch)
        }
      })()

      work.reject(new Error('bulk export failed'))
      await consume

      expect(beats).toHaveLength(0)
      expect(fake.pending()).toBe(0)
      // The caller still owns the error: awaiting work re-throws it.
      await expect(work.promise).rejects.toThrow('bulk export failed')

      // Give the runtime a beat to surface any unhandled rejection it was going to.
      await flush()
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

// ── makeReconcileHeartbeat ──────────────────────────────────────────────────────────────────

describe('makeReconcileHeartbeat', () => {
  it('is not due before the interval elapses, and due exactly once after', () => {
    let clock = 1_000
    const due = makeReconcileHeartbeat({ intervalMs: 100, now: () => clock })

    expect(due()).toBe(false) // 0ms since construction
    clock = 1_099
    expect(due()).toBe(false) // 99ms < 100ms
    clock = 1_100
    expect(due()).toBe(true) // 100ms >= 100ms → fires, resets the window
    clock = 1_150
    expect(due()).toBe(false) // 50ms since the last beat
    clock = 1_200
    expect(due()).toBe(true) // 100ms again
  })
})

// ── Guard ───────────────────────────────────────────────────────────────────────────────────

describe('interval vs stale-job timeout', () => {
  it('beats comfortably inside the core 60s STALE_JOB_TIMEOUT_SECONDS window', () => {
    // @open-mercato/core progress module fails any running job whose heartbeatAt is older than
    // STALE_JOB_TIMEOUT_SECONDS (60). The beat interval MUST stay well under that or the fix does
    // not fix anything.
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBeLessThan(60_000)
  })
})
