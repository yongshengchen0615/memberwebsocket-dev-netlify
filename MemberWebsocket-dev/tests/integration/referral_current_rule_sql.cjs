const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const load=require('./fixtures/load-postgres-snapshot.cjs');
test('current referral SQL rewards only the caller, replays once and rolls back incomplete issuance',async t=>{
 const db=await load(),one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
 try{
  for(const migration of ['20261003123000_referral_inviter_only_repeatable_rewards.sql','20261008111000_referral_actor_gets_reward.sql'])await db.exec(fs.readFileSync(path.resolve(__dirname,'../../supabase/migrations',migration),'utf8'));
  await db.exec('select maintenance.ensure_required_system_baseline();');
  const ids={};
  for(const [code,invite]of [['AAAA','A000000001'],['BBBB','B000000001'],['CCCC','C000000001'],['DDDD','D000000001']])ids[code]=(await one("insert into members(line_user_id,member_code,invite_code,status,membership_status,is_test_account)values($1,$2,$3,'active','active',true)returning id",['test:referral-'+code,code,invite])).id;
  const bind=async(actor,invite,request)=>(await one('select bind_member_referral($1,$2,$3) result',['test:referral-'+actor,invite,request])).result;
  const totals=async()=>({relations:(await one('select count(*)::int n from member_referrals')).n,claims:(await one("select count(*)::int n from event_ticket_claims where ticket_type='referral'")).n,children:(await one('select count(*)::int n from event_tickets where referral_source_event_ticket_id is not null')).n,audits:(await one("select count(*)::int n from audit_logs where action='user.member.referral.bind'")).n});
  await assert.rejects(bind('AAAA','B000000001','QA-REFERRAL-MISSING'),/REFERRAL_REWARD_UNAVAILABLE/);
  const source=(await one("insert into event_tickets(event_ticket_id,title,ticket_type,status,quota,allowed_tier_keys,ends_on,created_by,updated_by)values('QA-REF-SOURCE','QA referral','referral','active',2,array(select tier_key from membership_tier_settings),current_date+7,'test:admin','test:admin')returning id")).id;
  let first;
  await t.test('caller owns a new child claim; target owns no reward; same target replay does not issue again',async()=>{
   first=await bind('AAAA','B000000001','QA-REFERRAL-FIRST');assert.equal(first.alreadyApplied,false);assert.notEqual(first.rewardEventTicketId,'QA-REF-SOURCE');
   const claim=await one('select c.member_id,c.status,e.referral_source_event_ticket_id from event_ticket_claims c join event_tickets e on e.id=c.event_ticket_id where e.event_ticket_id=$1',[first.rewardEventTicketId]);
   assert.deepEqual(claim,{member_id:ids.AAAA,status:'claimed',referral_source_event_ticket_id:source});
   assert.equal((await one('select count(*)::int n from event_ticket_claims where member_id=$1',[ids.BBBB])).n,0);
   for(const request of ['QA-REFERRAL-FIRST','QA-REFERRAL-RETRY']){const replay=await bind('AAAA','B000000001',request);assert.equal(replay.alreadyApplied,true);assert.equal(replay.referralId,first.referralId);assert.equal(replay.rewardEventTicketId,first.rewardEventTicketId);}
   assert.deepEqual(await totals(),{relations:1,claims:1,children:1,audits:1});
  });
  await t.test('distinct targets reward again; bound target, self and exhausted quota reject without writes',async()=>{
   await assert.rejects(bind('DDDD','B000000001','QA-REFERRAL-BOUND'),/REFERRAL_ALREADY_BOUND/);
   await assert.rejects(bind('AAAA','A000000001','QA-REFERRAL-SELF'),/SELF_REFERRAL_NOT_ALLOWED/);
   const second=await bind('AAAA','C000000001','QA-REFERRAL-SECOND');assert.notEqual(second.referralId,first.referralId);assert.notEqual(second.rewardEventTicketId,first.rewardEventTicketId);
   assert.equal((await one('select count(*)::int n from event_ticket_claims where member_id=$1',[ids.AAAA])).n,2);
   await assert.rejects(bind('AAAA','D000000001','QA-REFERRAL-SOLDOUT'),/REFERRAL_REWARD_SOLD_OUT/);
   assert.deepEqual(await totals(),{relations:2,claims:2,children:2,audits:2});
  });
  await t.test('failure after claim and relation inserts rolls back issuance and a retry succeeds once',async()=>{
   await db.query('update event_tickets set quota=3 where id=$1',[source]);
   await db.exec("create function public.qa_fail_referral_audit() returns trigger language plpgsql as $$ begin if new.action='user.member.referral.bind' then raise exception 'QA_REFERRAL_WRITE_FAILURE'; end if; return new; end $$;create trigger qa_referral_failure before insert on audit_logs for each row execute function public.qa_fail_referral_audit();");
   await assert.rejects(bind('AAAA','D000000001','QA-REFERRAL-FAULT'),/QA_REFERRAL_WRITE_FAILURE/);
   assert.deepEqual(await totals(),{relations:2,claims:2,children:2,audits:2});
   await db.exec('drop trigger qa_referral_failure on audit_logs;');
   const result=await bind('AAAA','D000000001','QA-REFERRAL-FAULT');assert.equal(result.alreadyApplied,false);assert.equal((await bind('AAAA','D000000001','QA-REFERRAL-FAULT')).alreadyApplied,true);
   assert.deepEqual(await totals(),{relations:3,claims:3,children:3,audits:3});
  });
  await t.test('browser database roles cannot impersonate a referral caller',async()=>{
   for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(bind('AAAA','B000000001','QA-REFERRAL-DENIED'),/permission denied/);await db.exec('reset role');}
  });
 }finally{await db.close();}
});
