import { createModuleEvents } from '@open-mercato/shared/modules/events/factory'

// The `as const` is required: createModuleEvents infers the event-id union from it, and an
// undeclared id becomes both a type error and a runtime warning.
const events = [
  {
    id: 'sync_shopify.connection.established',
    label: 'Shopify Connection Established',
    description: 'An OAuth authorization completed and an access token was stored.',
    category: 'lifecycle',
    entity: 'connection',
  },
  {
    id: 'sync_shopify.connection.revoked',
    label: 'Shopify Connection Revoked',
    description: 'The stored access token was rejected by Shopify and re-authorization is required.',
    category: 'lifecycle',
    entity: 'connection',
  },
  {
    id: 'sync_shopify.reconcile.completed',
    label: 'Shopify Reconciliation Completed',
    description: 'A full sync finished reconciling and soft-deleted records absent upstream.',
    category: 'system',
    entity: 'reconcile',
  },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'sync_shopify', events })
export const emitSyncShopifyEvent = eventsConfig.emit
export type SyncShopifyEventId = (typeof events)[number]['id']

export default eventsConfig
