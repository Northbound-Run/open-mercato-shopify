import { createShopifyClient, ShopifyApiError } from './client'
import { DEFAULT_API_VERSION, REQUIRED_SCOPES } from './constants'
import { missingScopes, normalizeShopDomain, orderHistoryWindow, ShopifyAuthError } from './shop-domain'
import { createTokenProvider, type FetchImpl } from './token'

/**
 * Connection probe.
 *
 * Deliberately step-by-step rather than one try/catch: the useful information is *which* step
 * failed. "Bad client secret" and "app not installed on this store" and "store unreachable" all
 * present as a failure to get data, but need completely different fixes.
 *
 * Shares the exact code path a real sync uses — token provider, client, throttling — so a green
 * probe is evidence the sync will authenticate, not merely that the credentials look well-formed.
 */

export type ProbeStepStatus = 'ok' | 'failed' | 'warning' | 'skipped'

export type ProbeStep = {
  name: string
  status: ProbeStepStatus
  detail: string
  /** Actionable next step when this is what went wrong. */
  hint?: string
}

export type ProbeResult = {
  ok: boolean
  steps: ProbeStep[]
  shop?: {
    name?: string
    myshopifyDomain?: string
    currencyCode?: string
    plan?: string
  }
  grantedScopes?: string[]
  missingScopes?: string[]
  orderHistoryWindow?: 'full' | 'sixty_days'
  apiVersion?: string
}

const SHOP_PROBE = `#graphql
  query SyncShopifyConnectionProbe {
    shop {
      name
      myshopifyDomain
      currencyCode
      plan { displayName }
    }
  }
`

type ShopProbeData = {
  shop?: {
    name?: string
    myshopifyDomain?: string
    currencyCode?: string
    plan?: { displayName?: string }
  }
}

export type ProbeInput = {
  shopDomain: string
  clientId: string
  clientSecret: string
  apiVersion?: string
  fetchImpl?: FetchImpl
}

export async function probeConnection(input: ProbeInput): Promise<ProbeResult> {
  const steps: ProbeStep[] = []
  const apiVersion = input.apiVersion?.trim() || DEFAULT_API_VERSION

  // ── Step 1: shop domain ────────────────────────────────────────────────────────────────────
  let shopDomain: string
  try {
    shopDomain = normalizeShopDomain(input.shopDomain)
    steps.push({ name: 'Shop domain', status: 'ok', detail: shopDomain })
  } catch (error) {
    steps.push({
      name: 'Shop domain',
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      hint: 'Use the permanent .myshopify.com domain (Settings → Domains), not a custom storefront domain.',
    })
    return { ok: false, steps, apiVersion }
  }

  if (!input.clientId || !input.clientSecret) {
    steps.push({
      name: 'Credentials',
      status: 'failed',
      detail: `Missing ${!input.clientId ? 'client ID' : 'client secret'}`,
      hint: 'Both are on the app\'s Settings page in the Dev Dashboard.',
    })
    return { ok: false, steps, apiVersion }
  }
  steps.push({ name: 'Credentials', status: 'ok', detail: 'client ID and secret present' })

  // ── Step 2: mint a token ───────────────────────────────────────────────────────────────────
  const tokenProvider = createTokenProvider({
    shopDomain,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    fetchImpl: input.fetchImpl,
  })

  let grantedScopes: string[]
  try {
    const token = await tokenProvider.getToken()
    grantedScopes = token.grantedScopes
    const hoursLeft = Math.round((token.expiresAtMs - Date.now()) / 3_600_000)
    steps.push({
      name: 'Access token',
      status: 'ok',
      detail: `minted, valid ~${hoursLeft}h`,
    })
  } catch (error) {
    const code = error instanceof ShopifyAuthError ? error.code : 'unknown'
    const hint =
      code === 'invalid_client'
        ? 'Shopify rejected the client ID/secret. Check for a copy-paste error, and confirm the app is INSTALLED on this store — the client credentials grant only works for a store the app is installed in.'
        : code === 'shop_not_found'
          ? 'No Shopify store exists at that domain. Check the spelling, and use the permanent .myshopify.com domain rather than a custom one.'
          : code === 'network_error'
            ? 'Could not reach the store. Check the domain and your network egress.'
            : 'Confirm the app exists in the Dev Dashboard and has a released version.'
    steps.push({
      name: 'Access token',
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      hint,
    })
    return { ok: false, steps, apiVersion }
  }

  // ── Step 3: use the token against the Admin API ────────────────────────────────────────────
  const client = createShopifyClient({
    shopDomain,
    tokenProvider,
    apiVersion,
    ...(input.fetchImpl ? { customFetchApi: input.fetchImpl as unknown as typeof fetch } : {}),
  })

  let data: ShopProbeData
  try {
    data = await client.request<ShopProbeData>(SHOP_PROBE, { estimatedCost: 1 })
    steps.push({ name: `Admin API (${apiVersion})`, status: 'ok', detail: 'shop query succeeded' })
  } catch (error) {
    const code = error instanceof ShopifyApiError ? error.code : 'unknown'
    steps.push({
      name: `Admin API (${apiVersion})`,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      hint:
        code === 'unauthorized'
          ? 'The token was minted but rejected. This usually means the app is not installed on this store.'
          : `Check that API version ${apiVersion} is still supported.`,
    })
    return { ok: false, steps, grantedScopes, apiVersion }
  }

  const shop = data.shop
  const shopInfo = {
    name: shop?.name,
    myshopifyDomain: shop?.myshopifyDomain,
    currencyCode: shop?.currencyCode,
    plan: shop?.plan?.displayName,
  }

  // ── Step 4: scopes ─────────────────────────────────────────────────────────────────────────
  // Scopes are configured on the app, not requested per token, so a misconfigured app produces a
  // perfectly valid token that silently cannot read one entity type.
  const missing = missingScopes(grantedScopes, REQUIRED_SCOPES)
  if (missing.length > 0) {
    steps.push({
      name: 'Scopes',
      status: 'warning',
      detail: `missing: ${missing.join(', ')}`,
      hint: 'Add the scopes in the Dev Dashboard, release a new app version, then re-run. Syncing those entity types will fail until then.',
    })
  } else {
    steps.push({ name: 'Scopes', status: 'ok', detail: grantedScopes.join(', ') || '(none reported)' })
  }

  // ── Step 5: order history window ───────────────────────────────────────────────────────────
  const window = orderHistoryWindow(grantedScopes)
  steps.push({
    name: 'Order history',
    status: window === 'full' ? 'ok' : 'warning',
    detail: window === 'full' ? 'full history (read_all_orders granted)' : 'last 60 days only',
    hint:
      window === 'full'
        ? undefined
        : 'Shopify limits orders to 60 days unless read_all_orders is approved. Request it in the Dev Dashboard if you need historical orders; product, collection and customer syncs are unaffected.',
  })

  return {
    // Warnings do not fail the probe: a 60-day order window is a normal, supported configuration.
    ok: true,
    steps,
    shop: shopInfo,
    grantedScopes,
    missingScopes: missing,
    orderHistoryWindow: window,
    apiVersion,
  }
}

/** Render a probe result as plain text for a terminal. */
export function formatProbeResult(result: ProbeResult): string {
  const icon: Record<ProbeStepStatus, string> = {
    ok: '✓',
    failed: '✗',
    warning: '!',
    skipped: '-',
  }

  const lines: string[] = []
  for (const step of result.steps) {
    lines.push(`  ${icon[step.status]} ${step.name.padEnd(22)} ${step.detail}`)
    if (step.hint && step.status !== 'ok') lines.push(`      → ${step.hint}`)
  }

  if (result.shop?.myshopifyDomain) {
    lines.push('')
    lines.push('  Store')
    lines.push(`    name      ${result.shop.name ?? '(unknown)'}`)
    lines.push(`    domain    ${result.shop.myshopifyDomain}`)
    if (result.shop.currencyCode) lines.push(`    currency  ${result.shop.currencyCode}`)
    if (result.shop.plan) lines.push(`    plan      ${result.shop.plan}`)
  }

  lines.push('')
  lines.push(result.ok ? '  Connection OK.' : '  Connection FAILED.')
  return lines.join('\n')
}
