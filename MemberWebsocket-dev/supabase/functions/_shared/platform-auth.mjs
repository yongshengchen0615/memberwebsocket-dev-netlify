import { PlatformError } from './platform-policy.mjs';

// Legacy/local verifier defaults. Hosted entrypoints resolve their deployment
// channels from a server-pinned config URL, never from request bodies or Origin.
export const PLATFORM_CHANNEL_ID = '2012065297';

export const MERCHANT_ADMIN_CHANNEL_ID = '2010791619';
export const verifyPlatformIdToken = options => verifyChannelToken(options, PLATFORM_CHANNEL_ID, '總管理員');
// channelId is resolved from the trusted business record by the handler.
export const verifyMerchantAdminIdToken = (options, channelId = MERCHANT_ADMIN_CHANNEL_ID) => verifyChannelToken(options, channelId, '一般管理員');

function requireIdToken(idToken) {
  if (typeof idToken !== 'string' || !idToken || idToken.length > 10_000) {
    throw new PlatformError(401, 'AUTH_REQUIRED', '請使用總管理員 LINE 帳號登入。');
  }
}

// Only these operator-controlled deployment origins may configure account LINE
// audiences. Tenant audiences still come from the handler's trusted DB record.
const deploymentOrigins = Object.freeze({
  'https://dbuquirnaskrwcamdxki.supabase.co': 'https://memberwebsocket-dev-netlify.netlify.app',
  'https://bmwhojszsnxliekkhrka.supabase.co': 'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app',
});
export function createDeploymentLineVerifiers({ projectUrl, fetchImpl = globalThis.fetch, now = Date.now }) {
  let cached = null, loadedAt = 0, pending = null;
  const unavailable = () => new PlatformError(503, 'LINE_CONFIG_UNAVAILABLE', '無法確認本環境 LINE 設定，請稍後重新登入。');
  async function channels() {
    const age = now() - loadedAt;
    if (cached && age >= 0 && age < 60_000) return cached;
    if (pending) return pending;
    pending = (async () => {
      const origin = Object.hasOwn(deploymentOrigins, projectUrl) ? deploymentOrigins[projectUrl] : null;
      if (!origin) throw unavailable();
      try {
        const response = await fetchImpl(origin + '/config/config.json', {
          cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw unavailable();
        const config = await response.json();
        if (!config || Array.isArray(config) || config.supabaseUrl !== projectUrl
          || config.supabaseFunctionUrl !== projectUrl + '/functions/v1/api'
          || !/^\d{10}-[A-Za-z0-9]+$/.test(config.platformLiffId || '')
          || !/^\d{10}-[A-Za-z0-9]+$/.test(config.adminLiffId || '')
          || config.platformLiffId === config.adminLiffId) throw unavailable();
        cached = Object.freeze({ platform: config.platformLiffId.split('-')[0], admin: config.adminLiffId.split('-')[0] });
        loadedAt = now();
        return cached;
      } catch { throw unavailable(); }
    })();
    try { return await pending; }
    finally { pending = null; }
  }
  return Object.freeze({
    async verifyIdentity(idToken) {
      requireIdToken(idToken);
      return verifyChannelToken({ idToken, fetchImpl, now }, (await channels()).platform, '總管理員');
    },
    async verifyApplicantIdentity(idToken, trustedChannel) {
      requireIdToken(idToken);
      return verifyChannelToken({ idToken, fetchImpl, now }, trustedChannel ?? (await channels()).admin, '一般管理員');
    },
  });
}

async function verifyChannelToken({ idToken, fetchImpl = globalThis.fetch, now = Date.now }, channelId, label) {
  requireIdToken(idToken);
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

