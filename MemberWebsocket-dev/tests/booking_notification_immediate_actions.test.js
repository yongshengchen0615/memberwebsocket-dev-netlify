const {test}=require('node:test');
const assert=require('node:assert/strict');
const {resolve}=require('node:path');
const modulePath=resolve(__dirname,'../supabase/functions/_shared/booking-notification-wake.mjs');

test('AC-LINE-001: committed booking cancellation and completion correction wake the trusted merchant only',async()=>{
 const {wakeBookingNotifications:wake}=await import(modulePath);
 const dispatched=[];
 for(const [name,action] of [['booking-api','user.booking.cancel'],['booking-admin-operations','admin.booking.completed.correct']]){
  const result=await wake({name,context:{id:'verified-tenant'},body:{action,recipient:'forged-member',lineToken:'forged-token'},
   response:new Response('{"ok":true}'),dispatch:async tenant=>{dispatched.push([action,tenant]);return{data:true};}});
  assert.equal(result,true,`missing immediate wake for ${action}`);
 }
 assert.deepEqual(dispatched,[['user.booking.cancel','verified-tenant'],['admin.booking.completed.correct','verified-tenant']]);
});

test('AC-LINE-002: booking preview, failed mutations and unsupported endpoints never wake LINE',async()=>{
 const {wakeBookingNotifications:wake}=await import(modulePath);
 const dispatched=[];
 const base={name:'booking-api',context:{id:'verified-tenant'},body:{action:'user.booking.cancel'},
   response:new Response('{"ok":true}'),dispatch:async tenant=>{dispatched.push(tenant);return {data:true};}};
 for(const variation of [{body:{action:'admin.booking.completed.preview'}},{name:'booking-admin-api'},
  {response:new Response('{"ok":false}')},{response:new Response('{"ok":true}',{status:409})}]){
  assert.equal(await wake({...base,...variation}),false);
 }
 assert.deepEqual(dispatched,[]);
});

test('AC-LINE-003: eligible notifications register asynchronous wake without waiting for dispatch completion',async()=>{
 const {scheduleBookingNotificationWake:schedule}=await import(modulePath);
 const pending=[];
 let complete;
 const unresolved=new Promise(resolve=>complete=resolve);
 const dispatched=[];
 const yes=await schedule({name:'booking-api',context:{id:'verified-tenant'},body:{action:'user.booking.cancel'},
   response:new Response('{"ok":true}'),dispatch:async id=>{dispatched.push(id);await unresolved;return {data:true};}},p=>pending.push(p));
 assert.equal(yes,true);
 assert.deepEqual(dispatched,['verified-tenant']);
 assert.equal(pending.length,1);
 complete();
 await Promise.all(pending);
});
