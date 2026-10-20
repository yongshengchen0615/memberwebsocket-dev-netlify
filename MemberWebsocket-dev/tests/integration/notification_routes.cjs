const {test}=require('node:test'),assert=require('node:assert/strict');
const fixture=require('./business-platform-fixture.cjs'),{key}=require('./platform-fixture.cjs');
const owner='U'+'2'.repeat(32),features=Object.fromEntries(['membership','points','events','calendar','booking','testing','integrations','usage'].map(k=>[k,true]));
const token='synthetic-notification-token-with-no-real-provider-access';
async function setup(){
 const h=await fixture(),t=await h.approve(owner,'notification-shop',features);
 const {createPlatformHandler}=await import('../../supabase/functions/_shared/platform-handler.mjs');
 let valid=true;const provider=[];
 const handler=createPlatformHandler({db:{rpc:h.rpc},allowedOrigins:h.allowedOrigins,encryptionKey:()=>key,
   verifyApplicantIdentity:async id=>{if(id!=='manager')throw Error('UNVERIFIED');return{lineUserId:owner};},verifyIdentity:()=>assert.fail('must use applicant authentication'),
   fetchImpl:async(url,options)=>{provider.push({url,options});return new Response(JSON.stringify({client_id:valid?'2010123456':'different-channel',expires_in:1000}),{status:200});}});
 const call=async body=>{const r=await handler(new Request('https://backend.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify({idToken:'manager',business:t.slug,...body})}));return{status:r.status,body:await r.json()};};
 const save=async(body={})=>call({action:'platform.notifications.save',feature:'booking',purpose:'admin',mode:'custom',messagingChannelId:'2010123456',channelAccessToken:token,requestId:crypto.randomUUID(),expectedVersion:(await h.db.query('select version from platform_private.tenants where id=$1',[t.id])).rows[0].version,...body});
 return{...h,t,call,save,provider,setValid:v=>valid=v};
}
test('AC-186: real SQL encrypts scoped routes; masked responses, idempotency and LIFF edits preserve other purposes',async()=>{
 const h=await setup();try{
  const requestId=crypto.randomUUID(),first=await h.save({requestId,expectedVersion:1});assert.equal(first.status,200,JSON.stringify(first));
  const retry=await h.save({requestId,expectedVersion:1});assert.equal(retry.status,200);assert.equal(retry.body.data.tenant.version,2);
  assert.equal(h.provider[0].url,'https://api.line.me/v2/oauth/verify');assert.equal(h.provider[0].options.body.get('access_token'),token);
  assert.equal(h.provider[0].url.includes(token),false);
  assert.equal((await h.save({purpose:'member'})).status,200);
  const testId=crypto.randomUUID(),testBody={action:'platform.notifications.test',feature:'booking',purpose:'admin',expectedVersion:3,requestId:testId,to:'U'+'f'.repeat(32),message:'FORGED'};
  assert.equal((await h.call(testBody)).status,200);assert.equal((await h.call(testBody)).status,200);
  const pushes=h.provider.filter(c=>c.url.endsWith('/message/push'));assert.equal(pushes.length,1,'accepted test retries must use cached provider result');
  assert.equal(JSON.parse(pushes[0].options.body).to,owner);assert.equal(pushes[0].options.body.includes('FORGED'),false);assert.equal(pushes[0].options.headers['X-Line-Retry-Key'],testId);
  assert.equal((await h.save({feature:'points',purpose:'member',mode:'disabled'})).status,200);
  const current=(await h.db.query('select * from platform_private.tenants where id=$1',[h.t.id])).rows[0];
  const line={adminChannelId:'2010791619',adminLiffId:'2010791619-admin',memberChannelId:'2010787602',messagingChannelId:'2010123456',bookingLiffId:'2010787602-booking'};
  const edit=await h.call({action:'platform.line.save',feature:'booking',line,credentials:{channelAccessToken:'synthetic-legacy-token-123456',channelSecret:'a'.repeat(32)},requestId:crypto.randomUUID(),expectedVersion:current.version});assert.equal(edit.status,200,JSON.stringify(edit));
  assert.equal(edit.body.data.tenant.moduleLine.booking.notifications.admin.mode,'custom');assert.equal(edit.body.data.tenant.moduleLine.booking.notifications.member.mode,'custom');
  const rows=(await h.db.query('select * from platform_private.module_notification_routes order by feature,purpose')).rows;
  const {openCredentials}=await import('../../supabase/functions/_shared/platform-crypto.mjs');
  const admin=rows.find(r=>r.purpose==='admin');assert.equal((await openCredentials(h.t.id+':booking:notify:admin',admin.envelope,key)).channelAccessToken,token);
  await assert.rejects(openCredentials(h.t.id+':booking:notify:member',admin.envelope,key));
  const publicState=JSON.stringify([first.body,edit.body,(await h.db.query('select * from platform_private.audit_events')).rows,(await h.db.query('select result from platform_private.requests')).rows]);
  assert.equal(publicState.includes(token),false);assert.equal(publicState.includes('"envelope"'),false);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='NOTIFICATION_ROUTE_UPDATED'")).rows[0].n,3);
  await h.db.exec('set role anon');await assert.rejects(h.db.query('select * from platform_private.module_notification_routes'),/permission denied/);await h.db.exec('reset role');
 }finally{await h.db.close();}
});
test('AC-186: provider rejection, foreign business, stale version, revoked grant and suspended tenant fail closed',async()=>{
 const h=await setup();try{
  h.setValid(false);assert.equal((await h.save()).body.error.code,'LINE_NOTIFICATION_INVALID');assert.equal((await h.db.query('select count(*)::int n from platform_private.module_notification_routes')).rows[0].n,0);
  h.setValid(true);await h.approve('U'+'3'.repeat(32),'other-shop',features);assert.equal((await h.save({business:'other-shop'})).status,403);
  assert.equal((await h.save({feature:'points',purpose:'admin'})).status,400);
  assert.equal((await h.save()).status,200);assert.equal((await h.save({expectedVersion:1})).body.error.code,'PLATFORM_CONFLICT');
  await h.db.query("update platform_private.tenants set features=jsonb_set(features,'{booking}','false') where id=$1",[h.t.id]);assert.equal((await h.save()).body.error.code,'FEATURE_DISABLED');
  await h.db.query("update platform_private.tenants set status='suspended' where id=$1",[h.t.id]);assert.equal((await h.save()).status,403);
 }finally{await h.db.close();}
});
test('AC-185: opaque revisions use private PostgreSQL schemas, authorized identities and no idle writes',async()=>{
 const h=await setup();try{
  const {syncRevision}=await import('../../supabase/functions/_shared/sync-revision.mjs');
  const error=(status,code,message)=>Object.assign(Error(message),{status,code});
  const db=schema=>({from(table){let columns,conditions=[],args=[],limit='';const q={select(value){columns=value;return q;},eq(k,v){args.push(v);conditions.push(`${k}=$${args.length}`);return q;},in(k,values){args.push(values);conditions.push(`${k}=any($${args.length})`);return q;},order(){limit=' order by id desc';return q;},limit(n){limit+=' limit '+n;return q;},async maybeSingle(){try{return{data:(await h.db.query(`select ${columns} from ${schema}.${table} where ${conditions.join(' and ')}${limit}`,args)).rows[0]||null,error:null};}catch(e){return{data:null,error:e};}}};return q;}});
  const scoped=db(h.t.runtime_schema),before=await syncRevision(scoped,'admin',owner,error);
  await h.db.query(`insert into ${h.t.runtime_schema}.realtime_events(scope,event_type)values('admin','booking.fixture')`);
  const after=await syncRevision(scoped,'admin',owner,error);assert.notEqual(before.revision,after.revision);
  assert.deepEqual(await syncRevision(scoped,'admin',owner,error),after);
  await assert.rejects(syncRevision(scoped,'admin','U'+'f'.repeat(32),error),e=>e.status===403);
  const other=await h.approve('U'+'3'.repeat(32),'sync-other',features);
  await assert.rejects(syncRevision(db(other.runtime_schema),'admin',owner,error),e=>e.status===403);
  assert.deepEqual(Object.keys(after),['revision']);
 }finally{await h.db.close();}
});
test('AC-186: existing cron dispatches a custom-only notification module without requiring Login/LIFF credentials',async()=>{
 const h=await setup();try{
  assert.equal((await h.save({feature:'membership',purpose:'member'})).status,200);
  await h.db.query('update platform_private.tenants set features=$2 where id=$1',[h.t.id,{...features,points:false,events:false,calendar:false,booking:false}]);
  await h.db.exec(`create schema net;create table net.calls(body jsonb);
   create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer)returns bigint language plpgsql as $$begin insert into net.calls values(body);return 1;end$$;
   insert into vault.decrypted_secrets(name,decrypted_secret,updated_at)values('project_url','https://fixture.supabase.co',now()),('GRANT_MESSAGE_DISPATCH_SECRET','synthetic-dispatch',now());`);
  const member=(await h.db.query(`insert into ${h.t.runtime_schema}.members(line_user_id,member_code,invite_code,status,membership_status,display_name,is_test_account)
   values($1,'AAAA','AAAA000000','active','pending','Synthetic',false)returning id`,['U'+'d'.repeat(32)])).rows[0].id;
  await h.db.query(`insert into ${h.t.runtime_schema}.scheduled_grant_messages(schedule_id,request_id,member_id,line_user_id,scheduled_for,message_text,created_by)
   values('QA-schedule','QA-request',$1,$2,now()-interval '1 minute','Synthetic','system')`,[member,'U'+'d'.repeat(32)]);
  await h.db.query('select public.platform_tick_businesses()');
  assert.equal((await h.db.query('select * from net.calls')).rows[0].body.business,h.t.slug);
  assert.equal((await h.db.query('select credentials_configured from platform_private.tenants where id=$1',[h.t.id])).rows[0].credentials_configured,false);
 }finally{await h.db.close();}
});
test('AC-186: configuring notifications before a newly granted module preserves legacy Login/LIFF and credential scope',async()=>{
 const h=await setup();try{
  const {sealCredentials,openCredentials}=await import('../../supabase/functions/_shared/platform-crypto.mjs');
  const line={adminChannelId:'2010791619',adminLiffId:'2010791619-admin',memberChannelId:'2010787602',messagingChannelId:'2010123456',bookingLiffId:'2010787602-booking'};
  const envelope=await sealCredentials(h.t.id,{channelAccessToken:'synthetic-inherited-token-123456',channelSecret:'a'.repeat(32)},key);
  await h.db.query('insert into platform_private.tenant_secrets(tenant_id,envelope)values($1,$2)',[h.t.id,envelope]);
  await h.db.query('update platform_private.tenants set credentials_configured=true,line_config=$2 where id=$1',[h.t.id,line]);
  const saved=await h.save();assert.equal(saved.status,200,JSON.stringify(saved));
  assert.deepEqual(saved.body.data.tenant.moduleLine.booking.line,line);assert.equal(saved.body.data.tenant.moduleLine.booking.credentialsConfigured,true);
  const inherited=(await h.rpc('platform_module_credentials',{p_tenant_id:h.t.id,p_feature:'booking'})).data;
  assert.equal(inherited.scope,'tenant');assert.equal((await openCredentials(h.t.id,inherited.envelope,key)).channelAccessToken,'synthetic-inherited-token-123456');
  assert.equal((await h.db.query('select line_config from platform_private.tenants where id=$1',[h.t.id])).rows[0].line_config.adminChannelId,line.adminChannelId);
 }finally{await h.db.close();}
});
