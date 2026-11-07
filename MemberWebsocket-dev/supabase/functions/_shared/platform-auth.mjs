import { PlatformError } from './platform-policy.mjs';

// The platform has its own LINE Login channel. Never accept a merchant channel
// from request bodies, public config, or LINE_ADMIN_CHANNEL_ID here.
export const PLATFORM_CHANNEL_ID = '2012065297';

export const MERCHANT_ADMIN_CHANNEL_ID = '2010791619';
export const verifyPlatformIdToken = options => verifyChannelToken(options, PLATFORM_CHANNEL_ID, '總管理員');
// channelId is resolved from the trusted business record by the handler.
export const verifyMerchantAdminIdToken = (options, channelId = MERCHANT_ADMIN_CHANNEL_ID) => verifyChannelToken(options, channelId, '一般管理員');

async function verifyChannelToken({ idToken, fetchImpl = globalThis.fetch, now = Date.now }, channelId, label) {
  if (typeof idToken !== 'string' || !idToken || idToken.length > 10_000) {
    throw new PlatformError(401, 'AUTH_REQUIRED', '請使用總管理員 LINE 帳號登入。');
  }
  const unavailable = () => new PlatformError(503, 'LINE_AUTH_UNAVAILABLE', 'LINE 身分驗證服務暫時無法使用。');
  let response, payload;
  try {
    response = await fetchImpl('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429 || response.status >= 500) throw unavailable();
    payload = await response.json();
  } catch { throw unavailable(); }
  const time = now() / 1000;
  if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.aud !== channelId || payload.iss !== 'https://access.line.me'
    || typeof payload.sub !== 'string' || !/^U[0-9a-f]{32}$/.test(payload.sub)
    || !Number.isFinite(payload.exp) || payload.exp <= time
    || !Number.isFinite(payload.iat) || payload.iat <= 0 || payload.iat > time + 60 || payload.exp <= payload.iat) {
    throw new PlatformError(401, 'AUTH_INVALID', `${label} LINE 登入已失效，請重新登入。`);
  }
  // Authorization is checked separately against the singleton platform owner on
  // every request. Merchant maintenance and member session grants do not apply.
  return { lineUserId: payload.sub, displayName: String(payload.name || 'LINE 使用者').slice(0, 120), issuedAtMs: payload.iat * 1000 };
}

