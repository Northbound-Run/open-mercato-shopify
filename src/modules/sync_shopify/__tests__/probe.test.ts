import { formatProbeResult, probeConnection, type ProbeStep } from '../lib/probe'

const BASE = {
  shopDomain: 'mystore.myshopify.com',
  clientId: 'client-abc',
  clientSecret: 'shpss_secret',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const TOKEN_BODY = {
  access_token: 'shpat_token',
  scope: 'read_products,read_customers,read_orders',
  expires_in: 86399,
}

const SHOP_BODY = {
  data: {
    shop: {
      name: 'My Store',
      myshopifyDomain: 'mystore.myshopify.com',
      currencyCode: 'GBP',
      plan: { displayName: 'Shopify Plus' },
    },
  },
  extensions: {
    cost: {
      requestedQueryCost: 1,
      actualQueryCost: 1,
      throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1999, restoreRate: 100 },
    },
  },
}

/** Routes token requests vs GraphQL requests to separate stubs. */
function stubFetch(handlers: {
  token?: (url: string) => Response | Promise<Response>
  graphql?: (url: string) => Response | Promise<Response>
}) {
  return async (url: string) => {
    if (url.includes('/admin/oauth/access_token')) {
      return handlers.token ? handlers.token(url) : json(TOKEN_BODY)
    }
    return handlers.graphql ? handlers.graphql(url) : json(SHOP_BODY)
  }
}

const step = (steps: ProbeStep[], name: string) => steps.find((s) => s.name.startsWith(name))

describe('probeConnection — success', () => {
  it('reports every step ok and surfaces store details', async () => {
    const result = await probeConnection({ ...BASE, fetchImpl: stubFetch({}) as never })

    expect(result.ok).toBe(true)
    expect(step(result.steps, 'Shop domain')?.status).toBe('ok')
    expect(step(result.steps, 'Credentials')?.status).toBe('ok')
    expect(step(result.steps, 'Access token')?.status).toBe('ok')
    expect(step(result.steps, 'Admin API')?.status).toBe('ok')
    expect(step(result.steps, 'Scopes')?.status).toBe('ok')
    expect(result.shop).toEqual({
      name: 'My Store',
      myshopifyDomain: 'mystore.myshopify.com',
      currencyCode: 'GBP',
      plan: 'Shopify Plus',
    })
    expect(result.grantedScopes).toEqual(['read_products', 'read_customers', 'read_orders'])
  })

  // A 60-day order window is a normal, supported configuration — it must warn without failing,
  // otherwise the probe is useless as a health check for most installs.
  it('warns but still passes when only the 60-day order window is available', async () => {
    const result = await probeConnection({ ...BASE, fetchImpl: stubFetch({}) as never })
    expect(result.ok).toBe(true)
    expect(result.orderHistoryWindow).toBe('sixty_days')
    expect(step(result.steps, 'Order history')?.status).toBe('warning')
    expect(step(result.steps, 'Order history')?.hint).toMatch(/read_all_orders/)
  })

  it('reports full history when read_all_orders is granted', async () => {
    const result = await probeConnection({
      ...BASE,
      fetchImpl: stubFetch({
        token: () => json({ ...TOKEN_BODY, scope: `${TOKEN_BODY.scope},read_all_orders` }),
      }) as never,
    })
    expect(result.orderHistoryWindow).toBe('full')
    expect(step(result.steps, 'Order history')?.status).toBe('ok')
  })

  it('warns on missing scopes but does not fail the connection', async () => {
    const result = await probeConnection({
      ...BASE,
      fetchImpl: stubFetch({ token: () => json({ ...TOKEN_BODY, scope: 'read_products' }) }) as never,
    })
    expect(result.ok).toBe(true)
    expect(result.missingScopes).toEqual(['read_customers', 'read_orders'])
    expect(step(result.steps, 'Scopes')?.status).toBe('warning')
  })
})

describe('probeConnection — failures are diagnosed distinctly', () => {
  it('rejects a bad shop domain without touching the network', async () => {
    const fetchImpl = jest.fn()
    const result = await probeConnection({ ...BASE, shopDomain: 'evil.com', fetchImpl: fetchImpl as never })

    expect(result.ok).toBe(false)
    expect(step(result.steps, 'Shop domain')?.status).toBe('failed')
    // The security property: the client secret is never sent anywhere for an invalid domain.
    expect(fetchImpl).not.toHaveBeenCalled()
    // And it stops immediately rather than reporting misleading downstream failures.
    expect(step(result.steps, 'Access token')).toBeUndefined()
  })

  it.each([
    ['client secret', { ...BASE, clientSecret: '' }],
    ['client id', { ...BASE, clientId: '' }],
  ])('fails fast on a missing %s', async (_label, input) => {
    const fetchImpl = jest.fn()
    const result = await probeConnection({ ...input, fetchImpl: fetchImpl as never })
    expect(result.ok).toBe(false)
    expect(step(result.steps, 'Credentials')?.status).toBe('failed')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('distinguishes rejected credentials from a missing store', async () => {
    const rejected = await probeConnection({
      ...BASE,
      fetchImpl: stubFetch({ token: () => json({ error: 'x' }, 401) }) as never,
    })
    expect(rejected.ok).toBe(false)
    expect(step(rejected.steps, 'Access token')?.hint).toMatch(/INSTALLED on this store/)

    const missing = await probeConnection({
      ...BASE,
      fetchImpl: stubFetch({ token: () => json({ error: 'x' }, 404) }) as never,
    })
    expect(missing.ok).toBe(false)
    expect(step(missing.steps, 'Access token')?.hint).toMatch(/No Shopify store exists/)
  })

  it('reports a token that mints but is rejected by the Admin API', async () => {
    const result = await probeConnection({
      ...BASE,
      fetchImpl: stubFetch({
        // Wire format: GraphQL `errors` is an ARRAY. The SDK normalises it into
        // `{ graphQLErrors: [...] }` before we see it, so stubbing that inner shape directly
        // would test a fiction.
        graphql: () =>
          json({ errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }] }),
      }) as never,
    })
    expect(result.ok).toBe(false)
    expect(step(result.steps, 'Access token')?.status).toBe('ok')
    expect(step(result.steps, 'Admin API')?.status).toBe('failed')
    expect(step(result.steps, 'Admin API')?.hint).toMatch(/not installed/)
  })

  it('never leaks the client secret into a failure message', async () => {
    const result = await probeConnection({
      ...BASE,
      fetchImpl: stubFetch({ token: () => json({ client_secret: 'shpss_secret' }, 400) }) as never,
    })
    expect(JSON.stringify(result)).not.toMatch(/shpss_secret/)
  })
})

describe('formatProbeResult', () => {
  it('renders steps, hints and store details', async () => {
    const result = await probeConnection({ ...BASE, fetchImpl: stubFetch({}) as never })
    const text = formatProbeResult(result)

    expect(text).toMatch(/✓ Shop domain/)
    expect(text).toMatch(/My Store/)
    expect(text).toMatch(/GBP/)
    expect(text).toMatch(/Connection OK\./)
    // Hints only render for non-ok steps, so a clean run stays readable.
    expect(text).toMatch(/! Order history/)
  })

  it('renders a failure without a store block', async () => {
    const result = await probeConnection({ ...BASE, shopDomain: 'evil.com', fetchImpl: jest.fn() as never })
    const text = formatProbeResult(result)
    expect(text).toMatch(/✗ Shop domain/)
    expect(text).toMatch(/Connection FAILED\./)
    expect(text).not.toMatch(/Store\n/)
  })
})
