import {
  ShopifyOAuthError,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  missingScopes,
  normalizeShopDomain,
  orderHistoryWindow,
} from '../lib/oauth'

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

  // These are the cases that would leak the client secret or open-redirect if accepted.
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
    expect(() => normalizeShopDomain(input)).toThrow(ShopifyOAuthError)
  })

  it('rejects null and undefined', () => {
    expect(() => normalizeShopDomain(null)).toThrow(ShopifyOAuthError)
    expect(() => normalizeShopDomain(undefined)).toThrow(ShopifyOAuthError)
  })
})

describe('buildAuthorizeUrl', () => {
  const base = {
    shopDomain: 'mystore.myshopify.com',
    clientId: 'client-abc',
    redirectUri: 'https://app.example.com/api/sync_shopify/oauth/callback',
    state: 'nonce-xyz',
  }

  it('builds the per-shop authorize URL with encoded params', () => {
    const url = new URL(buildAuthorizeUrl(base))
    expect(url.origin).toBe('https://mystore.myshopify.com')
    expect(url.pathname).toBe('/admin/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('client-abc')
    expect(url.searchParams.get('redirect_uri')).toBe(base.redirectUri)
    expect(url.searchParams.get('state')).toBe('nonce-xyz')
    expect(url.searchParams.get('scope')).toBe('read_products,read_customers,read_orders')
  })

  it('honours an explicit scope list', () => {
    const url = new URL(buildAuthorizeUrl({ ...base, scopes: ['read_products'] }))
    expect(url.searchParams.get('scope')).toBe('read_products')
  })

  it('refuses a non-myshopify domain', () => {
    expect(() => buildAuthorizeUrl({ ...base, shopDomain: 'evil.com' })).toThrow(ShopifyOAuthError)
  })
})

describe('exchangeCodeForToken', () => {
  const base = {
    shopDomain: 'mystore.myshopify.com',
    clientId: 'client-abc',
    clientSecret: 'shpss_secret',
    code: 'auth-code',
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('posts to the shop token endpoint and returns the token plus granted scopes', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const result = await exchangeCodeForToken({
      ...base,
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return jsonResponse({ access_token: 'shpat_token', scope: 'read_products,read_orders' })
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://mystore.myshopify.com/admin/oauth/access_token')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      client_id: 'client-abc',
      client_secret: 'shpss_secret',
      code: 'auth-code',
    })
    expect(result.accessToken).toBe('shpat_token')
    expect(result.grantedScopes).toEqual(['read_products', 'read_orders'])
  })

  it('never sends the client secret to a non-myshopify host', async () => {
    const fetchImpl = jest.fn()
    await expect(
      exchangeCodeForToken({ ...base, shopDomain: 'evil.com', fetchImpl }),
    ).rejects.toThrow(ShopifyOAuthError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not leak the response body on failure', async () => {
    await expect(
      exchangeCodeForToken({
        ...base,
        fetchImpl: async () => jsonResponse({ error: 'bad', client_secret: 'shpss_secret' }, 400),
      }),
    ).rejects.toThrow(/HTTP 400/)

    await expect(
      exchangeCodeForToken({
        ...base,
        fetchImpl: async () => jsonResponse({ error: 'bad', client_secret: 'shpss_secret' }, 400),
      }),
    ).rejects.not.toThrow(/shpss_secret/)
  })

  it('rejects a 200 with no access_token', async () => {
    await expect(
      exchangeCodeForToken({ ...base, fetchImpl: async () => jsonResponse({ scope: 'read_products' }) }),
    ).rejects.toThrow(/no access_token/)
  })

  it('rejects a non-JSON body', async () => {
    await expect(
      exchangeCodeForToken({ ...base, fetchImpl: async () => new Response('<html>nope</html>') }),
    ).rejects.toThrow(/non-JSON/)
  })

  it('wraps network failures', async () => {
    await expect(
      exchangeCodeForToken({
        ...base,
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED')
        },
      }),
    ).rejects.toThrow(/token exchange request failed/)
  })

  it('tolerates a response with no scope field', async () => {
    const result = await exchangeCodeForToken({
      ...base,
      fetchImpl: async () => jsonResponse({ access_token: 'shpat_token' }),
    })
    expect(result.grantedScopes).toEqual([])
  })
})

describe('scope helpers', () => {
  it('reports scopes Shopify silently withheld', () => {
    expect(missingScopes(['read_products'])).toEqual(['read_customers', 'read_orders'])
    expect(missingScopes(['read_products', 'read_customers', 'read_orders'])).toEqual([])
  })

  it('derives the order history window from granted scopes', () => {
    expect(orderHistoryWindow(['read_orders'])).toBe('sixty_days')
    expect(orderHistoryWindow(['read_orders', 'read_all_orders'])).toBe('full')
  })
})
