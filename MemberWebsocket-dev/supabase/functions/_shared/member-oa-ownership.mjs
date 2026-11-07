// Verified merchant OA discovery; intentionally NOT proof that a LINE Login
// channel is linked to this bot. Never turn this result into an activation grant.
import { PlatformError } from './platform-policy.mjs';
import { verifyNotificationToken } from './notification-routes.mjs';

export async function inspectMemberOaOwnership({line,credentials,fetchImpl=fetch}) {
  const memberLoginChannelId=String(line?.memberChannelId||'');
  const memberLiffId=String(line?.memberLiffId||'');
  const messagingChannelId=String(line?.messagingChannelId||'');
  if (!/^\d{5,30}$/.test(memberLoginChannelId)
      || !memberLiffId.startsWith(memberLoginChannelId+'-')
      || !/^\d{5,30}-[A-Za-z0-9_-]+$/.test(memberLiffId))
    throw new PlatformError(409,'MEMBER_LINE_INCOMPLETE','請先儲存正確的會員 LINE Login Channel 與會員卡 LIFF ID。');
  if (!/^\d{5,30}$/.test(messagingChannelId) || !credentials?.channelAccessToken)
    throw new PlatformError(409,'MEMBER_OA_TOKEN_REQUIRED','請先在會員卡區塊儲存 Messaging API Channel ID、Channel access token 與 Channel secret。');
  await verifyNotificationToken(credentials.channelAccessToken,messagingChannelId,fetchImpl);
  let response,bot;
  try {
    response=await fetchImpl('https://api.line.me/v2/bot/info',{
      method:'GET',headers:{Authorization:'Bearer '+credentials.channelAccessToken},
      signal:AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('bot-info');
    bot=await response.json();
  } catch {
    throw new PlatformError(503,'MEMBER_OA_LOOKUP_UNAVAILABLE','LINE 官方帳號資料暫時無法確認，請稍後重試。');
  }
  if (!/^@[A-Za-z0-9._-]{3,40}$/.test(String(bot?.basicId||''))
      || !/^U[0-9a-f]{32}$/i.test(String(bot?.userId||'')))
    throw new PlatformError(503,'MEMBER_OA_LOOKUP_INVALID','LINE 官方帳號回傳資料不完整，無法確認綁定。');
  return Object.freeze({
    memberLoginChannelId,messagingChannelId,memberOaId:bot.basicId,
    // Provider/linked-Login identity is NOT present in bot/info.
    linkedLoginVerified:false,
  });
}
