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
}

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

export type ShopifyClient = {
  readonly shopDomain: string
  readonly apiVersion: string
  request<TData = unknown>(query: string, options?: GraphQLRequestOptions): Promise<TData>
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

  async function request<TData = unknown>(
    query: string,
    requestOptions: GraphQLRequestOptions = {},
  ): Promise<TData> {
    const { variables, estimatedCost, signal } = requestOptions
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
        variables ? { variables } : undefined,
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

      return response.data
    }

    throw new ShopifyApiError('throttled', '[internal] exhausted retries', true)
  }

  return { shopDomain, apiVersion, request, cost: tracker }
}
