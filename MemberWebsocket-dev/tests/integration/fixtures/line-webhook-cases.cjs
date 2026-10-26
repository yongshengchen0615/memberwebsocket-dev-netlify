const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const merchant=require('./merchant-applications.cjs');
const dir=path.resolve(__dirname,'../../../supabase/migrations');
const migration=suffix=>fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith(suffix))||'MISSING_LINE_WEBHOOK_MIGRATION'),'utf8');
const issued=()=>new Date(Date.now()+1000).toISOString(),destination='U'+'a'.repeat(32),channel='2010123456';
const line={adminChannelId:'2010791619',adminLiffId:'2010791619-admin',memberChannelId:'2010787602',messagingChannelId:channel,bookingLiffId:'2010787602-booking'};
async function setup(database,before){
 const h=await merchant.setup(database?{database:await database()}:{});
 try{
  for(const suffix of ['_merchant_explicit_context.sql','_line_capabilities.sql'])await h.db.exec(migration(suffix));
  await h.qualify();h.tenant=(await h.review(await h.submit(),'approved',merchant.features(['booking','points']))).tenant;
  const {sealCredentials}=await import('../../../supabase/functions/_shared/platform-crypto.mjs');
  h.secret=await sealCredentials(h.tenant.id+':booking',{channelAccessToken:'synthetic-token-for-webhook-test',channelSecret:'a'.repeat(32)},require('../platform-fixture.cjs').key);
  h.save=(t=h.tenant,feature='booking',version=1,value=line,secret=h.secret)=>h.call('platform_save_module_line_for_merchant',[merchant.owner,t.id,issued(),feature,version,crypto.randomUUID(),'a'.repeat(64),value,secret]);
  if(before)await before(h);
  await h.db.exec(migration('_line_webhook.sql'));
  h.prepare=(t=h.tenant,feature='booking',actor=merchant.owner)=>h.call('platform_line_webhook_prepare',[actor,t.id,issued(),feature]);
  h.status=(t=h.tenant,feature='booking',actor=merchant.owner)=>h.call('platform_line_webhook_status',[actor,t.id,issued(),feature]);
  h.bind=async(t=h.tenant,feature='booking',bot=destination)=>{const c=await h.prepare(t,feature);return h.call('platform_line_webhook_bind',[merchant.owner,t.id,issued(),feature,c.channelId,bot,c.revision]);};
  h.ingest=(revision,events=[{eventId:'evt-1',type:'message',timestamp:1793000000000,redelivery:false}])=>h.call('platform_line_webhook_ingest',[channel,'booking',revision,events]);
  return h;
 }catch(e){await h.db.close();throw e;}
}
module.exports=(label,database)=>{
 test(label+' #144 unverified optional Channel IDs cannot squat a different merchant Channel',async()=>{
  const h=await setup(database);try{
   await h.save(h.tenant,'booking',1,line,null);
   assert.equal((await h.db.query('select count(*)::int n from platform_private.line_channel_owners')).rows[0].n,0);
   const second=(await h.review(await h.submit(merchant.owner,'verified-channel-shop'),'approved',merchant.features(['booking']))).tenant;
   await h.save(second);assert.equal((await h.db.query('select tenant_id from platform_private.line_channel_owners where channel_id=$1',[channel])).rows[0].tenant_id,second.id);
  }finally{await h.db.close();}
 });
 test(label+' #144 shared Channel module checks preserve independent health and disabling one leaves another valid candidate',async()=>{
  const h=await setup(database);try{
   await h.save();await h.bind();const p=await h.prepare();await h.ingest(p.revision);
   await h.save(h.tenant,'points',2,{adminChannelId:line.adminChannelId,adminLiffId:line.adminLiffId,memberChannelId:line.memberChannelId,messagingChannelId:channel,pointsLiffId:'2010787602-points'});
   await h.bind(h.tenant,'points');assert.equal((await h.status()).ingressState,'verified');assert.equal((await h.status(h.tenant,'points')).apiState,'accepted');
   await h.db.query("update platform_private.tenants set features=jsonb_set(features,'{points}','false') where id=$1",[h.tenant.id]);
   assert.equal((await h.call('platform_line_webhook_candidate',[destination]))[0].feature,'booking');assert.equal((await h.ingest(p.revision)).accepted,0);
  }finally{await h.db.close();}
 });
 test(label+' #144 suspend then approve invalidates old receipt revisions until a fresh Provider check',async()=>{
  const h=await setup(database);try{
   await h.save();await h.bind();const old=await h.prepare();
   let q=(await h.db.query('select id,version from platform_private.admin_qualifications where applicant_line_user_id=$1',[merchant.owner])).rows[0];
   q=await h.call('platform_review_admin_qualification',[merchant.root,q.id,q.version,'suspended','Synthetic revocation',crypto.randomUUID()]);
   await h.call('platform_review_admin_qualification',[merchant.root,q.id,q.version,'approved','',crypto.randomUUID()]);
   assert.equal(await h.call('platform_line_webhook_candidate',[destination]),null);await assert.rejects(h.ingest(old.revision),/LINE_WEBHOOK_STALE/);
   assert.equal((await h.status()).apiState,'pending');await h.bind();const fresh=await h.prepare();assert.notEqual(fresh.revision,old.revision);assert.equal((await h.ingest(fresh.revision)).accepted,1);
   await h.db.query("update platform_private.tenants set status='suspended' where id=$1",[h.tenant.id]);
   await h.db.query("update platform_private.tenants set status='active' where id=$1",[h.tenant.id]);
   assert.equal(await h.call('platform_line_webhook_candidate',[destination]),null);await assert.rejects(h.ingest(fresh.revision),/LINE_WEBHOOK_STALE/);
  }finally{await h.db.close();}
 });
 test(label+' #144 conflicting legacy channels abort the entire migration and preserve existing configuration',async()=>{
  let upgraded;
  await assert.rejects(setup(database,async h=>{
   upgraded=h;
   await h.save();const second=(await h.review(await h.submit(merchant.owner,'legacy-duplicate'),'approved',merchant.features(['booking']))).tenant;await h.save(second);
   assert.equal((await h.db.query('select count(*)::int n from platform_private.module_secrets')).rows[0].n,2);
  }),/LINE_CHANNEL_IN_USE/);
  assert.ok(upgraded,'legacy fixture reached migration preflight');
 });
 test(label+' #144 upgrade and claims: same merchant may share channels, foreign claims fail and LIFF-only stays valid',async()=>{
  const h=await setup(database,async h=>{await h.save();});try{
   assert.equal((await h.db.query('select count(*)::int n from platform_private.line_channel_owners')).rows[0].n,1);
   await h.save(h.tenant,'points',2,{...line,bookingLiffId:undefined,pointsLiffId:'2010787602-points'});
   const second=(await h.review(await h.submit(merchant.owner,'second-shop'),'approved',merchant.features(['booking']))).tenant;
   await assert.rejects(h.save(second),/LINE_CHANNEL_IN_USE/);
   assert.equal((await h.db.query('select count(*)::int n from platform_private.module_secrets where tenant_id=$1',[second.id])).rows[0].n,0);
   await h.save(second,'booking',1,{...line,messagingChannelId:''},null);
   assert.equal((await h.status(second)).configurationState,'optional');
  }finally{await h.db.close();}
 });
 test(label+' #144 status/binding/receipts: authorized redacted summaries, terminal dedup, empty verification and transactional rejects',async()=>{
  const h=await setup(database);try{
   await h.save();const p=await h.prepare();assert.equal(p.scope,'module');assert.ok(p.revision);
   await h.bind();const c=(await h.call('platform_line_webhook_candidate',[destination]))?.[0];assert.equal(c.tenantId,h.tenant.id);
   const r=await h.ingest(c.revision);assert.equal(r.accepted,1);assert.equal((await h.ingest(c.revision)).accepted,0);
   await h.ingest(c.revision,[]);const status=await h.status();assert.equal(status.eventsReceived,1);assert.equal(status.humanState,'pending');assert.equal(status.ingressState,'verified');
   const serialized=JSON.stringify(status);for(const term of ['envelope','revision','synthetic','channelSecret','replyToken'])assert.ok(!serialized.includes(term));
   await assert.rejects(h.ingest(c.revision,[{eventId:'evt-2',type:'message',timestamp:1,redelivery:false},{eventId:'bad',type:'message',timestamp:1,redelivery:false,text:'secret'}]),/LINE_WEBHOOK_INVALID_EVENT/);
   assert.equal((await h.db.query('select count(*)::int n from platform_private.line_webhook_receipts')).rows[0].n,1);
   for(const role of ['anon','authenticated']){
    await assert.rejects(h.call('platform_line_webhook_candidate',[destination],role),/permission denied/);
    await assert.rejects(h.call('platform_line_webhook_status',[merchant.owner,h.tenant.id,issued(),'booking'],role),/permission denied/);
    await assert.rejects(h.db.exec('set role '+role+'; select * from platform_private.line_webhook_receipts'),/permission denied/);await h.db.exec('reset role');
    const privileges=await h.db.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'platform_line_webhook_%' and has_function_privilege($1,p.oid,'EXECUTE')",[role]);
    assert.equal(privileges.rows.length,0,'no new webhook RPC may be invoked by a browser role');
   }
  }finally{await h.db.close();}
 });
 test(label+' #144 current authorization and revision fence rotation, disabled feature, foreign merchant, revoked qualification and expiry',async()=>{
  const h=await setup(database);try{
   await h.save();await h.bind();const p=await h.prepare();
   await assert.rejects(h.status(h.tenant,'booking',merchant.other),/QUALIFICATION|TENANT_NOT_FOUND/);
   await h.save(h.tenant,'booking',2,line,{...h.secret,data:h.secret.data.slice(0,-4)+'AAAA'});
   assert.equal(await h.call('platform_line_webhook_candidate',[destination]),null);await assert.rejects(h.ingest(p.revision),/LINE_WEBHOOK_STALE/);
   await h.bind();const current=await h.prepare();
   await h.db.query("update platform_private.tenants set features=jsonb_set(features,'{booking}','false') where id=$1",[h.tenant.id]);
   await assert.rejects(h.status(),/FEATURE_DISABLED/);await assert.rejects(h.ingest(current.revision),/LINE_WEBHOOK_STALE/);
   await h.db.query("update platform_private.tenants set features=jsonb_set(features,'{booking}','true'),expires_at=clock_timestamp()-interval '1 second' where id=$1",[h.tenant.id]);
   assert.equal(await h.call('platform_line_webhook_candidate',[destination]),null);
   await h.db.query("update platform_private.tenants set expires_at=null where id=$1",[h.tenant.id]);
   await h.db.query("update platform_private.admin_qualifications set status='suspended' where applicant_line_user_id=$1",[merchant.owner]);
   assert.equal(await h.call('platform_line_webhook_candidate',[destination]),null);await assert.rejects(h.status(),/QUALIFICATION/);
   assert.equal((await h.db.query('select count(*)::int n from platform_private.line_webhook_receipts')).rows[0].n,0);
  }finally{await h.db.close();}
 });
 test(label+' #144 signed rate limits are bounded without storing payloads or accepting partial batches',async()=>{
  const h=await setup(database);try{
   await h.save();await h.bind();const p=await h.prepare();await h.ingest(p.revision,[]);
   await h.db.query('update platform_private.line_channel_owners set rate_count=120 where channel_id=$1',[channel]);
   await assert.rejects(h.ingest(p.revision),/LINE_WEBHOOK_RATE_LIMIT/);
   assert.equal((await h.db.query('select count(*)::int n from platform_private.line_webhook_receipts')).rows[0].n,0);
  }finally{await h.db.close();}
 });
};
module.exports.setup=setup;module.exports.destination=destination;module.exports.channel=channel;module.exports.line=line;module.exports.issued=issued;
