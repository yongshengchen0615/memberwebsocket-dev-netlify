const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const fixture=require('../business-platform-fixture.cjs'),{key}=require('../platform-fixture.cjs');
const {destination,line}=require('./line-webhook-cases.cjs');
const owner='U'+'2'.repeat(32);
async function setup({publicSupabaseUrl='https://fixture.supabase.co'}={}){
 const h=await fixture(),dir=path.resolve(__dirname,'../../../supabase/migrations');
 for(const suffix of ['_line_webhook.sql','_member_oa_webhook_state.sql'])await h.db.exec(fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith(suffix))),'utf8'));
 h.tenant=await h.approve(owner,'webhook-api');
 const saved=await h.call({action:'platform.line.save',business:h.tenant.slug,feature:'booking',line,credentials:{channelAccessToken:'synthetic-webhook-api-token-123456789',channelSecret:'a'.repeat(32)},expectedVersion:1,requestId:crypto.randomUUID()},'manager');assert.equal(saved.status,200,JSON.stringify(saved));
 const {createPlatformHandler}=await import('../../../supabase/functions/_shared/platform-handler.mjs');h.provider=[];
 h.handler=createPlatformHandler({db:{rpc:h.rpc},allowedOrigins:h.allowedOrigins,encryptionKey:()=>key,publicSupabaseUrl,
  verifyIdentity:()=>assert.fail('must use applicant verifier'),verifyApplicantIdentity:async()=>({lineUserId:owner,issuedAtMs:Date.now()}),fetchImpl:async(url,opts)=>{
   h.provider.push(url);if(h.offline)throw Error('synthetic-provider-token-secret');
   assert.ok(!url.includes('message/'));assert.equal(opts.method||'GET',url.endsWith('verify')?'POST':'GET');
   return new Response(JSON.stringify(url.endsWith('verify')?{client_id:h.wrongChannel?'9999999999':'2010123456',expires_in:3600}:{userId:destination}));
  }});
 h.request=async(action,extra={},transport={})=>{const res=await h.handler(new Request(transport.url||'https://fixture.supabase.co/functions/v1/platform-api',{method:'POST',headers:{Origin:'https://allowed.test',...transport.headers},body:JSON.stringify({idToken:'verified',business:h.tenant.slug,feature:'booking',action,...extra})}));return {status:res.status,body:await res.json()};};
 return h;
}
module.exports={setup};
