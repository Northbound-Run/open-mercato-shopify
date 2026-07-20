/**
 * The OAuth redirect URI must byte-match a redirect URL registered on the Shopify app, so it has
 * to be stable and absolute.
 *
 * Preference order:
 *  1. `OM_SHOPIFY_OAUTH_REDIRECT_URI` — explicit, and the only correct answer when the app sits
 *     behind a proxy or tunnel whose external origin differs from what the request reports.
 *  2. `APP_URL` / `NEXT_PUBLIC_APP_URL` — the host app's configured public origin.
 *  3. The request's own origin — convenient in local dev, unreliable behind a proxy.
 */

export const CALLBACK_PATH = '/api/sync_shopify/oauth/callback'

export function resolveRedirectUri(req: Request, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OM_SHOPIFY_OAUTH_REDIRECT_URI?.trim()
  if (explicit) return explicit

  const configuredOrigin = (env.APP_URL ?? env.NEXT_PUBLIC_APP_URL)?.trim()
  if (configuredOrigin) return new URL(CALLBACK_PATH, configuredOrigin).toString()

  return new URL(CALLBACK_PATH, new URL(req.url).origin).toString()
}

/** Where to send the browser once the flow finishes, with a flash message in the query string. */
export function buildReturnUrl(
  req: Request,
  integrationId: string,
  flash: { status: 'connected' } | { status: 'error'; reason: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredOrigin = (env.APP_URL ?? env.NEXT_PUBLIC_APP_URL)?.trim() ?? new URL(req.url).origin
  const url = new URL(`/backend/integrations/${integrationId}`, configuredOrigin)
  url.searchParams.set('shopifyAuth', flash.status)
  if (flash.status === 'error') url.searchParams.set('shopifyAuthReason', flash.reason)
  return url.toString()
}

/**
 * Whether to mark the state cookie `Secure`. Shopify requires HTTPS redirect URLs in production;
 * plain-http localhost is the only case where `Secure` would prevent the cookie coming back.
 */
export function shouldUseSecureCookie(redirectUri: string): boolean {
  try {
    return new URL(redirectUri).protocol === 'https:'
  } catch {
    return true
  }
}
