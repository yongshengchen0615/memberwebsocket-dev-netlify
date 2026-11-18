const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),fixture=require('./business-platform-fixture.cjs'),{key}=require('./platform-fixture.cjs');
test('frontdesk setup preserves a legacy merchant inherited booking Login and notification credentials',async()=>{
 const h=await fixture();try{
  const owner='U'+'2'.repeat(32),t=await h.approve(owner,'desk-inherited'),{sealCredentials,openCredentials}=await import('../../supabase/functions/_shared/platform-crypto.mjs');
  const line={adminChannelId:'2010791619',adminLiffId:'2010791619-admin',memberChannelId:'2010787602',bookingLiffId:'2010787602-booking',messagingChannelId:'2010123456'},token='synthetic-inherited-booking-token-123456';
  const envelope=await sealCredentials(t.id,{channelAccessToken:token,channelSecret:'a'.repeat(32)},key);
  await h.db.query('insert into platform_private.tenant_secrets(tenant_id,envelope)values($1,$2)',[t.id,envelope]);
  await h.db.query('update platform_private.tenants set credentials_configured=true,line_config=$2 where id=$1',[t.id,line]);
  for(const name of ['20261026050904_line_webhook.sql','20261118122150_frontdesk_booking_access.sql','20261118190000_frontdesk_safeupdate_projection.sql'])await h.db.exec(fs.readFileSync(path.resolve(__dirname,'../../supabase/migrations',name),'utf8'));
  await h.db.query('select public.platform_frontdesk_admin($1,$2,$3,$4,$5)',[owner,t.id,new Date().toISOString(),'settings.save',{requestId:crypto.randomUUID(),payloadHash:'a'.repeat(64),expectedVersion:1,loginChannelId:'2010999999',liffId:'2010999999-desk',messagingChannelId:'2010888888',oaId:'@desk',enabled:true,envelope:{version:1,iv:'a'.repeat(16),data:'b'.repeat(48)}}]);
  const current=(await h.db.query('select module_line from platform_private.tenants where id=$1',[t.id])).rows[0].module_line.booking;
  assert.equal(current.credentialsConfigured,true);assert.deepEqual(current.line,line);
  const stored=(await h.db.query('select public.platform_module_credentials($1,$2) result',[t.id,'booking'])).rows[0].result;
  assert.equal(stored.scope,'tenant');assert.equal((await openCredentials(t.id,stored.envelope,key)).channelAccessToken,token);
  assert.equal(current.notifications.frontdesk.mode,'custom');
 }finally{await h.db.close();}
});
