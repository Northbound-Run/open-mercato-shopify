/**
 * The one table this connector owns.
 *
 * Everything else in the package writes through the CommandBus into native Open Mercato entities
 * and ships zero migrations — the property inherited from `sync-akeneo`. This is the single,
 * argued exception (plan §12.2): demand planning must correct a SKU's trailing sales for the
 * periods it was **out of stock**, and that correction needs inventory *over time*. Custom fields
 * are overwritten on every sync, so they cannot hold a time series, and core has no
 * inventory-history domain to write into.
 *
 * The shape is deliberately **Shopify-agnostic** — nothing here is named after Shopify except the
 * external id — so it can graduate into a core `inventory_history` domain later instead of
 * becoming a Shopify silo. Do not generalise the exception; do not add a second table.
 *
 * Two conventions this file follows and one it deliberately breaks:
 *   - `organization_id` / `tenant_id` are plain columns on every row, never a cross-module ORM
 *     relation (core forbids those), and every read must scope on both.
 *   - `[OptionalProps]` lists every defaulted or nullable property; MikroORM v7 needs it for
 *     `em.create()` to typecheck.
 *   - **No `deleted_at`.** Retention (§12.9) hard-deletes, and a soft-deleted row would still be
 *     counted in `days_observed` by any reader that forgot to filter it — which is exactly the
 *     silently-confident-wrong-number failure this table exists to prevent.
 */

import { OptionalProps } from '@mikro-orm/core'
import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'
import { INVENTORY_TABLE } from '../lib/constants'

/** Names are pinned so hand-written migration SQL and entity metadata agree and `db:generate` sees no drift. */
const DAY_UNIQUE = 'sync_shopify_inventory_snapshots_day_key'
const LOOKUP_INDEX = 'sync_shopify_inventory_snapshots_lookup_idx'

@Entity({ tableName: INVENTORY_TABLE })
// Makes a snapshot day idempotent: re-running a day upserts, it never duplicates. `location_id` is
// part of the key because a variant stocked at two locations is two rows, not one — the prototype
// keyed on `(date, variant)` and could not represent the multi-location case it aimed at (§12.6).
@Unique({ name: DAY_UNIQUE, properties: ['snapshotDate', 'variantExternal', 'locationId', 'organizationId', 'tenantId'] })
// The exact shape of the `oosRatio` lookup: scope first, then variant, then the date range scan.
@Index({ name: LOOKUP_INDEX, properties: ['organizationId', 'tenantId', 'variantExternal', 'snapshotDate'] })
export class ShopifyInventorySnapshot {
  [OptionalProps]?:
    | 'variantId'
    | 'sku'
    | 'productType'
    | 'productStatus'
    | 'committed'
    | 'incoming'
    | 'createdAt'
    | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  /**
   * Store-timezone calendar day, `YYYY-MM-DD`. Text, not date, because it is an identity — the day
   * a human in the store's timezone would name — not an instant. Derived via `snapshotDateFor()`
   * from `shop { ianaTimezone }`; a wrong zone silently mis-buckets every row it writes.
   */
  @Property({ name: 'snapshot_date', type: 'text' })
  snapshotDate!: string

  /** When the snapshot was actually taken, for diagnosing a run that drifted across a day boundary. */
  @Property({ name: 'captured_at', type: Date })
  capturedAt!: Date

  /**
   * Local `CatalogProductVariant` id, resolved via `externalIdMappingService`.
   *
   * Nullable on purpose: the snapshot must still be written when the catalog mapping lags behind
   * (a variant created upstream since the last products run). History cannot be backfilled, so a
   * skipped day is permanently lost — recording the row without the local id is strictly better.
   */
  @Property({ name: 'variant_id', type: 'uuid', nullable: true })
  variantId?: string | null

  /** Shopify variant GID. The durable key: it survives a lagging or re-pointed local mapping. */
  @Property({ name: 'variant_external', type: 'text' })
  variantExternal!: string

  @Property({ name: 'sku', type: 'text', nullable: true })
  sku?: string | null

  /** Kept for reporting only — never for the physical/non-physical decision. See `isPhysical`. */
  @Property({ name: 'product_type', type: 'text', nullable: true })
  productType?: string | null

  /**
   * Shopify `ProductStatus` verbatim — ACTIVE, ARCHIVED or DRAFT.
   *
   * Inactive products ARE snapshotted (plan §12.10): excluding them would leave an unfillable hole,
   * and archiving stock off-season then restoring it is routine in this domain, which would cost
   * 14+ days of unusable out-of-stock ratio after every restore. Recording the status is what keeps
   * that inclusive capture honest — without it, "archived" and "live" are indistinguishable in
   * history and a demand-planning consumer cannot filter to sellable SKUs.
   */
  @Property({ name: 'product_status', type: 'text', nullable: true })
  productStatus?: string | null

  /** Shopify Location GID. Multi-location-ready from day one, not retrofitted. */
  @Property({ name: 'location_id', type: 'text' })
  locationId!: string

  @Property({ name: 'on_hand', type: 'int' })
  onHand!: number

  /**
   * The quantity that actually drives `outOfStock`. Writers must never substitute 0 for a missing
   * `available` — that records a stockout that did not happen, and an invented stockout inflates
   * the OOS ratio, which inflates the purchase order.
   */
  @Property({ name: 'available', type: 'int' })
  available!: number

  @Property({ name: 'committed', type: 'int', nullable: true })
  committed?: number | null

  @Property({ name: 'incoming', type: 'int', nullable: true })
  incoming?: number | null

  /** `available <= 0`. Stored rather than derived so the definition cannot drift between readers. */
  @Property({ name: 'out_of_stock', type: 'boolean' })
  outOfStock!: boolean

  /**
   * Whether this row is real physical stock, from `isGiftCard` / `requiresShipping` — the
   * structured signals. Never from title string-matching, which breaks silently on any
   * non-English store (§12.6).
   */
  @Property({ name: 'is_physical', type: 'boolean' })
  isPhysical!: boolean

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
