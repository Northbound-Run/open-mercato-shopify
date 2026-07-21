import type { AwilixContainer } from 'awilix'
import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import {
  ENV_KEYS,
  SYNC_ENTITY_NAMES,
  applyShopifyDataSyncBootstrap,
  applyShopifyEnvPreset,
  mergePreset,
  parseEnableEntities,
  readShopifyDataSyncBootstrap,
  readShopifyEnvPreset,
} from '../lib/preset'
import { ENTITY_TYPE, INTEGRATION_ID } from '../lib/constants'

const SCOPE: IntegrationScope = { organizationId: 'org-1', tenantId: 'tenant-1' }

// ── Fakes ────────────────────────────────────────────────────────────────────────────────────

type StateRow = { isEnabled: boolean }

function makeStateService(initial: Record<string, StateRow> = {}) {
  const rows: Record<string, StateRow> = { ...initial }
  const upserts: Array<{ integrationId: string; input: { isEnabled?: boolean } }> = []
  return {
    rows,
    upserts,
    async get(integrationId: string): Promise<StateRow | null> {
      return rows[integrationId] ?? null
    },
    async upsert(integrationId: string, input: { isEnabled?: boolean }) {
      upserts.push({ integrationId, input })
      rows[integrationId] = { isEnabled: input.isEnabled ?? false }
      return rows[integrationId]
    },
  }
}

type SavedSchedule = {
  integrationId: string
  entityType: string
  direction: 'import' | 'export'
  scheduleType: 'cron' | 'interval'
  scheduleValue: string
  timezone: string
  fullSync: boolean
  isEnabled: boolean
}

function makeScheduleService(existingKeys: string[] = []) {
  const existing = new Set(existingKeys)
  const saves: SavedSchedule[] = []
  const key = (id: string, entityType: string, direction: string) => `${id}:${entityType}:${direction}`
  return {
    saves,
    async getByKey(integrationId: string, entityType: string, direction: 'import' | 'export') {
      return existing.has(key(integrationId, entityType, direction)) ? { id: 'existing' } : null
    },
    async saveSchedule(input: SavedSchedule) {
      saves.push(input)
      existing.add(key(input.integrationId, input.entityType, input.direction))
      return { id: 'created' }
    },
  }
}

function makeCredentialsService(initial: Record<string, unknown> | null = null) {
  let stored = initial
  const saves: Array<Record<string, unknown>> = []
  return {
    saves,
    get current() {
      return stored
    },
    async getRaw() {
      return stored
    },
    async save(_id: string, creds: Record<string, unknown>) {
      saves.push(creds)
      stored = creds
    },
  }
}

function makeContainer(registrations: Record<string, unknown>) {
  const resolveCalls: string[] = []
  const container = {
    resolve(name: string) {
      resolveCalls.push(name)
      if (!(name in registrations)) throw new Error(`not registered: ${name}`)
      return registrations[name]
    },
    hasRegistration(name: string) {
      return name in registrations
    },
  }
  return { container: container as unknown as AwilixContainer, resolveCalls }
}

// ── Pure parsers ───────────────────────────────────────────────────────────────────────────────

describe('parseEnableEntities', () => {
  it('returns empty for undefined / blank', () => {
    expect(parseEnableEntities(undefined)).toEqual({ entities: [], unknown: [] })
    expect(parseEnableEntities('   ')).toEqual({ entities: [], unknown: [] })
  })

  it('expands `all` to every supported entity and ignores anything alongside it', () => {
    expect(parseEnableEntities('all').entities).toEqual([...SYNC_ENTITY_NAMES])
    expect(parseEnableEntities('all,foo').unknown).toEqual([])
  })

  it('is case-insensitive, trims, and de-duplicates', () => {
    expect(parseEnableEntities('PRODUCTS, Orders , products').entities).toEqual(['products', 'orders'])
  })

  it('collects unknown tokens instead of throwing', () => {
    const { entities, unknown } = parseEnableEntities('products,foo,bar,foo')
    expect(entities).toEqual(['products'])
    expect(unknown).toEqual(['foo', 'bar'])
  })

  it('accepts inventory as a first-class integration', () => {
    const { entities, unknown } = parseEnableEntities('inventory')
    expect(entities).toEqual(['inventory'])
    expect(unknown).toEqual([])
  })

  it('treats `none` / `off` as an explicit empty selection', () => {
    expect(parseEnableEntities('none')).toEqual({ entities: [], unknown: [] })
    expect(parseEnableEntities('off')).toEqual({ entities: [], unknown: [] })
  })
})

describe('readShopifyEnvPreset', () => {
  it('returns null without a shop domain', () => {
    expect(readShopifyEnvPreset({})).toBeNull()
  })

  it('normalizes the shop domain and defaults the api version', () => {
    const preset = readShopifyEnvPreset({
      [ENV_KEYS.shopDomain]: 'https://MyStore.myshopify.com/admin',
    })
    expect(preset?.shopDomain).toBe('mystore.myshopify.com')
    expect(preset?.apiVersion).toBe('2026-07')
    expect(preset?.clientId).toBeUndefined()
  })
})

describe('readShopifyDataSyncBootstrap', () => {
  it('defaults to a no-op with a UTC timezone when nothing is configured', () => {
    expect(readShopifyDataSyncBootstrap({})).toEqual({
      enableEntities: [],
      unknownEntities: [],
      syncCron: null,
      inventoryCron: null,
      cronRejected: [],
      syncTimezone: 'UTC',
    })
  })

  it('defaults to all four entities when a shop domain is configured via env', () => {
    const bootstrap = readShopifyDataSyncBootstrap({ [ENV_KEYS.shopDomain]: 'mystore.myshopify.com' })
    expect(bootstrap.enableEntities).toEqual([...SYNC_ENTITY_NAMES])
    expect(bootstrap.unknownEntities).toEqual([])
  })

  it('honors an explicit `none` / empty opt-out even with a shop domain', () => {
    const withDomain = (value: string) =>
      readShopifyDataSyncBootstrap({
        [ENV_KEYS.shopDomain]: 'mystore.myshopify.com',
        [ENV_KEYS.enableEntities]: value,
      }).enableEntities
    expect(withDomain('none')).toEqual([])
    expect(withDomain('')).toEqual([])
  })

  it('honors an explicit subset even without a shop domain', () => {
    expect(readShopifyDataSyncBootstrap({ [ENV_KEYS.enableEntities]: 'products' }).enableEntities).toEqual([
      'products',
    ])
  })

  it('accepts 5- and 6-field cron expressions', () => {
    expect(readShopifyDataSyncBootstrap({ [ENV_KEYS.syncCron]: '0 * * * *' }).syncCron).toBe('0 * * * *')
    expect(readShopifyDataSyncBootstrap({ [ENV_KEYS.syncCron]: '*/30 * * * * *' }).syncCron).toBe(
      '*/30 * * * * *',
    )
  })

  it('rejects a malformed cron and surfaces it', () => {
    const bootstrap = readShopifyDataSyncBootstrap({ [ENV_KEYS.syncCron]: 'hourly' })
    expect(bootstrap.syncCron).toBeNull()
    expect(bootstrap.cronRejected).toEqual(['hourly'])
  })

  it('reads the inventory cron independently of the delta cron', () => {
    const bootstrap = readShopifyDataSyncBootstrap({
      [ENV_KEYS.syncCron]: '0 * * * *',
      [ENV_KEYS.inventoryCron]: '0 2 * * *',
    })
    expect(bootstrap.syncCron).toBe('0 * * * *')
    expect(bootstrap.inventoryCron).toBe('0 2 * * *')
  })

  it('collects every malformed cron across both knobs', () => {
    const bootstrap = readShopifyDataSyncBootstrap({
      [ENV_KEYS.syncCron]: 'often',
      [ENV_KEYS.inventoryCron]: 'daily',
    })
    expect(bootstrap.cronRejected).toEqual(['often', 'daily'])
  })

  it('reads the timezone override', () => {
    expect(readShopifyDataSyncBootstrap({ [ENV_KEYS.syncTimezone]: 'Europe/Warsaw' }).syncTimezone).toBe(
      'Europe/Warsaw',
    )
  })
})

describe('mergePreset', () => {
  it('fills only missing values — existing always wins', () => {
    const { merged, changed } = mergePreset(
      { shopDomain: 'kept.myshopify.com' },
      { shopDomain: 'new.myshopify.com', clientId: 'cid', apiVersion: '2026-07' },
    )
    expect(merged.shopDomain).toBe('kept.myshopify.com')
    expect(merged.clientId).toBe('cid')
    expect(changed).toBe(true)
  })

  it('reports no change when everything is already present', () => {
    const { changed } = mergePreset(
      { shopDomain: 'a.myshopify.com', clientId: 'x', clientSecret: 'y', apiVersion: '2026-07' },
      { shopDomain: 'b.myshopify.com', clientId: 'z', clientSecret: 'w', apiVersion: '2026-04' },
    )
    expect(changed).toBe(false)
  })
})

// ── Data-sync bootstrap ──────────────────────────────────────────────────────────────────────

describe('applyShopifyDataSyncBootstrap', () => {
  it('is a pure no-op when no entities are requested', async () => {
    const state = makeStateService()
    const { container, resolveCalls } = makeContainer({ integrationStateService: state })
    const result = await applyShopifyDataSyncBootstrap({ container, scope: SCOPE, env: {} })

    expect(result.enabled).toEqual([])
    expect(result.schedulerUnavailable).toBe(false)
    // Nothing resolved: we never even touch the state service without an entity list.
    expect(resolveCalls).toEqual([])
    expect(state.upserts).toHaveLength(0)
  })

  it('enables every requested entity that has no state row', async () => {
    const state = makeStateService()
    const { container } = makeContainer({ integrationStateService: state })
    const result = await applyShopifyDataSyncBootstrap({
      container,
      scope: SCOPE,
      env: { [ENV_KEYS.enableEntities]: 'all' },
    })

    expect(result.enabled).toEqual([...SYNC_ENTITY_NAMES])
    expect(result.enableSkipped).toEqual([])
    expect(state.upserts).toHaveLength(SYNC_ENTITY_NAMES.length)
    expect(state.upserts.every((u) => u.input.isEnabled === true)).toBe(true)
  })

  it('leaves an already-configured integration untouched (non-destructive)', async () => {
    const state = makeStateService({ [INTEGRATION_ID.products]: { isEnabled: true } })
    const { container } = makeContainer({ integrationStateService: state })
    const result = await applyShopifyDataSyncBootstrap({
      container,
      scope: SCOPE,
      env: { [ENV_KEYS.enableEntities]: 'products,orders' },
    })

    expect(result.enabled).toEqual(['orders'])
    expect(result.enableSkipped).toEqual(['products'])
    expect(state.upserts.map((u) => u.integrationId)).toEqual([INTEGRATION_ID.orders])
  })

  it('seeds an incremental import schedule when a cron and the scheduler are present', async () => {
    const state = makeStateService()
    const schedule = makeScheduleService()
    const { container } = makeContainer({
      integrationStateService: state,
      schedulerService: {},
      dataSyncScheduleService: schedule,
    })
    const result = await applyShopifyDataSyncBootstrap({
      container,
      scope: SCOPE,
      env: {
        [ENV_KEYS.enableEntities]: 'products',
        [ENV_KEYS.syncCron]: '0 * * * *',
        [ENV_KEYS.syncTimezone]: 'Europe/Warsaw',
      },
    })

    expect(result.scheduled).toEqual(['products'])
    expect(schedule.saves).toEqual([
      {
        integrationId: INTEGRATION_ID.products,
        entityType: ENTITY_TYPE.product,
        direction: 'import',
        scheduleType: 'cron',
        scheduleValue: '0 * * * *',
        timezone: 'Europe/Warsaw',
        fullSync: false,
        isEnabled: true,
      },
    ])
  })

  it('skips scheduling (gracefully) when the scheduler module is absent', async () => {
    const state = makeStateService()
    const { container, resolveCalls } = makeContainer({ integrationStateService: state })
    const result = await applyShopifyDataSyncBootstrap({
      container,
      scope: SCOPE,
      env: { [ENV_KEYS.enableEntities]: 'products', [ENV_KEYS.syncCron]: '0 * * * *' },
    })

    expect(result.enabled).toEqual(['products'])
    expect(result.scheduled).toEqual([])
    expect(result.schedulerUnavailable).toBe(true)
    // Must never resolve the schedule service without the scheduler — that resolution throws.
    expect(resolveCalls).not.toContain('dataSyncScheduleService')
  })

  it('never overwrites an existing schedule', async () => {
    const state = makeStateService()
    const schedule = makeScheduleService([
      `${INTEGRATION_ID.products}:${ENTITY_TYPE.product}:import`,
    ])
    const { container } = makeContainer({
      integrationStateService: state,
      schedulerService: {},
      dataSyncScheduleService: schedule,
    })
    const result = await applyShopifyDataSyncBootstrap({
      container,
      scope: SCOPE,
      env: { [ENV_KEYS.enableEntities]: 'products', [ENV_KEYS.syncCron]: '0 * * * *' },
    })

    expect(result.scheduleExisting).toEqual(['products'])
    expect(result.scheduled).toEqual([])
    expect(schedule.saves).toHaveLength(0)
  })

  it('does not schedule an integration an operator has disabled', async () => {
    const state = makeStateService({ [INTEGRATION_ID.products]: { isEnabled: false } })
    const schedule = makeScheduleService()
    const { container } = makeContainer({
      integrationStateService: state,
      schedulerService: {},
      dataSyncScheduleService: schedule,
    })
    const result = await applyShopifyDataSyncBootstrap({
      container,
      scope: SCOPE,
      env: { [ENV_KEYS.enableEntities]: 'products', [ENV_KEYS.syncCron]: '0 * * * *' },
    })

    expect(result.enableSkipped).toEqual(['products'])
    expect(result.scheduled).toEqual([])
    expect(schedule.saves).toHaveLength(0)
  })

  it('surfaces unknown entities and a rejected cron without scheduling', async () => {
    const state = makeStateService()
    const { container, resolveCalls } = makeContainer({
      integrationStateService: state,
      schedulerService: {},
      dataSyncScheduleService: makeScheduleService(),
    })
    const result = await applyShopifyDataSyncBootstrap({
      container,
      scope: SCOPE,
      env: { [ENV_KEYS.enableEntities]: 'products,bogus', [ENV_KEYS.syncCron]: 'nope' },
    })

    expect(result.enabled).toEqual(['products'])
    expect(result.unknownEntities).toEqual(['bogus'])
    expect(result.cronRejected).toEqual(['nope'])
    expect(result.scheduled).toEqual([])
    // A rejected cron means we do not want schedules at all — the schedule service is never touched.
    expect(resolveCalls).not.toContain('dataSyncScheduleService')
  })

  it('schedules inventory on its own cron, and only when that cron is set', async () => {
    const state = makeStateService()
    const schedule = makeScheduleService()
    const { container } = makeContainer({
      integrationStateService: state,
      schedulerService: {},
      dataSyncScheduleService: schedule,
    })
    // Only the delta cron is set — inventory is enabled but must NOT be scheduled.
    const deltaOnly = await applyShopifyDataSyncBootstrap({
      container,
      scope: SCOPE,
      env: { [ENV_KEYS.enableEntities]: 'all', [ENV_KEYS.syncCron]: '0 * * * *' },
    })
    expect(deltaOnly.scheduled).toEqual(['products', 'collections', 'customers', 'orders'])
    expect(schedule.saves.map((s) => s.integrationId)).not.toContain(INTEGRATION_ID.inventory)
  })

  it('uses the inventory cron for the inventory snapshot schedule', async () => {
    const state = makeStateService()
    const schedule = makeScheduleService()
    const { container } = makeContainer({
      integrationStateService: state,
      schedulerService: {},
      dataSyncScheduleService: schedule,
    })
    const result = await applyShopifyDataSyncBootstrap({
      container,
      scope: SCOPE,
      env: { [ENV_KEYS.enableEntities]: 'inventory', [ENV_KEYS.inventoryCron]: '0 2 * * *' },
    })

    expect(result.scheduled).toEqual(['inventory'])
    expect(schedule.saves).toEqual([
      {
        integrationId: INTEGRATION_ID.inventory,
        entityType: ENTITY_TYPE.inventoryLevel,
        direction: 'import',
        scheduleType: 'cron',
        scheduleValue: '0 2 * * *',
        timezone: 'UTC',
        fullSync: false,
        isEnabled: true,
      },
    ])
  })

  it('schedules the delta syncs and inventory on their respective crons', async () => {
    const state = makeStateService()
    const schedule = makeScheduleService()
    const { container } = makeContainer({
      integrationStateService: state,
      schedulerService: {},
      dataSyncScheduleService: schedule,
    })
    const result = await applyShopifyDataSyncBootstrap({
      container,
      scope: SCOPE,
      env: {
        [ENV_KEYS.enableEntities]: 'all',
        [ENV_KEYS.syncCron]: '0 * * * *',
        [ENV_KEYS.inventoryCron]: '0 2 * * *',
      },
    })

    expect(result.scheduled).toEqual([...SYNC_ENTITY_NAMES])
    const byId = Object.fromEntries(schedule.saves.map((s) => [s.integrationId, s.scheduleValue]))
    expect(byId[INTEGRATION_ID.products]).toBe('0 * * * *')
    expect(byId[INTEGRATION_ID.inventory]).toBe('0 2 * * *')
  })
})

// ── Composed entry point ───────────────────────────────────────────────────────────────────────

describe('applyShopifyEnvPreset', () => {
  it('seeds credentials and enables entities together', async () => {
    const credentials = makeCredentialsService(null)
    const state = makeStateService()
    const { container } = makeContainer({
      integrationCredentialsService: credentials,
      integrationStateService: state,
    })
    const result = await applyShopifyEnvPreset({
      container,
      scope: SCOPE,
      env: {
        [ENV_KEYS.shopDomain]: 'mystore.myshopify.com',
        [ENV_KEYS.clientId]: 'cid',
        [ENV_KEYS.clientSecret]: 'shpss_x',
        [ENV_KEYS.enableEntities]: 'products',
      },
    })

    expect(result.credentials).toBe('applied')
    expect(credentials.saves).toHaveLength(1)
    expect(result.enabled).toEqual(['products'])
  })

  it('enables all five syncs by default for an env-driven deployment (entities unset)', async () => {
    const credentials = makeCredentialsService(null)
    const state = makeStateService()
    const { container } = makeContainer({
      integrationCredentialsService: credentials,
      integrationStateService: state,
    })
    const result = await applyShopifyEnvPreset({
      container,
      scope: SCOPE,
      env: {
        [ENV_KEYS.shopDomain]: 'mystore.myshopify.com',
        [ENV_KEYS.clientId]: 'cid',
        [ENV_KEYS.clientSecret]: 'shpss_x',
        // OM_INTEGRATION_SHOPIFY_ENABLE_ENTITIES deliberately unset → defaults to all
      },
    })

    expect(result.credentials).toBe('applied')
    expect(result.enabled).toEqual([...SYNC_ENTITY_NAMES])
  })

  it('still enables entities when credentials are already present (independent bootstraps)', async () => {
    const credentials = makeCredentialsService({
      shopDomain: 'mystore.myshopify.com',
      clientId: 'cid',
      clientSecret: 'shpss_x',
      apiVersion: '2026-07',
    })
    const state = makeStateService()
    const { container } = makeContainer({
      integrationCredentialsService: credentials,
      integrationStateService: state,
    })
    const result = await applyShopifyEnvPreset({
      container,
      scope: SCOPE,
      env: {
        [ENV_KEYS.shopDomain]: 'mystore.myshopify.com',
        [ENV_KEYS.enableEntities]: 'orders',
      },
    })

    expect(result.credentials).toBe('skipped')
    expect(credentials.saves).toHaveLength(0)
    expect(result.enabled).toEqual(['orders'])
  })
})
