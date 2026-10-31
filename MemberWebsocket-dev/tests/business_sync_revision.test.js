const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'../member-system.js'),'utf8');
const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
async function harness(surface='member'){
 let now=0,id=0,revision='0',failed=false,probes=0,refreshes=0,finish;
 const timers=new Map(),listeners=new Map(),store=new Map(),events=[];
 const eventTarget=()=>({addEventListener(type,fn){const key=this===document?'d:'+type:type;if(!listeners.has(key))listeners.set(key,new Set());listeners.get(key).add(fn);},removeEventListener(type,fn){listeners.get(this===document?'d:'+type:type)?.delete(fn);}});
 const document={...eventTarget(),visibilityState:'visible',querySelectorAll:()=>[],querySelector:()=>({}),title:'fixture'};
 const window={...eventTarget(),crypto:webcrypto,setTimeout(fn,ms){const key=++id;timers.set(key,{fn,at:now+ms});return key;},clearTimeout(key){timers.delete(key);},setInterval:()=>1,clearInterval(){},localStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},liff:{init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=> 'synthetic-id-token'},dispatchEvent:e=>events.push(e),CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}}};
 const navigator={onLine:true};
 const config={business:'fixture-shop',realtimeEnabled:true,supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',memberCalendarFunctionUrl:'https://fixture.supabase.co/functions/v1/member-calendar-api',supabasePublishableKey:'synthetic',memberLiffId:'member',pointsLiffId:'points',eventLiffId:'event',calendarLiffId:'calendar',bookingLiffId:'booking',adminLiffId:'admin'};
 const fetch=async(_url,options)=>{const body=JSON.parse(options.body);if(body.action.endsWith('.sync.status')){probes++;if(failed)return{status:503,text:async()=>JSON.stringify({ok:false,error:{code:'SYNC_UNAVAILABLE'}})};return{status:200,text:async()=>JSON.stringify({ok:true,data:{revision}})};}return{status:200,text:async()=>JSON.stringify({ok:true,data:{state:'claimed'}})};};
 vm.runInNewContext(source,{window,document,navigator,fetch,URL,AbortController,CustomEvent:window.CustomEvent,Date:class extends Date{static now(){return now;}}});
 await window.MemberSystem.signIn(config,surface);
 const baselineTimers=timers.size;
 const stop=window.MemberSystem.subscribeRealtime(config,surface,()=>{refreshes++;return finish?new Promise(resolve=>{finish.resolve=resolve;}):Promise.resolve();});
 return{window,document,navigator,events,stop,baselineTimers,setRevision:v=>revision=v,fail:v=>failed=v,slow(){finish={};},finish:()=>{finish?.resolve?.();finish=null;},get probes(){return probes;},get refreshes(){return refreshes;},get timerCount(){return timers.size;},emit(key){for(const fn of listeners.get(key)||[])fn({persisted:false});},async tick(ms){const end=now+ms;for(let n=0;n<500;n++){const next=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();await flush();}now=end;await flush();}};
}
for(const surface of ['member','points','event','calendar','admin'])test(`AC-185 revision ${surface}: changed data updates within 10s; idle polls avoid full reloads`,async()=>{
 const h=await harness(surface);try{await h.tick(0);const initial=h.refreshes;assert.equal(h.probes,1);await h.tick(30000);assert.equal(h.refreshes,initial);h.setRevision('new');await h.tick(10000);assert.equal(h.refreshes,initial+1);assert.ok(h.probes>=4);assert.ok(h.events.some(e=>e.type==='member-system:sync-metrics'));}finally{h.stop();}
});
test('AC-185 recovery: paused, failed, in-flight and disposed probes retain changes without overlapping reloads',async()=>{
 const h=await harness();await h.tick(0);const before=h.probes;h.document.visibilityState='hidden';await h.tick(30000);assert.equal(h.probes,before);
 h.setRevision('1');h.document.visibilityState='visible';h.emit('d:visibilitychange');await h.tick(0);assert.equal(h.refreshes,2);
 h.fail(true);await h.tick(10000);const failures=h.probes;await h.tick(9999);assert.equal(h.probes,failures,'failure must back off');h.fail(false);h.setRevision('2');await h.tick(20001);assert.equal(h.refreshes,3);
 h.slow();h.setRevision('3');await h.tick(10000);const inflight=h.probes;h.setRevision('4');h.emit('online');await h.tick(30000);assert.equal(h.probes,inflight);h.finish();await flush();await h.tick(0);assert.equal(h.refreshes,5,'resume during refresh must retain one trailing probe');h.stop();await h.tick(120000);assert.equal(h.timerCount,h.baselineTimers,'only the independent signed-in presence timer may remain');
});
