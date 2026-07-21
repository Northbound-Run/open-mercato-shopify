import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import { createShopifyClient, ShopifyApiError } from './client'
import { REQUIRED_SCOPES } from './constants'
import { resolveConnectionCredentials } from './preset'
import { missingScopes, orderHistoryWindow, ShopifyAuthError } from './shop-domain'
import { createTokenProvider } from './token'

/**
 * Health probe for the Shopify connection.
 *
 * Registered in DI under the name declared by `integration.healthCheck.service`; the framework's
 * health service resolves it by that name and races it against a 10s timeout.
 *
 * The probe mints a token via the client credentials grant and then runs `shop { name }` — the
 * cheapest authenticated call available at 1 point. That exercises the whole chain (credentials
 * → token → API) in two round trips, so a green health check genuinely means a sync would work.
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
    // Env-first: a stored field wins, else the OM_INTEGRATION_SHOPIFY_* env var — so health reflects
    // the same connection the sync runtime uses, even on a store that was never populated via the UI.
    const { shopDomain, clientId, clientSecret, apiVersion } = resolveConnectionCredentials(credentials ?? {})

    const missingConfig = [
      !shopDomain && 'shopDomain',
      !clientId && 'clientId',
      !clientSecret && 'clientSecret',
    ].filter(Boolean) as string[]

    if (missingConfig.length > 0) {
      return {
        status: 'unhealthy',
        message: `Not configured. Missing: ${missingConfig.join(', ')}.`,
        details: { code: 'not_configured', missing: missingConfig, reauthRequired: false },
      }
    }

    const tokenProvider = createTokenProvider({ shopDomain, clientId, clientSecret })

    // Step 1: can we mint a token at all? Failing here is a credentials problem, and is worth
    // distinguishing from the store being unreachable.
    let grantedScopes: string[]
    try {
      const token = await tokenProvider.getToken()
      grantedScopes = token.grantedScopes
    } catch (error) {
      if (error instanceof ShopifyAuthError) {
        const isCredentialFault = error.code === 'invalid_client' || error.code === 'invalid_shop'
        return {
          status: 'unhealthy',
          message: isCredentialFault
            ? 'Shopify rejected the client ID or secret. Check the credentials, and that the app is installed on this store.'
            : 'Could not obtain an access token from Shopify.',
          details: { code: error.code, reauthRequired: isCredentialFault },
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      return {
        status: 'unhealthy',
        message: 'Could not obtain an access token from Shopify.',
        details: { code: 'token_request_failed', reauthRequired: false, error: message },
      }
    }

    // Step 2: does the token actually work against the Admin API?
    const client = createShopifyClient({ shopDomain, tokenProvider, apiVersion })

    let data: ShopProbeData
    try {
      data = await client.request<ShopProbeData>(SHOP_PROBE, { estimatedCost: 1 })
    } catch (error) {
      if (error instanceof ShopifyApiError && error.code === 'unauthorized') {
        return {
          status: 'unhealthy',
          message: 'Shopify rejected the access token. Confirm the app is installed on this store.',
          details: { code: 'unauthorized', reauthRequired: true },
        }
      }
      if (error instanceof ShopifyApiError && error.code === 'throttled') {
        // Throttling means the credentials are fine and the store is reachable — degraded, not
        // broken.
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

    const details: Record<string, unknown> = {
      shopName: shop.name,
      myshopifyDomain: shop.myshopifyDomain,
      currencyCode: shop.currencyCode,
      plan: shop.plan?.displayName,
      apiVersion,
      grantedScopes,
      orderHistoryWindow: orderHistoryWindow(grantedScopes),
      reauthRequired: false,
    }

    // Scopes are configured on the app, not requested per token, so a misconfigured app yields a
    // valid token that silently cannot read one entity type. Surface it here rather than letting
    // it fail mid-run.
    const missing = missingScopes(grantedScopes, REQUIRED_SCOPES)
    if (missing.length > 0) {
      return {
        status: 'degraded',
        message: `Connected, but the app is missing scopes: ${missing.join(', ')}. Add them in the Dev Dashboard and release a new app version.`,
        details: { ...details, code: 'partial_scopes', missingScopes: missing },
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
