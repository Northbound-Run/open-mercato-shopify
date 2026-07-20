import {
  BULK_OPERATION_GID_PREFIX,
  CURSOR_VERSION,
  advanceCursor,
  normalizeTimestamp,
  parseCursor,
  serializeCursor,
  type ShopifyCursorState,
} from '../lib/cursor'

const BULK_GID = `${BULK_OPERATION_GID_PREFIX}987654321`

/** Build a wire-format cursor directly, to test what parse does with bytes we did not write. */
const wire = (fields: Record<string, unknown>) => JSON.stringify({ v: CURSOR_VERSION, ...fields })

describe('round-tripping', () => {
  it('preserves a paging state', () => {
    const state: ShopifyCursorState = {
      kind: 'paging',
      endCursor: 'eyJsYXN0X2lkIjo0MDkzNDE5fQ==',
      pagesFetched: 7,
      updatedAfter: '2026-07-19T00:00:00.000Z',
      maxUpdatedAt: '2026-07-20T09:15:00.000Z',
    }
    expect(parseCursor(serializeCursor(state))).toEqual(state)
  })

  it('preserves a bulk state', () => {
    const state: ShopifyCursorState = {
      kind: 'bulk',
      bulkOperationId: BULK_GID,
      updatedAfter: '2026-07-19T00:00:00.000Z',
      maxUpdatedAt: null,
    }
    expect(parseCursor(serializeCursor(state))).toEqual(state)
  })

  it('preserves an idle state', () => {
    const state: ShopifyCursorState = { kind: 'idle', updatedAfter: '2026-07-20T09:15:00.000Z' }
    expect(parseCursor(serializeCursor(state))).toEqual(state)
  })

  it('preserves the empty watermark a first-ever run leaves behind', () => {
    const state: ShopifyCursorState = { kind: 'idle', updatedAfter: null }
    expect(parseCursor(serializeCursor(state))).toEqual(state)
  })

  it('stamps the version and canonicalises timestamps on the way out', () => {
    const raw = serializeCursor({ kind: 'idle', updatedAfter: '2026-07-20T11:30:00+01:00' })
    expect(JSON.parse(raw)).toEqual({
      v: CURSOR_VERSION,
      kind: 'idle',
      updatedAfter: '2026-07-20T10:30:00.000Z',
    })
  })

  it('is idempotent, so re-committing a cursor cannot drift', () => {
    const once = serializeCursor({ kind: 'paging', endCursor: 'abc', pagesFetched: 1, updatedAfter: '2026-07-20', maxUpdatedAt: null })
    const twice = serializeCursor(parseCursor(once) as ShopifyCursorState)
    expect(twice).toBe(once)
  })
})

describe('parseCursor rejection', () => {
  // Any of these means "start fresh". Returning a partially-populated state instead would let a
  // corrupted cursor decide which records get skipped.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a non-JSON string', 'nope'],
    ['a JSON array', '[]'],
    ['a JSON string scalar', '"2026-07-20"'],
    ['a JSON number', '123'],
    ['JSON null', 'null'],
    ['truncated JSON', '{"v":1,"kind":"pag'],
    ['an object with no kind', wire({ updatedAfter: '2026-07-20T00:00:00Z' })],
    ['an unknown kind', wire({ kind: 'streaming', updatedAfter: null })],
    ['a paging state with no endCursor', wire({ kind: 'paging', updatedAfter: null })],
    ['a paging state with a blank endCursor', wire({ kind: 'paging', endCursor: '   ' })],
    ['a paging state with a non-string endCursor', wire({ kind: 'paging', endCursor: 42 })],
    ['a bulk state with no id', wire({ kind: 'bulk', updatedAfter: null })],
    ['a bulk state whose GID is for another type', wire({ kind: 'bulk', bulkOperationId: 'gid://shopify/Product/1' })],
    ['a bulk state with a bare numeric id', wire({ kind: 'bulk', bulkOperationId: '987654321' })],
  ])('returns null for %s', (_label, input) => {
    expect(parseCursor(input)).toBeNull()
  })

  it('rejects a future version rather than reading it as this one', () => {
    const raw = JSON.stringify({ v: CURSOR_VERSION + 1, kind: 'idle', updatedAfter: '2026-07-20T00:00:00Z' })
    expect(parseCursor(raw)).toBeNull()
  })

  it('rejects a cursor written before versioning', () => {
    expect(parseCursor(JSON.stringify({ kind: 'idle', updatedAfter: '2026-07-20T00:00:00Z' }))).toBeNull()
    expect(parseCursor(JSON.stringify({ v: '1', kind: 'idle' }))).toBeNull()
  })
})

describe('parseCursor normalisation', () => {
  it('drops keys it does not recognise', () => {
    const raw = wire({ kind: 'idle', updatedAfter: '2026-07-20T00:00:00Z', nextUrl: 'https://akeneo.test' })
    expect(parseCursor(raw)).toEqual({ kind: 'idle', updatedAfter: '2026-07-20T00:00:00.000Z' })
  })

  it('does not carry a polluted prototype out of the persisted JSON', () => {
    // `JSON.parse` makes `__proto__` a real own property, unlike an object literal. Rebuilding the
    // state field by field is what keeps that from being spread onto anything.
    const parsed = parseCursor('{"v":1,"kind":"idle","updatedAfter":null,"__proto__":{"polluted":true}}')
    expect(parsed).toEqual({ kind: 'idle', updatedAfter: null })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('treats an empty-string timestamp as absent', () => {
    expect(parseCursor(wire({ kind: 'idle', updatedAfter: '' }))).toEqual({ kind: 'idle', updatedAfter: null })
  })

  it.each([
    ['a negative count', -5, 0],
    ['a non-numeric count', 'many', 0],
    ['a missing count', undefined, 0],
    ['a fractional count', 3.9, 3],
    ['a numeric string', '12', 12],
    ['an absurd count', 1e30, 1_000_000],
  ])('clamps %s', (_label, pagesFetched, expected) => {
    const parsed = parseCursor(wire({ kind: 'paging', endCursor: 'abc', pagesFetched }))
    expect(parsed).toMatchObject({ kind: 'paging', pagesFetched: expected })
  })

  it('trims a padded endCursor', () => {
    expect(parseCursor(wire({ kind: 'paging', endCursor: '  abc  ' }))).toMatchObject({ endCursor: 'abc' })
  })
})

describe('normalizeTimestamp', () => {
  it.each([
    ['UTC', '2026-07-20T10:30:00Z', '2026-07-20T10:30:00.000Z'],
    ['a positive offset', '2026-07-20T11:30:00+01:00', '2026-07-20T10:30:00.000Z'],
    ['a negative offset', '2026-07-20T05:30:00-05:00', '2026-07-20T10:30:00.000Z'],
    ['a compact offset', '2026-07-20T11:30:00+0100', '2026-07-20T10:30:00.000Z'],
    ['fractional seconds', '2026-07-20T10:30:00.123Z', '2026-07-20T10:30:00.123Z'],
    ['minute precision', '2026-07-20T10:30Z', '2026-07-20T10:30:00.000Z'],
    ['a bare date, which the spec pins to UTC', '2026-07-20', '2026-07-20T00:00:00.000Z'],
    ['surrounding whitespace', '  2026-07-20T10:30:00Z  ', '2026-07-20T10:30:00.000Z'],
  ])('canonicalises %s', (_label, input, expected) => {
    expect(normalizeTimestamp(input)).toBe(expected)
  })

  // Unzoned forms resolve against the host clock, so the same persisted string would mean
  // different instants on different workers. Shopify never sends them.
  it.each([
    ['an unzoned timestamp', '2026-07-20T10:30'],
    ['an unzoned timestamp with seconds', '2026-07-20T10:30:00'],
    ['a space-separated timestamp', '2026-07-20 10:30:00'],
    ['a bare year', '2026'],
    ['a human-readable date', 'March 5, 2026'],
    ['an out-of-range date', '2026-13-45T00:00:00Z'],
    ['a trailing-garbage timestamp', '2026-07-20T10:30:00Zjunk'],
    ['an empty string', ''],
    ['a number', 1_784_000_000_000],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, input) => {
    expect(normalizeTimestamp(input)).toBeNull()
  })
})

describe('advanceCursor while paging', () => {
  it('opens a run from no cursor at all', () => {
    expect(advanceCursor(null, { next: { kind: 'paging', endCursor: 'p1' }, maxUpdatedAt: '2026-07-20T01:00:00Z' })).toEqual({
      kind: 'paging',
      endCursor: 'p1',
      pagesFetched: 1,
      updatedAfter: null,
      maxUpdatedAt: '2026-07-20T01:00:00.000Z',
    })
  })

  it('carries the pointer and accumulates the high-water mark', () => {
    const page1 = advanceCursor(
      { kind: 'idle', updatedAfter: '2026-07-19T00:00:00Z' },
      { next: { kind: 'paging', endCursor: 'p1' }, maxUpdatedAt: '2026-07-19T06:00:00Z' },
    )
    const page2 = advanceCursor(page1, { next: { kind: 'paging', endCursor: 'p2' }, maxUpdatedAt: '2026-07-19T08:00:00Z' })

    expect(page2).toEqual({
      kind: 'paging',
      endCursor: 'p2',
      pagesFetched: 2,
      // The window start is fixed for the run; only maxUpdatedAt moves.
      updatedAfter: '2026-07-19T00:00:00.000Z',
      maxUpdatedAt: '2026-07-19T08:00:00.000Z',
    })
  })

  it('does not let a page of older records lower the high-water mark', () => {
    const page1 = advanceCursor(null, { next: { kind: 'paging', endCursor: 'p1' }, maxUpdatedAt: '2026-07-20T10:00:00Z' })
    const page2 = advanceCursor(page1, { next: { kind: 'paging', endCursor: 'p2' }, maxUpdatedAt: '2026-07-20T02:00:00Z' })
    expect(page2).toMatchObject({ maxUpdatedAt: '2026-07-20T10:00:00.000Z' })
  })

  it('carries the mark through a page that matched nothing', () => {
    const page1 = advanceCursor(null, { next: { kind: 'paging', endCursor: 'p1' }, maxUpdatedAt: '2026-07-20T10:00:00Z' })
    const page2 = advanceCursor(page1, { next: { kind: 'paging', endCursor: 'p2' } })
    expect(page2).toMatchObject({ maxUpdatedAt: '2026-07-20T10:00:00.000Z', pagesFetched: 2 })
  })

  it('compares instants, not strings, when the zones differ', () => {
    // '…T11:30:00+01:00' sorts above '…T11:00:00Z' as text but is half an hour earlier.
    const page1 = advanceCursor(null, { next: { kind: 'paging', endCursor: 'p1' }, maxUpdatedAt: '2026-07-20T11:00:00Z' })
    const page2 = advanceCursor(page1, { next: { kind: 'paging', endCursor: 'p2' }, maxUpdatedAt: '2026-07-20T11:30:00+01:00' })
    expect(page2).toMatchObject({ maxUpdatedAt: '2026-07-20T11:00:00.000Z' })
  })

  it('survives a round-trip mid-run, which is how a restarted worker resumes', () => {
    const page1 = advanceCursor(null, { next: { kind: 'paging', endCursor: 'p1' }, maxUpdatedAt: '2026-07-20T10:00:00Z' })
    const resumed = parseCursor(serializeCursor(page1))
    expect(advanceCursor(resumed, { next: { kind: 'paging', endCursor: 'p2' } })).toMatchObject({
      endCursor: 'p2',
      pagesFetched: 2,
      maxUpdatedAt: '2026-07-20T10:00:00.000Z',
    })
  })
})

describe('advanceCursor promotion', () => {
  it('promotes the high-water mark when paging ends', () => {
    const page1 = advanceCursor(
      { kind: 'idle', updatedAfter: '2026-07-19T00:00:00Z' },
      { next: { kind: 'paging', endCursor: 'p1' }, maxUpdatedAt: '2026-07-20T10:00:00Z' },
    )
    expect(advanceCursor(page1, { maxUpdatedAt: '2026-07-20T12:00:00Z' })).toEqual({
      kind: 'idle',
      updatedAfter: '2026-07-20T12:00:00.000Z',
    })
  })

  it('leaves the previous watermark alone when the run saw no records', () => {
    // The delta case that must not regress: nothing changed upstream, so there is nothing to
    // promote. Writing null here would make the next run a full scan, forever.
    const before: ShopifyCursorState = { kind: 'idle', updatedAfter: '2026-07-19T00:00:00Z' }
    const page1 = advanceCursor(before, { next: { kind: 'paging', endCursor: 'p1' } })
    expect(advanceCursor(page1, {})).toEqual({ kind: 'idle', updatedAfter: '2026-07-19T00:00:00.000Z' })
  })

  it('never rewinds the watermark, even if a batch reports older records', () => {
    // An invalid search filter makes Shopify return the whole catalog instead of erroring, so a
    // delta batch can legitimately contain records far older than the window start.
    const page1 = advanceCursor(
      { kind: 'idle', updatedAfter: '2026-07-19T00:00:00Z' },
      { next: { kind: 'paging', endCursor: 'p1' }, maxUpdatedAt: '2024-01-01T00:00:00Z' },
    )
    expect(advanceCursor(page1, {})).toEqual({ kind: 'idle', updatedAfter: '2026-07-19T00:00:00.000Z' })
  })

  it('promotes on a single-page run with no prior watermark', () => {
    expect(advanceCursor(null, { maxUpdatedAt: '2026-07-20T10:00:00Z' })).toEqual({
      kind: 'idle',
      updatedAfter: '2026-07-20T10:00:00.000Z',
    })
  })

  it('ignores an unparseable batch timestamp instead of promoting it', () => {
    expect(advanceCursor({ kind: 'idle', updatedAfter: '2026-07-19T00:00:00Z' }, { maxUpdatedAt: 'yesterday' })).toEqual({
      kind: 'idle',
      updatedAfter: '2026-07-19T00:00:00.000Z',
    })
  })

  it('drives a whole run from backfill to incremental', () => {
    let cursor = parseCursor(null)
    expect(cursor).toBeNull()

    for (const [endCursor, updatedAt] of [['p1', '2026-07-20T01:00:00Z'], ['p2', '2026-07-20T02:00:00Z']]) {
      cursor = parseCursor(serializeCursor(advanceCursor(cursor, { next: { kind: 'paging', endCursor }, maxUpdatedAt: updatedAt })))
    }
    cursor = parseCursor(serializeCursor(advanceCursor(cursor, { maxUpdatedAt: '2026-07-20T03:00:00Z' })))

    // The next scheduled run reads this and filters on updated_at:>'2026-07-20T03:00:00.000Z'.
    expect(cursor).toEqual({ kind: 'idle', updatedAfter: '2026-07-20T03:00:00.000Z' })
  })
})

describe('advanceCursor with a bulk operation', () => {
  it('records the operation in flight without promoting', () => {
    expect(
      advanceCursor({ kind: 'idle', updatedAfter: '2026-07-19T00:00:00Z' }, { next: { kind: 'bulk', bulkOperationId: BULK_GID } }),
    ).toEqual({
      kind: 'bulk',
      bulkOperationId: BULK_GID,
      updatedAfter: '2026-07-19T00:00:00.000Z',
      maxUpdatedAt: null,
    })
  })

  it('accumulates the mark across polls of the same operation', () => {
    const submitted = advanceCursor(null, { next: { kind: 'bulk', bulkOperationId: BULK_GID } })
    const polled = advanceCursor(submitted, { next: { kind: 'bulk', bulkOperationId: BULK_GID }, maxUpdatedAt: '2026-07-20T10:00:00Z' })
    expect(polled).toMatchObject({ kind: 'bulk', maxUpdatedAt: '2026-07-20T10:00:00.000Z' })
  })

  it('promotes once the JSONL has been drained', () => {
    const running = advanceCursor(null, { next: { kind: 'bulk', bulkOperationId: BULK_GID }, maxUpdatedAt: '2026-07-20T10:00:00Z' })
    expect(advanceCursor(running, {})).toEqual({ kind: 'idle', updatedAfter: '2026-07-20T10:00:00.000Z' })
  })
})

describe('advanceCursor given a pointer it cannot use', () => {
  // "Keep going" plus an unusable pointer is a contradiction. Promoting would step over records
  // the run never reached, so we park on the old watermark and repeat the window instead.
  it.each([
    ['a blank endCursor', { kind: 'paging' as const, endCursor: '   ' }],
    ['a GID for the wrong type', { kind: 'bulk' as const, bulkOperationId: 'gid://shopify/Product/1' }],
    ['an empty GID', { kind: 'bulk' as const, bulkOperationId: '' }],
  ])('parks without promoting on %s', (_label, next) => {
    const current: ShopifyCursorState = { kind: 'idle', updatedAfter: '2026-07-19T00:00:00Z' }
    expect(advanceCursor(current, { next, maxUpdatedAt: '2026-07-20T10:00:00Z' })).toEqual({
      kind: 'idle',
      updatedAfter: '2026-07-19T00:00:00.000Z',
    })
  })
})
