const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const appointmentDate = '2099-01-02';
const notice = '請攜帶預約編號至現場辦理修改。';

for (const minAdvanceDays of [0, 1]) {
  test('AC-001/002 member booking actual DOM respects configured online cutoff: '+minAdvanceDays, async () => {
    const dom = new JSDOM(read('booking/index.html'), {
      url: 'https://bookings.test/booking/?business=test-shop',
      runScripts: 'outside-only', pretendToBeVisual:true,
    });
    const w = dom.window;
    const tick = () => new Promise(resolve => setTimeout(resolve, 45));
    const bookingId = '30000000-0000-4000-8000-000000000001';
    const serviceId = '20000000-0000-4000-8000-000000000001';
    const booking = {
      bookingId, status:'confirmed',updatedAt:'2099-01-01T09:00:00Z',
      bookingDate:appointmentDate,startTime:'10:00',endTime:'11:00',
      items:[{ serviceId, serviceTitle:'測試服務', quantity:1 }],
    };
    const data = {
      serverNow:'2099-01-02T09:00:00+08:00',
      today:appointmentDate,
      settings:{
        minAdvanceDays, maxAdvanceDays:60, workStartTime:'09:00',workEndTime:'18:00',
        onsiteEditMessage:notice,
      },
      services:[{ serviceId,title:'測試服務',durationMinutes:60,priceAmount:100,isActive:true }],
      bookings:[booking],
    };
    const calls=[], notices=[];
    w.MembershipProgress = {render(){}};
    w.matchMedia = () => ({matches:false});
    w.fetch = async (_url,init) => {
      const body=JSON.parse(init.body);
      calls.push(body.action);
      if(body.action==='member.list')return new Response(JSON.stringify({ok:true,data:{cancellationMode:'direct',requests:[]}}));
      throw Error('Unexpected endpoint '+body.action);
    };
    w.BookingSystem = {
      loadConfig:async()=>({supabaseUrl:'https://db.test',supabasePublishableKey:'publishable-test'}),
      signIn:async()=>'test-token',subscribeRealtime:()=>()=>{},
      memberProfile:async()=>({}),
      addDays:(day,days)=>new Date(Date.parse(day+'T00:00:00Z')+days*86400000).toISOString().slice(0,10),
      formatDate:x=>x,
      showNotice:(message,opts)=>{notices.push({message,opts});},
      request:async(_config,_type,_token,action)=>{
        calls.push(action);
        if(action==='user.booking.bootstrap')return structuredClone(data);
        if(action==='user.booking.slots')return { slots:[] };
        throw Error('Unexpected action '+action);
      },
    };
    try {
      w.eval(read('booking/onsite-edit-policy.js'));
      w.eval(read('booking/member-ui.js'));
      w.eval(read('booking/app.js'));
      await tick();await tick();
      const cards = w.document.querySelectorAll('.booking-item');
      assert.ok(cards.length > 0,'appointment card must render');
      const label = minAdvanceDays===0?'修改預約':'現場修改';
      const button = [...cards[0].querySelectorAll('button')]
        .find(el=>el.textContent.trim()===label);
      assert.ok(button, 'expected member action '+label);
      if(minAdvanceDays===1) {
        assert.match(cards[0].textContent, /請攜帶預約編號至現場辦理修改/);
        button.click();
        assert.deepEqual(notices.map(x=>x.message),[notice]);
        assert.equal(calls.filter(x=>/user\.booking\.(update|group\.update)/.test(x)).length,0,
          'onsite warning never transmits modification request');
      }else{
        assert.doesNotMatch(cards[0].textContent,/請攜帶預約編號至現場辦理修改/);
      }
    }finally{
      w.close();
    }
  });
}
