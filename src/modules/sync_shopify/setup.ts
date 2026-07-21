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
   * Seeds credentials — and, when the deployment opts in, enables and schedules the syncs — from
   * environment variables for single-store deployments. See `lib/preset.ts` for the env keys and the
   * non-destructive semantics.
   *
   * Deliberately swallows its own failures: a misconfigured optional preset must never abort
   * tenant creation. This mirrors sync-akeneo's `seedDefaults`, which logs a warning through the
   * integration log rather than throwing.
   */
  async seedDefaults(ctx) {
    try {
      const result = await applyShopifyEnvPreset({
        container: ctx.container,
        scope: { organizationId: ctx.organizationId, tenantId: ctx.tenantId },
      })

      const changes: string[] = []
      if (result.credentials === 'applied') changes.push('credentials')
      if (result.enabled.length) changes.push(`enabled ${result.enabled.join('/')}`)
      if (result.scheduled.length) changes.push(`scheduled ${result.scheduled.join('/')}`)
      if (changes.length) {
        // eslint-disable-next-line no-console
        console.log(`[sync_shopify] env preset applied: ${changes.join('; ')}`)
      }

      // Surface silent no-ops that an operator almost certainly did not intend.
      if (result.unknownEntities.length) {
        // eslint-disable-next-line no-console
        console.warn(
          `[sync_shopify] ignored unknown ${'OM_INTEGRATION_SHOPIFY_ENABLE_ENTITIES'} value(s): ${result.unknownEntities.join(', ')}`,
        )
      }
      if (result.cronRejected.length) {
        // eslint-disable-next-line no-console
        console.warn(
          `[sync_shopify] ignored malformed sync cron value(s): ${result.cronRejected
            .map((cron) => `"${cron}"`)
            .join(', ')}`,
        )
      }
      if (result.schedulerUnavailable) {
        // eslint-disable-next-line no-console
        console.warn(
          '[sync_shopify] OM_INTEGRATION_SHOPIFY_SYNC_CRON set but the scheduler module is not installed — no schedules were created.',
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // eslint-disable-next-line no-console
      console.warn(`[sync_shopify] env preset skipped: ${message}`)
    }
  },
}

export default setup
