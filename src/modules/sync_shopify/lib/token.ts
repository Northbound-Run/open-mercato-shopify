import { normalizeShopDomain, parseScopeList, ShopifyAuthError } from './shop-domain'

/**
 * Shopify client credentials grant.
 *
 * The app exchanges its own client ID and secret for an access token, with no end-user
 * interaction. Shopify restricts this to "apps developed by your own organization and installed
 * in stores that you own" — which is exactly the self-hosted case, where each Open Mercato
 * install owns its own Shopify app for its own store.
 *
 * The property that matters architecturally: this works HEADLESSLY. A scheduled worker can mint
 * its own token. An authorization-code flow cannot — if its token died, a background sync would
 * stall until a human clicked something.
 *
 * The catch: `expires_in` is always 86399 (24 hours) and there is no refresh token. "Refreshing"
 * means repeating the identical request. A long backfill can therefore outlive its own token, so
 * callers must obtain the token per-request through a provider rather than capturing it once.
 */

/** Shopify always returns exactly this. Kept as a constant so tests can assert we never assume it. */
export const CLIENT_CREDENTIALS_TOKEN_TTL_SECONDS = 86_399

/**
 * Renew this far before actual expiry. Covers clock skew between us and Shopify and stops a
 * request being issued with a token that expires in flight.
 */
export const DEFAULT_EXPIRY_SKEW_MS = 5 * 60 * 1000

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export type AccessToken = {
  accessToken: string
  /** Scopes attached to the token, as configured on the app. */
  grantedScopes: string[]
  /** Absolute epoch millis at which Shopify considers the token expired. */
  expiresAtMs: number
}

export type RequestTokenInput = {
  shopDomain: string
  clientId: string
  clientSecret: string
  fetchImpl?: FetchImpl
  timeoutMs?: number
  nowMs?: number
}

/**
 * Perform the grant. One request, no redirect, no state.
 *
 * Note the encoding: Shopify's token endpoint takes `application/x-www-form-urlencoded` for this
 * grant, not JSON.
 */
export async function requestAccessToken(input: RequestTokenInput): Promise<AccessToken> {
  // Validate BEFORE building the URL — this is what stops the client secret being POSTed to an
  // attacker-supplied host.
  const shop = normalizeShopDomain(input.shopDomain)
  const doFetch = input.fetchImpl ?? (globalThis.fetch as FetchImpl)
  const timeoutMs = input.timeoutMs ?? 10_000
  const nowMs = input.nowMs ?? Date.now()

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: input.clientId,
    client_secret: input.clientSecret,
  })

  let response: Response
  try {
    response = await doFetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ShopifyAuthError('network_error', `[internal] token request failed: ${message}`)
  }

  if (!response.ok) {
    // 401/403 means the credentials themselves are wrong, which is not retryable and should
    // surface to the operator as "fix your client ID/secret" rather than as an outage.
    const code = response.status === 401 || response.status === 403 ? 'invalid_client' : 'token_request_failed'
    // Never echo the body — it can contain the submitted client_secret.
    throw new ShopifyAuthError(code, `[internal] token request returned HTTP ${response.status}`)
  }

  let payload: { access_token?: string; scope?: string; expires_in?: number }
  try {
    payload = (await response.json()) as typeof payload
  } catch {
    throw new ShopifyAuthError('token_request_failed', '[internal] token endpoint returned non-JSON body')
  }

  if (!payload.access_token) {
    throw new ShopifyAuthError('token_request_failed', '[internal] token endpoint returned no access_token')
  }

  // Trust the response's expires_in rather than the documented constant — if Shopify ever
  // changes the TTL, a hardcoded 24h would keep using a dead token.
  const ttlSeconds =
    typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
      ? payload.expires_in
      : CLIENT_CREDENTIALS_TOKEN_TTL_SECONDS

  return {
    accessToken: payload.access_token,
    grantedScopes: parseScopeList(payload.scope),
    expiresAtMs: nowMs + ttlSeconds * 1000,
  }
}

export type TokenProvider = {
  /** Current token, minting or renewing as required. */
  getToken(): Promise<AccessToken>
  /** Discard the cached token so the next call re-mints. Use after a 401 from the Admin API. */
  invalidate(): void
  /** Cached token without triggering a request — for diagnostics. */
  peek(): AccessToken | null
}

export type TokenProviderOptions = {
  shopDomain: string
  clientId: string
  clientSecret: string
  fetchImpl?: FetchImpl
  timeoutMs?: number
  now?: () => number
  expirySkewMs?: number
  /** Called whenever a new token is minted, so it can be cached outside the process. */
  onToken?: (token: AccessToken) => void | Promise<void>
  /** Seed from a previously persisted token to avoid a request on every cold start. */
  initialToken?: AccessToken | null
}

/**
 * Caches a token and renews it on demand.
 *
 * Concurrent callers share a single in-flight request: a batch of parallel adapter calls at
 * startup would otherwise stampede the token endpoint with identical requests.
 */
export function createTokenProvider(options: TokenProviderOptions): TokenProvider {
  const now = options.now ?? (() => Date.now())
  const skewMs = options.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS

  let cached: AccessToken | null = options.initialToken ?? null
  let inFlight: Promise<AccessToken> | null = null

  const isUsable = (token: AccessToken | null): token is AccessToken =>
    !!token && token.expiresAtMs - skewMs > now()

  async function mint(): Promise<AccessToken> {
    const token = await requestAccessToken({
      shopDomain: options.shopDomain,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      nowMs: now(),
    })
    cached = token
    await options.onToken?.(token)
    return token
  }

  return {
    async getToken() {
      if (isUsable(cached)) return cached
      if (inFlight) return inFlight

      inFlight = mint().finally(() => {
        inFlight = null
      })
      return inFlight
    },
    invalidate() {
      cached = null
    },
    peek() {
      return cached
    },
  }
}
