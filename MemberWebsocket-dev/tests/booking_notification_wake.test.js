const {test}=require('node:test'),assert=require('node:assert/strict');
test('AC-188: dispatch happens only after successful committed booking mutation and never forwards caller recipients',async()=>{
 const {wakeBookingNotifications:wake}=await import('../supabase/functions/_shared/booking-notification-wake.mjs');const calls=[];
 const base={name:'booking-api',context:{id:'trusted-tenant'},body:{action:'user.booking.create',to:'forged',token:'forged'},response:new Response(JSON.stringify({ok:true})),dispatch:async id=>{calls.push(id);return{data:true};}};
 assert.equal(await wake(base),true);assert.deepEqual(calls,['trusted-tenant']);
 for(const override of [{response:new Response('{}',{status:403})},{response:new Response('{"ok":false}')},{body:{action:'user.booking.bootstrap'}},{context:null},{name:'platform-api'}])assert.equal(await wake({...base,...override}),false);
 assert.equal(calls.length,1);
 assert.equal(await wake({...base,dispatch:async()=>{throw Error('unavailable');}}),false);
 assert.equal(await base.response.clone().json().then(x=>x.ok),true,'original successful response remains readable');
});

test('AC-ADM-LINE-SPEED-001: committed admin walk-in rejection wakes merchant outbox immediately without recipient injection',async()=>{
 const {wakeBookingNotifications:wake}=await import('../supabase/functions/_shared/booking-notification-wake.mjs');
 const dispatches=[];
 const makeResponse=(ok,status=200)=>new Response(JSON.stringify({ok}),{status,headers:{'Content-Type':'application/json'}});
 const base={name:'booking-api',context:{id:'trusted-tenant'},body:{
   action:'admin.booking.reject-walkin',bookingId:'a-notification-test-id',
   recipient:'forged-recipient',channel:'frontdesk',to:'forged-recipient',status:'rejected'
 },response:makeResponse(true),dispatch:async tenantId=>{dispatches.push(tenantId);return{data:true,error:null};}};
 assert.equal(await wake(base),true,'the atomic reject-walkin action must wake without waiting for cron');
 assert.deepEqual(dispatches,['trusted-tenant'],'only verified tenant ID is forwarded to dispatch');
 assert.equal((await base.response.clone().json()).ok,true,'response is still readable after wake');
 for(const override of [
   {response:makeResponse(false)},
   {response:makeResponse(true,409)},
   {response:new Response('not JSON',{status:200})},
   {name:'booking-admin-api'},
   {context:null},
   {body:{action:'admin.booking.reject-walkin.preview'}},
   {body:{action:'admin.booking.bootstrap'}}
 ]){
   assert.equal(await wake({...base,...override}),false,'failure/read-only/ineligible requests must not trigger LINE');
 }
 assert.equal(dispatches.length,1,'no notification triggered for negative paths');
 assert.equal(await wake({...base,dispatch:async()=>({data:false})}),false,'queue may be empty or locked');
 assert.equal(await wake({...base,dispatch:async()=>({error:{message:'unavailable'},data:null})}),false,'dispatch failure is nonfatal');
 assert.equal(await wake({...base,dispatch:async()=>{throw Error('network unavailable');}}),false,'cron owns eventual retries');
});

test('AC-ADM-LINE-SPEED-002: normal admin rejection and frontdesk-origin notifications retain existing wake contract',async()=>{
 const {wakeBookingNotifications:wake}=await import('../supabase/functions/_shared/booking-notification-wake.mjs');
 const actions=['admin.booking.status.update','user.booking.create','admin.booking.status.complete'];
 const seen=[];
 for(const action of actions){
   const triggered=await wake({name:'booking-api',context:{id:'tenant-a'},
     body:{action},response:new Response('{"ok":true}'),
     dispatch:async id=>{seen.push({action,id});return{data:true};}});
   assert.equal(triggered,true,'existing successful booking writes continue waking');
 }
 assert.deepEqual(seen,actions.map(action=>({action,id:'tenant-a'})));
});
