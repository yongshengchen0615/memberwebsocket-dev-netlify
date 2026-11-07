const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {setup:merchantSetup,owner,features}=require('./merchant-applications.cjs');
const {key}=require('../platform-fixture.cjs');
const dir=path.resolve(__dirname,'../../../supabase/migrations');
const migration=suffix=>{const names=fs.readdirSync(dir).filter(n=>n.endsWith(suffix));assert.equal(names.length,1);return fs.readFileSync(path.join(dir,names[0]),'utf8');};
const line=feature=>({adminChannelId:'2010791619',adminLiffId:'2010791619-admin',memberChannelId:'2010787602',messagingChannelId:'',[{membership:'memberLiffId',points:'pointsLiffId',events:'eventLiffId',calendar:'calendarLiffId',booking:'bookingLiffId'}[feature]]:'2010787602-'+feature});
async function setup(database,beforeUpgrade){
 const h=await merchantSetup(database?{database:await database()}:{});try{
  await h.db.exec(migration('_merchant_explicit_context.sql'));
  await h.qualify();h.tenant=(await h.review(await h.submit(),'approved',features(['membership','points','events','calendar','booking']))).tenant;
  if(beforeUpgrade)await beforeUpgrade(h);
  if(!process.env.LINE_CAPABILITIES_BEFORE_UPGRADE)await h.db.exec(migration('_line_capabilities.sql'));
  h.write=(feature,expectedVersion,requestId=crypto.randomUUID(),value=line(feature),secret=null,tenant=h.tenant)=>h.call('platform_save_module_line_for_merchant',[owner,tenant.id,new Date(Date.now()+1000).toISOString(),feature,expectedVersion,requestId,'a'.repeat(64),value,secret]);
  return h;
 }catch(e){await h.db.close();throw e;}
}
module.exports=(label,database)=>{
 test(label+' #124 replay lookup: accepted requests require current merchant, feature, token cutoff and exact operation/hash',async()=>{
  const h=await setup(database);try{
   const id=crypto.randomUUID(),issuedAt=new Date(Date.now()+1000).toISOString();
   await h.write('calendar',1,id);
   const args=[owner,h.tenant.id,issuedAt,'calendar','module_line:calendar',id,'a'.repeat(64),true];
   const replay=(changes=[])=>h.call('platform_configuration_replay',changes.length?changes:args);
   assert.equal((await replay()).version,2);
   const absent=[...args];absent[5]=crypto.randomUUID();assert.equal(await replay(absent),null);
   const changed=[...args];changed[6]='b'.repeat(64);await assert.rejects(replay(changed),/PLATFORM_REQUEST_CONFLICT/);
   const operation=[...args];operation[3]='booking';operation[4]='module_line:booking';await assert.rejects(replay(operation),/PLATFORM_REQUEST_CONFLICT/);
   const second=(await h.review(await h.submit(owner,'replay-other','Other'),'approved',features(['calendar']))).tenant;
   const foreign=[...args];foreign[1]=second.id;await assert.rejects(replay(foreign),/PLATFORM_REQUEST_CONFLICT/);
   for(const role of ['anon','authenticated'])await assert.rejects(h.call('platform_configuration_replay',args,role),/permission denied/);
   await h.db.query("update platform_private.tenants set features=jsonb_set(features,'{calendar}','false') where id=$1",[h.tenant.id]);
   await assert.rejects(replay(),/PLATFORM_FEATURE_DISABLED/);
   await h.db.query("update platform_private.tenants set features=jsonb_set(features,'{calendar}','true'),access_revoked_before=$2::timestamptz+interval '1 second' where id=$1",[h.tenant.id,issuedAt]);
   await assert.rejects(replay(),/TENANT_REAUTH_REQUIRED/);
   assert.equal((await h.db.query('select version from platform_private.tenants where id=$1',[h.tenant.id])).rows[0].version,2);
   assert.equal((await h.db.query('select count(*)::int n from platform_private.requests where request_id=$1',[id])).rows[0].n,1);
  }finally{await h.db.close();}
 });
 test(label+' #124 SQL: all five no-secret modules retain scoped LIFF, versions/replay and private RPC grants',async()=>{
  const h=await setup(database);try{
   let version=1;for(const feature of ['membership','points','events','calendar','booking']){
    const saved=await h.write(feature,version++);assert.equal(saved.module_line[feature].credentialsConfigured,false);assert.deepEqual(saved.module_line[feature].line,line(feature));
   }
   assert.equal((await h.db.query('select count(*)::int n from platform_private.module_secrets')).rows[0].n,0);
   const id=crypto.randomUUID();await h.write('calendar',version,id);
   assert.equal((await h.write('calendar',version,id)).version,version+1);
   await assert.rejects(h.write('calendar',version),/PLATFORM_CONFLICT/);
   const second=(await h.review(await h.submit(owner,'second-liff','Second'),'approved',features(['calendar']))).tenant;
   await assert.rejects(h.write('calendar',version,id,line('calendar'),null,second),/PLATFORM_REQUEST_CONFLICT/);
   assert.deepEqual((await h.db.query('select module_line from platform_private.tenants where id=$1',[second.id])).rows[0].module_line,{});
   for(const role of ['anon','authenticated'])await assert.rejects(h.call('platform_save_module_line_for_merchant',[owner,h.tenant.id,new Date().toISOString(),'calendar',version,crypto.randomUUID(),'b'.repeat(64),line('calendar'),null],role),/permission denied/);
  }finally{await h.db.close();}
 });
 test(label+' #124 SQL upgrade: legacy tenant envelope keeps AES scope, unrelated channels do not inherit it and module channel rotation requires replacement',async()=>{
  const {sealCredentials,openCredentials}=await import('../../../supabase/functions/_shared/platform-crypto.mjs');
  const credentials={channelAccessToken:'synthetic-legacy-line-token-123456',channelSecret:'a'.repeat(32)},shared={...line('booking'),messagingChannelId:'2010123456'};let envelope;
  const h=await setup(database,async h=>{
   envelope=await sealCredentials(h.tenant.id,credentials,key);
   await h.db.query('insert into platform_private.tenant_secrets(tenant_id,envelope)values($1,$2)',[h.tenant.id,envelope]);
   await h.db.query("insert into platform_private.module_secrets(tenant_id,feature,envelope,credential_scope)values($1,'booking',$2,'tenant')",[h.tenant.id,envelope]);
   await h.db.query('update platform_private.tenants set line_config=$2,credentials_configured=true,module_line=$3 where id=$1',[h.tenant.id,shared,{booking:{line:shared,credentialsConfigured:true}}]);
  });try{
   assert.deepEqual((await h.db.query("select envelope from platform_private.module_secrets where feature='booking'")).rows[0].envelope,envelope);
   const unrelated=await h.write('calendar',1,crypto.randomUUID(),line('calendar'));
   assert.equal(unrelated.module_line.calendar.credentialsConfigured,false);
   const saved=await h.write('booking',2,crypto.randomUUID(),shared);
   assert.equal(saved.module_line.booking.credentialsConfigured,true);
   const stored=(await h.db.query("select envelope,credential_scope from platform_private.module_secrets where feature='booking'")).rows[0];
   assert.equal(stored.credential_scope,'tenant');assert.deepEqual(stored.envelope,envelope);assert.deepEqual(await openCredentials(h.tenant.id,stored.envelope,key),credentials);
   await assert.rejects(openCredentials(h.tenant.id+':booking',stored.envelope,key));
   await assert.rejects(h.write('booking',3,crypto.randomUUID(),{...shared,messagingChannelId:'2010999999'}),/PLATFORM_CREDENTIALS_REQUIRED/);
   assert.equal((await h.db.query('select version from platform_private.tenants where id=$1',[h.tenant.id])).rows[0].version,3);
   const rotated=await sealCredentials(h.tenant.id+':booking',credentials,key);
   await h.write('booking',3,crypto.randomUUID(),{...shared,messagingChannelId:'2010999999'},rotated);
   assert.equal((await h.db.query("select credential_scope from platform_private.module_secrets where feature='booking'")).rows[0].credential_scope,'module');
  }finally{await h.db.close();}
 });
};
