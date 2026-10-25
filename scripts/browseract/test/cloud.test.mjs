import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorHandler, tokenMatches } from '../monitor/functions/browseract-monitor.mjs';
import { createBrowserActClient } from '../core.mjs';
const site='https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/';
const origin='https://memberwebsocket-browseract-monitor.netlify.app';
const secret='long-and-random-credential-that-cannot-be-guessed';
const paused={id:'task_123',status:'paused',steps:[],live_url_info:{live_url:'https://browseract.com/live'}};
function fixture(envOver={},task=paused) {
 const env={BROWSERACT_MONITOR_ACCESS_TOKEN:secret,BROWSERACT_API_KEY:'fake',BROWSERACT_WORKFLOW_ID:'wf',BROWSERACT_BASE_URL:site,BROWSERACT_ALLOWED_ORIGINS:new URL(site).origin,BROWSERACT_HUMAN_HANDOFF_ENABLED:'true',...envOver};
 const calls=[];
 const handler=createMonitorHandler({env:k=>env[k],clientFactory:()=>({
  start:async x=>{calls.push(['start',x]);return{id:'task_123'};},
  get:async()=>task,stop:async()=>{calls.push(['stop']);},resume:async()=>{calls.push(['resume']);}
 })});
 const req=(action,{method='GET',token=secret,body,id='task_123',wrongOrigin=false}={})=>{
  const u=new URL('/.netlify/functions/browseract-monitor',origin);u.searchParams.set('action',action);u.searchParams.set('id',id);
  return handler(new Request(u,{method,headers:{Authorization:'Bearer '+token,...(method==='POST'?{Origin:wrongOrigin?'https://evil.invalid':origin}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}));
 };
 return{req,calls};
}
test('AC-MON-001 auth gates live browser and refuses missing credentials',async()=>{
 assert.equal(tokenMatches(secret,secret),true);assert.equal(tokenMatches('wrong',secret),false);
 const f=fixture();
 assert.equal((await f.req('config',{token:'wrong'})).status,401);
 assert.equal((await f.req('task',{token:'wrong'})).status,401);
 assert.equal((await fixture({BROWSERACT_MONITOR_ACCESS_TOKEN:''}).req('config')).status,503);
 const cfg=await(await f.req('config')).json();
 assert.equal(cfg.configured,true);assert.doesNotMatch(JSON.stringify(cfg),/fake|credential/);
});
test('AC-MON-002 handoff/return checks state and Human Interaction feature gate',async()=>{
 const f=fixture();
 assert.equal((await f.req('start',{method:'POST',body:{baseUrl:site,scenarioId:'AC-001',handoffMode:'human'}})).status,201);
 assert.equal(f.calls[0][1].handoffMode,'human');
 assert.equal((await(await f.req('task')).json()).liveUrl,'https://browseract.com/live');
 assert.equal((await f.req('resume',{method:'POST'})).status,200);
 const off=fixture({BROWSERACT_HUMAN_HANDOFF_ENABLED:'false'});
 assert.equal((await off.req('start',{method:'POST',body:{baseUrl:site,scenarioId:'AC-001',handoffMode:'human'}})).status,409);
 assert.equal((await fixture({}, {...paused,status:'running'}).req('resume',{method:'POST'})).status,409);
});
test('AC-MON-003 cross-origin and unapproved target blocked',async()=>{
 const f=fixture();
 assert.equal((await f.req('start',{method:'POST',wrongOrigin:true,body:{baseUrl:site,scenarioId:'AC-001'}})).status,403);
 assert.equal((await f.req('start',{method:'POST',body:{baseUrl:'https://evil.invalid',scenarioId:'AC-001'}})).status,400);
 assert.equal((await f.req('task',{id:'bad!'})).status,400);
 assert.equal((await fixture({}, {...paused,status:'finished'}).req('stop',{method:'POST'})).status,409);
});
test('AC-MON-004 BrowserAct workflow has optional manual handoff param',async()=>{
 const bodies=[];
 const c=createBrowserActClient({apiKey:'synthetic',fetchImpl:async(_,opt)=>{
  bodies.push(JSON.parse(opt.body));
  return{ok:true,status:200,text:async()=>JSON.stringify({id:'task_123'})};
 }});
 await c.start({workflowId:'wf',baseUrl:site,scenarioId:'AC-001'});
 await c.start({workflowId:'wf',baseUrl:site,scenarioId:'AC-001',handoffMode:'human'});
 assert.equal(bodies[0].input_parameters.length,2);
 assert.deepEqual(bodies[1].input_parameters.at(-1),{name:'handoff_mode',value:'human'});
});