const test=require('node:test'),assert=require('node:assert/strict');
const fixture=require('./business-runtime-fixture.cjs');
test('AC-201: approval atomically provisions empty private business data and current grants, without LINE configuration',async()=>{
 const h=await fixture();try{
  const t=await h.approve('U'+'2'.repeat(32),'merchant-a');
  assert.equal(t.status,'active');assert.match(t.runtime_schema,/^business_[a-f0-9]{32}$/);
  assert.equal(t.credentials_configured,false);assert.deepEqual(t.line_config,{});
  assert.equal((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.members`)).rows[0].n,0);
  assert.equal((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.admins where line_user_id=$1 and role='admin' and status='active'`,[t.owner_line_user_id])).rows[0].n,1);
  assert.equal((await h.db.query('select count(*)::int n from public.admins')).rows[0].n,1);
  assert.equal((await h.db.query('select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relkind=\'r\' and c.relrowsecurity',[t.runtime_schema])).rows[0].n,69);
 }finally{await h.db.close();}
});
test('AC-206: two businesses accept the same LINE user and public IDs with independent data, FKs and sessions',async()=>{
 const h=await fixture();try{
  const a=await h.approve('U'+'2'.repeat(32),'merchant-a'),b=await h.approve('U'+'3'.repeat(32),'merchant-b');
  const uid='U'+'4'.repeat(32), rows=[];
  for(const t of [a,b]){
   const s=t.runtime_schema;
   const m=(await h.db.query(`insert into ${s}.members(line_user_id,member_code,display_name)values($1,'SAME-MEMBER',$2) returning id`,[uid,t.slug])).rows[0];
   const card=(await h.db.query(`insert into ${s}.point_cards(card_id,title,created_by,updated_by)values('SAME-CARD',$1,$2,$2) returning id`,[t.slug,t.owner_line_user_id])).rows[0];
   await h.db.query(`select ${s}.member_login_claim($1,$2,$3,$4,'login')`,[uid,'a'.repeat(64),t===a?'b'.repeat(64):'c'.repeat(64),Date.now()]);
   rows.push({m,card});
  }
  assert.notEqual(rows[0].m.id,rows[1].m.id);
  await assert.rejects(h.db.query(`insert into ${a.runtime_schema}.point_balances(member_id,point_card_id,stamps)values($1,$2,10)`,[rows[0].m.id,rows[1].card.id]),/foreign key/);
  assert.equal((await h.db.query(`select display_name from ${b.runtime_schema}.members`)).rows[0].display_name,'merchant-b');
  assert.equal((await h.db.query(`select count(*)::int n from ${a.runtime_schema}.member_login_token_grants where token_hash=$1`,['c'.repeat(64)])).rows[0].n,0);
  assert.equal((await h.db.query('select count(*)::int n from public.members')).rows[0].n,0);
  await assert.rejects(h.db.query(`select ${a.runtime_schema}.copy_admin_settings($1,'card',$2,'stolen','COPY-cross-business-123')`,[a.owner_line_user_id,rows[1].card.id]),/COPY_SOURCE_NOT_FOUND/);
 }finally{await h.db.close();}
});
test('AC-207: direct anon/authenticated access, foreign admins and unscoped function references are denied',async()=>{
 const h=await fixture();try{
  const t=await h.approve('U'+'2'.repeat(32),'merchant-a'),s=t.runtime_schema;
  for(const role of ['anon','authenticated']){
   await h.db.exec('set role '+role);
   await assert.rejects(h.db.query(`select * from ${s}.members`),/permission denied/);
   await assert.rejects(h.db.query(`select ${s}.issue_fixed_tickets()`),/permission denied/);
   await assert.rejects(h.db.query('select public.platform_business_context($1,null)',[t.owner_line_user_id]),/permission denied/);
   await h.db.exec('reset role');
  }
  await assert.rejects(h.db.query(`select ${s}.copy_admin_settings($1,'point_card','missing','copy','COPY-foreign-admin-123')`,[h.root]),/ADMIN_REQUIRED/);
  const functions=(await h.db.query(`select pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1`,[s])).rows;
  assert.equal(functions.length,257);
  for(const f of functions)assert.doesNotMatch(f.definition,/\b(?:public|booking_notifications|platform_private|line_config|vault|cron)\./);
 }finally{await h.db.close();}
});
test('AC-208: storage discovery only sees the current business UUID prefix',async()=>{
 const h=await fixture();try{
  const a=await h.approve('U'+'2'.repeat(32),'merchant-a'),b=await h.approve('U'+'3'.repeat(32),'merchant-b');
  await h.db.query("insert into storage.objects(bucket_id,name)values('booking-receipts',$1),('booking-receipts',$2),('booking-receipts','legacy/member/a.png')",[a.id+'/member/a.png',b.id+'/member/b.png']);
  assert.deepEqual((await h.db.query(`select name from ${a.runtime_schema}.runtime_storage_objects`)).rows,[{name:'member/a.png'}]);
  assert.deepEqual((await h.db.query(`select name from ${b.runtime_schema}.runtime_storage_objects`)).rows,[{name:'member/b.png'}]);
  assert.equal((await h.db.query('select public.platform_tick_businesses() processed')).rows[0].processed,2);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='BUSINESS_JOB_FAILED'")).rows[0].n,0);
 }finally{await h.db.close();}
});
test('AC-209: provisioning failure rolls back approval and all partially created business objects',async()=>{
 const h=await fixture();try{
  await h.db.exec(`update platform_private.business_templates set snapshot=jsonb_set(snapshot,'{functions,0,definition}',to_jsonb('create function public.bad() returns text language sql as $bad$ select value from vault.secret $bad$'::text))`);
  await assert.rejects(h.approve('U'+'2'.repeat(32),'merchant-bad'),/UNSCOPED_BUSINESS_FUNCTION/);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.tenants')).rows[0].n,0);
  assert.equal((await h.db.query("select count(*)::int n from pg_namespace where nspname like 'business_%'")).rows[0].n,0);
  assert.equal((await h.db.query('select status from platform_private.applications')).rows[0].status,'pending');
 }finally{await h.db.close();}
});
test('AC-211: existing membership consent, event claim and booking RPCs write only the approved business',async()=>{
 const h=await fixture();try{
  const a=await h.approve('U'+'2'.repeat(32),'merchant-a'),b=await h.approve('U'+'3'.repeat(32),'merchant-b'),s=a.runtime_schema,uid='U'+'4'.repeat(32);
  const mid=(await h.db.query(`insert into ${s}.members(line_user_id,member_code)values($1,'MEMBER-1')returning id`,[uid])).rows[0].id;
  const terms=(await h.db.query(`insert into ${s}.membership_terms(version,title,body,status,activated_at,created_by,updated_by)values('v1','Fixture consent','Isolated test only','active',now(),$1,$1)returning id`,[a.owner_line_user_id])).rows[0].id;
  assert.equal((await h.db.query(`select ${s}.accept_membership_terms($1,$2,'v1',true,'1990-01-01','+886912345678','測試','mr') joined`,[uid,terms])).rows[0].joined,true);
  await h.db.query(`insert into ${s}.event_tickets(event_ticket_id,title,ticket_type,status,created_by,updated_by)values('EVENT-1','A event','coupon','active',$1,$1)`,[a.owner_line_user_id]);
  await h.db.query(`select ${s}.claim_event_ticket($1,'EVENT-1')`,[uid]);
  const tech=(await h.db.query(`insert into ${s}.booking_technicians(name)values('A technician')returning id`)).rows[0].id;
  await h.db.query(`update ${s}.booking_settings set primary_technician_id=$1`,[tech]);
  await h.db.query(`insert into ${s}.booking_service_types(name)values('A type')`);
  const service=(await h.db.query(`insert into ${s}.booking_services(title,created_by,service_type)values('A service',$1,'A type')returning id`,[a.owner_line_user_id])).rows[0].id;
  await h.db.query(`select ${s}.create_booking_bundle_with_benefits_request('BOOK-fixture', $1,'2099-01-05','10:00', $2,'','[]')`,[mid,[{serviceId:'00000000-0000-4000-8000-000000000010',quantity:1},{serviceId:service,quantity:1}]]);
  assert.equal((await h.db.query(`select count(*)::int n from ${s}.bookings`)).rows[0].n,1);
  assert.equal((await h.db.query(`select count(*)::int n from ${b.runtime_schema}.bookings`)).rows[0].n,0);
  assert.equal((await h.db.query(`select count(*)::int n from ${b.runtime_schema}.event_ticket_claims`)).rows[0].n,0);
  assert.equal((await h.db.query('select count(*)::int n from public.bookings')).rows[0].n,0);
 }finally{await h.db.close();}
});
