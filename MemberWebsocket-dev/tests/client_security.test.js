const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
for(const surface of ['member','points','event','calendar','admin']) {
  test(`${surface}: realtime cleanup cancels pending refresh and permits resubscription`,()=>{
    let onChange, removed=0, cleared=0;
    const channel={on(event,filter,callback){onChange=callback;return this;},subscribe(){return this;}};
    const client={channel(){return channel;},removeChannel(){removed++;}};
    const window={addEventListener(){},removeEventListener(){},supabase:{createClient(){return client;}},setTimeout(){return 7;},clearTimeout(id){assert.equal(id,7);cleared++;}};
    const context=vm.createContext({window,document:{addEventListener(){},removeEventListener(){},querySelector(){return {};}},Map,Set,URL,console});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../member-system.js'),'utf8'),context);
    const config={supabaseUrl:'https://example.supabase.co',supabaseFunctionUrl:'https://example.supabase.co/functions/v1/api',memberCalendarFunctionUrl:'https://example.supabase.co/functions/v1/member-calendar-api',supabasePublishableKey:'fixture',memberLiffId:'member',pointsLiffId:'points',eventLiffId:'event',calendarLiffId:'calendar',adminLiffId:'admin'};
    const stop=window.MemberSystem.subscribeRealtime(config,surface,()=>assert.fail('Disposed refresh ran'));
    onChange({new:{scope:surface}}); stop();stop();
    assert.equal(cleared,1);assert.equal(removed,1);
    const next=window.MemberSystem.subscribeRealtime(config,surface,()=>{});assert.notEqual(next,stop);next();assert.equal(removed,2);
  });
  test(`${surface}: in-flight reads deduplicate only within the same identity`,async()=>{
    const deferred=[];
    const window={setTimeout,clearTimeout};
    const context=vm.createContext({window,document:{addEventListener(){},removeEventListener(){},querySelector(){return {};}},Map,Set,URL,AbortController,Date,console,fetch(url,options){return new Promise(resolve=>deferred.push({resolve,token:JSON.parse(options.body).idToken}));}});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../member-system.js'),'utf8'),context);
    const config={realtimeEnabled:false,supabaseUrl:'https://example.supabase.co',supabaseFunctionUrl:'https://example.supabase.co/functions/v1/api',memberCalendarFunctionUrl:'https://example.supabase.co/functions/v1/member-calendar-api',supabasePublishableKey:'fixture',memberLiffId:'member',pointsLiffId:'points',eventLiffId:'event',calendarLiffId:'calendar',adminLiffId:'admin'};
    const first=window.MemberSystem.request(config,surface,'identity-A','read');
    const duplicate=window.MemberSystem.request(config,surface,'identity-A','read');
    const other=window.MemberSystem.request(config,surface,'identity-B','read');
    assert.equal(first,duplicate);assert.notEqual(first,other);assert.equal(deferred.length,2);
    for(const item of deferred)item.resolve({ok:true,status:200,text:async()=>JSON.stringify({ok:true,data:{identity:item.token}})});
    assert.equal((await first).identity,'identity-A');assert.equal((await other).identity,'identity-B');
  });
}
