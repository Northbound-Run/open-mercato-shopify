import { probeConnection, type ProbeStep } from '../lib/probe'

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

const TOKEN_BODY = { access_token: 'shpat_token', scope: 'read_products', expires_in: 86399 }

function shopBody(myshopifyDomain: string) {
  return {
    data: { shop: { name: 'My Store', myshopifyDomain, currencyCode: 'USD' } },
    extensions: {
      cost: {
        requestedQueryCost: 1,
        throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1999, restoreRate: 100 },
      },
    },
  }
}

function stub(myshopifyDomain: string) {
  return async (url: string) =>
    url.includes('/admin/oauth/access_token') ? json(TOKEN_BODY) : json(shopBody(myshopifyDomain))
}

const step = (steps: ProbeStep[], name: string) => steps.find((s) => s.name === name)

// Observed against a real store: connecting as mystore.myshopify.com returned a canonical
// myshopifyDomain of store-internal-42.myshopify.com. Left unflagged, two integrations reaching one store
// via different aliases would be treated as two stores and duplicate every record.
describe('canonical domain reconciliation', () => {
  it('warns when the store reports a different canonical domain', async () => {
    const result = await probeConnection({ ...BASE, fetchImpl: stub('store-internal-42.myshopify.com') as never })

    const warning = step(result.steps, 'Canonical domain')
    expect(warning?.status).toBe('warning')
    expect(warning?.detail).toContain('mystore.myshopify.com')
    expect(warning?.detail).toContain('store-internal-42.myshopify.com')
    expect(warning?.hint).toContain('store-internal-42.myshopify.com')
    // An alias is a working connection, not a broken one.
    expect(result.ok).toBe(true)
  })

  it('stays quiet when the domains agree', async () => {
    const result = await probeConnection({
      ...BASE,
      fetchImpl: stub('mystore.myshopify.com') as never,
    })
    expect(step(result.steps, 'Canonical domain')).toBeUndefined()
    expect(result.ok).toBe(true)
  })

  it('does not warn on a mere case difference', async () => {
    const result = await probeConnection({
      ...BASE,
      fetchImpl: stub('MyStore.MyShopify.com') as never,
    })
    expect(step(result.steps, 'Canonical domain')).toBeUndefined()
  })
})
