import { ShopifyAuthError } from '../lib/shop-domain'
import {
  CLIENT_CREDENTIALS_TOKEN_TTL_SECONDS,
  createTokenProvider,
  requestAccessToken,
  type AccessToken,
} from '../lib/token'

const BASE = {
  shopDomain: 'mystore.myshopify.com',
  clientId: 'client-abc',
  clientSecret: 'shpss_secret',
}
const NOW = 1_800_000_000_000

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const okBody = { access_token: 'shpat_token', scope: 'read_products,read_orders', expires_in: 86399 }

describe('requestAccessToken', () => {
  it('performs a form-encoded client_credentials grant', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const token = await requestAccessToken({
      ...BASE,
      nowMs: NOW,
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return jsonResponse(okBody)
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://mystore.myshopify.com/admin/oauth/access_token')
    expect(calls[0]!.init?.method).toBe('POST')
    // Shopify wants form encoding for this grant, not JSON.
    expect((calls[0]!.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )

    const body = new URLSearchParams(String(calls[0]!.init?.body))
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('client_id')).toBe('client-abc')
    expect(body.get('client_secret')).toBe('shpss_secret')
    // No redirect_uri and no code: that is the whole point of this grant.
    expect(body.get('code')).toBeNull()
    expect(body.get('redirect_uri')).toBeNull()

    expect(token.accessToken).toBe('shpat_token')
    expect(token.grantedScopes).toEqual(['read_products', 'read_orders'])
    expect(token.expiresAtMs).toBe(NOW + 86399 * 1000)
  })

  it('never sends the client secret to a non-myshopify host', async () => {
    const fetchImpl = jest.fn()
    await expect(
      requestAccessToken({ ...BASE, shopDomain: 'evil.com', fetchImpl }),
    ).rejects.toThrow(ShopifyAuthError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('flags bad credentials distinctly from a transport failure', async () => {
    await expect(
      requestAccessToken({ ...BASE, fetchImpl: async () => jsonResponse({ error: 'x' }, 401) }),
    ).rejects.toMatchObject({ code: 'invalid_client' })

    await expect(
      requestAccessToken({ ...BASE, fetchImpl: async () => jsonResponse({ error: 'x' }, 500) }),
    ).rejects.toMatchObject({ code: 'token_request_failed' })
  })

  it('does not leak the response body, which echoes the submitted secret', async () => {
    await expect(
      requestAccessToken({
        ...BASE,
        fetchImpl: async () => jsonResponse({ client_secret: 'shpss_secret' }, 400),
      }),
    ).rejects.not.toThrow(/shpss_secret/)
  })

  it('rejects a 200 with no access_token', async () => {
    await expect(
      requestAccessToken({ ...BASE, fetchImpl: async () => jsonResponse({ scope: 'read_products' }) }),
    ).rejects.toThrow(/no access_token/)
  })

  it('rejects a non-JSON body', async () => {
    await expect(
      requestAccessToken({ ...BASE, fetchImpl: async () => new Response('<html/>') }),
    ).rejects.toThrow(/non-JSON/)
  })

  it('wraps network failures', async () => {
    await expect(
      requestAccessToken({
        ...BASE,
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED')
        },
      }),
    ).rejects.toMatchObject({ code: 'network_error' })
  })

  // If Shopify ever changes the TTL, trusting the response beats a hardcoded 24h that would
  // keep using a dead token.
  it('honours the returned expires_in over the documented constant', async () => {
    const token = await requestAccessToken({
      ...BASE,
      nowMs: NOW,
      fetchImpl: async () => jsonResponse({ ...okBody, expires_in: 3600 }),
    })
    expect(token.expiresAtMs).toBe(NOW + 3600 * 1000)
  })

  it('falls back to the documented TTL when expires_in is absent or nonsense', async () => {
    for (const expires of [undefined, 0, -1, 'soon']) {
      const token = await requestAccessToken({
        ...BASE,
        nowMs: NOW,
        fetchImpl: async () => jsonResponse({ ...okBody, expires_in: expires }),
      })
      expect(token.expiresAtMs).toBe(NOW + CLIENT_CREDENTIALS_TOKEN_TTL_SECONDS * 1000)
    }
  })
})

describe('createTokenProvider', () => {
  function harness(startMs = NOW) {
    let now = startMs
    let mints = 0
    const provider = createTokenProvider({
      ...BASE,
      now: () => now,
      fetchImpl: async () => {
        mints += 1
        return jsonResponse({ ...okBody, access_token: `shpat_${mints}` })
      },
    })
    return { provider, advance: (ms: number) => { now += ms }, mintCount: () => mints }
  }

  it('mints once and then serves from cache', async () => {
    const { provider, mintCount } = harness()
    expect((await provider.getToken()).accessToken).toBe('shpat_1')
    expect((await provider.getToken()).accessToken).toBe('shpat_1')
    expect(mintCount()).toBe(1)
  })

  it('re-mints once the token nears expiry', async () => {
    const { provider, advance, mintCount } = harness()
    await provider.getToken()
    // 24h TTL with a 5min skew — just inside the skew window should already renew.
    advance((86399 - 60) * 1000)
    expect((await provider.getToken()).accessToken).toBe('shpat_2')
    expect(mintCount()).toBe(2)
  })

  it('renews early enough to cover clock skew', async () => {
    const { provider, advance, mintCount } = harness()
    await provider.getToken()
    advance(86399 * 1000 - 6 * 60 * 1000) // 6 min before expiry: still outside the 5 min skew
    await provider.getToken()
    expect(mintCount()).toBe(1)
  })

  // A backfill fanning out on startup would otherwise stampede the token endpoint.
  it('coalesces concurrent callers into a single request', async () => {
    const { provider, mintCount } = harness()
    const tokens = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ])
    expect(mintCount()).toBe(1)
    expect(new Set(tokens.map((t) => t.accessToken)).size).toBe(1)
  })

  it('re-mints after invalidate, which is how a mid-run 401 recovers', async () => {
    const { provider, mintCount } = harness()
    await provider.getToken()
    provider.invalidate()
    expect((await provider.getToken()).accessToken).toBe('shpat_2')
    expect(mintCount()).toBe(2)
  })

  it('recovers from a failed mint rather than caching the failure', async () => {
    let attempt = 0
    const provider = createTokenProvider({
      ...BASE,
      now: () => NOW,
      fetchImpl: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('boom')
        return jsonResponse(okBody)
      },
    })
    await expect(provider.getToken()).rejects.toThrow()
    expect((await provider.getToken()).accessToken).toBe('shpat_token')
  })

  it('reports the cached token without triggering a request', async () => {
    const { provider, mintCount } = harness()
    expect(provider.peek()).toBeNull()
    await provider.getToken()
    expect(provider.peek()?.accessToken).toBe('shpat_1')
    expect(mintCount()).toBe(1)
  })

  it('notifies on each new token so it can be persisted', async () => {
    const seen: AccessToken[] = []
    const provider = createTokenProvider({
      ...BASE,
      now: () => NOW,
      onToken: (token) => { seen.push(token) },
      fetchImpl: async () => jsonResponse(okBody),
    })
    await provider.getToken()
    await provider.getToken()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.accessToken).toBe('shpat_token')
  })

  it('uses a seeded token to avoid a request on cold start', async () => {
    let mints = 0
    const provider = createTokenProvider({
      ...BASE,
      now: () => NOW,
      initialToken: {
        accessToken: 'shpat_persisted',
        grantedScopes: ['read_products'],
        expiresAtMs: NOW + 60 * 60 * 1000,
      },
      fetchImpl: async () => {
        mints += 1
        return jsonResponse(okBody)
      },
    })
    expect((await provider.getToken()).accessToken).toBe('shpat_persisted')
    expect(mints).toBe(0)
  })

  it('ignores a seeded token that has already expired', async () => {
    const provider = createTokenProvider({
      ...BASE,
      now: () => NOW,
      initialToken: {
        accessToken: 'shpat_stale',
        grantedScopes: [],
        expiresAtMs: NOW - 1000,
      },
      fetchImpl: async () => jsonResponse(okBody),
    })
    expect((await provider.getToken()).accessToken).toBe('shpat_token')
  })
})
