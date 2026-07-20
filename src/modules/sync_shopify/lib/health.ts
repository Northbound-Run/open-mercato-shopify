import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import { createShopifyClient, ShopifyApiError } from './client'
import { DEFAULT_API_VERSION, REQUIRED_SCOPES } from './constants'
import { missingScopes, orderHistoryWindow } from './oauth'

/**
 * Health probe for the Shopify connection.
 *
 * Registered in DI under the name declared by `integration.healthCheck.service`; the framework's
 * health service resolves it by that name and races it against a 10s timeout.
 *
 * The probe is a `shop { name }` query — the cheapest authenticated call available, costing 1
 * point, which confirms the token, the shop domain and the API version in a single round trip.
 */

export type HealthCheckResult = {
  status: 'healthy' | 'degraded' | 'unhealthy'
  message?: string
  details?: Record<string, unknown>
}

const SHOP_PROBE = `#graphql
  query SyncShopifyHealthProbe {
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

export const shopifyHealthCheck = {
  async check(
    credentials: Record<string, unknown> | null,
    _scope: IntegrationScope,
  ): Promise<HealthCheckResult> {
    const shopDomain = typeof credentials?.shopDomain === 'string' ? credentials.shopDomain : ''
    const accessToken = typeof credentials?.accessToken === 'string' ? credentials.accessToken : ''
    const apiVersion =
      typeof credentials?.apiVersion === 'string' && credentials.apiVersion
        ? credentials.apiVersion
        : DEFAULT_API_VERSION

    if (!shopDomain) {
      return {
        status: 'unhealthy',
        message: 'No shop domain configured.',
        details: { code: 'not_configured' },
      }
    }
    if (!accessToken) {
      // Distinct from a bad token: nothing has been connected yet, so prompt to connect rather
      // than to re-authorize.
      return {
        status: 'unhealthy',
        message: 'Not connected. Complete the Shopify authorization to obtain an access token.',
        details: { code: 'not_connected', reauthRequired: true },
      }
    }

    const client = createShopifyClient({ shopDomain, accessToken, apiVersion })

    let data: ShopProbeData
    try {
      data = await client.request<ShopProbeData>(SHOP_PROBE, { estimatedCost: 1 })
    } catch (error) {
      if (error instanceof ShopifyApiError && error.code === 'unauthorized') {
        return {
          status: 'unhealthy',
          message: 'Shopify rejected the access token. Re-authorize the connection.',
          details: { code: 'unauthorized', reauthRequired: true },
        }
      }
      if (error instanceof ShopifyApiError && error.code === 'throttled') {
        // Throttling means the credentials are fine and the store is reachable — that is a
        // degraded connection, not a broken one.
        return {
          status: 'degraded',
          message: 'Shopify is rate limiting requests.',
          details: { code: 'throttled', reauthRequired: false },
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      return {
        status: 'unhealthy',
        message: 'Could not reach the Shopify Admin API.',
        details: { code: 'unreachable', reauthRequired: false, error: message },
      }
    }

    const shop = data.shop
    if (!shop?.myshopifyDomain) {
      return {
        status: 'degraded',
        message: 'Shopify responded but returned no shop record.',
        details: { code: 'unexpected_response' },
      }
    }

    // A narrower-than-requested grant is silent on Shopify's side — surface it here, because
    // otherwise it shows up as a mid-run failure on one entity type.
    const granted =
      typeof credentials?.grantedScopes === 'string' && credentials.grantedScopes
        ? credentials.grantedScopes.split(',').map((s) => s.trim()).filter(Boolean)
        : []
    const missing = granted.length > 0 ? missingScopes(granted, REQUIRED_SCOPES) : []

    const details: Record<string, unknown> = {
      shopName: shop.name,
      myshopifyDomain: shop.myshopifyDomain,
      currencyCode: shop.currencyCode,
      plan: shop.plan?.displayName,
      apiVersion,
      reauthRequired: false,
      orderHistoryWindow: granted.length > 0 ? orderHistoryWindow(granted) : 'unknown',
    }

    if (missing.length > 0) {
      return {
        status: 'degraded',
        message: `Connected, but missing scopes: ${missing.join(', ')}. Re-authorize to grant them.`,
        details: { ...details, code: 'partial_scopes', missingScopes: missing, reauthRequired: true },
      }
    }

    return {
      status: 'healthy',
      message: `Connected to ${shop.name ?? shop.myshopifyDomain}.`,
      details,
    }
  },
}

export default shopifyHealthCheck
