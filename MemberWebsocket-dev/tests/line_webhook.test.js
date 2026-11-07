const test=require('node:test'),assert=require('node:assert/strict');
const {createHmac}=require('node:crypto');
const load=()=>import('../supabase/functions/_shared/line-webhook.mjs');
const secret='a'.repeat(32),destination='U'+'a'.repeat(32),key=Buffer.alloc(32,7).toString('base64');
const event=(id='01JTESTEVENT')=>({webhookEventId:id,type:'message',timestamp:1793000000000,deliveryContext:{isRedelivery:false},message:{type:'text',text:'秘密內容'},replyToken:'do-not-store'});
async function fixture(options={}){
 const {sealCredentials}=await import('../supabase/functions/_shared/platform-crypto.mjs');
 const calls=[],candidate={tenantId:'10000000-0000-4000-8000-000000000001',channelId:'2010123456',feature:'booking',scope:'module',revision:'revision',envelope:await sealCredentials('10000000-0000-4000-8000-000000000001:booking',{channelSecret:secret},key)};
 const db={rpc:async(name,params)=>{calls.push({name,params});const result=await (options.rpc?options.rpc(name,params,candidate):{data:name==='platform_line_webhook_candidate'?candidate:{accepted:params.p_events.length},error:null});return name==='platform_line_webhook_candidate'&&result.data?{...result,data:Array.isArray(result.data)?result.data:[result.data]}:result;}};
 const handler=(await load()).createLineWebhookHandler({db,encryptionKey:()=>key,bodyTimeoutMs:options.bodyTimeoutMs||100,rpcTimeoutMs:options.rpcTimeoutMs||100});
 const send=(body=JSON.stringify({destination,events:[event()]}),signature=createHmac('sha256',secret).update(body).digest('base64'),extra={})=>handler(new Request('https://backend.test/functions/v1/line-webhook',{method:'POST',body,headers:{'content-type':'application/json','x-line-signature':signature,...extra}}));
 return{handler,send,calls,candidate};
}
test('#144 original UTF-8 bytes authenticate, event storage is allowlisted and ACK follows storage',async()=>{
 const h=await fixture(),raw=' { "destination": "'+destination+'", "events": '+JSON.stringify([event()])+' }\n';
 assert.equal((await h.send(raw)).status,200);assert.equal(h.calls.length,2);
 const receipt=h.calls[1].params.p_events[0];assert.deepEqual(Object.keys(receipt).sort(),['eventId','redelivery','timestamp','type']);
 assert.ok(!JSON.stringify(h.calls).includes('秘密內容'));assert.ok(!JSON.stringify(h.calls).includes('do-not-store'));
 assert.equal((await h.send(raw+' ',createHmac('sha256',secret).update(raw).digest('base64'))).status,401);
 assert.equal(h.calls.filter(c=>c.name==='platform_line_webhook_ingest').length,1);
});
test('#144 empty provider verification is persisted before ACK; failed storage and missing candidate fail closed',async()=>{
 for(const events of [[],[event()]]){
  const h=await fixture({rpc:(name,_p,c)=>name.endsWith('candidate')?{data:c}:{error:Error('storage-secret-do-not-leak')}});
  const r=await h.send(JSON.stringify({destination,events}));assert.equal(r.status,503);assert.ok(!(await r.text()).includes('storage-secret'));
 }
 const h=await fixture({rpc:()=>({data:null})});assert.equal((await h.send()).status,401);assert.equal(h.calls.length,1);
});
test('#144 missing/malformed signatures, invalid JSON, method and oversized payload are bounded without database access',async()=>{
 const h=await fixture();
 for(const sig of ['', 'bad','A'.repeat(44),'a'.repeat(43)+'=, '+ 'b'.repeat(43)+'='])assert.equal((await h.send('{}',sig)).status,401);
 assert.equal((await h.send('{')).status,400);
 assert.equal((await h.send('x'.repeat(262145))).status,413);
 assert.equal((await h.handler(new Request('https://backend.test',{method:'GET'}))).status,405);
 assert.equal(h.calls.length,0);
});
test('#144 event IDs, batch limits and unknown types are deterministic; unknown types never dispatch',async()=>{
 const h=await fixture();
 for(const events of [[{type:'message'}],Array.from({length:101},(_,i)=>event('id'+i)),[{...event(),timestamp:-1}]])assert.equal((await h.send(JSON.stringify({destination,events}))).status,400);
 const r=await h.send(JSON.stringify({destination,events:[{...event(),type:'future-event'}]}));assert.equal(r.status,200);
 assert.equal(h.calls.at(-1).params.p_events[0].type,'other');
});
test('#144 hangs, storage stale revision and rate limits never ACK success',async()=>{
 const h=await fixture({rpc:(name,_p,c)=>name.endsWith('candidate')?{data:c}:new Promise(()=>{}),rpcTimeoutMs:15});assert.equal((await h.send()).status,503);
 for(const code of ['LINE_WEBHOOK_STALE','LINE_WEBHOOK_RATE_LIMIT']){
  const f=await fixture({rpc:(name,_p,c)=>name.endsWith('candidate')?{data:c}:{error:{message:code}}});assert.equal((await f.send()).status,code.endsWith('RATE_LIMIT')?429:503);
 }
 const f=await fixture({bodyTimeoutMs:15});
 const stream=new ReadableStream({start(){},cancel(){}});
 const r=await f.handler(new Request('https://backend.test',{method:'POST',headers:{'x-line-signature':createHmac('sha256',secret).update('{}').digest('base64')},body:stream,duplex:'half'}));assert.equal(r.status,408);assert.equal(f.calls.length,0);
});

test('#158 signed user identity is retained only for follow/unfollow, without raw payload or tokens',async()=>{
 const userId='U'+'b'.repeat(32),h=await fixture();
 const events=[
  {...event('follow'),type:'follow',source:{type:'user',userId}},
  {...event('unfollow'),type:'unfollow',source:{type:'user',userId}},
  {...event('message'),source:{type:'user',userId}},
  {...event('group'),type:'follow',source:{type:'group',userId,groupId:'private-group'}},
  {...event('invalid'),type:'follow',source:{type:'user',userId:'invalid'}},
  {...event('missing'),type:'follow'},
 ];
 assert.equal((await h.send(JSON.stringify({destination,events}))).status,200);
 const receipts=h.calls.at(-1).params.p_events;
 assert.equal(receipts[0].sourceUserId,userId);assert.equal(receipts[1].sourceUserId,userId);
 for(const receipt of receipts.slice(2))assert.equal(Object.hasOwn(receipt,'sourceUserId'),false);
 for(const term of ['replyToken','秘密內容','private-group'])assert.ok(!JSON.stringify(receipts).includes(term));
 const tampered=JSON.stringify({destination,events:[{...events[0],source:{type:'user',userId:'U'+'c'.repeat(32)}}]});
 assert.equal((await h.send(tampered,createHmac('sha256',secret).update(JSON.stringify({destination,events})).digest('base64'))).status,401);
});
test('#158 shared-channel membership is selected only after its own current credential verifies',async()=>{
 const {sealCredentials}=await import('../supabase/functions/_shared/platform-crypto.mjs');
 for(const valid of [true,false]){
  const h=await fixture({rpc:async(name,p,c)=>{
   if(name.endsWith('candidate'))return {data:[c,{...c,feature:'membership',envelope:await sealCredentials(c.tenantId+':membership',{channelSecret:valid?secret:'other-secret'},key)}]};
   return {data:{accepted:p.p_events.length}};
  }});
  assert.equal((await h.send(JSON.stringify({destination,events:[{...event(),type:'follow',source:{type:'user',userId:'U'+'b'.repeat(32)}}]}))).status,200);
  assert.equal(h.calls.at(-1).params.p_feature,valid?'membership':'booking');
 }
});
