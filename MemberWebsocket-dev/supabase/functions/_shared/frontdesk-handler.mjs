import { PlatformError } from './platform-policy.mjs';
import { verifyFrontdeskIdToken } from './platform-auth.mjs';
import { openCredentials } from './platform-crypto.mjs';
import { readRequestBytes } from './request-ingress.mjs';
const actions=new Map([['frontdesk.public','public'],['frontdesk.apply','apply'],['frontdesk.bootstrap','bootstrap'],['frontdesk.bookings','bookings'],['frontdesk.sync.status','sync.status'],['frontdesk.booking.update','booking.update'],['frontdesk.phone.catalog','phone.catalog'],['frontdesk.phone.slots','phone.slots'],['frontdesk.phone.create','phone.create']]);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function frontdeskDatabaseError(error){
 const text=String(error?.message||'');
 const messages={FRONTDESK_OA_STALE:[409,'櫃檯官方帳號設定已變更，請重新整理後再次申請。'],FRONTDESK_UNAVAILABLE:[403,'此商家的櫃檯服務尚未開放或已停用。'],FRONTDESK_AUTH_INVALID:[401,'櫃檯登入已失效，請重新登入。'],FRONTDESK_REVIEW_REQUIRED:[403,'你目前沒有確認或拒絕預約的權限。'],FRONTDESK_OA_STALE:[409,'櫃檯官方帳號設定已變更，請重新申請。'],FRONTDESK_OA_REQUIRED:[409,'請先加入此商家的櫃檯官方帳號好友。'],FRONTDESK_NOT_FOUND:[404,'找不到此商家的資料。'],FRONTDESK_REQUEST_CONFLICT:[409,'此操作識別碼已用於不同內容。'],FRONTDESK_CHANNEL_CONFLICT:[409,'此 LINE 通道已屬於其他商家。'],BOOKING_CONFLICT:[409,'預約已變更，請重新整理後確認。'],BOOKING_REJECTION_REASON_REQUIRED:[400,'請先選擇拒絕預約原因。'],BOOKING_CANCELLATION_PENDING:[409,'此預約有待審核的取消申請，請交由商家管理員處理。'],PLATFORM_CONFLICT:[409,'資料已變更，請重新整理。'],PLATFORM_INVALID_INPUT:[400,'資料格式不正確。'],PLATFORM_IMMUTABLE_IDENTITY:[409,'已有櫃檯身分的登入入口不可任意更換。']};
 for(const [code,[status,message]]of Object.entries(messages))if(text.includes(code))return new PlatformError(status,code,message);
 return new PlatformError(503,'FRONTDESK_DATABASE_UNAVAILABLE','目前無法確認櫃檯服務，請稍後重試。');
}
export function createFrontdeskHandler({db,allowedOrigins,verifyIdentity=(idToken,channel)=>verifyFrontdeskIdToken({idToken},channel),encryptionKey,fetchImpl=fetch}){
 return async request=>{
  const origin=request.headers.get('Origin'),headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin','Access-Control-Allow-Origin':allowedOrigins.has(origin)?origin:'','Access-Control-Allow-Headers':'content-type,apikey','Access-Control-Allow-Methods':'POST,OPTIONS'};
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
  const rpc=async(name,args)=>{const r=await db.rpc(name,args);if(r.error)throw frontdeskDatabaseError(r.error);return r.data;};
  try{
   if(origin&&!allowedOrigins.has(origin))throw new PlatformError(403,'ORIGIN_NOT_ALLOWED','此網站來源未被允許。');
   if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
   if(request.method!=='POST')throw new PlatformError(405,'METHOD_NOT_ALLOWED','不支援此請求方式。');
   let body;try{body=JSON.parse(new TextDecoder().decode(await readRequestBytes(request,16000)));}catch(error){throw new PlatformError(error.status||400,'INVALID_JSON','請求格式不正確。');}
   if(!body||Array.isArray(body)||!actions.has(body.action)||typeof body.business!=='string'||! /^[a-z][a-z0-9-]{2,39}$/.test(body.business))throw new PlatformError(400,'INVALID_ACTION','櫃檯入口或操作不正確。');
   if(body.action==='frontdesk.bookings'&&body.bookingId!==undefined&&!uuid.test(body.bookingId))throw new PlatformError(400,'PLATFORM_INVALID_INPUT','預約識別碼不正確。');
   if(body.action==='frontdesk.booking.update'&&(!uuid.test(body.bookingId||'')||!uuid.test(body.requestId||'')||!['confirmed','rejected'].includes(body.status)||typeof body.expectedUpdatedAt!=='string'||!Number.isFinite(Date.parse(body.expectedUpdatedAt))||(body.note!==undefined&&typeof body.note!=='string')))throw new PlatformError(400,'PLATFORM_INVALID_INPUT','預約操作資料不正確。');
   if(body.action==='frontdesk.booking.update'&&(body.status==='rejected'?!['technician_leave','unrecorded_phone_booking'].includes(body.rejectionReason):body.rejectionReason!==undefined))throw new PlatformError(400,'BOOKING_REJECTION_REASON_REQUIRED','請先選擇有效的拒絕預約原因。');
   if(['frontdesk.phone.slots','frontdesk.phone.create'].includes(body.action)){
    const items=body.items;
    if(!Array.isArray(items)||items.length<1||items.length>20||
       items.some(item=>!item||!uuid.test(item.serviceId||'')||!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>2)||
       new Set(items.map(item=>item.serviceId)).size!==items.length||
       typeof body.bookingDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(body.bookingDate)||!Number.isFinite(Date.parse(body.bookingDate+'T00:00:00Z')))
      throw new PlatformError(400,'PLATFORM_INVALID_INPUT','請輸入有效的預約日期與項目。');
   }
   if(body.action==='frontdesk.phone.create'&&(
       typeof body.requestId!=='string'||!/^PHONE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId)||
       typeof body.startTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.startTime)||
       typeof body.contactSurname!=='string'||!body.contactSurname.trim()||body.contactSurname.length>40||
       !['mr','ms'].includes(body.contactSalutation)||
       (body.contactPhone!==undefined&&(typeof body.contactPhone!=='string'||body.contactPhone.length>35))||
       (body.adminNote!==undefined&&(typeof body.adminNote!=='string'||body.adminNote.length>500))))
      throw new PlatformError(400,'PLATFORM_INVALID_INPUT','電話預約資料格式不正確。');
   const publicAction=body.action==='frontdesk.public';
   // Before any tenant lookup or provider call, bound anonymous ingress too.
   const principal=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('frontdesk:'+body.business+':'+(request.headers.get('x-forwarded-for')||'')));
   const hash=Array.from(new Uint8Array(principal),b=>b.toString(16).padStart(2,'0')).join('');
   if(!await rpc('consume_api_rate_limit',{p_principal_hash:hash,p_is_write:false,p_cost:1,p_read_limit:120,p_write_limit:15}))throw new PlatformError(429,'RATE_LIMITED','操作過於頻繁，請稍後再試。');
   const context=await rpc('platform_frontdesk_context',{p_slug:body.business});
   if(publicAction)return json({ok:true,data:{business:context.slug,name:context.name,frontdesk:context.frontdesk}});
   const identity=await verifyIdentity(body.idToken,context.frontdesk?.loginChannelId);
   const identityHash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('frontdesk:'+context.id+':'+identity.lineUserId));
   if(!await rpc('consume_api_rate_limit',{p_principal_hash:Array.from(new Uint8Array(identityHash),b=>b.toString(16).padStart(2,'0')).join(''),p_is_write:['frontdesk.apply','frontdesk.booking.update','frontdesk.phone.create'].includes(body.action),p_cost:1,p_read_limit:90,p_write_limit:15}))throw new PlatformError(429,'RATE_LIMITED','操作過於頻繁，請稍後再試。');
   const input=body.action==='frontdesk.booking.update'?{bookingId:body.bookingId,status:body.status,expectedUpdatedAt:body.expectedUpdatedAt,requestId:body.requestId,note:body.note,rejectionReason:body.rejectionReason}:body.action==='frontdesk.bookings'?{bookingId:body.bookingId}:body.action==='frontdesk.phone.slots'?{bookingDate:body.bookingDate,items:body.items}:body.action==='frontdesk.phone.create'?{requestId:body.requestId,bookingDate:body.bookingDate,startTime:body.startTime,items:body.items,contactSurname:body.contactSurname,contactSalutation:body.contactSalutation,contactPhone:body.contactPhone,adminNote:body.adminNote}:{};
   if(body.action==='frontdesk.apply'){
    const routes=await rpc('platform_notification_credentials',{p_tenant_id:context.id,p_feature:'booking'}),route=routes?.frontdesk;
    if(route?.mode!=='custom'||!route.envelope)throw new PlatformError(409,'FRONTDESK_OA_REQUIRED','請先請管理員啟用櫃檯官方帳號。');
    const credentials=await openCredentials(context.id+':booking:notify:frontdesk',route.envelope,await encryptionKey());
    // Verifies this authenticated sub is reachable through the configured bot,
    // never infers a global Login-to-bot binding from bot/info.
    let profile;try{const r=await fetchImpl('https://api.line.me/v2/bot/profile/'+identity.lineUserId,{headers:{Authorization:'Bearer '+credentials.channelAccessToken},signal:AbortSignal.timeout(8000)});if(r.ok)profile=await r.json();else if(r.status>=500||r.status===429)throw Error('provider');}
    catch{throw new PlatformError(503,'LINE_AUTH_UNAVAILABLE','LINE 暫時無法驗證官方帳號好友，請稍後重試。');}
    if(profile?.userId!==identity.lineUserId)throw new PlatformError(409,'FRONTDESK_OA_REQUIRED','請先加入本商家的櫃檯官方帳號好友，再送出申請。');
    Object.assign(input,{displayName:identity.displayName,oaVerified:true,verifiedMessagingChannelId:context.frontdesk.messagingChannelId,verifiedConfigRevision:context.frontdesk.revision});
   }
   const data=await rpc('platform_frontdesk_request',{p_tenant_id:context.id,p_actor:identity.lineUserId,p_channel_id:context.frontdesk.loginChannelId,p_issued_at:new Date(identity.issuedAtMs).toISOString(),p_action:actions.get(body.action),p_body:input});
   if(['frontdesk.booking.update','frontdesk.phone.create'].includes(body.action)){try{await db.rpc('platform_dispatch_booking',{p_tenant_id:context.id});}catch{/* durable outbox recovery */}}
   return json({ok:true,data});
  }catch(error){const status=error.status||503;return json({ok:false,error:{code:error.code||'FRONTDESK_UNAVAILABLE',message:error.status?error.message:'櫃檯服務暫時無法使用。'}},status);}
 };
}
