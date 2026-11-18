const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),fixture=require('./business-platform-fixture.cjs');
test('changing OA between profile verification and staff insertion invalidates the prior proof',async()=>{
 const h=await fixture();try{
  const owner='U'+'2'.repeat(32),staff='U'+'4'.repeat(32),t=await h.approve(owner,'desk-race');
  for(const name of ['20261026050904_line_webhook.sql','20261118122150_frontdesk_booking_access.sql'])await h.db.exec(fs.readFileSync(path.resolve(__dirname,'../../supabase/migrations',name),'utf8'));
  const save=async(channel,version)=>(await h.db.query('select public.platform_frontdesk_admin($1,$2,$3,$4,$5) result',[owner,t.id,new Date().toISOString(),'settings.save',{requestId:crypto.randomUUID(),payloadHash:'a'.repeat(64),expectedVersion:version,loginChannelId:'2010999999',liffId:'2010999999-desk',messagingChannelId:channel,oaId:'@desk',enabled:true,envelope:{version:1,iv:'a'.repeat(16),data:'b'.repeat(48)}}])).rows[0].result;
  const verified=await save('2010888888',1);await save('2010777777',2);
  await assert.rejects(h.db.query('select public.platform_frontdesk_request($1,$2,$3,$4,$5,$6)',[t.id,staff,'2010999999',new Date().toISOString(),'apply',{displayName:'Desk',oaVerified:true,verifiedMessagingChannelId:'2010888888',verifiedConfigRevision:verified.frontdesk.revision}]),/FRONTDESK_OA_STALE/);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.frontdesk_staff')).rows[0].n,0);
 }finally{await h.db.close();}
});
