require('../fixtures/line-webhook-cases.cjs')('PostgreSQL 17',require('./database.cjs'));
const test=require('node:test'),assert=require('node:assert/strict');
const {setup,channel}=require('../fixtures/line-webhook-cases.cjs');
test('PostgreSQL 17 #144 two physical transactions serialize redelivery and commit one receipt',async()=>{
 const h=await setup(require('./database.cjs'));try{
  await h.save();await h.bind();const c=await h.prepare();
  const writer=await h.db.connect(),reader=await h.db.connect();await writer.query('set role service_role');await reader.query('set role service_role');
  const pid=(await reader.query('select pg_backend_pid() pid')).rows[0].pid;
  assert.notEqual((await writer.query('select pg_backend_pid() pid')).rows[0].pid,pid);
  const args=[channel,'booking',c.revision,[{eventId:'concurrent-evt',type:'message',timestamp:1793000000000,redelivery:true}]];
  const query='select public.platform_line_webhook_ingest($1,$2,$3,$4) result';
  await writer.query('begin');const first=await writer.query(query,args.map(v=>Array.isArray(v)?JSON.stringify(v):v));
  const pending=reader.query(query,args.map(v=>Array.isArray(v)?JSON.stringify(v):v));pending.catch(()=>{});
  let waiting=false;for(let i=0;i<100;i++){if((await h.db.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event_type==='Lock'){waiting=true;break;}await new Promise(r=>setTimeout(r,20));}
  assert.equal(waiting,true);await writer.query('commit');
  assert.equal(first.rows[0].result.accepted,1);assert.equal((await pending).rows[0].result.accepted,0);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.line_webhook_receipts')).rows[0].n,1);
 }finally{await h.db.close();}
});
test('PostgreSQL 17 #144 competing merchant Channel claims serialize and only the verified writer commits',async()=>{
 const h=await setup(require('./database.cjs'));try{
  const {owner,features}=require('../fixtures/merchant-applications.cjs'),{line,issued}=require('../fixtures/line-webhook-cases.cjs');
  const second=(await h.review(await h.submit(owner,'concurrent-channel-owner'),'approved',features(['booking']))).tenant;
  const writer=await h.db.connect(),reader=await h.db.connect();await writer.query('set role service_role');await reader.query('set role service_role');
  const pid=(await reader.query('select pg_backend_pid() pid')).rows[0].pid;
  const query='select public.platform_save_module_line_for_merchant($1,$2,$3,$4,$5,$6,$7,$8,$9) result';
  const args=t=>[owner,t.id,issued(),'booking',1,crypto.randomUUID(),'a'.repeat(64),line,h.secret];
  await writer.query('begin');await writer.query(query,args(h.tenant));
  const pending=reader.query(query,args(second));pending.catch(()=>{});
  let waiting=false;for(let i=0;i<100;i++){if((await h.db.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event_type==='Lock'){waiting=true;break;}await new Promise(r=>setTimeout(r,20));}
  assert.equal(waiting,true);await writer.query('commit');await assert.rejects(pending,/LINE_CHANNEL_IN_USE/);
  assert.equal((await h.db.query('select tenant_id from platform_private.line_channel_owners where channel_id=$1',[channel])).rows[0].tenant_id,h.tenant.id);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.module_secrets where tenant_id=$1',[second.id])).rows[0].n,0);
 }finally{await h.db.close();}
});
test('PostgreSQL 17 #144 revocation between HMAC candidate and commit blocks stale receipt after concurrent suspension',async()=>{
 const h=await setup(require('./database.cjs'));try{
  const {owner}=require('../fixtures/merchant-applications.cjs');await h.save();await h.bind();const candidate=await h.prepare();
  const revoker=await h.db.connect(),receiver=await h.db.connect();await receiver.query('set role service_role');
  const pid=(await receiver.query('select pg_backend_pid() pid')).rows[0].pid;
  await revoker.query('begin');await revoker.query("update platform_private.tenants set status='suspended' where id=$1",[h.tenant.id]);
  const pending=receiver.query('select public.platform_line_webhook_ingest($1,$2,$3,$4) result',[channel,'booking',candidate.revision,JSON.stringify([{eventId:'revoked-in-flight',type:'follow',timestamp:1,redelivery:false}])]);pending.catch(()=>{});
  let waiting=false;for(let i=0;i<100;i++){if((await h.db.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event_type==='Lock'){waiting=true;break;}await new Promise(r=>setTimeout(r,20));}
  assert.equal(waiting,true);await revoker.query('commit');await assert.rejects(pending,/LINE_WEBHOOK_STALE/);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.line_webhook_receipts')).rows[0].n,0);
 }finally{await h.db.close();}
});
