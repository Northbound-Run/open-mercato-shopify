import { REQUIRED_SCOPES } from './constants'

/**
 * Shop domain validation and scope helpers.
 *
 * Shop domains are always `<handle>.myshopify.com`.
 *
 * The validation here is a SECURITY control, not tidiness. The token endpoint URL is built from
 * a caller-supplied domain and the request POSTs our client secret to it, so an unvalidated
 * domain would exfiltrate the secret to an arbitrary host.
 */

const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

export class ShopifyAuthError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ShopifyAuthError'
    this.code = code
  }
}

/**
 * Normalise and validate a shop domain. Accepts a bare domain or a full URL and returns the
 * canonical lowercase host. Throws for anything that is not a myshopify.com host.
 */
export function normalizeShopDomain(input: string | null | undefined): string {
  if (!input) throw new ShopifyAuthError('invalid_shop', '[internal] shop domain is required')

  let host = input.trim().toLowerCase()
  if (host.includes('://')) {
    try {
      host = new URL(host).host
    } catch {
      throw new ShopifyAuthError('invalid_shop', `[internal] unparseable shop domain: ${input}`)
    }
  }
  host = host.replace(/\/.*$/, '').replace(/:\d+$/, '')

  if (!SHOP_DOMAIN_PATTERN.test(host)) {
    throw new ShopifyAuthError(
      'invalid_shop',
      `[internal] not a valid .myshopify.com shop domain: ${input}`,
    )
  }
  return host
}

/**
 * Which of the scopes we need did the app not actually get?
 *
 * With the client credentials grant, scopes are configured on the app in the Dev Dashboard
 * rather than requested per token — so a misconfigured app yields a perfectly valid token that
 * silently cannot read one of our entity types. Surfacing this at connect time beats
 * discovering it as a mid-run failure.
 */
export function missingScopes(
  granted: readonly string[],
  required: readonly string[] = REQUIRED_SCOPES,
): string[] {
  const have = new Set(granted)
  return required.filter((scope) => !have.has(scope))
}

/**
 * Did the app obtain full order history, or only Shopify's default 60-day window?
 *
 * `read_all_orders` is approval-gated, so most installs are limited. This must be surfaced — a
 * truncated backfill that reports success is worse than one that refuses to run.
 */
export function orderHistoryWindow(granted: readonly string[]): 'full' | 'sixty_days' {
  return granted.includes('read_all_orders') ? 'full' : 'sixty_days'
}

export function parseScopeList(scope: string | null | undefined): string[] {
  if (!scope) return []
  return scope
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
