/**
 * Centralised identifiers.
 *
 * Open Mercato uses THREE different entity-id dialects, and crossing them fails SILENTLY with a
 * wrong lookup rather than an error. Every one of them is declared here exactly once; never
 * inline these strings at a call site.
 *
 *   COLON      `catalog:catalog_product`     → setCustomFieldsIfAny, query-index events,
 *                                               CustomFieldDef.entityId, refreshCoverageEntityTypes
 *   BARE SNAKE `catalog_product`             → SyncExternalIdMapping.internalEntityType
 *   DOT        `catalog.products.create`     → CommandBus command ids
 *
 * A fourth, unrelated namespace is the data_sync `entityType` — adapter-defined, validated
 * against nothing. We choose `shopify.*` so runs are self-describing in the admin UI.
 */

// ── data_sync entityType (adapter-defined; appears on SyncRun/SyncCursor rows) ──────────────
export const ENTITY_TYPE = {
  product: 'shopify.product',
  collection: 'shopify.collection',
  customer: 'shopify.customer',
  order: 'shopify.order',
} as const

export type ShopifyEntityType = (typeof ENTITY_TYPE)[keyof typeof ENTITY_TYPE]

// ── COLON dialect: custom fields, query-index events, coverage refresh ──────────────────────
export const OM_ENTITY_ID = {
  product: 'catalog:catalog_product',
  productVariant: 'catalog:catalog_product_variant',
  productCategory: 'catalog:catalog_product_category',
  customerEntity: 'customers:customer_entity',
  salesOrder: 'sales:sales_order',
} as const

// ── BARE SNAKE dialect: SyncExternalIdMapping.internalEntityType ────────────────────────────
export const MAPPING_ENTITY_TYPE = {
  product: 'catalog_product',
  productVariant: 'catalog_product_variant',
  productPrice: 'catalog_product_price',
  productOffer: 'catalog_product_offer',
  productCategory: 'catalog_product_category',
  customerEntity: 'customer_entity',
  salesOrder: 'sales_order',
} as const

// ── DOT dialect: CommandBus command ids ─────────────────────────────────────────────────────
export const COMMAND = {
  productCreate: 'catalog.products.create',
  productUpdate: 'catalog.products.update',
  variantCreate: 'catalog.variants.create',
  variantUpdate: 'catalog.variants.update',
  priceCreate: 'catalog.prices.create',
  priceUpdate: 'catalog.prices.update',
  priceDelete: 'catalog.prices.delete',
  offerCreate: 'catalog.offers.create',
  offerUpdate: 'catalog.offers.update',
  offerDelete: 'catalog.offers.delete',
  categoryCreate: 'catalog.categories.create',
  categoryUpdate: 'catalog.categories.update',
} as const

// ── Integration + provider identity ─────────────────────────────────────────────────────────
// `providerKey` is the join to the sync engine: it resolves an adapter via
// `getIntegration(integrationId)?.providerKey ?? integrationId`, so each IntegrationDefinition's
// providerKey MUST equal its adapter's providerKey.
export const BUNDLE_ID = 'sync_shopify'

export const INTEGRATION_ID = {
  products: 'sync_shopify_products',
  collections: 'sync_shopify_collections',
  customers: 'sync_shopify_customers',
  orders: 'sync_shopify_orders',
} as const

export const PROVIDER_KEY = {
  products: 'shopify_products',
  collections: 'shopify_collections',
  customers: 'shopify_customers',
  orders: 'shopify_orders',
} as const

// The DI name our health-check service registers under. `integration.healthCheck.service` must
// match it exactly — the health service resolves it by name from the container.
export const HEALTH_CHECK_SERVICE = 'shopifyHealthCheck'

// ── Shopify API ─────────────────────────────────────────────────────────────────────────────
/**
 * Pinned Admin API version. 2026-07 is current stable (released 2026-07-01, accessible until
 * 2027-07-16).
 *
 * Do NOT pin backwards to "play safe": collections using the 2026-07 multi-source model are
 * SILENTLY FILTERED OUT of pre-2026-07 query results, so an older pin loses data without error.
 */
export const DEFAULT_API_VERSION = '2026-07'

export const SUPPORTED_API_VERSIONS = ['2026-07', '2026-04', '2026-01'] as const

/** Read scopes required by the entities we sync. `read_products` also covers Collections. */
export const REQUIRED_SCOPES = ['read_products', 'read_customers', 'read_orders'] as const
