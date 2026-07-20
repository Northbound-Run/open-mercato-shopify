import {
  formatMoney,
  mapAddressSnapshot,
  mapOrder,
  OrderMappingError,
  scaleMoney,
  type MappedOrder,
  type MappedOrderAdjustment,
  type MappedOrderLine,
  type ShopifyMoneyBag,
  type ShopifyOrderNode,
} from '../lib/mappers/order'

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A faithful port of core's total engine (`@open-mercato/core .../sales/lib/calculations.ts`,
// `buildBaseLineResult` + `buildBaseDocumentResult`). ts-jest cannot import that file at runtime —
// Jest does not transpile node_modules — so the arithmetic is mirrored here, integer-scaled at 1e4
// (core rounds to 1e4 internally, so a 2-decimal figure is identical either way). This is the proof
// the mapper exists for: feed core the mapper's `lines` + `adjustments`, and the totals it computes
// ARE Shopify's. Each step cites the core line it mirrors.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const s = (v: string): bigint => scaleMoney(v) ?? 0n

function coreTotals(
  lines: MappedOrderLine[],
  adjustments: MappedOrderAdjustment[],
): { grand: string; net: string; tax: string; discount: string } {
  // buildBaseLineResult: unitNet = unitPriceNet; discountPerUnit = 0 (we never set a line discount);
  // netSubtotal = unitNet*qty; taxAmount = explicit; grossSubtotal = net + tax.
  let subtotalNet = 0n
  let subtotalGross = 0n
  let discountTotal = 0n
  let taxTotal = 0n
  for (const line of lines) {
    const q = BigInt(line.quantity)
    const net = s(line.unitPriceNet) * q // scaled 1e4 × integer qty stays 1e4-scaled
    const tax = s(line.taxAmount)
    subtotalNet += net
    subtotalGross += net + tax
    taxTotal += tax
  }
  // buildBaseDocumentResult: order-scoped adjustments applied in `position` order.
  for (const adj of [...adjustments].sort((a, b) => a.position - b.position)) {
    const amount = s(adj.amount) // core Math.abs-normalizes non-negative kinds; our amounts are ≥0
    switch (adj.kind) {
      case 'discount':
        discountTotal += amount
        subtotalNet -= amount
        subtotalGross -= amount
        break
      case 'shipping':
        subtotalNet += amount
        subtotalGross += amount
        break
      case 'tax':
        taxTotal += amount
        subtotalGross += amount
        break
    }
  }
  // grand = subtotal after adjustments (core folds shipping/tax/surcharge into subtotal).
  return {
    grand: formatMoney(subtotalGross),
    net: formatMoney(subtotalNet),
    tax: formatMoney(taxTotal),
    discount: formatMoney(discountTotal),
  }
}

// ── Fixture builders ─────────────────────────────────────────────────────────────────────────

function bag(shop: string, presentment?: { amount: string; currency: string }): ShopifyMoneyBag {
  return {
    shopMoney: { amount: shop, currencyCode: 'USD' },
    presentmentMoney: presentment
      ? { amount: presentment.amount, currencyCode: presentment.currency }
      : { amount: shop, currencyCode: 'USD' },
  }
}

type LineSpec = {
  id: string
  variantId?: string | null
  sku?: string | null
  qty: number
  unit: string
  tax?: string
  discount?: { amount: string; code?: string; title?: string }
}

function line(spec: LineSpec) {
  return {
    id: spec.id,
    name: `Item ${spec.id}`,
    sku: spec.sku ?? 'SKU-1',
    quantity: spec.qty,
    variant: spec.variantId === null ? null : { id: spec.variantId ?? 'gid://shopify/ProductVariant/1', sku: spec.sku ?? 'SKU-1' },
    originalUnitPriceSet: bag(spec.unit),
    discountedUnitPriceSet: bag(spec.unit),
    taxLines: spec.tax ? [{ title: 'State tax', ratePercentage: 8, priceSet: bag(spec.tax) }] : [],
    discountAllocations: spec.discount
      ? [
          {
            allocatedAmountSet: bag(spec.discount.amount),
            discountApplication: { code: spec.discount.code ?? null, title: spec.discount.title ?? null },
          },
        ]
      : [],
  }
}

function orderNode(over: Partial<ShopifyOrderNode> & { lines?: ReturnType<typeof line>[] } = {}): ShopifyOrderNode {
  const { lines: lineNodes, ...rest } = over
  return {
    id: 'gid://shopify/Order/5001',
    name: '#1001',
    email: 'buyer@example.com',
    createdAt: '2026-07-15T09:00:00Z',
    processedAt: '2026-07-15T09:01:00Z',
    updatedAt: '2026-07-18T12:00:00Z',
    currencyCode: 'USD',
    taxesIncluded: false,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    customer: { id: 'gid://shopify/Customer/9001', email: 'buyer@example.com' },
    billingAddress: { firstName: 'Ada', lastName: 'Byron', address1: '10 King St', city: 'Bath', zip: 'BA1', country: 'United Kingdom' },
    shippingAddress: { firstName: 'Ada', lastName: 'Byron', address1: '10 King St', city: 'Bath', zip: 'BA1', country: 'United Kingdom' },
    lineItems: { nodes: lineNodes ?? [line({ id: 'gid://shopify/LineItem/1', qty: 2, unit: '25.00', tax: '4.00' })] },
    ...rest,
  }
}

/** Attach the four authoritative order-level totals Shopify would report for a fixture. */
function withTotals(
  node: ShopifyOrderNode,
  totals: { grand: string; subtotal: string; tax: string; discount: string; shipping: string },
): ShopifyOrderNode {
  return {
    ...node,
    totalPriceSet: bag(totals.grand),
    subtotalPriceSet: bag(totals.subtotal),
    totalTaxSet: bag(totals.tax),
    totalDiscountsSet: bag(totals.discount),
    totalShippingPriceSet: bag(totals.shipping),
    ...(Number(totals.shipping) > 0 ? { shippingLines: { nodes: [{ title: 'Standard', priceSet: bag(totals.shipping) }] } } : {}),
  }
}

/** Assert core, fed the mapper's output, reproduces Shopify's four totals to the cent. */
function expectReconciles(mapped: MappedOrder, shopify: { grand: string; tax: string; discount: string }) {
  const computed = coreTotals(mapped.lines, mapped.adjustments)
  const cents = (v: string) => scaleMoney(v)
  expect(cents(computed.grand)).toBe(cents(shopify.grand))
  expect(cents(computed.tax)).toBe(cents(shopify.tax))
  expect(cents(computed.discount)).toBe(cents(shopify.discount))
  // Net is grand minus tax by construction — the invariant that keeps grandTotalNet meaningful.
  expect(cents(computed.net)).toBe(cents(mapped.reconciliation.grandTotalNet))
  expect(cents(mapped.reconciliation.grandTotalGross)).toBe(cents(shopify.grand))
}

// ── Money helpers ────────────────────────────────────────────────────────────────────────────

describe('money is decimal, never float', () => {
  it('scales and re-renders without a float artefact', () => {
    expect(formatMoney(scaleMoney('0.1')! + scaleMoney('0.2')!)).toBe('0.3')
    expect(formatMoney(scaleMoney('19.99')!)).toBe('19.99')
    expect(formatMoney(scaleMoney('100')!)).toBe('100')
  })

  it('rejects a number, an over-precise decimal, and junk — never coerces silently', () => {
    expect(scaleMoney(19.99 as unknown)).toBeNull()
    expect(scaleMoney('1.23456')).toBeNull()
    expect(scaleMoney('1,234.00')).toBeNull()
    expect(scaleMoney('')).toBeNull()
  })

  it('sums a set of decimals exactly', () => {
    const total = ['19.99', '5.01', '0.005' /* 4dp ok? no, 3dp */].slice(0, 2).reduce((acc, v) => acc + scaleMoney(v)!, 0n)
    expect(formatMoney(total)).toBe('25')
  })
})

// ── The header fields ────────────────────────────────────────────────────────────────────────

describe('order header mapping', () => {
  const mapped = mapOrder(
    withTotals(orderNode(), { grand: '59.00', subtotal: '50.00', tax: '4.00', discount: '0', shipping: '5.00' }),
  )

  it('routes the order GID to external_reference and the name to orderNumber', () => {
    expect(mapped.externalId).toBe('gid://shopify/Order/5001')
    expect(mapped.header.externalReference).toBe('gid://shopify/Order/5001')
    expect(mapped.header.orderNumber).toBe('#1001')
    expect(mapped.orderNumber).toBe('#1001')
  })

  it('links the customer and keeps the email for a natural-key fallback', () => {
    expect(mapped.customerExternalId).toBe('gid://shopify/Customer/9001')
    expect(mapped.customerEmail).toBe('buyer@example.com')
  })

  it('carries both display statuses (native columns need dictionary ids, so these live in metadata)', () => {
    const namespace = (mapped.header.metadata as any).shopify
    expect(namespace.financialStatus).toBe('PAID')
    expect(namespace.fulfillmentStatus).toBe('UNFULFILLED')
    expect(mapped.financialStatus).toBe('PAID')
    expect(mapped.fulfillmentStatus).toBe('UNFULFILLED')
  })

  it('maps both addresses to snapshots', () => {
    expect(mapped.header.billingAddressSnapshot).toMatchObject({ addressLine1: '10 King St', city: 'Bath' })
    expect(mapped.header.shippingAddressSnapshot).toMatchObject({ name: 'Ada Byron', country: 'United Kingdom' })
  })

  it('sets placedAt from processedAt and currency from the order', () => {
    expect(mapped.header.placedAt).toBe('2026-07-15T09:01:00Z')
    expect(mapped.currencyCode).toBe('USD')
  })

  it('throws only when the currency is unusable', () => {
    expect(() => mapOrder(orderNode({ currencyCode: null }))).toThrow(OrderMappingError)
  })
})

describe('address snapshot', () => {
  it('composes a name from first/last when Shopify sends no precomposed name', () => {
    expect(mapAddressSnapshot({ firstName: 'Grace', lastName: 'Hopper', address1: '1 Navy Yard' })).toMatchObject({
      name: 'Grace Hopper',
      addressLine1: '1 Navy Yard',
    })
  })
  it('returns null for an empty address', () => {
    expect(mapAddressSnapshot(null)).toBeNull()
    expect(mapAddressSnapshot({})).toBeNull()
  })
})

// ── MoneyBag: shopMoney persisted, presentmentMoney kept ───────────────────────────────────────

describe('MoneyBag — shopMoney drives totals, presentmentMoney is preserved', () => {
  // Built directly (not via withTotals, which would overwrite the presentment side): the store
  // prices in USD but the customer paid in GBP, and that GBP figure must survive.
  const node: ShopifyOrderNode = {
    ...orderNode({
      lines: [line({ id: 'gid://shopify/LineItem/1', qty: 1, unit: '50.00', tax: '4.00' })],
    }),
    totalPriceSet: bag('54.00', { amount: '43.20', currency: 'GBP' }),
    totalTaxSet: bag('4.00', { amount: '3.20', currency: 'GBP' }),
    totalDiscountsSet: bag('0', { amount: '0', currency: 'GBP' }),
    totalShippingPriceSet: bag('0', { amount: '0', currency: 'GBP' }),
    presentmentCurrencyCode: 'GBP',
  }
  const mapped = mapOrder(node)

  it('persists shopMoney into the reconciled totals', () => {
    expect(mapped.reconciliation.grandTotalGross).toBe('54')
    expect(mapped.reconciliation.taxTotal).toBe('4')
  })

  it('keeps presentmentMoney alongside — it is what the customer actually paid', () => {
    const totals = (mapped.header.metadata as any).shopify.totals
    expect(totals.presentment.grandTotal).toEqual({ amount: '43.20', currencyCode: 'GBP' })
    expect(totals.presentment.tax).toEqual({ amount: '3.20', currencyCode: 'GBP' })
  })
})

// ── Lines and variant resolution ───────────────────────────────────────────────────────────────

describe('line mapping', () => {
  it('keeps the variant GID and SKU for the adapter to resolve, and preserves the decimal string', () => {
    const mapped = mapOrder(
      withTotals(
        orderNode({ lines: [line({ id: 'gid://shopify/LineItem/1', variantId: 'gid://shopify/ProductVariant/77', sku: 'HAT-01', qty: 3, unit: '12.34', tax: '0' })] }),
        { grand: '37.02', subtotal: '37.02', tax: '0', discount: '0', shipping: '0' },
      ),
    )
    const l = mapped.lines[0]
    expect(l.variantExternalId).toBe('gid://shopify/ProductVariant/77')
    expect(l.sku).toBe('HAT-01')
    expect(l.quantity).toBe(3)
    // Exact decimal string, no float rounding.
    expect(l.unitPriceNet).toBe('12.34')
  })

  it('records a line with no variant rather than dropping it or fabricating one', () => {
    const mapped = mapOrder(
      withTotals(
        orderNode({ lines: [line({ id: 'gid://shopify/LineItem/1', variantId: null, sku: null, qty: 1, unit: '10.00', tax: '0' })] }),
        { grand: '10.00', subtotal: '10.00', tax: '0', discount: '0', shipping: '0' },
      ),
    )
    expect(mapped.lines).toHaveLength(1)
    expect(mapped.lines[0].variantExternalId).toBeNull()
    // Nothing invented.
    expect(mapped.lines[0].metadata.variantGid).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 EXACT TOTAL RECONCILIATION ACROSS THE FIXTURE SET.
// A plain order, a discount-code order, an automatic-discount order, a partially-fulfilled order, a
// partially-refunded order, and a cancelled order. For each, core (mirrored above) fed the mapper's
// lines + adjustments must reproduce Shopify's grand/tax/discount to the cent. Total matching on
// discounted orders is the best available proxy that the discount math is right.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('exact total reconciliation', () => {
  it('a plain order (line tax + shipping)', () => {
    const node = withTotals(
      orderNode({ lines: [line({ id: 'gid://shopify/LineItem/1', qty: 2, unit: '25.00', tax: '4.00' })] }),
      { grand: '59.00', subtotal: '50.00', tax: '4.00', discount: '0', shipping: '5.00' },
    )
    expectReconciles(mapOrder(node), { grand: '59.00', tax: '4.00', discount: '0' })
  })

  it('an order with a DISCOUNT CODE (allocated across lines)', () => {
    const node = withTotals(
      orderNode({
        lines: [
          line({ id: 'gid://shopify/LineItem/1', qty: 1, unit: '40.00', tax: '2.40', discount: { amount: '10.00', code: 'SAVE10' } }),
          line({ id: 'gid://shopify/LineItem/2', qty: 2, unit: '10.00', tax: '1.60' }),
        ],
      }),
      { grand: '54.00', subtotal: '60.00', tax: '4.00', discount: '10.00', shipping: '0' },
    )
    const mapped = mapOrder(node)
    expectReconciles(mapped, { grand: '54.00', tax: '4.00', discount: '10.00' })
    // The discount code is a visible, named adjustment.
    const discountAdj = mapped.adjustments.find((a) => a.kind === 'discount')!
    expect(discountAdj.code).toBe('SAVE10')
    expect(discountAdj.amount).toBe('10')
  })

  it('an order with an AUTOMATIC discount (no code, a title)', () => {
    const node = withTotals(
      orderNode({
        lines: [line({ id: 'gid://shopify/LineItem/1', qty: 1, unit: '100.00', tax: '8.50', discount: { amount: '15.00', title: 'Spring Sale' } })],
      }),
      { grand: '93.50', subtotal: '100.00', tax: '8.50', discount: '15.00', shipping: '0' },
    )
    const mapped = mapOrder(node)
    expectReconciles(mapped, { grand: '93.50', tax: '8.50', discount: '15.00' })
    const discountAdj = mapped.adjustments.find((a) => a.kind === 'discount')!
    expect(discountAdj.code).toBeNull()
    expect(discountAdj.label).toBe('Spring Sale')
  })

  it('a PARTIALLY-FULFILLED order (fulfillment does not change totals)', () => {
    const node = withTotals(
      {
        ...orderNode({
          lines: [line({ id: 'gid://shopify/LineItem/1', qty: 3, unit: '20.00', tax: '0' })],
          displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
        }),
        fulfillments: [
          {
            id: 'gid://shopify/Fulfillment/1',
            status: 'SUCCESS',
            displayStatus: 'FULFILLED',
            createdAt: '2026-07-16T10:00:00Z',
            trackingInfo: [{ company: 'UPS', number: '1Z999', url: 'https://ups.example/1Z999' }],
            fulfillmentLineItems: { nodes: [{ quantity: 2, lineItem: { id: 'gid://shopify/LineItem/1' } }] },
          },
        ],
      },
      { grand: '60.00', subtotal: '60.00', tax: '0', discount: '0', shipping: '0' },
    )
    const mapped = mapOrder(node)
    expectReconciles(mapped, { grand: '60.00', tax: '0', discount: '0' })
    expect(mapped.shipments).toHaveLength(1)
    expect(mapped.shipments[0]).toMatchObject({ carrierName: 'UPS', trackingNumbers: ['1Z999'], status: 'FULFILLED' })
    expect(mapped.fulfillmentStatus).toBe('PARTIALLY_FULFILLED')
  })

  it('a PARTIALLY-REFUNDED order (original totals persist; the refund is a payment)', () => {
    const node = withTotals(
      {
        ...orderNode({
          lines: [line({ id: 'gid://shopify/LineItem/1', qty: 1, unit: '100.00', tax: '0' })],
          displayFinancialStatus: 'PARTIALLY_REFUNDED',
        }),
        transactions: [
          { id: 'gid://shopify/OrderTransaction/1', kind: 'SALE', status: 'SUCCESS', gateway: 'stripe', processedAt: '2026-07-15T09:02:00Z', amountSet: bag('100.00') },
          { id: 'gid://shopify/OrderTransaction/2', kind: 'REFUND', status: 'SUCCESS', gateway: 'stripe', processedAt: '2026-07-17T11:00:00Z', amountSet: bag('30.00') },
        ],
      },
      { grand: '100.00', subtotal: '100.00', tax: '0', discount: '0', shipping: '0' },
    )
    const mapped = mapOrder(node)
    // Grand total is the ORIGINAL order value — the refund does not rewrite it.
    expectReconciles(mapped, { grand: '100.00', tax: '0', discount: '0' })
    expect(mapped.payments).toHaveLength(2)
    const sale = mapped.payments.find((p) => p.metadata.kind === 'SALE')!
    const refund = mapped.payments.find((p) => p.metadata.kind === 'REFUND')!
    expect(sale.capturedAmount).toBe('100')
    expect(refund.refundedAmount).toBe('30')
  })

  it('a CANCELLED order (totals unchanged; cancellation recorded)', () => {
    const node = withTotals(
      {
        ...orderNode({
          lines: [line({ id: 'gid://shopify/LineItem/1', qty: 1, unit: '75.00', tax: '0' })],
          displayFinancialStatus: 'REFUNDED',
          displayFulfillmentStatus: 'UNFULFILLED',
          cancelledAt: '2026-07-17T08:00:00Z',
          cancelReason: 'CUSTOMER',
        }),
      },
      { grand: '75.00', subtotal: '75.00', tax: '0', discount: '0', shipping: '0' },
    )
    const mapped = mapOrder(node)
    expectReconciles(mapped, { grand: '75.00', tax: '0', discount: '0' })
    expect(mapped.cancelledAt).toBe('2026-07-17T08:00:00Z')
    expect((mapped.header.metadata as any).shopify.cancelReason).toBe('CUSTOMER')
  })

  it('reconciles the discount total even when allocations do not add up to it (shipping discount)', () => {
    // Shopify says D=12 but only 10 is allocated to a line (2 was a shipping discount we did not
    // capture on a line). The residual guarantees discountTotal still equals 12.
    const node = withTotals(
      orderNode({
        lines: [line({ id: 'gid://shopify/LineItem/1', qty: 1, unit: '80.00', tax: '0', discount: { amount: '10.00', code: 'FREESHIP' } })],
      }),
      { grand: '73.00', subtotal: '80.00', tax: '0', discount: '12.00', shipping: '5.00' },
    )
    const mapped = mapOrder(node)
    expectReconciles(mapped, { grand: '73.00', tax: '0', discount: '12.00' })
    expect(mapped.notes).toContain('discount_residual_reconciled')
  })

  it('reconciles (and never emits a negative amount) when allocations over-count the total', () => {
    // Allocations claim 15 but Shopify's authoritative total is 10. Collapse to a single 10 so the
    // discount total is exact and no amount is negative — core's decimal({ min: 0 }) would reject one.
    const node = withTotals(
      orderNode({
        lines: [line({ id: 'gid://shopify/LineItem/1', qty: 1, unit: '100.00', tax: '0', discount: { amount: '15.00', code: 'OVER' } })],
      }),
      { grand: '90.00', subtotal: '100.00', tax: '0', discount: '10.00', shipping: '0' },
    )
    const mapped = mapOrder(node)
    expectReconciles(mapped, { grand: '90.00', tax: '0', discount: '10.00' })
    for (const adj of mapped.adjustments) expect(scaleMoney(adj.amount)! >= 0n).toBe(true)
  })
})

// ── Tax residual (shipping/duty tax not carried by any line) ────────────────────────────────────

describe('tax residual', () => {
  it('adds a tax adjustment for tax no line carries, so the tax total lands exactly', () => {
    // Line tax 4.00; order tax 4.40 → 0.40 of shipping tax that no line carries.
    const node = withTotals(
      orderNode({ lines: [line({ id: 'gid://shopify/LineItem/1', qty: 2, unit: '25.00', tax: '4.00' })] }),
      { grand: '59.40', subtotal: '50.00', tax: '4.40', discount: '0', shipping: '5.00' },
    )
    const mapped = mapOrder(node)
    expectReconciles(mapped, { grand: '59.40', tax: '4.40', discount: '0' })
    expect(mapped.notes).toContain('tax_residual_added')
    expect(mapped.adjustments.find((a) => a.kind === 'tax')?.amount).toBe('0.4')
  })
})

// ── Content hash ───────────────────────────────────────────────────────────────────────────────

describe('content hash', () => {
  const base = () => withTotals(orderNode(), { grand: '59.00', subtotal: '50.00', tax: '4.00', discount: '0', shipping: '5.00' })

  it('is stable across identical payloads and ignores updatedAt', () => {
    const a = mapOrder(base())
    const b = mapOrder({ ...base(), updatedAt: '2099-01-01T00:00:00Z' })
    expect(a.contentHash).toBe(b.contentHash)
  })

  it('changes when a mapped field changes', () => {
    const a = mapOrder(base())
    const b = mapOrder({ ...base(), displayFulfillmentStatus: 'FULFILLED' })
    expect(a.contentHash).not.toBe(b.contentHash)
  })
})
