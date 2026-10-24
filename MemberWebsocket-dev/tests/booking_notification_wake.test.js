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
