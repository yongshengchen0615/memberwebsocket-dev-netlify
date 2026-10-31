import { PlatformError } from './platform-policy.mjs';
import { openCredentials } from './platform-crypto.mjs';
import { verifyNotificationToken } from './notification-routes.mjs';

// Gateways may rewrite request.url to an internal HTTP URL without /functions/v1.
// Advertise only the explicitly configured public project origin.
export function lineWebhookEndpoint(publicSupabaseUrl) {
  const unavailable=()=>new PlatformError(503,'WEBHOOK_ENDPOINT_UNAVAILABLE','Webhook 公開接收網址尚未正確設定，請聯絡管理員。');
  let url;
  try { url=new URL(publicSupabaseUrl); } catch { throw unavailable(); }
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw unavailable();
  return url.origin+'/functions/v1/line-webhook';
}

// The Provider check is read-only: it never changes the LINE webhook URL or sends.
export async function checkLineWebhook({candidate,encryptionKey,fetchImpl=fetch}) {
  if(!candidate)throw new PlatformError(409,'WEBHOOK_NOT_CONFIGURED','目前僅設定 LIFF 入口；需要接收 Webhook 時，再儲存本功能 Messaging API Channel、Token 與 Secret。');
  const scope=candidate.tenantId+(candidate.scope==='module'?':'+candidate.feature:'');
  const credentials=await openCredentials(scope,candidate.envelope,await encryptionKey());
  if(!credentials.channelSecret)throw new PlatformError(409,'WEBHOOK_NOT_CONFIGURED','請先儲存本功能的 Channel secret。');
  await verifyNotificationToken(credentials.channelAccessToken,candidate.channelId,fetchImpl);
  let response,data;
  try {
    response=await fetchImpl('https://api.line.me/v2/bot/info',{method:'GET',headers:{Authorization:'Bearer '+credentials.channelAccessToken},signal:AbortSignal.timeout(8000)});
    data=await response.json();
  }catch{throw new PlatformError(503,'LINE_WEBHOOK_UNAVAILABLE','LINE 連線檢查暫時無法完成，請稍後重試。');}
  if(!response.ok||!/^U[0-9a-f]{32}$/.test(data?.userId||''))
    throw new PlatformError(400,'LINE_WEBHOOK_INVALID','無法確認此 Channel 的官方帳號，請檢查 Messaging API Token。');
  return data.userId;
}
