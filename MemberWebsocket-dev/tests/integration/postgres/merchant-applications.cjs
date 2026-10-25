const test=require('node:test'),assert=require('node:assert/strict');
const database=require('./database.cjs');
const {setup:merchantSetup,merchant,root,owner,other,features}=require('../fixtures/merchant-applications.cjs');
const fs=require('node:fs'),path=require('node:path');
const migrationDir=path.resolve(__dirname,'../../../supabase/migrations');
const contextMigration=fs.readFileSync(path.join(migrationDir,fs.readdirSync(migrationDir).find(n=>n.endsWith('_merchant_explicit_context.sql'))),'utf8');
const submit='select public.platform_submit_merchant_application($1,$2,$3,$4,null,null) result';
const review='select public.platform_review_merchant_application($1,$2,$3,$4,$5,$6,$7) result';
async function setup(options={}){
 const h=await merchantSetup({...options,database:await database()});
 try{
  h.first=await h.db.connect();h.second=await h.db.connect();
  await h.first.query('set role service_role');await h.second.query('set role service_role');
  const pid=(await h.second.query('select pg_backend_pid() pid')).rows[0].pid;
  assert.notEqual((await h.first.query('select pg_backend_pid() pid')).rows[0].pid,pid);
  h.blocked=async()=>{
   for(let i=0;i<100;i++){
    if((await h.db.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event_type==='Lock')return;
    await new Promise(r=>setTimeout(r,20));
   }
   throw Error('EXPECTED_MERCHANT_SECOND_PHYSICAL_SESSION_LOCK_WAIT');
  };
  return h;
 }catch(e){await h.db.close();throw e;}
}
async function runtimeGuard(h){
 await h.db.exec(contextMigration);
 for(const suffix of ['_merchant_runtime_transaction_guard.sql','_merchant_runtime_public_hook_guard.sql']){
  const files=fs.readdirSync(migrationDir).filter(n=>n.endsWith(suffix));
  assert.ok(files.length<=1,'only one '+suffix+' migration may be installed');
  if(files.length)await h.db.exec(fs.readFileSync(path.join(migrationDir,files[0]),'utf8'));
 }
}
const adminHeaders=(a,timestamp=new Date(Date.now()+1000).toISOString())=>({'x-platform-admin-actor':owner,
 'x-platform-admin-tenant':a.tenant.id,'x-platform-admin-issued-at':timestamp,'content-profile':a.tenant.runtime_schema});
async function guardSession(client,headers){
 await client.query("select set_config('request.headers',$1,true)",[JSON.stringify(headers)]);
 await client.query('select public.platform_business_pre_request()');
}
async function policyMutation(h,a,kind,text){
 if(kind==='direct UPDATE')return client=>client.query(`update ${a.tenant.runtime_schema}.booking_no_show_policy set contact_text=$1`,[text]);
 const policy=(await h.db.query(`select to_jsonb(p) policy from ${a.tenant.runtime_schema}.booking_no_show_policy p`)).rows[0].policy;
 return client=>client.query(`select ${a.tenant.runtime_schema}.admin_booking_no_show($1,$2,$3)`,[owner,'save',{...policy,contact_text:text}]);
}

for(const role of ['anon','authenticated'])for(const marked of [false,true]){
 test('PostgreSQL 17 C015 '+role+' '+(marked?'forged marker':'unmarked')+': the first hook invocation on a fresh TCP backend needs no private schema access',async()=>{
  const h=await setup();try{
   await runtimeGuard(h);
   // PostgreSQL compiles PL/pgSQL independently in each backend. Neither the
   // setup's service connections nor a prior unmarked call may warm this one.
   const fresh=await h.db.connect();
   await fresh.query('begin read only');await fresh.query('set local role '+role);
   assert.equal((await fresh.query('select current_user role')).rows[0].role,role);
   const headers=marked?{'x-platform-admin-actor':owner,'x-platform-admin-tenant':'10000000-0000-4000-8000-000000000001',
    'x-platform-admin-issued-at':new Date().toISOString(),'accept-profile':'business_'+'a'.repeat(32)}:{};
   if(marked){
    await assert.rejects(guardSession(fresh,headers),error=>error.code==='PT403'&&error.message.includes('PLATFORM_RUNTIME_CONTEXT_INVALID'));
    await fresh.query('rollback');
   }else{
    await guardSession(fresh,headers);
    assert.equal((await fresh.query('select 1 allowed')).rows[0].allowed,1);await fresh.query('commit');
   }
  }finally{await h.db.close();}
 });
}

// These sessions explicitly model PostgREST's transaction + pre-request hook.
// They exercise real tenant statements/RPCs, not an HTTP/PostgREST transport.
for(const kind of ['direct UPDATE','tenant RPC']){
 test('PostgreSQL 17 C012 '+kind+': an authorized runtime mutation commits before qualification suspension can commit',async()=>{
  const h=await setup();try{
   await runtimeGuard(h);const q=await h.qualify(),a=await h.review(await h.submit(),'approved',features(['booking']));
   const mutate=await policyMutation(h,a,kind,'AUTHORIZED BEFORE SUSPENSION');
   await h.first.query('begin');await guardSession(h.first,adminHeaders(a));await mutate(h.first);
   const revoking=h.second.query('select public.platform_review_admin_qualification($1,$2,$3,$4,$5,$6)',[root,q.id,q.version,'suspended','Stop',crypto.randomUUID()]);revoking.catch(()=>{});
   await h.blocked();
   assert.equal((await h.db.query('select status from platform_private.admin_qualifications where id=$1',[q.id])).rows[0].status,'approved');
   await h.first.query('commit');await revoking;
   assert.equal((await h.db.query(`select contact_text from ${a.tenant.runtime_schema}.booking_no_show_policy`)).rows[0].contact_text,'AUTHORIZED BEFORE SUSPENSION');
   await h.first.query('begin');await assert.rejects(guardSession(h.first,adminHeaders(a)),/PLATFORM_QUALIFICATION_REQUIRED/);await h.first.query('rollback');
  }finally{await h.db.close();}
 });

 test('PostgreSQL 17 C013 '+kind+': a runtime mutation waiting behind committed suspension is denied without changing tenant rows',async()=>{
  const h=await setup();try{
   await runtimeGuard(h);const q=await h.qualify(),a=await h.review(await h.submit(),'approved',features(['booking']));
   const before=(await h.db.query(`select to_jsonb(p) policy from ${a.tenant.runtime_schema}.booking_no_show_policy p`)).rows[0].policy;
   const mutate=await policyMutation(h,a,kind,'MUST NOT COMMIT');
   await h.first.query('begin');await h.first.query('select public.platform_review_admin_qualification($1,$2,$3,$4,$5,$6)',[root,q.id,q.version,'suspended','Stop',crypto.randomUUID()]);
   await h.second.query('begin');
   const writing=(async()=>{await guardSession(h.second,adminHeaders(a));await mutate(h.second);await h.second.query('commit');})();writing.catch(()=>{});
   await h.blocked();await h.first.query('commit');await assert.rejects(writing,/PLATFORM_QUALIFICATION_REQUIRED/);await h.second.query('rollback');
   assert.deepEqual((await h.db.query(`select to_jsonb(p) policy from ${a.tenant.runtime_schema}.booking_no_show_policy p`)).rows[0].policy,before);
  }finally{await h.db.close();}
 });
}

test('PostgreSQL 17 C014: readonly admin transaction and unmarked browser requests work while forged browser markers are denied',async()=>{
 const h=await setup();try{
  await runtimeGuard(h);await h.qualify();const a=await h.review(await h.submit(),'approved',features(['booking'])),headers=adminHeaders(a);
  delete headers['content-profile'];headers['accept-profile']=a.tenant.runtime_schema;
  await h.first.query('begin read only');await guardSession(h.first,headers);
  assert.equal((await h.first.query(`select count(*)::int n from ${a.tenant.runtime_schema}.booking_no_show_policy`)).rows[0].n,1);await h.first.query('commit');
  for(const role of ['anon','authenticated']){
   await h.first.query('begin');await h.first.query('set local role '+role);await guardSession(h.first,{});
   assert.equal((await h.first.query('select 1 allowed')).rows[0].allowed,1);await h.first.query('commit');
   await h.first.query('begin');await h.first.query('set local role '+role);
   await assert.rejects(guardSession(h.first,headers),/PLATFORM_|BUSINESS_|permission denied/);await h.first.query('rollback');
  }
 }finally{await h.db.close();}
});

test('PostgreSQL 17 C006: authorized scoped write finishes before qualification suspension commits, later replay is refused',async()=>{
 const h=await setup();try{
  await h.db.exec(contextMigration);const q=await h.qualify(),a=await h.review(await h.submit()),id=crypto.randomUUID();
  const write='select public.platform_save_notification_route_for_merchant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result';
  const args=[owner,a.tenant.id,new Date(Date.now()+1000).toISOString(),'points','member','disabled',a.tenant.version,id,'a'.repeat(64),null,null];
  await h.first.query('begin');const saved=(await h.first.query(write,args)).rows[0].result;
  const revoking=h.second.query('select public.platform_review_admin_qualification($1,$2,$3,$4,$5,$6)',[root,q.id,q.version,'suspended','Stop',crypto.randomUUID()]);revoking.catch(()=>{});
  await h.blocked();await h.first.query('commit');await revoking;
  assert.equal(saved.module_line.points.notifications.member.mode,'disabled');
  await assert.rejects(h.first.query(write,args),/PLATFORM_QUALIFICATION_REQUIRED/);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='NOTIFICATION_ROUTE_UPDATED'")).rows[0].n,1);
  const backup=await h.db.backupRestore();
  assert.equal((await backup.client.query('select status from platform_private.admin_qualifications where id=$1',[q.id])).rows[0].status,'suspended');
  await backup.client.query('set role authenticated');await assert.rejects(backup.client.query('select public.platform_my_merchant_context($1,$2,$3)',[owner,a.slug,args[2]]),/permission denied/);
 }finally{await h.db.close();}
});

test('PostgreSQL 17 C007: same request racing across same-owner merchants cannot write the second tenant',async()=>{
 const h=await setup();try{
  await h.db.exec(contextMigration);await h.qualify();const a=await h.review(await h.submit()),b=await h.review(await h.submit(owner,'merchant-c','C')),id=crypto.randomUUID();
  const write='select public.platform_save_notification_route_for_merchant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result';
  const args=[owner,a.tenant.id,new Date(Date.now()+1000).toISOString(),'points','member','disabled',a.tenant.version,id,'b'.repeat(64),null,null];
  await h.first.query('begin');await h.first.query(write,args);
  const second=h.second.query(write,[...args.slice(0,1),b.tenant.id,...args.slice(2)]);second.catch(()=>{});
  await h.blocked();await h.first.query('commit');await assert.rejects(second,/PLATFORM_REQUEST_CONFLICT/);
  assert.equal((await h.get(b.id)).tenant.version,b.tenant.version);assert.deepEqual((await h.get(b.id)).tenant.module_line,{});
  assert.equal((await h.db.query("select count(*)::int n from platform_private.requests where request_id=$1",[id])).rows[0].n,1);
 }finally{await h.db.close();}
});

test('PostgreSQL 17 M024: upgrade waits for legacy transaction and catches its late submission and review',async()=>{
 const h=await setup({apply:false,before:async h=>{
  await h.db.query('select public.platform_submit_application($1,$2,$3)',[owner,'Legacy A','legacy-a']);
 }});try{
  const a=await h.call('platform_my_application',[owner]);
  await h.first.query('begin');
  await h.first.query('select public.platform_submit_application($1,$2,$3)',[other,'Late B','late-b']);
  await h.first.query('select public.platform_approve_application($1,$2,$3,$4)',[root,a.id,features(['points']),crypto.randomUUID()]);
  await h.second.query('reset role');
  const migrating=h.second.query(merchant);migrating.catch(()=>{});
  await h.blocked();await h.first.query('commit');await migrating;
  const rows=(await h.db.query(`select a.slug,a.status,q.status qualification_status,a.qualification_id,q.origin
   from platform_private.applications a join platform_private.admin_qualifications q on q.id=a.qualification_id order by a.slug`)).rows;
  assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>[r.slug,r.status,r.qualification_status]),[['late-b','pending','pending'],['legacy-a','approved','approved']]);
  assert.ok(rows.every(r=>r.qualification_id&&r.origin==='legacy_application'));
  assert.equal((await h.list(owner)).length,1);await assert.rejects(h.list(other),/PLATFORM_QUALIFICATION_REQUIRED/);
  assert.equal(await h.count('tenants'),1);
 }finally{await h.db.close();}
});

test('PostgreSQL 17 M014: same request racing on distinct TCP sessions commits one pending application and audit',async()=>{
 const h=await setup();try{
  await h.qualify();const args=[owner,'Merchant B','merchant-b',crypto.randomUUID()];
  await h.first.query('begin');const first=(await h.first.query(submit,args)).rows[0].result;
  const pending=h.second.query(submit,args);pending.catch(()=>{});
  await h.blocked();await h.first.query('commit');assert.deepEqual((await pending).rows[0].result,first);
  assert.equal(await h.count('applications'),1);assert.equal(await h.count('tenants'),0);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='MERCHANT_APPLICATION_SUBMITTED'")).rows[0].n,1);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.requests where operation='merchant_submit'")).rows[0].n,1);
 }finally{await h.db.close();}
});

test('PostgreSQL 17 M015: two qualified owners racing for one slug commit exactly one application, request and audit',async()=>{
 const h=await setup();try{
  await h.qualify();await h.qualify(other);
  await h.first.query('begin');await h.first.query(submit,[owner,'Owner One','same-slug',crypto.randomUUID()]);
  const pending=h.second.query(submit,[other,'Owner Two','same-slug',crypto.randomUUID()]);pending.catch(()=>{});
  await h.blocked();await h.first.query('commit');await assert.rejects(pending,/PLATFORM_DUPLICATE_SLUG/);
  assert.equal(await h.count('applications'),1);assert.equal((await h.db.query('select applicant_line_user_id from platform_private.applications')).rows[0].applicant_line_user_id,owner);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.requests where operation='merchant_submit'")).rows[0].n,1);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='MERCHANT_APPLICATION_SUBMITTED'")).rows[0].n,1);
 }finally{await h.db.close();}
});

test('PostgreSQL 17 M016: opposing reviews of one version create one private tenant and one decision',async()=>{
 const h=await setup();try{
  await h.qualify();const a=await h.submit();
  await h.first.query('begin');await h.first.query(review,[root,a.id,a.version,'approved','',features(['points']),crypto.randomUUID()]);
  const pending=h.second.query(review,[root,a.id,a.version,'rejected','Incomplete',null,crypto.randomUUID()]);pending.catch(()=>{});
  await h.blocked();await h.first.query('commit');await assert.rejects(pending,/PLATFORM_CONFLICT/);
  const current=await h.get(a.id);assert.equal(current.status,'approved');assert.equal(current.version,2);assert.equal(current.tenant.status,'active');
  assert.equal(await h.count('tenants'),1);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.requests where operation='merchant_review'")).rows[0].n,1);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='MERCHANT_APPLICATION_APPROVED'")).rows[0].n,1);
 }finally{await h.db.close();}
});

test('PostgreSQL 17 M017: submission waiting behind a committed qualification suspension cannot create an application',async()=>{
 const h=await setup();try{
  const q=await h.qualify();await h.first.query('begin');
  await h.first.query('select public.platform_review_admin_qualification($1,$2,$3,$4,$5,$6)',[root,q.id,q.version,'suspended','Stop',crypto.randomUUID()]);
  const pending=h.second.query(submit,[owner,'Merchant B','merchant-b',crypto.randomUUID()]);pending.catch(()=>{});
  await h.blocked();await h.first.query('commit');await assert.rejects(pending,/PLATFORM_QUALIFICATION_REQUIRED/);
  assert.equal(await h.count('applications'),0);assert.equal(await h.count('tenants'),0);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.requests where operation='merchant_submit'")).rows[0].n,0);
 }finally{await h.db.close();}
});

test('PostgreSQL 17 M017 reverse: committed submission precedes suspension, and its old request cannot regain authority',async()=>{
 const h=await setup();try{
  const q=await h.qualify(),request=crypto.randomUUID();await h.first.query('begin');
  await h.first.query(submit,[owner,'Merchant B','merchant-b',request]);
  const pending=h.second.query('select public.platform_review_admin_qualification($1,$2,$3,$4,$5,$6)',[root,q.id,q.version,'suspended','Stop',crypto.randomUUID()]);pending.catch(()=>{});
  await h.blocked();await h.first.query('commit');await pending;
  await assert.rejects(h.submit(owner,'merchant-b','Merchant B',request),/PLATFORM_QUALIFICATION_REQUIRED/);
  assert.equal(await h.count('applications'),1);assert.equal(await h.count('tenants'),0);
  assert.equal((await h.db.query('select status from platform_private.applications')).rows[0].status,'pending');
 }finally{await h.db.close();}
});

test('PostgreSQL 17 M017 root: an administrator revoked while waiting on the qualification lock cannot finish a review',async()=>{
 const h=await setup();try{
  await h.qualify();const a=await h.submit();await h.first.query('begin');
  await h.first.query('select id from platform_private.admin_qualifications where applicant_line_user_id=$1 for update',[owner]);
  const pending=h.second.query(review,[root,a.id,a.version,'approved','',features(['points']),crypto.randomUUID()]);pending.catch(()=>{});
  await h.blocked();await h.db.exec('update platform_private.super_admins set enabled=false');await h.first.query('commit');
  await assert.rejects(pending,/PLATFORM_ADMIN_REQUIRED/);
  assert.equal(await h.count('tenants'),0);assert.equal((await h.get(a.id)).status,'pending');
 }finally{await h.db.close();}
});

test('PostgreSQL 17 M018: dump/restore preserves two private merchants, qualification ownership, versions and service-only RPCs',async()=>{
 const h=await setup();try{
  await h.qualify();const a=await h.review(await h.submit(owner,'merchant-a','Merchant A'),'approved',features(['membership']));
  const b=await h.review(await h.submit(owner,'merchant-b','Merchant B'),'approved',features(['points']));
  await h.db.query(`update ${a.tenant.runtime_schema}.booking_no_show_policy set contact_text='RESTORE A ONLY'`);
  const before=(await h.db.query('select id,qualification_id,applicant_line_user_id,status,version,tenant_id from platform_private.applications order by id')).rows;
  const {client,checksum}=await h.db.backupRestore();assert.match(checksum,/^[a-f0-9]{64}$/);
  assert.deepEqual((await client.query('select id,qualification_id,applicant_line_user_id,status,version,tenant_id from platform_private.applications order by id')).rows,before);
  assert.equal((await client.query(`select contact_text from ${a.tenant.runtime_schema}.booking_no_show_policy`)).rows[0].contact_text,'RESTORE A ONLY');
  assert.notEqual((await client.query(`select contact_text from ${b.tenant.runtime_schema}.booking_no_show_policy`)).rows[0].contact_text,'RESTORE A ONLY');
  for(const role of ['anon','authenticated']){
   await client.query('set role '+role);
   await assert.rejects(client.query('select public.platform_my_merchant_applications($1)',[owner]),/permission denied/);
   await assert.rejects(client.query(`select * from ${a.tenant.runtime_schema}.members`),/permission denied/);
   await client.query('reset role');
  }
  await client.query('set role service_role');const rows=(await client.query('select public.platform_my_merchant_applications($1) result',[owner])).rows;assert.equal(rows.length,2);
  assert.deepEqual(rows.map(r=>r.result.slug).sort(),['merchant-a','merchant-b']);
  await assert.rejects(client.query('select public.platform_my_application($1)',[owner]),/PLATFORM_BUSINESS_SELECTION_REQUIRED/);
 }finally{await h.db.close();}
});

async function waitForClientLock(h,client){
 const pid=(await client.query('select pg_backend_pid() pid')).rows[0].pid;
 return async()=>{
  for(let i=0;i<100;i++){
   if((await h.db.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event_type==='Lock')return;
   await new Promise(r=>setTimeout(r,20));
  }
  throw Error('EXPECTED_AUTHORIZATION_OR_CATALOG_LOCK_WAIT');
 };
}
async function blockRoleSettings(h){
 await h.db.exec("alter role authenticator set pgrst.db_schemas='public,graphql_public'");
 const blocker=await h.db.connect();await blocker.query('begin');
 assert.equal((await blocker.query("select setrole from pg_db_role_setting where setdatabase=0 and setrole=(select oid from pg_roles where rolname='authenticator') for update")).rowCount,1);
 return blocker;
}

test('PostgreSQL 17 M020: distinct parallel approvals preserve both business schemas in shared PostgREST configuration',async()=>{
 const h=await setup();try{
  await h.qualify();const a=await h.submit(owner,'merchant-a','Merchant A'),b=await h.submit();
  const firstBlocked=await waitForClientLock(h,h.first),blocker=await blockRoleSettings(h);
  const one=h.first.query(review,[root,a.id,a.version,'approved','',features(['membership']),crypto.randomUUID()]);one.catch(()=>{});
  const two=h.second.query(review,[root,b.id,b.version,'approved','',features(['points']),crypto.randomUUID()]);two.catch(()=>{});
  await firstBlocked();await h.blocked();await blocker.query('commit');
  const outcomes=await Promise.allSettled([one,two]);assert.ok(outcomes.every(r=>r.status==='fulfilled'),outcomes.map(r=>r.reason?.message).join('; '));
  const applications=outcomes.map(r=>r.value.rows[0].result);
  const settings=(await h.db.query("select unnest(rolconfig) setting from pg_roles where rolname='authenticator'")).rows.map(r=>r.setting).find(v=>v.startsWith('pgrst.db_schemas='));
  for(const a of applications){assert.equal(a.tenant.status,'active');assert.ok(settings.split('=')[1].split(',').includes(a.tenant.runtime_schema));}
  assert.equal(await h.count('tenants'),2);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='MERCHANT_APPLICATION_APPROVED'")).rows[0].n,2);
 }finally{await h.db.close();}
});

test('PostgreSQL 17 M021: an already-authorized in-flight review completes before revocation commits, then old requests are denied',async()=>{
 const h=await setup();try{
  await h.qualify();const a=await h.submit(),request=crypto.randomUUID(),blocker=await blockRoleSettings(h);
  const args=[root,a.id,a.version,'approved','',features(['points']),request];
  const approving=h.second.query(review,args);approving.catch(()=>{});await h.blocked();
  const revoker=await h.db.connect(),revocationBlocked=await waitForClientLock(h,revoker);
  const revoking=revoker.query('update platform_private.super_admins set enabled=false');revoking.catch(()=>{});
  await revocationBlocked();await blocker.query('commit');
  assert.equal((await approving).rows[0].result.status,'approved');await revoking;
  await assert.rejects(h.review(a,'approved',features(['points']),'',request),/PLATFORM_ADMIN_REQUIRED/);
  assert.equal((await h.db.query('select enabled from platform_private.super_admins where line_user_id=$1',[root])).rows[0].enabled,false);
 }finally{await h.db.close();}
});
