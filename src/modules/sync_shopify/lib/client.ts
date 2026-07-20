import { createAdminApiClient } from '@shopify/admin-api-client'
import { DEFAULT_API_VERSION } from './constants'
import { normalizeShopDomain } from './shop-domain'
import type { TokenProvider } from './token'
import {
  CostTracker,
  computeBackoffMs,
  extractErrorList,
  isMaxCostExceeded,
  isThrottledResponse,
  parseCost,
  type QueryCost,
} from './throttle'

/**
 * Shopify Admin GraphQL client.
 *
 * `@shopify/admin-api-client` owns the wire — URL and header construction, API version pinning,
 * deprecation notices — and we own pacing and token lifecycle. That split is deliberate:
 *
 *  - The SDK's `retries` fires only on HTTP 429/503, whereas Shopify signals cost throttling on
 *    an HTTP 200 with `errors[].extensions.code === 'THROTTLED'`.
 *  - Client-credentials tokens live 24 hours with no refresh token, so a long backfill can
 *    outlive its own token. The token is therefore fetched per request from a provider and
 *    re-minted on a 401, rather than captured once at construction.
 *
 * All SDK usage is confined to this file, so swapping to raw fetch later is a local change.
 */

export type ShopifyClientOptions = {
  shopDomain: string
  tokenProvider: TokenProvider
  apiVersion?: string
  /** Injected in tests. */
  customFetchApi?: typeof fetch
  /** Retries for throttling, token expiry and transient failures — not for permanent errors. */
  maxRetries?: number
  /** Ceiling on a single backoff wait, so a starved bucket cannot stall a run indefinitely. */
  backoffCapMs?: number
  sleep?: (ms: number) => Promise<void>
  onDeprecation?: (notice: string) => void
}

export type GraphQLRequestOptions = {
  variables?: Record<string, unknown>
  /** Estimated cost, used to pace *before* sending. Optional but improves smoothing. */
  estimatedCost?: number
  signal?: AbortSignal
  /**
   * Extra request headers.
   *
   * Exists chiefly for `SEARCH_DEBUG_HEADER`: Shopify only populates `extensions.search` when the
   * request asks for it, so without this the R-13 detection is wired but permanently silent.
   */
  headers?: Record<string, string>
}

/**
 * Ask Shopify to report how it interpreted a `query:` filter.
 *
 * R-13: an invalid search field is **ignored**, and the connection returns everything — a delta run
 * silently degrades into a full scan while still returning correct-looking data. The only signal is
 * `extensions.search[].warnings`, and Shopify emits it solely when this header is present. Any
 * adapter issuing a filtered query should send it and assert the warnings are empty.
 */
export const SEARCH_DEBUG_HEADER = { 'Shopify-Search-Query-Debug': '1' } as const

export class ShopifyApiError extends Error {
  readonly code: string
  readonly retryable: boolean
  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'ShopifyApiError'
    this.code = code
    this.retryable = retryable
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A response with its `extensions` envelope intact. See `requestDetailed`. */
export type DetailedResponse<TData> = {
  data: TData
  extensions: Record<string, unknown> | undefined
}

export type ShopifyClient = {
  readonly shopDomain: string
  readonly apiVersion: string
  request<TData = unknown>(query: string, options?: GraphQLRequestOptions): Promise<TData>
  /**
   * Same request, but returns `extensions` alongside the data.
   *
   * Needed because Shopify reports a **silently ignored search filter** in
   * `extensions.search[].warnings` rather than as an error — and per R-13, an invalid field means
   * "the query is ignored and all results are returned". A delta sync with a typo'd `updated_at`
   * therefore degrades into a full scan that still returns correct-looking data. Callers doing
   * filtered queries should send `Shopify-Search-Query-Debug: 1` and assert those warnings are
   * empty; `request` alone discards the only evidence that anything went wrong.
   */
  requestDetailed<TData = unknown>(
    query: string,
    options?: GraphQLRequestOptions,
  ): Promise<DetailedResponse<TData>>
  /** Last observed bucket state — for surfacing pacing in run telemetry. */
  readonly cost: CostTracker
}

export function createShopifyClient(options: ShopifyClientOptions): ShopifyClient {
  const shopDomain = normalizeShopDomain(options.shopDomain)
  const apiVersion = options.apiVersion?.trim() || DEFAULT_API_VERSION
  const maxRetries = options.maxRetries ?? 3
  const backoffCapMs = options.backoffCapMs ?? 30_000
  const sleep = options.sleep ?? defaultSleep
  const tracker = new CostTracker()

  // The SDK holds a static accessToken, so a client is built per token. Tokens change rarely
  // (once a day), and construction is cheap — it allocates no connections.
  let clientToken: string | null = null
  let client: ReturnType<typeof createAdminApiClient> | null = null

  function clientFor(accessToken: string) {
    if (client && clientToken === accessToken) return client
    clientToken = accessToken
    client = createAdminApiClient({
      storeDomain: shopDomain,
      apiVersion,
      accessToken,
      userAgentPrefix: 'open-mercato-sync-shopify',
      // Left at 0 on purpose: the SDK's retry cannot see HTTP-200 throttling, so retrying is
      // handled below where the cost data is actually available.
      retries: 0,
      ...(options.customFetchApi ? { customFetchApi: options.customFetchApi } : {}),
      ...(options.onDeprecation
        ? {
            logger: (log: { type?: string; content?: unknown }) => {
              // Quarterly API releases are real breaking boundaries; surface deprecations early
              // rather than discovering them when a version is retired.
              if (log?.type === 'HTTP-Response-GraphQL-Deprecation-Notice') {
                options.onDeprecation?.(JSON.stringify(log.content))
              }
            },
          }
        : {}),
    })
    return client
  }

  async function requestDetailed<TData = unknown>(
    query: string,
    requestOptions: GraphQLRequestOptions = {},
  ): Promise<DetailedResponse<TData>> {
    const { variables, estimatedCost, signal, headers } = requestOptions
    let lastCost: QueryCost | null = null
    let tokenRetried = false

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      signal?.throwIfAborted()

      // Pace proactively so we rarely trip the bucket at all.
      const preDelay = estimatedCost ? tracker.delayForMs(estimatedCost) : 0
      if (preDelay > 0) await sleep(Math.min(preDelay, backoffCapMs))

      const token = await options.tokenProvider.getToken()
      const response = await clientFor(token.accessToken).request<TData>(
        query,
        variables || headers
          ? { ...(variables ? { variables } : {}), ...(headers ? { headers } : {}) }
          : undefined,
      )

      lastCost = parseCost(response.extensions)
      tracker.observe(lastCost)

      // Shopify returns HTTP 200 for throttling, so the body is the only signal.
      if (isThrottledResponse(response.errors)) {
        if (attempt === maxRetries) {
          throw new ShopifyApiError('throttled', '[internal] throttled and out of retries', true)
        }
        await sleep(Math.min(computeBackoffMs(lastCost), backoffCapMs))
        continue
      }

      // A cost-ceiling breach is permanent: the query must shrink, not be retried.
      if (isMaxCostExceeded(response.errors)) {
        throw new ShopifyApiError(
          'max_cost_exceeded',
          '[internal] query exceeds the 1000-point per-query ceiling; reduce page size or nesting',
        )
      }

      const errors = extractErrorList(response.errors)
      if (errors.length > 0) {
        const codes = errors
          .map((e) => (e.extensions as Record<string, unknown> | undefined)?.code)
          .filter((c): c is string => typeof c === 'string')
        const messages = errors.map((e) => e.message).filter(Boolean).join('; ')
        const isAuth = codes.some((c) => ['ACCESS_DENIED', 'UNAUTHORIZED'].includes(c.toUpperCase()))

        // A 24-hour token can expire mid-backfill. Re-mint once and retry before concluding the
        // credentials are bad — otherwise a long run dies of old age rather than of a real fault.
        if (isAuth && !tokenRetried) {
          tokenRetried = true
          options.tokenProvider.invalidate()
          continue
        }

        throw new ShopifyApiError(
          isAuth ? 'unauthorized' : 'graphql_error',
          `[internal] Shopify GraphQL error: ${messages || codes.join(',') || 'unknown'}`,
        )
      }

      if (response.data === undefined || response.data === null) {
        throw new ShopifyApiError('empty_response', '[internal] Shopify returned no data and no errors')
      }

      // `extensions` travels back with the data: it carries the cost envelope and, for filtered
      // queries, `search[].warnings` — the only signal that Shopify ignored a filter and quietly
      // returned everything (R-13).
      return { data: response.data, extensions: response.extensions }
    }

    throw new ShopifyApiError('throttled', '[internal] exhausted retries', true)
  }

  async function request<TData = unknown>(
    query: string,
    requestOptions: GraphQLRequestOptions = {},
  ): Promise<TData> {
    return (await requestDetailed<TData>(query, requestOptions)).data
  }

  return { shopDomain, apiVersion, request, requestDetailed, cost: tracker }
}
