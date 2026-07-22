import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import {
  BUNDLE_ID,
  COMMAND,
  DEFAULT_API_VERSION,
  INTEGRATION_ID,
  INVENTORY_DAILY_RETENTION_DAYS,
  MAPPING_ENTITY_TYPE,
} from './lib/constants'
import { createShopifyClientFromCredentials } from './lib/runtime'
import { buildCommandContext } from './lib/writer'
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

/**
 * Re-fetch each order's customer from Shopify by the order GID.
 *
 * The customer GID is not stored on the local order, so a null link cannot be repaired from the
 * database alone — the order has to be looked up again. `nodes(ids:)` fetches a specific set by id,
 * which is exactly the owned orders we already know are missing a customer.
 */
const RELINK_QUERY = `#graphql
  query SyncShopifyRelinkOrders($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order { id customer { id } }
    }
  }
`

type RelinkResponse = {
  nodes?: ({ id?: string | null; customer?: { id?: string | null } | null } | null)[] | null
}

/**
 * Backfill the customer link on orders imported before their customer existed locally.
 *
 * The orders adapter now self-heals on any re-import (GID mapping, then email), but a delta only
 * re-fetches orders that CHANGED upstream — an old, unchanged order never comes back through it. So
 * existing null links need either a full re-backfill or this targeted repair, which touches only the
 * orders that are actually missing a customer and never resets a cursor or re-runs reconciliation.
 *
 * Dry-run by default (mirroring `prune-inventory`): it reports what it would link; `--confirm` writes.
 */
const relinkOrders: ModuleCli = {
  command: 'relink-orders',
  async run(argv) {
    const flags = parseArgs(argv)
    const tenantId = str(flags.tenant) || str(flags['tenant-id'])
    const organizationId = str(flags.org) || str(flags['organization-id'])
    if (!tenantId || !organizationId) {
      console.error('\n  ✗ --tenant and --org are required.\n')
      process.exitCode = 1
      return
    }

    let credentials: ResolvedCredentials
    try {
      credentials = await resolveCredentials(flags, process.env)
    } catch (error) {
      console.error(`\n  ✗ ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
      return
    }

    const confirmed = flags.confirm === true || str(flags.confirm) === 'true'
    const batchSize = Math.min(Math.max(Number(str(flags.batch) || 100) || 100, 1), 250)

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    try {
      const scope = { organizationId, tenantId }
      const em = container.resolve('em') as {
        find(entity: unknown, where: Record<string, unknown>): Promise<Record<string, unknown>[]>
      }
      const commandBus = container.resolve('commandBus') as {
        execute(commandId: string, opts: { input: Record<string, unknown>; ctx: unknown }): Promise<{ result: unknown }>
      }
      const mappingService = container.resolve('externalIdMappingService') as {
        lookupLocalId(i: string, e: string, x: string, s: typeof scope): Promise<string | null>
      }
      const client = createShopifyClientFromCredentials(credentials as unknown as Record<string, unknown>)
      const ctx = buildCommandContext(container as never, scope)

      const { SyncExternalIdMapping } = await import(
        '@open-mercato/core/modules/integrations/data/entities'
      )
      const SalesOrder = container.resolve('SalesOrder')

      // 1. Every order this integration owns — local id ↔ Shopify GID.
      const mappings = (await em.find(SyncExternalIdMapping, {
        integrationId: INTEGRATION_ID.orders,
        internalEntityType: MAPPING_ENTITY_TYPE.salesOrder,
        organizationId,
        tenantId,
      })) as { internalEntityId: string; externalId: string }[]

      if (mappings.length === 0) {
        console.log('\n  No Shopify-owned orders found for this tenant.\n')
        return
      }

      // 2. Of those, the ones whose customer link is still null.
      const gidByLocalId = new Map(mappings.map((m) => [m.internalEntityId, m.externalId]))
      const localIdByGid = new Map(mappings.map((m) => [m.externalId, m.internalEntityId]))
      const nullCustomer = (await em.find(SalesOrder as unknown as object, {
        id: { $in: [...gidByLocalId.keys()] },
        customerEntityId: null,
        organizationId,
        tenantId,
        deletedAt: null,
      })) as { id: string }[]

      console.log(`\n  Shopify order → customer relink (tenant ${tenantId})\n`)
      console.log(`    owned orders        ${mappings.length}`)
      console.log(`    missing customer    ${nullCustomer.length}`)
      if (nullCustomer.length === 0) {
        console.log('\n  Nothing to relink.\n')
        return
      }

      // 3. Re-fetch each order's customer from Shopify and resolve it against the customers sync's
      //    external-id mappings. A guest order has no customer; a customer not yet synced has no
      //    mapping — both are reported and skipped rather than guessed at.
      const orderGids = nullCustomer
        .map((o) => gidByLocalId.get(o.id))
        .filter((g): g is string => typeof g === 'string')

      let noShopifyCustomer = 0
      let customerNotSynced = 0
      const plan: { localId: string; customerEntityId: string }[] = []

      for (let i = 0; i < orderGids.length; i += batchSize) {
        const ids = orderGids.slice(i, i + batchSize)
        const data = await client.request<RelinkResponse>(RELINK_QUERY, {
          variables: { ids },
          estimatedCost: ids.length * 2,
        })
        for (const node of data?.nodes ?? []) {
          const orderGid = node?.id
          if (typeof orderGid !== 'string') continue
          const localId = localIdByGid.get(orderGid)
          if (!localId) continue
          const customerGid = node?.customer?.id
          if (typeof customerGid !== 'string' || customerGid === '') {
            noShopifyCustomer += 1
            continue
          }
          const customerEntityId = await mappingService.lookupLocalId(
            INTEGRATION_ID.customers,
            MAPPING_ENTITY_TYPE.customerEntity,
            customerGid,
            scope,
          )
          if (!customerEntityId) {
            customerNotSynced += 1
            continue
          }
          plan.push({ localId, customerEntityId })
        }
      }

      console.log(`    now linkable        ${plan.length}`)
      console.log(`    no Shopify customer ${noShopifyCustomer}`)
      console.log(`    customer not synced ${customerNotSynced}`)

      if (plan.length === 0) {
        console.log('\n  Nothing to update. Run the Customers sync first so customer mappings exist.\n')
        return
      }
      if (!confirmed) {
        console.log('\n  Dry run. Re-run with --confirm to write the customer links.\n')
        return
      }

      let updated = 0
      for (const { localId, customerEntityId } of plan) {
        try {
          await commandBus.execute(COMMAND.orderUpdate, {
            input: { id: localId, organizationId, tenantId, customerEntityId },
            ctx,
          })
          updated += 1
        } catch (error) {
          console.log(`    ! order ${localId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      console.log(`\n  ✓ Linked ${updated} order(s) to their customers.\n`)
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

  yarn mercato sync_shopify relink-orders --tenant <id> --org <id> [flags]
      Backfill the customer link on orders that were imported before their customer existed
      locally (e.g. the orders backfill finished before the customers backfill). Re-fetches each
      customer-less order's customer from Shopify and links it to the already-synced customer.
      Touches only orders missing a customer; never resets a cursor. Run the Customers sync first.

      --confirm                actually write the links; without it this is a dry run
      --batch <n>              orders re-fetched per Shopify call, default 100 (max 250)

  yarn mercato sync_shopify help
`)
  },
}

export const cli: ModuleCli[] = [testConnection, configureFromEnv, pruneInventory, relinkOrders, help]

export default cli
