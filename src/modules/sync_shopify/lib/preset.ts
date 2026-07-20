import type { AwilixContainer } from 'awilix'
import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import { BUNDLE_ID, DEFAULT_API_VERSION } from './constants'
import { normalizeShopDomain } from './shop-domain'

/**
 * Optional environment bootstrap for single-store deployments.
 *
 * Credentials live in the integration credential store, not in env — a Shopify custom-distribution
 * app is scoped to one store or one Plus org, so a multi-store install needs multiple apps and
 * therefore per-integration credentials. This preset exists only so a single-store deployment can
 * be provisioned from config management without clicking through the UI.
 *
 * Deliberately non-destructive: it never overwrites credentials that are already present.
 */

export const ENV_KEYS = {
  shopDomain: 'OM_INTEGRATION_SHOPIFY_SHOP_DOMAIN',
  clientId: 'OM_INTEGRATION_SHOPIFY_CLIENT_ID',
  clientSecret: 'OM_INTEGRATION_SHOPIFY_CLIENT_SECRET',
  apiVersion: 'OM_INTEGRATION_SHOPIFY_API_VERSION',
} as const

export type ShopifyEnvPreset = {
  shopDomain: string
  clientId?: string
  clientSecret?: string
  apiVersion: string
}

/** Read and validate the preset. Returns null when the required shop domain is absent. */
export function readShopifyEnvPreset(env: NodeJS.ProcessEnv = process.env): ShopifyEnvPreset | null {
  const rawShopDomain = env[ENV_KEYS.shopDomain]?.trim()
  if (!rawShopDomain) return null

  // Throws on a non-myshopify host rather than persisting something the OAuth flow will reject.
  const shopDomain = normalizeShopDomain(rawShopDomain)

  return {
    shopDomain,
    clientId: env[ENV_KEYS.clientId]?.trim() || undefined,
    clientSecret: env[ENV_KEYS.clientSecret]?.trim() || undefined,
    apiVersion: env[ENV_KEYS.apiVersion]?.trim() || DEFAULT_API_VERSION,
  }
}

/**
 * Merge env-provided values into the bundle credentials, without clobbering anything already
 * configured. Existing values always win — an operator's UI edit should survive a redeploy.
 */
export function mergePreset(
  existing: Record<string, unknown>,
  preset: ShopifyEnvPreset,
): { merged: Record<string, unknown>; changed: boolean } {
  const merged = { ...existing }
  let changed = false

  const apply = (key: string, value: string | undefined) => {
    if (!value) return
    const current = merged[key]
    if (typeof current === 'string' && current.trim()) return
    merged[key] = value
    changed = true
  }

  apply('shopDomain', preset.shopDomain)
  apply('clientId', preset.clientId)
  apply('clientSecret', preset.clientSecret)
  apply('apiVersion', preset.apiVersion)

  return { merged, changed }
}

type CredentialsService = {
  getRaw(integrationId: string, scope: IntegrationScope): Promise<Record<string, unknown> | null>
  save(
    integrationId: string,
    credentials: Record<string, unknown>,
    scope: IntegrationScope,
  ): Promise<void>
}

export async function applyShopifyEnvPreset(input: {
  container: AwilixContainer
  scope: IntegrationScope
  env?: NodeJS.ProcessEnv
}): Promise<'applied' | 'skipped'> {
  const preset = readShopifyEnvPreset(input.env ?? process.env)
  if (!preset) return 'skipped'

  const credentialsService = input.container.resolve(
    'integrationCredentialsService',
  ) as CredentialsService

  const existing = (await credentialsService.getRaw(BUNDLE_ID, input.scope)) ?? {}
  const { merged, changed } = mergePreset(existing, preset)
  if (!changed) return 'skipped'

  await credentialsService.save(BUNDLE_ID, merged, input.scope)
  return 'applied'
}
