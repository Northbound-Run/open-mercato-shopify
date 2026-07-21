import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import {
  BUNDLE_ID,
  DEFAULT_API_VERSION,
  INVENTORY_DAILY_RETENTION_DAYS,
} from './lib/constants'
import { formatProbeResult, probeConnection } from './lib/probe'
import {
  applyShopifyEnvPreset,
  ENV_KEYS,
  readShopifyDataSyncBootstrap,
  type ShopifyDataSyncBootstrap,
  type ShopifyPresetResult,
} from './lib/preset'
import { addDays, snapshotDateFor } from './lib/inventory-history'

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

/** Human-readable summary of what `configure-from-env` did (and deliberately did not) change. */
function reportPresetOutcome(result: ShopifyPresetResult, bootstrap: ShopifyDataSyncBootstrap): void {
  const list = (xs: readonly string[]) => (xs.length ? xs.join(', ') : '—')
  const line = (label: string, value: string) => console.log(`    ${label.padEnd(16)}${value}`)

  console.log('')
  line(
    'Credentials',
    result.credentials === 'applied'
      ? 'seeded from environment'
      : 'unchanged (already present or not set)',
  )
  line('Enabled', list(result.enabled))
  if (result.enableSkipped.length) line('Already set', result.enableSkipped.join(', '))

  if (bootstrap.syncCron !== null || bootstrap.inventoryCron !== null) {
    line('Scheduled', list(result.scheduled))
    if (result.scheduleExisting.length) line('Sched. exists', result.scheduleExisting.join(', '))
    if (bootstrap.syncCron) line('  delta cron', bootstrap.syncCron)
    if (bootstrap.inventoryCron) line('  inventory cron', bootstrap.inventoryCron)
  }

  const warnings: string[] = []
  if (result.unknownEntities.length)
    warnings.push(`ignored unknown ${ENV_KEYS.enableEntities} value(s): ${result.unknownEntities.join(', ')}`)
  for (const cron of result.cronRejected) warnings.push(`ignored malformed sync cron: "${cron}"`)
  if (result.schedulerUnavailable)
    warnings.push('a sync cron is set but the scheduler module is not installed — no schedules created')
  for (const warning of warnings) console.log(`  ! ${warning}`)

  const nothingChanged =
    result.credentials === 'skipped' && !result.enabled.length && !result.scheduled.length
  if (nothingChanged && !warnings.length) {
    console.log(`  - Nothing to do (set ${ENV_KEYS.shopDomain} and/or ${ENV_KEYS.enableEntities}).`)
  }
  console.log('')
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
      const result = await applyShopifyEnvPreset({
        container: container as never,
        scope: { organizationId, tenantId },
      })
      reportPresetOutcome(result, readShopifyDataSyncBootstrap(process.env))
    } catch (error) {
      console.error(`\n  ✗ ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    } finally {
      await (container as unknown as { dispose?: () => Promise<void> }).dispose?.()
    }
  },
}

/**
 * Retention for the inventory snapshot table.
 *
 * Deliberately manual and dry-run by default. Inventory history cannot be re-fetched — Shopify has
 * no way to backfill it — so a deleted row is gone permanently, and this is the only destructive
 * operation in the connector. Nothing prunes on a schedule; an operator asks for it, sees what
 * would go, then confirms.
 */
const pruneInventory: ModuleCli = {
  command: 'prune-inventory',
  async run(argv) {
    const flags = parseArgs(argv)
    const tenantId = str(flags.tenant) || str(flags['tenant-id'])
    const organizationId = str(flags.org) || str(flags['organization-id'])
    if (!tenantId || !organizationId) {
      console.error('\n  ✗ --tenant and --org are required.\n')
      process.exitCode = 1
      return
    }

    const olderThanDays = Number(str(flags['older-than-days']) || INVENTORY_DAILY_RETENTION_DAYS)
    if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
      console.error('\n  ✗ --older-than-days must be a positive number.\n')
      process.exitCode = 1
      return
    }
    const confirmed = flags.confirm === true || str(flags.confirm) === 'true'

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    try {
      const em = container.resolve('em') as {
        count(entity: unknown, where: Record<string, unknown>): Promise<number>
        nativeDelete(entity: unknown, where: Record<string, unknown>): Promise<number>
        findOne(
          entity: unknown,
          where: Record<string, unknown>,
          options?: Record<string, unknown>,
        ): Promise<{ snapshotDate?: string } | null>
      }
      const { ShopifyInventorySnapshot } = await import('./data/entities')

      // The cutoff is inclusive of today, so exactly `olderThanDays` calendar days survive.
      const cutoff = addDays(snapshotDateFor(new Date(), 'UTC'), -(olderThanDays - 1))
      const scoped = { organizationId, tenantId }
      const doomed = { ...scoped, snapshotDate: { $lt: cutoff } }

      const [total, toDelete, oldest] = await Promise.all([
        em.count(ShopifyInventorySnapshot, scoped),
        em.count(ShopifyInventorySnapshot, doomed),
        em.findOne(ShopifyInventorySnapshot, scoped, { orderBy: { snapshotDate: 'ASC' } }),
      ])

      console.log(`\n  Inventory snapshot retention (tenant ${tenantId})\n`)
      console.log(`    rows total        ${total}`)
      console.log(`    oldest snapshot   ${oldest?.snapshotDate ?? '(none)'}`)
      console.log(`    keeping on/after  ${cutoff}  (${olderThanDays} days)`)
      console.log(`    would delete      ${toDelete}`)

      if (toDelete === 0) {
        console.log('\n  Nothing to prune.\n')
        return
      }
      if (!confirmed) {
        // Never delete without an explicit second step — this data is unrecoverable.
        console.log('\n  Dry run. Re-run with --confirm to delete permanently.')
        console.log('  This history cannot be re-fetched from Shopify.\n')
        return
      }

      const deleted = await em.nativeDelete(ShopifyInventorySnapshot, doomed)
      console.log(`\n  ✓ Deleted ${deleted} snapshot row(s) older than ${cutoff}.\n`)
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
      Apply the provider-owned env preconfiguration: seed stored credentials, and — when the
      deployment opts in — enable integrations and seed recurring import schedules. Every step is
      non-destructive: existing credentials, operator-toggled integrations and existing schedules
      are all left untouched.

      ${ENV_KEYS.enableEntities}=products,collections,customers,orders,inventory (or 'all' / 'none')
          Enables the named syncs. Defaults to 'all' when a shop domain is configured via env; set
          'none' to opt out.
      ${ENV_KEYS.syncCron}='0 * * * *'
          Seeds an incremental import schedule for each enabled delta sync — products, collections,
          customers, orders (needs @open-mercato/scheduler).
      ${ENV_KEYS.inventoryCron}='0 2 * * *'
          Seeds the daily inventory snapshot schedule. Separate knob because inventory captures one
          snapshot per day; without it, inventory is enabled but not auto-scheduled.
      ${ENV_KEYS.syncTimezone}=UTC
          Timezone for the seeded schedules. Defaults to UTC.

  yarn mercato sync_shopify prune-inventory --tenant <id> --org <id> [flags]
      Delete inventory snapshot rows older than the retention window. Nothing prunes
      automatically — inventory history cannot be re-fetched from Shopify, so deletion
      is always an explicit operator action.

      --older-than-days <n>    retention window, default ${INVENTORY_DAILY_RETENTION_DAYS}
      --confirm                actually delete; without it this is a dry run

  yarn mercato sync_shopify help
`)
  },
}

export const cli: ModuleCli[] = [testConnection, configureFromEnv, pruneInventory, help]

export default cli
