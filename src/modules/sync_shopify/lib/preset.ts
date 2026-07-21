import type { AwilixContainer } from 'awilix'
import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import { BUNDLE_ID, DEFAULT_API_VERSION, ENTITY_TYPE, INTEGRATION_ID } from './constants'
import { normalizeShopDomain } from './shop-domain'

/**
 * Optional environment bootstrap for single-store deployments.
 *
 * Credentials live in the integration credential store, not in env — a Shopify custom-distribution
 * app is scoped to one store or one Plus org, so a multi-store install needs multiple apps and
 * therefore per-integration credentials. This preset exists only so a single-store deployment can
 * be provisioned from config management without clicking through the UI.
 *
 * Two independent bootstraps live here:
 *   1. Credentials  — seed the shared bundle connection (shopDomain / clientId / clientSecret / …).
 *   2. Data-sync    — optionally enable integrations and seed recurring import schedules, so a fresh
 *                     install actually starts syncing without an admin toggling anything.
 *
 * Both are deliberately non-destructive: credentials already present, integrations an operator has
 * already toggled, and schedules that already exist are all left exactly as they are. A redeploy
 * must never clobber an operator's choices.
 */

export const ENV_KEYS = {
  shopDomain: 'OM_INTEGRATION_SHOPIFY_SHOP_DOMAIN',
  clientId: 'OM_INTEGRATION_SHOPIFY_CLIENT_ID',
  clientSecret: 'OM_INTEGRATION_SHOPIFY_CLIENT_SECRET',
  apiVersion: 'OM_INTEGRATION_SHOPIFY_API_VERSION',
  // Data-sync bootstrap (all optional).
  enableEntities: 'OM_INTEGRATION_SHOPIFY_ENABLE_ENTITIES',
  syncCron: 'OM_INTEGRATION_SHOPIFY_SYNC_CRON',
  // Inventory has its own cadence knob: it captures one snapshot per day, so it wants a daily cron,
  // not the hourly delta cron the other four share. Without this set, inventory is enabled but not
  // auto-scheduled — a deliberate guard against accidental hourly full-inventory pulls.
  inventoryCron: 'OM_INTEGRATION_SHOPIFY_SYNC_CRON_INVENTORY',
  syncTimezone: 'OM_INTEGRATION_SHOPIFY_SYNC_TIMEZONE',
} as const

// ── Credentials preset ────────────────────────────────────────────────────────────────────────

export type ShopifyEnvPreset = {
  shopDomain: string
  clientId?: string
  clientSecret?: string
  apiVersion: string
}

/** Read and validate the credentials preset. Returns null when the required shop domain is absent. */
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

export async function applyShopifyCredentialsPreset(input: {
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

// ── Data-sync bootstrap (enable + schedule) ─────────────────────────────────────────────────────

/**
 * The syncs a deployment can bootstrap by name. Each carries an `IntegrationDefinition` in
 * `integration.ts` — that is what maps `integrationId → providerKey` in the registry, so a scheduled
 * run can resolve the right adapter.
 *
 * `inventory` is a snapshot job, not a delta sync: it has no cursor (every run captures the current
 * day) and resolves its catalog variant links from the Products sync's external-id mappings. It gets
 * its own cadence knob (`ENV_KEYS.inventoryCron`) so it is scheduled daily rather than hourly, and it
 * wants Products enabled alongside it — see `lib/adapters/inventory.ts`.
 */
export const SYNC_ENTITY_NAMES = ['products', 'collections', 'customers', 'orders', 'inventory'] as const
export type SyncEntityName = (typeof SYNC_ENTITY_NAMES)[number]

const SYNC_ENTITY_TABLE: Record<SyncEntityName, { integrationId: string; entityType: string }> = {
  products: { integrationId: INTEGRATION_ID.products, entityType: ENTITY_TYPE.product },
  collections: { integrationId: INTEGRATION_ID.collections, entityType: ENTITY_TYPE.collection },
  customers: { integrationId: INTEGRATION_ID.customers, entityType: ENTITY_TYPE.customer },
  orders: { integrationId: INTEGRATION_ID.orders, entityType: ENTITY_TYPE.order },
  inventory: { integrationId: INTEGRATION_ID.inventory, entityType: ENTITY_TYPE.inventoryLevel },
}

/**
 * Parse a `OM_INTEGRATION_SHOPIFY_ENABLE_ENTITIES` value into a validated, de-duplicated list. `all`
 * expands to every supported entity; `none`/`off` (and an empty value) mean explicitly nothing.
 * Unknown tokens are collected (not thrown) so a single typo cannot abort tenant creation — the
 * caller decides how loudly to report them.
 *
 * Note this parses an *explicit* value; the unset-means-`all` default lives in
 * `readShopifyDataSyncBootstrap`, which knows whether the deployment is env-driven.
 */
export function parseEnableEntities(
  raw: string | undefined,
): { entities: SyncEntityName[]; unknown: string[] } {
  if (!raw) return { entities: [], unknown: [] }
  const tokens = raw
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  if (tokens.includes('all')) return { entities: [...SYNC_ENTITY_NAMES], unknown: [] }
  if (tokens.includes('none') || tokens.includes('off')) return { entities: [], unknown: [] }

  const entities: SyncEntityName[] = []
  const unknown: string[] = []
  for (const token of tokens) {
    if ((SYNC_ENTITY_NAMES as readonly string[]).includes(token)) {
      const name = token as SyncEntityName
      if (!entities.includes(name)) entities.push(name)
    } else if (!unknown.includes(token)) {
      unknown.push(token)
    }
  }
  return { entities, unknown }
}

/**
 * A minimal cron shape check (5 classic fields, or 6 with a seconds field). We do NOT validate field
 * ranges — the scheduler does that on registration — but we refuse to persist an obviously malformed
 * value, because `saveSchedule()` writes the schedule row BEFORE registering it with the scheduler,
 * so a rejection there would orphan a row that never fires.
 */
function looksLikeCron(value: string): boolean {
  const fields = value.trim().split(/\s+/)
  return fields.length === 5 || fields.length === 6
}

export type ShopifyDataSyncBootstrap = {
  enableEntities: SyncEntityName[]
  unknownEntities: string[]
  /** Cron for the incremental delta syncs (products / collections / customers / orders). */
  syncCron: string | null
  /** Cron for the daily inventory snapshot — separate cadence, no fallback to `syncCron`. */
  inventoryCron: string | null
  /** Cron values that were present but failed the shape check, surfaced so callers can warn. */
  cronRejected: string[]
  syncTimezone: string
}

export function readShopifyDataSyncBootstrap(
  env: NodeJS.ProcessEnv = process.env,
): ShopifyDataSyncBootstrap {
  // Unset defaults to `all` — but only for an env-driven deployment (one that supplies the shop
  // domain through env). That is the "deployment already knows the credentials and defaults" case,
  // where auto-enabling every sync is the intent. A plain install with no Shopify env stays a no-op,
  // so integrations are never enabled without a connection behind them. To opt out of the default in
  // an env deployment, set the value to `none` (or empty).
  const rawEntities = env[ENV_KEYS.enableEntities]
  const hasEnvConnection = (env[ENV_KEYS.shopDomain] ?? '').trim().length > 0
  const { entities, unknown } =
    rawEntities === undefined
      ? { entities: hasEnvConnection ? [...SYNC_ENTITY_NAMES] : [], unknown: [] as string[] }
      : parseEnableEntities(rawEntities.trim())

  // Validate each cron independently — a malformed value is dropped (not persisted) and reported.
  const cronRejected: string[] = []
  const readCron = (key: string): string | null => {
    const raw = env[key]?.trim() || ''
    if (raw.length === 0) return null
    if (looksLikeCron(raw)) return raw
    cronRejected.push(raw)
    return null
  }

  return {
    enableEntities: entities,
    unknownEntities: unknown,
    syncCron: readCron(ENV_KEYS.syncCron),
    inventoryCron: readCron(ENV_KEYS.inventoryCron),
    cronRejected,
    syncTimezone: env[ENV_KEYS.syncTimezone]?.trim() || 'UTC',
  }
}

type IntegrationStateLike = {
  get(integrationId: string, scope: IntegrationScope): Promise<{ isEnabled: boolean } | null>
  upsert(
    integrationId: string,
    input: { isEnabled?: boolean },
    scope: IntegrationScope,
  ): Promise<unknown>
}

type SyncScheduleLike = {
  getByKey(
    integrationId: string,
    entityType: string,
    direction: 'import' | 'export',
    scope: IntegrationScope,
  ): Promise<unknown | null>
  saveSchedule(
    input: {
      integrationId: string
      entityType: string
      direction: 'import' | 'export'
      scheduleType: 'cron' | 'interval'
      scheduleValue: string
      timezone: string
      fullSync: boolean
      isEnabled: boolean
    },
    scope: IntegrationScope,
  ): Promise<unknown>
}

export type DataSyncBootstrapResult = {
  /** Integrations freshly enabled (had no state row). */
  enabled: SyncEntityName[]
  /** Integrations already carrying a state row, left untouched. */
  enableSkipped: SyncEntityName[]
  /** Integrations a schedule was freshly created for. */
  scheduled: SyncEntityName[]
  /** Integrations that already had an import schedule, left untouched. */
  scheduleExisting: SyncEntityName[]
  /** True when a cron was requested but `@open-mercato/scheduler` is not installed. */
  schedulerUnavailable: boolean
  unknownEntities: string[]
  cronRejected: string[]
}

/**
 * Enable the requested integrations and (when a cron is set and the scheduler is present) seed a
 * recurring import schedule for each. The delta syncs use `syncCron`; inventory uses its own
 * `inventoryCron` (daily cadence). Every step is non-destructive and independent of whether
 * credentials were seeded from env — a deployment may enter credentials in the UI yet still declare
 * the operational defaults here.
 */
export async function applyShopifyDataSyncBootstrap(input: {
  container: AwilixContainer
  scope: IntegrationScope
  env?: NodeJS.ProcessEnv
}): Promise<DataSyncBootstrapResult> {
  const bootstrap = readShopifyDataSyncBootstrap(input.env ?? process.env)
  const result: DataSyncBootstrapResult = {
    enabled: [],
    enableSkipped: [],
    scheduled: [],
    scheduleExisting: [],
    schedulerUnavailable: false,
    unknownEntities: bootstrap.unknownEntities,
    cronRejected: bootstrap.cronRejected,
  }

  // The entity list gates the whole bootstrap: nothing is enabled or scheduled unless the deployment
  // opts in by naming entities. A fresh install with no list behaves exactly as before.
  if (bootstrap.enableEntities.length === 0) return result

  const stateService = input.container.resolve('integrationStateService') as IntegrationStateLike

  // Scheduling is doubly opt-in: it needs a cron AND the optional scheduler module. The data_sync DI
  // factory eagerly destructures `schedulerService` from the cradle, so resolving the schedule
  // service without the scheduler module throws — hence the `hasRegistration` guard before resolving.
  const wantSchedules = bootstrap.syncCron !== null || bootstrap.inventoryCron !== null
  const schedulerAvailable =
    wantSchedules &&
    input.container.hasRegistration('schedulerService') &&
    input.container.hasRegistration('dataSyncScheduleService')
  if (wantSchedules && !schedulerAvailable) result.schedulerUnavailable = true
  const scheduleService = schedulerAvailable
    ? (input.container.resolve('dataSyncScheduleService') as SyncScheduleLike)
    : null

  for (const name of bootstrap.enableEntities) {
    const { integrationId, entityType } = SYNC_ENTITY_TABLE[name]

    // Enable non-destructively: a persisted state row means an operator (or a prior run) already made
    // a choice, so leave it. Only a fresh integration with no row is enabled here.
    const state = await stateService.get(integrationId, input.scope)
    let effectiveEnabled: boolean
    if (state) {
      result.enableSkipped.push(name)
      effectiveEnabled = state.isEnabled
    } else {
      await stateService.upsert(integrationId, { isEnabled: true }, input.scope)
      result.enabled.push(name)
      effectiveEnabled = true
    }

    // Inventory has its own cadence; everything else shares the delta cron. An entity whose cron is
    // unset is enabled but left unscheduled.
    const cron = name === 'inventory' ? bootstrap.inventoryCron : bootstrap.syncCron

    // Only schedule an integration we actually left enabled — the scheduled worker no-ops on a
    // disabled integration, so seeding a schedule for one an operator disabled would be misleading.
    if (!scheduleService || cron === null || !effectiveEnabled) continue

    const existing = await scheduleService.getByKey(integrationId, entityType, 'import', input.scope)
    if (existing) {
      result.scheduleExisting.push(name)
      continue
    }
    await scheduleService.saveSchedule(
      {
        integrationId,
        entityType,
        direction: 'import',
        scheduleType: 'cron',
        scheduleValue: cron,
        timezone: bootstrap.syncTimezone,
        // Incremental by default — a scheduled full sync would re-scan the entire store every tick.
        fullSync: false,
        isEnabled: true,
      },
      input.scope,
    )
    result.scheduled.push(name)
  }

  return result
}

// ── Composed entry point ────────────────────────────────────────────────────────────────────────

export type ShopifyPresetResult = { credentials: 'applied' | 'skipped' } & DataSyncBootstrapResult

/**
 * Apply the full provider-owned env preconfiguration: seed credentials, then enable + schedule the
 * requested syncs. This is the single entry point used by `setup.ts` (tenant bootstrap) and the
 * `configure-from-env` CLI.
 */
export async function applyShopifyEnvPreset(input: {
  container: AwilixContainer
  scope: IntegrationScope
  env?: NodeJS.ProcessEnv
}): Promise<ShopifyPresetResult> {
  const env = input.env ?? process.env
  const credentials = await applyShopifyCredentialsPreset({
    container: input.container,
    scope: input.scope,
    env,
  })
  const bootstrap = await applyShopifyDataSyncBootstrap({
    container: input.container,
    scope: input.scope,
    env,
  })
  return { credentials, ...bootstrap }
}
