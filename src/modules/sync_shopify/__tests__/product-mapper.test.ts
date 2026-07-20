import {
  METADATA_NAMESPACE,
  PRICE_KIND_CODE,
  ProductMappingError,
  compareDecimalStrings,
  computeContentHash,
  isActiveStatus,
  mapPrice,
  mapProduct,
  mapVariant,
  mergeMetadata,
  normalizeMoney,
  readContentHash,
  resolveCurrencyCode,
  stableStringify,
  toPriceIntents,
  type ShopifyProductNode,
  type ShopifyVariantNode,
} from '../lib/mappers/product'

const SCOPE = { organizationId: 'org-1', tenantId: 'tenant-1' }

function product(over: Partial<ShopifyProductNode> = {}): ShopifyProductNode {
  return {
    id: 'gid://shopify/Product/1',
    title: 'Merino Beanie',
    descriptionHtml: '<p>Warm.</p>',
    handle: 'merino-beanie',
    status: 'ACTIVE',
    productType: 'Hats',
    vendor: 'Northbound',
    tags: ['winter', 'wool'],
    updatedAt: '2026-07-20T10:00:00Z',
    priceRangeV2: { maxVariantPrice: { amount: '29.00', currencyCode: 'GBP' } },
    variants: [],
    variantsComplete: true,
    ...over,
  }
}

function variant(over: Partial<ShopifyVariantNode> = {}): ShopifyVariantNode {
  return {
    id: 'gid://shopify/ProductVariant/11',
    title: 'One size',
    sku: 'BEANIE-1',
    barcode: '5012345678900',
    price: '29.00',
    compareAtPrice: null,
    selectedOptions: [{ name: 'Size', value: 'One size' }],
    updatedAt: '2026-07-20T10:00:00Z',
    ...over,
  }
}

describe('normalizeMoney', () => {
  it('preserves the decimal string exactly as Shopify sent it', () => {
    // The trailing zero is the point: `String(Number('1.10'))` is '1.1', which is a different
    // value to anyone reconciling against Shopify's own reporting.
    expect(normalizeMoney('1.10')).toBe('1.10')
    expect(normalizeMoney('19.99')).toBe('19.99')
    expect(normalizeMoney('0.0000')).toBe('0.0000')
    expect(normalizeMoney('1234567.8900')).toBe('1234567.8900')
    expect(normalizeMoney(' 42 ')).toBe('42')
  })

  it('refuses a number rather than laundering a value that already lost precision', () => {
    expect(normalizeMoney(19.99)).toBeNull()
    expect(normalizeMoney(0.1 + 0.2)).toBeNull()
  })

  it('rejects anything that is not an unsigned decimal', () => {
    expect(normalizeMoney('-1.00')).toBeNull()
    expect(normalizeMoney('1e3')).toBeNull()
    expect(normalizeMoney('1,000.00')).toBeNull()
    expect(normalizeMoney('')).toBeNull()
    expect(normalizeMoney(null)).toBeNull()
    expect(normalizeMoney(undefined)).toBeNull()
  })
})

describe('compareDecimalStrings', () => {
  it('orders by magnitude, not lexically', () => {
    // '10' < '9' as strings, which is the bug this exists to avoid.
    expect(compareDecimalStrings('10.00', '9.00')).toBeGreaterThan(0)
    expect(compareDecimalStrings('9.00', '10.00')).toBeLessThan(0)
  })

  it('compares fractions position by position regardless of width', () => {
    expect(compareDecimalStrings('1.5', '1.50')).toBe(0)
    expect(compareDecimalStrings('1.5', '1.45')).toBeGreaterThan(0)
    expect(compareDecimalStrings('1.05', '1.5')).toBeLessThan(0)
  })

  it('ignores leading zeroes', () => {
    expect(compareDecimalStrings('007.00', '7')).toBe(0)
    expect(compareDecimalStrings('0.10', '00.10')).toBe(0)
  })

  it('stays exact past the range a float can represent', () => {
    // Both parse to the same double; only string comparison can tell them apart.
    expect(compareDecimalStrings('9007199254740993', '9007199254740992')).toBeGreaterThan(0)
  })
})

describe('isActiveStatus', () => {
  it('treats only ACTIVE as live', () => {
    expect(isActiveStatus('ACTIVE')).toBe(true)
    expect(isActiveStatus('active')).toBe(true)
    expect(isActiveStatus('DRAFT')).toBe(false)
    expect(isActiveStatus('ARCHIVED')).toBe(false)
    expect(isActiveStatus(null)).toBe(false)
    expect(isActiveStatus(undefined)).toBe(false)
  })
})

describe('mapProduct — §5.1 field mapping', () => {
  it('maps every core field to its Open Mercato column', () => {
    const mapped = mapProduct(product(), SCOPE)

    expect(mapped.input).toMatchObject({
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      title: 'Merino Beanie',
      // ⚠ descriptionHtml, not the deprecated bodyHtml.
      description: '<p>Warm.</p>',
      handle: 'merino-beanie',
      isActive: true,
      tags: ['winter', 'wool'],
    })
  })

  it('maps status to isActive and keeps the raw value, which the boolean cannot express', () => {
    expect(mapProduct(product({ status: 'ACTIVE' }), SCOPE).input.isActive).toBe(true)

    // DRAFT and ARCHIVED both collapse to false and are indistinguishable afterwards.
    for (const status of ['DRAFT', 'ARCHIVED']) {
      const mapped = mapProduct(product({ status }), SCOPE)
      expect(mapped.input.isActive).toBe(false)
      expect((mapped.input.metadata as any)[METADATA_NAMESPACE].status).toBe(status)
    }
  })

  it('never sends productType — Shopify free text would fail Open Mercato closed enum', () => {
    // OM's productType is simple|configurable|virtual|downloadable|bundle|grouped. Sending
    // "Hats" is a validation failure; omitting it defaults to `simple` on create and leaves an
    // operator's deliberate choice alone on update.
    const mapped = mapProduct(product({ productType: 'Hats' }), SCOPE)

    expect(mapped.input).not.toHaveProperty('productType')
    expect((mapped.input.metadata as any)[METADATA_NAMESPACE].productType).toBe('Hats')
  })

  it('keeps vendor in metadata — there is no native column for it', () => {
    const mapped = mapProduct(product({ vendor: 'Northbound' }), SCOPE)
    expect((mapped.input.metadata as any)[METADATA_NAMESPACE].vendor).toBe('Northbound')
  })

  it('drops a handle Open Mercato would reject rather than failing the product', () => {
    const mapped = mapProduct(product({ handle: 'Not A Handle!' }), SCOPE)

    expect(mapped.input).not.toHaveProperty('handle')
    expect(mapped.handle).toBeNull()
    // The original is still visible, so the loss is not silent.
    expect((mapped.input.metadata as any)[METADATA_NAMESPACE].handle).toBe('Not A Handle!')
  })

  it('lowercases a handle that only differs by case', () => {
    expect(mapProduct(product({ handle: 'Merino-Beanie' }), SCOPE).handle).toBe('merino-beanie')
  })

  it('tolerates every optional field being missing or null', () => {
    const sparse = mapProduct(
      {
        id: 'gid://shopify/Product/9',
        title: 'Bare',
        descriptionHtml: null,
        handle: null,
        status: null,
        productType: null,
        vendor: null,
        tags: null,
        updatedAt: null,
        priceRangeV2: null,
        variants: [],
        variantsComplete: true,
      },
      SCOPE,
    )

    expect(sparse.input).toMatchObject({ title: 'Bare', isActive: false, tags: [] })
    expect(sparse.input).not.toHaveProperty('description')
    expect(sparse.input).not.toHaveProperty('handle')
  })

  it('always sends tags, empty included, so an upstream removal propagates', () => {
    expect(mapProduct(product({ tags: [] }), SCOPE).input.tags).toEqual([])
  })

  it('deduplicates tags case-insensitively and caps the list at 100', () => {
    const many = Array.from({ length: 150 }, (_, i) => `tag-${i}`)
    expect(mapProduct(product({ tags: ['Winter', 'winter', 'WOOL'] }), SCOPE).input.tags).toEqual([
      'Winter',
      'WOOL',
    ])
    expect((mapProduct(product({ tags: many }), SCOPE).input.tags as string[])).toHaveLength(100)
  })

  it('truncates an over-long description and records that it did', () => {
    const long = 'x'.repeat(5000)
    const mapped = mapProduct(product({ descriptionHtml: long }), SCOPE)

    expect((mapped.input.description as string)).toHaveLength(4000)
    expect((mapped.input.metadata as any)[METADATA_NAMESPACE].descriptionTruncated).toBe(true)
  })

  it('fails an untitled product loudly instead of inventing a placeholder', () => {
    expect(() => mapProduct(product({ title: '   ' }), SCOPE)).toThrow(ProductMappingError)
    expect(() => mapProduct(product({ title: null }), SCOPE)).toThrow(/has no title/)
  })

  it('maps a product with zero variants without complaint', () => {
    const mapped = mapProduct(product({ variants: [] }), SCOPE)
    expect(mapped.input.title).toBe('Merino Beanie')
    expect(mapped.contentHash).toEqual(expect.any(String))
  })
})

describe('mapProduct — content hash', () => {
  it('is stable across runs and across key ordering', () => {
    expect(mapProduct(product(), SCOPE).contentHash).toBe(mapProduct(product(), SCOPE).contentHash)
    expect(computeContentHash({ a: 1, b: 2 })).toBe(computeContentHash({ b: 2, a: 1 }))
  })

  it('changes when anything we would write changes', () => {
    const base = mapProduct(product(), SCOPE).contentHash
    expect(mapProduct(product({ title: 'Other' }), SCOPE).contentHash).not.toBe(base)
    expect(mapProduct(product({ status: 'DRAFT' }), SCOPE).contentHash).not.toBe(base)
    expect(mapProduct(product({ tags: ['winter'] }), SCOPE).contentHash).not.toBe(base)
    expect(mapProduct(product({ vendor: 'Someone Else' }), SCOPE).contentHash).not.toBe(base)
  })

  it('does not contain itself', () => {
    // The hash is computed before metadata is attached, or it could never match on a re-read.
    const mapped = mapProduct(product(), SCOPE)
    expect(readContentHash({ metadata: mapped.input.metadata })).toBe(mapped.contentHash)
  })

  it('round-trips through readContentHash and returns null for an unsynced row', () => {
    expect(readContentHash(null)).toBeNull()
    expect(readContentHash({})).toBeNull()
    expect(readContentHash({ metadata: {} })).toBeNull()
    expect(readContentHash({ metadata: { [METADATA_NAMESPACE]: {} } })).toBeNull()
  })
})

describe('stableStringify', () => {
  it('sorts keys at every depth', () => {
    expect(stableStringify({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}')
  })

  it('preserves array order, which is data rather than layout', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]')
  })
})

describe('mergeMetadata', () => {
  it('replaces only our namespace and leaves other writers alone', () => {
    const merged = mergeMetadata(
      { metadata: { erp: { code: 'X' }, [METADATA_NAMESPACE]: { contentHash: 'old' } } },
      { contentHash: 'new' },
    )

    expect(merged).toEqual({ erp: { code: 'X' }, [METADATA_NAMESPACE]: { contentHash: 'new' } })
  })

  it('copes with a row that has no metadata at all', () => {
    expect(mergeMetadata(null, { contentHash: 'h' })).toEqual({
      [METADATA_NAMESPACE]: { contentHash: 'h' },
    })
  })
})

describe('mapVariant', () => {
  it('maps sku, barcode, title and selectedOptions', () => {
    const mapped = mapVariant(variant(), 'local-product-1', SCOPE)

    expect(mapped.input).toMatchObject({
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      productId: 'local-product-1',
      name: 'One size',
      sku: 'BEANIE-1',
      barcode: '5012345678900',
      isActive: true,
      optionValues: { Size: 'One size' },
    })
  })

  it('drops a sku Open Mercato would reject but keeps the variant', () => {
    // Shopify permits spaces and slashes; core's pattern is [A-Za-z0-9-_.] only.
    const mapped = mapVariant(variant({ sku: 'BEANIE 1/RED' }), 'local-product-1', SCOPE)

    expect(mapped.input).not.toHaveProperty('sku')
    expect(mapped.sku).toBeNull()
    expect((mapped.input.metadata as any)[METADATA_NAMESPACE].rejectedSku).toBe('BEANIE 1/RED')
  })

  it('keeps money as the exact string Shopify sent', () => {
    const mapped = mapVariant(variant({ price: '1.10', compareAtPrice: '2.00' }), 'p', SCOPE)
    const namespace = (mapped.input.metadata as any)[METADATA_NAMESPACE]

    expect(namespace.price).toBe('1.10')
    expect(namespace.compareAtPrice).toBe('2.00')
  })

  it('excludes the local product id from the hash so a re-mapped product is not a change', () => {
    const a = mapVariant(variant(), 'local-product-1', SCOPE)
    const b = mapVariant(variant(), 'local-product-2', SCOPE)
    expect(a.contentHash).toBe(b.contentHash)
  })

  it('changes the hash when a price moves', () => {
    const base = mapVariant(variant(), 'p', SCOPE).contentHash
    expect(mapVariant(variant({ price: '31.00' }), 'p', SCOPE).contentHash).not.toBe(base)
  })

  it('tolerates missing options, sku, barcode and title', () => {
    const mapped = mapVariant(
      { id: 'gid://shopify/ProductVariant/2', sku: null, barcode: null, title: null, selectedOptions: null },
      'p',
      SCOPE,
    )

    expect(mapped.input).toMatchObject({ productId: 'p', isActive: true })
    expect(mapped.input).not.toHaveProperty('sku')
    expect(mapped.input).not.toHaveProperty('optionValues')
  })

  it('drops an option with no name rather than keying it under a placeholder', () => {
    const mapped = mapVariant(
      variant({ selectedOptions: [{ name: null, value: 'x' }, { name: 'Colour', value: 'Red' }] }),
      'p',
      SCOPE,
    )

    expect(mapped.input.optionValues).toEqual({ Colour: 'Red' })
  })
})

describe('toPriceIntents', () => {
  it('files a plain price under the regular kind and writes no sale row', () => {
    const intents = toPriceIntents(variant({ price: '29.00', compareAtPrice: null }), 'GBP')

    expect(intents).toEqual([
      {
        kindCode: PRICE_KIND_CODE.regular,
        amount: '29.00',
        currencyCode: 'GBP',
        externalId: 'gid://shopify/ProductVariant/11:price:regular::GBP',
      },
    ])
  })

  it('inverts a sale: compareAtPrice is the list price, price is what is charged', () => {
    // ⚠ Opposite to the literal reading of plan §5.1. selectBestPrice scores a promotional kind
    // above a regular one, so putting the higher "was" price under the sale kind would make the
    // customer pay MORE while on sale.
    const intents = toPriceIntents(variant({ price: '19.00', compareAtPrice: '29.00' }), 'GBP')

    expect(intents).toEqual([
      expect.objectContaining({ kindCode: PRICE_KIND_CODE.regular, amount: '29.00' }),
      expect.objectContaining({ kindCode: PRICE_KIND_CODE.sale, amount: '19.00' }),
    ])
  })

  it('ignores a compareAtPrice that is not above the price', () => {
    // Shopify keeps returning a stale compareAtPrice after a sale ends.
    expect(toPriceIntents(variant({ price: '29.00', compareAtPrice: '29.00' }), 'GBP')).toHaveLength(1)
    expect(toPriceIntents(variant({ price: '29.00', compareAtPrice: '19.00' }), 'GBP')).toHaveLength(1)
  })

  it('compares sale prices exactly, without a float in the path', () => {
    const intents = toPriceIntents(variant({ price: '0.10', compareAtPrice: '0.1000000000000001' }), 'GBP')
    expect(intents).toHaveLength(2)
    expect(intents[1]!.amount).toBe('0.10')
  })

  it('writes no price at all when the variant has none', () => {
    expect(toPriceIntents(variant({ price: null }), 'GBP')).toEqual([])
    expect(toPriceIntents(variant({ price: 'not money' }), 'GBP')).toEqual([])
  })

  it('builds the composite external id from plan §4.8', () => {
    const [intent] = toPriceIntents(variant(), 'GBP')
    expect(intent!.externalId).toBe('gid://shopify/ProductVariant/11:price:regular::GBP')
  })
})

describe('mapPrice', () => {
  it('passes the decimal string through untouched', () => {
    const [intent] = toPriceIntents(variant({ price: '1.10' }), 'GBP')
    const input = mapPrice(intent!, 'local-variant-1', 'kind-regular', SCOPE)

    expect(input).toEqual({
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      variantId: 'local-variant-1',
      priceKindId: 'kind-regular',
      currencyCode: 'GBP',
      unitPriceGross: '1.10',
    })
    // Not 1.1, and not a number.
    expect(typeof input.unitPriceGross).toBe('string')
  })
})

describe('resolveCurrencyCode', () => {
  it('reads the currency off priceRangeV2', () => {
    expect(resolveCurrencyCode(product(), 'USD')).toBe('GBP')
  })

  it('falls back to the shop currency when the product has no priced variant', () => {
    expect(resolveCurrencyCode(product({ priceRangeV2: null }), 'USD')).toBe('USD')
    expect(
      resolveCurrencyCode(product({ priceRangeV2: { maxVariantPrice: { currencyCode: null } } }), 'USD'),
    ).toBe('USD')
  })

  it('rejects a currency code that is not three letters', () => {
    expect(
      resolveCurrencyCode(product({ priceRangeV2: { maxVariantPrice: { currencyCode: 'POUNDS' } } }), 'USD'),
    ).toBe('USD')
  })
})
