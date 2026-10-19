// Shared, server-side product control contract. No credentials belong in responses.
import { merchantOnboarding } from './merchant-onboarding.mjs';
export const FEATURES = Object.freeze({
  membership: '會員卡', points: '集點卡', events: '活動票券', calendar: '營運日曆',
  integrations: '整合中心', booking: '預約', testing: '測試', usage: '使用紀錄',
});
export class PlatformError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const invalid = (message) => { throw new PlatformError(400, 'INVALID_TENANT', message); };
const text = (value, name, max, required = true) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid(`${name}格式不正確。`);
  return value.trim();
};
export function validateTenant(input, creating = true, { allowIncompleteFeatureLiffs = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('商家資料格式不正確。');
  const allowed = ['name', 'slug', 'ownerLineUserId', 'features', 'line', 'credentials'];
  if (Object.keys(input).some(k => !allowed.includes(k))) invalid('含有不允許修改的欄位。');
  const name = text(input.name, '商家名稱', 100);
  const slug = text(input.slug, '商家代碼', 40);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug) || slug.length < 3 || ['admin','platform','api','www','root','system'].includes(slug)) invalid('商家代碼需為 3–40 位小寫英數字與連字號。');
  const ownerLineUserId = text(input.ownerLineUserId, '管理員 LINE User ID', 33);
  if (!/^U[0-9a-f]{32}$/.test(ownerLineUserId)) invalid('管理員 LINE User ID 格式不正確。');
  const features = input.features;
  if (!features || typeof features !== 'object' || Array.isArray(features)
    || Object.keys(features).length !== Object.keys(FEATURES).length
    || Object.keys(FEATURES).some(k => typeof features[k] !== 'boolean')
    || Object.keys(features).some(k => !(k in FEATURES))) invalid('請明確設定全部八項功能權限。');
  const line = input.line;
  const lineKeys = ['adminChannelId','memberChannelId','messagingChannelId','adminLiffId','memberLiffId','pointsLiffId','eventLiffId','calendarLiffId','bookingLiffId'];
  if (!line || typeof line !== 'object' || Array.isArray(line) || Object.keys(line).some(k => !lineKeys.includes(k))) invalid('LINE 設定格式不正確。');
  const normalized = {};
  for (const k of ['adminChannelId','memberChannelId','messagingChannelId']) {
    normalized[k] = text(line[k], k, 30);
    if (!/^\d{5,30}$/.test(normalized[k])) invalid(`${k} 必須是有效 Channel ID。`);
  }
  const required = { admin: true, member: !allowIncompleteFeatureLiffs && features.membership, points: !allowIncompleteFeatureLiffs && features.points, event: !allowIncompleteFeatureLiffs && features.events, calendar: !allowIncompleteFeatureLiffs && features.calendar, booking: !allowIncompleteFeatureLiffs && features.booking };
  for (const [surface, needed] of Object.entries(required)) {
    const k = `${surface}LiffId`;
    normalized[k] = text(line[k] ?? '', k, 100, needed);
    const channel = normalized[surface === 'admin' ? 'adminChannelId' : 'memberChannelId'];
    if (normalized[k] && (!/^\d{5,30}-[A-Za-z0-9_-]+$/.test(normalized[k]) || !normalized[k].startsWith(`${channel}-`))) invalid(`${k} 與 Channel ID 不一致。`);
  }
  const credentials = input.credentials;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)
    || Object.keys(credentials).some(k => !['channelAccessToken','channelSecret'].includes(k))) invalid('LINE 憑證格式不正確。');
  const channelAccessToken = text(credentials.channelAccessToken ?? '', 'Channel access token', 4000, creating);
  const channelSecret = text(credentials.channelSecret ?? '', 'Channel secret', 128, creating);
  if ((channelAccessToken && (channelAccessToken.length < 20 || /\s/.test(channelAccessToken)))
    || (channelSecret && !/^[a-fA-F0-9]{32}$/.test(channelSecret))) invalid('LINE 憑證格式不正確。');
  if (Boolean(channelAccessToken) !== Boolean(channelSecret)) invalid('更新憑證時請同時提供 access token 與 secret。');
  return { name, slug, ownerLineUserId, features: Object.fromEntries(Object.keys(FEATURES).map(k => [k, features[k]])), line: normalized, credentials: { channelAccessToken, channelSecret } };
}
export function requireFeature(tenant, feature) {
  if (!tenant || tenant.status !== 'active' || !tenant.isolation_verified_at) {
    throw new PlatformError(409, 'TENANT_NOT_READY', '商家尚未完成獨立資料環境驗證，暫時無法使用。');
  }
  if (!Object.hasOwn(FEATURES, feature) || tenant.features?.[feature] !== true) {
    throw new PlatformError(403, 'FEATURE_DISABLED', '此商家未開放這項功能。');
  }
}
export function publicTenant(row) {
  // Explicit projection; no token, ciphertext or privileged actor fields.
  // Approval only unlocks LINE configuration. Data-plane readiness is a
  // separate, server-derived signal and never overrides API authorization.
  const dataPlaneVerified = row.status === 'active'
    && Boolean(row.isolation_verified_at) && Boolean(row.isolation_version);
  return { id: row.id, name: row.name, slug: row.slug, ownerLineUserId: row.owner_line_user_id,
    features: row.features, line: row.line_config, status: row.status, version: row.version,
    credentialsConfigured: row.credentials_configured === true,
    onboarding: merchantOnboarding({status:row.status,features:row.features,line:row.line_config,
      credentialsConfigured:row.credentials_configured === true}),
    capabilities: {
      lineSettingsEnabled: row.status !== 'suspended',
      dataPlaneVerified,
      grantedFeatures: Object.fromEntries(Object.keys(FEATURES).map(key =>
        [key, row.features?.[key] === true])),
    },
    createdAt: row.created_at, updatedAt: row.updated_at };
}
