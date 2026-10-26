require('../fixtures/line-webhook-cases.cjs')('PostgreSQL 17',require('./database.cjs'));
const test=require('node:test'),assert=require('node:assert/strict');
const {setup,channel}=require('../fixtures/line-webhook-cases.cjs');
test('PostgreSQL 17 #144 two physical transactions serialize redelivery and commit one receipt',async()=>{
 const h=await setup(require('./database.cjs'));try{
  await h.save();await h.bind();const c=await h.prepare();
  const writer=await h.db.connect(),reader=await h.db.connect();await writer.query('set role service_role');await reader.query('set role service_role');
  const pid=(await reader.query('select pg_backend_pid() pid')).rows[0].pid;
  assert.notEqual((await writer.query('select pg_backend_pid() pid')).rows[0].pid,pid);
  const args=[channel,c.revision,[{eventId:'concurrent-evt',type:'message',timestamp:1793000000000,redelivery:true}]];
  const query='select public.platform_line_webhook_ingest($1,$2,$3) result';
  await writer.query('begin');const first=await writer.query(query,args.map(v=>Array.isArray(v)?JSON.stringify(v):v));
  const pending=reader.query(query,args.map(v=>Array.isArray(v)?JSON.stringify(v):v));pending.catch(()=>{});
  let waiting=false;for(let i=0;i<100;i++){if((await h.db.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event_type==='Lock'){waiting=true;break;}await new Promise(r=>setTimeout(r,20));}
  assert.equal(waiting,true);await writer.query('commit');
  assert.equal(first.rows[0].result.accepted,1);assert.equal((await pending).rows[0].result.accepted,0);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.line_webhook_receipts')).rows[0].n,1);
 }finally{await h.db.close();}
});
