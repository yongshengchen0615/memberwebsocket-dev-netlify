const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,shared,root,manager,key,tenantId}=require('./platform-fixture.cjs');
test('AC-001/002/003/004: real migration + handler create tenant atomically; secrets are encrypted and never listed',async()=>{
 const h=await fixture();try{
  const denied=await h.call(h.save,'manager');assert.equal(denied.status,403);assert.equal((await h.db.query('select count(*)::int n from platform_private.tenants')).rows[0].n,0);
  const saved=await h.call(h.save);assert.equal(saved.status,200,JSON.stringify(saved));assert.equal(saved.body.data.tenant.status,'pending_provisioning');
  assert.equal(saved.body.data.tenant.version,1);assert.equal(saved.body.data.tenant.credentialsConfigured,true);
  const listing=await h.call({action:'platform.bootstrap'});assert.equal(listing.status,200);assert.equal(listing.body.data.tenants.length,1);
  const rows=(await h.db.query('select * from platform_private.tenant_secrets')).rows;
  const {openCredentials}=await shared('platform-crypto.mjs');assert.deepEqual(await openCredentials(tenantId,rows[0].envelope,key),h.tenant.credentials);
  const all=JSON.stringify({saved,listing,rows,audit:(await h.db.query('select * from platform_private.audit_events')).rows});
  assert.ok(!all.includes(h.tenant.credentials.channelAccessToken));assert.ok(!all.includes(h.tenant.credentials.channelSecret));
  assert.ok(!JSON.stringify(listing).includes('envelope'));assert.ok(!JSON.stringify(listing).includes('payload_hash'));
 }finally{await h.db.close();}
});
test('AC-005: uncertain retry returns original result once; changed request is rejected; stale update preserves data',async()=>{
 const h=await fixture();try{
  const first=await h.call(h.save),replay=await h.call(h.save);assert.deepEqual(replay,first);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.audit_events')).rows[0].n,1);
  const changed=await h.call({...h.save,tenant:{...h.tenant,name:'different'}});assert.equal(changed.status,409);assert.equal(changed.body.error.code,'PLATFORM_REQUEST_CONFLICT');
  const update={...h.save,requestId:crypto.randomUUID(),expectedVersion:1,tenant:{...h.tenant,name:'updated',credentials:{channelAccessToken:'',channelSecret:''}}};
  assert.equal((await h.call(update)).status,200);
  const stale=await h.call({...update,requestId:crypto.randomUUID(),tenant:{...update.tenant,name:'stale'}});assert.equal(stale.status,409);
  const row=(await h.db.query('select name,version from platform_private.tenants')).rows[0];assert.deepEqual(row,{name:'updated',version:2});
  const cipher=(await h.db.query('select envelope from platform_private.tenant_secrets')).rows[0].envelope;const {openCredentials}=await shared('platform-crypto.mjs');assert.deepEqual(await openCredentials(tenantId,cipher,key),h.tenant.credentials);
  const identity=await h.call({...update,expectedVersion:2,requestId:crypto.randomUUID(),tenant:{...update.tenant,ownerLineUserId:root}});assert.equal(identity.status,409);
 }finally{await h.db.close();}
});
test('AC-005: competing versions yield exactly one update, with no double audit or lost increment',async()=>{
 const h=await fixture();try{
  await h.call(h.save);
  const outcomes=await Promise.all(['first','second'].map(name=>h.call({...h.save,requestId:crypto.randomUUID(),expectedVersion:1,tenant:{...h.tenant,name}})));
  assert.deepEqual(outcomes.map(x=>x.status).sort(),[200,409]);
  assert.equal((await h.db.query('select version from platform_private.tenants')).rows[0].version,2);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.audit_events')).rows[0].n,2);
 }finally{await h.db.close();}
});
test('AC-001/006: root revocation applies to old identity immediately; activation without isolation is rejected',async()=>{
 const h=await fixture();try{
  await h.call(h.save);
  await assert.rejects(h.db.query("update platform_private.tenants set status='active' where id=$1",[tenantId]),/isolation_gate/);
  const result=await h.call({action:'platform.tenant.suspend',tenantId,expectedVersion:1,requestId:crypto.randomUUID()});assert.equal(result.body.data.tenant.status,'suspended');
  await h.db.query("update admins set status='suspended' where line_user_id=$1",[root]);
  assert.equal((await h.call({action:'platform.bootstrap'})).status,403);
  assert.equal((await h.call({...h.save,requestId:crypto.randomUUID()})).status,403);
 }finally{await h.db.close();}
});
test('AC-001/004: anon/authenticated cannot read private tables or spoof root actor via RPC',async()=>{
 const h=await fixture();try{
  for(const role of ['anon','authenticated']) {
   await h.db.exec('set role '+role);
   await assert.rejects(h.db.query('select * from platform_private.tenant_secrets'),/permission denied/);
   await assert.rejects(h.db.query('select public.platform_list_tenants($1)',[root]),/permission denied/);
   await assert.rejects(h.db.query('select public.platform_is_super_admin($1)',[root]),/permission denied/);
   await h.db.exec('reset role');
  }
  // RLS remains a second boundary even if a future grant accidentally exposes a table.
  await h.db.exec('grant usage on schema platform_private to authenticated; grant select on platform_private.tenants to authenticated');
  await h.call(h.save);await h.db.exec('set role authenticated');assert.equal((await h.db.query('select * from platform_private.tenants')).rows.length,0);await h.db.exec('reset role');
  assert.equal((await h.db.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='platform_private' and c.relkind='r' and c.relrowsecurity")).rows[0].n,5);
 }finally{await h.db.close();}
});
test('AC-005/006: invalid ciphertext rolls back tenant+audit; legacy public-table reset cannot erase control plane',async()=>{
 const h=await fixture();try{
  const p={p_actor:root,p_request_id:crypto.randomUUID(),p_payload_hash:'a'.repeat(64),p_tenant_id:tenantId,p_expected_version:0,p_tenant:{name:h.tenant.name,slug:h.tenant.slug,ownerLineUserId:manager,features:h.tenant.features,line:h.tenant.line},p_secrets:{version:1,iv:'bad',data:'bad'}};
  assert.ok((await h.rpc('platform_save_tenant',p)).error);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.tenants')).rows[0].n,0);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.audit_events')).rows[0].n,0);
  await h.call(h.save);
  await h.db.exec(`do $$ declare r record; begin for r in select schemaname,tablename from pg_tables where schemaname='public' and tablename<>'admins' loop execute format('truncate table %I.%I cascade',r.schemaname,r.tablename); end loop; end $$;`);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.tenants')).rows[0].n,1);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.super_admins')).rows[0].n,1);
 }finally{await h.db.close();}
});
test('ambiguous legacy installation does not automatically select one of multiple admins as root',async()=>{
 const h=await fixture(2);try{assert.equal((await h.db.query('select count(*)::int n from platform_private.super_admins')).rows[0].n,0);assert.equal((await h.call({action:'platform.bootstrap'})).status,403);}finally{await h.db.close();}
});

test('asynchronous server key resolution completes before encrypting and committing merchant credentials',async()=>{
 const h=await fixture();try{
  const {createPlatformHandler}=await shared('platform-handler.mjs');let resolved=false;
  const handler=createPlatformHandler({db:{rpc:h.rpc},allowedOrigins:h.allowedOrigins,verifyIdentity:async()=>({lineUserId:root,displayName:'root'}),encryptionKey:async()=>{await Promise.resolve();resolved=true;return key;}});
  const response=await handler(new Request('https://backend.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify({...h.save,idToken:'synthetic-token'})}));
  assert.equal(response.status,200);assert.equal(resolved,true);
  const envelope=(await h.db.query('select envelope from platform_private.tenant_secrets')).rows[0].envelope;
  const {openCredentials}=await shared('platform-crypto.mjs');assert.deepEqual(await openCredentials(tenantId,envelope,key),h.tenant.credentials);
 }finally{await h.db.close();}
});

test('AC-009: dedicated channel plus explicit platform identity are both required; different Provider binding revokes the old UID',async()=>{
 const h=await fixture();try{
  // The verifier accepts only the platform channel, even for the actual owner.
  assert.equal((await h.call({action:'platform.bootstrap'},'legacy-root')).status,401);
  assert.equal((await h.call({action:'platform.bootstrap'},'root')).status,200);
  assert.equal((await h.call({action:'platform.bootstrap'},'manager')).status,403);
  assert.equal((await h.call({action:'platform.bootstrap'},'new-provider-root')).status,403);
  await assert.rejects(h.db.query("update platform_private.super_admins set line_user_id='invalid'"),/platform_super_admin_line_identity/);
  const newId='U'+'3'.repeat(32);
  await h.db.query('update platform_private.super_admins set line_user_id=$1 where singleton',[newId]);
  assert.equal((await h.call({action:'platform.bootstrap'},'root')).status,403);
  assert.equal((await h.call(h.save,'new-provider-root')).status,200);
  assert.equal((await h.db.query('select actor from platform_private.audit_events')).rows[0].actor,newId);
  assert.equal((await h.db.query('select count(*)::int n from admins where line_user_id=$1',[newId])).rows[0].n,0);
  await h.db.exec('update platform_private.super_admins set enabled=false');
  assert.equal((await h.call({action:'platform.bootstrap'},'new-provider-root')).status,403);
  await h.db.exec('update platform_private.super_admins set enabled=true');
  await h.db.query("update admins set status='suspended' where line_user_id=$1",[root]);
  assert.equal((await h.call({action:'platform.bootstrap'},'new-provider-root')).status,403);
 }finally{await h.db.close();}
});

test('rollback removes the new platform only and preserves legacy admins/business data',async()=>{
 const h=await fixture();try{
  await h.call(h.save);await h.db.exec('insert into public.legacy_member_data default values');
  await h.db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname,'../../supabase/rollback/product_platform_control_plane.sql'),'utf8'));
  assert.equal((await h.db.query('select count(*)::int n from public.admins')).rows[0].n,2);
  assert.equal((await h.db.query('select count(*)::int n from public.legacy_member_data')).rows[0].n,1);
  assert.equal((await h.db.query("select count(*)::int n from pg_namespace where nspname='platform_private'")).rows[0].n,0);
 }finally{await h.db.close();}
});
