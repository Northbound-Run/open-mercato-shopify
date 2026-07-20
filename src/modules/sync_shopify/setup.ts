import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { applyShopifyEnvPreset } from './lib/preset'

/**
 * Module setup hooks, discovered by `yarn generate`.
 *
 * `defaultRoleFeatures` is not optional in practice: features declared in `acl.ts` exist but are
 * assigned to nobody until they are listed here, so the module would install and then be
 * invisible to every role including admin.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['sync_shopify.view', 'sync_shopify.configure', 'sync_shopify.run'],
    admin: ['sync_shopify.view', 'sync_shopify.configure', 'sync_shopify.run'],
    // Employees can watch and re-run a sync, but not re-point it at another store or touch
    // credentials.
    employee: ['sync_shopify.view', 'sync_shopify.run'],
  },

  /**
   * Seeds credentials from environment variables for single-store deployments.
   *
   * Deliberately swallows its own failures: a misconfigured optional preset must never abort
   * tenant creation. This mirrors sync-akeneo's `seedDefaults`, which logs a warning through the
   * integration log rather than throwing.
   */
  async seedDefaults(ctx) {
    try {
      await applyShopifyEnvPreset({
        container: ctx.container,
        scope: { organizationId: ctx.organizationId, tenantId: ctx.tenantId },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // eslint-disable-next-line no-console
      console.warn(`[sync_shopify] env preset skipped: ${message}`)
    }
  },
}

export default setup
