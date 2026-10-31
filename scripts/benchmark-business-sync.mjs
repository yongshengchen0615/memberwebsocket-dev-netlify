// Compare the actual before/after browser runtime using the same virtual clock
// and authoritative synthetic changes. This measures scheduler latency only;
// it does not measure LINE, network, PostgreSQL or production p95 latency.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
const baselinePath=process.argv[2],reportPath=process.argv[3];
if(!baselinePath||!reportPath)throw Error('Usage: node scripts/benchmark-business-sync.mjs BEFORE.js REPORT.json');
const sources={before:fs.readFileSync(baselinePath,'utf8'),after:fs.readFileSync(new URL('../MemberWebsocket-dev/member-system.js',import.meta.url),'utf8')};
async function runtime(source,surface){
 let now=0,id=0,revision=0,fullReads=0,probes=0,statusReads=0,awaiting=null;
 const timers=new Map(),local=new Map(),latencies=[];
 const eventTarget=()=>({addEventListener(){},removeEventListener(){},dispatchEvent(){}});
 const document={...eventTarget(),visibilityState:'visible',querySelector:()=>({}),querySelectorAll:()=>[],title:'QA'};
 const window={...eventTarget(),crypto:webcrypto,
  setTimeout(fn,delay){const key=++id;timers.set(key,{fn,at:now+delay});return key;},clearTimeout:key=>timers.delete(key),
  setInterval(fn,delay){const key=++id;timers.set(key,{fn,at:now+delay,interval:delay});return key;},clearInterval:key=>timers.delete(key),
  localStorage:{getItem:k=>local.get(k),setItem:(k,v)=>local.set(k,v)},
  liff:{init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=> 'synthetic-token'}};
 const fetch=async(_url,options)=>{const body=JSON.parse(options.body);if(body.action.endsWith('.sync.status'))probes++;if(body.action.endsWith('.session.status'))statusReads++;
  return{status:200,text:async()=>JSON.stringify({ok:true,data:{state:'claimed',revision:String(revision)}})};};
 const config={business:'qa-shop',realtimeEnabled:true,supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic',memberLiffId:'member',pointsLiffId:'points',eventLiffId:'event',calendarLiffId:'calendar',bookingLiffId:'booking',adminLiffId:'admin'};
 const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
 vm.runInNewContext(source,{window,document,navigator:{onLine:true},fetch,URL,AbortController,Date:class extends Date{static now(){return now;}}});
 await window.MemberSystem.signIn(config,surface);
 const stop=window.MemberSystem.subscribeRealtime(config,surface,()=>{fullReads++;if(awaiting&&awaiting.revision===revision){latencies.push(now-awaiting.at);awaiting=null;}});
 return{stop,latencies,change(){assert.equal(awaiting,null,'previous change was lost');revision++;awaiting={revision,at:now};},stats:()=>({fullReads,revisionProbes:probes,sessionStatusReads:statusReads}),async advanceTo(end){assert.ok(end>=now);let iterations=0;while(true){
  const next=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;assert.ok(++iterations<10000,'runaway scheduler');now=next[1].at;timers.delete(next[0]);if(next[1].interval)timers.set(next[0],{...next[1],at:now+next[1].interval});next[1].fn();await flush();
 }now=end;await flush();}};
}
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const report={scope:'Controlled scheduler benchmark; actual before/after production JS, synthetic authority, virtual clock, zero network/DB/provider latency. Not production SLO evidence.',samplesPerScenario:120,scenarios:[]};
for(const surface of ['member','points','admin']){
 const row={surface};
 for(const [name,source]of Object.entries(sources)){
  const h=await runtime(source,surface);
  try{await h.advanceTo(30000);for(let i=0;i<120;i++){const at=45000+i*45000+(i*137%7000);await h.advanceTo(at);h.change();await h.advanceTo(at+35000);}assert.equal(h.latencies.length,120);
   row[name]={p50Ms:percentile(h.latencies,.5),p95Ms:percentile(h.latencies,.95),p99Ms:percentile(h.latencies,.99),lostEvents:120-h.latencies.length,...h.stats()};
  }finally{h.stop();}
 }
 row.p95ImprovementPercent=Number(((row.before.p95Ms-row.after.p95Ms)/row.before.p95Ms*100).toFixed(2));
 assert.ok(row.p95ImprovementPercent>=30);report.scenarios.push(row);
}
report.idle120Seconds={};
for(const [name,source]of Object.entries(sources)){const h=await runtime(source,'admin');try{await h.advanceTo(120000);report.idle120Seconds[name]=h.stats();}finally{h.stop();}}
fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
