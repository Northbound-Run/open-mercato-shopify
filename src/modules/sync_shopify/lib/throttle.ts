/**
 * Cost-aware pacing for the Shopify GraphQL Admin API.
 *
 * Shopify meters GraphQL by *calculated query cost* against a leaky bucket, per app+store pair.
 * Two properties make this awkward, and neither is handled by any Shopify JS client:
 *
 *  1. **Throttling arrives as HTTP 200**, with `errors[].extensions.code === 'THROTTLED'`.
 *     `@shopify/admin-api-client`'s own `retries` option only fires on HTTP 429/503, so it never
 *     sees the common case. That is why this module exists.
 *  2. **Requested cost is charged up front and refunded after.** Over-fetching a connection can
 *     therefore throttle a query that would have been cheap once executed.
 *
 * Bucket sizes vary by plan (2,000 standard → 20,000 enterprise) and the published examples are
 * stale, so nothing here hardcodes them — capacity is always read from the response.
 *
 * Pure and clock-injectable; no I/O.
 */

export type ThrottleStatus = {
  maximumAvailable: number
  currentlyAvailable: number
  restoreRate: number
}

export type QueryCost = {
  requestedQueryCost: number
  actualQueryCost?: number | null
  throttleStatus: ThrottleStatus
}

/** Shopify's hard per-query ceiling, identical on every plan. A deeper bucket does not raise it. */
export const MAX_SINGLE_QUERY_COST = 1000

/** Pace below this fraction of the bucket so a burst never starves a concurrent run. */
const DEFAULT_HEADROOM_RATIO = 0.2

/** Read `extensions.cost` defensively — shape varies and may be absent entirely. */
export function parseCost(extensions: unknown): QueryCost | null {
  if (!extensions || typeof extensions !== 'object') return null
  const cost = (extensions as Record<string, unknown>).cost
  if (!cost || typeof cost !== 'object') return null

  const record = cost as Record<string, unknown>
  const throttle = record.throttleStatus
  if (!throttle || typeof throttle !== 'object') return null

  const t = throttle as Record<string, unknown>
  const maximumAvailable = Number(t.maximumAvailable)
  const currentlyAvailable = Number(t.currentlyAvailable)
  const restoreRate = Number(t.restoreRate)
  if (![maximumAvailable, currentlyAvailable, restoreRate].every(Number.isFinite)) return null

  const requestedQueryCost = Number(record.requestedQueryCost)
  const actualRaw = Number(record.actualQueryCost)

  return {
    requestedQueryCost: Number.isFinite(requestedQueryCost) ? requestedQueryCost : 0,
    actualQueryCost: Number.isFinite(actualRaw) ? actualRaw : null,
    throttleStatus: { maximumAvailable, currentlyAvailable, restoreRate },
  }
}

/** Did this 200 response actually carry a throttle error? */
export function isThrottledResponse(errors: unknown): boolean {
  const list = extractErrorList(errors)
  return list.some((error) => {
    const code = (error?.extensions as Record<string, unknown> | undefined)?.code
    return typeof code === 'string' && code.toUpperCase() === 'THROTTLED'
  })
}

/** Cost ceiling breach — distinct from throttling: retrying is pointless, the query must shrink. */
export function isMaxCostExceeded(errors: unknown): boolean {
  const list = extractErrorList(errors)
  return list.some((error) => {
    const code = (error?.extensions as Record<string, unknown> | undefined)?.code
    return typeof code === 'string' && code.toUpperCase() === 'MAX_COST_EXCEEDED'
  })
}

type GraphQLErrorLike = { message?: string; extensions?: unknown }

/**
 * `ResponseErrors` is a union: sometimes `{ graphQLErrors: [...] }`, sometimes a bare array,
 * sometimes `{ message }` for a network-level failure. Normalise all of it.
 */
export function extractErrorList(errors: unknown): GraphQLErrorLike[] {
  if (!errors) return []
  if (Array.isArray(errors)) return errors as GraphQLErrorLike[]
  if (typeof errors === 'object') {
    const graphQLErrors = (errors as Record<string, unknown>).graphQLErrors
    if (Array.isArray(graphQLErrors)) return graphQLErrors as GraphQLErrorLike[]
    return [errors as GraphQLErrorLike]
  }
  return []
}

/**
 * How long to wait before retrying a throttled query, from the server's own arithmetic:
 * `(requestedQueryCost − currentlyAvailable) / restoreRate`, in ms.
 *
 * Preferred over blind exponential backoff — it waits exactly as long as the bucket needs, no
 * more. Falls back to `fallbackMs` when cost data is missing.
 */
export function computeBackoffMs(cost: QueryCost | null, fallbackMs = 1000): number {
  if (!cost) return fallbackMs
  const { requestedQueryCost, throttleStatus } = cost
  const { currentlyAvailable, restoreRate } = throttleStatus
  if (restoreRate <= 0) return fallbackMs

  const deficit = requestedQueryCost - currentlyAvailable
  if (deficit <= 0) return 0
  return Math.ceil((deficit / restoreRate) * 1000)
}

/**
 * Tracks bucket capacity across requests for one shop.
 *
 * Capacity is only ever learned from responses — never assumed — because bucket size varies by
 * plan and the documented example values are out of date.
 */
export class CostTracker {
  private status: ThrottleStatus | null = null
  private observedAtMs = 0
  private readonly headroomRatio: number
  private readonly now: () => number

  constructor(opts?: { headroomRatio?: number; now?: () => number }) {
    this.headroomRatio = opts?.headroomRatio ?? DEFAULT_HEADROOM_RATIO
    this.now = opts?.now ?? (() => Date.now())
  }

  observe(cost: QueryCost | null): void {
    if (!cost) return
    this.status = cost.throttleStatus
    this.observedAtMs = this.now()
  }

  /** Last seen capacity, or null before the first response. */
  get lastStatus(): ThrottleStatus | null {
    return this.status
  }

  /** Available points, extrapolated forward from the last observation via the restore rate. */
  estimateAvailable(): number | null {
    if (!this.status) return null
    const elapsedSec = Math.max(0, (this.now() - this.observedAtMs) / 1000)
    const restored = elapsedSec * this.status.restoreRate
    return Math.min(this.status.maximumAvailable, this.status.currentlyAvailable + restored)
  }

  /**
   * Delay before issuing a query of `estimatedCost`, so we stay above the headroom floor.
   * Returns 0 when there is capacity, or before any response has been seen.
   */
  delayForMs(estimatedCost: number): number {
    if (!this.status) return 0
    const available = this.estimateAvailable()
    if (available === null) return 0

    const floor = this.status.maximumAvailable * this.headroomRatio
    const needed = estimatedCost + floor
    if (available >= needed) return 0
    if (this.status.restoreRate <= 0) return 0

    return Math.ceil(((needed - available) / this.status.restoreRate) * 1000)
  }
}

/**
 * Largest page size affordable within the per-query cost ceiling.
 *
 * A connection costs roughly `first × perNodeCost`, so this keeps a page from tripping
 * MAX_COST_EXCEEDED. Clamped to Shopify's 250-per-page maximum.
 */
export function safePageSize(perNodeCost: number, desired = 250, ceiling = MAX_SINGLE_QUERY_COST): number {
  if (perNodeCost <= 0) return Math.min(desired, 250)
  const affordable = Math.floor((ceiling * 0.8) / perNodeCost)
  return Math.max(1, Math.min(desired, 250, affordable))
}
