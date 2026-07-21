import type { AwilixContainer } from 'awilix'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import type { ExternalIdMappingService } from '@open-mercato/core/modules/data_sync/lib/id-mapping'
import {
  createEntityWriter,
  type CommandBusPort,
  type CustomFieldWriterPort,
  type EntityRow,
  type ExternalIdMappingPort,
  type FindOnePort,
  type TenantScope,
} from './writer'
import { createShopifyClient, type ShopifyClient } from './client'
import { createTokenProvider } from './token'
import { INTEGRATION_ID, MAPPING_ENTITY_TYPE } from './constants'
import { resolveConnectionCredentials } from './preset'
import type { ProductsMappingPort, ProductsRuntime } from './adapters/products'
import type { CategoryAssignmentPort, CollectionsRunContext } from './adapters/collections'
import type { CustomerSyncRuntime } from './adapters/customers'
import type { InventorySnapshotStore } from './adapters/inventory'
import type { OrderSyncRuntime, OrdersMappingPort } from './adapters/orders'

/**
 * The convergence layer: builds each adapter's real dependencies from the framework container.
 *
 * The four adapters are pure generators over injected ports; this file is where those ports get
 * their teeth. It exists as its own module — rather than living in `di.ts` — for one reason: the
 * framework never loads under ts-jest, so anything a test touches must import framework values by
 * NOTHING but `import type`. So the split is:
 *
 *   • `di.ts` (never loaded by a test) owns every framework RUNTIME import — `createRequestContainer`,
 *     `findOneWithDecryption`, `setCustomFieldsIfAny`, the ORM entity classes — and packs them into a
 *     `RuntimeEnv`.
 *   • this file holds the WIRING LOGIC — which service to resolve, which where-clause to build, which
 *     integration id to scope by — against that injected env, resolving services by string name from
 *     the container exactly as `lib/adapter.ts` in the akeneo template does. A test supplies a stub
 *     env and a stub container and asserts the wiring without a database.
 *
 * PER-RUN CONTAINER LIFECYCLE. Writes go through the CommandBus and reads through
 * `findOneWithDecryption`, both of which need a request-scoped `em` (§4.8). The engine hands the
 * adapter only `{ scope, credentials }`, so the adapter mints its own container.
 *
 *   • products / collections / customers each call their runtime factory ONCE per `streamImport`
 *     run, so each opens ONE container per run and shares its `em`/`commandBus`/mapping service across
 *     every read and write of that run — the same "one `createRequestContainer()` per run" shape the
 *     akeneo importer uses.
 *   • inventory exposes flat deps with no per-run seam, and it writes DIRECTLY through the ORM
 *     (`em.upsertMany`) rather than the CommandBus. So each inventory port opens a FRESH container per
 *     call. That is deliberately concurrency-safe (no shared mutable `em` across two runs that may sit
 *     in one worker process) and keeps each raw-write unit-of-work bounded to a single page.
 *
 * THREE TRAPS, each obeyed here and pinned by a test:
 *   1. `findPriceKindByCode` is scoped by TENANT ONLY — `CatalogPriceKind.organization_id` is nullable
 *      and core seeds it null, so adding the organization finds nothing and writes zero prices.
 *   2. inventory variant resolution and collections member resolution look up the mapping under the
 *      PRODUCTS integration id, because that is who wrote those rows. This module forwards the
 *      integration id the adapter passes verbatim; it never substitutes its own.
 *   3. credentials are tenant-wide — `scope` here is `{ organizationId, tenantId }` with no `userId`,
 *      so a per-user credential row can never be resolved by accident.
 */

// ── Injected framework surface ─────────────────────────────────────────────────────────────────

export type RuntimeContainer = AwilixContainer

/**
 * The ORM entity classes, passed as opaque values.
 *
 * They are only ever handed straight to `findOneWithDecryption`/`findWithDecryption`, so typing them
 * as `unknown` keeps every framework import in `di.ts` and this module out of ts-jest's way.
 */
export type RuntimeEntities = {
  product: unknown
  variant: unknown
  price: unknown
  priceKind: unknown
  category: unknown
  categoryAssignment: unknown
  customerEntity: unknown
  customerAddress: unknown
  syncMapping: unknown
}

/** Everything framework-shaped a runtime needs, assembled once in `di.ts`. */
export type RuntimeEnv = {
  /** `createRequestContainer` — one fresh request scope, `em` forked, all module registrars applied. */
  createContainer: () => Promise<RuntimeContainer>
  /** `findOneWithDecryption`, em passed explicitly so this stays a pure function of the injected env. */
  findOne: (
    em: unknown,
    entity: unknown,
    where: Record<string, unknown>,
    options: unknown,
    scope: TenantScope,
  ) => Promise<EntityRow | null>
  /** `findWithDecryption`, same shape. */
  findMany: (
    em: unknown,
    entity: unknown,
    where: Record<string, unknown>,
    options: unknown,
    scope: TenantScope,
  ) => Promise<EntityRow[]>
  /** `setCustomFieldsIfAny`, bound by `di.ts` to take the data engine as its first argument. */
  setCustomFields: (
    dataEngine: unknown,
    args: {
      entityId: string
      recordId: string
      tenantId: string
      organizationId: string
      values: Record<string, unknown>
    },
  ) => Promise<void>
  /** `createInventorySnapshotStore`, given a request-scoped `em`. */
  createSnapshotStore: (em: unknown) => InventorySnapshotStore
  entities: RuntimeEntities
}

// ── Scoped-where helpers ───────────────────────────────────────────────────────────────────────
// Every read carries `organizationId` + `tenantId`. `deletedAt: null` is added ONLY for entities
// that actually have the column — `CatalogProductPrice`, `CatalogProductCategoryAssignment` and
// `CustomerAddress` do not, and querying a non-existent column throws under MikroORM v7.

function scoped(scope: TenantScope, extra: Record<string, unknown>): Record<string, unknown> {
  return { ...extra, organizationId: scope.organizationId, tenantId: scope.tenantId }
}

function scopedLive(scope: TenantScope, extra: Record<string, unknown>): Record<string, unknown> {
  return { ...scoped(scope, extra), deletedAt: null }
}

/** Read a ManyToOne's id whether the relation came back as a reference, an entity or a bare id. */
function refId(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'string') return id
  }
  return null
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

// ── The shared Shopify client ───────────────────────────────────────────────────────────────────

/**
 * Build a Shopify client from a connection's credentials. Shared by all four adapters.
 *
 * Credentials are resolved env-first (`resolveConnectionCredentials`): a stored field wins, else the
 * `OM_INTEGRATION_SHOPIFY_*` env var — so an env-driven deployment connects even when the store is
 * empty or partial. `createShopifyClient` then normalises the shop domain eagerly and throws on an
 * empty or foreign host, so a misconfigured connection fails loudly here rather than POSTing a client
 * secret somewhere unsafe. No `userId` is read or set — credentials are tenant-wide (trap 3).
 */
export function createShopifyClientFromCredentials(
  credentials: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): ShopifyClient {
  const { shopDomain, clientId, clientSecret, apiVersion } = resolveConnectionCredentials(credentials, env)
  const tokenProvider = createTokenProvider({ shopDomain, clientId, clientSecret })
  return createShopifyClient({ shopDomain, tokenProvider, apiVersion })
}

// ── Resolved-per-run collaborators ──────────────────────────────────────────────────────────────

type RunServices = {
  container: RuntimeContainer
  em: unknown
  commandBus: CommandBus
  mappingService: ExternalIdMappingService
  dataEngine: unknown
  /** A `FindOnePort` bound to this run's `em`, for `createEntityWriter`. */
  findOne: FindOnePort
}

/**
 * Open one request container and resolve every service a run needs from it by string name.
 *
 * Passing the real `CommandBus` and `ExternalIdMappingService` straight into `createEntityWriter`
 * below is what re-proves the writer's ports under `yarn typecheck` — the conformance check the
 * writer module documents it cannot host itself.
 */
async function openRun(env: RuntimeEnv): Promise<RunServices> {
  const container = await env.createContainer()
  const em = container.resolve('em')
  const commandBus = container.resolve('commandBus') as CommandBus
  const mappingService = container.resolve('externalIdMappingService') as ExternalIdMappingService
  const dataEngine = container.resolve('dataEngine')
  const findOne: FindOnePort = (entity, where, options, scope) =>
    env.findOne(em, entity, where, options, scope)
  return { container, em, commandBus, mappingService, dataEngine, findOne }
}

// ── Products ────────────────────────────────────────────────────────────────────────────────────

export async function createProductsRuntime(
  env: RuntimeEnv,
  input: { scope: TenantScope; integrationId: string; credentials: Record<string, unknown> },
): Promise<ProductsRuntime> {
  const { scope, integrationId } = input
  const run = await openRun(env)
  const E = env.entities

  const writer = createEntityWriter({
    container: run.container,
    scope,
    integrationId,
    commandBus: run.commandBus,
    externalIdMapping: run.mappingService,
    findOne: run.findOne,
  })

  // `ExternalIdMappingService` carries lookupExternalId + deleteExternalIdMapping on top of the two
  // ExternalIdMappingPort methods, so it satisfies ProductsMappingPort directly.
  const mapping: ProductsMappingPort = run.mappingService

  return {
    writer,
    mapping,
    readProduct: writer.rowReader(E.product),
    readVariant: writer.rowReader(E.variant),
    // `CatalogProductPrice` has no deleted_at column — scope org + tenant only.
    readPrice: (localId) => env.findOne(run.em, E.price, scoped(scope, { id: localId }), undefined, scope),
    findProductByHandle: writer.naturalKeyLookup(E.product, 'handle'),
    findVariantBySku: writer.naturalKeyLookup(E.variant, 'sku'),
    // 🔴 TRAP 1: TENANT ONLY. `CatalogPriceKind.organization_id` is nullable and core seeds it null,
    // so adding the organization to this where clause finds nothing and silently writes zero prices.
    findPriceKindByCode: (code) =>
      env.findOne(run.em, E.priceKind, { code, tenantId: scope.tenantId, deletedAt: null }, undefined, scope),
    findVariantsByProductId: (productLocalId) =>
      env.findMany(run.em, E.variant, scopedLive(scope, { product: productLocalId }), undefined, scope),
    listOwnedLocalIds: async (entityType) => {
      const rows = await env.findMany(
        run.em,
        E.syncMapping,
        scopedLive(scope, { integrationId, internalEntityType: entityType }),
        undefined,
        scope,
      )
      return rows.map((row) => stringField(row.internalEntityId)).filter((id): id is string => id !== null)
    },
    execute: async (commandId, commandInput) => {
      await run.commandBus.execute(commandId, { input: commandInput, ctx: writer.commandContext })
    },
  }
}

// ── Collections ──────────────────────────────────────────────────────────────────────────────────

export async function createCollectionsRunContext(
  env: RuntimeEnv,
  input: { scope: TenantScope },
): Promise<CollectionsRunContext> {
  const run = await openRun(env)
  const E = env.entities

  const writer = createEntityWriter({
    container: run.container,
    scope: input.scope,
    integrationId: INTEGRATION_ID.collections,
    commandBus: run.commandBus,
    externalIdMapping: run.mappingService,
    findOne: run.findOne,
  })

  // `catalog_product_category_assignments` has no deleted_at column — scope org + tenant only.
  const assignments: CategoryAssignmentPort = {
    productIdsForCategory: async (categoryLocalId, scope) => {
      const rows = await env.findMany(
        run.em,
        E.categoryAssignment,
        scoped(scope, { category: categoryLocalId }),
        undefined,
        scope,
      )
      return rows.map((row) => refId(row.product)).filter((id): id is string => id !== null)
    },
    categoryIdsForProduct: async (productLocalId, scope) => {
      const rows = await env.findMany(
        run.em,
        E.categoryAssignment,
        scoped(scope, { product: productLocalId }),
        undefined,
        scope,
      )
      return rows.map((row) => refId(row.category)).filter((id): id is string => id !== null)
    },
  }

  return {
    writer,
    // The adapter supplies `INTEGRATION_ID.products` when resolving a member's local product id
    // (trap 2); this service forwards that argument verbatim.
    externalIdMapping: run.mappingService,
    commandBus: run.commandBus,
    assignments,
    categoryEntity: E.category,
  }
}

// ── Customers ────────────────────────────────────────────────────────────────────────────────────

export async function createCustomersRuntime(
  env: RuntimeEnv,
  input: { scope: TenantScope; credentials: Record<string, unknown> },
): Promise<CustomerSyncRuntime> {
  const { scope } = input
  const client = createShopifyClientFromCredentials(input.credentials)
  const run = await openRun(env)
  const E = env.entities

  const writer = createEntityWriter({
    container: run.container,
    scope,
    integrationId: INTEGRATION_ID.customers,
    commandBus: run.commandBus,
    externalIdMapping: run.mappingService,
    findOne: run.findOne,
  })

  return {
    client,
    writer,
    commandBus: run.commandBus,
    customerEntity: E.customerEntity,
    customerAddress: E.customerAddress,
    findCustomerByEmail: writer.naturalKeyLookup(E.customerEntity, 'primaryEmail'),
    // `customer_addresses` has no deleted_at column — scope org + tenant only. (`entity` is the
    // ManyToOne to CustomerEntity; MikroORM accepts the parent id string as the filter value.)
    listAddresses: (customerLocalId) =>
      env.findMany(run.em, E.customerAddress, scoped(scope, { entity: customerLocalId }), undefined, scope),
    // Same reason, single row: the address upsert's mapping re-validation re-reads by id. Must NOT
    // use `writer.rowReader` (it forces deletedAt:null) — a mapped address on the second sync would
    // throw on the missing column and fail the customer. Org + tenant only, mirroring listAddresses.
    readAddressById: (localId) =>
      env.findOne(run.em, E.customerAddress, scoped(scope, { id: localId }), undefined, scope),
    // Bound to this integration's own id — customers owns its customer and address mappings.
    lookupExternalId: (entityType, localId) =>
      run.mappingService.lookupExternalId(INTEGRATION_ID.customers, entityType, localId, scope),
    listSyncedCustomers: async () => {
      const rows = await env.findMany(
        run.em,
        E.syncMapping,
        scopedLive(scope, {
          integrationId: INTEGRATION_ID.customers,
          internalEntityType: MAPPING_ENTITY_TYPE.customerEntity,
        }),
        undefined,
        scope,
      )
      return rows
        .map((row) => ({ localId: stringField(row.internalEntityId), externalId: stringField(row.externalId) }))
        .filter((entry): entry is { localId: string; externalId: string } => entry.localId !== null && entry.externalId !== null)
    },
    // `contentHash` is deliberately left unset: there is no framework-provided home for a per-customer
    // hash yet, and a hash compared against a store that does not exist is worse than none (see the
    // adapter's port comment). Every resolved customer is rewritten instead of wrongly skipped.
  }
}

// ── Orders ───────────────────────────────────────────────────────────────────────────────────────

export async function createOrdersRuntime(
  env: RuntimeEnv,
  input: { scope: TenantScope; credentials: Record<string, unknown> },
): Promise<OrderSyncRuntime> {
  const { scope } = input
  const client = createShopifyClientFromCredentials(input.credentials)
  const run = await openRun(env)
  const E = env.entities

  const writer = createEntityWriter({
    container: run.container,
    scope,
    integrationId: INTEGRATION_ID.orders,
    commandBus: run.commandBus,
    externalIdMapping: run.mappingService,
    findOne: run.findOne,
  })

  const variantBySku = writer.naturalKeyLookup(E.variant, 'sku')
  const mapping: OrdersMappingPort = run.mappingService

  // `SalesOrder` is resolved from the container by name rather than imported: sales/di.ts registers it
  // as an asValue, and importing `@open-mercato/core/modules/sales/data/entities` drags in the sales
  // module's type graph, which currently fails typecheck (a latent `EventBus`-namespace-as-type bug in
  // core's `sales/lib/types.ts`). Resolving by string is the akeneo pattern and sidesteps it entirely.
  const salesOrder = run.container.resolve('SalesOrder') as unknown

  return {
    client,
    writer,
    mapping,
    // `SalesOrder` has no deleted_at column — scope org + tenant only (as with CatalogProductPrice).
    readOrder: (localId) => env.findOne(run.em, salesOrder, scoped(scope, { id: localId }), undefined, scope),
    findOrderByExternalReference: (externalReference) => {
      // A blank natural key would otherwise match an arbitrary row with a null external_reference.
      if (typeof externalReference !== 'string' || externalReference.trim() === '') return Promise.resolve(null)
      return env.findOne(run.em, salesOrder, scoped(scope, { externalReference }), undefined, scope)
    },
    // 🔴 TRAP 2: the variant was mapped by the PRODUCTS sync, so resolve its local id under
    // `INTEGRATION_ID.products` — resolving under orders' own id would always miss. Fall back to the
    // local variant's SKU (a natural key that heals a variant whose GID mapping is absent).
    resolveVariantLocalId: async (variantExternalId, sku) => {
      if (variantExternalId) {
        const localId = await run.mappingService.lookupLocalId(
          INTEGRATION_ID.products,
          MAPPING_ENTITY_TYPE.productVariant,
          variantExternalId,
          scope,
        )
        if (localId) return localId
      }
      if (sku) {
        const row = await variantBySku(sku)
        if (row) return row.id
      }
      return null
    },
    // 🔴 TRAP 2: the customer was mapped by the CUSTOMERS sync — resolve under `INTEGRATION_ID.customers`.
    resolveCustomerLocalId: (customerExternalId) =>
      run.mappingService.lookupLocalId(
        INTEGRATION_ID.customers,
        MAPPING_ENTITY_TYPE.customerEntity,
        customerExternalId,
        scope,
      ),
    // ⚠️ NON-VOID, unlike products' `execute`. Orders dispatches child creates (payments, shipments)
    // and needs their ids back (`paymentId`/`shipmentId`), so the bus envelope's `result` is returned
    // rather than swallowed.
    execute: async (commandId, commandInput) => ({
      result: (await run.commandBus.execute(commandId, { input: commandInput, ctx: writer.commandContext })).result,
    }),
    listOwnedOrderIds: async () => {
      const rows = await env.findMany(
        run.em,
        E.syncMapping,
        scopedLive(scope, {
          integrationId: INTEGRATION_ID.orders,
          internalEntityType: MAPPING_ENTITY_TYPE.salesOrder,
        }),
        undefined,
        scope,
      )
      return rows.map((row) => stringField(row.internalEntityId)).filter((id): id is string => id !== null)
    },
    // `resolveStatusEntryIds` is intentionally left unwired: it is optional, and absent it keeps the
    // display statuses in `metadata.shopify` with the native payment_status/fulfillment_status columns
    // null — the intended v1 behaviour, since no status dictionary is seeded yet.
  }
}

// ── Inventory ────────────────────────────────────────────────────────────────────────────────────

export type InventoryPorts = {
  store: InventorySnapshotStore
  externalIdMapping: ExternalIdMappingPort
  writeCustomFields: CustomFieldWriterPort
}

/**
 * Inventory's flat ports. Each opens a FRESH container per call (see the lifecycle note up top):
 * inventory has no per-run factory, writes raw through the ORM, and may run concurrently with another
 * tenant's inventory run in the same worker, so a shared `em` would be both a leak and a hazard.
 */
export function createInventoryPorts(env: RuntimeEnv): InventoryPorts {
  const store: InventorySnapshotStore = {
    findDailyRows: async (args) => {
      const container = await env.createContainer()
      return env.createSnapshotStore(container.resolve('em')).findDailyRows(args)
    },
    upsertSnapshots: async (args) => {
      const container = await env.createContainer()
      return env.createSnapshotStore(container.resolve('em')).upsertSnapshots(args)
    },
  }

  const externalIdMapping: ExternalIdMappingPort = {
    // 🔴 TRAP 2: the adapter passes `INTEGRATION_ID.products` here because the products sync wrote the
    // variant mapping rows. This forwards `integrationId` unchanged — it never substitutes inventory's
    // own id, which would find nothing and silently disable every write-back.
    lookupLocalId: async (integrationId, entityType, externalId, scope) => {
      const container = await env.createContainer()
      const service = container.resolve('externalIdMappingService') as ExternalIdMappingService
      return service.lookupLocalId(integrationId, entityType, externalId, scope)
    },
    storeExternalIdMapping: async (integrationId, entityType, localId, externalId, scope) => {
      const container = await env.createContainer()
      const service = container.resolve('externalIdMappingService') as ExternalIdMappingService
      return service.storeExternalIdMapping(integrationId, entityType, localId, externalId, scope)
    },
  }

  const writeCustomFields: CustomFieldWriterPort = async (fields) => {
    const container = await env.createContainer()
    await env.setCustomFields(container.resolve('dataEngine'), fields)
  }

  return { store, externalIdMapping, writeCustomFields }
}
