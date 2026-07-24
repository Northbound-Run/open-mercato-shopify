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
  inventoryLevel: 'shopify.inventory_level',
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
  // Addresses are mapped in their own right, not folded into the customer: they are reconciled
  // per customer (Shopify sends the whole set, so a deleted one is simply absent), and deletion is
  // ownership-gated on this mapping existing.
  customerAddress: 'customer_address',
  salesOrder: 'sales_order',
  salesOrderLine: 'sales_order_line',
  salesPayment: 'sales_payment',
  salesShipment: 'sales_shipment',
} as const

// ── DOT dialect: CommandBus command ids ─────────────────────────────────────────────────────
// All verified present in @open-mercato/core 0.6.6 by reading the registerCommand definitions.
export const COMMAND = {
  productCreate: 'catalog.products.create',
  productUpdate: 'catalog.products.update',
  productDelete: 'catalog.products.delete',
  variantCreate: 'catalog.variants.create',
  variantUpdate: 'catalog.variants.update',
  variantDelete: 'catalog.variants.delete',
  priceCreate: 'catalog.prices.create',
  priceUpdate: 'catalog.prices.update',
  priceDelete: 'catalog.prices.delete',
  offerCreate: 'catalog.offers.create',
  offerUpdate: 'catalog.offers.update',
  offerDelete: 'catalog.offers.delete',
  categoryCreate: 'catalog.categories.create',
  categoryUpdate: 'catalog.categories.update',
  categoryDelete: 'catalog.categories.delete',
  personCreate: 'customers.people.create',
  personUpdate: 'customers.people.update',
  personDelete: 'customers.people.delete',
  addressCreate: 'customers.addresses.create',
  addressUpdate: 'customers.addresses.update',
  addressDelete: 'customers.addresses.delete',
  orderCreate: 'sales.orders.create',
  orderUpdate: 'sales.orders.update',
  orderDelete: 'sales.orders.delete',
  orderLineUpsert: 'sales.orders.lines.upsert',
  orderLineDelete: 'sales.orders.lines.delete',
  orderAdjustmentUpsert: 'sales.orders.adjustments.upsert',
  orderAdjustmentDelete: 'sales.orders.adjustments.delete',
  paymentCreate: 'sales.payments.create',
  paymentUpdate: 'sales.payments.update',
  paymentDelete: 'sales.payments.delete',
  shipmentCreate: 'sales.shipments.create',
  shipmentUpdate: 'sales.shipments.update',
} as const

/**
 * The key each command returns its id under. **These are NOT uniform**, and the odd one out is
 * genuinely surprising: `customers.people.*` returns `entityId`, not `personId` — because the row
 * it creates is a `CustomerEntity`, with the person profile hanging off it.
 *
 * Reading the wrong key yields `undefined`, which then gets stored as an external-id mapping to
 * nothing. Pass the right key to the writer's `resultKey` rather than guessing from the noun.
 *
 * Verified against the `CommandHandler<Input, Result>` generics in core 0.6.6.
 */
export const COMMAND_RESULT_KEY = {
  product: 'productId',
  variant: 'variantId',
  price: 'priceId',
  offer: 'offerId',
  category: 'categoryId',
  person: 'entityId',
  address: 'addressId',
  order: 'orderId',
  // sales.orders.lines.upsert returns { orderId, lineId } — the line's own id is `lineId`.
  orderLine: 'lineId',
  // sales.payments.create returns { paymentId, orderTotals?, ... } — read `paymentId`.
  payment: 'paymentId',
  shipment: 'shipmentId',
} as const

// ── Integration + provider identity ─────────────────────────────────────────────────────────
// `providerKey` is the join to the sync engine: it resolves an adapter via
// `getIntegration(integrationId)?.providerKey ?? integrationId`, so each IntegrationDefinition's
// providerKey MUST equal its adapter's providerKey.
export const INTEGRATION_ID = {
  products: 'sync_shopify_products',
  collections: 'sync_shopify_collections',
  customers: 'sync_shopify_customers',
  orders: 'sync_shopify_orders',
  inventory: 'sync_shopify_inventory',
} as const

// The bundle is the shared Shopify connection — one set of credentials for all five integrations.
// Its id MUST equal a real integration id: the framework's bundle-config page and its shared-credential
// resolution both go through `getIntegration(bundleId)`, which returns nothing for a standalone bundle
// id (that is the "Integration not found" 404). So the bundle is anchored to the primary Products
// integration — Products owns the connection credentials directly and the other four inherit them via
// `bundleId` fall-through. (Changed from the standalone 'sync_shopify' in 0.2.1; this re-keys the
// stored credential row, so re-run `configure-from-env` after upgrading.)
export const BUNDLE_ID = INTEGRATION_ID.products

export const PROVIDER_KEY = {
  products: 'shopify_products',
  collections: 'shopify_collections',
  customers: 'shopify_customers',
  orders: 'shopify_orders',
  inventory: 'shopify_inventory',
} as const

// ── Inventory history (the one module-owned table — see plan §12) ────────────────────────────
export const INVENTORY_TABLE = 'sync_shopify_inventory_snapshots'

/**
 * Minimum evidence before an out-of-stock ratio may be reported.
 *
 * History cannot be backfilled — it accrues only forward — so a fresh install has no valid ratio
 * for months while still looking authoritative. Missed runs shrink the denominator the same way.
 * Below these thresholds `oosRatio` returns null and NO custom field is written (writing 0 would
 * read as "never out of stock"). This number feeds purchase-order quantities.
 */
export const OOS_MIN_OBSERVED_DAYS = 14
export const OOS_MIN_WINDOW_COVERAGE = 0.5

/** Default window for the rolling custom field. */
export const OOS_DEFAULT_WINDOW_DAYS = 90

/**
 * Custom fields written back onto `OM_ENTITY_ID.productVariant`.
 *
 * The `90d` suffix is pinned to `OOS_DEFAULT_WINDOW_DAYS` directly above; changing that constant
 * without renaming these leaves the field names lying about their own window.
 *
 * These live here, and not beside the write in `adapters/inventory.ts`, because `ce.ts` declares
 * the matching definitions from the same source and must stay importable by the host app's module
 * generator — a leaf with no Shopify-client or bulk-export dependencies. Adding a key here without
 * adding a definition in `ce.ts` makes the write a silent no-op; `ce.test.ts` fails if they drift.
 */
export const INVENTORY_CUSTOM_FIELD = {
  unitCost: 'unit_cost',
  oosRatio: 'oos_ratio_90d',
  daysOutOfStock: 'days_out_of_stock_90d',
  // Current-state on-hand and available, written on the same pass as the snapshot. These exist so a
  // downstream consumer (e.g. a purchasing / PO-drafting module) reads current stock off a stable
  // `cf:` seam on the native variant, and never has to reach into this connector's private snapshot
  // table. Aggregated across the variant's locations — see `writeBackCustomFields`.
  onHand: 'on_hand',
  available: 'available',
} as const

/** Retention: keep daily rows this long (covers year-over-year), then roll up to monthly. */
export const INVENTORY_DAILY_RETENTION_DAYS = 396

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
