const test=require('node:test'),assert=require('node:assert/strict');
const {setup,owner,other,root,features}=require('./fixtures/merchant-http.cjs');
const fields={adminChannelId:'2010791619',memberChannelId:'2010787602',messagingChannelId:'2010123456',adminLiffId:'2010791619-admin',memberLiffId:'',pointsLiffId:'2010787602-points',eventLiffId:'',calendarLiffId:'',bookingLiffId:'2010787602-booking'};
async function merchants(){const h=await setup();try{await h.qualify();h.a=await h.review(await h.submit(owner,'merchant-a','A'),'approved',features(['points','booking']));h.b=await h.review(await h.submit(owner,'merchant-b','B'),'approved',features(['booking']));return h;}catch(e){await h.db.close();throw e;}}

test('AC-MMA-CTX-HTTP-001: selected bootstrap resolves same owner A and B exactly; foreign actor is rejected',async()=>{
 const h=await merchants();try{
  for(const a of [h.a,h.b]){const r=await h.platformCall({action:'platform.application.bootstrap',business:a.slug});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.data.application.id,a.id);assert.equal(r.body.data.tenant.id,a.tenant.id);}
  await h.qualify(other);const foreign=await h.platformCall({action:'platform.application.bootstrap',business:h.a.slug},'other');assert.equal(foreign.status,404);
  const missing=await h.platformCall({action:'platform.application.bootstrap'});assert.equal(missing.status,409);assert.equal(missing.body.error.code,'PLATFORM_BUSINESS_SELECTION_REQUIRED');
 }finally{await h.db.close();}
});

test('AC-MMA-CTX-HTTP-002: shared LINE save and notification save target selected tenant and replay cannot switch shops',async()=>{
 const h=await merchants();try{
  const requestId=crypto.randomUUID(),body={action:'platform.line.save',business:h.a.slug,expectedVersion:h.a.tenant.version,requestId,line:fields,credentials:{channelAccessToken:'synthetic-token-1234567890',channelSecret:'a'.repeat(32)}};
  const r=await h.platformCall(body);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.data.tenant.id,h.a.tenant.id);
  assert.equal((await h.get(h.b.id)).tenant.credentials_configured,false);
  const cross=await h.platformCall({...body,business:h.b.slug,line:{...fields,pointsLiffId:''},expectedVersion:h.b.tenant.version});
  assert.equal(cross.status,409,JSON.stringify(cross.body));assert.equal(cross.body.error.code,'PLATFORM_REQUEST_CONFLICT');
  const notify=await h.platformCall({action:'platform.notifications.save',business:h.a.slug,feature:'points',purpose:'member',mode:'disabled',expectedVersion:r.body.data.tenant.version,requestId:crypto.randomUUID()});
  assert.equal(notify.status,200,JSON.stringify(notify.body));assert.equal(notify.body.data.tenant.id,h.a.tenant.id);
  const replay=await h.platformCall(body);assert.equal(replay.status,200);assert.equal(replay.body.data.tenant.version,notify.body.data.tenant.version);
 }finally{await h.db.close();}
});

test('AC-MMA-CTX-HTTP-003: selected bootstrap and write reject suspended qualification and pre-resume verified token',async()=>{
 const h=await merchants();try{
  let q=await h.call('platform_my_admin_qualification',[owner]);q=await h.call('platform_review_admin_qualification',[root,q.id,q.version,'suspended','Stop',crypto.randomUUID()]);
  const body={action:'platform.application.bootstrap',business:h.a.slug};const suspended=await h.platformCall(body);assert.equal(suspended.status,403);assert.equal(suspended.body.error.code,'PLATFORM_QUALIFICATION_REQUIRED');
  await h.call('platform_review_admin_qualification',[root,q.id,q.version,'approved','',crypto.randomUUID()]);
  h.issuedAtMs=()=>Date.now()-60000;const old=await h.platformCall(body);assert.equal(old.status,401);assert.equal(old.body.error.code,'TENANT_REAUTH_REQUIRED');
  h.issuedAtMs=()=>Date.now()+1000;assert.equal((await h.platformCall(body)).status,200);
 }finally{await h.db.close();}
});
