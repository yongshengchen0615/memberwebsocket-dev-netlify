const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness(){
 const calls=[],timers=new Map(),location=new URL('https://fixture.test/event/?business=shop-a');
 const window={location,setTimeout(fn){const id=timers.size+1;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},
  fetch:(url,init)=>new Promise((resolve,reject)=>{init.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});calls.push({url,init,resolve,reject});})};
 const document={documentElement:{},querySelectorAll:()=>[],addEventListener(){}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../business-context.js'),'utf8'),{window,location,document,URL,URLSearchParams,AbortController});
 const config=()=>({supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'public'});
 const succeed=(i,business='shop-a')=>calls[i].resolve({ok:true,json:async()=>({ok:true,data:{business,name:business,features:{events:true},line:{eventLiffId:'event-id'}}})});
 return{context:window.BusinessContext,calls,timers,config,succeed,async flush(){for(let i=0;i<30;i++)await Promise.resolve();}};
}
test('AC-004: 100 matching startup configurations share one request and all receive feature identity',async()=>{
 const h=harness(),configs=Array.from({length:100},h.config),pending=configs.map(c=>h.context.configure(c));
 await h.flush();assert.equal(h.calls.length,1);h.succeed(0);await Promise.all(pending);
 assert.ok(configs.every(c=>c.business==='shop-a'&&c.eventLiffId==='event-id'));
 assert.equal(h.timers.size,0);
 const fresh=h.context.configure(h.config());await h.flush();assert.equal(h.calls.length,2);h.succeed(1);await fresh;
});
test('AC-004: startup is bounded, aborted once, and an explicit retry starts a fresh request',async()=>{
 const h=harness(),pending=h.context.configure(h.config());await h.flush();
 assert.equal(h.timers.size,1);assert.ok(h.calls[0].init.signal);
 [...h.timers.values()][0]();await assert.rejects(pending,/aborted/);assert.equal(h.timers.size,0);
 const retry=h.context.configure(h.config());await h.flush();assert.equal(h.calls.length,2);h.succeed(1);await retry;
});
test('AC-004: timeout remains active while the response body is stalled',async()=>{
 const h=harness(),pending=h.context.configure(h.config());await h.flush();
 const signal=h.calls[0].init.signal;
 h.calls[0].resolve({ok:true,json:()=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('body aborted')),{once:true}))});
 await h.flush();assert.equal(h.timers.size,1);[...h.timers.values()][0]();
 await assert.rejects(pending,/body aborted/);assert.equal(h.timers.size,0);
});
test('AC-004: refresh and different public keys never share a feature-scoped startup response',async()=>{
 const h=harness();const a=h.context.configure(h.config()),b=h.context.configure({...h.config(),supabasePublishableKey:'other'}),c=h.context.refresh(h.config());
 const settled=Promise.allSettled([a,b,c]);await h.flush();assert.equal(h.calls.length,3);
 h.succeed(2);await h.flush();h.succeed(0);h.succeed(1);const results=await settled;
 assert.ok(results.every(r=>r.status==='fulfilled'));assert.equal(h.timers.size,0);
 assert.equal(JSON.parse(h.calls[0].init.body).feature,'events');assert.equal(JSON.parse(h.calls[2].init.body).feature,undefined);
});
test('AC-004: switching business discards the old response and starts an isolated request',async()=>{
 const h=harness(),a=h.context.configure(h.config());const rejected=assert.rejects(a,/入口已變更/);
 h.context.set('shop-b');const b=h.context.configure(h.config());await h.flush();assert.equal(h.calls.length,2);
 h.succeed(0);await rejected;h.succeed(1,'shop-b');assert.equal((await b).business,'shop-b');
});
test('AC-004: A to B to A cannot revive a request from the previous merchant generation',async()=>{
 const h=harness(),a=h.context.configure(h.config()),rejected=assert.rejects(a,/入口已變更/);
 h.context.set('shop-b');h.context.set('shop-a');const fresh=h.context.configure(h.config());await h.flush();
 assert.equal(h.calls.length,2);h.succeed(0);await rejected;h.succeed(1);await fresh;
});
for(const newestFirst of [false,true])test('AC-004: startup and refresh succeed in either response order; newer grants win: '+newestFirst,async()=>{
 const h=harness(),config=h.config(),startup=h.context.configure(config),refresh=h.context.refresh(h.config());await h.flush();
 const revoke=()=>h.calls[1].resolve({ok:true,json:async()=>({ok:true,data:{business:'shop-a',name:'Synthetic',features:{events:false},line:{}}})});
 if(newestFirst){revoke();await refresh;h.succeed(0);await startup;}
 else{h.succeed(0);await startup;revoke();await refresh;}
 assert.equal(config.grantedFeatures.events,false);assert.equal(config.eventLiffId,'event-id');
});
test('AC-004: a newer failed refresh cannot turn a valid startup response into a startup failure',async()=>{
 const h=harness(),startup=h.context.configure(h.config()),refresh=h.context.refresh(h.config()),failed=assert.rejects(refresh,/offline/);await h.flush();
 h.succeed(0);assert.equal((await startup).business,'shop-a');h.calls[1].reject(new Error('offline'));await failed;
});
