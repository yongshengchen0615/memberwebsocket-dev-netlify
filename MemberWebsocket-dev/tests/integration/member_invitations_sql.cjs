const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {setup}=require('./fixtures/member-invitations.cjs');
let h;before(async()=>{h=await setup();});after(async()=>{if(h)await h.db.close();});
test('INV24 bounded retries rotate past twenty conflicting legacy rewards',async()=>{
 await h.db.exec('begin');try{
 const t=h.old,a=await h.active(t),b=await h.active(t),token=await h.token(t,a),members=[];
 await h.db.exec(`update ${t.runtime_schema}.event_tickets set status='draft' where ticket_type='referral' and referral_source_event_ticket_id is null`);
 for(let i=0;i<21;i++){const p=await h.pending(t);members.push(p);await h.rpc(t,'member_invitation_claim',[p.line_user_id,token.hash]);await h.accept(t,p);}
 await h.source(t);
 for(const p of members.slice(0,20))await h.rpc(t,'bind_member_referral',[b.line_user_id,(await h.db.query(`select invite_code from ${t.runtime_schema}.members where id=$1`,[p.id])).rows[0].invite_code,'legacy_'+p.id]);
 assert.equal((await h.rpc(t,'member_invitation_retry',[a.line_user_id])).rewardedCount,0);
 const result=await h.rpc(t,'member_invitation_retry',[a.line_user_id]);
 assert.equal(result.rewardedCount,1);assert.equal(result.pendingCount,20);
 const last=members.at(-1);assert.equal((await h.db.query(`select inviter_member_id from ${t.runtime_schema}.member_referrals where invitee_member_id=$1`,[last.id])).rows[0].inviter_member_id,a.id);
 }finally{await h.db.exec('rollback');}
});
test('INV23 existing member removal clears invitation secrets and claims without removing surviving members',async()=>{
 for(const t of [h.old,h.fresh]){
  const admin='U'+crypto.randomUUID().replaceAll('-','');
  await h.db.query(`insert into ${t.runtime_schema}.admins(line_user_id,role,status) values($1,'admin','active')`,[admin]);
  const a=await h.active(t),p=await h.pending(t),q=await h.pending(t),token=await h.token(t,a);
  await h.rpc(t,'member_invitation_claim',[p.line_user_id,token.hash]);
  await h.rpc(t,'member_invitation_claim',[q.line_user_id,token.hash]);
  const remove=async m=>{const job=await h.rpc(t,'begin_member_removal',[admin,m.line_user_id,m.member_code]);return h.rpc(t,'finish_member_removal',[admin,job.jobId]);};
  assert.equal((await remove(p)).state,'complete');
  assert.equal((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.member_invitation_attributions where invitee_id=$1`,[p.id])).rows[0].n,0);
  assert.equal((await remove(a)).state,'complete');
  assert.equal((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.member_invitation_tokens where inviter_id=$1`,[a.id])).rows[0].n,0);
  assert.equal((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.member_invitation_attributions where invitee_id=$1`,[q.id])).rows[0].n,0);
  assert.equal((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.members where id=$1`,[q.id])).rows[0].n,1);
 }
});
test('INV03 existing/new installers enforce first pending claim, hash/TTL and tenant isolation',async()=>{
 for(const t of [h.old,h.fresh]){
  const a=await h.active(t),b=await h.active(t),p=await h.pending(t),token=await h.token(t,a),other=await h.token(t,b);
  assert.equal(Math.round((new Date(token.expiresAt)-Date.now())/86400000),7);assert.equal(token.campaign,null);
  assert.deepEqual(await h.rpc(t,'member_invitation_claim',[p.line_user_id,token.hash]),{claimed:true,alreadyClaimed:false,rewardStatus:'awaiting_activation'});
  assert.equal((await h.rpc(t,'member_invitation_claim',[p.line_user_id,token.hash])).alreadyClaimed,true);
  await assert.rejects(h.rpc(t,'member_invitation_claim',[p.line_user_id,other.hash]),/INVITATION_ALREADY_CLAIMED/);
  await assert.rejects(h.rpc(t,'member_invitation_claim',[a.line_user_id,token.hash]),/INVITATION_ACTIVE_MEMBER/);
  const foreign=t===h.old?h.fresh:h.old,fp=await h.pending(foreign);
  await assert.rejects(h.rpc(foreign,'member_invitation_claim',[fp.line_user_id,token.hash]),/INVITATION_TOKEN_INVALID/);
  assert.deepEqual(await h.rpc(t,'member_invitation_summary',[a.line_user_id]),{joinedCount:0,rewardedCount:0,pendingCount:0,rewards:[]});
  assert.equal((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.member_referrals`)).rows[0].n,0);
  await assert.rejects(h.rpc(t,'member_invitation_create',[p.line_user_id,h.hash()]),/MEMBERSHIP_REQUIRED/);
  await assert.rejects(h.rpc(t,'member_invitation_claim',[p.line_user_id,'a'.repeat(65)]),/INVITATION_TOKEN_INVALID/);
 }
});
test('INV04 first activation atomically issues inviter reward once; private summary and retry idempotency',async()=>{
 const t=h.old,a=await h.active(t),p=await h.pending(t);await h.source(t);const token=await h.token(t,a);
 assert.equal(token.campaign.title,'Invitation reward');assert.equal(token.campaign.settlementPolicy,'current_at_activation_or_retry');
 await h.rpc(t,'member_invitation_claim',[p.line_user_id,token.hash]);await h.accept(t,p);await h.accept(t,p);
 const summary=await h.rpc(t,'member_invitation_summary',[a.line_user_id]);
 assert.equal(summary.joinedCount,1);assert.equal(summary.rewardedCount,1);assert.equal(summary.pendingCount,0);assert.equal(summary.rewards.length,1);assert.equal(summary.rewards[0].title,'Invitation reward');
 assert.doesNotMatch(JSON.stringify(summary),new RegExp(p.line_user_id+'|'+p.member_code+'|token|hash|invitee','i'));
 assert.deepEqual(await h.rpc(t,'member_invitation_retry',[a.line_user_id]),summary);
 assert.equal((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.event_ticket_claims where member_id=$1 and ticket_type='referral'`,[a.id])).rows[0].n,1);
 await assert.rejects(h.rpc(t,'member_invitation_claim',[p.line_user_id,token.hash]),/INVITATION_ACTIVE_MEMBER/);
});
test('INV05 campaign failures preserve activation and can retry current campaign without duplicate reward',async()=>{
 const t=h.fresh,a=await h.active(t),p=await h.pending(t),token=await h.token(t,a);
 await h.rpc(t,'member_invitation_claim',[p.line_user_id,token.hash]);await h.accept(t,p);
 let summary=await h.rpc(t,'member_invitation_summary',[a.line_user_id]);assert.equal(summary.joinedCount,1);assert.equal(summary.pendingCount,1);assert.equal(summary.rewardedCount,0);
 assert.equal((await h.db.query(`select last_error from ${t.runtime_schema}.member_invitation_attributions where invitee_id=$1`,[p.id])).rows[0].last_error,'REFERRAL_REWARD_UNAVAILABLE');
 await h.source(t,1);summary=await h.rpc(t,'member_invitation_retry',[a.line_user_id]);assert.equal(summary.rewardedCount,1);
 const p2=await h.pending(t);await h.rpc(t,'member_invitation_claim',[p2.line_user_id,token.hash]);await h.accept(t,p2);
 summary=await h.rpc(t,'member_invitation_retry',[a.line_user_id]);assert.equal(summary.rewardedCount,1);assert.equal(summary.pendingCount,1);
 assert.equal((await h.db.query(`select last_error from ${t.runtime_schema}.member_invitation_attributions where invitee_id=$1`,[p2.id])).rows[0].last_error,'REFERRAL_REWARD_SOLD_OUT');
});
test('INV06 expiry, disabled inviter, test parity and consent revocation fail closed',async()=>{
 const t=h.old,a=await h.active(t),p=await h.pending(t),token=await h.token(t,a);
 await h.db.query(`update ${t.runtime_schema}.member_invitation_tokens set expires_at=now()-interval '1 second' where token_hash=$1`,[token.hash]);
 await assert.rejects(h.rpc(t,'member_invitation_claim',[p.line_user_id,token.hash]),/INVITATION_TOKEN_EXPIRED/);
 const live=await h.token(t,a),synthetic=await h.pending(t,{test:true});
 await assert.rejects(h.rpc(t,'member_invitation_claim',[synthetic.line_user_id,live.hash]),/INVITATION_SOURCE_UNAVAILABLE/);
 await h.rpc(t,'member_invitation_claim',[p.line_user_id,live.hash]);await h.db.query(`update ${t.runtime_schema}.members set status='disabled' where id=$1`,[a.id]);
 await h.accept(t,p);assert.equal((await h.db.query(`select reward_status,last_error from ${t.runtime_schema}.member_invitation_attributions where invitee_id=$1`,[p.id])).rows[0].last_error,'INVITATION_SOURCE_UNAVAILABLE');
 await assert.rejects(h.rpc(t,'member_invitation_retry',[a.line_user_id]),/MEMBERSHIP_REQUIRED/);
 await h.db.query(`update ${t.runtime_schema}.members set status='active' where id=$1`,[a.id]);
 await h.db.exec('begin');
 await h.db.query(`update ${t.runtime_schema}.membership_terms set status='archived' where id=$1`,[t.terms]);
 await h.db.exec(`insert into ${t.runtime_schema}.membership_terms(version,title,body,status,required,effective_at,activated_at,reconsent_existing,created_by,updated_by) values('reconsent','Updated','Updated','active',true,now()-interval '1 day',clock_timestamp()+interval '1 second',true,'fixture','fixture')`);
 await assert.rejects(h.rpc(t,'member_invitation_create',[a.line_user_id,h.hash()]),/TERMS_RECONSENT_REQUIRED/);
 await h.db.exec('rollback');
});
test('INV07 private tables/functions deny browser roles and installer repeats safely',async()=>{
 for(const t of [h.old,h.fresh]){
  const trigger=async()=>(await h.db.query(`select oid from pg_trigger where tgrelid=$1::regclass and tgname='members_activate_invitation'`,[t.runtime_schema+'.members'])).rows[0].oid;
  const before=await trigger();
  await h.db.query('select platform_private.install_member_invitations($1)',[t.runtime_schema]);
  assert.equal(await trigger(),before,'reinstall preserves trigger identity');
  for(const role of ['anon','authenticated']){
   for(const table of ['member_invitation_tokens','member_invitation_attributions'])assert.equal((await h.db.query('select has_table_privilege($1,$2,\'select\') allowed',[role,t.runtime_schema+'.'+table])).rows[0].allowed,false);
   for(const f of ['member_invitation_create(text,text)','member_invitation_claim(text,text)','member_invitation_summary(text)','member_invitation_retry(text)'])assert.equal((await h.db.query('select has_function_privilege($1,$2,\'execute\') allowed',[role,t.runtime_schema+'.'+f])).rows[0].allowed,false);
  }
  await h.db.exec('set role service_role');
  try{const actor=(await h.db.query(`select line_user_id from ${t.runtime_schema}.members where membership_status='active' and status='active' limit 1`)).rows[0].line_user_id;await h.rpc(t,'member_invitation_summary',[actor]);}finally{await h.db.exec('reset role');}
 }
});
test('INV12 transaction rollback preserves pending claim; later activation uses current campaign',async()=>{
 const t=h.old,a=await h.active(t),p=await h.pending(t);await h.source(t);const token=await h.token(t,a);
 await h.rpc(t,'member_invitation_claim',[p.line_user_id,token.hash]);
 await h.db.exec('begin');await h.accept(t,p);await h.db.exec('rollback');
 let state=(await h.db.query(`select activated_at,reward_status from ${t.runtime_schema}.member_invitation_attributions where invitee_id=$1`,[p.id])).rows[0];assert.deepEqual(state,{activated_at:null,reward_status:'awaiting_activation'});
 assert.equal((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.member_referrals where invitee_member_id=$1`,[p.id])).rows[0].n,0);
 const current=await h.source(t);await h.db.query(`update ${t.runtime_schema}.event_tickets set title='Current campaign' where id=$1`,[current]);await h.accept(t,p);
 assert.equal((await h.rpc(t,'member_invitation_summary',[a.line_user_id])).rewards[0].title,'Current campaign');
});
test('INV13 legacy conflicting referral remains intact; expired/deleted/ineligible campaigns remain retryable',async()=>{
 const t=h.old,a=await h.active(t),legacy=await h.active(t),p=await h.pending(t),token=await h.token(t,a);
 await h.db.exec(`update ${t.runtime_schema}.event_tickets set status='draft' where ticket_type='referral' and referral_source_event_ticket_id is null`);
 await h.rpc(t,'member_invitation_claim',[p.line_user_id,token.hash]);await h.accept(t,p);await h.source(t);
 const refreshed=(await h.db.query(`select * from ${t.runtime_schema}.members where id=$1`,[p.id])).rows[0];
 const bound=await h.rpc(t,'bind_member_referral',[legacy.line_user_id,refreshed.invite_code,'LEGACY-'+crypto.randomUUID()]);
 await h.rpc(t,'member_invitation_retry',[a.line_user_id]);
 const relation=(await h.db.query(`select inviter_member_id,referral_id from ${t.runtime_schema}.member_referrals where invitee_member_id=$1`,[p.id])).rows[0];assert.equal(relation.inviter_member_id,legacy.id);assert.equal(relation.referral_id,bound.referralId);
 assert.equal((await h.db.query(`select reward_status,last_error from ${t.runtime_schema}.member_invitation_attributions where invitee_id=$1`,[p.id])).rows[0].last_error,'REFERRAL_ALREADY_BOUND');
 for(const patch of ["ends_on=current_date-1","deleted_at=now()","allowed_tier_keys=array['platinum']"]){
  const q=await h.pending(t);const source=await h.source(t);await h.db.exec(`update ${t.runtime_schema}.event_tickets set ${patch} where id='${source}'`);
  await h.rpc(t,'member_invitation_claim',[q.line_user_id,token.hash]);await h.accept(t,q);
  assert.equal((await h.db.query(`select reward_status from ${t.runtime_schema}.member_invitation_attributions where invitee_id=$1`,[q.id])).rows[0].reward_status,'pending');
  assert.equal((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.member_referrals where invitee_member_id=$1`,[q.id])).rows[0].n,0);
 }
});
test('INV14 unavailable tenant, self source and invalid hash cannot create claims',async()=>{
 const t=h.fresh,a=await h.active(t),p=await h.pending(t),token=await h.token(t,a);
 for(const patch of ["status='suspended'","expires_at=now()-interval '1 second'","features=jsonb_set(features,'{membership}','false')"]){
  await h.db.exec('begin');await h.db.exec(`update platform_private.tenants set ${patch} where id='${t.id}'`);
  await assert.rejects(h.rpc(t,'member_invitation_claim',[p.line_user_id,token.hash]),/INVITATION_TENANT_UNAVAILABLE/);await h.db.exec('rollback');
 }
 await h.db.query(`update ${t.runtime_schema}.members set membership_status='pending',joined_at=null where id=$1`,[a.id]);
 await assert.rejects(h.rpc(t,'member_invitation_claim',[a.line_user_id,token.hash]),/INVITATION_SELF_NOT_ALLOWED/);
 assert.equal((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.member_invitation_attributions where invitee_id=$1`,[p.id])).rows[0].n,0);
});
