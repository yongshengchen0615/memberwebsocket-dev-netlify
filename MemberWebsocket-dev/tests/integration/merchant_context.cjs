const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {setup:base,owner,other,root,features}=require('./fixtures/merchant-applications.cjs');
const dir=path.resolve(__dirname,'../../supabase/migrations');
const file=fs.readdirSync(dir).find(n=>n.endsWith('_merchant_explicit_context.sql'));
const migration=fs.readFileSync(path.join(dir,file),'utf8');
const issued=()=>new Date(Date.now()+1000).toISOString();
async function setup(){const h=await base();try{await h.db.exec(migration);await h.qualify();
 h.a=await h.review(await h.submit(owner,'merchant-a','A'),'approved',features(['points','booking']));
 h.b=await h.review(await h.submit(owner,'merchant-b','B'),'approved',features(['booking']));
 return h;}catch(e){await h.db.close();throw e;}}
async function runtimeGuard(h){
 const files=fs.readdirSync(dir).filter(n=>n.endsWith('_merchant_runtime_transaction_guard.sql'));
 assert.ok(files.length<=1,'only one runtime transaction guard migration may be installed');
 if(files.length)await h.db.exec(fs.readFileSync(path.join(dir,files[0]),'utf8'));
}
const adminHeaders=(a,actor=owner,timestamp=issued())=>({'x-platform-admin-actor':actor,
 'x-platform-admin-tenant':a.tenant.id,'x-platform-admin-issued-at':timestamp,'content-profile':a.tenant.runtime_schema});
async function guarded(h,headers,sql='select 1',args=[],{role='service_role',readOnly=false}={}){
 assert.ok(['service_role','anon','authenticated'].includes(role));
 await h.db.exec('begin'+(readOnly?' read only':''));
 try{
  await h.db.exec('set local role '+role);
  await h.db.query("select set_config('request.headers',$1,true)",[JSON.stringify(headers)]);
  await h.db.query('select public.platform_business_pre_request()');
  const result=await h.db.query(sql,args);await h.db.exec('commit');return result;
 }catch(error){await h.db.exec('rollback');throw error;}
}

test('AC-MMA-C001: explicit context resolves exact approved owned merchant, never implicit first tenant',async()=>{
 const h=await setup();try{
  for(const a of [h.a,h.b]){const got=await h.call('platform_my_merchant_context',[owner,a.slug,issued()]);assert.equal(got.id,a.id);assert.equal(got.tenant.id,a.tenant.id);}
  await h.qualify(other);await assert.rejects(h.call('platform_my_merchant_context',[other,h.a.slug,issued()]),/PLATFORM_APPLICATION_NOT_FOUND/);
  await assert.rejects(h.call('platform_my_merchant_context',[owner,null,issued()]),/PLATFORM_INVALID_INPUT/);
  const pending=await h.submit(owner,'merchant-pending','Pending');await assert.rejects(h.call('platform_my_merchant_context',[owner,pending.slug,issued()]),/PLATFORM_APPLICATION_NOT_APPROVED/);
 }finally{await h.db.close();}
});

test('AC-MMA-C002: scoped LINE/module/notification writers isolate A/B and bind retry to tenant',async()=>{
 const h=await setup();try{
  const request=crypto.randomUUID(),hash='a'.repeat(64);
  const saved=await h.call('platform_save_notification_route_for_merchant',[owner,h.a.tenant.id,issued(),'points','member','disabled',h.a.tenant.version,request,hash,null,null]);
  assert.equal(saved.id,h.a.tenant.id);assert.equal(saved.module_line.points.notifications.member.mode,'disabled');
  assert.deepEqual((await h.get(h.b.id)).tenant,h.b.tenant);
  await assert.rejects(h.call('platform_save_notification_route_for_merchant',[owner,h.b.tenant.id,issued(),'booking','member','disabled',h.b.tenant.version,request,hash,null,null]),/PLATFORM_REQUEST_CONFLICT/);
  const {sealCredentials}=await import('../../supabase/functions/_shared/platform-crypto.mjs');
  const envelope=await sealCredentials(h.b.tenant.id+':booking',{channelAccessToken:'synthetic-only',channelSecret:'a'.repeat(32)},Buffer.alloc(32,7).toString('base64'));
  const b=await h.call('platform_save_module_line_for_merchant',[owner,h.b.tenant.id,issued(),'booking',h.b.tenant.version,crypto.randomUUID(),hash,{bookingLiffId:'2010787602-booking'},envelope]);
  assert.equal(b.id,h.b.tenant.id);assert.equal(b.module_line.booking.line.bookingLiffId,'2010787602-booking');
  await assert.rejects(h.call('platform_save_module_line_for_merchant',[owner,h.b.tenant.id,issued(),'points',b.version,crypto.randomUUID(),hash,{},null]),/PLATFORM_FEATURE_DISABLED/);
  const fresh=await h.call('platform_save_notification_route_for_merchant',[owner,h.a.tenant.id,issued(),'points','member','disabled',h.a.tenant.version,request,hash,null,null]);assert.equal(fresh.version,saved.version);
  for(const id of [h.a.tenant.id,h.b.tenant.id])await assert.rejects(h.call('platform_save_my_line_for_merchant',[other,id,issued(),1,crypto.randomUUID(),hash,{},null]),/PLATFORM_QUALIFICATION_REQUIRED/);
 }finally{await h.db.close();}
});

test('AC-MMA-C003: qualification suspension rejects both merchants and old request replay; resume still requires fresh token',async()=>{
 const h=await setup();try{
  const tokenBefore=new Date(Date.now()-60000).toISOString(),id=crypto.randomUUID();
  await h.call('platform_notification_test_for_merchant',[owner,h.a.tenant.id,tokenBefore,'booking','member',h.a.tenant.version,id,'b'.repeat(64),null]);
  let q=await h.call('platform_my_admin_qualification',[owner]);
  q=await h.call('platform_review_admin_qualification',[root,q.id,q.version,'suspended','Stop',crypto.randomUUID()]);
  for(const a of [h.a,h.b])await assert.rejects(h.call('platform_my_merchant_context',[owner,a.slug,issued()]),/PLATFORM_QUALIFICATION_REQUIRED/);
  await assert.rejects(h.call('platform_notification_test_for_merchant',[owner,h.a.tenant.id,tokenBefore,'booking','member',h.a.tenant.version,id,'b'.repeat(64),null]),/PLATFORM_QUALIFICATION_REQUIRED/);
  await h.call('platform_review_admin_qualification',[root,q.id,q.version,'approved','',crypto.randomUUID()]);
  for(const a of [h.a,h.b])await assert.rejects(h.call('platform_my_merchant_context',[owner,a.slug,tokenBefore]),/TENANT_REAUTH_REQUIRED/);
  await assert.rejects(h.call('platform_notification_test_for_merchant',[owner,h.a.tenant.id,tokenBefore,'booking','member',h.a.tenant.version,id,'b'.repeat(64),null]),/TENANT_REAUTH_REQUIRED/);
  assert.equal((await h.call('platform_my_merchant_context',[owner,h.b.slug,issued()])).tenant.id,h.b.tenant.id);
 }finally{await h.db.close();}
});

test('AC-MMA-C004: public routing metadata preserves tenant cutoff separately from owner admin cutoff',async()=>{
 const h=await setup();try{
  let q=await h.call('platform_my_admin_qualification',[owner]);q=await h.call('platform_review_admin_qualification',[root,q.id,q.version,'suspended','Stop',crypto.randomUUID()]);
  const c=await h.call('platform_business_context_v2',[owner,h.a.slug]);
  assert.equal(c.owner_qualification_status,'suspended');assert.ok(c.admin_access_revoked_before);assert.equal(c.access_revoked_before,null);
  assert.equal((await h.call('platform_business_context_v2',[null,h.b.slug])).id,h.b.tenant.id);
  await assert.rejects(h.call('platform_business_context_v2',[owner,null]),/PLATFORM_BUSINESS_SELECTION_REQUIRED/);
  await h.db.query("update platform_private.tenants set status='suspended' where id=$1",[h.a.tenant.id]);
  await h.call('platform_review_admin_qualification',[root,q.id,q.version,'approved','',crypto.randomUUID()]);
  await assert.rejects(h.call('platform_my_merchant_context',[owner,h.a.slug,issued()]),/PLATFORM_TENANT_NOT_FOUND/);
  assert.equal((await h.call('platform_my_merchant_context',[owner,h.b.slug,issued()])).status,'approved');
 }finally{await h.db.close();}
});

test('AC-MMA-C005: new context and writer RPCs are invoker/service-only, safe on missing or nonfinite issuedAt',async()=>{
 const h=await setup();try{
  for(const timestamp of [null,'infinity',new Date(Date.now()+120000).toISOString()])await assert.rejects(h.call('platform_my_merchant_context',[owner,h.a.slug,timestamp]),/TENANT_REAUTH_REQUIRED/);
  const calls=[['platform_business_context_v2',[owner,h.a.slug]],['platform_my_merchant_context',[owner,h.a.slug,issued()]],
   ['platform_save_my_line_for_merchant',[owner,h.a.tenant.id,issued(),1,crypto.randomUUID(),'a'.repeat(64),{},null]]];
  for(const role of ['anon','authenticated'])for(const [name,args]of calls)await assert.rejects(h.call(name,args,role),/permission denied/);
  const flags=(await h.db.query("select prosecdef,proconfig from pg_proc where proname like '%_for_merchant' or proname in ('platform_business_context_v2','platform_my_merchant_context')")).rows;
  assert.equal(flags.length,6);assert.ok(flags.every(f=>!f.prosecdef&&f.proconfig.includes('search_path=\"\"')));
 }finally{await h.db.close();}
});

test('AC-MMA-C008: transaction guard binds verified admin actor and selected tenant to the actual runtime profile',async()=>{
 const h=await setup();try{
  await runtimeGuard(h);await h.qualify(other);const headers=adminHeaders(h.a);
  const update=`update ${h.a.tenant.runtime_schema}.booking_no_show_policy set contact_text=$1`;
  await guarded(h,headers,update,['GUARDED A']);
  assert.equal((await h.db.query(`select contact_text from ${h.a.tenant.runtime_schema}.booking_no_show_policy`)).rows[0].contact_text,'GUARDED A');
  assert.notEqual((await h.db.query(`select contact_text from ${h.b.tenant.runtime_schema}.booking_no_show_policy`)).rows[0].contact_text,'GUARDED A');
  for(const invalid of [
   {...headers,'x-platform-admin-actor':other},
   {...headers,'x-platform-admin-tenant':h.b.tenant.id},
   {...headers,'content-profile':h.b.tenant.runtime_schema},
   {...headers,'x-platform-admin-issued-at':''},
   {...headers,'x-platform-admin-issued-at':'not-a-timestamp'},
   {...headers,'x-platform-admin-issued-at':'infinity'},
   {...headers,'x-platform-admin-issued-at':new Date(Date.now()+120000).toISOString()},
   {'x-platform-admin-actor':owner},
  ])await assert.rejects(guarded(h,invalid,update,['MUST NOT COMMIT']),/PLATFORM_|BUSINESS_|TENANT_REAUTH_REQUIRED/);
  assert.equal((await h.db.query(`select contact_text from ${h.a.tenant.runtime_schema}.booking_no_show_policy`)).rows[0].contact_text,'GUARDED A');
 }finally{await h.db.close();}
});

test('AC-MMA-C009: committed qualification suspension blocks guarded tenant writes and resume rejects the original verified timestamp',async()=>{
 const h=await setup();try{
  await runtimeGuard(h);const timestamp=new Date(Date.now()-60000).toISOString(),headers=adminHeaders(h.a,owner,timestamp);
  const update=`update ${h.a.tenant.runtime_schema}.booking_no_show_policy set contact_text=$1`;
  await guarded(h,headers,update,['BEFORE SUSPENSION']);
  let q=await h.call('platform_my_admin_qualification',[owner]);
  q=await h.call('platform_review_admin_qualification',[root,q.id,q.version,'suspended','Stop',crypto.randomUUID()]);
  for(const a of [h.a,h.b])await assert.rejects(guarded(h,adminHeaders(a),`update ${a.tenant.runtime_schema}.booking_no_show_policy set contact_text='MUST NOT COMMIT'`),/PLATFORM_QUALIFICATION_REQUIRED/);
  await h.call('platform_review_admin_qualification',[root,q.id,q.version,'approved','',crypto.randomUUID()]);
  await assert.rejects(guarded(h,headers,update,['OLD TOKEN MUST NOT COMMIT']),/TENANT_REAUTH_REQUIRED/);
  assert.equal((await h.db.query(`select contact_text from ${h.a.tenant.runtime_schema}.booking_no_show_policy`)).rows[0].contact_text,'BEFORE SUSPENSION');
  await guarded(h,adminHeaders(h.a),update,['FRESH AFTER RESUME']);
  assert.equal((await h.db.query(`select contact_text from ${h.a.tenant.runtime_schema}.booking_no_show_policy`)).rows[0].contact_text,'FRESH AFTER RESUME');
 }finally{await h.db.close();}
});

test('AC-MMA-C010: readonly admin requests validate without row locks while unmarked public/member/job requests retain their existing authorization',async()=>{
 const h=await setup();try{
  await runtimeGuard(h);const headers=adminHeaders(h.a);delete headers['content-profile'];headers['accept-profile']=h.a.tenant.runtime_schema;
  const read=await guarded(h,headers,`select contact_text from ${h.a.tenant.runtime_schema}.booking_no_show_policy`,[],{readOnly:true});assert.equal(read.rows.length,1);
  for(const role of ['anon','authenticated']){
   assert.equal((await guarded(h,{},'select 1 as allowed',[],{role,readOnly:true})).rows[0].allowed,1);
   await assert.rejects(guarded(h,headers,'select 1',[],{role}),/PLATFORM_|BUSINESS_|permission denied/);
  }
  let q=await h.call('platform_my_admin_qualification',[owner]);await h.call('platform_review_admin_qualification',[root,q.id,q.version,'suspended','Stop',crypto.randomUUID()]);
  await assert.rejects(guarded(h,headers,'select 1',[],{readOnly:true}),/PLATFORM_QUALIFICATION_REQUIRED/);
  await guarded(h,{},`update ${h.a.tenant.runtime_schema}.booking_no_show_policy set contact_text='UNMARKED EXISTING CONTRACT'`);
  assert.equal((await h.db.query(`select contact_text from ${h.a.tenant.runtime_schema}.booking_no_show_policy`)).rows[0].contact_text,'UNMARKED EXISTING CONTRACT');
 }finally{await h.db.close();}
});

test('AC-MMA-C011: authenticator installs the invoker hook with a fixed search path',async()=>{
 const h=await setup();try{
  await runtimeGuard(h);
  const flags=(await h.db.query("select prosecdef,proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='platform_business_pre_request'")).rows;
  assert.equal(flags.length,1,'runtime request guard function must be installed');
  assert.equal(flags[0].prosecdef,false);assert.ok(flags[0].proconfig.includes('search_path=\"\"'));
  const settings=(await h.db.query("select rolconfig from pg_roles where rolname='authenticator'")).rows[0].rolconfig;
  assert.ok(settings.includes('pgrst.db_pre_request=public.platform_business_pre_request'));
 }finally{await h.db.close();}
});
