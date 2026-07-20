import {
  createCollectionsRunContext,
  createCustomersRuntime,
  createInventoryPorts,
  createProductsRuntime,
  createShopifyClientFromCredentials,
  type RuntimeEnv,
} from '../lib/runtime'
import { createShopifyProductsAdapter } from '../lib/adapters/products'
import { createShopifyCollectionsAdapter } from '../lib/adapters/collections'
import { createCustomersAdapter } from '../lib/adapters/customers'
import { createShopifyInventoryAdapter } from '../lib/adapters/inventory'
import { DEFAULT_API_VERSION, INTEGRATION_ID, MAPPING_ENTITY_TYPE, PROVIDER_KEY } from '../lib/constants'
import type { EntityRow } from '../lib/writer'

// The framework never loads at test runtime, so the whole convergence layer is exercised against a
// stub `RuntimeEnv` and a stub container. The assertions below deliberately check the EXACT where
// clauses and the EXACT integration ids handed to the injected reads — the three scoping traps this
// wiring exists to defuse each fail SILENTLY in production, so this is the only place they surface.

const SCOPE = { organizationId: 'org-1', tenantId: 'tenant-1' }
const CREDENTIALS = {
  shopDomain: 'mystore.myshopify.com',
  clientId: 'client-id',
  clientSecret: 'shpss_secret',
  apiVersion: '2026-07',
}

type FindCall = { entity: unknown; where: Record<string, unknown>; scope: Record<string, unknown> }
type LookupLocalIdCall = { integrationId: string; entityType: string; externalId: string }
type LookupExternalIdCall = { integrationId: string; entityType: string; localId: string }

function makeEnv(
  opts: { findManyResult?: (call: FindCall) => EntityRow[]; findOneResult?: (call: FindCall) => EntityRow | null } = {},
) {
  const findOneCalls: FindCall[] = []
  const findManyCalls: FindCall[] = []
  const lookupLocalIdCalls: LookupLocalIdCall[] = []
  const lookupExternalIdCalls: LookupExternalIdCall[] = []
  const setCustomFieldsCalls: Array<{ dataEngine: unknown; args: Record<string, unknown> }> = []
  let containerCount = 0

  const service = {
    async lookupLocalId(integrationId: string, entityType: string, externalId: string) {
      lookupLocalIdCalls.push({ integrationId, entityType, externalId })
      return null
    },
    async lookupExternalId(integrationId: string, entityType: string, localId: string) {
      lookupExternalIdCalls.push({ integrationId, entityType, localId })
      return null
    },
    async storeExternalIdMapping() {
      return {}
    },
    async deleteExternalIdMapping() {
      return true
    },
  }
  const commandBus = { async execute() { return { result: { productId: 'local-x' }, logEntry: null } } }
  const snapshotStore = { async findDailyRows() { return [] }, async upsertSnapshots() { return new Map() } }
  const cradle: Record<string, unknown> = {
    em: { marker: 'em' },
    commandBus,
    externalIdMappingService: service,
    dataEngine: { marker: 'dataEngine' },
  }
  const container = { resolve: (name: string) => cradle[name] }

  const env: RuntimeEnv = {
    createContainer: async () => {
      containerCount += 1
      return container as unknown as Awaited<ReturnType<RuntimeEnv['createContainer']>>
    },
    findOne: async (_em, entity, where, _options, scope) => {
      const call: FindCall = { entity, where, scope: scope as unknown as Record<string, unknown> }
      findOneCalls.push(call)
      return opts.findOneResult ? opts.findOneResult(call) : null
    },
    findMany: async (_em, entity, where, _options, scope) => {
      const call: FindCall = { entity, where, scope: scope as unknown as Record<string, unknown> }
      findManyCalls.push(call)
      return opts.findManyResult ? opts.findManyResult(call) : []
    },
    setCustomFields: async (dataEngine, args) => {
      setCustomFieldsCalls.push({ dataEngine, args: args as unknown as Record<string, unknown> })
    },
    createSnapshotStore: () => snapshotStore as unknown as ReturnType<RuntimeEnv['createSnapshotStore']>,
    entities: {
      product: 'CatalogProduct',
      variant: 'CatalogProductVariant',
      price: 'CatalogProductPrice',
      priceKind: 'CatalogPriceKind',
      category: 'CatalogProductCategory',
      categoryAssignment: 'CatalogProductCategoryAssignment',
      customerEntity: 'CustomerEntity',
      customerAddress: 'CustomerAddress',
      syncMapping: 'SyncExternalIdMapping',
    },
  }

  return {
    env,
    findOneCalls,
    findManyCalls,
    lookupLocalIdCalls,
    lookupExternalIdCalls,
    setCustomFieldsCalls,
    getContainerCount: () => containerCount,
  }
}

const last = <T>(items: T[]): T => {
  expect(items.length).toBeGreaterThan(0)
  return items[items.length - 1]
}

// ── Registration ─────────────────────────────────────────────────────────────────────────────

describe('adapter registration', () => {
  it('exposes each adapter under the providerKey its IntegrationDefinition declares', () => {
    const { env } = makeEnv()

    const products = createShopifyProductsAdapter({
      createClient: createShopifyClientFromCredentials,
      createRuntime: (input) => createProductsRuntime(env, input),
    })
    const collections = createShopifyCollectionsAdapter({
      createClient: createShopifyClientFromCredentials,
      createRunContext: (input) => createCollectionsRunContext(env, input),
    })
    const customers = createCustomersAdapter({
      createRuntime: (input) => createCustomersRuntime(env, input),
    })
    const inventory = createShopifyInventoryAdapter({
      createClient: createShopifyClientFromCredentials,
      ...createInventoryPorts(env),
    })

    expect(products.providerKey).toBe(PROVIDER_KEY.products)
    expect(collections.providerKey).toBe(PROVIDER_KEY.collections)
    expect(customers.providerKey).toBe(PROVIDER_KEY.customers)
    expect(inventory.providerKey).toBe(PROVIDER_KEY.inventory)
  })
})

// ── Shared client ────────────────────────────────────────────────────────────────────────────

describe('createShopifyClientFromCredentials', () => {
  it('builds a client from the connection credentials', () => {
    const client = createShopifyClientFromCredentials(CREDENTIALS)
    expect(client.shopDomain).toContain('mystore')
    expect(client.shopDomain).toMatch(/myshopify\.com$/)
    expect(client.apiVersion).toBe('2026-07')
  })

  it('falls back to the pinned API version and fails loudly on a missing shop domain', () => {
    const client = createShopifyClientFromCredentials({
      shopDomain: 'mystore.myshopify.com',
      clientId: 'id',
      clientSecret: 'secret',
    })
    expect(client.apiVersion).toBe(DEFAULT_API_VERSION)
    // `createShopifyClient` normalises the domain eagerly, so an empty one throws before a secret can
    // ever be POSTed to a foreign host.
    expect(() => createShopifyClientFromCredentials({})).toThrow()
  })
})

// ── Products ─────────────────────────────────────────────────────────────────────────────────

describe('products runtime', () => {
  const build = (h: ReturnType<typeof makeEnv>) =>
    createProductsRuntime(h.env, { scope: SCOPE, integrationId: INTEGRATION_ID.products, credentials: CREDENTIALS })

  it('opens exactly one request container for the whole run', async () => {
    const h = makeEnv()
    await build(h)
    expect(h.getContainerCount()).toBe(1)
  })

  it('scopes a representative read by org + tenant + deletedAt and never carries a userId (trap 3)', async () => {
    const h = makeEnv()
    const runtime = await build(h)
    await runtime.findVariantsByProductId('prod-1')

    const call = last(h.findManyCalls)
    expect(call.entity).toBe('CatalogProductVariant')
    expect(call.where).toEqual({
      product: 'prod-1',
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      deletedAt: null,
    })
    // Trap 3: credentials are tenant-wide, so the scope threaded through every read is org + tenant
    // only — a stray userId here would silently resolve a per-user credential row.
    expect(Object.keys(call.scope).sort()).toEqual(['organizationId', 'tenantId'])
  })

  it('scopes findPriceKindByCode by TENANT ONLY, never by organization (trap 1)', async () => {
    const h = makeEnv()
    const runtime = await build(h)
    await runtime.findPriceKindByCode('regular')

    const call = last(h.findOneCalls)
    expect(call.entity).toBe('CatalogPriceKind')
    expect(call.where).toEqual({ code: 'regular', tenantId: 'tenant-1', deletedAt: null })
    // The trap itself: CatalogPriceKind.organization_id is nullable and seeded null, so an
    // organization in the where clause finds nothing and writes zero prices.
    expect('organizationId' in call.where).toBe(false)
  })

  it('reads a price without a deletedAt filter — CatalogProductPrice has no such column', async () => {
    const h = makeEnv()
    const runtime = await build(h)
    await runtime.readPrice('price-1')

    const call = last(h.findOneCalls)
    expect(call.entity).toBe('CatalogProductPrice')
    expect(call.where).toEqual({ id: 'price-1', organizationId: 'org-1', tenantId: 'tenant-1' })
    expect('deletedAt' in call.where).toBe(false)
  })

  it('lists owned local ids from the mapping table scoped to this integration', async () => {
    const h = makeEnv({
      findManyResult: () => [
        { id: 'm1', internalEntityId: 'prod-1', externalId: 'gid://shopify/Product/1' },
        { id: 'm2', internalEntityId: 'prod-2', externalId: 'gid://shopify/Product/2' },
      ],
    })
    const runtime = await build(h)
    const ids = await runtime.listOwnedLocalIds(MAPPING_ENTITY_TYPE.product)

    expect(ids).toEqual(['prod-1', 'prod-2'])
    const call = last(h.findManyCalls)
    expect(call.entity).toBe('SyncExternalIdMapping')
    expect(call.where).toEqual({
      integrationId: INTEGRATION_ID.products,
      internalEntityType: MAPPING_ENTITY_TYPE.product,
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      deletedAt: null,
    })
  })
})

// ── Collections ──────────────────────────────────────────────────────────────────────────────

describe('collections run context', () => {
  it('resolves member products under the PRODUCTS integration id, not its own (trap 2)', async () => {
    const h = makeEnv()
    const run = await createCollectionsRunContext(h.env, { scope: SCOPE })
    // The adapter passes INTEGRATION_ID.products; the wiring must forward it verbatim.
    await run.externalIdMapping.lookupLocalId(
      INTEGRATION_ID.products,
      MAPPING_ENTITY_TYPE.product,
      'gid://shopify/Product/1',
      SCOPE,
    )
    expect(last(h.lookupLocalIdCalls).integrationId).toBe(INTEGRATION_ID.products)
    expect(last(h.lookupLocalIdCalls).integrationId).not.toBe(INTEGRATION_ID.collections)
  })

  it('reads category assignments without a deletedAt filter and returns the product ids', async () => {
    const h = makeEnv({
      findManyResult: () => [{ id: 'a1', product: { id: 'prod-1' }, category: { id: 'cat-1' } }],
    })
    const run = await createCollectionsRunContext(h.env, { scope: SCOPE })
    const ids = await run.assignments.productIdsForCategory('cat-1', SCOPE)

    expect(ids).toEqual(['prod-1'])
    const call = last(h.findManyCalls)
    expect(call.entity).toBe('CatalogProductCategoryAssignment')
    // catalog_product_category_assignments has no deleted_at column — org + tenant only.
    expect(call.where).toEqual({ category: 'cat-1', organizationId: 'org-1', tenantId: 'tenant-1' })
    expect('deletedAt' in call.where).toBe(false)
  })
})

// ── Customers ────────────────────────────────────────────────────────────────────────────────

describe('customers runtime', () => {
  const build = (h: ReturnType<typeof makeEnv>) =>
    createCustomersRuntime(h.env, { scope: SCOPE, credentials: CREDENTIALS })

  it('builds a Shopify client and binds lookupExternalId to the customers integration', async () => {
    const h = makeEnv()
    const runtime = await build(h)

    expect(runtime.client.shopDomain).toMatch(/myshopify\.com$/)
    await runtime.lookupExternalId(MAPPING_ENTITY_TYPE.customerAddress, 'addr-1')
    expect(last(h.lookupExternalIdCalls)).toEqual({
      integrationId: INTEGRATION_ID.customers,
      entityType: MAPPING_ENTITY_TYPE.customerAddress,
      localId: 'addr-1',
    })
  })

  it("lists a customer's addresses without a deletedAt filter — customer_addresses has no such column", async () => {
    const h = makeEnv()
    const runtime = await build(h)
    await runtime.listAddresses('cust-1')

    const call = last(h.findManyCalls)
    expect(call.entity).toBe('CustomerAddress')
    expect(call.where).toEqual({ entity: 'cust-1', organizationId: 'org-1', tenantId: 'tenant-1' })
    expect('deletedAt' in call.where).toBe(false)
  })

  it('lists synced customers scoped to the customers integration', async () => {
    const h = makeEnv({
      findManyResult: () => [{ id: 'm', internalEntityId: 'cust-1', externalId: 'gid://shopify/Customer/1' }],
    })
    const runtime = await build(h)
    const rows = await runtime.listSyncedCustomers()

    expect(rows).toEqual([{ localId: 'cust-1', externalId: 'gid://shopify/Customer/1' }])
    const call = last(h.findManyCalls)
    expect(call.where).toEqual({
      integrationId: INTEGRATION_ID.customers,
      internalEntityType: MAPPING_ENTITY_TYPE.customerEntity,
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      deletedAt: null,
    })
  })
})

// ── Inventory ────────────────────────────────────────────────────────────────────────────────

describe('inventory ports', () => {
  it('open a fresh container per call rather than sharing one across the run', async () => {
    const h = makeEnv()
    const ports = createInventoryPorts(h.env)
    // Building the ports resolves nothing — a container is only opened when a port is invoked.
    expect(h.getContainerCount()).toBe(0)

    await ports.externalIdMapping.lookupLocalId(
      INTEGRATION_ID.products,
      MAPPING_ENTITY_TYPE.productVariant,
      'gid://shopify/ProductVariant/1',
      SCOPE,
    )
    await ports.store.upsertSnapshots({ rows: [], scope: SCOPE })
    expect(h.getContainerCount()).toBe(2)
  })

  it('resolves a variant mapping under the PRODUCTS integration id (trap 2)', async () => {
    const h = makeEnv()
    const ports = createInventoryPorts(h.env)
    await ports.externalIdMapping.lookupLocalId(
      INTEGRATION_ID.products,
      MAPPING_ENTITY_TYPE.productVariant,
      'gid://shopify/ProductVariant/1',
      SCOPE,
    )
    const call = last(h.lookupLocalIdCalls)
    expect(call.integrationId).toBe('sync_shopify_products')
    expect(call.integrationId).toBe(INTEGRATION_ID.products)
    expect(call.integrationId).not.toBe(INTEGRATION_ID.inventory)
  })

  it('writes custom fields through the data engine resolved per call', async () => {
    const h = makeEnv()
    const ports = createInventoryPorts(h.env)
    await ports.writeCustomFields({
      entityId: 'catalog:catalog_product_variant',
      recordId: 'v1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      values: { unit_cost: '5.00' },
    })
    expect(h.setCustomFieldsCalls).toHaveLength(1)
    expect(h.setCustomFieldsCalls[0].args.values).toEqual({ unit_cost: '5.00' })
    expect((h.setCustomFieldsCalls[0].dataEngine as { marker?: string }).marker).toBe('dataEngine')
  })
})
