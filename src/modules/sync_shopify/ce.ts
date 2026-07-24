/**
 * Custom-field definitions this module contributes to the host app.
 *
 * WHY THIS FILE EXISTS. The inventory adapter writes `unit_cost`, `on_hand`, `available`,
 * `oos_ratio_90d` and `days_out_of_stock_90d` onto the native product variant on every run. A write
 * to an **undeclared** key is a silent no-op: `setRecordCustomFields` resolves the storage column
 * from the field definition, and with no definition there is nothing to resolve — the value never
 * lands and nothing appears on the product page. Declaring them here is what makes the
 * already-correct write visible.
 *
 * The failure this repairs is invisible from run telemetry by design: a failed write-back is an
 * `InventoryAnomaly` (`write_back_failed`), deliberately NOT a failed item, so a store with no
 * definitions reported every run as fully successful while persisting none of these five values.
 *
 * WHY IT ATTACHES TO ANOTHER MODULE'S ENTITY. `catalog:catalog_product_variant` is a system entity
 * owned by `@open-mercato/core`. `installCustomEntitiesFromModules` aggregates field sets from
 * every module by entity id, and skips entity *registration* for system ids — so a third-party
 * module may contribute fields to a core entity without owning, shadowing or migrating it. Only
 * the five keys below are touched; catalog's own fields are merged, not replaced.
 *
 * These are installed per tenant when the host runs its entity install (module setup, or
 * `yarn mercato entities install-from-ce`), not by this module's sync runs.
 */

import type { CustomEntitySpec } from '@open-mercato/shared/modules/entities'
import { INVENTORY_CUSTOM_FIELD, OM_ENTITY_ID, OOS_DEFAULT_WINDOW_DAYS } from './lib/constants'

/**
 * Written as plain literals rather than the `cf.*` DSL helpers on purpose. `cf` is a *runtime*
 * export of `@open-mercato/shared`, and this repo's jest config (see its header comment) rests on
 * tested modules importing framework code as `import type` only — a runtime import resolves to
 * shared's ESM `dist` and dies as `SyntaxError: Unexpected token 'export'` under ts-jest's CJS
 * transform. `cf.integer(k, o)` is exactly `{ key: k, kind: 'integer', ...o }`, so nothing is lost
 * but the sugar, and the file stays a pure data leaf the host generator can import anywhere.
 *
 * Every field is `formEditable: false`. The sync owns these values and overwrites them on the next
 * run, so an editable form control would offer the operator an edit that silently reverts.
 *
 * Kinds are load-bearing, not decoration. Once a definition exists the storage column is chosen
 * from `kind` and the value is coerced into it — `integer`/`float` write `Number(value)`,
 * `currency` writes `String(value)`. `unit_cost` arrives from Shopify as a decimal *string*
 * (`'12.5000'`), so it is declared `currency` to preserve the exact decimal rather than round-trip
 * through a JS float.
 */
const systemEntities: CustomEntitySpec[] = [
  {
    id: OM_ENTITY_ID.productVariant,
    fields: [
      {
        key: INVENTORY_CUSTOM_FIELD.onHand,
        kind: 'integer',
        label: 'On hand',
        description: "Current on-hand stock, summed across the variant's Shopify locations. Maintained by the Shopify inventory sync.",
        formEditable: false,
        filterable: true,
        indexed: true,
        listVisible: true,
      },
      {
        key: INVENTORY_CUSTOM_FIELD.available,
        kind: 'integer',
        label: 'Available',
        description: "Current available (sellable) stock, summed across the variant's Shopify locations. Maintained by the Shopify inventory sync.",
        formEditable: false,
        filterable: true,
        indexed: true,
        listVisible: true,
      },
      {
        key: INVENTORY_CUSTOM_FIELD.oosRatio,
        kind: 'float',
        label: `Out-of-stock ratio (${OOS_DEFAULT_WINDOW_DAYS}d)`,
        // Stated here too because the admin UI is where someone will first meet a blank value and
        // reasonably read it as "never out of stock" — which is the opposite of what it means.
        description: `Share of the trailing ${OOS_DEFAULT_WINDOW_DAYS} days the variant was out of stock everywhere, 0–1. Blank means not enough history to say, NOT zero stockouts.`,
        formEditable: false,
        filterable: true,
        indexed: true,
        listVisible: true,
      },
      {
        key: INVENTORY_CUSTOM_FIELD.daysOutOfStock,
        kind: 'integer',
        label: `Days out of stock (${OOS_DEFAULT_WINDOW_DAYS}d)`,
        description: `Days out of stock over the trailing ${OOS_DEFAULT_WINDOW_DAYS} days — the numerator behind the ratio. Written only when the ratio is.`,
        formEditable: false,
        filterable: true,
        indexed: true,
        // Supporting detail behind the ratio; off by default so it does not crowd the grid.
        listVisible: false,
      },
      {
        key: INVENTORY_CUSTOM_FIELD.unitCost,
        kind: 'currency',
        label: 'Unit cost',
        description: 'Shopify inventory item unit cost, for margin and P&L. Maintained by the Shopify inventory sync.',
        formEditable: false,
        filterable: true,
        indexed: true,
        // Cost is commercially sensitive — opt in per view rather than defaulting into shared grids.
        listVisible: false,
      },
    ],
  },
]

export const entities = systemEntities
export default systemEntities
