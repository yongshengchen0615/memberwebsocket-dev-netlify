/**
 * Defense-in-depth validation for the claims returned by LINE's ID-token verify
 * endpoint. The provider response is still required; this is not local JWT
 * signature verification and must never be used on unverified token payloads.
 */
export function isVerifiedLineIdClaim(payload, expectedChannelId, nowMs = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (typeof expectedChannelId !== 'string' || !expectedChannelId) return false;
  const { sub, aud, iss, exp, iat } = payload;
  const nowSeconds = nowMs / 1000;
  return typeof sub === 'string' && /^U[0-9a-f]{32}$/.test(sub)
    && aud === expectedChannelId
    && iss === 'https://access.line.me'
    && typeof exp === 'number' && Number.isFinite(exp)
    && typeof iat === 'number' && Number.isFinite(iat)
    && iat > 0 && iat <= nowSeconds + 60
    && exp > nowSeconds && exp > iat;
}
