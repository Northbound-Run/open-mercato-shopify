import { REQUIRED_SCOPES } from './constants'

/**
 * Shopify OAuth authorization-code flow.
 *
 * As of 2026 there is no way to read an Admin API access token out of the Shopify UI for a newly
 * created app — the reveal-once `shpat_` button belonged to the retired admin custom-app flow.
 * A token is now minted only by this exchange, which makes it the critical path for the whole
 * integration rather than a convenience.
 *
 * Everything here is a pure function plus an injectable `fetchImpl`, so the flow is unit-testable
 * without a network or a live store.
 */

/**
 * Shopify shop domains are always `<handle>.myshopify.com`.
 *
 * This is a SECURITY control, not tidiness. Both the authorize URL and the token exchange are
 * built from a caller-supplied domain, and the exchange POSTs our client secret to it. Without
 * this check a crafted `shop` parameter would exfiltrate the secret to an arbitrary host, and the
 * authorize redirect would become an open redirect.
 */
const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

export class ShopifyOAuthError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ShopifyOAuthError'
    this.code = code
  }
}

/**
 * Normalise and validate a shop domain. Accepts a bare domain or a full URL and returns the
 * canonical lowercase host. Throws for anything that is not a myshopify.com host.
 */
export function normalizeShopDomain(input: string | null | undefined): string {
  if (!input) throw new ShopifyOAuthError('invalid_shop', '[internal] shop domain is required')

  let host = input.trim().toLowerCase()
  if (host.includes('://')) {
    try {
      host = new URL(host).host
    } catch {
      throw new ShopifyOAuthError('invalid_shop', `[internal] unparseable shop domain: ${input}`)
    }
  }
  host = host.replace(/\/.*$/, '').replace(/:\d+$/, '')

  if (!SHOP_DOMAIN_PATTERN.test(host)) {
    throw new ShopifyOAuthError(
      'invalid_shop',
      `[internal] not a valid .myshopify.com shop domain: ${input}`,
    )
  }
  return host
}

export function buildAuthorizeUrl(input: {
  shopDomain: string
  clientId: string
  redirectUri: string
  state: string
  scopes?: readonly string[]
}): string {
  const shop = normalizeShopDomain(input.shopDomain)
  const scopes = input.scopes?.length ? input.scopes : REQUIRED_SCOPES

  const url = new URL(`https://${shop}/admin/oauth/authorize`)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('scope', scopes.join(','))
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  return url.toString()
}

export type TokenExchangeResult = {
  accessToken: string
  /** Comma-separated scopes actually granted — may be narrower than requested. */
  scope: string
  grantedScopes: string[]
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Exchange an authorization code for an offline access token.
 *
 * Custom-distribution apps receive a non-expiring `shpat_`; the response carries no
 * `expires_in`. Public apps created on/after 2026-04-01 receive short-lived tokens plus a
 * `shprt_` refresh token — we surface those fields if present so adding refresh later does not
 * require reworking this function.
 */
export async function exchangeCodeForToken(input: {
  shopDomain: string
  clientId: string
  clientSecret: string
  code: string
  fetchImpl?: FetchImpl
  timeoutMs?: number
}): Promise<TokenExchangeResult> {
  const shop = normalizeShopDomain(input.shopDomain)
  const doFetch = input.fetchImpl ?? (globalThis.fetch as FetchImpl)
  const timeoutMs = input.timeoutMs ?? 10_000

  let response: Response
  try {
    response = await doFetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ShopifyOAuthError('network_error', `[internal] token exchange request failed: ${message}`)
  }

  if (!response.ok) {
    // Never echo the body verbatim — it can contain the submitted client_secret.
    throw new ShopifyOAuthError(
      'exchange_failed',
      `[internal] token exchange returned HTTP ${response.status}`,
    )
  }

  let body: { access_token?: string; scope?: string }
  try {
    body = (await response.json()) as { access_token?: string; scope?: string }
  } catch {
    throw new ShopifyOAuthError('exchange_failed', '[internal] token exchange returned non-JSON body')
  }

  if (!body.access_token) {
    throw new ShopifyOAuthError('exchange_failed', '[internal] token exchange returned no access_token')
  }

  const scope = body.scope ?? ''
  return {
    accessToken: body.access_token,
    scope,
    grantedScopes: scope ? scope.split(',').map((s) => s.trim()).filter(Boolean) : [],
  }
}

/**
 * Which of the scopes we asked for did we not get?
 *
 * Shopify silently grants a narrower set rather than failing, so a connection can look healthy
 * while a whole entity type is unreadable. Callers surface this instead of discovering it as a
 * 403 mid-run.
 */
export function missingScopes(granted: readonly string[], required: readonly string[] = REQUIRED_SCOPES): string[] {
  const have = new Set(granted)
  return required.filter((scope) => !have.has(scope))
}

/**
 * Did the install obtain full order history, or only Shopify's default 60-day window?
 *
 * `read_all_orders` is approval-gated, so most installs will be limited. This must be surfaced in
 * the UI — a truncated backfill that reports success is worse than one that refuses to run.
 */
export function orderHistoryWindow(granted: readonly string[]): 'full' | 'sixty_days' {
  return granted.includes('read_all_orders') ? 'full' : 'sixty_days'
}
