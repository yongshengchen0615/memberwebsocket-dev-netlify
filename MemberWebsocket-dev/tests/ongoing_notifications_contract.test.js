const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),load=p=>import(pathToFileURL(path.join(root,p)));
const id='30000000-0000-4000-8000-000000000001';
const job={id,recipient:'QA:admin',message_text:'【預約】\n日期：2026/10/14\n時段：10:00–11:00\n預約項目：肩頸',channel:'admin',attempt_count:1,booking_id:id};
function dbFixture(tables){return {from(table){let rows=tables[table] || [],single=false;const q={select(){return q},eq(k,v){rows=rows.filter(r=>r[k]===v);return q},in(k,v){rows=rows.filter(r=>v.includes(r[k]));return q},order(){return q},single(){single=true;return q},maybeSingle(){single=true;return q},then(resolve,reject){return Promise.resolve({data:single ? rows[0] || null : rows,error:null}).then(resolve,reject)}};return q;}};}
test('LINE copy payload and management use one full participant formatter with safe fallback',async()=>{
 const {loadAdminCopyText}=await load('supabase/functions/booking-line-notifications/booking-actions.ts');
 const {buildBookingFlexMessage}=await load('supabase/functions/booking-line-notifications/delivery.ts');
 const db=dbFixture({bookings:[{id,status:'pending',booking_date:'2026-10-14',start_time:'10:00:00',end_time:'11:00:00',contact_source:'member',members:{surname:'王',salutation:'mr',phone:'0912-345-678'}}],booking_participants:[{booking_id:id,id:'p1',position:1,booking_technicians:{name:'甲（主要技師）'}},{booking_id:id,id:'p2',position:2,booking_technicians:{name:'乙'}}],booking_participant_items:[{participant_id:'p1',service_id:'s1',service_title:'肩頸',quantity:2},{participant_id:'p2',service_id:'s2',service_title:'腳底',quantity:1}]});
 const {copyText,status}=await loadAdminCopyText(db,id);assert.equal(status,'pending');
 const expected='營業日 2026-10-14｜10:00–11:00\n王先生\n電話：0912345678\n預約人數：2 位\n\n第一位預約\n預約項目：肩頸 × 2\n預約技師：甲\n\n第二位預約\n預約項目：腳底\n預約技師：乙';assert.equal(copyText,expected);
 const message=buildBookingFlexMessage({...job,copyText,bookingStatus:status}),buttons=message.contents.footer.contents.filter(x=>x.type==='button');
 assert.equal(buttons.length,1,'Admin LINE only exposes the copy action');assert.equal(buttons[0].action.type,'clipboard');assert.equal(buttons[0].action.clipboardText,expected);
 const long=buildBookingFlexMessage({...job,copyText:'長'.repeat(1001)});assert.equal(long.contents.footer.contents[0].action.type,'uri');assert.equal(long.contents.footer.contents[0].action.label,'複製預約內容');assert.equal(JSON.stringify(long).includes('長'.repeat(20)),false);
 const stale=buildBookingFlexMessage({...job,copyText,bookingStatus:'cancelled'});assert.equal(stale.contents.footer.contents.some(x=>x.action?.label==='確認預約'),false);
});
test('member confirmed LINE preserves date and service, drops tier and offered tickets, without a detail button',async()=>{
 const {buildBookingFlexMessage}=await load('supabase/functions/booking-line-notifications/delivery.ts');
 const result=buildBookingFlexMessage({...job,channel:'member',message_text:'【預約確認】\n日期：2026/10/14\n時段：10:00–11:00\n預約項目：肩頸',benefits:{pointTickets:['OFFER-SECRET'],eventTickets:['EVENT-SECRET'],tierActivities:['TIER-SECRET'],tierLabel:'GOLD-SECRET'}});
 const serialized=JSON.stringify(result);assert.doesNotMatch(serialized,/OFFER-SECRET|EVENT-SECRET|TIER-SECRET|GOLD-SECRET|可用集點卡|會員階級/);assert.match(serialized,/2026\/10\/14/);assert.match(serialized,/10:00/);assert.match(serialized,/肩頸/);assert.doesNotMatch(serialized,/查看預約明細/);assert.equal(result.contents.footer.contents.some(x=>x.type==='button'),false);
});
test('linked member booking detail fails closed for forged or another member booking',async()=>{
 const {linkedBooking}=await load('supabase/functions/_shared/linked-booking.ts');
 const own={id,member_id:'own',status:'cancelled'},db=dbFixture({bookings:[own]});
 assert.equal((await linkedBooking(db,id,'own')).status,'cancelled');await assert.rejects(linkedBooking(db,id,'foreign'),/BOOKING_NOT_FOUND/);await assert.rejects(linkedBooking(db,'invalid','own'),/INVALID_BOOKING_ID/);
});
