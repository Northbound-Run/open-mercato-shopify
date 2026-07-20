import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { HEALTH_CHECK_SERVICE } from './lib/constants'
import { shopifyHealthCheck } from './lib/health'

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
 */
export function register(container: AppContainer) {
  container.register({
    [HEALTH_CHECK_SERVICE]: asValue(shopifyHealthCheck),
  })

  // Data sync adapters register here as they land, via:
  //   registerDataSyncAdapter(shopifyProductsAdapter)
}

export default register
