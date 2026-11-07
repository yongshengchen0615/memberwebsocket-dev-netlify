const test=require('node:test'),assert=require('node:assert/strict');
const fixture=require('./business-platform-fixture.cjs');
test('AC-184-01/05/06: suspend and reinstate preserve grants, configuration, expiry and revoke old credentials',async()=>{
 const h=await fixture();try{
  const t=await h.approve('U'+'2'.repeat(32),'access-test');
  const call=(action,row,extra={})=>h.call({action,tenantId:row.id,expectedVersion:row.version,requestId:crypto.randomUUID(),...extra});
  const suspended=await call('platform.tenant.suspend',t);assert.equal(suspended.status,200);
  const resumed=await call('platform.tenant.resume',suspended.body.data.tenant);
  assert.equal(resumed.status,200,JSON.stringify(resumed));
  const row=(await h.db.query('select * from platform_private.tenants where id=$1',[t.id])).rows[0];
  assert.equal(row.status,'active');assert.deepEqual(row.features,t.features);assert.deepEqual(row.line_config,t.line_config);
  assert.ok(row.access_revoked_before);assert.equal(row.expires_at,null);
 }finally{await h.db.close();}
});
test('AC-184-04/07/08: owner cannot restore, direct roles denied, concurrent updates conflict and errors roll back',async()=>{
 const h=await fixture();try{
  let t=await h.approve('U'+'2'.repeat(32),'access-concurrency');
  const payload={action:'platform.tenant.expiry.save',tenantId:t.id,expectedVersion:1,requestId:crypto.randomUUID(),expiresAt:'2020-01-01T00:00:00Z'};
  assert.equal((await h.call(payload,'manager')).status,403);assert.equal((await h.call(payload,'invalid')).status,401);
  const results=await Promise.all([h.call(payload),h.call({...payload,requestId:crypto.randomUUID()})]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  assert.deepEqual(await h.call(payload),results[0]);
  assert.equal((await h.call({...payload,expiresAt:null})).status,409);
  t=(await h.db.query('select * from platform_private.tenants')).rows[0];
  assert.equal(t.version,2);assert.equal(new Date(t.expires_at).toISOString(),'2020-01-01T00:00:00.000Z');
  assert.equal((await h.db.query('select count(*)::int n from public.platform_active_businesses()')).rows[0].n,0);
  assert.equal((await h.db.query('select public.platform_tick_businesses() n')).rows[0].n,0);
  const suspended=await h.call({action:'platform.tenant.suspend',tenantId:t.id,expectedVersion:2,requestId:crypto.randomUUID()});
  const resumed=await h.call({action:'platform.tenant.resume',tenantId:t.id,expectedVersion:suspended.body.data.tenant.version,requestId:crypto.randomUUID()});
  assert.equal(resumed.status,200);assert.equal(resumed.body.data.tenant.expired,true);assert.equal(resumed.body.data.tenant.onboarding.adminReady,false);
  assert.equal((await h.call({action:'platform.application.bootstrap'},'manager')).status,401,'pre-suspension identity remains revoked');
  for(const role of ['anon','authenticated']){
   await h.db.exec('set role '+role);
   await assert.rejects(h.db.query('select public.platform_update_tenant_access($1,$2,1,$3,$4)',[h.root,t.id,crypto.randomUUID(),{status:'active'}]),/permission denied/);
   await h.db.exec('reset role');
  }
  const before=(await h.db.query('select to_jsonb(t) t from platform_private.tenants t')).rows[0].t;
  await h.db.exec("create function platform_private.fail_access_audit() returns trigger language plpgsql as $$ begin if new.action='TENANT_EXPIRY_UPDATED' then raise exception 'synthetic failure'; end if; return new; end $$; create trigger fail_access_audit before insert on platform_private.audit_events for each row execute function platform_private.fail_access_audit();");
  const failure=await h.call({...payload,expectedVersion:before.version,expiresAt:'2099-01-01T00:00:00Z',requestId:crypto.randomUUID()});
  assert.equal(failure.status,503);assert.deepEqual((await h.db.query('select to_jsonb(t) t from platform_private.tenants t')).rows[0].t,before);
  const audit=(await h.db.query("select detail from platform_private.audit_events where action='TENANT_EXPIRY_UPDATED'")).rows[0].detail;
  assert.equal(audit.before.expiresAt,null);assert.equal(audit.after.version,2);assert.equal(audit.result,'success');
 }finally{await h.db.close();}
});
test('AC-ENV-002/003/005: independent module configuration, encrypted credentials, owner/grant checks and replay safety',async()=>{
 const h=await fixture();try{
  let t=await h.approve('U'+'2'.repeat(32),'module-scope');
  const base={adminChannelId:'2010791619',adminLiffId:'2010791619-admin',memberChannelId:'2010787602',messagingChannelId:'2010123456'};
  const save=(feature,version,extra={})=>({action:'platform.line.save',feature,expectedVersion:version,requestId:crypto.randomUUID(),line:{...base,[feature==='membership'?'memberLiffId':'pointsLiffId']:'2010787602-'+feature},credentials:{channelAccessToken:'synthetic-'+feature+'-token-123456789',channelSecret:'a'.repeat(32)},...extra});
  const first=save('membership',1),a=await h.call(first,'manager');assert.equal(a.status,200,JSON.stringify(a));assert.deepEqual(await h.call(first,'manager'),a);
  const second=save('points',2,{line:{...base,memberChannelId:'2010789999',pointsLiffId:'2010789999-points'}}),b=await h.call(second,'manager');
  assert.equal(b.status,200,JSON.stringify(b));assert.equal(b.body.data.tenant.moduleLine.membership.line.memberLiffId,'2010787602-membership');
  const {openCredentials}=await import('../../supabase/functions/_shared/platform-crypto.mjs');const {key}=require('./platform-fixture.cjs');
  const secrets=(await h.db.query('select * from platform_private.module_secrets order by feature')).rows;
  for(const row of secrets){const actual=await openCredentials(t.id+':'+row.feature,row.envelope,key);assert.equal(actual.channelAccessToken,'synthetic-'+row.feature+'-token-123456789');
   await assert.rejects(openCredentials(t.id+':other',row.envelope,key));}
  const view=JSON.stringify({a,b,audit:(await h.db.query('select detail from platform_private.audit_events')).rows});assert.doesNotMatch(view,/synthetic-membership-token|synthetic-points-token|ciphertext/);
  const disabled={...b.body.data.tenant.features,points:false};
  const grant=await h.call({action:'platform.tenant.features.save',tenantId:t.id,expectedVersion:3,features:disabled,requestId:crypto.randomUUID()});assert.equal(grant.status,200);
  assert.equal((await h.call(save('points',4),'manager')).status,403);
  assert.equal((await h.call(save('membership',4),'root')).status,403);
  const {createPlatformHandler}=await import('../../supabase/functions/_shared/platform-handler.mjs');
  const foreign=createPlatformHandler({db:{rpc:h.rpc},allowedOrigins:h.allowedOrigins,verifyIdentity:async()=>({lineUserId:'U'+'3'.repeat(32),issuedAtMs:Date.now()}),encryptionKey:()=>key});
  const foreignResult=await foreign(new Request('https://api.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify({...save('membership',4),idToken:'foreign'})}));assert.equal(foreignResult.status,403);
  for(const role of ['anon','authenticated']){await h.db.exec('set role '+role);await assert.rejects(h.db.query('select * from platform_private.module_secrets'),/permission denied/);await h.db.exec('reset role');}
  const {publicTenant}=await import('../../supabase/functions/_shared/platform-policy.mjs');
  const current=(await h.db.query('select * from platform_private.tenants')).rows[0];assert.equal(publicTenant(current).moduleLine.points,undefined);
 }finally{await h.db.close();}
});
test('AC-181-007/ENV-003: existing suspended configuration upgrades without losing grants, encrypted secrets or approval',async()=>{
 const h=await require('./business-runtime-fixture.cjs')({beforeAccess:true});try{
  const t=await h.approve('U'+'2'.repeat(32),'upgrade-access');
  await h.db.query("update platform_private.tenants set status='suspended' where id=$1",[t.id]);
  const fs=require('node:fs'),path=require('node:path');
  for(const name of ['20261019122719_admin_access_lifecycle.sql','20261019122917_module_line_scope.sql'])await h.db.exec(fs.readFileSync(path.join(__dirname,'../../supabase/migrations',name),'utf8'));
  const row=(await h.db.query('select * from platform_private.tenants')).rows[0];assert.equal(row.status,'suspended');assert.deepEqual(row.features,t.features);assert.equal(row.expires_at,null);assert.ok(row.access_revoked_before);
  const resumed=(await h.db.query('select public.platform_update_tenant_access($1,$2,$3,$4,$5) t',[h.root,t.id,row.version,crypto.randomUUID(),{status:'active'}])).rows[0].t;
  assert.equal(resumed.status,'active');assert.equal(new Date(resumed.access_revoked_before).getTime(),new Date(row.access_revoked_before).getTime());
  assert.equal((await h.db.query('select status from platform_private.applications')).rows[0].status,'approved');
 }finally{await h.db.close();}
});
