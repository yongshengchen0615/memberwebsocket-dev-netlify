import { PlatformError } from './platform-policy.mjs';
export const notificationPurposes = feature => feature === 'booking' ? ['admin','member'] : ['member'];
export function validateNotificationRoute(body) {
  if (!['membership','points','events','calendar','booking'].includes(body.feature)
    || !notificationPurposes(body.feature).includes(body.purpose)
    || !['inherit','custom','disabled'].includes(body.mode))
    throw new PlatformError(400,'INVALID_NOTIFICATION_ROUTE','通知功能、用途或模式不正確。');
  if (body.mode === 'custom' && (!/^\d{5,30}$/.test(body.messagingChannelId || '')
    || typeof body.channelAccessToken !== 'string' || body.channelAccessToken.length < 20
    || body.channelAccessToken.length > 4000 || /\s/.test(body.channelAccessToken)))
    throw new PlatformError(400,'INVALID_NOTIFICATION_CREDENTIALS','請輸入 Messaging API Channel ID 與 long-lived channel access token。');
}
export async function verifyNotificationToken(token, channelId, fetchImpl = fetch) {
  let response, data;
  try {
    response = await fetchImpl('https://api.line.me/v2/oauth/verify', {method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({access_token:token}),signal:AbortSignal.timeout(8000)});
    data = await response.json();
  } catch { throw new PlatformError(503,'LINE_NOTIFICATION_UNAVAILABLE','LINE 驗證暫時無法連線，請稍後重試。'); }
  if (!response.ok || String(data.client_id || '') !== channelId || !(Number(data.expires_in) > 0))
    throw new PlatformError(400,'LINE_NOTIFICATION_INVALID','Token 已失效或不屬於此 Messaging API Channel。請重新發行 long-lived token。');
}
export function notificationToken(context, purpose = 'member') {
  if (Object.hasOwn(context.notificationCredentials || {}, purpose)) return context.notificationCredentials[purpose];
  return context.credentials?.channelAccessToken || '';
}
