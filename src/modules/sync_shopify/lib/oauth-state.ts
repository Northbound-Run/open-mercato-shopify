import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * CSRF protection for the Shopify OAuth round-trip.
 *
 * Shopify echoes an opaque `state` back on the callback but stores nothing for us, so the
 * binding between "who started this flow" and "who is completing it" has to be carried by us.
 *
 * Design (ported from the sync-google-sheets reference, which is the one part of that package
 * worth copying outright):
 *   - `state` is an opaque random nonce. It is the only thing that travels via Shopify.
 *   - The real payload (nonce + who + where) is HMAC-signed and stored in an httpOnly,
 *     SameSite=Lax cookie, so it never leaves the browser↔app channel.
 *   - On callback we verify the signature, check the TTL, constant-time-compare the nonce, and
 *     re-check that the payload's user/tenant still match the live session.
 *
 * The signing key is the app's client secret, so no additional env var is needed.
 */

export const STATE_COOKIE_NAME = 'om_shopify_oauth_state'
export const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000

export type OAuthStatePayload = {
  /** Opaque nonce echoed through Shopify as `state`. */
  nonce: string
  /** Shop the flow was started for; must match the callback's `shop` param. */
  shopDomain: string
  /** Integration/bundle the credentials will be written to. */
  integrationId: string
  userId: string
  tenantId: string
  organizationId: string
  /** Epoch millis. */
  issuedAt: number
}

export type StateVerification =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: StateFailureReason }

export type StateFailureReason =
  | 'missing_cookie'
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'nonce_mismatch'
  | 'shop_mismatch'
  | 'session_mismatch'

export function createNonce(): string {
  return randomBytes(32).toString('base64url')
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url')
}

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Serialise a signed `<payload>.<signature>` cookie value. */
export function serializeState(payload: OAuthStatePayload, secret: string): string {
  const encoded = base64UrlJson(payload)
  return `${encoded}.${sign(encoded, secret)}`
}

/**
 * Verify a callback. Checks, in order: cookie present, well-formed, signature valid, not
 * expired, nonce matches the `state` Shopify echoed, shop matches, and session still matches.
 *
 * Signature failures are checked BEFORE the payload is trusted for anything.
 */
export function verifyState(input: {
  cookieValue: string | null | undefined
  stateParam: string | null | undefined
  shopDomain: string | null | undefined
  secret: string
  session: { userId: string; tenantId: string; organizationId: string }
  nowMs?: number
  ttlMs?: number
}): StateVerification {
  const { cookieValue, stateParam, shopDomain, secret, session } = input
  const nowMs = input.nowMs ?? Date.now()
  const ttlMs = input.ttlMs ?? DEFAULT_STATE_TTL_MS

  if (!cookieValue) return { ok: false, reason: 'missing_cookie' }

  const separator = cookieValue.lastIndexOf('.')
  if (separator <= 0 || separator === cookieValue.length - 1) {
    return { ok: false, reason: 'malformed' }
  }

  const encoded = cookieValue.slice(0, separator)
  const signature = cookieValue.slice(separator + 1)
  if (!safeEqual(signature, sign(encoded, secret))) {
    return { ok: false, reason: 'bad_signature' }
  }

  let payload: OAuthStatePayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OAuthStatePayload
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (
    typeof payload?.nonce !== 'string' ||
    typeof payload?.issuedAt !== 'number' ||
    typeof payload?.shopDomain !== 'string'
  ) {
    return { ok: false, reason: 'malformed' }
  }

  if (nowMs - payload.issuedAt > ttlMs || nowMs < payload.issuedAt) {
    return { ok: false, reason: 'expired' }
  }
  if (!stateParam || !safeEqual(stateParam, payload.nonce)) {
    return { ok: false, reason: 'nonce_mismatch' }
  }
  if (!shopDomain || shopDomain.toLowerCase() !== payload.shopDomain.toLowerCase()) {
    return { ok: false, reason: 'shop_mismatch' }
  }
  if (
    payload.userId !== session.userId ||
    payload.tenantId !== session.tenantId ||
    payload.organizationId !== session.organizationId
  ) {
    return { ok: false, reason: 'session_mismatch' }
  }

  return { ok: true, payload }
}

/** `Set-Cookie` value for the state cookie. Host-only, httpOnly, SameSite=Lax (OAuth redirects back via GET). */
export function buildStateCookie(value: string, opts?: { secure?: boolean; ttlMs?: number }): string {
  const maxAge = Math.floor((opts?.ttlMs ?? DEFAULT_STATE_TTL_MS) / 1000)
  const parts = [
    `${STATE_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]
  if (opts?.secure !== false) parts.push('Secure')
  return parts.join('; ')
}

/** Expire the state cookie. Always call this on the callback, success or failure. */
export function buildStateClearCookie(opts?: { secure?: boolean }): string {
  const parts = [`${STATE_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (opts?.secure !== false) parts.push('Secure')
  return parts.join('; ')
}

/** Read one cookie out of a raw `Cookie` header. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}
