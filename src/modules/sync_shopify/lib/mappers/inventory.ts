/**
 * Shopify variant node → dated inventory snapshot rows.
 *
 * Pure: no network, no ORM, no clock, no framework. The adapter hands in the instant and the
 * store's timezone; everything else is a function of the node. That is what makes the rules below
 * unit-testable, and every one of them exists because getting it wrong produces a *confident wrong
 * number* rather than an error.
 *
 * Three rules carry the weight:
 *
 *  1. **A missing `available` is never 0.** `quantities(names:)` returns only the names Shopify
 *     actually has for that level, so an absent `available` means *unobserved*, not *sold out*.
 *     Writing it as 0 records a stockout that did not happen, and an invented stockout inflates
 *     `oos_ratio`, which inflates the purchase order this whole feature exists to get right. Such a
 *     level is skipped and reported, never coerced. (`available: 0` present on the wire is a real
 *     observation and is kept — the test is presence, not truthiness.)
 *  2. **Gift cards are excluded structurally, not by title.** `isGiftCard` and `requiresShipping`,
 *     via `isPhysicalInventory`. The prototype matched titles against `"gift card" | "e-gift" |
 *     "barcode"`, which fails silently on a German store's *Geschenkkarte* and equally on any brand
 *     whose product names contain those words (§12.6).
 *  3. **One row per location.** `variant.inventoryQuantity` — which the prototype used — collapses
 *     every location into one number and makes the `(date, variant, location)` key meaningless. A
 *     variant stocked at two locations is two rows.
 *
 * The wire types below are all-optional on purpose. They describe what a *response* may contain,
 * not what the schema promises: a field the query asked for can still arrive null, and a nullable
 * field read as non-null is how a phantom zero gets in.
 */

import { isPhysicalInventory, snapshotDateFor } from '../inventory-history'

// ── The wire shape ──────────────────────────────────────────────────────────────────────────────

export type ShopifyQuantityNode = {
  name?: string | null
  quantity?: number | null
}

export type ShopifyInventoryLevelNode = {
  location?: { id?: string | null; name?: string | null } | null
  quantities?: readonly (ShopifyQuantityNode | null)[] | null
}

/**
 * `inventoryLevels` in either transport form.
 *
 * The paged query returns `edges { node }`; the bulk path reassembles children into a flat array,
 * which the adapter passes as `nodes`. Accepting both keeps one mapper for two fetch strategies.
 */
export type ShopifyInventoryLevelConnection = {
  edges?: readonly ({ node?: ShopifyInventoryLevelNode | null } | null)[] | null
  nodes?: readonly (ShopifyInventoryLevelNode | null)[] | null
  pageInfo?: { hasNextPage?: boolean | null } | null
}

export type ShopifyInventoryItemNode = {
  /** Money as a string all the way through — never round-tripped via float. */
  unitCost?: { amount?: string | null } | null
  requiresShipping?: boolean | null
  inventoryLevels?: ShopifyInventoryLevelConnection | null
}

export type ShopifyProductNode = {
  title?: string | null
  /** `ProductStatus`: ACTIVE | ARCHIVED | DRAFT. */
  status?: string | null
  productType?: string | null
  isGiftCard?: boolean | null
}

export type ShopifyVariantNode = {
  id?: string | null
  sku?: string | null
  product?: ShopifyProductNode | null
  inventoryItem?: ShopifyInventoryItemNode | null
}

/**
 * Quantity names requested from `quantities(names:)`.
 *
 * Shopify rejects an unrecognised name outright, so these are pinned here and used both to build
 * the query and to read the response — a typo then breaks in one place rather than silently
 * yielding "no such quantity", which reads exactly like an unobserved level.
 */
export const QUANTITY_NAME = {
  available: 'available',
  onHand: 'on_hand',
  committed: 'committed',
  incoming: 'incoming',
} as const

export const REQUESTED_QUANTITY_NAMES = [
  QUANTITY_NAME.available,
  QUANTITY_NAME.onHand,
  QUANTITY_NAME.committed,
  QUANTITY_NAME.incoming,
] as const

// ── What the mapper produces ────────────────────────────────────────────────────────────────────

/** One `sync_shopify_inventory_snapshots` row, before scoping and persistence. */
export type InventorySnapshotDraft = {
  snapshotDate: string
  capturedAt: Date
  variantExternal: string
  sku: string | null
  productType: string | null
  /**
   * `ProductStatus` verbatim — ACTIVE, ARCHIVED or DRAFT — recorded because inactive products are
   * snapshotted by default (see `includeInactiveProducts`). A demand-planning consumer wanting only
   * live SKUs filters on this; without it, "archived" and "live" are indistinguishable in history,
   * and there is no backfill to add the distinction later.
   */
  productStatus: string | null
  locationId: string
  onHand: number
  available: number
  committed: number | null
  incoming: number | null
  outOfStock: boolean
  isPhysical: boolean
}

/**
 * Why a level produced no row.
 *
 * Reported rather than dropped. A snapshot run that quietly writes fewer rows than yesterday still
 * reports success, and the shortfall shows up months later as a wrong purchase order.
 */
export type InventorySkipReason =
  | 'not_physical'
  | 'product_not_active'
  | 'unobserved_available'
  | 'unidentified_location'

export type InventoryMapSkip = {
  variantExternal: string
  /** Null when the level itself could not be identified, or when the skip is variant-wide. */
  locationId: string | null
  reason: InventorySkipReason
}

export type MappedVariantInventory = {
  variantExternal: string
  /** From `isGiftCard` / `requiresShipping`. Drives whether any row is produced at all. */
  isPhysical: boolean
  rows: InventorySnapshotDraft[]
  skipped: InventoryMapSkip[]
  /**
   * `inventoryItem.unitCost.amount`, verbatim. Null when Shopify has none — and null must stay
   * null on the way to a custom field, because a per-key null blanks the stored value.
   */
  unitCost: string | null
  /** `inventoryLevels` had more pages: this variant stocks more locations than the query asked for. */
  locationsTruncated: boolean
}

export type MapInventoryOptions = {
  /** When the snapshot was taken. */
  capturedAt: Date
  /**
   * From `shop { ianaTimezone }`, fetched once per run. Never a constant and never the worker's
   * own zone: day boundaries define row identity, so a wrong zone mis-buckets history permanently.
   */
  ianaTimezone: string
  /**
   * Snapshot variants whose product is ARCHIVED or DRAFT. **On by default.**
   *
   * History cannot be backfilled, so excluding them is lossy in a way nothing can repair: a fashion
   * brand that archives stock off-season and restores it in season would lose the archived stretch,
   * and the restored variant then has no usable ratio until it re-accrues past the thresholds. The
   * cost of including them is only table size, and `productStatus` on every row lets a consumer
   * filter them back out at read time.
   *
   * Set `false` to exclude — the escape hatch for a store with a very large archived tail that does
   * not restore products. (This supersedes §12.10's "active physical variant" wording.)
   */
  includeInactiveProducts?: boolean
}

// ── Reading the wire defensively ────────────────────────────────────────────────────────────────

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Levels from either transport form, in one array. */
export function readInventoryLevels(
  connection: ShopifyInventoryLevelConnection | null | undefined,
): ShopifyInventoryLevelNode[] {
  if (!connection) return []
  if (Array.isArray(connection.nodes)) {
    return connection.nodes.filter((node): node is ShopifyInventoryLevelNode => !!node)
  }
  if (Array.isArray(connection.edges)) {
    return connection.edges
      .map((edge) => edge?.node)
      .filter((node): node is ShopifyInventoryLevelNode => !!node)
  }
  return []
}

/**
 * One named quantity, or **null when it was not observed**.
 *
 * `null` and `0` are different answers and the distinction is the whole point: `0` is "we looked
 * and there were none", `null` is "we did not see this number". Only `0` may become a stockout.
 * `Number.isFinite` rather than a truthiness check is what preserves that — a `0` is falsy and
 * would otherwise collapse into the unobserved branch, turning a real stockout into a dropped row.
 */
export function readQuantity(
  quantities: readonly (ShopifyQuantityNode | null)[] | null | undefined,
  name: string,
): number | null {
  if (!Array.isArray(quantities)) return null
  for (const entry of quantities) {
    if (!entry || entry.name !== name) continue
    const quantity = entry.quantity
    return typeof quantity === 'number' && Number.isFinite(quantity) ? quantity : null
  }
  return null
}

/**
 * Is this variant's product live?
 *
 * Consulted only when a caller opts out of inactive products; the default snapshots them and
 * records the status instead. An absent status resolves to active, matching `isPhysicalInventory`'s
 * asymmetry: wrongly including a variant dilutes an aggregate, wrongly excluding one drops it from
 * history with no way to recover it.
 *
 * Filtered here rather than with a `productVariants(query: "product_status:active")` search
 * argument on purpose — an invalid search field is *ignored* by Shopify and silently returns
 * everything (R-13), so a filter that looks like it works is worse than one done client-side.
 */
export function isActiveProduct(product: ShopifyProductNode | null | undefined): boolean {
  const status = trimmed(product?.status)
  return status === null || status.toUpperCase() === 'ACTIVE'
}

// ── The mapping ─────────────────────────────────────────────────────────────────────────────────

/**
 * Map one variant node to its per-location snapshot rows.
 *
 * Returns `null` only when the node carries no variant GID — there is then no key to record it
 * under, and inventing one would poison the unique key that makes a snapshot day idempotent.
 */
export function mapVariantInventory(
  node: ShopifyVariantNode,
  options: MapInventoryOptions,
): MappedVariantInventory | null {
  const variantExternal = trimmed(node.id)
  if (!variantExternal) return null

  const product = node.product ?? null
  const inventoryItem = node.inventoryItem ?? null
  const unitCost = trimmed(inventoryItem?.unitCost?.amount)
  const levels = readInventoryLevels(inventoryItem?.inventoryLevels)
  const locationsTruncated = inventoryItem?.inventoryLevels?.pageInfo?.hasNextPage === true

  const isPhysical = isPhysicalInventory({
    isGiftCard: product?.isGiftCard,
    requiresShipping: inventoryItem?.requiresShipping,
  })

  const withoutRows = (reason: InventorySkipReason): MappedVariantInventory => ({
    variantExternal,
    isPhysical,
    rows: [],
    skipped: [{ variantExternal, locationId: null, reason }],
    unitCost,
    locationsTruncated,
  })

  // Gift cards and digital goods are excluded from snapshots and from every OOS metric (§12.10).
  // `unitCost` still travels back: what a variant costs is a catalog fact, independent of whether
  // its stock is worth tracking over time.
  if (!isPhysical) return withoutRows('not_physical')
  if (options.includeInactiveProducts === false && !isActiveProduct(product)) {
    return withoutRows('product_not_active')
  }

  const snapshotDate = snapshotDateFor(options.capturedAt, options.ianaTimezone)
  const sku = trimmed(node.sku)
  const productType = trimmed(product?.productType)
  const productStatus = trimmed(product?.status)

  const rows: InventorySnapshotDraft[] = []
  const skipped: InventoryMapSkip[] = []

  for (const level of levels) {
    const locationId = trimmed(level.location?.id)
    if (!locationId) {
      // `location_id` is part of the unique key, so a level without one cannot be stored without
      // colliding with every other unidentified level for this variant on this day.
      skipped.push({ variantExternal, locationId: null, reason: 'unidentified_location' })
      continue
    }

    const available = readQuantity(level.quantities, QUANTITY_NAME.available)
    if (available === null) {
      skipped.push({ variantExternal, locationId, reason: 'unobserved_available' })
      continue
    }

    const onHand = readQuantity(level.quantities, QUANTITY_NAME.onHand)

    rows.push({
      snapshotDate,
      capturedAt: options.capturedAt,
      variantExternal,
      sku,
      productType,
      productStatus,
      locationId,
      // `on_hand` is NOT NULL on the entity but reporting-only — it never feeds `outOfStock` or
      // the ratio. Falling back to the observed `available` therefore cannot corrupt the derived
      // signal, whereas dropping the row would lose a real availability observation for good.
      // This is deliberately NOT the treatment `available` gets, and the asymmetry is the point.
      onHand: onHand ?? available,
      available,
      committed: readQuantity(level.quantities, QUANTITY_NAME.committed),
      incoming: readQuantity(level.quantities, QUANTITY_NAME.incoming),
      outOfStock: available <= 0,
      isPhysical: true,
    })
  }

  return { variantExternal, isPhysical, rows, skipped, unitCost, locationsTruncated }
}
