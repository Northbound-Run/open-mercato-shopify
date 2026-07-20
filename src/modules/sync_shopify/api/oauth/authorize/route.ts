import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import { BUNDLE_ID } from '../../../lib/constants'
import { buildAuthorizeUrl, normalizeShopDomain, ShopifyOAuthError } from '../../../lib/oauth'
import { buildStateCookie, createNonce, serializeState } from '../../../lib/oauth-state'
import { resolveRedirectUri, shouldUseSecureCookie } from '../../../lib/redirect-uri'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['sync_shopify.configure'] },
}

export const openApi = {
  tags: ['ShopifySync'],
  summary: 'Begin the Shopify OAuth authorization flow',
  description:
    'Redirects to the shop\'s Shopify authorization screen. Requires shopDomain and clientId to be saved on the sync_shopify integration bundle first.',
}

type CredentialsService = {
  getRaw(integrationId: string, scope: IntegrationScope): Promise<Record<string, unknown> | null>
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId || !auth.sub) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Tenant-wide credential: userId is deliberately left unset. Setting it would silently
  // resolve a different (per-user) credential row rather than erroring.
  const scope: IntegrationScope = { organizationId: auth.orgId, tenantId: auth.tenantId }

  const container = await createRequestContainer()
  const credentialsService = container.resolve('integrationCredentialsService') as CredentialsService
  const credentials = (await credentialsService.getRaw(BUNDLE_ID, scope)) ?? {}

  const clientId = typeof credentials.clientId === 'string' ? credentials.clientId.trim() : ''
  const clientSecret = typeof credentials.clientSecret === 'string' ? credentials.clientSecret : ''
  const rawShopDomain = typeof credentials.shopDomain === 'string' ? credentials.shopDomain : ''

  if (!clientId || !clientSecret || !rawShopDomain) {
    return Response.json(
      {
        error: 'Shopify connection is not configured',
        code: 'not_configured',
        missing: [
          !rawShopDomain && 'shopDomain',
          !clientId && 'clientId',
          !clientSecret && 'clientSecret',
        ].filter(Boolean),
      },
      { status: 409 },
    )
  }

  let shopDomain: string
  try {
    shopDomain = normalizeShopDomain(rawShopDomain)
  } catch (error) {
    const code = error instanceof ShopifyOAuthError ? error.code : 'invalid_shop'
    return Response.json({ error: 'Invalid shop domain', code }, { status: 422 })
  }

  const redirectUri = resolveRedirectUri(req)
  const nonce = createNonce()
  const stateCookie = serializeState(
    {
      nonce,
      shopDomain,
      integrationId: BUNDLE_ID,
      userId: auth.sub,
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
      issuedAt: Date.now(),
    },
    // Signing with the client secret avoids introducing another key to manage. It also means a
    // rotated secret invalidates in-flight flows, which is the behaviour we want.
    clientSecret,
  )

  const authorizeUrl = buildAuthorizeUrl({ shopDomain, clientId, redirectUri, state: nonce })

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl,
      'Set-Cookie': buildStateCookie(stateCookie, { secure: shouldUseSecureCookie(redirectUri) }),
      'Cache-Control': 'no-store',
    },
  })
}

export default GET
