const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const {pathToFileURL}=require('node:url');
const shared=path.resolve(__dirname,'../supabase/functions/_shared');
const read=name=>fs.readFileSync(path.join(shared,name),'utf8');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function verifier(response){
  const {isVerifiedLineIdClaim}=await import(pathToFileURL(path.join(shared,'line-id-claims.mjs')));
  let downstream=0;
  const context=vm.createContext({Response,URLSearchParams,AbortSignal,
    fetch:async()=>response,isVerifiedLineIdClaim,
    businessContext:()=>undefined,assertTenantIdentity:()=>{downstream++;throw Error('unexpected downstream authorization');},
  });
  const source=read('auth-contract.ts').split('export async function requireActiveAdminContract')[0]
    .replace(/^import[^;]+;\n/gm,'').replace(/^export /gm,'');
  vm.runInContext(stripTypeScriptTypes(source),context);
  return {run:()=>context.verifyLineIdTokenContract({idToken:'synthetic-token',expectedChannelId:'2010791619',
    createError:(status,code,message)=>Object.assign(Error(message),{status,code})}),downstream:()=>downstream};
}

for(const status of [429,500,502,503])test(`AC-001: LINE ${status} stays a temporary service failure and never reaches authorization`,async()=>{
  const now=Math.floor(Date.now()/1000);
  // Even a provider error with plausible claims cannot authenticate the caller.
  const edge=await verifier(Response.json({sub:'U'+'a'.repeat(32),aud:'2010791619',iss:'https://access.line.me',iat:now-5,exp:now+300},{status}));
  await assert.rejects(edge.run(),{status:503,code:'LINE_AUTH_UNAVAILABLE'});
  assert.equal(edge.downstream(),0);
});
for(const status of [400,401,403])test(`AC-001: actual invalid LINE token (${status}) remains denied`,async()=>{
  const edge=await verifier(Response.json({error:'invalid token'},{status}));
  await assert.rejects(edge.run(),{status:401,code:'AUTH_INVALID'});
  assert.equal(edge.downstream(),0);
});

async function mainApi(){
  let queries=0;const logs=[];
  const {readRequestBytes}=await import(pathToFileURL(path.join(shared,'request-ingress.mjs')));
  const {readJsonObject}=await import(pathToFileURL(path.join(shared,'request-body.ts')));
  const context=vm.createContext({Request,Response,Headers,URL,URLSearchParams,TextDecoder,TextEncoder,Uint8Array,AbortSignal,
    crypto,console:{error:value=>logs.push(value)},setTimeout,clearTimeout,
    readRequestBytes,readJsonObject,
    rawEnv:name=>name==='ALLOWED_ORIGINS'?'https://allowed.test':'',
    businessEnv:name=>name==='ALLOWED_ORIGINS'?'https://allowed.test':'',
    baseClient:()=>{queries++;throw Error('unexpected privileged query');},scope:{getStore:()=>undefined},
  });
  if(fs.existsSync(path.join(shared,'server-errors.mjs'))){
    const {serverFailureTrace}=await import(pathToFileURL(path.join(shared,'server-errors.mjs')));
    context.serverFailureTrace=(...args)=>serverFailureTrace(...args,{log:value=>logs.push(value)});
  }
  const runtime=read('business-runtime.ts').replace(/^import[^;]+;\n/gm,'').replace(/^export type[^;]+;\n/gm,'')
    .replace(/^export \{[^;]+;\n/gm,'').replace(/^export /gm,'');
  vm.runInContext(stripTypeScriptTypes(runtime),context);
  const api=fs.readFileSync(path.join(shared,'../api/index.ts'),'utf8').replace(/^import[^;]+;\n/gm,'')
    .replace('export default','globalThis.deployedEndpoint =');
  vm.runInContext(stripTypeScriptTypes(api),context);
  return {run:request=>context.deployedEndpoint.fetch(request),queries:()=>queries,logs,context};
}
const request=(body,headers={Origin:'https://allowed.test'})=>new Request('https://backend.test/api',{method:'POST',body,headers});

test('AC-002: forbidden origin is rejected before tenant resolution, without consuming a stalled body',async()=>{
  const edge=await mainApi();let cancelled=false;
  const body=new ReadableStream({cancel(){cancelled=true;}});
  const response=await edge.run(new Request('https://backend.test/api',{method:'POST',duplex:'half',body,headers:{Origin:'https://forbidden.test'}}));
  assert.equal(response.status,403);assert.equal((await response.json()).error.code,'ORIGIN_NOT_ALLOWED');
  assert.equal(edge.queries(),0);assert.equal(cancelled,true);
});
for(const length of [undefined,'1','40001'])test(`AC-002: oversized main API body (${length||'no declared length'}) never starts tenant work`,async()=>{
  const edge=await mainApi();const headers={Origin:'https://allowed.test'};if(length)headers['Content-Length']=length;
  const body=JSON.stringify({business:'merchant-a',action:'user.member.bootstrap',padding:'x'.repeat(40000)});
  const response=await edge.run(request(body,headers));
  assert.equal(response.status,413);assert.equal(edge.queries(),0);
});
test('AC-002: exact 40000-byte body and absent Origin retain endpoint validation',async()=>{
  for(const headers of [{Origin:'https://allowed.test'},{}]){
    const edge=await mainApi();const body=JSON.stringify({padding:'x'.repeat(39986)});
    assert.equal(Buffer.byteLength(body),40000);
    const response=await edge.run(request(body,headers));
    assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_ACTION');assert.equal(edge.queries(),0);
  }
});
test('AC-002: valid-shaped in-limit tenant requests still reach existing routing and fail closed on DB outage',async()=>{
  const edge=await mainApi();const response=await edge.run(request(JSON.stringify({business:'merchant-a',action:'user.member.bootstrap',idToken:'synthetic-token'})));
  assert.equal(response.status,503);assert.equal(edge.queries(),1);assert.equal((await response.json()).ok,false);
});

test('AC-003: main API 5xx has a server trace with no raw failure or private details',async()=>{
  const edge=await mainApi();
  const failure=vm.runInContext('new ApiError(500,"DATABASE_ERROR","safe public message",{private:"secret-token and private member details"})',edge.context);
  const response=edge.context.errorResponse('https://allowed.test',failure);
  const payload=await response.json();
  assert.equal(response.status,500);assert.match(payload.error.requestId,uuid);
  assert.equal(response.headers.get('X-Request-Id'),payload.error.requestId);
  assert.equal(edge.logs.length,1);assert.doesNotMatch(JSON.stringify(edge.logs),/secret-token|private member details/);
});
test('AC-003: concurrent routing failures receive different server-generated IDs and no request content is logged',async()=>{
  const edge=await mainApi();const responses=await Promise.all([1,2].map(()=>edge.run(request(JSON.stringify({business:'merchant-a',idToken:'secret-token',action:'user.member.bootstrap',phone:'private-phone'}),{Origin:'https://allowed.test','X-Request-Id':'caller-controlled'}))));
  const ids=[];for(const response of responses){const payload=await response.json();assert.match(payload.error.requestId,uuid);assert.equal(response.headers.get('X-Request-Id'),payload.error.requestId);ids.push(payload.error.requestId);}
  assert.notEqual(ids[0],ids[1]);assert.equal(edge.logs.length,2);
  assert.doesNotMatch(JSON.stringify(edge.logs),/secret-token|private-phone|caller-controlled|unexpected privileged query/);
});

test('AC-003: trace metadata rejects unknown codes and logging failure preserves the response identity',async()=>{
  const {serverFailureTrace}=await import(pathToFileURL(path.join(shared,'server-errors.mjs')));
  const logs=[];const id=serverFailureTrace('private-service-name',503,'SECRET_TOKEN',{log:value=>logs.push(JSON.parse(value))});
  assert.match(id,uuid);assert.deepEqual(logs,[{event:'backend_request_failed',request_id:id,service:'business-router',status:503,code:'SERVER_ERROR'}]);
  assert.match(serverFailureTrace('api',500,'DATABASE_ERROR',{log:()=>{throw Error('logger unavailable');}}),uuid);
  assert.equal(serverFailureTrace('api',401,'AUTH_INVALID',{log:()=>assert.fail('4xx must not emit server failures')}),undefined);
});
