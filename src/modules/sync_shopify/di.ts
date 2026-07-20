import { asValue } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { registerDataSyncAdapter } from '@open-mercato/core/modules/data_sync/lib/adapter-registry'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { setCustomFieldsIfAny } from '@open-mercato/shared/lib/commands/helpers'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import {
  CatalogPriceKind,
  CatalogProduct,
  CatalogProductCategory,
  CatalogProductCategoryAssignment,
  CatalogProductPrice,
  CatalogProductVariant,
} from '@open-mercato/core/modules/catalog/data/entities'
import { CustomerAddress, CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { SyncExternalIdMapping } from '@open-mercato/core/modules/integrations/data/entities'
import { HEALTH_CHECK_SERVICE } from './lib/constants'
import { shopifyHealthCheck } from './lib/health'
import { createInventorySnapshotStore } from './lib/inventory-store'
import { createShopifyProductsAdapter } from './lib/adapters/products'
import { createShopifyCollectionsAdapter } from './lib/adapters/collections'
import { createCustomersAdapter } from './lib/adapters/customers'
import { createShopifyInventoryAdapter } from './lib/adapters/inventory'
import {
  createCollectionsRunContext,
  createCustomersRuntime,
  createInventoryPorts,
  createProductsRuntime,
  createShopifyClientFromCredentials,
  type RuntimeEnv,
} from './lib/runtime'

/**
 * Module DI registrar, discovered by `yarn generate`.
 *
 * Note the framework docs say to register data_sync adapters from `setup.ts`; both shipped
 * first-party modules (sync_excel, sync-akeneo) do it here in `di.ts` instead. We follow the
 * code, not the docs.
 *
 * The health-check DI name must match `integration.healthCheck.service` exactly — the
 * integrations health service resolves it by that string, and a mismatch surfaces only at
 * runtime as a resolution error.
 *
 * This is also the module's one and only home for framework RUNTIME imports. `lib/runtime.ts`
 * holds the wiring logic and stays framework-free so ts-jest can load it; this file supplies the
 * framework values it needs through a `RuntimeEnv` bundle, and the four adapters each get their
 * real dependencies built from a request container per run (products/collections/customers) or per
 * call (inventory). See `lib/runtime.ts` for the lifecycle rationale and the three scoping traps.
 */

/**
 * The framework surface `lib/runtime.ts` needs, resolved from real modules here so the wiring logic
 * stays testable against a stub. Entity classes are passed as opaque values — the runtime only ever
 * forwards them to the decryption-aware read helpers.
 */
function buildRuntimeEnv(): RuntimeEnv {
  return {
    createContainer: () => createRequestContainer(),
    findOne: (em, entity, where, options, scope) =>
      findOneWithDecryption(em as EntityManager, entity as never, where as never, options as never, scope),
    findMany: (em, entity, where, options, scope) =>
      findWithDecryption(em as EntityManager, entity as never, where as never, options as never, scope),
    setCustomFields: (dataEngine, args) => setCustomFieldsIfAny({ dataEngine: dataEngine as DataEngine, ...args }),
    createSnapshotStore: (em) => createInventorySnapshotStore(em as EntityManager),
    entities: {
      product: CatalogProduct,
      variant: CatalogProductVariant,
      price: CatalogProductPrice,
      priceKind: CatalogPriceKind,
      category: CatalogProductCategory,
      categoryAssignment: CatalogProductCategoryAssignment,
      customerEntity: CustomerEntity,
      customerAddress: CustomerAddress,
      syncMapping: SyncExternalIdMapping,
    },
  }
}

export function register(container: AppContainer) {
  container.register({
    [HEALTH_CHECK_SERVICE]: asValue(shopifyHealthCheck),
  })

  const env = buildRuntimeEnv()

  // Each adapter's `providerKey` must equal the `providerKey` its IntegrationDefinition declares in
  // `integration.ts` (both draw from `PROVIDER_KEY.*`), or `getDataSyncAdapter` cannot find it.
  registerDataSyncAdapter(
    createShopifyProductsAdapter({
      createClient: createShopifyClientFromCredentials,
      createRuntime: (input) => createProductsRuntime(env, input),
    }),
  )

  registerDataSyncAdapter(
    createShopifyCollectionsAdapter({
      createClient: createShopifyClientFromCredentials,
      createRunContext: (input) => createCollectionsRunContext(env, input),
    }),
  )

  registerDataSyncAdapter(
    createCustomersAdapter({
      // Customers' runtime builds its own client — the adapter carries no separate `createClient`.
      createRuntime: (input) => createCustomersRuntime(env, input),
    }),
  )

  const inventory = createInventoryPorts(env)
  registerDataSyncAdapter(
    createShopifyInventoryAdapter({
      createClient: createShopifyClientFromCredentials,
      store: inventory.store,
      externalIdMapping: inventory.externalIdMapping,
      writeCustomFields: inventory.writeCustomFields,
    }),
  )
}

export default register
