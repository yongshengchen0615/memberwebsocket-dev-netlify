const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const load=require('./fixtures/load-postgres-snapshot.cjs');
test('member removal blocks writes, retries cross-service failures, removes private data and preserves other member assets',async t=>{
 const db=await load();try{
  const exec=name=>db.exec(fs.readFileSync(path.resolve(__dirname,'../../supabase/migrations',name),'utf8'));
  for(const name of ['20261006023020_booking_ticket_usage_consistency.sql','20261006081433_booking_primary_requirement_fixed_notification_time.sql','20261006133127_member_p2_features.sql','20261008034343_admin_service_item_grants.sql','20261008075553_single_active_member_login.sql','20261008083358_test_account_duplicate_login_setting.sql','20261008091007_test_login_takeover_single_session.sql','20261005151234_e2e_membership_terms_scope.sql','20261005152023_e2e_membership_terms_target_member.sql'])await exec(name);
  await db.exec('create schema storage;create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);');
  await exec('20261008152922_member_removal_workflow.sql');
  // Simulate the versioned source of all future provisioned business schemas.
  await db.exec(`create schema if not exists platform_private;
    create table platform_private.business_templates(version text primary key,snapshot jsonb not null);
    insert into platform_private.business_templates(version,snapshot)
    select 'business-v1-20261019',jsonb_build_object('functions',jsonb_build_array(
      jsonb_build_object('name','begin_member_removal','definition',pg_get_functiondef('public.begin_member_removal(text,text,text)'::regprocedure)),
      jsonb_build_object('name','finish_member_removal','definition',pg_get_functiondef('public.finish_member_removal(text,uuid)'::regprocedure))
    ));`);
  await exec('20261108020933_admin_self_member_card_removal.sql');
  const provisioned=(await db.query("select snapshot->'functions' as functions from platform_private.business_templates where version='business-v1-20261019'")).rows[0].functions;
  assert.match(provisioned[0].definition,/if p_actor<>p_target and exists\(select 1 from admins/);
  assert.match(provisioned[1].definition,/if not exists\(select 1 from admins where line_user_id=m.line_user_id\) then/);
  await db.exec("select maintenance.ensure_required_system_baseline();insert into admins(line_user_id,role,status)values('qa-removal-admin','admin','active');");
  const one=async(q,v=[])=>(await db.query(q,v)).rows[0];
  const make=async code=>(await one("insert into members(line_user_id,member_code,invite_code,status,membership_status,display_name,is_test_account)values($1,$2,$3,'active','active','Private member',true)returning id",['qa-removal-'+code,code,code+'000000'])).id;
  const a=await make('AAAA'),b=await make('BBBB');
  const card=(await one("insert into point_cards(card_id,title,status,created_by,updated_by)values('QA-REMOVE-CARD','QA card','active','qa-removal-admin','qa-removal-admin')returning id")).id;
  await db.query('insert into point_balances(member_id,point_card_id,stamps)values($1,$3,10),($2,$3,2)',[a,b,card]);
  await one("select transfer_member_points('qa-removal-AAAA','BBBB','QA-REMOVE-CARD',3,'QA-TRANSFER-REMOVE')");
  await db.query("select member_friend_action('qa-removal-AAAA','request','BBBB')");await db.query("select member_friend_action('qa-removal-BBBB','accept','AAAA')");
  await db.exec("insert into booking_service_types(name)values('QA removal');");
  const svc=(await one("insert into booking_services(title,duration_minutes,price_amount,service_type,created_by)values('QA service',60,100,'QA removal','qa-removal-admin')returning id")).id;
  // Member-owned text attribution in an actual base table must still be scrubbed.
  await db.query("update booking_services set created_by='qa-removal-AAAA' where id=$1",[svc]);
  const tech=(await one('select primary_technician_id id from booking_settings where id=1')).id;
  const parts=JSON.stringify([{technicianId:tech,items:[{serviceId:svc,quantity:1}]}]);
  const shared=(await one("select (create_friend_booking_request('qa-removal-AAAA','BBBB','QA-SHARED-REMOVE',current_date+3,'10:00',$1,'QA','custom','PRIVATE','mr','0912345678','[]')).id id",[parts])).id;
  const removedRecipient=(await one("select (create_friend_booking_request('qa-removal-BBBB','AAAA','QA-RECIPIENT-REMOVE',current_date+4,'10:00',$1,'QA','custom','PRIVATE','mr','0912345678','[]')).id id",[parts])).id;
  // These tables were added after the original removal guards. NO ACTION FKs
  // must not strand a disabled member or erase a surviving member's history.
  await db.exec(`create table public.booking_no_show_events (
    booking_id uuid primary key references public.bookings(id),
    member_id uuid not null references public.members(id),
    occurred_at timestamptz not null,marked_by text not null
  );
  create table public.booking_restrictions (
    id uuid primary key default gen_random_uuid(),
    member_id uuid not null references public.members(id),
    source_booking_id uuid not null unique references public.booking_no_show_events(booking_id)
  );
  create table public.booking_restriction_appeals (
    restriction_id uuid primary key references public.booking_restrictions(id),
    member_id uuid not null references public.members(id),
    reason text not null
  );`);
  await db.query("insert into booking_no_show_events(booking_id,member_id,occurred_at,marked_by)values($1,$2,now(),'qa-removal-admin'),($3,$4,now(),'qa-removal-admin')",[shared,a,removedRecipient,b]);
  const risk=(await one("insert into booking_restrictions(member_id,source_booking_id)values($1,$2)returning id",[a,shared])).id;
  await db.query("insert into booking_restriction_appeals(restriction_id,member_id,reason)values($1,$2,'member request')",[risk,a]);
  await db.query("insert into storage.objects(bucket_id,name)values('booking-receipts',$1)",[a+'/pending/photo.jpg']);
  const begin=async(actor='qa-removal-admin',code='AAAA')=>(await one("select begin_member_removal($1,'qa-removal-AAAA',$2) result",[actor,code])).result;
  const finish=async id=>(await one("select finish_member_removal('qa-removal-admin',$1) result",[id])).result;
  await t.test('authorization and exact confirmation precede every mutation',async()=>{
   await assert.rejects(begin('qa-removal-outsider'),/ADMIN_REQUIRED/);await assert.rejects(begin(undefined,'BBBB'),/CONFIRMATION_MISMATCH/);
   assert.equal((await one('select status from members where id=$1',[a])).status,'active');
   await assert.rejects(one("select begin_member_removal('qa-removal-admin','qa-removal-admin','ADMIN')"),/MEMBER_NOT_FOUND/);
  });
  await t.test('admin status update reports a pending removal conflict, not a generic database error',async()=>{
    const api=fs.readFileSync(path.resolve(__dirname,'../../supabase/functions/api/index.ts'),'utf8');
    const start=api.indexOf('if (action === "admin.member.update")');
    const end=api.indexOf('if (action === "admin.member-tiers.save")',start);
    assert.ok(start>0&&end>start,'member admin API must exist');
    const handler=api.slice(start,end);
    assert.ok(handler.includes('updated.error && String(updated.error.message || "").includes("MEMBER_REMOVED")'),'must detect guarded update');
    assert.ok(handler.includes('new ApiError(409,"MEMBER_REMOVAL_IN_PROGRESS"'),'must provide actionable conflict');
    assert.ok(handler.includes('if (updated.error) throw mapDatabaseError(updated.error)'),'other database errors stay mapped');
  });
  const job=await begin();assert.equal(job.state,'deleting');assert.equal((await begin()).jobId,job.jobId);
  await t.test('pending storage failure keeps identity disabled and rejects writes and stale signed uploads',async()=>{
   await assert.rejects(finish(job.jobId),/REMOVAL_STORAGE_PENDING/);
   assert.equal((await one('select status from members where id=$1',[a])).status,'disabled');
   await assert.rejects(db.query('insert into point_balances(member_id,point_card_id,stamps)values($1,$2,1) on conflict(member_id,point_card_id)do update set stamps=1',[a,card]),/MEMBER_REMOVED/);
   await assert.rejects(db.query("insert into storage.objects(bucket_id,name)values('booking-receipts',$1)",[a+'/late/photo.jpg']),/MEMBER_REMOVED/);
   await assert.rejects(db.query("update members set status='active' where id=$1",[a]),/MEMBER_REMOVED/);
  });
  await db.query('delete from storage.objects where name like $1',[a+'/%']);
  // Reproduce the baseline bug: FK NO ACTION from newly added booking-risk
  // tables blocks the final delete. This cannot count as a successful removal.
  await assert.rejects(finish(job.jobId),/foreign key constraint|violates foreign key/);
  assert.equal((await one('select status from members where id=$1',[a])).status,'disabled');
  await exec('20261128214500_member_removal_booking_risk_cleanup.sql');
  const removalDdl=()=>one("select pg_get_functiondef('public.finish_member_removal(text,uuid)'::regprocedure) body");
  const installedBeforeRepeat=(await removalDdl()).body;
  assert.equal(installedBeforeRepeat.split("-- A member's archived booking-risk records").length,2);
  await exec('20261128214500_member_removal_booking_risk_cleanup.sql');
  assert.equal((await removalDdl()).body,installedBeforeRepeat,'repeated release must not duplicate cleanup');
  const templateAfterRepeat=await one("select (snapshot->'functions'->1->>'definition') body from platform_private.business_templates where version='business-v1-20261019'");
  assert.equal(templateAfterRepeat.body.split("-- A member's archived booking-risk records").length,2,'future tenant template is applied exactly once');
  // A late no-show callback must not revive member-linked data after begin.
  await assert.rejects(db.query("insert into booking_restrictions(member_id,source_booking_id)values($1,$2)",[a,removedRecipient]),/MEMBER_REMOVED/);
  // Reproduce a real tenant failure: information_schema.columns includes joined
  // read-only views such as booking_services_priced, not just writable tables.
  await db.exec(`create view public.qa_member_removal_priced_view as
    select s.title,s.created_by,t.name as type_name
      from booking_services s join booking_service_types t on t.name=s.service_type;`);
  assert.equal((await one("select relkind from pg_class where oid='public.qa_member_removal_priced_view'::regclass")).relkind,'v');
  await assert.rejects(finish(job.jobId),/cannot update view|not automatically updatable|cannot modify|INSTEAD OF|is not updatable/i);
  assert.equal((await one('select status from members where id=$1',[a])).status,'disabled','failed finish must remain blocked');
  assert.equal((await one('select state from member_removal_jobs where id=$1',[job.jobId])).state,'deleting','failed finish must remain retryable');
  await exec('20261128234500_member_removal_skip_readonly_views.sql');
  const viewFix=(await removalDdl()).body;
  assert.match(viewFix,/rel\.relkind in \('r','p'\)/,'finalizer updates only base/partitioned tables');
  await exec('20261128234500_member_removal_skip_readonly_views.sql');
  assert.equal((await removalDdl()).body,viewFix,'view fix is idempotent');
  const futureViewFix=await one("select (snapshot->'functions'->1->>'definition') body from platform_private.business_templates where version='business-v1-20261019'");
  assert.match(futureViewFix.body,/rel\.relkind in \('r','p'\)/,'future tenants must skip read-only views');
    const result=await finish(job.jobId);assert.equal(result.state,'complete');assert.equal((await finish(job.jobId)).alreadyApplied,true);
  assert.equal((await one("select count(*)::int n from members where id=$1",[a])).n,0,'retry after view-safe migration completes removal');
  assert.equal((await one('select created_by from booking_services where id=$1',[svc])).created_by,'removed-member','base-table attribution still scrubbed');
  await t.test('no member FK or private identity remains, receiver balance and ledger remain intact',async()=>{
   assert.equal((await one('select count(*)::int n from members where id=$1',[a])).n,0);
   const fks=(await db.query("select c.relname,a.attname from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_attribute a on a.attrelid=k.conrelid and a.attnum=any(k.conkey) where k.contype='f' and k.confrelid='public.members'::regclass")).rows;
   for(const fk of fks)assert.equal((await one(`select count(*)::int n from ${fk.relname} where ${fk.attname}=$1`,[a])).n,0,fk.relname);
   for(const table of ['booking_no_show_events','booking_restrictions','booking_restriction_appeals']){
    assert.equal((await one(`select count(*)::int n from ${table} where member_id=$1`,[a])).n,0,table);
   }
   assert.equal((await one('select count(*)::int n from booking_no_show_events where member_id=$1',[b])).n,1);
   assert.equal((await one('select stamps from point_balances where member_id=$1 and point_card_id=$2',[b,card])).stamps,5);
   assert.equal((await one('select sum(amount)::int n from point_entries where member_id=$1',[b])).n,3);
   const kept=await one('select member_id,service_recipient_member_id,contact_phone from bookings where id=$1',[shared]);assert.equal(kept.member_id,null);assert.equal(kept.service_recipient_member_id,b);assert.equal(kept.contact_phone,null);
   const cancelled=await one('select member_id,service_recipient_member_id,status from bookings where id=$1',[removedRecipient]);assert.equal(cancelled.member_id,b);assert.equal(cancelled.service_recipient_member_id,null);assert.equal(cancelled.status,'cancelled');
   assert.equal((await one('select sender_member_id from point_transfers')).sender_member_id,null);
   assert.equal((await one('select member_id from member_removal_jobs where id=$1',[job.jobId])).member_id,null);
   await assert.rejects(db.query("insert into storage.objects(bucket_id,name)values('booking-receipts',$1)",[a+'/resurrect/photo.jpg']),/MEMBER_REMOVED/);
   await assert.rejects(one("select member_login_claim('qa-removal-AAAA',$1,$2,1,'login')",['a'.repeat(64),'b'.repeat(64)]),/MEMBER_REMOVED/);
   await one("select member_login_claim('qa-removal-AAAA',$1,$2,$3,'login')",['a'.repeat(64),'b'.repeat(64),Date.now()+10000]);
   const next=await make('AAAA');assert.notEqual(next,a);assert.equal((await one('select count(*)::int n from point_balances where member_id=$1',[next])).n,0);
  });
  await exec('20261128223000_member_removal_admin_activity_reset.sql');
  await t.test('administrator self-removal deletes only their member card and retains administrator security history',async()=>{
    await db.exec("insert into admins(line_user_id,role,status)values('qa-removal-peer-admin','admin','active');");
    await one("insert into members(line_user_id,member_code,invite_code,status,membership_status,display_name,is_test_account)values('qa-removal-peer-admin','PEER','AABB000000','active','active','Peer admin member',true) returning id");
    const self=(await one("insert into members(line_user_id,member_code,invite_code,status,membership_status,display_name,is_test_account)values('qa-removal-admin','SELF','CCDD000000','active','active','Admin member card',true) returning id")).id;
    await db.exec("insert into audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)values(new_public_id('AUD'),'qa-removal-admin','admin','ADMIN_SETTINGS_UPDATED','business','business-settings','success','{}'::jsonb);");

    // Self-removal must distinguish security-critical admin audits from the
    // same LINE identity's private member presence and booking activity.
    await db.exec(`insert into audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
      values(new_public_id('AUD'),'qa-removal-admin','member','user.member.presence.online','member','qa-removal-admin','success','{}'::jsonb),
            (new_public_id('AUD'),'qa-removal-admin','member','user.booking.presence.offline','member','qa-removal-admin','success','{}'::jsonb),
            (new_public_id('AUD'),'system','system','line.push.grant','member','qa-removal-admin','success','{}'::jsonb);
      insert into booking_audit_events(id,actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
        values(990001,'qa-removal-admin','member','BOOKING_TICKETS_REDEEMED','booking','qa-synthetic-private','success','{}'::jsonb),
              (990002,'qa-removal-admin','admin','BOOKING_SETTINGS_UPDATED','booking','qa-admin-security','success','{}'::jsonb);`);

    await assert.rejects(one("select begin_member_removal('qa-removal-admin','qa-removal-peer-admin','PEER')"),/ADMIN_PROTECTED/);
    await assert.rejects(one("select begin_member_removal('qa-removal-outsider','qa-removal-admin','SELF')"),/ADMIN_REQUIRED/);
    const priorRemovalAudits=(await one("select count(*)::int n from audit_logs where actor_line_user_id='qa-removal-admin' and action='MEMBER_REMOVAL_COMPLETE'")).n;
    const begun=(await one("select begin_member_removal('qa-removal-admin','qa-removal-admin','SELF') result")).result;
    assert.equal(begun.state,'deleting');
    const removed=(await one("select finish_member_removal('qa-removal-admin',$1) result",[begun.jobId])).result;
    assert.equal(removed.state,'complete');
    assert.equal((await one('select count(*)::int n from members where id=$1',[self])).n,0);
    const retained=await one("select role,status from admins where line_user_id='qa-removal-admin'");
    assert.deepEqual({role:retained.role,status:retained.status},{role:'admin',status:'active'});
    assert.equal((await one("select count(*)::int n from audit_logs where actor_line_user_id='qa-removal-admin' and action='ADMIN_SETTINGS_UPDATED'")).n,1);
    assert.equal((await one("select count(*)::int n from audit_logs where actor_line_user_id='qa-removal-admin' and action='MEMBER_REMOVAL_COMPLETE'")).n,priorRemovalAudits+1);
 
    assert.equal((await one("select count(*)::int n from audit_logs where actor_role='member' and actor_line_user_id='qa-removal-admin'")).n,0,'self-removal must erase past member online/offline logs');
    assert.equal((await one("select count(*)::int n from audit_logs where actor_role='system' and target_type='member' and target_id='qa-removal-admin'")).n,0,'member-targeted system activity must not be inherited');
    assert.equal((await one("select count(*)::int n from booking_audit_events where actor_role='member' and actor_line_user_id='qa-removal-admin'")).n,0,'member booking audit must not survive on an admin identity');
    assert.equal((await one("select count(*)::int n from booking_audit_events where actor_role='admin' and actor_line_user_id='qa-removal-admin'")).n,1,'admin booking security audit remains');

    assert.equal((await one("select count(*)::int n from members where line_user_id='qa-removal-peer-admin'")).n,1);

    // An old completed self-removal also has to be fixed by the one-time
    // history backfill, even without its original member row.
    await db.exec(`insert into audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail,created_at)
       values(new_public_id('AUD'),'qa-removal-admin','member','user.member.presence.online','member','qa-removal-admin','success','{}'::jsonb,now()-interval '2 days'),
             (new_public_id('AUD'),'qa-removal-admin','admin','ADMIN_SETTINGS_UPDATED','business','retained-admin-action','success','{}'::jsonb,now()-interval '2 days');
       insert into booking_audit_events(id,actor_line_user_id,actor_role,action,target_type,target_id,result,metadata,created_at)
       values(990003,'qa-removal-admin','member','BOOKING_TICKETS_REDEEMED','booking','qa-legacy-ticket','success','{}'::jsonb,now()-interval '2 days');`);
    assert.equal((await one("select count(*)::int n from audit_logs where actor_role='member' and actor_line_user_id='qa-removal-admin'")).n,1,'simulate historical orphaned member audit');
    await exec('20261128223000_member_removal_admin_activity_reset.sql');
    assert.equal((await one("select count(*)::int n from audit_logs where actor_role='member' and actor_line_user_id='qa-removal-admin'")).n,0,'backfill clears orphaned past-member audit');
    assert.equal((await one("select count(*)::int n from booking_audit_events where actor_role='member' and actor_line_user_id='qa-removal-admin'")).n,0,'backfill clears orphaned member booking audit');
    assert.equal((await one("select count(*)::int n from audit_logs where actor_role='admin' and actor_line_user_id='qa-removal-admin' and action='ADMIN_SETTINGS_UPDATED'")).n,2,'backfill must preserve separate administrator audit');
    const patched=(await removalDdl()).body;
    assert.equal(patched.split('-- Member-only activity is erased even for an admin LINE identity.').length,2,'repeated migration must not duplicate the function cleanup');

    // A new registration after removal is a new member, never the old ledger.
    await one("select member_login_claim('qa-removal-admin',$1,$2,$3,'login')",['a'.repeat(64),'b'.repeat(64),Date.now()+10000]);
    const rejoined=(await one("insert into members(line_user_id,member_code,invite_code,status,membership_status,display_name,is_test_account) values('qa-removal-admin','REJOIN','EEFF000000','active','pending','New account',true) returning id")).id;
    assert.notEqual(rejoined,self);
    assert.equal((await one('select count(*)::int n from point_entries where member_id=$1',[rejoined])).n,0);
    assert.equal((await one('select count(*)::int n from point_balances where member_id=$1',[rejoined])).n,0);
    assert.equal((await one('select count(*)::int n from member_referrals where inviter_member_id=$1 or invitee_member_id=$1',[rejoined])).n,0);
    assert.equal((await one("select count(*)::int n from audit_logs where target_type='member' and target_id='qa-removal-admin' and action like 'user.%.presence.%'")).n,0,'new member must not see old presence timeline');

  });
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(begin(),/permission denied/);await assert.rejects(db.query('select * from member_removal_jobs'),/permission denied/);await db.exec('reset role');}
 }finally{await db.close();}
});
