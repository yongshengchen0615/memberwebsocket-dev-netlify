const test=require('node:test'),assert=require('node:assert/strict');
const {setup,merchant,root,owner,other,features}=require('./fixtures/merchant-applications.cjs');

test('AC-MMA-M001: approved A plus a new B produces independent pending B, leaving A and its grants unchanged',async()=>{
 let original;
 const h=await setup({before:async h=>{const t=await h.approve(owner,'merchant-a',features(['membership','booking']));original=(await h.db.query('select * from platform_private.tenants where id=$1',[t.id])).rows[0];}});try{
  const a=(await h.list())[0],b=await h.submit();
  assert.notEqual(b.id,a.id);assert.equal(b.slug,'merchant-b');assert.equal(b.status,'pending');assert.equal(b.version,1);assert.equal(b.tenant,null);
  assert.deepEqual((await h.db.query('select * from platform_private.tenants where id=$1',[original.id])).rows[0],original);
  assert.equal(await h.count('applications'),2);assert.equal(await h.count('tenants'),1);
  assert.deepEqual((await h.list()).map(a=>a.slug).sort(),['merchant-a','merchant-b']);
 }finally{await h.db.close();}
});

test('AC-MMA-M002: unapplied, pending, rejected and suspended qualifications cannot create merchants',async()=>{
 const h=await setup();try{
  for(const state of ['unapplied','pending','rejected','suspended']){
   const actor='U'+String(['unapplied','pending','rejected','suspended'].indexOf(state)+4).repeat(32);
   if(state!=='unapplied'){
    let q=await h.call('platform_submit_admin_qualification',[actor,'Synthetic owner',crypto.randomUUID()]);
    if(state!=='pending')q=await h.call('platform_review_admin_qualification',[root,q.id,q.version,state==='suspended'?'approved':'rejected',state==='rejected'?'Incomplete':'',crypto.randomUUID()]);
    if(state==='suspended')await h.call('platform_review_admin_qualification',[root,q.id,q.version,'suspended','Suspended',crypto.randomUUID()]);
   }
   await assert.rejects(h.submit(actor,'blocked-'+state),/PLATFORM_QUALIFICATION_REQUIRED/);
  }
  assert.equal(await h.count('applications'),0);assert.equal(await h.count('tenants'),0);
 }finally{await h.db.close();}
});

test('AC-MMA-M003: retry binds request identity/body and returns current status; suspension still rejects an old request',async()=>{
 const h=await setup();try{
  const q=await h.qualify(),request=crypto.randomUUID(),a=await h.submit(owner,'merchant-b','Merchant B',request);
  assert.deepEqual(await h.submit(owner,'merchant-b','Merchant B',request),a);
  await assert.rejects(h.submit(owner,'merchant-c','Merchant C',request),/PLATFORM_REQUEST_CONFLICT/);
  await h.qualify(other);await assert.rejects(h.submit(other,'merchant-b','Merchant B',request),/PLATFORM_REQUEST_CONFLICT/);
  await h.review(a,'rejected',null,'Incomplete');
  assert.equal((await h.submit(owner,'merchant-b','Merchant B',request)).status,'rejected');
  await h.call('platform_review_admin_qualification',[root,q.id,q.version,'suspended','Stop',crypto.randomUUID()]);
  await assert.rejects(h.submit(owner,'merchant-b','Merchant B',request),/PLATFORM_QUALIFICATION_REQUIRED/);
  assert.equal(await h.count('applications'),1);assert.equal(await h.count('tenants'),0);
 }finally{await h.db.close();}
});

test('AC-MMA-M004: list/get enforce ownership; duplicate slug cannot reserve another merchant or create an audit',async()=>{
 const h=await setup();try{
  await h.qualify();await h.qualify(other);const a=await h.submit(),before=await h.count('audit_events');
  await assert.rejects(h.submit(other),/PLATFORM_DUPLICATE_SLUG/);
  await assert.rejects(h.get(a.id,other),/PLATFORM_APPLICATION_NOT_FOUND/);
  assert.deepEqual(await h.list(other),[]);assert.equal(await h.count('applications'),1);assert.equal(await h.count('audit_events'),before);
  await assert.rejects(h.get(crypto.randomUUID()),/PLATFORM_APPLICATION_NOT_FOUND/);
 }finally{await h.db.close();}
});

test('AC-MMA-M005: rejected resubmission is explicit, owner-scoped and versioned; other merchants remain unchanged',async()=>{
 const h=await setup();try{
  await h.qualify();const a=await h.submit(),b=await h.submit(owner,'merchant-c','Merchant C');
  await assert.rejects(h.review(a,'rejected',null,' '),/PLATFORM_INVALID_INPUT/);
  const rejected=await h.review(a,'rejected',null,'Incomplete');assert.equal(rejected.version,2);
  await assert.rejects(h.submit(owner,'merchant-b','Updated',crypto.randomUUID(),a.id,1),/PLATFORM_CONFLICT/);
  const next=await h.submit(owner,'merchant-new','Updated',crypto.randomUUID(),a.id,rejected.version);
  assert.equal(next.id,a.id);assert.equal(next.status,'pending');assert.equal(next.version,3);assert.equal(next.reviewReason,null);
  assert.deepEqual(await h.get(b.id),b);
  await h.qualify(other);await assert.rejects(h.submit(other,'foreign-merchant','Foreign',crypto.randomUUID(),a.id,3),/PLATFORM_APPLICATION_NOT_FOUND/);
  await assert.rejects(h.submit(owner,'merchant-new','Updated',crypto.randomUUID(),a.id,3),/PLATFORM_APPLICATION_REVIEWED/);
 }finally{await h.db.close();}
});

test('AC-MMA-M006: only current Platform administrators review; stale/opposed decisions and malformed grants cannot write',async()=>{
 const h=await setup();try{
  await h.qualify();const a=await h.submit(),before=await h.count('audit_events');
  await assert.rejects(h.review(a,'approved',features(['points']),'',crypto.randomUUID(),owner),/PLATFORM_ADMIN_REQUIRED/);
  await assert.rejects(h.review(a,'approved',null),/PLATFORM_INVALID_INPUT/);
  await assert.rejects(h.review(a,'approved',{}),/PLATFORM_INVALID_INPUT/);
  await assert.rejects(h.review(a,'rejected',features([]),'Reason'),/PLATFORM_INVALID_INPUT/);
  assert.equal(await h.count('audit_events'),before);
  const request=crypto.randomUUID(),rejected=await h.review(a,'rejected',null,'No',request);
  assert.deepEqual(await h.review(a,'rejected',null,'No',request),rejected);
  await assert.rejects(h.review(a,'approved'),/PLATFORM_CONFLICT/);
  await h.db.query("insert into platform_private.super_admins(line_user_id,display_name,enabled,singleton,admin_id)values($1,'Additional Platform admin',true,null,null)",[other]);
  const additional=await h.submit(owner,'merchant-c','Merchant C'),otherRequest=crypto.randomUUID();
  assert.equal((await h.review(additional,'rejected',null,'No',otherRequest,other)).status,'rejected');
  await h.db.query('update platform_private.super_admins set enabled=false where line_user_id=$1',[other]);
  await assert.rejects(h.review(additional,'rejected',null,'No',otherRequest,other),/PLATFORM_ADMIN_REQUIRED/);
  await h.db.exec('update platform_private.super_admins set enabled=false');
  await assert.rejects(h.review(a,'rejected',null,'No',request),/PLATFORM_ADMIN_REQUIRED/);
 }finally{await h.db.close();}
});

test('AC-MMA-M007: approving B provisions a separate private schema and its own grants without copying A data or credentials',async()=>{
 let first;
 const h=await setup({before:async h=>{first=await h.approve(owner,'merchant-a',features(['membership','booking']));}});try{
  await h.db.query(`update ${first.runtime_schema}.booking_no_show_policy set contact_text='A only marker'`);
  const a=await h.submit(),request=crypto.randomUUID(),approved=await h.review(a,'approved',features(['points']),'',request);
  assert.equal(approved.status,'approved');assert.equal(approved.version,2);assert.equal(approved.tenant.status,'active');
  assert.notEqual(approved.tenant.id,first.id);assert.notEqual(approved.tenant.runtime_schema,first.runtime_schema);
  assert.deepEqual(approved.tenant.features,features(['points']));assert.equal(approved.tenant.credentials_configured,false);
  assert.deepEqual(approved.tenant.line_config,{});assert.deepEqual(approved.tenant.module_line,{});
  assert.equal((await h.db.query(`select contact_text from ${first.runtime_schema}.booking_no_show_policy`)).rows[0].contact_text,'A only marker');
  assert.notEqual((await h.db.query(`select contact_text from ${approved.tenant.runtime_schema}.booking_no_show_policy`)).rows[0].contact_text,'A only marker');
  assert.equal(await h.count('tenant_secrets'),0);assert.equal(await h.count('module_secrets'),0);
  assert.deepEqual(await h.review(a,'approved',features(['points']),'',request),approved);
  await assert.rejects(h.submit(owner,'replace-approved','Changed',crypto.randomUUID(),a.id,2),/PLATFORM_APPLICATION_REVIEWED/);
  await h.db.query("update platform_private.tenants set status='suspended' where id=$1",[approved.tenant.id]);
  assert.equal((await h.review(a,'approved',features(['points']),'',request)).tenant.status,'suspended');
 }finally{await h.db.close();}
});

for(const failure of ['audit','provision'])test(`AC-MMA-M008: ${failure} failure rolls back tenant, private schema, approval, audit and idempotency together`,async()=>{
 const h=await setup();try{
  await h.qualify();const a=await h.submit(),request=crypto.randomUUID(),before=await h.count('audit_events');
  if(failure==='audit')await h.db.exec("create function public.fail_merchant_audit() returns trigger language plpgsql as $$begin if new.action='MERCHANT_APPLICATION_APPROVED' then raise exception 'SYNTHETIC_MERCHANT_FAILURE';end if;return new;end$$;create trigger fail_merchant before insert on platform_private.audit_events for each row execute function public.fail_merchant_audit();");
  else await h.db.exec("alter function public.platform_provision_business(uuid) rename to fixture_original_provision; create function public.platform_provision_business(uuid) returns void language plpgsql security invoker set search_path='' as $$begin perform public.fixture_original_provision($1);raise exception 'SYNTHETIC_MERCHANT_FAILURE';end$$;revoke all on function public.platform_provision_business(uuid) from public;grant execute on function public.platform_provision_business(uuid) to service_role;");
  await assert.rejects(h.review(a,'approved',features(['points']),'',request),/SYNTHETIC_MERCHANT_FAILURE/);
  assert.deepEqual(await h.get(a.id),a);assert.equal(await h.count('tenants'),0);assert.equal(await h.count('audit_events'),before);
  assert.equal((await h.db.query("select count(*)::int n from pg_namespace where nspname like 'business_%'")).rows[0].n,0);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.requests where request_id=$1',[request])).rows[0].n,0);
 }finally{await h.db.close();}
});

test('AC-MMA-M009: legacy owner-only reads/settings/context fail closed on ambiguity and blind legacy writers reject',async()=>{
 let first;
 const h=await setup({before:async h=>{first=await h.approve(owner,'merchant-a');}});try{
  await h.db.query("update platform_private.tenants set expires_at=clock_timestamp()-interval '1 minute' where id=$1",[first.id]);
  await assert.rejects(h.call('platform_save_module_line',[owner,'points',1,crypto.randomUUID(),'a'.repeat(64),{},null]),/TENANT_EXPIRED/);
  await h.db.query('update platform_private.tenants set expires_at=null where id=$1',[first.id]);
  const saved=await h.call('platform_save_notification_route',[owner,'points','member','disabled',1,crypto.randomUUID(),'a'.repeat(64),null,null]);
  assert.equal(saved.module_line.points.notifications.member.mode,'disabled');
  await h.submit();
  for(const [name,args]of [
   ['platform_my_application',[owner]],
   ['platform_save_my_line',[owner,1,crypto.randomUUID(),'a'.repeat(64),{},null]],
   ['platform_save_module_line',[owner,'points',1,crypto.randomUUID(),'a'.repeat(64),{},null]],
   ['platform_save_notification_route',[owner,'points','member','disabled',1,crypto.randomUUID(),'a'.repeat(64),'',null]],
   ['platform_notification_test',[owner,'points','member',1,crypto.randomUUID(),'a'.repeat(64),null]],
  ])await assert.rejects(h.call(name,args),/PLATFORM_BUSINESS_SELECTION_REQUIRED/,name);
  await assert.rejects(h.call('platform_submit_application',[owner,'New','new-merchant']),/PLATFORM_MERCHANT_API_REQUIRED/);
  const a=(await h.list()).find(a=>a.slug==='merchant-b');
  await assert.rejects(h.call('platform_approve_application',[root,a.id,features(['points']),crypto.randomUUID()]),/PLATFORM_MERCHANT_API_REQUIRED/);
  await h.review(a);
  await assert.rejects(h.call('platform_business_context',[owner,null]),/PLATFORM_BUSINESS_SELECTION_REQUIRED/);
  assert.equal((await h.call('platform_business_context',[owner,'merchant-a'])).id,first.id);
 }finally{await h.db.close();}
});

test('AC-MMA-M010: malformed input and qualification-owner mismatch cannot change persisted application state',async()=>{
 const h=await setup();try{
  await h.qualify();
  for(const [actor,name,slug,request,id,version]of [[null,'Name','valid-slug',crypto.randomUUID(),null,null],[owner,' ','valid-slug',crypto.randomUUID(),null,null],[owner,'a'.repeat(101),'valid-slug',crypto.randomUUID(),null,null],[owner,'Name','admin',crypto.randomUUID(),null,null],[owner,'Name','INVALID',crypto.randomUUID(),null,null],[owner,'Name','valid-slug',null,null,null],[owner,'Name','valid-slug',crypto.randomUUID(),null,1]])
   await assert.rejects(h.submit(actor,slug,name,request,id,version),/PLATFORM_INVALID_INPUT/);
  assert.equal(await h.count('applications'),0);
  await h.qualify(other);const a=await h.submit();const q=(await h.db.query('select id from platform_private.admin_qualifications where applicant_line_user_id=$1',[other])).rows[0];
  await assert.rejects(h.db.query('update platform_private.applications set qualification_id=$1 where id=$2',[q.id,a.id]),/foreign key/);
 }finally{await h.db.close();}
});

test('AC-MMA-M011: browser roles cannot execute new RPCs or read application rows; functions are invokers with fixed search paths',async()=>{
 const h=await setup();try{
  await h.qualify();const a=await h.submit();
  const calls=[['platform_my_merchant_applications',[owner]],['platform_get_merchant_application',[owner,a.id]],['platform_submit_merchant_application',[owner,'Name','other-merchant',crypto.randomUUID(),null,null]],['platform_review_merchant_application',[root,a.id,1,'approved','',features(['points']),crypto.randomUUID()]]];
  for(const role of ['anon','authenticated']){
   for(const [name,args]of calls)await assert.rejects(h.call(name,args,role),/permission denied/);
   await h.db.exec('set role '+role);
   try{await assert.rejects(h.db.query('select * from platform_private.applications'),/permission denied/);}finally{await h.db.exec('reset role');}
  }
  const flags=(await h.db.query("select prosecdef,proconfig from pg_proc where proname in ('platform_my_merchant_applications','platform_get_merchant_application','platform_submit_merchant_application','platform_review_merchant_application')")).rows;
  assert.equal(flags.length,4);assert.ok(flags.every(p=>!p.prosecdef&&p.proconfig.includes('search_path=""')));
  assert.equal((await h.db.query("select relrowsecurity from pg_class where oid='platform_private.applications'::regclass")).rows[0].relrowsecurity,true);
 }finally{await h.db.close();}
});

test('AC-MMA-M012/013: upgrade preserves legacy applications/tenants and transaction rollback restores the old contract',async()=>{
 let a,t;
 const h=await setup({apply:false,before:async h=>{const created=await h.approve(owner,'legacy-a');t=(await h.db.query('select * from platform_private.tenants where id=$1',[created.id])).rows[0];a=(await h.db.query('select * from platform_private.applications')).rows[0];}});try{
  await h.db.exec('begin');await h.db.exec(merchant.replace(/^\s*begin;/i,'').replace(/commit;\s*$/i,''));await h.db.exec('rollback');
  assert.equal((await h.db.query('select * from platform_private.applications')).rows[0].qualification_id,undefined);
  assert.equal((await h.call('platform_my_application',[owner])).id,a.id);
  await h.db.exec(merchant);const current=(await h.db.query('select * from platform_private.applications')).rows[0];
  const {qualification_id,version,review_reason,...old}=current;assert.deepEqual(old,a);assert.ok(qualification_id);assert.equal(version,1);assert.equal(review_reason,null);
  assert.deepEqual((await h.db.query('select * from platform_private.tenants where id=$1',[t.id])).rows[0],t);
  assert.equal((await h.call('platform_my_application',[owner])).id,a.id);
  assert.equal((await h.db.query("select count(*)::int n from pg_constraint where conrelid='platform_private.applications'::regclass and conname='applications_applicant_line_user_id_key'")).rows[0].n,0);
 }finally{await h.db.close();}
});

test('AC-MMA-M019: upgrading pending and rejected single-merchant owners preserves read-only legacy status without qualifying writes',async()=>{
 const h=await setup({before:async h=>{
  for(const [actor,slug]of [[owner,'legacy-pending'],[other,'legacy-rejected']])await h.db.query('select public.platform_submit_application($1,$2,$3)',[actor,slug,slug]);
  await h.db.query("update platform_private.applications set status='rejected',reviewed_by=$1,reviewed_at=now() where applicant_line_user_id=$2",[root,other]);
 }});try{
  assert.equal((await h.call('platform_my_application',[owner])).status,'pending');
  assert.equal((await h.call('platform_my_application',[other])).status,'rejected');
  await assert.rejects(h.list(owner),/PLATFORM_QUALIFICATION_REQUIRED/);
  await assert.rejects(h.submit(other,'new-merchant','New Merchant'),/PLATFORM_QUALIFICATION_REQUIRED/);
  assert.equal(await h.count('applications'),2);assert.equal(await h.count('tenants'),0);
 }finally{await h.db.close();}
});
