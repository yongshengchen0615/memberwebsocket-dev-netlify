// FJG-01/02: server-only verifier. This module is deliberately not connected to
// membership activation until the tenant's linked member OA is verified.
export class MemberOaFriendshipError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'MemberOaFriendshipError';
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => { throw new MemberOaFriendshipError(status, code, message); };
const unavailable = () => fail(503, 'LINE_FRIENDSHIP_UNAVAILABLE', '暫時無法確認 LINE 好友資格，請稍後重試。');

/**
 * Check an already ID-token-verified person against their tenant's *linked*
 * member OA. Every parameter except accessToken must originate on the server:
 * - expectedChannelId: tenant's LINE Login channel (not Messaging API channel)
 * - expectedLineUserId: sub from a server-verified ID token for that channel
 * - memberOaLinked: trusted operator-verified link (same LINE Provider)
 * The access token is used in-memory only and must never be logged or persisted.
 */
export async function verifyMemberOaFriendship({
  expectedChannelId, expectedLineUserId, memberOaLinked,
  accessToken, fetchImpl = fetch, timeoutMs = 10000,
} = {}) {
  if (!/^\d{5,30}$/.test(String(expectedChannelId || '')) || memberOaLinked !== true) {
    fail(503, 'MEMBER_OA_CONFIG_INCOMPLETE', '商家會員 LINE 官方帳號尚未完成連結設定。');
  }
  if (!/^U[0-9a-f]{32}$/i.test(String(expectedLineUserId || ''))) {
    fail(401, 'AUTH_INVALID', 'LINE 登入已失效，請重新登入。');
  }
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 4096) {
    fail(401, 'LINE_ACCESS_TOKEN_REQUIRED', '請重新登入 LINE 並授權會員資訊。');
  }
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    fail(503, 'MEMBER_OA_CONFIG_INCOMPLETE', '商家 LINE 驗證服務設定不正確。');
  }

  async function lineRequest(url, useBearer = false) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: useBearer ? { Authorization: `Bearer ${accessToken}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { unavailable(); }
    if (response.status === 401 || response.status === 400) {
      fail(401, 'LINE_ACCESS_TOKEN_INVALID', 'LINE 登入已失效，請重新登入。');
    }
    if (!response.ok) unavailable();
    try {
      const payload = await response.json();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) unavailable();
      return payload;
    } catch { unavailable(); }
  }

  // LINE documents this verification endpoint as a GET with access_token in
  // the query string. Do not log request URLs (the query contains a secret).
  const verifyUrl = new URL('https://api.line.me/oauth2/v2.1/verify');
  verifyUrl.searchParams.set('access_token', accessToken);
  const credentials = await lineRequest(verifyUrl);
  if (String(credentials.client_id || '') !== expectedChannelId ||
      !String(credentials.scope || '').split(/\s+/).includes('profile') ||
      !Number.isFinite(Number(credentials.expires_in)) || Number(credentials.expires_in) <= 0) {
    fail(401, 'LINE_CHANNEL_OR_SCOPE_MISMATCH', 'LINE 登入帳號與商家會員入口不一致，請重新登入。');
  }
  const profile = await lineRequest('https://api.line.me/v2/profile', true);
  if (String(profile.userId || '') !== expectedLineUserId) {
    fail(401, 'LINE_IDENTITY_MISMATCH', 'LINE 登入身分與會員資料不一致，請重新登入。');
  }
  const friendship = await lineRequest('https://api.line.me/friendship/v1/status', true);
  if (friendship.friendFlag === false) {
    fail(403, 'MEMBER_OA_FRIENDSHIP_REQUIRED', '請先加入此商家的會員 LINE 官方帳號好友。');
  }
  if (friendship.friendFlag !== true) unavailable();
  return true;
}
