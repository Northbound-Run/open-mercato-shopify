import {
  ShopifyAuthError,
  missingScopes,
  normalizeShopDomain,
  orderHistoryWindow,
  parseScopeList,
} from '../lib/shop-domain'

describe('normalizeShopDomain', () => {
  it.each([
    ['mystore.myshopify.com', 'mystore.myshopify.com'],
    ['  MyStore.MyShopify.com  ', 'mystore.myshopify.com'],
    ['https://mystore.myshopify.com', 'mystore.myshopify.com'],
    ['https://mystore.myshopify.com/admin/products', 'mystore.myshopify.com'],
    ['my-store-123.myshopify.com', 'my-store-123.myshopify.com'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeShopDomain(input)).toBe(expected)
  })

  // These are the cases that would POST the client secret to an attacker-controlled host.
  it.each([
    ['evil.com'],
    ['mystore.myshopify.com.evil.com'],
    ['evil.com/mystore.myshopify.com'],
    ['https://evil.com'],
    ['myshopify.com'],
    ['-bad.myshopify.com'],
    ['mystore.myshopify.net'],
    [''],
  ])('rejects %s', (input) => {
    expect(() => normalizeShopDomain(input)).toThrow(ShopifyAuthError)
  })

  it('rejects null and undefined', () => {
    expect(() => normalizeShopDomain(null)).toThrow(ShopifyAuthError)
    expect(() => normalizeShopDomain(undefined)).toThrow(ShopifyAuthError)
  })
})

describe('parseScopeList', () => {
  it('splits and trims a comma-separated scope string', () => {
    expect(parseScopeList('read_products, read_orders ,read_customers')).toEqual([
      'read_products',
      'read_orders',
      'read_customers',
    ])
  })

  it('returns an empty list for empty input', () => {
    expect(parseScopeList('')).toEqual([])
    expect(parseScopeList(null)).toEqual([])
    expect(parseScopeList(undefined)).toEqual([])
  })
})

describe('scope helpers', () => {
  it('reports scopes the app was not configured with', () => {
    expect(missingScopes(['read_products'])).toEqual(['read_customers', 'read_orders'])
    expect(missingScopes(['read_products', 'read_customers', 'read_orders'])).toEqual([])
  })

  it('derives the order history window from granted scopes', () => {
    expect(orderHistoryWindow(['read_orders'])).toBe('sixty_days')
    expect(orderHistoryWindow(['read_orders', 'read_all_orders'])).toBe('full')
  })
})
