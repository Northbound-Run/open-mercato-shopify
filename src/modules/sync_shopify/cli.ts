import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import { BUNDLE_ID, DEFAULT_API_VERSION } from './lib/constants'
import { formatProbeResult, probeConnection } from './lib/probe'
import { applyShopifyEnvPreset, ENV_KEYS } from './lib/preset'

/**
 * Module CLI, discovered by `yarn generate` and dispatched as:
 *   yarn mercato sync_shopify <command> [flags]
 *
 * A provider CLI that can re-run env bootstrap is required by the framework's own module
 * conventions, not optional.
 */

export type ModuleCli = {
  command: string
  run: (argv: string[]) => Promise<void> | void
}

/** Minimal flag parser matching the first-party convention: supports `--k=v` and `--k v`. */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg?.startsWith('--')) continue
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq !== -1) {
      out[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[body] = next
      i += 1
    } else {
      out[body] = true
    }
  }
  return out
}

const str = (value: string | boolean | undefined): string =>
  typeof value === 'string' ? value.trim() : ''

type ResolvedCredentials = {
  shopDomain: string
  clientId: string
  clientSecret: string
  apiVersion: string
  source: string
}

/**
 * Resolve credentials from flags, then env, then the stored integration credentials.
 *
 * The flag and env paths need no database, which is the point: an operator can validate a client
 * ID and secret before the module is installed anywhere.
 */
async function resolveCredentials(
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedCredentials> {
  const fromFlags = {
    shopDomain: str(flags.shop) || str(flags['shop-domain']),
    clientId: str(flags['client-id']),
    clientSecret: str(flags['client-secret']),
    apiVersion: str(flags['api-version']),
  }
  if (fromFlags.shopDomain && fromFlags.clientId && fromFlags.clientSecret) {
    return { ...fromFlags, apiVersion: fromFlags.apiVersion || DEFAULT_API_VERSION, source: 'flags' }
  }

  const fromEnv = {
    shopDomain: fromFlags.shopDomain || (env[ENV_KEYS.shopDomain] ?? '').trim(),
    clientId: fromFlags.clientId || (env[ENV_KEYS.clientId] ?? '').trim(),
    clientSecret: fromFlags.clientSecret || (env[ENV_KEYS.clientSecret] ?? '').trim(),
    apiVersion:
      fromFlags.apiVersion || (env[ENV_KEYS.apiVersion] ?? '').trim() || DEFAULT_API_VERSION,
  }
  if (fromEnv.shopDomain && fromEnv.clientId && fromEnv.clientSecret) {
    return { ...fromEnv, source: 'environment' }
  }

  // Fall back to the stored credentials. This needs DI and an explicit tenant/org, since
  // credentials are tenant-scoped and there is no ambient session in a CLI.
  const tenantId = str(flags.tenant) || str(flags['tenant-id'])
  const organizationId = str(flags.org) || str(flags['organization-id'])
  if (!tenantId || !organizationId) {
    throw new Error(
      'Missing credentials. Pass --shop, --client-id and --client-secret; or set the ' +
        `${ENV_KEYS.shopDomain} / ${ENV_KEYS.clientId} / ${ENV_KEYS.clientSecret} environment ` +
        'variables; or pass --tenant and --org to read stored integration credentials.',
    )
  }

  const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
  const container = await createRequestContainer()
  try {
    const scope: IntegrationScope = { organizationId, tenantId }
    const credentialsService = container.resolve('integrationCredentialsService') as {
      getRaw(id: string, scope: IntegrationScope): Promise<Record<string, unknown> | null>
    }
    const stored = (await credentialsService.getRaw(BUNDLE_ID, scope)) ?? {}
    const pick = (key: string) => (typeof stored[key] === 'string' ? (stored[key] as string).trim() : '')
    return {
      shopDomain: fromEnv.shopDomain || pick('shopDomain'),
      clientId: fromEnv.clientId || pick('clientId'),
      clientSecret: fromEnv.clientSecret || pick('clientSecret'),
      apiVersion: fromEnv.apiVersion || pick('apiVersion') || DEFAULT_API_VERSION,
      source: `stored credentials (tenant ${tenantId})`,
    }
  } finally {
    await (container as unknown as { dispose?: () => Promise<void> }).dispose?.()
  }
}

const testConnection: ModuleCli = {
  command: 'test-connection',
  async run(argv) {
    const flags = parseArgs(argv)
    let credentials: ResolvedCredentials
    try {
      credentials = await resolveCredentials(flags, process.env)
    } catch (error) {
      console.error(`\n  ✗ ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
      return
    }

    console.log(`\nProbing Shopify connection (credentials from ${credentials.source})\n`)
    const result = await probeConnection(credentials)
    console.log(formatProbeResult(result))
    console.log('')

    // Warnings (60-day orders, missing optional scopes) are not failures — a limited but working
    // connection should still exit 0 so this is usable in a health script.
    if (!result.ok) process.exitCode = 1
  },
}

const configureFromEnv: ModuleCli = {
  command: 'configure-from-env',
  async run(argv) {
    const flags = parseArgs(argv)
    const tenantId = str(flags.tenant) || str(flags['tenant-id'])
    const organizationId = str(flags.org) || str(flags['organization-id'])
    if (!tenantId || !organizationId) {
      console.error('\n  ✗ --tenant and --org are required.\n')
      process.exitCode = 1
      return
    }

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    try {
      const outcome = await applyShopifyEnvPreset({
        container: container as never,
        scope: { organizationId, tenantId },
      })
      console.log(
        outcome === 'applied'
          ? '\n  ✓ Credentials seeded from environment.\n'
          : `\n  - Nothing to do (no ${ENV_KEYS.shopDomain} set, or credentials already present).\n`,
      )
    } catch (error) {
      console.error(`\n  ✗ ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    } finally {
      await (container as unknown as { dispose?: () => Promise<void> }).dispose?.()
    }
  },
}

const help: ModuleCli = {
  command: 'help',
  run() {
    console.log(`
sync_shopify — Shopify sync for Open Mercato

  yarn mercato sync_shopify test-connection [flags]
      Verify a Shopify connection end to end: validate the shop domain, mint an access
      token via the client credentials grant, call the Admin API, and report granted
      scopes and the available order history window.

      --shop <domain>          e.g. mystore.myshopify.com
      --client-id <id>         Dev Dashboard → app → Settings
      --client-secret <secret> the value beginning shpss_
      --api-version <version>  defaults to ${DEFAULT_API_VERSION}
      --tenant <id> --org <id> read stored credentials instead of passing them

      Falls back to ${ENV_KEYS.shopDomain} / ${ENV_KEYS.clientId} /
      ${ENV_KEYS.clientSecret} when flags are omitted.

  yarn mercato sync_shopify configure-from-env --tenant <id> --org <id>
      Seed stored credentials from environment variables. Never overwrites existing values.

  yarn mercato sync_shopify help
`)
  },
}

export const cli: ModuleCli[] = [testConnection, configureFromEnv, help]

export default cli
