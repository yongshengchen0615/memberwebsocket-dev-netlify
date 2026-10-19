import { createClient as baseClient } from 'npm:@supabase/supabase-js@2.57.0';
import { assertBusinessAction,businessBootstrap,actionFeatures } from './business-policy.mjs';
import { openCredentials } from './platform-crypto.mjs';
import { resolvePlatformEncryptionKey } from './platform-key.mjs';
import { tenantExpired } from './tenant-access.mjs';
import { merchantOnboarding } from './merchant-onboarding.mjs';
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
 if(key!=='from')return typeof target[key]==='function'?target[key].bind(target):target[key];
 return(bucket:string)=>{const client=target.from(bucket);return new Proxy(client,{get(object,method){
  const original=object[method];if(typeof original!=='function')return original;
  return(...args:any[])=>{
   if(['remove','createSignedUrls'].includes(String(method)))args[0]=args[0].map((p:string)=>relative(p,c));
   else if(['move','copy'].includes(String(method))){args[0]=relative(args[0],c);args[1]=relative(args[1],c);}
   else if(String(method)==='list')args[0]=args[0]?relative(args[0],c):c.id;
   else if(['upload','update','download','createSignedUrl','createSignedUploadUrl','getPublicUrl','info','exists'].includes(String(method)))args[0]=relative(args[0],c);
   return original.apply(object,args);
  };
 }});};
}});}
export function createClient(url:string,key:string,options?:any):import('npm:@supabase/supabase-js@2.57.0').SupabaseClient{
 const args=[url,key,options] as const;
 const c=scope.getStore();if(!c)return baseClient(...args);
 const client=baseClient(args[0],args[1],{...args[2],db:{...args[2]?.db,schema:c.runtime_schema},global:{...args[2]?.global,
  fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{
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
   if(name==='get_line_messaging_token')return Promise.resolve({data:c.credentials?.channelAccessToken||null,error:null});
   if(name==='get_grant_dispatch_secret'||name==='get_e2e_artifact_retention_secret')return control().rpc(name);
   if(name==='booking_notification_config')return control().rpc(name).then(({data,error}:any)=>({error,data:error?null:{BOOKING_NOTIFICATION_DISPATCH_SECRET:data?.BOOKING_NOTIFICATION_DISPATCH_SECRET,
    LINE_BOOKING_ADMIN_CHANNEL_ACCESS_TOKEN:c.credentials?.channelAccessToken||'',LINE_BOOKING_MEMBER_CHANNEL_ACCESS_TOKEN:c.credentials?.channelAccessToken||''}}));
   if(name==='get_line_setting'){
    const keys:Record<string,string>={LINE_MEMBER_LIFF_ID:'memberLiffId',LINE_POINTS_LIFF_ID:'pointsLiffId',LINE_EVENT_LIFF_ID:'eventLiffId',LINE_CALENDAR_LIFF_ID:'calendarLiffId',LINE_BOOKING_LIFF_ID:'bookingLiffId',LINE_ADMIN_LIFF_ID:'adminLiffId'};
    if(keys[params?.p_key])return Promise.resolve({data:c.customLineReady?c.line_config?.[keys[params.p_key]]||null:null,error:null});
   }
   return target.rpc(name,params,options);
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }}) as any;
}
function subject(token:unknown):string|null {
 try{const part=String(token).split('.')[1];const parsed=JSON.parse(atob(part.replace(/-/g,'+').replace(/_/g,'/')));return /^U[0-9a-f]{32}$/.test(parsed.sub)?parsed.sub:null;}catch{return null;}
}
// This subject is only a routing hint. It never authorizes anything: every
// existing handler still verifies the original token with LINE and checks the
// current admin/member record inside the chosen, private namespace.
async function resolve(body:any):Promise<Context|null>{
 const slug=body.business;
 if(slug!==undefined&&(typeof slug!=='string'||!/^admin-[a-f0-9]{32}$|^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug)||slug.length>40))throw Object.assign(Error('商家入口格式不正確。'),{status:400,code:'INVALID_BUSINESS'});
 const actor=subject(body.idToken);if(!slug&&!actor)return null;
 const result=await control().rpc('platform_business_context',{p_actor:actor,p_slug:slug||null});
 if(result.error)throw Object.assign(Error('目前無法確認商家權限。'),{status:503,code:'BUSINESS_ACCESS_UNAVAILABLE'});
 if(!result.data&&slug)throw Object.assign(Error('找不到商家入口。'),{status:404,code:'BUSINESS_NOT_FOUND'});
 return result.data;
}
async function credentials(c:Context,feature?:string){
 c.adminCustomLineReady=Boolean(c.line_config?.adminLiffId?.startsWith(c.line_config?.adminChannelId+'-'));
 const module=feature?c.module_line?.[feature]:null;
 c.active_feature=feature;
 if(module)c.line_config={...c.line_config,...module.line};
 const configured=module?module.credentialsConfigured===true:c.credentials_configured;
 c.customLineReady=merchantOnboarding({status:c.status,features:feature?{[feature]:true}:c.features,line:c.line_config,credentialsConfigured:configured}).configurationComplete;
 if(!configured)return;
 const db=control(),result=await db.rpc(module?'platform_module_credentials':'platform_business_credentials',module?{p_tenant_id:c.id,p_feature:feature}:{p_tenant_id:c.id});
 if(result.error||!result.data)throw Error('BUSINESS_CREDENTIALS_UNAVAILABLE');
 const key=await resolvePlatformEncryptionKey({configuredKey:rawEnv('PLATFORM_CREDENTIAL_ENCRYPTION_KEY'),db});
 c.credentials=await openCredentials(module&&result.data.scope==='module'?c.id+':'+feature:c.id,module?result.data.envelope:result.data,key);
}
export async function withBusinessModule<T>(feature:string,run:()=>Promise<T>):Promise<T>{
 const current=scope.getStore();if(!current)return run();
 const c:Context={...current,credentials:undefined};
 if(c.features?.[feature]!==true)throw Object.assign(Error('此功能已停用。'),{code:'FEATURE_DISABLED',status:403});
 await credentials(c,feature);return scope.run(c,run);
}
function requestModule(name:string,body:any):string|undefined{
 if(name==='booking-line-notifications')return 'booking';
 if(name==='scheduled-grant-messages')return undefined;
 const features=actionFeatures(policyAction(name,body),body);
 return features?.[0];
}

const jobs=new Set(['booking-line-notifications','scheduled-grant-messages','e2e-artifact-retention']);
const jobAllowed=(name:string,c:Context)=>name==='scheduled-grant-messages'
 ? ['membership','points','events'].some(key=>c.features?.[key]):c.features?.[name==='booking-line-notifications'?'booking':'testing']===true;
function policyAction(name:string,body:any):string{
 const action=String(body.action||'');
 if(name==='pointcard-extension-api')return 'admin.pointcard.settings.save';
 if(name==='event-ticket-extension-api')return 'admin.event-ticket.settings.save';
 if(name==='booking-cancellation-api')return 'admin.booking.cancellation';
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
   const requested=String(body.action||body.operation||'');
   if(requested.startsWith('admin.')&&subject(body.idToken)!==c.owner_line_user_id)
    throw Object.assign(Error('你沒有此商家的管理權限。'),{code:'BUSINESS_ADMIN_REQUIRED',status:403});
   if(jobs.has(name)&&!String(body.action||'').startsWith('admin.')){
    if(tenantExpired(c))throw Object.assign(Error('使用期限已到，請聯絡總管理員。'),{code:'TENANT_EXPIRED',status:403});
    if(c.status!=='active')throw Object.assign(Error('此商家已停用。'),{code:'TENANT_SUSPENDED',status:403});
    if(!jobAllowed(name,c))throw Object.assign(Error('此功能已停用。'),{code:'FEATURE_DISABLED',status:403});
   }else assertBusinessAction(c,policyAction(name,body),body);
   await credentials(c,requestModule(name,body));
   const response=await scope.run(c,()=>handler(request));
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
