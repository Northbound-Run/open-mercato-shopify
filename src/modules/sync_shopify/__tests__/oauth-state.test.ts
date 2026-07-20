import {
  DEFAULT_STATE_TTL_MS,
  STATE_COOKIE_NAME,
  buildStateClearCookie,
  buildStateCookie,
  createNonce,
  readCookie,
  serializeState,
  verifyState,
  type OAuthStatePayload,
} from '../lib/oauth-state'

const SECRET = 'shpss_test_secret'
const SESSION = { userId: 'user-1', tenantId: 'tenant-1', organizationId: 'org-1' }
const NOW = 1_800_000_000_000

function payload(overrides: Partial<OAuthStatePayload> = {}): OAuthStatePayload {
  return {
    nonce: 'nonce-abc',
    shopDomain: 'mystore.myshopify.com',
    integrationId: 'sync_shopify',
    userId: SESSION.userId,
    tenantId: SESSION.tenantId,
    organizationId: SESSION.organizationId,
    issuedAt: NOW,
    ...overrides,
  }
}

function verify(cookieValue: string | null, overrides: Partial<Parameters<typeof verifyState>[0]> = {}) {
  return verifyState({
    cookieValue,
    stateParam: 'nonce-abc',
    shopDomain: 'mystore.myshopify.com',
    secret: SECRET,
    session: SESSION,
    nowMs: NOW,
    ...overrides,
  })
}

describe('createNonce', () => {
  it('produces distinct, url-safe, high-entropy nonces', () => {
    const a = createNonce()
    const b = createNonce()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.length).toBeGreaterThanOrEqual(43)
  })
})

describe('verifyState', () => {
  it('accepts a well-formed round-trip', () => {
    const result = verify(serializeState(payload(), SECRET))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.shopDomain).toBe('mystore.myshopify.com')
  })

  it('rejects a missing cookie', () => {
    expect(verify(null)).toEqual({ ok: false, reason: 'missing_cookie' })
    expect(verify('')).toEqual({ ok: false, reason: 'missing_cookie' })
  })

  it.each([['no-separator'], ['.'], ['payload.'], ['.signature']])('rejects malformed cookie %s', (value) => {
    const result = verify(value)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(['malformed', 'bad_signature']).toContain(result.reason)
  })

  it('rejects a tampered payload', () => {
    const cookie = serializeState(payload(), SECRET)
    const [encoded, signature] = cookie.split('.')
    const forged = Buffer.from(
      JSON.stringify(payload({ organizationId: 'org-attacker' })),
      'utf8',
    ).toString('base64url')
    expect(verify(`${forged}.${signature}`)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(encoded).not.toBe(forged)
  })

  it('rejects a cookie signed with a different secret', () => {
    const cookie = serializeState(payload(), 'other_secret')
    expect(verify(cookie)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects an expired state', () => {
    const cookie = serializeState(payload(), SECRET)
    const result = verify(cookie, { nowMs: NOW + DEFAULT_STATE_TTL_MS + 1 })
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('accepts right up to the TTL boundary', () => {
    const cookie = serializeState(payload(), SECRET)
    expect(verify(cookie, { nowMs: NOW + DEFAULT_STATE_TTL_MS }).ok).toBe(true)
  })

  it('rejects a state issued in the future', () => {
    const cookie = serializeState(payload({ issuedAt: NOW + 60_000 }), SECRET)
    expect(verify(cookie)).toEqual({ ok: false, reason: 'expired' })
  })

  // The replay case: a valid, unexpired cookie replayed against a different `state` value.
  it('rejects a nonce mismatch', () => {
    const cookie = serializeState(payload(), SECRET)
    expect(verify(cookie, { stateParam: 'different-nonce' })).toEqual({
      ok: false,
      reason: 'nonce_mismatch',
    })
    expect(verify(cookie, { stateParam: null })).toEqual({ ok: false, reason: 'nonce_mismatch' })
  })

  it('rejects a shop mismatch', () => {
    const cookie = serializeState(payload(), SECRET)
    expect(verify(cookie, { shopDomain: 'other.myshopify.com' })).toEqual({
      ok: false,
      reason: 'shop_mismatch',
    })
  })

  it('is case-insensitive on the shop domain', () => {
    const cookie = serializeState(payload(), SECRET)
    expect(verify(cookie, { shopDomain: 'MyStore.MyShopify.com' }).ok).toBe(true)
  })

  // Guards against completing someone else's flow in your own session.
  it.each([
    [{ userId: 'user-2' }],
    [{ tenantId: 'tenant-2' }],
    [{ organizationId: 'org-2' }],
  ])('rejects a session mismatch on %o', (sessionOverride) => {
    const cookie = serializeState(payload(), SECRET)
    expect(verify(cookie, { session: { ...SESSION, ...sessionOverride } })).toEqual({
      ok: false,
      reason: 'session_mismatch',
    })
  })

  it('rejects a structurally valid but wrongly-typed payload', () => {
    const encoded = Buffer.from(JSON.stringify({ nonce: 42 }), 'utf8').toString('base64url')
    const { createHmac } = require('node:crypto') as typeof import('node:crypto')
    const signature = createHmac('sha256', SECRET).update(encoded).digest('base64url')
    expect(verify(`${encoded}.${signature}`)).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('cookie helpers', () => {
  it('builds a hardened state cookie', () => {
    const cookie = buildStateCookie('value')
    expect(cookie).toContain(`${STATE_COOKIE_NAME}=value`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('Path=/')
    expect(cookie).toMatch(/Max-Age=\d+/)
  })

  it('allows dropping Secure for local http development', () => {
    expect(buildStateCookie('value', { secure: false })).not.toContain('Secure')
  })

  it('builds an immediately-expiring clear cookie', () => {
    expect(buildStateClearCookie()).toContain('Max-Age=0')
  })

  it('reads a named cookie out of a header', () => {
    const header = `other=1; ${STATE_COOKIE_NAME}=abc.def; another=2`
    expect(readCookie(header, STATE_COOKIE_NAME)).toBe('abc.def')
    expect(readCookie(header, 'missing')).toBeNull()
    expect(readCookie(null, STATE_COOKIE_NAME)).toBeNull()
  })

  it('does not confuse a cookie whose name is a suffix of another', () => {
    expect(readCookie(`x_${STATE_COOKIE_NAME}=wrong; ${STATE_COOKIE_NAME}=right`, STATE_COOKIE_NAME)).toBe(
      'right',
    )
  })
})
