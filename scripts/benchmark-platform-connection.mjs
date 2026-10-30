import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
const root=path.resolve(import.meta.dirname,'..');
const require=createRequire(path.join(root,'MemberWebsocket-dev/tests/integration/package.json'));
const {JSDOM}=require('jsdom');
const baseline=process.argv[2],output=process.argv[3];
if(!baseline||!output)throw Error('Usage: node scripts/benchmark-platform-connection.mjs BASELINE_PLATFORM_APP OUTPUT.json');
const features={membership:'會員卡',points:'集點卡',events:'活動票券',calendar:'營運日曆',booking:'預約'};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
async function mount(source){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'MemberWebsocket-dev/platform/index.html'),'utf8'),{url:'https://fixture.test/platform/',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,intervals=[];let reads=0;
 w.AbortController=AbortController;w.AbortSignal=AbortSignal;w.structuredClone=structuredClone;
 w.setInterval=fn=>(intervals.push(fn),intervals.length);w.clearInterval=()=>{};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 w.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>'synthetic-root'};
 w.fetch=async(url,options)=>{
  if(String(url).includes('config.json'))return{ok:true,json:async()=>({merchantApprovalVersion:2,platformLiffId:'2012065297-root',supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'public-fixture'})};
  const input=JSON.parse(options.body);reads++;
  await new Promise(resolve=>setTimeout(resolve,40));
  return{ok:true,status:200,json:async()=>({ok:true,data:input.action==='platform.bootstrap'?{tenants:[],applications:[],features,profile:{displayName:'Root'}}:{qualifications:[]}})};
 };
 w.eval(fs.readFileSync(path.join(root,'MemberWebsocket-dev/member-system.js'),'utf8'));
 w.eval(source);
 async function idle(initial=false){
  const deadline=performance.now()+2000;
  while(initial?w.document.getElementById('platformWorkspace').hidden:w.document.getElementById('rootSyncNow').disabled){
   if(performance.now()>deadline)throw Error('Benchmark refresh did not settle: '+w.document.getElementById('platformStatus').textContent);
   await new Promise(resolve=>setTimeout(resolve,1));
  }
  await settle();
 }
 await idle(true);
 return{w,idle,intervals,get reads(){return reads;},close:()=>w.close()};
}
const base=await mount(fs.readFileSync(baseline,'utf8'));
const candidate=await mount(fs.readFileSync(path.join(root,'MemberWebsocket-dev/platform/app.js'),'utf8'));
const samples={baseline:[],candidate:[]},offline={};
try{
 for(let i=0;i<30;i++)for(const [name,h] of i%2?[['candidate',candidate],['baseline',base]]:[['baseline',base],['candidate',candidate]]){
  const started=performance.now();h.w.document.getElementById('rootSyncNow').click();await h.idle();samples[name].push(performance.now()-started);
 }
 for(const [name,h] of [['baseline',base],['candidate',candidate]]){
  Object.defineProperty(h.w.navigator,'onLine',{value:false,configurable:true});const before=h.reads;
  for(let i=0;i<12;i++){for(const tick of h.intervals)tick();await h.idle();}
  offline[name]=h.reads-before;
 }
 const summarize=values=>{const sorted=[...values].sort((a,b)=>a-b);return{count:values.length,p50Ms:sorted[14],p95Ms:sorted[28],samplesMs:values};};
 const report={baseSha:'3eaae7005b5952b3f55a001afef2731818d79438',candidate:'working tree; bind to PR tree',environment:{node:process.version,delayPerIndependentReadMs:40,samplesPerVersion:30,ordering:'alternating baseline/candidate',dataset:'empty lists, V2 root, same DOM and synthetic API'},refresh:{baseline:summarize(samples.baseline),candidate:summarize(samples.candidate)},offline:{pollTicks:12,requests:offline},limits:'Controlled HTTP stub in real JS + JSDOM, not production network latency or live traffic reduction.'};
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({refresh:report.refresh.baseline.p50Ms+' -> '+report.refresh.candidate.p50Ms,offline:report.offline}));
}finally{base.close();candidate.close();}
