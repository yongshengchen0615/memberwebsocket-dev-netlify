const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {fixture,root,manager}=require('./platform-fixture.cjs');
const migrations=path.resolve(__dirname,'../../supabase/migrations');
const names=['platform_my_admin_qualification','platform_submit_admin_qualification','platform_list_admin_qualifications','platform_review_admin_qualification'];
const stranger='U'+'3'.repeat(32),rejectedActor='U'+'4'.repeat(32);
const features={membership:true,points:false,events:false,calendar:false,integrations:false,booking:false,testing:false,usage:false};
async function setup(before){
 const h=await fixture();
 try{
  if(before)await before(h.db);
  for(const name of fs.readdirSync(migrations).filter(n=>n.endsWith('_admin_qualification_foundation.sql')))await h.db.exec(fs.readFileSync(path.join(migrations,name),'utf8'));
  h.call=async(name,args=[],role='service_role')=>{
   assert.ok(names.includes(name));assert.ok(['service_role','anon','authenticated'].includes(role));
   return h.db.transaction(async tx=>{
    await tx.exec('set local role '+role);
    const rows=(await tx.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows;
    return name==='platform_list_admin_qualifications'?rows.map(r=>r.result):rows[0]?.result;
   });
  };
  h.mine=(actor=manager)=>h.call(names[0],[actor]);
  h.submit=(actor=manager,name='測試管理員',id=crypto.randomUUID())=>h.call(names[1],[actor,name,id]);
  h.review=(q,status,reason='',id=crypto.randomUUID(),actor=root)=>h.call(names[3],[actor,q.id,q.version,status,reason,id]);
  return h;
 }catch(error){await h.db.close();throw error;}
}
async function count(db,table){return Number((await db.query('select count(*) n from platform_private.'+table)).rows[0].n);}

test('AC-MMA-Q001: reading an unapplied or existing legacy admin creates no qualification, merchant or root grant',async()=>{
 const h=await setup();try{
  assert.equal(await h.mine(),null);assert.equal(await h.mine(root),null);
  assert.equal(await count(h.db,'admin_qualifications'),0);
  assert.equal(await count(h.db,'applications'),0);assert.equal(await count(h.db,'tenants'),0);
  assert.equal(await count(h.db,'super_admins'),1);
  for(const actor of [null,'','Ubad'])await assert.rejects(h.mine(actor),/PLATFORM_INVALID_INPUT/);
 }finally{await h.db.close();}
});

test('AC-MMA-Q002: explicit submission is pending and repeated visits/retries neither approve nor duplicate it',async()=>{
 const h=await setup();try{
  const id=crypto.randomUUID(),q=await h.submit(manager,'  合成管理員  ',id);
  assert.equal(q.displayName,'合成管理員');assert.equal(q.status,'pending');assert.equal(q.version,1);
  assert.equal(q.reviewedAt,null);assert.equal(q.accessRevokedBefore,null);
  assert.deepEqual(await h.submit(manager,'合成管理員',id),q);
  const again=await h.submit();assert.equal(again.id,q.id);assert.equal(again.version,1);
  assert.equal(await count(h.db,'admin_qualifications'),1);
  assert.equal(await count(h.db,'applications'),0);assert.equal(await count(h.db,'tenants'),0);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='ADMIN_QUALIFICATION_SUBMITTED'")).rows[0].n,1);
  for(const [actor,name,request] of [[null,'ok',crypto.randomUUID()],['Ubad','ok',crypto.randomUUID()],[manager,' ',crypto.randomUUID()],[manager,'a'.repeat(101),crypto.randomUUID()],[manager,null,crypto.randomUUID()],[manager,'ok',null]])
   await assert.rejects(h.submit(actor,name,request),/PLATFORM_INVALID_INPUT/);
 }finally{await h.db.close();}
});

test('AC-MMA-Q003: only root may list/review; qualification approval creates no merchant, grants or legacy admin',async()=>{
 const h=await setup();try{
  const q=await h.submit(),admins=(await h.db.query('select * from public.admins order by id')).rows;
  await assert.rejects(h.call(names[2],[manager]),/PLATFORM_ADMIN_REQUIRED/);
  await assert.rejects(h.review(q,'approved','',crypto.randomUUID(),manager),/PLATFORM_ADMIN_REQUIRED/);
  assert.equal((await h.mine()).status,'pending');
  const list=await h.call(names[2],[root]);assert.equal(list.length,1);assert.equal(list[0].id,q.id);
  const approved=await h.review(q,'approved');assert.equal(approved.status,'approved');assert.equal(approved.version,2);
  assert.ok(approved.reviewedAt);assert.equal(await count(h.db,'tenants'),0);
  assert.equal(await count(h.db,'applications'),0);assert.equal(await count(h.db,'super_admins'),1);
  assert.deepEqual((await h.db.query('select * from public.admins order by id')).rows,admins);
  await assert.rejects(h.review(approved,'rejected','late rejection'),/PLATFORM_QUALIFICATION_TRANSITION/);
 }finally{await h.db.close();}
});

test('AC-MMA-Q004: rejection needs a reason; explicit resubmission returns to pending without a new identity',async()=>{
 const h=await setup();try{
  const q=await h.submit();
  await assert.rejects(h.review(q,'rejected',' '),/PLATFORM_INVALID_INPUT/);
  await assert.rejects(h.review(q,'rejected','a'.repeat(501)),/PLATFORM_INVALID_INPUT/);
  const r=await h.review(q,'rejected','資料不足');assert.equal(r.status,'rejected');assert.equal(r.reviewReason,'資料不足');
  await assert.rejects(h.review(r,'approved'),/PLATFORM_QUALIFICATION_TRANSITION/);
  const resubmitted=await h.submit(manager,'補件管理員');
  assert.equal(resubmitted.id,q.id);assert.equal(resubmitted.status,'pending');assert.equal(resubmitted.version,3);
  assert.equal(resubmitted.reviewReason,null);assert.equal(resubmitted.reviewedAt,null);
  assert.equal(await count(h.db,'admin_qualifications'),1);
 }finally{await h.db.close();}
});

test('AC-MMA-Q005: suspension cannot be self-cleared; replayed submissions/reviews return current status, never stale approval',async()=>{
 const h=await setup();try{
  const submitId=crypto.randomUUID(),approveId=crypto.randomUUID();
  const q=await h.submit(manager,'測試管理員',submitId),approved=await h.review(q,'approved','',approveId);
  const suspended=await h.review(approved,'suspended','暫停資格');
  assert.equal(suspended.status,'suspended');assert.ok(suspended.accessRevokedBefore);
  await assert.rejects(h.submit(),/PLATFORM_QUALIFICATION_SUSPENDED/);
  assert.equal((await h.submit(manager,'測試管理員',submitId)).status,'suspended');
  assert.equal((await h.review(q,'approved','',approveId)).status,'suspended');
  const resumed=await h.review(suspended,'approved');assert.equal(resumed.status,'approved');
  assert.equal(resumed.accessRevokedBefore,suspended.accessRevokedBefore);
  await h.db.exec('update platform_private.super_admins set enabled=false');
  await assert.rejects(h.review(q,'approved','',approveId),/PLATFORM_ADMIN_REQUIRED/);
 }finally{await h.db.close();}
});

test('AC-MMA-Q006: request reuse across actors, bodies or operations fails and stale review versions do not mutate state',async()=>{
 const h=await setup();try{
  const id=crypto.randomUUID(),q=await h.submit(manager,'測試管理員',id);
  await assert.rejects(h.submit(manager,'其他名字',id),/PLATFORM_REQUEST_CONFLICT/);
  await assert.rejects(h.submit(stranger,'測試管理員',id),/PLATFORM_REQUEST_CONFLICT/);
  await assert.rejects(h.review(q,'approved','',id),/PLATFORM_REQUEST_CONFLICT/);
  await h.review(q,'approved');const before=await count(h.db,'audit_events');
  await assert.rejects(h.review(q,'rejected','過期審核'),/PLATFORM_CONFLICT/);
  assert.equal((await h.mine()).status,'approved');assert.equal(await count(h.db,'audit_events'),before);
  await assert.rejects(h.review({...q,id:crypto.randomUUID()},'approved'),/PLATFORM_QUALIFICATION_NOT_FOUND/);
  await assert.rejects(h.review({...q,version:0},'approved'),/PLATFORM_INVALID_INPUT/);
  await assert.rejects(h.review(q,'active'),/PLATFORM_INVALID_INPUT/);
 }finally{await h.db.close();}
});

test('AC-MMA-Q007: legacy backfill preserves approved/pending/rejected and every original application/tenant row',async()=>{
 let before;
 const h=await setup(async db=>{
  for(const [actor,slug]of [[manager,'old-approved'],[stranger,'old-pending'],[rejectedActor,'old-rejected']])
   await db.query('select public.platform_submit_application($1,$2,$3)',[actor,slug,slug]);
  const app=(await db.query('select id from platform_private.applications where applicant_line_user_id=$1',[manager])).rows[0];
  await db.query('select public.platform_approve_application($1,$2,$3,$4)',[root,app.id,features,crypto.randomUUID()]);
  await db.query("update platform_private.applications set status='rejected',reviewed_by=$1,reviewed_at=now() where applicant_line_user_id=$2",[root,rejectedActor]);
  before=(await db.query("select (select jsonb_agg(to_jsonb(a) order by id) from platform_private.applications a) apps,(select jsonb_agg(to_jsonb(t) order by id) from platform_private.tenants t) tenants")).rows[0];
 });try{
  assert.equal((await h.mine(manager)).status,'approved');assert.equal((await h.mine(stranger)).status,'pending');
  assert.equal((await h.mine(rejectedActor)).status,'rejected');assert.equal(await h.mine(root),null);
  assert.equal(await count(h.db,'admin_qualifications'),3);
  const after=(await h.db.query("select (select jsonb_agg(to_jsonb(a) order by id) from platform_private.applications a) apps,(select jsonb_agg(to_jsonb(t) order by id) from platform_private.tenants t) tenants")).rows[0];
  assert.deepEqual(after,before);
 }finally{await h.db.close();}
});

test('AC-MMA-Q008: browser roles cannot read/write qualifications or execute RPCs; service functions remain invokers',async()=>{
 const h=await setup();try{
  const q=await h.submit();
  for(const role of ['anon','authenticated']){
   for(const [name,args]of [[names[0],[manager]],[names[1],[manager,'name',crypto.randomUUID()]],[names[2],[root]],[names[3],[root,q.id,1,'approved','',crypto.randomUUID()]]])
    await assert.rejects(h.call(name,args,role),/permission denied/);
   await assert.rejects(h.db.transaction(async tx=>{await tx.exec('set local role '+role);return tx.query('select * from platform_private.admin_qualifications');}),/permission denied/);
  }
  const flags=(await h.db.query("select p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[])",[names])).rows;
  assert.equal(flags.length,4);assert.ok(flags.every(p=>p.prosecdef===false));
  assert.equal((await h.db.query("select relrowsecurity from pg_class where oid='platform_private.admin_qualifications'::regclass")).rows[0].relrowsecurity,true);
 }finally{await h.db.close();}
});

test('AC-MMA-Q009: an audit failure rolls back qualification, version and idempotency record together',async()=>{
 const h=await setup();try{
  const q=await h.submit(),requestId=crypto.randomUUID();
  await h.db.exec("create function public.fail_qualification_audit() returns trigger language plpgsql as $$begin if new.action='ADMIN_QUALIFICATION_APPROVED' then raise exception 'SYNTHETIC_AUDIT_FAILURE';end if;return new;end$$; create trigger fail_qualification before insert on platform_private.audit_events for each row execute function public.fail_qualification_audit();");
  await assert.rejects(h.review(q,'approved','',requestId),/SYNTHETIC_AUDIT_FAILURE/);
  assert.deepEqual(await h.mine(),q);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.requests where request_id=$1',[requestId])).rows[0].n,0);
  await h.db.exec('drop trigger fail_qualification on platform_private.audit_events');
  assert.equal((await h.review(q,'approved','',requestId)).status,'approved');
 }finally{await h.db.close();}
});
