import { createClient as baseClient } from 'npm:@supabase/supabase-js@2.57.0';
import { assertBusinessAction,businessBootstrap,actionFeatures } from './business-policy.mjs';
import { openCredentials } from './platform-crypto.mjs';
import { resolvePlatformEncryptionKey } from './platform-key.mjs';
import { tenantExpired, assertTenantIdentity } from './tenant-access.mjs';
import { verifyMerchantAdminIdToken } from './platform-auth.mjs';
import { merchantOnboarding, featureLineReady } from './merchant-onboarding.mjs';
import { wakeBookingNotifications } from './booking-notification-wake.mjs';
import { notificationToken } from './notification-routes.mjs';
export type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.0';
type Context=Record<string,any>;
import { scope, rawEnv, businessContext, businessEnv, businessFetch } from './business-scope.ts';
export { businessContext, businessEnv, businessFetch } from './business-scope.ts';
const control=()=>baseClient(rawEnv('SUPABASE_URL'),rawEnv('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
const relative=(path:unknown,c:Context)=>{
 const p=String(path||'');if(!p||p.startsWith('/')||p.split('/').some(x=>x==='..'||x==='.')||p.includes('\\'))throw Error('INVALID_STORAGE_PATH');
 return c.id+'/'+p;
};
function storageAdapter(storage:any,c:Context){return new Proxy(storage,{get(target,key){
 if(c.authorizeExternal&&['createBucket','updateBucket','emptyBucket','deleteBucket'].includes(String(key)))
  return(...args:any[])=>c.authorizeExternal().then(()=>target[key](...args));
 if(key!=='from')return typeof target[key]==='function'?target[key].bind(target):target[key];
 return(bucket:string)=>{const client=target.from(bucket);return new Proxy(client,{get(object,method){
  const original=object[method];if(typeof original!=='function')return original;
  return(...args:any[])=>{
   if(['remove','createSignedUrls'].includes(String(method)))args[0]=args[0].map((p:string)=>relative(p,c));
   else if(['move','copy'].includes(String(method))){args[0]=relative(args[0],c);args[1]=relative(args[1],c);}
   else if(String(method)==='list')args[0]=args[0]?relative(args[0],c):c.id;
   else if(['upload','update','download','createSignedUrl','createSignedUploadUrl','getPublicUrl','info','exists'].includes(String(method)))args[0]=relative(args[0],c);
   if(c.authorizeExternal&&['upload','update','remove','move','copy','createSignedUploadUrl'].includes(String(method)))
    return c.authorizeExternal().then(()=>original.apply(object,args));
   return original.apply(object,args);
  };
 }});};
}});}
export function createClient(url:string,key:string,options?:any):import('npm:@supabase/supabase-js@2.57.0').SupabaseClient{
 const args=[url,key,options] as const;
 const c=scope.getStore();if(!c)return baseClient(...args);
 const client=baseClient(args[0],args[1],{...args[2],db:{...args[2]?.db,schema:c.runtime_schema},global:{...args[2]?.global,
  fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{
   const active=scope.getStore();if(active&&active.id!==c.id)throw Error('CROSS_BUSINESS_SCHEMA');
   const current=active||c,headers=new Headers(input instanceof Request?input.headers:undefined);
   new Headers(init?.headers).forEach((value,key)=>headers.set(key,value));
   // These markers are created only after provider verification, never copied
   // from request/caller headers. PostgREST validates and locks this authority
   // in the same transaction as every scoped table/RPC statement.
   for(const name of ['x-platform-admin-actor','x-platform-admin-tenant','x-platform-admin-issued-at'])headers.delete(name);
   if(current.verifiedAdmin){
    headers.set('x-platform-admin-actor',current.verifiedAdmin.actor);
    headers.set('x-platform-admin-tenant',current.id);
    headers.set('x-platform-admin-issued-at',current.verifiedAdmin.issuedAt);
   }
   init={...init,headers};
   for(let attempt=0;;attempt++){
    const result=await (args[2]?.global?.fetch||fetch)(input,init);
    if(result.ok||attempt>=6)return result;
    const error=await result.clone().json().catch(()=>null);
    // These PostgREST errors occur before SQL executes. Approval reloads its
    // schema cache asynchronously; retry only these known, non-executed requests.
    if(!['PGRST106','PGRST202','PGRST204','PGRST205'].includes(error?.code))return result;
    await new Promise(resolve=>setTimeout(resolve,250));
   }
  }}} as any);
 return new Proxy(client,{get(target,key){
  if(key==='storage')return storageAdapter(target.storage,c);
  if(key==='schema')return(name:string)=>{if(name!==c.runtime_schema)throw Error('CROSS_BUSINESS_SCHEMA');return client;};
  if(key==='rpc')return(name:string,params?:any,options?:any)=>{
   const active=scope.getStore();
   if(active && active.id!==c.id)throw Error('CROSS_BUSINESS_SCHEMA');
   const current=active||c;
   if(name==='get_line_messaging_token')return Promise.resolve({data:notificationToken(current,'member')||null,error:null});
   if(name==='get_grant_dispatch_secret'||name==='get_e2e_artifact_retention_secret')return control().rpc(name);
   if(name==='booking_notification_config')return control().rpc(name).then(({data,error}:any)=>({error,data:error?null:{BOOKING_NOTIFICATION_DISPATCH_SECRET:data?.BOOKING_NOTIFICATION_DISPATCH_SECRET,
    LINE_BOOKING_ADMIN_CHANNEL_ACCESS_TOKEN:notificationToken(current,'admin'),LINE_BOOKING_MEMBER_CHANNEL_ACCESS_TOKEN:notificationToken(current,'member'),
    ADMIN_NOTIFICATIONS_DISABLED:current.module_line?.booking?.notifications?.admin?.mode==='disabled',
    MEMBER_NOTIFICATIONS_DISABLED:current.module_line?.booking?.notifications?.member?.mode==='disabled'}}));
   if(name==='get_line_setting'){
    const keys:Record<string,string>={LINE_MEMBER_LIFF_ID:'memberLiffId',LINE_POINTS_LIFF_ID:'pointsLiffId',LINE_EVENT_LIFF_ID:'eventLiffId',LINE_CALENDAR_LIFF_ID:'calendarLiffId',LINE_BOOKING_LIFF_ID:'bookingLiffId',LINE_ADMIN_LIFF_ID:'adminLiffId'};
    if(keys[params?.p_key])return Promise.resolve({data:current.customLineReady?current.line_config?.[keys[params.p_key]]||null:null,error:null});
   }
   return target.rpc(name,params,options);
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }}) as any;
}
function subject(token:unknown):string|null {
 try{const part=String(token).split('.')[1];const parsed=JSON.parse(atob(part.replace(/-/g,'+').replace(/_/g,'/')));return /^U[0-9a-f]{32}$/.test(parsed.sub)?parsed.sub:null;}catch{return null;}
}
// This subject is only a routing hint. Administrative access is verified below;
// existing handlers retain their own LINE and private admin/member checks.
async function resolve(body:any):Promise<Context|null>{
 const slug=body.business;
 if(slug!==undefined&&(typeof slug!=='string'||!/^admin-[a-f0-9]{32}$|^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug)||slug.length>40))throw Object.assign(Error('商家入口格式不正確。'),{status:400,code:'INVALID_BUSINESS'});
 const actor=subject(body.idToken);if(!slug&&!actor)return null;
 const result=await control().rpc('platform_business_context_v2',{p_actor:actor,p_slug:slug||null});
 if(result.error)throw Object.assign(Error('目前無法確認商家權限。'),{status:503,code:'BUSINESS_ACCESS_UNAVAILABLE'});
 if(!result.data&&slug)throw Object.assign(Error('找不到商家入口。'),{status:404,code:'BUSINESS_NOT_FOUND'});
 return result.data;
}
async function assertBusinessAdmin(c:Context,body:any){
 const qualification=c.owner_qualification_status,cutoff=c.admin_access_revoked_before;
 if(!Object.hasOwn(c,'owner_qualification_status')||![null,'approved','pending','rejected','suspended'].includes(qualification)
  ||!Object.hasOwn(c,'admin_access_revoked_before')||(cutoff!==null&&(typeof cutoff!=='string'||!Number.isFinite(Date.parse(cutoff))))
  ||(c.access_revoked_before!=null&&!Number.isFinite(Date.parse(c.access_revoked_before))))
  throw Object.assign(Error('目前無法確認商家權限。'),{status:503,code:'BUSINESS_ACCESS_UNAVAILABLE'});
 if(qualification!=='approved')throw Object.assign(Error(qualification==='suspended'?'管理員資格已停權，請聯絡總管理員。':'請先取得一般管理員資格。'),
  {status:403,code:qualification==='suspended'?'PLATFORM_QUALIFICATION_SUSPENDED':'PLATFORM_QUALIFICATION_REQUIRED'});
 // Qualification revocation applies only to this administrative request. Member
 // scopes continue carrying the tenant cutoff returned by the routing RPC.
 const revoked=Math.max(Date.parse(c.access_revoked_before||'')||0,Date.parse(cutoff||'')||0);
 if(revoked)c.access_revoked_before=new Date(revoked).toISOString();
 // Resolve the trusted admin channel without loading any merchant credentials.
 // This is the same readiness rule credentials() uses for downstream handlers.
 c.adminCustomLineReady=Boolean(c.line_config?.adminLiffId?.startsWith(c.line_config?.adminChannelId+'-'));
 const identity=await scope.run(c,()=>verifyMerchantAdminIdToken({idToken:body.idToken},businessEnv('LINE_ADMIN_CHANNEL_ID')));
 if(identity.lineUserId!==c.owner_line_user_id)throw Object.assign(Error('你沒有此商家的管理權限。'),{code:'BUSINESS_ADMIN_REQUIRED',status:403});
 assertTenantIdentity(c,identity);
 c.verifiedAdmin={actor:identity.lineUserId,issuedAt:new Date(identity.issuedAtMs).toISOString()};
 // External services cannot share a Postgres transaction. Recheck immediately
 // before dispatch; already-dispatched provider/storage requests may finish.
 c.authorizeExternal=async()=>{
  const result=await control().rpc('platform_my_merchant_context',{
   p_actor:c.verifiedAdmin.actor,p_slug:c.slug,p_issued_at:c.verifiedAdmin.issuedAt,
  });
  if(result.error||!result.data)throw Object.assign(Error('管理權限已變更，請重新確認。'),{status:403,code:'BUSINESS_ADMIN_REQUIRED'});
 };
}
async function credentials(c:Context,feature?:string,identityOnly=false){
 c.adminCustomLineReady=Boolean(c.line_config?.adminLiffId?.startsWith(c.line_config?.adminChannelId+'-'));
 const module=feature?c.module_line?.[feature]:null;
 c.active_feature=feature;
 if(module)c.line_config={...c.line_config,...module.line};
 const configured=module?module.credentialsConfigured===true:c.credentials_configured;
 c.customLineReady=feature?featureLineReady(feature,c.line_config):merchantOnboarding({status:c.status,features:c.features,line:c.line_config,credentialsConfigured:configured}).configurationComplete;
 // Session operations only need the trusted Login identity; no Messaging
 // envelope or notification route is needed to claim/check/close a session.
 if(identityOnly){c.notificationCredentials={};return;}
 const db=control();
 if(configured){
  const result=await db.rpc(module?'platform_module_credentials':'platform_business_credentials',module?{p_tenant_id:c.id,p_feature:feature}:{p_tenant_id:c.id});
  if(result.error||!result.data)throw Error('BUSINESS_CREDENTIALS_UNAVAILABLE');
  const key=await resolvePlatformEncryptionKey({configuredKey:rawEnv('PLATFORM_CREDENTIAL_ENCRYPTION_KEY'),db});
  c.credentials=await openCredentials(module&&result.data.scope==='module'?c.id+':'+feature:c.id,module?result.data.envelope:result.data,key);
 }
 c.notificationCredentials={};
 if(module?.notifications && Object.keys(module.notifications).length){
  const result=await db.rpc('platform_notification_credentials',{p_tenant_id:c.id,p_feature:feature});
  for(const purpose of ['admin','member']){
   const mode=module.notifications[purpose]?.mode;
   if(mode==='disabled')c.notificationCredentials[purpose]='';
   else if(mode==='custom'){
    // A broken outgoing channel must not block non-LINE business operations.
    // Override with an empty token on failure so this purpose can never fall
    // back to a different account; delivery records its configuration failure.
    c.notificationCredentials[purpose]='';
    try{
     if(result.error||result.data?.[purpose]?.mode!=='custom')continue;
     const key=await resolvePlatformEncryptionKey({configuredKey:rawEnv('PLATFORM_CREDENTIAL_ENCRYPTION_KEY'),db});
     const secret=await openCredentials(c.id+':'+feature+':notify:'+purpose,result.data[purpose].envelope,key);
     c.notificationCredentials[purpose]=secret?.channelAccessToken||'';
    }catch{ /* fail closed for this purpose only */ }
   }
  }
 }
}
export async function withBusinessModule<T>(feature:string,run:()=>Promise<T>):Promise<T>{
 const current=scope.getStore();if(!current)return run();
 const c:Context={...current,credentials:undefined,notificationCredentials:undefined};
 if(c.features?.[feature]!==true)throw Object.assign(Error('此功能已停用。'),{code:'FEATURE_DISABLED',status:403});
 await credentials(c,feature);return scope.run(c,run);
}
const sessionSurface=/^user\.(member|points|event|calendar|booking)\.session\.(claim|status|logout)$/;
const identityFeatures:Record<string,string>={member:'membership',points:'points',event:'events',calendar:'calendar',booking:'booking'};
function requestModule(name:string,body:any,context?:Context):string|undefined{
 if(name==='booking-line-notifications')return 'booking';
 if(name==='scheduled-grant-messages')return undefined;
 const action=policyAction(name,body),session=sessionSurface.exec(action);
 // Session authorization deliberately remains a workspace operation in
 // actionFeatures. Its LINE identity still belongs to the named surface,
 // including logout/status after that feature's grant has been revoked.
 if(session)return identityFeatures[session[1]];
 const features=actionFeatures(action,body),primary=features?.[0];
 if(context && /^user\.member\.(bootstrap|profile\.save|terms\.accept)$/.test(action)){
  // Shared member profile/terms are also used from booking and other approved
  // LIFFs. aud is only a routing hint, never identity or authorization proof:
  // choose solely from this tenant's granted, valid LINE configurations. The
  // downstream verifier must still validate the token with LINE against the
  // selected database Channel and enforce the existing session/cutoff checks.
  let audience:unknown;
  try{audience=JSON.parse(atob(String(body.idToken).split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).aud;}catch{}
  // Test-session requests may carry no LINE ID token. Leave their existing
  // authentication branch (and malformed token rejection) to the endpoint.
  if(typeof audience!=='string')return primary;
  const candidates=Object.values(identityFeatures).filter(feature=>context.features?.[feature]===true
   && featureLineReady(feature,{...context.line_config,...context.module_line?.[feature]?.line}));
  const matched=candidates.find(feature=>({...context.line_config,...context.module_line?.[feature]?.line}).memberChannelId===audience);
  if(matched)return matched;
  // Do not fall back to a global Channel when only another configured LIFF can
  // legitimately enter this shared foundation route. Legacy unconfigured
  // tenants and an explicitly configured membership Channel retain their path.
  if(candidates.length && (!primary || !candidates.includes(primary)))throw Object.assign(Error('LINE 登入已失效，請重新登入。'),{status:401,code:'AUTH_INVALID'});
 }
 return primary;
}

const jobs=new Set(['booking-line-notifications','scheduled-grant-messages','e2e-artifact-retention']);
const jobAllowed=(name:string,c:Context)=>name==='scheduled-grant-messages'
 ? ['membership','points','events'].some(key=>c.features?.[key]):c.features?.[name==='booking-line-notifications'?'booking':'testing']===true;
function policyAction(name:string,body:any):string{
 const action=String(body.action||body.operation||'');
 if(name==='pointcard-extension-api')return ['member.settings.get','member.redeem'].includes(body.operation)?'user.pointcard.'+body.operation.slice(7):'admin.pointcard.settings.save';
 if(name==='event-ticket-extension-api')return ['member.settings.get','member.today-usable','member.redeem'].includes(body.operation)?'user.event.'+body.operation.slice(7):'admin.event-ticket.settings.save';
 if(name==='booking-cancellation-api')return body.clientType==='member'&&['member.list','member.request'].includes(body.action)?'user.booking.cancellation':'admin.booking.cancellation';
 return action;
}
export function businessHandler(name:string,handler:(request:Request)=>Response|Promise<Response>){
 return async(request:Request):Promise<Response>=>{
  if(request.method!=='POST')return handler(request);
  let body:any;
  try{
   const reader=request.clone().body?.getReader(),chunks:Uint8Array[]=[];let size=0;
   if(reader){try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;
    if(size>8_000_000){void reader.cancel();return new Response(JSON.stringify({ok:false,error:{code:'BODY_TOO_LARGE',message:'請求資料過大。'}}),{status:413});}
    chunks.push(item.value);
   }}finally{reader.releaseLock();}}
   const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
   body=JSON.parse(new TextDecoder().decode(bytes));
  }catch{return handler(request);}
  if(!body||typeof body!=='object'||Array.isArray(body))return handler(request);
  try{
   const c=await resolve(body);
   if(!c){
    const response=await handler(request);
    // Only after the real dispatch-secret check succeeds. Each tenant is run
    // separately, with fresh grants and its own LINE token/outbox/storage prefix.
    if(jobs.has(name)&&response.ok&&!body.business){
     const active=await control().rpc('platform_active_businesses');
     if(active.error)throw Error('BUSINESS_JOBS_UNAVAILABLE');
     for(const tenant of active.data||[]){
      if(!jobAllowed(name,tenant))continue;
      await credentials(tenant,requestModule(name,body));
      await scope.run(tenant,()=>handler(new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify({...body,business:tenant.slug})})));
     }
    }
    return response;
   }
   const action=policyAction(name,body),admin=[body.action,body.operation,action].some(value=>String(value||'').startsWith('admin.'));
   if(admin)await assertBusinessAdmin(c,body);
   if(jobs.has(name)&&!admin){
    if(tenantExpired(c))throw Object.assign(Error('使用期限已到，請聯絡總管理員。'),{code:'TENANT_EXPIRED',status:403});
    if(c.status!=='active')throw Object.assign(Error('此商家已停用。'),{code:'TENANT_SUSPENDED',status:403});
    if(!jobAllowed(name,c))throw Object.assign(Error('此功能已停用。'),{code:'FEATURE_DISABLED',status:403});
   }else assertBusinessAction(c,action,body);
   await credentials(c,requestModule(name,body,c),sessionSurface.test(action));
   const response=await scope.run(c,()=>handler(request));
   await wakeBookingNotifications({name,context:c,body,response,dispatch:(id:string)=>control().rpc('platform_dispatch_booking',{p_tenant_id:id})});
   if(body.action==='admin.bootstrap'&&response.ok){
    const payload=await response.clone().json();if(payload.ok&&payload.data){payload.data=businessBootstrap(payload.data,c);return new Response(JSON.stringify(payload),{status:response.status,headers:response.headers});}
   }
   return response;
  }catch(error){
   const e=error as any,status=e.status||503;
   const allowed=new Set(['https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app','https://platform--memberwebsocket-dev-netlify.netlify.app','https://develop--memberwebsocket-dev-netlify.netlify.app','https://memberwebsocket-dev-netlify.netlify.app',...rawEnv('ALLOWED_ORIGINS').split(',')]);
   const origin=request.headers.get('Origin')||'';
   return new Response(JSON.stringify({ok:false,status,error:{code:e.code||'BUSINESS_UNAVAILABLE',message:e.status?e.message:'商家服務暫時無法使用，請稍後重試。'}}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':allowed.has(origin)?origin:'','Vary':'Origin'}});
  }
 };
}
export function serveBusiness(name:string,handler:(request:Request)=>Response|Promise<Response>){return Deno.serve(businessHandler(name,handler));}
