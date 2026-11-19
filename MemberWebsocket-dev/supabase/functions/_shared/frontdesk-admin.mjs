import { PlatformError } from './platform-policy.mjs';
import { sealCredentials } from './platform-crypto.mjs';
import { verifyNotificationToken } from './notification-routes.mjs';
import { frontdeskDatabaseError } from './frontdesk-handler.mjs';
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');
export async function frontdeskAdmin({db,body,actor,issuedAt,tenant,encryptionKey,fetchImpl}){
 const action={'platform.frontdesk.get':'get','platform.frontdesk.settings.save':'settings.save','platform.frontdesk.staff.save':'staff.save'}[body.action];
 if(!tenant?.id)throw new PlatformError(403,'BUSINESS_FORBIDDEN','請先選擇自己的商家。');
 if(tenant.features?.frontdesk!==true || tenant.features?.booking!==true)
  throw new PlatformError(403,'FEATURE_DISABLED','此商家尚未開通櫃檯設定或預約功能。');
 let input={};
 if(action!=='get'){
  if(!/^[0-9a-f-]{36}$/i.test(body.requestId||'')||!Number.isSafeInteger(body.expectedVersion))throw new PlatformError(400,'PLATFORM_INVALID_INPUT','操作識別碼或版本不正確。');
  input={requestId:body.requestId,expectedVersion:body.expectedVersion};
  if(action==='settings.save'){
   const raw=body.settings||{},line={loginChannelId:raw.loginChannelId,liffId:raw.liffId,messagingChannelId:raw.messagingChannelId,enabled:raw.enabled},token=body.channelAccessToken;
   if(!/^\d{5,30}$/.test(line.loginChannelId||'')||!/^\d{5,30}-[A-Za-z0-9_-]+$/.test(line.liffId||'')||!line.liffId.startsWith(line.loginChannelId+'-')||typeof line.enabled!=='boolean')throw new PlatformError(400,'PLATFORM_INVALID_INPUT','請填寫正確的櫃檯 Login Channel 與 LIFF ID。');
   const disabling=line.enabled===false&&!token;
   if(!/^\d{5,30}$/.test(line.messagingChannelId||'')||(!disabling&&(typeof token!=='string'||token.length<20||token.length>4000||/\s/.test(token))))throw new PlatformError(400,'PLATFORM_INVALID_INPUT','請填寫完整的櫃檯 Messaging Channel 與 access token。');
   input.payloadHash=await digest({action,line,token,expectedVersion:body.expectedVersion});
   const replay=await db.rpc('platform_frontdesk_replay',{p_actor:actor,p_tenant_id:tenant.id,p_issued_at:issuedAt,p_request_id:body.requestId,p_hash:input.payloadHash,p_action:action});
   if(replay.error)throw frontdeskDatabaseError(replay.error);if(replay.data)return replay.data;
   if(disabling){
    Object.assign(input,line,{envelope:null});
    const result=await db.rpc('platform_frontdesk_admin',{p_actor:actor,p_tenant_id:tenant.id,p_issued_at:issuedAt,p_action:action,p_body:input});
    if(result.error)throw frontdeskDatabaseError(result.error);return result.data;
   }
   await verifyNotificationToken(token,line.messagingChannelId,fetchImpl);
   let bot;try{const r=await fetchImpl('https://api.line.me/v2/bot/info',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('bot');bot=await r.json();}catch{throw new PlatformError(503,'LINE_AUTH_UNAVAILABLE','無法確認櫃檯官方帳號。');}
   if(!/^@[A-Za-z0-9._-]{3,40}$/.test(bot.basicId||''))throw new PlatformError(400,'PLATFORM_INVALID_INPUT','官方帳號資料不完整。');
   const envelope=await sealCredentials(tenant.id+':booking:notify:frontdesk',{channelAccessToken:token},await encryptionKey());
   Object.assign(input,line,{oaId:bot.basicId,envelope});
  }else{
   Object.assign(input,{staffId:body.staffId,status:body.status,permissionMode:body.permissionMode});input.payloadHash=await digest(input);
  }
 }
 const r=await db.rpc('platform_frontdesk_admin',{p_actor:actor,p_tenant_id:tenant.id,p_issued_at:issuedAt,p_action:action,p_body:input});
 if(r.error)throw frontdeskDatabaseError(r.error);return r.data;
}
