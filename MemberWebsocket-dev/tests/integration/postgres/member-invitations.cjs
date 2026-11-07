const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const database=require('./database.cjs');
const {setup}=require('../fixtures/member-invitations.cjs');
let h;
before(async()=>{h=await setup(await database());});
after(async()=>{if(h)await h.db.close();});
async function sessions(){const a=await h.db.connect(),b=await h.db.connect();for(const c of [a,b])await c.query('set role service_role');return[a,b];}
async function waiter(client,blocker){
 const pid=(await client.query('select pg_backend_pid() pid')).rows[0].pid,bpid=(await blocker.query('select pg_backend_pid() pid')).rows[0].pid;
 assert.notEqual(pid,bpid,'independent physical sessions required');
 return async()=>{const end=Date.now()+5000;while(Date.now()<end){if((await h.db.query('select $2::int=any(pg_blocking_pids($1::int)) blocked',[pid,bpid])).rows[0].blocked)return;await new Promise(r=>setTimeout(r,20));}assert.fail('expected a real PostgreSQL row-lock wait');};
}
async function attribution(t,p){return(await h.db.query(`select inviter_id,activated_at,reward_status,last_error,referral_id from ${t.runtime_schema}.member_invitation_attributions where invitee_id=$1`,[p.id])).rows[0];}
async function count(t,p){return(await h.db.query(`select count(*)::int n from ${t.runtime_schema}.member_referrals where invitee_member_id=$1`,[p.id])).rows[0].n;}
test('PG17 INV15 concurrent different valid claims preserve the first attribution',async()=>{
 const t=h.old,a=await h.active(t),b=await h.active(t),p=await h.pending(t),x=await h.token(t,a),y=await h.token(t,b),[writer,reader]=await sessions(),wait=await waiter(reader,writer);let second;
 try{await writer.query('begin');await h.rpc(t,'member_invitation_claim',[p.line_user_id,x.hash],writer);
  second=h.rpc(t,'member_invitation_claim',[p.line_user_id,y.hash],reader);second.catch(()=>{});await wait();
  assert.equal(await attribution(t,p),undefined);await writer.query('commit');await assert.rejects(second,/INVITATION_ALREADY_CLAIMED/);
  assert.equal((await attribution(t,p)).inviter_id,a.id);assert.equal(await count(t,p),0);
 }finally{await writer.query('rollback');if(second)await second.catch(()=>{});}
});
test('PG17 INV16 claim racing an uncommitted first activation cannot strand late attribution',async()=>{
 const t=h.old,a=await h.active(t),p=await h.pending(t),x=await h.token(t,a),[writer,reader]=await sessions(),wait=await waiter(reader,writer);let second;
 try{await writer.query('begin');await h.accept(t,p,writer);
  second=h.rpc(t,'member_invitation_claim',[p.line_user_id,x.hash],reader);second.catch(()=>{});await wait();await writer.query('commit');await assert.rejects(second,/INVITATION_ACTIVE_MEMBER/);
  assert.equal(await attribution(t,p),undefined);assert.equal(await count(t,p),0);
 }finally{await writer.query('rollback');if(second)await second.catch(()=>{});}
});
test('PG17 INV17 concurrent first activation replays settle exactly one inviter reward',async()=>{
 const t=h.old,a=await h.active(t),p=await h.pending(t);await h.source(t);const x=await h.token(t,a);await h.rpc(t,'member_invitation_claim',[p.line_user_id,x.hash]);
 const [writer,reader]=await sessions(),wait=await waiter(reader,writer);let second;
 try{await writer.query('begin');assert.equal(await h.accept(t,p,writer),true);second=h.accept(t,p,reader);second.catch(()=>{});await wait();
  assert.equal((await attribution(t,p)).activated_at,null);assert.equal(await count(t,p),0);await writer.query('commit');assert.equal(await second,false);
  assert.equal((await attribution(t,p)).reward_status,'issued');assert.equal(await count(t,p),1);
  const relation=(await h.db.query(`select inviter_member_id from ${t.runtime_schema}.member_referrals where invitee_member_id=$1`,[p.id])).rows[0];assert.equal(relation.inviter_member_id,a.id);
  await h.rpc(t,'member_invitation_retry',[a.line_user_id]);assert.equal(await count(t,p),1);
 }finally{await writer.query('rollback');if(second)await second.catch(()=>{});}
});
test('PG17 INV18 rollback keeps original claim and waiting activation owns the only reward',async()=>{
 const t=h.old,a=await h.active(t),p=await h.pending(t);await h.source(t);const x=await h.token(t,a);await h.rpc(t,'member_invitation_claim',[p.line_user_id,x.hash]);
 const [writer,reader]=await sessions(),wait=await waiter(reader,writer);let second;
 try{await writer.query('begin');await h.accept(t,p,writer);second=h.accept(t,p,reader);second.catch(()=>{});await wait();await writer.query('rollback');assert.equal(await second,true);
  assert.equal((await attribution(t,p)).reward_status,'issued');assert.equal(await count(t,p),1);
 }finally{await writer.query('rollback');if(second)await second.catch(()=>{});}
});
test('PG17 INV19 competing activations cannot exceed the final campaign quota',async()=>{
 const t=h.fresh,a=await h.active(t),b=await h.active(t),p=await h.pending(t),q=await h.pending(t);const source=await h.source(t,1),x=await h.token(t,a),y=await h.token(t,b);
 await h.rpc(t,'member_invitation_claim',[p.line_user_id,x.hash]);await h.rpc(t,'member_invitation_claim',[q.line_user_id,y.hash]);
 const [writer,reader]=await sessions(),wait=await waiter(reader,writer);let second;
 try{await writer.query('begin');await h.accept(t,p,writer);second=h.accept(t,q,reader);second.catch(()=>{});await wait();await writer.query('commit');assert.equal(await second,true);
  assert.equal((await attribution(t,p)).reward_status,'issued');const pending=await attribution(t,q);assert.equal(pending.reward_status,'pending');assert.equal(pending.last_error,'REFERRAL_REWARD_SOLD_OUT');
  await h.rpc(t,'member_invitation_retry',[b.line_user_id]);assert.equal(await count(t,q),0);
  const claims=(await h.db.query(`select count(*)::int n from ${t.runtime_schema}.event_ticket_claims c join ${t.runtime_schema}.event_tickets e on e.id=c.event_ticket_id where e.referral_source_event_ticket_id=$1`,[source])).rows[0].n;assert.equal(claims,1);
 }finally{await writer.query('rollback');if(second)await second.catch(()=>{});}
});
test('PG17 INV20 legacy inviter lock contention leaves successful activation with retryable sanitized failure',async()=>{
 const t=h.fresh,a=await h.active(t),p=await h.pending(t);await h.source(t);const x=await h.token(t,a);await h.rpc(t,'member_invitation_claim',[p.line_user_id,x.hash]);const [writer,reader]=await sessions();
 try{await writer.query('begin');await writer.query(`select id from ${t.runtime_schema}.members where id=$1 for update`,[a.id]);
  assert.equal(await h.accept(t,p,reader),true);const pending=await attribution(t,p);assert.ok(pending.activated_at);assert.equal(pending.reward_status,'pending');assert.equal(pending.last_error,'INVITATION_RETRY_REQUIRED');assert.equal(await count(t,p),0);
  await writer.query('rollback');await h.rpc(t,'member_invitation_retry',[a.line_user_id]);assert.equal((await attribution(t,p)).reward_status,'issued');assert.equal(await count(t,p),1);
 }finally{await writer.query('rollback');}
});
test('PG17 INV21 retry skips busy invitee without opposite member/attribution lock deadlock',async()=>{
 const t=h.fresh,a=await h.active(t),p=await h.pending(t);await h.db.exec(`update ${t.runtime_schema}.event_tickets set status='draft' where ticket_type='referral' and referral_source_event_ticket_id is null`);const x=await h.token(t,a);
 await h.rpc(t,'member_invitation_claim',[p.line_user_id,x.hash]);await h.accept(t,p);await h.source(t);const [writer,reader]=await sessions();
 try{await writer.query('begin');await writer.query(`select id from ${t.runtime_schema}.members where id=$1 for update`,[p.id]);const result=await h.rpc(t,'member_invitation_retry',[a.line_user_id],reader);assert.equal(result.pendingCount,1);assert.equal(result.rewardedCount,0);
  await writer.query('rollback');await h.rpc(t,'member_invitation_retry',[a.line_user_id]);assert.equal(await count(t,p),1);
 }finally{await writer.query('rollback');}
});
