import {
  OOS_DEFAULT_WINDOW_DAYS,
  OOS_MIN_OBSERVED_DAYS,
  INVENTORY_DAILY_RETENTION_DAYS,
} from '../lib/constants'
import {
  addDays,
  collapseLocations,
  createInventoryHistoryService,
  isPhysicalInventory,
  monthlyAggregateToObservation,
  oosRatio,
  planRetention,
  snapshotDateFor,
  type InventoryHistoryStore,
  type InventorySnapshotRow,
} from '../lib/inventory-history'

const VARIANT = 'gid://shopify/ProductVariant/1'
const LOCATION = 'gid://shopify/Location/1'
const TODAY = '2026-07-20'

/**
 * A run of consecutive daily rows. `outOfStock` is derived from `available` rather than passed
 * separately, so a fixture cannot express a state the writer would never produce.
 */
function dailyRows(options: {
  from: string
  days: number
  variantExternal?: string
  locationId?: string
  /** Units available on day `index`, counting from `from`. Zero or less is a stockout. */
  available?: (index: number) => number
}): InventorySnapshotRow[] {
  const available = options.available ?? (() => 5)
  const rows: InventorySnapshotRow[] = []
  for (let index = 0; index < options.days; index += 1) {
    const value = available(index)
    rows.push({
      snapshotDate: addDays(options.from, index),
      variantExternal: options.variantExternal ?? VARIANT,
      locationId: options.locationId ?? LOCATION,
      available: value,
      outOfStock: value <= 0,
    })
  }
  return rows
}

/** `days` days of history ending on `TODAY`. */
function endingToday(days: number, available?: (index: number) => number): InventorySnapshotRow[] {
  return dailyRows({ from: addDays(TODAY, -(days - 1)), days, available })
}

describe('snapshotDateFor', () => {
  // §12.10 requires exactly this: day boundaries define every row's identity, so the store's own
  // zone is the only correct one. The prototype hardcoded America/Los_Angeles.
  it('buckets one instant to different days either side of the date line', () => {
    const instant = new Date('2026-07-20T06:00:00Z')
    expect(snapshotDateFor(instant, 'Pacific/Auckland')).toBe('2026-07-20')
    expect(snapshotDateFor(instant, 'America/Los_Angeles')).toBe('2026-07-19')
  })

  it('bucketing follows the zone, not UTC, across a local midnight', () => {
    // 07:30Z is 00:30 PDT the same day; 06:30Z is still the previous evening.
    expect(snapshotDateFor(new Date('2026-07-20T07:30:00Z'), 'America/Los_Angeles')).toBe('2026-07-20')
    expect(snapshotDateFor(new Date('2026-07-20T06:30:00Z'), 'America/Los_Angeles')).toBe('2026-07-19')
  })

  it('handles a zone with a non-whole-hour offset', () => {
    // Kathmandu is UTC+05:45 — a good check that we format rather than add hours.
    expect(snapshotDateFor(new Date('2026-07-19T18:20:00Z'), 'Asia/Kathmandu')).toBe('2026-07-20')
  })

  it('throws on an unknown zone instead of silently falling back', () => {
    // Mis-bucketed rows can never be corrected, because history cannot be backfilled. A failed run
    // can simply be re-run.
    expect(() => snapshotDateFor(new Date(), 'Mars/Olympus_Mons')).toThrow(/unknown IANA timezone/)
  })
})

describe('isPhysicalInventory', () => {
  it('excludes a gift card via the structured flag', () => {
    expect(isPhysicalInventory({ isGiftCard: true, requiresShipping: false })).toBe(false)
  })

  it('excludes a non-shipping item even when it is not flagged as a gift card', () => {
    expect(isPhysicalInventory({ isGiftCard: false, requiresShipping: false })).toBe(false)
  })

  it('includes ordinary physical stock', () => {
    expect(isPhysicalInventory({ isGiftCard: false, requiresShipping: true })).toBe(true)
  })

  // The correction that matters (§12.6). Titles are carried here only to show what a string matcher
  // would have done with them — the predicate never sees a title.
  it.each([
    ['a German gift card that "gift card" would never match', 'Geschenkkarte 50 €', { isGiftCard: true, requiresShipping: false }, false],
    ['a Japanese gift card', 'ギフトカード', { isGiftCard: true, requiresShipping: false }, false],
    ['a Polish physical product', 'Bluza z kapturem', { isGiftCard: false, requiresShipping: true }, true],
    ['a physical product whose English title contains "gift card"', 'Gift Card Holder Wallet', { isGiftCard: false, requiresShipping: true }, true],
    ['a physical product whose title contains "barcode"', 'Barcode Print Tee', { isGiftCard: false, requiresShipping: true }, true],
  ])('classifies %s correctly', (_label, _title, signals, expected) => {
    expect(isPhysicalInventory(signals)).toBe(expected)
  })

  it('treats missing signals as physical rather than dropping real stock', () => {
    // The errors are not symmetric: including a gift card dilutes an aggregate slightly, while
    // excluding a real SKU loses it from history permanently.
    expect(isPhysicalInventory({})).toBe(true)
    expect(isPhysicalInventory({ isGiftCard: null, requiresShipping: null })).toBe(true)
  })
})

describe('collapseLocations', () => {
  it('turns one day at several locations into one observation', () => {
    const rows = [
      ...dailyRows({ from: TODAY, days: 1, locationId: 'gid://shopify/Location/1', available: () => 4 }),
      ...dailyRows({ from: TODAY, days: 1, locationId: 'gid://shopify/Location/2', available: () => 0 }),
    ]
    expect(collapseLocations(rows)).toEqual([{ snapshotDate: TODAY, daysObserved: 1, daysOutOfStock: 0 }])
  })

  it('counts a stockout only when every location is out', () => {
    const rows = [
      ...dailyRows({ from: TODAY, days: 1, locationId: 'gid://shopify/Location/1', available: () => 0 }),
      ...dailyRows({ from: TODAY, days: 1, locationId: 'gid://shopify/Location/2', available: () => 0 }),
    ]
    expect(collapseLocations(rows)[0].daysOutOfStock).toBe(1)
  })

  it('never lets two locations count one calendar day twice', () => {
    const rows = [
      ...dailyRows({ from: addDays(TODAY, -9), days: 10, locationId: 'gid://shopify/Location/1' }),
      ...dailyRows({ from: addDays(TODAY, -9), days: 10, locationId: 'gid://shopify/Location/2' }),
    ]
    const observations = collapseLocations(rows)
    expect(observations).toHaveLength(10)
    expect(observations.reduce((sum, o) => sum + o.daysObserved, 0)).toBe(10)
  })

  it('returns observations in date order', () => {
    const rows = [...dailyRows({ from: addDays(TODAY, -2), days: 3 })].reverse()
    expect(collapseLocations(rows).map((o) => o.snapshotDate)).toEqual([
      addDays(TODAY, -2),
      addDays(TODAY, -1),
      TODAY,
    ])
  })
})

describe('oosRatio', () => {
  it('matches a hand-computed fixture when history is sufficient', () => {
    // 60 observed days, the first 15 out of stock → 15/60 = 0.25, coverage 60/90.
    const result = oosRatio(collapseLocations(endingToday(60, (i) => (i < 15 ? 0 : 5))), { asOf: TODAY })
    expect(result.daysObserved).toBe(60)
    expect(result.daysOutOfStock).toBe(15)
    expect(result.ratio).toBe(0.25)
    expect(result.windowCoverage).toBeCloseTo(60 / 90, 10)
    expect(result.insufficientReason).toBeNull()
  })

  it('reports the window it actually used', () => {
    const result = oosRatio(collapseLocations(endingToday(60)), { asOf: TODAY })
    expect(result.windowEnd).toBe(TODAY)
    expect(result.windowStart).toBe(addDays(TODAY, -(OOS_DEFAULT_WINDOW_DAYS - 1)))
  })

  // A real 0 and a withheld null are categorically different answers. Conflating them is the bug
  // this whole module is shaped to prevent, so both directions are pinned.
  it('returns a real 0 when a well-observed variant never went out of stock', () => {
    const result = oosRatio(collapseLocations(endingToday(60, () => 5)), { asOf: TODAY })
    expect(result.ratio).toBe(0)
    expect(result.insufficientReason).toBeNull()
  })

  it('returns 1 when a well-observed variant was out of stock throughout', () => {
    const result = oosRatio(collapseLocations(endingToday(60, () => 0)), { asOf: TODAY })
    expect(result.ratio).toBe(1)
  })

  describe('the guard', () => {
    it('returns null — not 0 — below the minimum observed days', () => {
      // A 20-day window isolates this guard: 13 days is 65% coverage, so only the day floor binds.
      const result = oosRatio(collapseLocations(endingToday(13, (i) => (i < 4 ? 0 : 5))), {
        asOf: TODAY,
        windowDays: 20,
      })
      expect(result.daysObserved).toBe(13)
      expect(result.windowCoverage).toBeCloseTo(0.65, 10)
      expect(result.ratio).toBeNull()
      expect(result.ratio).not.toBe(0)
      expect(result.insufficientReason).toBe('insufficient_observations')
    })

    it('admits the ratio at exactly the minimum observed days', () => {
      const result = oosRatio(collapseLocations(endingToday(OOS_MIN_OBSERVED_DAYS, (i) => (i < 7 ? 0 : 5))), {
        asOf: TODAY,
        windowDays: 20,
      })
      expect(result.daysObserved).toBe(14)
      expect(result.ratio).toBeCloseTo(7 / 14, 10)
    })

    it('returns null — not 0 — below the minimum window coverage', () => {
      // 44 of 90 days is 48.9%: far past the 14-day floor, still not enough of the window.
      const result = oosRatio(collapseLocations(endingToday(44, (i) => (i < 10 ? 0 : 5))), { asOf: TODAY })
      expect(result.daysObserved).toBe(44)
      expect(result.windowCoverage).toBeLessThan(0.5)
      expect(result.ratio).toBeNull()
      expect(result.ratio).not.toBe(0)
      expect(result.insufficientReason).toBe('insufficient_coverage')
    })

    it('admits the ratio at exactly 50% window coverage', () => {
      const result = oosRatio(collapseLocations(endingToday(45, (i) => (i < 9 ? 0 : 5))), { asOf: TODAY })
      expect(result.windowCoverage).toBe(0.5)
      expect(result.ratio).toBeCloseTo(9 / 45, 10)
      expect(result.insufficientReason).toBeNull()
    })

    // History accrues only forward, so a fresh install looks authoritative while knowing nothing.
    it('withholds a ratio for every day of a fresh install', () => {
      for (let day = 0; day <= 13; day += 1) {
        const rows = day === 0 ? [] : endingToday(day, () => 0)
        const result = oosRatio(collapseLocations(rows), { asOf: TODAY })
        expect(result.ratio).toBeNull()
        expect(result.daysObserved).toBe(day)
      }
    })

    it('still withholds at 14 days, because 14/90 is nowhere near half the window', () => {
      const result = oosRatio(collapseLocations(endingToday(14, () => 0)), { asOf: TODAY })
      expect(result.ratio).toBeNull()
      expect(result.insufficientReason).toBe('insufficient_coverage')
    })

    it('has no ratio to give when nothing was ever observed', () => {
      const result = oosRatio([], { asOf: TODAY })
      expect(result.ratio).toBeNull()
      expect(result.daysObserved).toBe(0)
      expect(result.windowCoverage).toBe(0)
    })
  })

  describe('gaps', () => {
    it('reduces coverage by exactly the missing days', () => {
      // 30 days, a 30-day outage, then 30 days → 60 of 90 observed.
      const rows = [
        ...dailyRows({ from: addDays(TODAY, -89), days: 30, available: () => 0 }),
        ...dailyRows({ from: addDays(TODAY, -29), days: 30, available: () => 5 }),
      ]
      const result = oosRatio(collapseLocations(rows), { asOf: TODAY })
      expect(result.daysObserved).toBe(60)
      expect(result.windowCoverage).toBeCloseTo(60 / 90, 10)
      expect(result.ratio).toBeCloseTo(30 / 60, 10)
    })

    it('withholds the ratio once a gap eats past half the window', () => {
      // A worker down for most of a quarter still leaves a tidy-looking 20/20 = 1.0 behind.
      const rows = [
        ...dailyRows({ from: addDays(TODAY, -89), days: 20, available: () => 0 }),
        ...dailyRows({ from: addDays(TODAY, -19), days: 20, available: () => 0 }),
      ]
      const result = oosRatio(collapseLocations(rows), { asOf: TODAY })
      expect(result.daysObserved).toBe(40)
      expect(result.ratio).toBeNull()
      expect(result.insufficientReason).toBe('insufficient_coverage')
    })
  })

  it('ignores observations outside the window rather than assuming they were filtered', () => {
    const rows = [
      ...dailyRows({ from: addDays(TODAY, -200), days: 100, available: () => 0 }),
      ...dailyRows({ from: addDays(TODAY, -59), days: 60, available: () => 5 }),
    ]
    const result = oosRatio(collapseLocations(rows), { asOf: TODAY })
    expect(result.daysObserved).toBe(60)
    expect(result.ratio).toBe(0)
  })

  it('counts a rolled-up month as the days it summarises, not as one row', () => {
    const aggregate = monthlyAggregateToObservation({
      month: '2026-06',
      variantExternal: VARIANT,
      locationId: LOCATION,
      daysObserved: 30,
      daysOutOfStock: 12,
      avgAvailable: 1.5,
    })
    const result = oosRatio([aggregate, ...collapseLocations(endingToday(20, () => 5))], { asOf: TODAY })
    expect(result.daysObserved).toBe(50)
    expect(result.daysOutOfStock).toBe(12)
    expect(result.ratio).toBeCloseTo(12 / 50, 10)
  })
})

describe('planRetention', () => {
  const FOURTEEN_MONTHS = 426

  function fourteenMonths(locationId?: string) {
    // Out of stock every fifth day, and available drifting, so the aggregates have real content.
    return dailyRows({
      from: addDays(TODAY, -(FOURTEEN_MONTHS - 1)),
      days: FOURTEEN_MONTHS,
      locationId,
      available: (index) => (index % 5 === 0 ? 0 : (index % 7) + 1),
    })
  }

  it('keeps exactly the retention window of daily rows and prunes the rest', () => {
    const plan = planRetention(fourteenMonths(), { today: TODAY })
    expect(plan.dailyCutoff).toBe(addDays(TODAY, -(INVENTORY_DAILY_RETENTION_DAYS - 1)))
    expect(plan.keep).toHaveLength(INVENTORY_DAILY_RETENTION_DAYS)
    expect(plan.prune).toHaveLength(FOURTEEN_MONTHS - INVENTORY_DAILY_RETENTION_DAYS)
    expect(plan.keep.every((row) => row.snapshotDate >= plan.dailyCutoff)).toBe(true)
    expect(plan.prune.every((row) => row.snapshotDate < plan.dailyCutoff)).toBe(true)
  })

  it('summarises every pruned row into a monthly aggregate, losing no observed days', () => {
    const plan = planRetention(fourteenMonths(), { today: TODAY })
    const observed = plan.aggregates.reduce((sum, a) => sum + a.daysObserved, 0)
    expect(observed).toBe(plan.prune.length)
  })

  it('computes days_observed, days_oos and avg_available per month', () => {
    const rows = dailyRows({
      from: '2025-01-01',
      days: 31,
      available: (index) => (index < 10 ? 0 : 4),
    })
    const plan = planRetention(rows, { today: TODAY })
    expect(plan.keep).toHaveLength(0)
    expect(plan.aggregates).toHaveLength(1)
    expect(plan.aggregates[0]).toEqual({
      month: '2025-01',
      variantExternal: VARIANT,
      locationId: LOCATION,
      daysObserved: 31,
      daysOutOfStock: 10,
      // 10 days at 0 plus 21 days at 4 → 84/31 = 2.709...
      avgAvailable: 2.71,
    })
  })

  it('keeps locations separate in the rollup so the multi-location model survives it', () => {
    const rows = [
      ...dailyRows({ from: '2025-01-01', days: 31, locationId: 'gid://shopify/Location/1', available: () => 0 }),
      ...dailyRows({ from: '2025-01-01', days: 31, locationId: 'gid://shopify/Location/2', available: () => 6 }),
    ]
    const plan = planRetention(rows, { today: TODAY })
    expect(plan.aggregates).toHaveLength(2)
    expect(plan.aggregates.map((a) => a.daysOutOfStock)).toEqual([31, 0])
    expect(plan.aggregates.map((a) => a.avgAvailable)).toEqual([0, 6])
  })

  // The acceptance criterion: retention is only safe if it cannot move the number that drives POs.
  it('leaves a 90-day oosRatio untouched', () => {
    const rows = fourteenMonths()
    const before = oosRatio(collapseLocations(rows), { asOf: TODAY })
    const plan = planRetention(rows, { today: TODAY })
    const after = oosRatio(collapseLocations(plan.keep), { asOf: TODAY })

    expect(before.ratio).not.toBeNull()
    expect(after).toEqual(before)
  })

  it('is a no-op on a store younger than the retention window', () => {
    const plan = planRetention(endingToday(30), { today: TODAY })
    expect(plan.prune).toHaveLength(0)
    expect(plan.aggregates).toHaveLength(0)
    expect(plan.keep).toHaveLength(30)
  })
})

describe('createInventoryHistoryService', () => {
  function storeReturning(rows: InventorySnapshotRow[]) {
    const calls: Parameters<InventoryHistoryStore['findDailyRows']>[0][] = []
    const store: InventoryHistoryStore = {
      async findDailyRows(args) {
        calls.push(args)
        return rows
      },
    }
    return { store, calls }
  }

  const scope = { organizationId: 'org-1', tenantId: 'tenant-1' }

  it('queries exactly the requested window, scoped', async () => {
    const { store, calls } = storeReturning(endingToday(60))
    await createInventoryHistoryService(store).oosRatio(VARIANT, { scope, asOf: TODAY })
    expect(calls).toEqual([
      { variantExternal: VARIANT, from: addDays(TODAY, -89), to: TODAY, scope },
    ])
  })

  it('collapses locations before computing, so two locations are not two days', async () => {
    const rows = [
      ...dailyRows({ from: addDays(TODAY, -59), days: 60, locationId: 'gid://shopify/Location/1', available: () => 0 }),
      ...dailyRows({ from: addDays(TODAY, -59), days: 60, locationId: 'gid://shopify/Location/2', available: () => 3 }),
    ]
    const { store } = storeReturning(rows)
    const result = await createInventoryHistoryService(store).oosRatio(VARIANT, { scope, asOf: TODAY })
    expect(result.daysObserved).toBe(60)
    expect(result.ratio).toBe(0)
  })

  it('withholds the ratio when the store has too little history', async () => {
    const { store } = storeReturning(endingToday(10, () => 0))
    const result = await createInventoryHistoryService(store).oosRatio(VARIANT, { scope, asOf: TODAY })
    expect(result.ratio).toBeNull()
    expect(result.insufficientReason).toBe('insufficient_observations')
  })

  it('honours a custom window length', async () => {
    const { store, calls } = storeReturning(endingToday(20))
    await createInventoryHistoryService(store).oosRatio(VARIANT, { scope, asOf: TODAY, windowDays: 30 })
    expect(calls[0].from).toBe(addDays(TODAY, -29))
  })
})

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('knows about leap days', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('rejects a malformed date rather than producing NaN', () => {
    expect(() => addDays('20260720', 1)).toThrow(/YYYY-MM-DD/)
  })
})
