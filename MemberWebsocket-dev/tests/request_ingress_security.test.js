const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const {pathToFileURL}=require('node:url');
const shared=path.resolve(__dirname,'../supabase/functions/_shared');
const flush=()=>new Promise(resolve=>setImmediate(resolve));

async function ingress(kind){
  let calls=0,received;
  const unexpected=()=>{calls++;throw Error('Unexpected identity/database access');};
  if(kind==='platform'){
    const {createPlatformHandler}=await import(pathToFileURL(path.join(shared,'platform-handler.mjs')));
    return {handler:createPlatformHandler({db:{rpc:unexpected},verifyIdentity:unexpected,allowedOrigins:new Set(['https://allowed.test'])}),calls:()=>calls};
  }
  // Evaluate the real adapter. Only its external provider/database dependencies
  // are excluded; parsing, streaming, routing and Request replay remain real.
  const ingressModule=fs.existsSync(path.join(shared,'request-ingress.mjs'))?await import(pathToFileURL(path.join(shared,'request-ingress.mjs'))):{};
  const context=vm.createContext({Request,Response,Headers,URL,TextDecoder,Uint8Array,AbortSignal,console,
    setTimeout:(...args)=>setTimeout(...args),clearTimeout:(...args)=>clearTimeout(...args),
    rawEnv:name=>name==='ALLOWED_ORIGINS'?'https://allowed.test':'',baseClient:unexpected,scope:{getStore:()=>undefined},
    readRequestBytes:ingressModule.readRequestBytes,
  });
  const code=fs.readFileSync(path.join(shared,'business-runtime.ts'),'utf8').replace(/^import[^;]+;\n/gm,'').replace(/^export type[^;]+;\n/gm,'').replace(/^export \{[^;]+;\n/gm,'').replace(/^export /gm,'');
  vm.runInContext(stripTypeScriptTypes(code),context);
  const handler=context.businessHandler('api',async request=>{
    calls++;received={body:await request.text(),origin:request.headers.get('origin'),url:request.url};
    return new Response(received.body,{status:200});
  });
  return {handler,calls:()=>calls,received:()=>received};
}

function streamed(){
  let controller,cancelled=false;
  const body=new ReadableStream({start(c){controller=c;},cancel(){cancelled=true;}});
  const request=new Request('https://backend.test/api',{method:'POST',headers:{Origin:'https://allowed.test'},body,duplex:'half'});
  return {request,push:text=>controller.enqueue(new TextEncoder().encode(text)),close:()=>{try{controller.close();}catch{}},cancelled:()=>cancelled};
}

for(const kind of ['platform','business']){
  for(const trickle of [false,true])test(`${kind}: ${trickle?'slow trickle':'stalled body'} ends at absolute deadline before authentication`,async t=>{
    const edge=await ingress(kind),s=streamed();
    t.mock.timers.enable({apis:['setTimeout']});
    let result,error;
    const running=edge.handler(s.request).then(r=>{result=r;},e=>{error=e;});
    try{
      await flush();
      if(trickle){s.push('{');await flush();t.mock.timers.tick(6000);s.push(' ');await flush();}
      t.mock.timers.tick(trickle?4001:10001);await flush();
      assert.equal(error,undefined);
      assert.equal(result?.status,408,'body must terminate independently of client completion');
      assert.equal(edge.calls(),0);
      assert.equal(result.headers.get('Access-Control-Allow-Origin'),'https://allowed.test');
      assert.equal(s.cancelled(),true);
    }finally{s.close();await running;}
  });
  test(`${kind}: oversized stream returns 413 even when cancellation never resolves`,async()=>{
    const edge=await ingress(kind),limit=kind==='platform'?32000:8000000;
    let cancelled=false,result;
    const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(limit+1));},cancel(){cancelled=true;return new Promise(()=>{});}});
    const request=new Request('https://backend.test/api',{method:'POST',headers:{Origin:'https://allowed.test','Content-Length':'1'},body,duplex:'half'});
    void edge.handler(request).then(r=>{result=r;});
    await flush();await flush();
    assert.equal(result?.status,413,'rejection must not wait for untrusted cancellation');
    assert.equal(edge.calls(),0);assert.equal(cancelled,true);
  });
  test(`${kind}: oversized declared length rejects without pulling the body`,async()=>{
    const edge=await ingress(kind),limit=kind==='platform'?32000:8000000;
    let cancelled=false;
    const body=new ReadableStream({cancel(){cancelled=true;return new Promise(()=>{});}});
    const response=await edge.handler(new Request('https://backend.test/api',{method:'POST',headers:{Origin:'https://allowed.test','Content-Length':String(limit+1)},body,duplex:'half'}));
    assert.equal(response.status,413);assert.equal(edge.calls(),0);assert.equal(cancelled,true);
  });
}

test('business: replay preserves complete bytes, origin and URL for the existing handler',async()=>{
  const edge=await ingress('business');
  const body=' {"name":"會員","action":"unknown"} ';
  const result=await edge.handler(new Request('https://backend.test/api',{method:'POST',headers:{Origin:'https://allowed.test'},body}));
  assert.equal(result.status,200);assert.equal(await result.text(),body);
  assert.deepEqual(edge.received(),{body,origin:'https://allowed.test',url:'https://backend.test/api'});
});

test('business: malformed JSON is replayed to the existing endpoint validator',async()=>{
  const edge=await ingress('business');
  assert.equal(await(await edge.handler(new Request('https://backend.test/api',{method:'POST',body:'{'}))).text(),'{');
});

test('platform: complete JSON exactly at limit keeps existing authentication rejection',async()=>{
  const edge=await ingress('platform');
  const body=JSON.stringify({padding:'x'.repeat(31986)});
  assert.equal(new TextEncoder().encode(body).length,32000);
  const response=await edge.handler(new Request('https://backend.test/api',{method:'POST',body}));
  assert.equal(response.status,401);assert.equal((await response.json()).error.code,'AUTH_REQUIRED');assert.equal(edge.calls(),0);
});
