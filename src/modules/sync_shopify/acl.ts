// Feature ids follow the framework convention `<moduleId>.<verb>` and are granted through
// setup.ts `defaultRoleFeatures`. Routes gate on these via `requireFeatures` — never on
// `requireRoles`, which is deprecated (role names are mutable and spoofable).
// After changing this file the host app must run `yarn mercato auth sync-role-acls`.

export type AclFeature = {
  id: string
  title: string
  module: string
  dependsOn?: string[]
}

export const features: AclFeature[] = [
  {
    id: 'sync_shopify.view',
    title: 'View Shopify sync configuration and run history',
    module: 'sync_shopify',
  },
  {
    id: 'sync_shopify.configure',
    title: 'Connect a Shopify store and edit sync configuration',
    module: 'sync_shopify',
    dependsOn: ['sync_shopify.view'],
  },
  {
    id: 'sync_shopify.run',
    title: 'Trigger Shopify sync runs',
    module: 'sync_shopify',
    dependsOn: ['sync_shopify.view'],
  },
]

export default features
