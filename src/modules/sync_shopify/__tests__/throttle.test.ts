import {
  CostTracker,
  MAX_SINGLE_QUERY_COST,
  computeBackoffMs,
  extractErrorList,
  isMaxCostExceeded,
  isThrottledResponse,
  parseCost,
  safePageSize,
  type QueryCost,
} from '../lib/throttle'

const extensions = (overrides: Record<string, unknown> = {}) => ({
  cost: {
    requestedQueryCost: 100,
    actualQueryCost: 80,
    throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1900, restoreRate: 100 },
    ...overrides,
  },
})

describe('parseCost', () => {
  it('reads a well-formed cost block', () => {
    expect(parseCost(extensions())).toEqual({
      requestedQueryCost: 100,
      actualQueryCost: 80,
      throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1900, restoreRate: 100 },
    })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['an object with no cost', {}],
    ['cost with no throttleStatus', { cost: { requestedQueryCost: 10 } }],
    ['non-numeric throttle values', { cost: { throttleStatus: { maximumAvailable: 'x', currentlyAvailable: 1, restoreRate: 1 } } }],
  ])('returns null for %s', (_label, input) => {
    expect(parseCost(input)).toBeNull()
  })

  it('tolerates a missing actualQueryCost (present only after execution)', () => {
    const parsed = parseCost(extensions({ actualQueryCost: undefined }))
    expect(parsed?.actualQueryCost).toBeNull()
    expect(parsed?.requestedQueryCost).toBe(100)
  })
})

describe('throttle detection', () => {
  // The central case: Shopify signals throttling on an HTTP 200, which is why status-code
  // checks (and the SDK's own `retries`) miss it.
  it('detects THROTTLED inside a 200 response body', () => {
    expect(isThrottledResponse({ graphQLErrors: [{ extensions: { code: 'THROTTLED' } }] })).toBe(true)
    expect(isThrottledResponse([{ extensions: { code: 'throttled' } }])).toBe(true)
  })

  it('does not confuse other error codes for throttling', () => {
    expect(isThrottledResponse({ graphQLErrors: [{ extensions: { code: 'ACCESS_DENIED' } }] })).toBe(false)
    expect(isThrottledResponse(null)).toBe(false)
    expect(isThrottledResponse({ message: 'network boom' })).toBe(false)
  })

  it('distinguishes MAX_COST_EXCEEDED, which retrying cannot fix', () => {
    const errors = { graphQLErrors: [{ extensions: { code: 'MAX_COST_EXCEEDED' } }] }
    expect(isMaxCostExceeded(errors)).toBe(true)
    expect(isThrottledResponse(errors)).toBe(false)
  })

  it('normalises every shape ResponseErrors can take', () => {
    expect(extractErrorList([{ message: 'a' }])).toHaveLength(1)
    expect(extractErrorList({ graphQLErrors: [{ message: 'a' }, { message: 'b' }] })).toHaveLength(2)
    expect(extractErrorList({ message: 'network' })).toHaveLength(1)
    expect(extractErrorList(null)).toHaveLength(0)
    expect(extractErrorList('weird')).toHaveLength(0)
  })
})

describe('computeBackoffMs', () => {
  const cost = (requested: number, available: number, restoreRate = 100): QueryCost => ({
    requestedQueryCost: requested,
    actualQueryCost: null,
    throttleStatus: { maximumAvailable: 2000, currentlyAvailable: available, restoreRate },
  })

  it('waits exactly long enough for the bucket to cover the deficit', () => {
    // deficit 500, restore 100/s → 5s
    expect(computeBackoffMs(cost(1000, 500))).toBe(5000)
  })

  it('returns 0 when capacity already covers the query', () => {
    expect(computeBackoffMs(cost(100, 1900))).toBe(0)
  })

  it('falls back when cost data is absent or the restore rate is nonsense', () => {
    expect(computeBackoffMs(null, 1234)).toBe(1234)
    expect(computeBackoffMs(cost(1000, 0, 0), 1234)).toBe(1234)
  })

  it('rounds up so we never retry a fraction too early', () => {
    expect(computeBackoffMs(cost(100, 55, 100))).toBe(450)
  })
})

describe('CostTracker', () => {
  function trackerAt(startMs: number) {
    let now = startMs
    const tracker = new CostTracker({ now: () => now })
    return { tracker, advance: (ms: number) => { now += ms } }
  }

  it('does not pace before it has seen a response', () => {
    const { tracker } = trackerAt(0)
    expect(tracker.estimateAvailable()).toBeNull()
    expect(tracker.delayForMs(500)).toBe(0)
  })

  it('learns capacity from the response rather than assuming a plan', () => {
    const { tracker } = trackerAt(0)
    tracker.observe(parseCost(extensions({ throttleStatus: { maximumAvailable: 20000, currentlyAvailable: 19000, restoreRate: 1000 } })))
    expect(tracker.lastStatus?.maximumAvailable).toBe(20000)
    expect(tracker.estimateAvailable()).toBe(19000)
  })

  it('extrapolates recovery via the restore rate, capped at the bucket size', () => {
    const { tracker, advance } = trackerAt(0)
    tracker.observe(parseCost(extensions({ throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1000, restoreRate: 100 } })))
    advance(2000)
    expect(tracker.estimateAvailable()).toBe(1200)
    advance(1_000_000)
    expect(tracker.estimateAvailable()).toBe(2000)
  })

  it('delays when a query would eat into the headroom floor', () => {
    const { tracker } = trackerAt(0)
    // 20% of 2000 = 400 floor; available 500; cost 300 needs 700 → short by 200 at 100/s = 2s
    tracker.observe(parseCost(extensions({ throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 500, restoreRate: 100 } })))
    expect(tracker.delayForMs(300)).toBe(2000)
  })

  it('does not delay when there is ample headroom', () => {
    const { tracker } = trackerAt(0)
    tracker.observe(parseCost(extensions()))
    expect(tracker.delayForMs(100)).toBe(0)
  })

  it('ignores a null observation rather than dropping learned state', () => {
    const { tracker } = trackerAt(0)
    tracker.observe(parseCost(extensions()))
    tracker.observe(null)
    expect(tracker.lastStatus).not.toBeNull()
  })
})

describe('safePageSize', () => {
  it('never exceeds Shopify\'s 250-per-page cap', () => {
    expect(safePageSize(0.1)).toBe(250)
    expect(safePageSize(0)).toBe(250)
  })

  it('shrinks the page so the query stays under the cost ceiling', () => {
    // 0.8 * 1000 / 10 = 80
    expect(safePageSize(10)).toBe(80)
  })

  it('honours a smaller desired size', () => {
    expect(safePageSize(1, 50)).toBe(50)
  })

  it('never returns less than 1, even for an absurdly expensive node', () => {
    expect(safePageSize(MAX_SINGLE_QUERY_COST * 10)).toBe(1)
  })
})
