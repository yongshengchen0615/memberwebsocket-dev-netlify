require('../fixtures/line-capability-cases.cjs')('PostgreSQL 17',require('./database.cjs'));
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {setup,owner,features}=require('../fixtures/merchant-applications.cjs');
test('PostgreSQL 17 #124: replay lookup waits for the original physical transaction and reads its accepted result once',async()=>{
 const h=await setup({database:await require('./database.cjs')()});try{
  const dir=path.resolve(__dirname,'../../../supabase/migrations');
  for(const suffix of ['_merchant_explicit_context.sql','_line_capabilities.sql'])await h.db.exec(fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith(suffix))),'utf8'));
  await h.qualify();const t=(await h.review(await h.submit(),'approved',features(['calendar']))).tenant;
  const writer=await h.db.connect(),reader=await h.db.connect();
  await writer.query('set role service_role');await reader.query('set role service_role');
  const pid=(await reader.query('select pg_backend_pid() pid')).rows[0].pid;
  assert.notEqual((await writer.query('select pg_backend_pid() pid')).rows[0].pid,pid);
  const id=crypto.randomUUID(),issuedAt=new Date(Date.now()+1000).toISOString(),hash='a'.repeat(64);
  const line={adminChannelId:'2010791619',adminLiffId:'2010791619-admin',memberChannelId:'2088888888',calendarLiffId:'2088888888-calendar',messagingChannelId:''};
  await writer.query('begin');
  await writer.query('select public.platform_save_module_line_for_merchant($1,$2,$3,$4,$5,$6,$7,$8,$9)',[owner,t.id,issuedAt,'calendar',1,id,hash,line,null]);
  const replay=reader.query('select public.platform_configuration_replay($1,$2,$3,$4,$5,$6,$7,$8) result',[owner,t.id,issuedAt,'calendar','module_line:calendar',id,hash,true]);replay.catch(()=>{});
  let waiting=false;
  for(let i=0;i<100;i++){if((await h.db.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event_type==='Lock'){waiting=true;break;}await new Promise(r=>setTimeout(r,20));}
  assert.equal(waiting,true,'replay must wait for the original request lock');
  await writer.query('commit');assert.equal((await replay).rows[0].result.version,2);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.requests where request_id=$1',[id])).rows[0].n,1);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='MODULE_LINE_UPDATED' and tenant_id=$1",[t.id])).rows[0].n,1);
 }finally{await h.db.close();}
});
