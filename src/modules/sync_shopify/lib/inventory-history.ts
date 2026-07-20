/**
 * Out-of-stock history: the derived signal, and the guard that keeps it honest.
 *
 *   oos_ratio(variant, window)  = days_out_of_stock / days_observed
 *   effective_daily_demand      = recorded_sales / (days_observed × (1 − oos_ratio))
 *
 * This turns "sold 30 last quarter" into "sold 30 *while available only 40% of the time* → true
 * demand ≈ 75", which is what a correct purchase order needs. A sold-out item's recorded sales are
 * artificially low, so naïve 90-day arithmetic under-orders exactly the items that sell best.
 *
 * 🔴 **The guard is the point.** Two failure modes both produce a confident wrong number rather
 * than an error:
 *
 *  1. **History cannot be backfilled.** It accrues only forward. A fresh install has
 *     `days_observed` of 0, then 1, then 2… so a 90-day ratio is meaningless for ~90 days while
 *     looking perfectly authoritative to a consumer.
 *  2. **Missed runs shrink the denominator.** A month of downed workers still yields a tidy ratio
 *     computed from whatever days happened to survive.
 *
 * So `oosRatio` returns **null** below the thresholds — not 0, not a number — and callers must
 * then not write the custom field *at all*, because a stored 0 reads as "never out of stock". Every
 * result carries `daysObserved` and `windowCoverage` so a caller can judge it, and
 * `insufficientReason` so it can say *why* it declined. This number feeds purchase-order
 * quantities: a confident wrong value is worse than none.
 *
 * Everything here is pure and framework-free — no ORM, no clock, no I/O — so it is fully unit
 * testable. The DB-facing service at the bottom takes an injected store rather than importing one.
 */

import {
  INVENTORY_DAILY_RETENTION_DAYS,
  OOS_DEFAULT_WINDOW_DAYS,
  OOS_MIN_OBSERVED_DAYS,
  OOS_MIN_WINDOW_COVERAGE,
} from './constants'

// ── Calendar days ───────────────────────────────────────────────────────────────────────────────
//
// Snapshot dates are calendar days in the *store's* timezone, not instants, so all arithmetic here
// is on `YYYY-MM-DD` strings via UTC — which has no DST discontinuities to fall into. ISO dates
// also sort lexicographically, so range checks are plain string comparisons.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Store-timezone calendar day for an instant.
 *
 * The prototype hardcoded `America/Los_Angeles`. Day boundaries define every row's identity, so a
 * wrong zone silently mis-buckets history and a *changed* zone retroactively shifts it — read
 * `shop { ianaTimezone }` and pass it here. An unknown zone throws rather than falling back: a run
 * that fails loudly can be re-run, whereas mis-bucketed rows can never be corrected, because
 * history cannot be backfilled.
 */
export function snapshotDateFor(instant: Date, ianaTimezone: string): string {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant)
  } catch {
    throw new Error(`[internal] unknown IANA timezone for snapshot bucketing: ${ianaTimezone}`)
  }

  const find = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  const year = find('year').padStart(4, '0')
  const month = find('month').padStart(2, '0')
  const day = find('day').padStart(2, '0')
  return `${year}-${month}-${day}`
}

function assertDate(date: string): void {
  // A malformed date would silently become NaN and corrupt every window boundary derived from it.
  if (!DATE_PATTERN.test(date)) throw new Error(`[internal] expected a YYYY-MM-DD calendar date, got: ${date}`)
}

/** Shift a calendar date by whole days. Negative shifts backwards. */
export function addDays(date: string, days: number): string {
  assertDate(date)
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day))
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

/** `YYYY-MM` bucket a calendar date belongs to. */
export function monthOf(date: string): string {
  assertDate(date)
  return date.slice(0, 7)
}

// ── What counts as physical stock ───────────────────────────────────────────────────────────────

export type GiftCardSignals = {
  /** `Product.isGiftCard` — a real `Boolean!` on the Admin API. */
  isGiftCard?: boolean | null
  /** `InventoryItem.requiresShipping`. False for digital goods and services. */
  requiresShipping?: boolean | null
}

/**
 * Is this variant real physical inventory?
 *
 * The prototype matched product titles against `"gift card" | "e-gift" | "barcode"`. That breaks
 * **silently** on any non-English store — a German store's *Geschenkkarte* matches nothing and is
 * counted as physical stock — and equally on any brand whose product names happen to contain those
 * words. Use the structured signals instead; `product_type` stays in the row for reporting, never
 * for this decision.
 *
 * Unknown signals resolve to *physical*. The two errors are not symmetric: wrongly including a gift
 * card slightly dilutes an aggregate, whereas wrongly excluding a real SKU drops it from history
 * permanently — there is no backfill to recover it.
 */
export function isPhysicalInventory(signals: GiftCardSignals): boolean {
  if (signals.isGiftCard === true) return false
  if (signals.requiresShipping === false) return false
  return true
}

// ── Observations ────────────────────────────────────────────────────────────────────────────────

/** The subset of a stored snapshot row the statistics need. */
export type InventorySnapshotRow = {
  snapshotDate: string
  variantExternal: string
  locationId: string
  available: number
  outOfStock: boolean
}

/**
 * One weighted observation of a variant's availability.
 *
 * Weighted because a rolled-up monthly aggregate must count as the ~30 days it summarises, not as
 * one. Keeping the weights explicit is what makes `oosRatio` produce the same answer before and
 * after a retention prune — the alternative, counting rows, silently collapses a month into a day.
 */
export type InventoryObservation = {
  snapshotDate: string
  daysObserved: number
  daysOutOfStock: number
}

/**
 * Collapse the per-location rows of one variant into one observation per day.
 *
 * A variant stocked at two locations produces two rows a day; summing them would count one calendar
 * day twice and inflate the denominator past the window length. A day counts as out of stock only
 * when the variant was unavailable at **every** location — stock sitting at another location is not
 * lost demand.
 *
 * Callers must pass rows for a single variant; rows for several variants would be merged silently.
 */
export function collapseLocations(rows: readonly InventorySnapshotRow[]): InventoryObservation[] {
  const outEverywhereByDate = new Map<string, boolean>()
  for (const row of rows) {
    const outSoFar = outEverywhereByDate.get(row.snapshotDate)
    outEverywhereByDate.set(row.snapshotDate, outSoFar === undefined ? row.outOfStock : outSoFar && row.outOfStock)
  }

  return [...outEverywhereByDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([snapshotDate, outEverywhere]) => ({
      snapshotDate,
      daysObserved: 1,
      daysOutOfStock: outEverywhere ? 1 : 0,
    }))
}

/**
 * Read a rolled-up month back as an observation, anchored at the first of the month.
 *
 * The anchor makes a monthly aggregate all-or-nothing at a window edge. That is exact in practice —
 * aggregates are only ever older than `INVENTORY_DAILY_RETENTION_DAYS` (396) while the default
 * window is 90 days, so the two never overlap — but a caller asking for a window long enough to
 * straddle the boundary should expect month-granular edges.
 */
export function monthlyAggregateToObservation(aggregate: MonthlyInventoryAggregate): InventoryObservation {
  return {
    snapshotDate: `${aggregate.month}-01`,
    daysObserved: aggregate.daysObserved,
    daysOutOfStock: aggregate.daysOutOfStock,
  }
}

// ── The guarded ratio ───────────────────────────────────────────────────────────────────────────

export type OosRatioOptions = {
  /** Last day of the window, inclusive. Normally today in the store's timezone. */
  asOf: string
  /** Window length in days, inclusive of `asOf`. */
  windowDays?: number
  minObservedDays?: number
  minWindowCoverage?: number
}

export type OosRatioResult = {
  /** `null` means "unknown, do not correct" — never treat it as "no stockouts". */
  ratio: number | null
  daysObserved: number
  daysOutOfStock: number
  /** `daysObserved / windowDays`. Below `minWindowCoverage` the ratio is withheld. */
  windowCoverage: number
  windowStart: string
  windowEnd: string
  /** Why the ratio was withheld, or `null` when `ratio` is usable. */
  insufficientReason: 'insufficient_observations' | 'insufficient_coverage' | null
}

/**
 * Out-of-stock ratio over a window, or null when the evidence does not support one.
 *
 * Preconditions: observations belong to a single variant and each calendar day appears at most once
 * — use `collapseLocations` for daily rows. Observations outside the window are ignored here rather
 * than assumed pre-filtered, so pruning older history cannot change the answer.
 *
 * Note that a ratio of **0 is a real answer** ("observed enough, never went out of stock") and is
 * categorically different from `null` ("not enough evidence to say"). Conflating them is the bug
 * this whole module is shaped to prevent.
 */
export function oosRatio(
  observations: readonly InventoryObservation[],
  options: OosRatioOptions,
): OosRatioResult {
  const windowDays = options.windowDays ?? OOS_DEFAULT_WINDOW_DAYS
  const minObservedDays = options.minObservedDays ?? OOS_MIN_OBSERVED_DAYS
  const minWindowCoverage = options.minWindowCoverage ?? OOS_MIN_WINDOW_COVERAGE

  const windowEnd = options.asOf
  assertDate(windowEnd)
  const windowStart = addDays(windowEnd, -(windowDays - 1))

  let daysObserved = 0
  let daysOutOfStock = 0
  for (const observation of observations) {
    if (observation.snapshotDate < windowStart || observation.snapshotDate > windowEnd) continue
    daysObserved += observation.daysObserved
    daysOutOfStock += observation.daysOutOfStock
  }

  const windowCoverage = windowDays > 0 ? daysObserved / windowDays : 0

  // Both guards are needed, and neither implies the other. Over a 90-day window ≥50% coverage is
  // the stricter of the two; over a 20-day window the 14-day floor binds first.
  const insufficientReason =
    daysObserved < minObservedDays
      ? 'insufficient_observations'
      : windowCoverage < minWindowCoverage
        ? 'insufficient_coverage'
        : null

  return {
    ratio: insufficientReason === null ? daysOutOfStock / daysObserved : null,
    daysObserved,
    daysOutOfStock,
    windowCoverage,
    windowStart,
    windowEnd,
    insufficientReason,
  }
}

// ── Retention ───────────────────────────────────────────────────────────────────────────────────
//
// Growth is superlinear in the store dimensions — a 10k-variant × 3-location store generates ~11M
// rows a year — so the policy ships with the feature rather than after it. Daily rows are kept for
// `INVENTORY_DAILY_RETENTION_DAYS` (396 ≈ 13 months, enough for a year-over-year comparison); older
// days collapse into monthly aggregates, which is all `oosRatio` needs beyond the recent window.

export type MonthlyInventoryAggregate = {
  month: string
  variantExternal: string
  locationId: string
  daysObserved: number
  daysOutOfStock: number
  /** Mean `available` across the month's daily rows. Reporting only — it never feeds the ratio. */
  avgAvailable: number
}

export type RetentionPlan = {
  /** Daily rows on or after this date are kept verbatim. */
  dailyCutoff: string
  /** Rows to keep as dailies. */
  keep: InventorySnapshotRow[]
  /** Rows to delete, already summarised into `aggregates`. */
  prune: InventorySnapshotRow[]
  /** One aggregate per (month, variant, location) — the per-location grain survives the rollup. */
  aggregates: MonthlyInventoryAggregate[]
}

export type RetentionOptions = {
  /** Today in the store's timezone. */
  today: string
  retentionDays?: number
}

/**
 * Decide which daily rows survive and what the pruned ones become.
 *
 * Pure by design: the caller executes the delete and the aggregate upsert in its own transaction
 * after the snapshot, but every judgement about *what* to keep and *what each aggregate becomes*
 * is made and tested here.
 *
 * The rollup preserves `(month, variant, location)` rather than collapsing locations, so a rolled
 * month still answers the same multi-location questions the daily rows did.
 */
export function planRetention(
  rows: readonly InventorySnapshotRow[],
  options: RetentionOptions,
): RetentionPlan {
  const retentionDays = options.retentionDays ?? INVENTORY_DAILY_RETENTION_DAYS
  assertDate(options.today)
  // Inclusive of today, so exactly `retentionDays` calendar days are retained.
  const dailyCutoff = addDays(options.today, -(retentionDays - 1))

  const keep: InventorySnapshotRow[] = []
  const prune: InventorySnapshotRow[] = []
  for (const row of rows) {
    if (row.snapshotDate >= dailyCutoff) keep.push(row)
    else prune.push(row)
  }

  type Bucket = MonthlyInventoryAggregate & { availableTotal: number }
  const buckets = new Map<string, Bucket>()
  for (const row of prune) {
    const month = monthOf(row.snapshotDate)
    // NUL separates the parts because it cannot occur in a Shopify GID or a location id.
    const key = `${month}\u0000${row.variantExternal}\u0000${row.locationId}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        month,
        variantExternal: row.variantExternal,
        locationId: row.locationId,
        daysObserved: 0,
        daysOutOfStock: 0,
        avgAvailable: 0,
        availableTotal: 0,
      }
      buckets.set(key, bucket)
    }
    bucket.daysObserved += 1
    if (row.outOfStock) bucket.daysOutOfStock += 1
    bucket.availableTotal += row.available
  }

  const aggregates = [...buckets.values()]
    .map(({ availableTotal, ...aggregate }) => ({
      ...aggregate,
      // Two decimals: this is a reporting aid, and an unrounded float only adds noise.
      avgAvailable: Math.round((availableTotal / aggregate.daysObserved) * 100) / 100,
    }))
    .sort((a, b) =>
      a.month !== b.month
        ? a.month < b.month
          ? -1
          : 1
        : a.variantExternal !== b.variantExternal
          ? a.variantExternal < b.variantExternal
            ? -1
            : 1
          : a.locationId < b.locationId
            ? -1
            : a.locationId > b.locationId
              ? 1
              : 0,
    )

  return { dailyCutoff, keep, prune, aggregates }
}

// ── Query service ───────────────────────────────────────────────────────────────────────────────

export type InventoryHistoryScope = {
  organizationId: string
  tenantId: string
}

/**
 * The only thing this module needs from the database.
 *
 * Injected rather than imported so the statistics stay framework-free and unit-testable. The real
 * implementation reads through `findWithDecryption` scoped on `organizationId` + `tenantId`, per
 * the connector's rule that there are no bare `em.find` calls.
 */
export type InventoryHistoryStore = {
  /** Daily rows for one variant across all locations, both bounds inclusive. */
  findDailyRows(args: {
    variantExternal: string
    from: string
    to: string
    scope: InventoryHistoryScope
  }): Promise<InventorySnapshotRow[]>
}

export type InventoryHistoryService = {
  oosRatio(
    variantExternal: string,
    options: { scope: InventoryHistoryScope; asOf: string; windowDays?: number },
  ): Promise<OosRatioResult>
}

/**
 * Keyed on the Shopify variant GID rather than the local variant id (§12.7 sketches the latter):
 * `variant_id` is nullable precisely so a snapshot survives a lagging catalog mapping, so the
 * external id is the only key guaranteed present on every row.
 */
export function createInventoryHistoryService(store: InventoryHistoryStore): InventoryHistoryService {
  return {
    async oosRatio(variantExternal, options) {
      const windowDays = options.windowDays ?? OOS_DEFAULT_WINDOW_DAYS
      const from = addDays(options.asOf, -(windowDays - 1))
      const rows = await store.findDailyRows({
        variantExternal,
        from,
        to: options.asOf,
        scope: options.scope,
      })
      return oosRatio(collapseLocations(rows), { asOf: options.asOf, windowDays })
    },
  }
}
