import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import { BUNDLE_ID } from '../../../lib/constants'
import { exchangeCodeForToken, missingScopes, orderHistoryWindow } from '../../../lib/oauth'
import {
  buildStateClearCookie,
  readCookie,
  STATE_COOKIE_NAME,
  verifyState,
} from '../../../lib/oauth-state'
import { buildReturnUrl, resolveRedirectUri, shouldUseSecureCookie } from '../../../lib/redirect-uri'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['sync_shopify.configure'] },
}

export const openApi = {
  tags: ['ShopifySync'],
  summary: 'Complete the Shopify OAuth authorization flow',
  description:
    'Verifies the signed CSRF state, exchanges the authorization code for an Admin API access token, and stores it on the sync_shopify bundle credentials.',
}

type CredentialsService = {
  getRaw(integrationId: string, scope: IntegrationScope): Promise<Record<string, unknown> | null>
  save(
    integrationId: string,
    credentials: Record<string, unknown>,
    scope: IntegrationScope,
  ): Promise<void>
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId || !auth.sub) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const scope: IntegrationScope = { organizationId: auth.orgId, tenantId: auth.tenantId }

  const url = new URL(req.url)
  const redirectUri = resolveRedirectUri(req)
  const secure = shouldUseSecureCookie(redirectUri)
  // The state cookie is single-use: clear it on every outcome, success or failure, so a leaked
  // cookie cannot be replayed.
  const clearCookie = buildStateClearCookie({ secure })

  const fail = (reason: string, status = 400) =>
    new Response(null, {
      status: 302,
      headers: {
        Location: buildReturnUrl(req, BUNDLE_ID, { status: 'error', reason }),
        'Set-Cookie': clearCookie,
        'Cache-Control': 'no-store',
        'X-Shopify-Auth-Failure': `${reason}:${status}`,
      },
    })

  const container = await createRequestContainer()
  const credentialsService = container.resolve('integrationCredentialsService') as CredentialsService
  const credentials = (await credentialsService.getRaw(BUNDLE_ID, scope)) ?? {}

  const clientId = typeof credentials.clientId === 'string' ? credentials.clientId.trim() : ''
  const clientSecret = typeof credentials.clientSecret === 'string' ? credentials.clientSecret : ''
  if (!clientId || !clientSecret) return fail('not_configured', 409)

  // Verify CSRF state BEFORE touching the code or contacting Shopify.
  const verification = verifyState({
    cookieValue: readCookie(req.headers.get('cookie'), STATE_COOKIE_NAME),
    stateParam: url.searchParams.get('state'),
    shopDomain: url.searchParams.get('shop'),
    secret: clientSecret,
    session: { userId: auth.sub, tenantId: auth.tenantId, organizationId: auth.orgId },
  })
  if (!verification.ok) return fail(verification.reason, 400)

  const code = url.searchParams.get('code')
  if (!code) return fail('missing_code', 400)

  let token: Awaited<ReturnType<typeof exchangeCodeForToken>>
  try {
    token = await exchangeCodeForToken({
      shopDomain: verification.payload.shopDomain,
      clientId,
      clientSecret,
      code,
    })
  } catch {
    // Never surface the exchange error verbatim — it can echo the submitted client secret.
    return fail('exchange_failed', 502)
  }

  const granted = token.grantedScopes
  await credentialsService.save(
    BUNDLE_ID,
    {
      ...credentials,
      shopDomain: verification.payload.shopDomain,
      accessToken: token.accessToken,
      grantedScopes: granted.join(','),
      // Persisted so the UI can warn about a truncated order backfill without re-querying
      // Shopify. read_all_orders is approval-gated, so most installs land on 'sixty_days'.
      orderHistoryWindow: orderHistoryWindow(granted),
      connectedAt: new Date().toISOString(),
    },
    scope,
  )

  // A narrower-than-requested grant is not an error to Shopify — it silently omits scopes. Flag
  // it rather than letting it surface later as a mid-run 403.
  const missing = missingScopes(granted)
  const flashStatus = missing.length > 0 ? 'partial_scopes' : 'connected'

  return new Response(null, {
    status: 302,
    headers: {
      Location:
        missing.length > 0
          ? buildReturnUrl(req, BUNDLE_ID, { status: 'error', reason: `partial_scopes:${missing.join(',')}` })
          : buildReturnUrl(req, BUNDLE_ID, { status: 'connected' }),
      'Set-Cookie': clearCookie,
      'Cache-Control': 'no-store',
      'X-Shopify-Auth-Result': flashStatus,
    },
  })
}

export default GET
