/**
 * Guards the seam that broke once already: the inventory adapter wrote five custom fields that no
 * module declared, so every write was a silent no-op and nothing surfaced on the product page.
 *
 * Nothing at runtime couples the write to the declaration — a missing definition raises no error,
 * and the adapter's own `write_back_failed` anomaly is deliberately not a failed item — so the
 * only thing that can catch a drift is a test that compares the two lists directly.
 */

import { entities } from '../ce'
import { INVENTORY_CUSTOM_FIELD, OM_ENTITY_ID } from '../lib/constants'

const variantSpec = entities.find((entity) => entity.id === OM_ENTITY_ID.productVariant)
const fields = variantSpec?.fields ?? []
const byKey = new Map(fields.map((field) => [field.key, field]))

describe('ce', () => {
  it('declares the variant fieldset against the colon-dialect entity id', () => {
    // The wrong dialect (`catalog_product_variant`, the mapping-table form) declares fields against
    // an entity that does not exist and fails exactly as silently as declaring nothing at all.
    expect(variantSpec).toBeDefined()
    expect(variantSpec!.id).toBe('catalog:catalog_product_variant')
  })

  it('declares a definition for every custom field the inventory adapter writes', () => {
    const written = Object.values(INVENTORY_CUSTOM_FIELD)
    const declared = fields.map((field) => field.key)
    // Sorted set comparison, so the failure message names the missing key rather than a length.
    expect([...declared].sort()).toEqual([...written].sort())
  })

  it('stores each value in a column that matches how the adapter writes it', () => {
    // `setRecordCustomFields` picks the storage column from `kind` and coerces into it, so a kind
    // that disagrees with the written JS type corrupts the value rather than rejecting it:
    // `Number('12.5000')` in an int column, or a rounded ratio, are both wrong-but-plausible.
    expect(byKey.get(INVENTORY_CUSTOM_FIELD.onHand)?.kind).toBe('integer')
    expect(byKey.get(INVENTORY_CUSTOM_FIELD.available)?.kind).toBe('integer')
    expect(byKey.get(INVENTORY_CUSTOM_FIELD.daysOutOfStock)?.kind).toBe('integer')
    // A ratio in an integer column truncates to 0 or 1 — the two readings that matter most.
    expect(byKey.get(INVENTORY_CUSTOM_FIELD.oosRatio)?.kind).toBe('float')
    // Shopify sends unit cost as a decimal string; `currency` stores text and keeps it exact.
    expect(byKey.get(INVENTORY_CUSTOM_FIELD.unitCost)?.kind).toBe('currency')
  })

  it('marks every synced field read-only in generated forms', () => {
    // These are overwritten on the next run; an editable control offers an edit that silently reverts.
    for (const field of fields) {
      expect(field.formEditable).toBe(false)
    }
  })

  it('keeps the window-suffixed keys pinned to the window constant', () => {
    // The `90d` in the key names is a claim about `OOS_DEFAULT_WINDOW_DAYS`. Changing the constant
    // without renaming the fields leaves them lying about the window they summarise.
    expect(INVENTORY_CUSTOM_FIELD.oosRatio).toBe('oos_ratio_90d')
    expect(INVENTORY_CUSTOM_FIELD.daysOutOfStock).toBe('days_out_of_stock_90d')
  })
})
