import { businessHandler,businessContext,createClient } from './business-runtime.ts';
import { assertTenantIdentity } from './tenant-access.mjs';
import { businessFetch } from './business-scope.ts';

const assert=(condition:unknown,message='assertion failed')=>{if(!condition)throw Error(message);};
const owner='U'+'a'.repeat(32),other='U'+'b'.repeat(32),member='U'+'c'.repeat(32);
// The unverified payload is deliberately newer than the provider's claim.
const token=(sub=owner)=>'e30.'+btoa(JSON.stringify({sub,iat:Math.floor(Date.now()/1000)}))+'.untrusted';
const now=Math.floor(Date.now()/1000),tenantCutoff=new Date((now-60)*1000).toISOString(),adminCutoff=new Date((now-20)*1000).toISOString();
const tenant={id:'10000000-0000-4000-8000-000000000001',slug:'merchant-a',name:'A',status:'active',runtime_schema:'business_'+'a'.repeat(32),owner_line_user_id:owner,
 features:{membership:true,points:true,events:true,booking:true},line_config:{},credentials_configured:false,access_revoked_before:tenantCutoff,
 owner_qualification_status:'approved',admin_access_revoked_before:null};
type Fixture={context:any;issued:number;verifiedSub:string;verifiedAudience?:string;verifyStatus:number;rpcStatus:number;current:boolean;calls:{path:string;body:any;headers:Headers}[]};
async function transport(run:(f:Fixture)=>Promise<void>){
 const oldEnv=Deno.env.get,oldFetch=globalThis.fetch;
 const f:Fixture={context:structuredClone(tenant),issued:now-10,verifiedSub:owner,verifyStatus:200,rpcStatus:200,current:true,calls:[]};
 Deno.env.get=(key:string)=>({SUPABASE_URL:'https://runtime-fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service'} as Record<string,string>)[key];
 globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  const body=init?.body instanceof URLSearchParams?Object.fromEntries(init.body):typeof init?.body==='string'?JSON.parse(init.body):{};
  f.calls.push({path:url.pathname,body,headers:new Headers(init?.headers)});
  const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  if(url.pathname.endsWith('/platform_business_context_v2'))return reply(f.rpcStatus===200?f.context:{code:'PGRST202',message:'RPC missing'},f.rpcStatus);
  if(url.pathname.endsWith('/platform_my_merchant_context'))return reply(f.current?{tenant}:{message:'PLATFORM_QUALIFICATION_REQUIRED'},f.current?200:403);
  if(url.pathname==='/oauth2/v2.1/verify')return reply({sub:f.verifiedSub,aud:f.verifiedAudience||body.client_id,iss:'https://access.line.me',iat:f.issued,exp:now+300},f.verifyStatus);
  if(url.pathname.endsWith('/members')||url.pathname.endsWith('/rpc/admin_example'))return reply([]);
  if(url.pathname.startsWith('/storage/v1/')||url.pathname.startsWith('/v2/bot/message/'))return reply({Key:'synthetic'});
  throw Error('Unexpected transport '+url.pathname);
 }) as typeof fetch;
 try{await run(f);}finally{Deno.env.get=oldEnv;globalThis.fetch=oldFetch;}
}
const request=(body:Record<string,unknown>={})=>new Request('https://api.test',{method:'POST',body:JSON.stringify({business:'merchant-a',idToken:token(),action:'admin.bootstrap',...body})});

Deno.test('#97 runtime: committed revocation before external dispatch prevents new LINE or storage mutation',()=>transport(async f=>{
 for(const operation of ['line','storage','bucket']){
  f.current=true;const before=f.calls.length;
  const handle=businessHandler('api',async()=>{
   f.current=false; // Revocation committed after entry checks, before dispatch.
   if(operation==='line')await businessFetch('https://api.line.me/v2/bot/message/push',{method:'POST',body:'{}'});
   else if(operation==='storage')await createClient('https://runtime-fixture.supabase.co','synthetic-service').storage.from('booking-receipts').remove(['owned.png']);
   else await createClient('https://runtime-fixture.supabase.co','synthetic-service').storage.emptyBucket('synthetic');
   return new Response('{}');
  });
  assert((await handle(request())).status===403,operation+' did not recheck current authority');
  assert(!f.calls.slice(before).some(c=>c.path.startsWith('/storage/v1/')||c.path.startsWith('/v2/bot/message/')),operation+' dispatched after committed revocation');
 }
}));

Deno.test('#97 runtime: scoped table and RPC transports overwrite caller markers with provider-verified admin authority',()=>transport(async f=>{
 const handle=businessHandler('api',async()=>{
  const db=createClient('https://runtime-fixture.supabase.co','synthetic-service',{global:{headers:{'x-platform-admin-actor':other,'x-platform-admin-tenant':'forged','x-platform-admin-issued-at':'2099-01-01'}}});
  await db.from('members').update({display_name:'A'}).eq('id','synthetic');
  await db.rpc('admin_example');return new Response('{}');
 });
 assert((await handle(request())).status===200);
 const calls=f.calls.filter(c=>c.path.endsWith('/members')||c.path.endsWith('/rpc/admin_example'));assert(calls.length===2);
 for(const call of calls){assert(call.headers.get('x-platform-admin-actor')===owner,'must not trust caller actor');assert(call.headers.get('x-platform-admin-tenant')===tenant.id,'must scope exact tenant');assert(call.headers.get('x-platform-admin-issued-at')===new Date(f.issued*1000).toISOString(),'must use verified, not decoded timestamp');}
}));

Deno.test('#97 runtime: member database transports strip reserved admin markers',()=>transport(async f=>{
 f.context={...tenant,owner_qualification_status:'suspended'};
 const handle=businessHandler('api',async()=>{
  const db=createClient('https://runtime-fixture.supabase.co','synthetic-service',{global:{headers:{'x-platform-admin-actor':other,'x-platform-admin-tenant':'forged','x-platform-admin-issued-at':'2099-01-01'}}});
  await db.from('members').select('id');return new Response('{}');
 });
 assert((await handle(request({action:'user.member.bootstrap',idToken:token(member)}))).status===200);
 const call=f.calls.find(c=>c.path.endsWith('/members'));assert(call,'member transport was not exercised');
 for(const name of ['x-platform-admin-actor','x-platform-admin-tenant','x-platform-admin-issued-at'])assert(!call!.headers.has(name),'member must not inherit admin marker');
}));

Deno.test('#97 runtime: current qualification denies every non-approved state before handler or credential reads',()=>transport(async f=>{
 let invoked=0;const handle=businessHandler('api',()=>{invoked++;return new Response('{}');});
 for(const status of ['pending','rejected','suspended',null]){
  f.context={...tenant,owner_qualification_status:status,credentials_configured:true};
  const response=await handle(request());assert(response.status===403,'qualification '+status+' must deny, got '+response.status);
 }
 assert(invoked===0,'unqualified request reached handler');
 assert(f.calls.every(c=>!c.path.includes('credentials')),'unqualified request read credentials');
}));

Deno.test('#97 runtime: actionless admin wrappers require current qualification and verified ownership',()=>transport(async f=>{
 let invoked=0;
 for(const [name,body]of [
  ['pointcard-extension-api',{operation:'admin.settings.save',action:undefined}],
  ['event-ticket-extension-api',{operation:'admin.settings.get',action:undefined}],
  ['booking-cancellation-api',{action:undefined,clientType:'admin'}],
  ['pointcard-extension-api',{action:undefined,operation:'member.unknown'}],
 ] as [string,Record<string,unknown>][]){
  const handle=businessHandler(name,()=>{invoked++;return new Response('{}');});
  f.context={...tenant,owner_qualification_status:'suspended'};
  assert((await handle(request(body))).status===403,name+' skipped qualification');
  f.context={...tenant};f.verifiedSub=other;
  assert((await handle(request(body))).status===403,name+' trusted decoded owner over verified subject');
 }
 assert(invoked===0,'wrapper denial must happen before handler');
}));

Deno.test('#97 runtime: invalid provider token and wrong channel cannot pass an owner routing hint',()=>transport(async f=>{
 f.context={...tenant,credentials_configured:true};
 let invoked=0;const handle=businessHandler('api',()=>{invoked++;return new Response('{}');});
 f.verifyStatus=400;assert((await handle(request())).status===401,'forged token must fail LINE verification');
 f.verifyStatus=200;f.verifiedAudience='2099999999';assert((await handle(request({channel:'2099999999'}))).status===401,'request channel cannot select a verifier audience');
 f.verifiedAudience=undefined;f.verifiedSub=other;assert((await handle(request())).status===403,'verified owner must match selected merchant');
 f.verifyStatus=503;assert((await handle(request())).status===503,'LINE read error must fail closed');
 assert(invoked===0,'invalid identity reached handler');assert(f.calls.every(c=>!c.path.includes('credentials')),'invalid identity read credentials');
}));

Deno.test('#97 runtime: only provider-issued freshness passes resume and combined cutoff stays in downstream admin scope',()=>transport(async f=>{
 f.context={...tenant,admin_access_revoked_before:adminCutoff};f.issued=now-30;
 let invoked=0;const handle=businessHandler('api',()=>{
  invoked++;assert(businessContext()?.access_revoked_before===adminCutoff,'downstream admin scope lost qualification cutoff');
  assertTenantIdentity(businessContext(),{issuedAtMs:(now-10)*1000});return new Response('{}');
 });
 const stale=await handle(request());assert(stale.status===401,'decoded fresh iat cannot replace stale provider claim');
 assert((await stale.json()).error.code==='TENANT_REAUTH_REQUIRED');assert(invoked===0,'stale token reached handler');
 f.issued=now-10;assert((await handle(request())).status===200);assert(invoked===1);
 f.context={...tenant,access_revoked_before:adminCutoff,admin_access_revoked_before:tenantCutoff};f.issued=now-30;
 assert((await handle(request())).status===401,'tenant cutoff must also remain authoritative');assert(invoked===1);
}));

Deno.test('#97 runtime: trusted custom admin channel verifies the original token before any credential read',()=>transport(async f=>{
 f.context={...tenant,line_config:{adminChannelId:'2010999999',adminLiffId:'2010999999-admin'}};
 let invoked=0;const handle=businessHandler('api',()=>{invoked++;return new Response('{}');});
 const original=token();assert((await handle(request({idToken:original,channel:'2012000000'}))).status===200);assert(invoked===1);
 const verify=f.calls.find(c=>c.path==='/oauth2/v2.1/verify');
 assert(verify?.body.client_id==='2010999999','trusted business channel not used');assert(verify?.body.id_token===original,'verifier did not receive original token');
 assert(f.calls[0].path.endsWith('/platform_business_context_v2'),'qualification metadata must come from mandatory v2 RPC');
}));

Deno.test('#97 runtime: missing or invalid qualification metadata and unavailable v2 RPC fail closed',()=>transport(async f=>{
 let invoked=0;const handle=businessHandler('api',()=>{invoked++;return new Response('{}');});
 const missingStatus={...tenant} as any;delete missingStatus.owner_qualification_status;
 const missingCutoff={...tenant} as any;delete missingCutoff.admin_access_revoked_before;
 for(const context of [missingStatus,missingCutoff,{...tenant,owner_qualification_status:'invalid'},{...tenant,admin_access_revoked_before:'invalid'}]){
  f.context=context;const response=await handle(request());assert(response.status===503,'incomplete or invalid v2 metadata must fail closed');
 }
 f.rpcStatus=404;assert((await handle(request())).status===503);assert(invoked===0,'unavailable metadata reached handler');
}));

Deno.test('#97 runtime: member wrapper operations keep tenant freshness without inheriting owner qualification',()=>transport(async f=>{
 f.context={...tenant,owner_qualification_status:'suspended',admin_access_revoked_before:adminCutoff};
 let invoked=0;
 for(const [name,body]of [
  ['api',{action:'user.member.bootstrap'}],
  ['pointcard-extension-api',{action:undefined,operation:'member.settings.get'}],
  ['pointcard-extension-api',{action:undefined,operation:'member.redeem'}],
  ['event-ticket-extension-api',{action:undefined,operation:'member.settings.get'}],
  ['event-ticket-extension-api',{action:undefined,operation:'member.today-usable'}],
  ['event-ticket-extension-api',{action:undefined,operation:'member.redeem'}],
  ['booking-cancellation-api',{action:'member.list',clientType:'member'}],
  ['booking-cancellation-api',{action:'member.request',clientType:'member'}],
 ] as [string,Record<string,unknown>][]){
  const handle=businessHandler(name,()=>{
   invoked++;assert(businessContext()?.access_revoked_before===tenantCutoff,'owner cutoff leaked into member scope');
   assertTenantIdentity(businessContext(),{issuedAtMs:(now-30)*1000});return new Response('{}');
  });
  assert((await handle(request({...body,idToken:token(member)}))).status===200,name+' member must retain endpoint authentication');
 }
 assert(invoked===8);assert(!f.calls.some(c=>c.path==='/oauth2/v2.1/verify'),'runtime must leave member token verification to existing endpoint contract');
}));

Deno.test('#97 runtime: each merchant uses its own current qualification and jobs retain dispatch-secret routing',()=>transport(async f=>{
 let invoked=0;const handle=businessHandler('api',()=>{invoked++;return new Response('{}');});
 assert((await handle(request())).status===200);
 f.context={...tenant,id:'20000000-0000-4000-8000-000000000002',slug:'merchant-b',owner_line_user_id:other,owner_qualification_status:'suspended'};
 f.verifiedSub=other;assert((await handle(request({business:'merchant-b',idToken:token(other)}))).status===403);assert(invoked===1);
 f.context={...tenant,owner_qualification_status:'suspended',admin_access_revoked_before:adminCutoff};
 const job=businessHandler('booking-line-notifications',()=>{invoked++;return new Response('{}');});
 const before=f.calls.filter(c=>c.path==='/oauth2/v2.1/verify').length;
 assert((await job(request({action:undefined,idToken:undefined,dispatchSecret:'synthetic-secret'}))).status===200);
 assert(invoked===2);assert(f.calls.filter(c=>c.path==='/oauth2/v2.1/verify').length===before,'job must retain its dispatch-secret verifier');
}));
