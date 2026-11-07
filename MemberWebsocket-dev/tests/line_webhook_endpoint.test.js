const test=require('node:test'),assert=require('node:assert/strict');
const load=()=>import('../supabase/functions/_shared/line-webhook-diagnostics.mjs');
test('#144 Webhook receiver uses the public HTTPS project origin and full function path',async()=>{
 const {lineWebhookEndpoint}=await load();
 for(const base of ['https://fixture.supabase.co','https://fixture.supabase.co/'])assert.equal(lineWebhookEndpoint(base),'https://fixture.supabase.co/functions/v1/line-webhook');
 assert.equal(lineWebhookEndpoint('https://custom.example:8443'),'https://custom.example:8443/functions/v1/line-webhook');
});
test('#144 missing or unsafe public project origins fail with a safe error',async()=>{
 const {lineWebhookEndpoint}=await load();
 for(const base of [undefined,null,'','http://fixture.supabase.co','https://user:secret@example.test','https://fixture.supabase.co/functions/v1','https://fixture.supabase.co?token=secret','https://fixture.supabase.co/#secret']){
  assert.throws(()=>lineWebhookEndpoint(base),e=>e.status===503&&e.code==='WEBHOOK_ENDPOINT_UNAVAILABLE'&&!e.message.includes('secret'));
 }
});
