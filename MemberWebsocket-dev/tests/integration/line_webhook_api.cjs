const test=require('node:test'),assert=require('node:assert/strict');
const {setup}=require('./fixtures/line-webhook-http.cjs');
const owner='U'+'2'.repeat(32);
const {destination}=require('./fixtures/line-webhook-cases.cjs');
test('#144 diagnostics: read status is local, explicit check binds verified bot without sending and never returns credentials',async()=>{
 const h=await setup();try{
  const status=await h.request('platform.webhook.status');assert.equal(status.status,200,JSON.stringify(status));assert.equal(status.body.data.apiState,'pending');assert.equal(h.provider.length,0);
  const checked=await h.request('platform.webhook.check');assert.equal(checked.status,200,JSON.stringify(checked));assert.equal(checked.body.data.apiState,'accepted');assert.equal(checked.body.data.humanState,'pending');assert.equal(checked.body.data.ingressState,'pending');
  assert.equal(checked.body.data.endpoint,'https://fixture.supabase.co/functions/v1/line-webhook');assert.equal(h.provider.length,2);
  for(const forbidden of ['envelope','revision','synthetic-webhook-api-token','channelSecret',destination])assert.ok(!JSON.stringify(checked).includes(forbidden));
 }finally{await h.db.close();}
});
test('#144 diagnostics reject foreign/disabled/revoked merchants and audit denial without exposing foreign identifiers',async()=>{
 const h=await setup();try{
  const foreign=await h.approve('U'+'3'.repeat(32),'webhook-foreign');
  const denied=await h.request('platform.webhook.check',{business:foreign.slug});assert.equal(denied.status,403,JSON.stringify(denied));assert.equal(h.provider.length,0);
  await h.db.query("update platform_private.tenants set features=jsonb_set(features,'{booking}','false') where id=$1",[h.tenant.id]);
  assert.equal((await h.request('platform.webhook.status')).status,403);
  const audit=(await h.db.query("select detail from platform_private.audit_events where action='LINE_WEBHOOK_ACCESS_DENIED'")).rows;assert.equal(audit.length,2);assert.deepEqual(audit[0].detail,{result:'denied'});
  await h.db.query("update platform_private.admin_qualifications set status='suspended' where applicant_line_user_id=$1",[owner]);assert.equal((await h.request('platform.webhook.check')).status,403);
 }finally{await h.db.close();}
});
test('#144 diagnostics keep Provider failures distinct from accepted delivery and LIFF-only optional',async()=>{
 const h=await setup();try{
  h.offline=true;const down=await h.request('platform.webhook.check');assert.equal(down.status,503);assert.ok(!JSON.stringify(down).includes('synthetic-provider'));
  h.offline=false;h.wrongChannel=true;assert.equal((await h.request('platform.webhook.check')).status,400);assert.equal((await h.request('platform.webhook.status')).body.data.apiState,'pending');
  const optional=await h.request('platform.webhook.status',{feature:'points'});assert.equal(optional.status,200);assert.equal(optional.body.data.configurationState,'optional');
  assert.equal((await h.request('platform.webhook.check',{feature:'points'})).body.error.code,'WEBHOOK_NOT_CONFIGURED');
 }finally{await h.db.close();}
});
test('#144 real receiver commits signed events exactly once; forged destination/signature never creates receipts or touches members',async()=>{
 const h=await setup();try{
  const {createLineWebhookHandler}=await import('../../supabase/functions/_shared/line-webhook.mjs');
  const {createHmac}=require('node:crypto');
  assert.equal((await h.request('platform.webhook.check')).status,200);
  const handler=createLineWebhookHandler({db:{rpc:h.rpc},encryptionKey:()=>require('./platform-fixture.cjs').key});
  const body=JSON.stringify({destination,events:[{webhookEventId:'evt-integration',type:'follow',timestamp:1793000000000,source:{userId:owner}}]});
  const send=(signature)=>handler(new Request('https://backend.test/functions/v1/line-webhook',{method:'POST',body,headers:{'x-line-signature':signature}}));
  const before=(await h.db.query('select count(*)::int n from public.members')).rows[0].n;
  assert.equal((await send(require('node:crypto').createHmac('sha256','wrong').update(body).digest('base64'))).status,401);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.line_webhook_receipts')).rows[0].n,0);
  const signature=createHmac('sha256','a'.repeat(32)).update(body).digest('base64');
  const responses=await Promise.all([send(signature),send(signature)]);assert.deepEqual(responses.map(r=>r.status),[200,200]);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.line_webhook_receipts')).rows[0].n,1);
  assert.equal((await h.db.query('select count(*)::int n from public.members')).rows[0].n,before);
  assert.equal((await h.request('platform.webhook.status')).body.data.ingressState,'verified');
  assert.equal(h.provider.length,2,'only the explicit read-only check contacts LINE');
 }finally{await h.db.close();}
});
