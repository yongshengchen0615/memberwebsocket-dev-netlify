const test=require('node:test'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),path=require('node:path');
const {setup:database,root,owner,other,features}=require('./fixtures/merchant-applications.cjs');
const shared=name=>import(pathToFileURL(path.resolve(__dirname,'../../supabase/functions/_shared',name)));
async function setup({rate=()=>({data:true,error:null})}={}){
 const h=await database();
 try{
  const {createPlatformHandler}=await shared('platform-handler.mjs');
  const {verifyMerchantAdminIdToken,verifyPlatformIdToken}=await shared('platform-auth.mjs');
  const args={platform_is_super_admin:['p_actor'],platform_record_access_request:['p_actor','p_display_name'],
   platform_list_tenants:['p_actor'],platform_list_applications:['p_actor'],
   platform_my_merchant_applications:['p_actor'],platform_get_merchant_application:['p_actor','p_application_id'],
   platform_submit_merchant_application:['p_actor','p_name','p_slug','p_request_id','p_application_id','p_expected_version'],
   platform_review_merchant_application:['p_actor','p_application_id','p_expected_version','p_decision','p_reason','p_features','p_request_id']};
  h.providerCalls=[];h.rpcCalls=[];h.rates=[];
  const provider=async(url,options)=>{
   const channel=options.body.get('client_id'),token=options.body.get('id_token');
   h.providerCalls.push({channel,token});
   const sub=token==='manager'?owner:token==='other'?other:token==='root'||token==='wrong-channel'?root:'';
   return new Response(JSON.stringify({sub,name:'Synthetic LINE user',aud:token==='wrong-channel'?'2010791619':channel,
    iss:'https://access.line.me',iat:Math.floor(Date.now()/1000)-10,exp:Math.floor(Date.now()/1000)+300}),{status:sub?200:400});
  };
  h.handler=createPlatformHandler({allowedOrigins:new Set(['https://allowed.test']),encryptionKey:()=>{throw Error('NO_CREDENTIAL_READ_EXPECTED');},
   verifyApplicantIdentity:(idToken,channel)=>verifyMerchantAdminIdToken({idToken,fetchImpl:provider},channel),
   verifyIdentity:idToken=>verifyPlatformIdToken({idToken,fetchImpl:provider}),
   db:{rpc:async(name,p)=>{
    if(name==='consume_api_rate_limit'){h.rates.push(p);return rate(p);}
    h.rpcCalls.push({name,p});assert.ok(args[name],'Unexpected RPC '+name);
    assert.deepEqual(Object.keys(p).sort(),args[name].toSorted());
    try{const rows=await h.rows(name,args[name].map(k=>p[k]));return{data:['platform_my_merchant_applications','platform_list_tenants','platform_list_applications'].includes(name)?rows.map(r=>r.result):rows[0]?.result,error:null};}
    catch(error){return{data:null,error};}
   }}});
  h.api=async(action,body={},token='manager',origin='https://allowed.test')=>{
   const response=await h.handler(new Request('https://backend.test',{method:'POST',headers:{Origin:origin},
    body:JSON.stringify({action:'platform.merchant.'+action,...body,idToken:token})}));
   assert.equal(response.headers.get('cache-control'),'no-store');
   return{status:response.status,body:await response.json()};
  };
  h.send=(name='merchant-a',body={},token='manager')=>h.api('submit',{businessName:name,requestId:crypto.randomUUID(),...body},token);
  h.decide=(a,decision='approved',body={},token='root')=>h.api('review',{
   applicationId:a.id,expectedVersion:a.version,decision,reason:decision==='rejected'?'資料不足':'',
   ...(decision==='approved'?{features:features(['points'])}:{}),requestId:crypto.randomUUID(),...body},token);
  h.snapshot=async()=>({applications:await h.count('applications'),tenants:await h.count('tenants'),
   requests:await h.count('requests'),audits:await h.count('audit_events')});
  return h;
 }catch(e){await h.db.close();throw e;}
}
function application(r){assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data.application;}
function safe(a){assert.equal(a.tenant?.runtime_schema,undefined);assert.equal(a.tenant?.line_config,undefined);
 assert.equal(a.tenant?.module_line,undefined);assert.ok(!JSON.stringify(a).includes('envelope'));}

test('AC-CODE-001/002/005: name-only applications receive distinct system codes and an uncertain retry keeps one application',async()=>{
 const h=await setup();try{
  await h.qualify();const body={businessName:'商家 A',requestId:'AABBCCDD-1111-4111-8111-112233445566'};
  const a=application(await h.api('submit',body));assert.equal(a.slug,'m-aabbccdd111141118111112233445566');assert.equal(a.status,'pending');
  const retries=await Promise.all([h.api('submit',body),h.api('submit',{...body,requestId:body.requestId.toLowerCase()})]);
  for(const retry of retries)assert.deepEqual(application(retry),a);assert.equal(await h.count('applications'),1);
  application(await h.decide(a));const approved=await h.get(a.id);
  const b=application(await h.api('submit',{businessName:'商家 B',requestId:crypto.randomUUID()}));
  assert.notEqual(b.slug,a.slug);assert.equal(b.status,'pending');assert.deepEqual(await h.get(a.id),approved);
  assert.equal(await h.count('applications'),2);assert.equal(await h.count('tenants'),1);
 }finally{await h.db.close();}
});

test('AC-CODE-003/004: resubmission preserves a legacy code and rejects custom codes or another owner',async()=>{
 const h=await setup();try{
  await h.qualify();await h.qualify(other);let a=await h.submit(owner,'legacy-code','原商家');a=await h.review(a,'rejected',null,'補資料');
  const body={businessName:'商家改名',requestId:crypto.randomUUID(),applicationId:a.id,expectedVersion:a.version};
  assert.equal((await h.api('submit',body,'other')).status,404);
  const before=await h.snapshot();
  for(const slug of ['chosen-code','',null,{},'m-'+'a'.repeat(32)]){
   assert.equal((await h.api('submit',{...body,slug})).status,400);assert.deepEqual(await h.snapshot(),before);
  }
  const next=application(await h.api('submit',body));assert.equal(next.slug,'legacy-code');assert.equal(next.businessName,'商家改名');assert.equal(next.status,'pending');
  assert.deepEqual(application(await h.api('submit',body)),next);assert.equal(await h.count('applications'),1);
 }finally{await h.db.close();}
});

test('AC-MMA-HTTP-001: qualified owner submits distinct B pending after A approval; independent B grants and schema',async()=>{
 const h=await setup();try{
  await h.qualify();const a=application(await h.send()),approved=application(await h.decide(a));
  assert.equal(approved.status,'approved');assert.equal(approved.tenant.features.points,true);safe(approved);
  const b=application(await h.send('merchant-b'));assert.notEqual(b.id,a.id);assert.equal(b.status,'pending');assert.equal(b.tenant,null);
  assert.equal((await h.get(a.id)).tenant.id,approved.tenant.id);
  const approvedB=application(await h.decide(b,'approved',{features:features(['booking'])}));
  assert.notEqual(approvedB.tenant.id,approved.tenant.id);assert.equal(approvedB.tenant.features.points,false);assert.equal(approvedB.tenant.features.booking,true);
  const rows=(await h.db.query('select runtime_schema from platform_private.tenants')).rows;
  assert.equal(new Set(rows.map(r=>r.runtime_schema)).size,2);safe(approvedB);
 }finally{await h.db.close();}
});

test('AC-MMA-HTTP-002: list/get are owner-scoped sanitized reads and cannot create state',async()=>{
 const h=await setup();try{
  await h.qualify();await h.qualify(other);const a=application(await h.send());await h.decide(a);
  const before=await h.snapshot(),r=await h.api('list');assert.equal(r.status,200);assert.equal(r.body.data.applications.length,1);safe(r.body.data.applications[0]);
  assert.equal(h.rates.at(-1).p_is_write,false);
  const got=application(await h.api('get',{applicationId:a.id}));assert.equal(got.id,a.id);safe(got);assert.equal(h.rates.at(-1).p_is_write,false);
  assert.deepEqual((await h.api('list',{},'other')).body.data.applications,[]);
  for(const id of [a.id,crypto.randomUUID()]){const denied=await h.api('get',{applicationId:id},'other');assert.equal(denied.status,404);assert.equal(denied.body.error.code,'PLATFORM_APPLICATION_NOT_FOUND');}
  assert.deepEqual(await h.snapshot(),before);
 }finally{await h.db.close();}
});

test('AC-MMA-HTTP-003: verified identity overrides forged actor and roles; account actions reject all business selectors',async()=>{
 const h=await setup();try{
  await h.qualify();const a=application(await h.send('merchant-a',{actor:root,lineUserId:other,role:'root',status:'approved',channelId:'2012065297'}));
  assert.equal(a.status,'pending');assert.equal((await h.get(a.id)).qualificationId,(await h.qualify()).id);
  assert.equal(h.providerCalls.at(-1).channel,'2010791619');const before=await h.snapshot();
  for(const action of ['list','get','submit','review'])for(const business of ['merchant-a','',null]){
   const count=h.providerCalls.length,r=await h.api(action,{business},action==='review'?'root':'manager');
   assert.equal(r.status,400);assert.equal(r.body.error.code,'PLATFORM_INVALID_INPUT');assert.equal(h.providerCalls.length,count);
  }
  assert.deepEqual(await h.snapshot(),before);
 }finally{await h.db.close();}
});

test('AC-MMA-HTTP-004: current Platform role and correct Channel are required for review',async()=>{
 const h=await setup();try{
  await h.qualify();const a=application(await h.send()),before=await h.snapshot();
  const denied=await h.decide(a,'approved',{},'manager');assert.equal(denied.status,403);assert.equal(denied.body.error.code,'PLATFORM_ADMIN_REQUIRED');
  assert.equal(h.providerCalls.at(-1).channel,'2012065297');assert.equal((await h.decide(a,'approved',{},'wrong-channel')).status,401);
  assert.deepEqual(await h.snapshot(),before);
  const requestId=crypto.randomUUID();application(await h.decide(a,'rejected',{requestId}));
  await h.db.exec('update platform_private.super_admins set enabled=false');const revoked=await h.decide(a,'rejected',{requestId});
  assert.equal(revoked.status,403);assert.equal(revoked.body.error.code,'PLATFORM_ADMIN_REQUIRED');
 }finally{await h.db.close();}
});

test('AC-MMA-HTTP-005: unapplied/pending/rejected/suspended qualification cannot submit/read/replay merchant actions',async()=>{
 const h=await setup();try{
  const check=async()=>{for(const [action,body]of [['submit',{businessName:'Name',requestId:crypto.randomUUID()}],['list',{}],['get',{applicationId:crypto.randomUUID()}]]){
   const r=await h.api(action,body);assert.equal(r.status,403);assert.equal(r.body.error.code,'PLATFORM_QUALIFICATION_REQUIRED');
  }};
  await check();let q=await h.call('platform_submit_admin_qualification',[owner,'Synthetic',crypto.randomUUID()]);await check();
  q=await h.call('platform_review_admin_qualification',[root,q.id,q.version,'rejected','Reason',crypto.randomUUID()]);await check();
  q=await h.qualify();const requestId=crypto.randomUUID();application(await h.send('merchant-a',{requestId}));
  await h.call('platform_review_admin_qualification',[root,q.id,q.version,'suspended','Reason',crypto.randomUUID()]);await check();
  const replay=await h.send('merchant-a',{requestId});assert.equal(replay.status,403);assert.equal(replay.body.error.code,'PLATFORM_QUALIFICATION_REQUIRED');
  assert.equal(await h.count('applications'),1);
 }finally{await h.db.close();}
});

test('AC-MMA-HTTP-006: submit/get validate UUIDs, Unicode names, slug and paired positive int32 versions before writer RPC',async()=>{
 const h=await setup();try{
  await h.qualify();const before=await h.snapshot();
  for(const body of [{businessName:' '},{businessName:null},{businessName:'😀'.repeat(101)},{slug:'admin'},{slug:'Aaa'},{slug:'ab'},
   {slug:'a'.repeat(41)},{requestId:null},{requestId:[]},{applicationId:null},{applicationId:crypto.randomUUID()},
   {expectedVersion:1},{applicationId:crypto.randomUUID(),expectedVersion:0},{applicationId:crypto.randomUUID(),expectedVersion:2147483648},
   {applicationId:crypto.randomUUID(),expectedVersion:'1'},{applicationId:crypto.randomUUID(),expectedVersion:1.5}]){
   const count=h.rpcCalls.length,r=await h.send('merchant-a',body);assert.equal(r.status,400,JSON.stringify(body));assert.equal(h.rpcCalls.length,count);
  }
  for(const applicationId of [undefined,null,[],123,'bad'])assert.equal((await h.api('get',{applicationId})).status,400);
  assert.deepEqual(await h.snapshot(),before);
  const a=application(await h.send('merchant-a',{businessName:'  '+'😀'.repeat(100)+'  '}));assert.equal(a.businessName,'😀'.repeat(100));
 }finally{await h.db.close();}
});

test('AC-MMA-HTTP-007: review requires explicit version, decision, bounded reason and exactly eight boolean grants',async()=>{
 const h=await setup();try{
  await h.qualify();const a=application(await h.send()),before=await h.snapshot();
  for(const body of [{applicationId:null},{expectedVersion:undefined},{expectedVersion:0},{expectedVersion:2147483648},{expectedVersion:'1'},
   {decision:'suspended'},{reason:null},{reason:'😀'.repeat(501)},{features:null},{features:{}},{features:[]},
   {features:{...features([]),extra:true}},{features:{...features([]),points:1}},{requestId:null},
   {decision:'rejected',features:null,reason:' '},{decision:'rejected',reason:'No',features:features([])}]){
   const count=h.rpcCalls.filter(x=>x.name==='platform_review_merchant_application').length,r=await h.decide(a,'approved',body);
   assert.equal(r.status,400,JSON.stringify(body));assert.equal(h.rpcCalls.filter(x=>x.name==='platform_review_merchant_application').length,count);
  }
  assert.deepEqual(await h.snapshot(),before);
  const rejected=application(await h.decide(a,'rejected',{reason:' '+'😀'.repeat(500)+' '}));assert.equal(rejected.reviewReason,'😀'.repeat(500));
 }finally{await h.db.close();}
});

test('AC-MMA-HTTP-008: idempotent submit/review return current state; conflicts, duplicate slug and stale versions are stable 409s',async()=>{
 const h=await setup();try{
  await h.qualify();const requestId=crypto.randomUUID(),a=application(await h.send('merchant-a',{requestId}));
  assert.deepEqual(application(await h.send('merchant-a',{requestId})),a);
  const collisionId=crypto.randomUUID();await h.submit(owner,'m-'+collisionId.replaceAll('-',''),'Existing reserved code');
  for(const [r,code]of [[await h.send('different',{requestId}),'PLATFORM_REQUEST_CONFLICT'],[await h.send('Collision',{requestId:collisionId}),'PLATFORM_DUPLICATE_SLUG']]){
   assert.equal(r.status,409);assert.equal(r.body.error.code,code);
  }
  const reviewId=crypto.randomUUID(),approved=application(await h.decide(a,'approved',{requestId:reviewId}));
  assert.deepEqual(application(await h.decide(a,'approved',{requestId:reviewId})),approved);
  assert.equal(application(await h.send('merchant-a',{requestId})).status,'approved');
  const stale=await h.decide(a,'rejected');assert.equal(stale.status,409);assert.equal(stale.body.error.code,'PLATFORM_CONFLICT');
  assert.equal(await h.count('tenants'),1);
 }finally{await h.db.close();}
});

test('AC-MMA-HTTP-009: rejected resubmission selects exact owned application and preserves other pending merchant',async()=>{
 const h=await setup();try{
  await h.qualify();await h.qualify(other);const a=application(await h.send()),b=application(await h.send('merchant-b'));
  const rejected=application(await h.decide(a,'rejected'));
  const foreign=await h.send('foreign-merchant',{applicationId:a.id,expectedVersion:rejected.version},'other');assert.equal(foreign.status,404);
  const next=application(await h.send('merchant-new',{applicationId:a.id,expectedVersion:rejected.version}));
  assert.equal(next.id,a.id);assert.equal(next.version,3);assert.equal(next.status,'pending');assert.equal(next.reviewReason,null);
  assert.deepEqual(application(await h.api('get',{applicationId:b.id})),b);
  const repeat=await h.send('merchant-new',{applicationId:a.id,expectedVersion:next.version});
  assert.equal(repeat.status,409);assert.equal(repeat.body.error.code,'PLATFORM_APPLICATION_REVIEWED');
 }finally{await h.db.close();}
});

test('AC-MMA-HTTP-010: missing/invalid identity, origin and rate-limit failures cannot call merchant SQL',async()=>{
 let limited=false,failed=false;const h=await setup({rate:()=>failed?{data:null,error:Error('sensitive limiter detail')}:{data:!limited,error:null}});try{
  await h.qualify();const before=await h.snapshot();
  for(const [token,origin,status]of [['','https://allowed.test',401],['invalid','https://allowed.test',401],['manager','https://evil.test',403]])
   assert.equal((await h.api('list',{},token,origin)).status,status);
  limited=true;assert.equal((await h.send()).status,429);failed=true;const r=await h.send();assert.equal(r.status,503);
  assert.ok(!JSON.stringify(r.body).includes('sensitive'));assert.equal(h.rpcCalls.length,0);assert.deepEqual(await h.snapshot(),before);
 }finally{await h.db.close();}
});

test('AC-MMA-HTTP-011: real SQL audit failure rolls back approval, schema and request with safe service error',async()=>{
 const h=await setup();try{
  await h.qualify();const a=application(await h.send()),before=await h.snapshot();
  await h.db.exec("create function public.fail_api_audit()returns trigger language plpgsql as $$begin if new.action='MERCHANT_APPLICATION_APPROVED' then raise exception 'PRIVATE_PROVIDER_SECRET';end if;return new;end$$;create trigger fail_api before insert on platform_private.audit_events for each row execute function public.fail_api_audit();");
  const r=await h.decide(a);assert.equal(r.status,503);assert.equal(r.body.error.code,'PLATFORM_DATABASE_UNAVAILABLE');
  assert.ok(!JSON.stringify(r.body).includes('PRIVATE_PROVIDER_SECRET'));assert.deepEqual(await h.snapshot(),before);
  assert.equal((await h.db.query("select count(*)::int n from pg_namespace where nspname like 'business_%'")).rows[0].n,0);
  assert.equal((await h.get(a.id)).status,'pending');
 }finally{await h.db.close();}
});

test('AC-MMA-HTTP-012: Platform bootstrap sanitizes nested merchant tenant rows and preserves reviewer selectors',async()=>{
 const h=await setup();try{
  await h.qualify();const a=application(await h.send());application(await h.decide(a));
  const r=await h.api('list',{action:'platform.bootstrap'},'root');assert.equal(r.status,200,JSON.stringify(r.body));
  const listed=r.body.data.applications[0];safe(listed);
  assert.equal(listed.applicantLineUserId,owner);assert.equal(listed.tenantId,(await h.get(a.id)).tenant.id);
  assert.deepEqual(listed.tenant,r.body.data.tenants[0]);
 }finally{await h.db.close();}
});
