const {test}=require('node:test');
const assert=require('node:assert/strict');
const load=()=>import('../supabase/functions/_shared/booking-price-publishing.mjs');
const id='10000000-0000-4000-8000-000000000001';
const version='20000000-0000-4000-8000-000000000001';
test('existing batch delete submits selected services without depending on batch-edit modal state',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
 const s=fs.readFileSync(path.join(__dirname,'../admin/booking-panel-core.js'),'utf8');
 const start=s.indexOf('  async function batchDelete()');const end=s.indexOf('\n  async function runModalAction',start+5);
 assert.ok(start>=0&&end>start);let sent;
 const context={state:{config:{pricePublishing:true},catalog:{services:[{serviceId:id,updatedAt:'2030-01-01T00:00:00Z'}]},selected:new Set([id])},window:{confirm:()=>true},els:{bookingAdminServiceMessage:{}},runPageAction:async(_,run)=>run(),manageRequest:async(action,payload)=>{sent={action,payload}}};
 await vm.runInNewContext(s.slice(start,end)+'\n batchDelete()',context);
 assert.equal(sent.action,'admin.booking.services.batch');
 assert.deepEqual(JSON.parse(JSON.stringify(sent.payload)),{operations:[{op:'delete',serviceId:id,expectedUpdatedAt:'2030-01-01T00:00:00Z'}]});
});
test('browser quote includes every selected participant item and preserves feature-off payloads',()=>{
 const fs=require('node:fs'),vm=require('node:vm');const window={};
 vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../booking-price-publishing.js'),'utf8'),{window});
 const payload={participants:[{items:[{serviceId:id,quantity:1}]},{items:[{serviceId:id,quantity:2},{serviceId:'10000000-0000-4000-8000-000000000002'}]}]};
 assert.equal(window.BookingPricePublishing.payload({},payload,[]),payload);
 const result=window.BookingPricePublishing.payload({pricePublishing:true},payload,[{serviceId:id,priceAmount:500,priceVersion:version},{serviceId:'10000000-0000-4000-8000-000000000002',priceAmount:900,priceVersion:version}]);
 assert.equal(result.pricePublishing,true);assert.equal(result.expectedPrices.length,2);
 assert.equal(result.expectedPrices[0].priceAmount,500);assert.equal(result.expectedPrices[1].priceAmount,900);
 assert.equal(payload.pricePublishing,undefined);
 const captured=[{serviceId:id,priceAmount:100,priceVersion:version},{serviceId:'10000000-0000-4000-8000-000000000002',priceAmount:200,priceVersion:version}];
 assert.equal(window.BookingPricePublishing.payload({pricePublishing:true},{...payload,expectedPrices:captured},[]).expectedPrices,captured,'a modal must preserve its original quote even if background catalog data refreshes');
 assert.throws(()=>window.BookingPricePublishing.payload({pricePublishing:true},payload,[]),/價格資料/);
});
test('quote headers are request-local, validate every item and require member write confirmation',async()=>{
 const {bookingPriceOptions}=await load();
 assert.equal(bookingPriceOptions({}).global.headers['x-booking-price-preview'],'1');
 assert.equal(bookingPriceOptions({pricePublishing:false,action:'user.booking.create'}).global.headers['x-booking-price-check'],'1');
 const body={pricePublishing:true,action:'user.booking.group.create',expectedPrices:[{serviceId:id,priceAmount:500,priceVersion:version}]};
 const opts=bookingPriceOptions(body);
 assert.equal(opts.global.headers['x-booking-price-preview'],'1');
 assert.equal(opts.global.headers['x-booking-price-check'],'1');
 assert.deepEqual(JSON.parse(opts.global.headers['x-booking-price-quote']),body.expectedPrices);
 assert.equal(bookingPriceOptions({pricePublishing:true,action:'user.booking.bootstrap'}).global.headers['x-booking-price-check'],'0');
 assert.equal(bookingPriceOptions({action:'admin.booking.receipt.register'}).global.headers['x-booking-price-check'],'1');
 assert.equal(bookingPriceOptions({action:'admin.booking.completed.correct'}).global.headers['x-booking-price-check'],'0');
 assert.throws(()=>bookingPriceOptions({...body,expectedPrices:[{serviceId:id,priceAmount:-1,priceVersion:version}]}),/INVALID_BOOKING_PRICE_QUOTE/);
 assert.throws(()=>bookingPriceOptions({...body,expectedPrices:[...body.expectedPrices,...body.expectedPrices]}),/INVALID_BOOKING_PRICE_QUOTE/);
 assert.equal(opts.global.headers['x-booking-price-check'],'1','a later read must not mutate a previous write context');
});
test('opt-in service reads use effective prices, while legacy calls and table mutations preserve contracts',async()=>{
 const {withBookingPrices}=await load();
 const client={from:table=>({select:fields=>({table,fields}),update:patch=>({table,patch})}),rpc:(name,args)=>({name,args})};
 assert.deepEqual(withBookingPrices(client,{}).from('booking_services').select('price_amount'),{table:'booking_services_priced',fields:'price_amount'});
 const c=withBookingPrices(client,{pricePublishing:true});
 assert.deepEqual(c.from('booking_services').select('id,price_amount'),{table:'booking_services_priced',fields:'id,price_amount'});
 assert.deepEqual(c.from('booking_services').update({title:'A'}),{table:'booking_services',patch:{title:'A'}});
 assert.deepEqual(c.from('members').select('id'),{table:'members',fields:'id'});
});
test('database price conflicts map to actionable status without exposing raw SQL details',async()=>{
 const {bookingPriceError}=await load();
 assert.deepEqual(bookingPriceError({message:'BOOKING_PRICE_CHANGED secret database detail'}),{status:409,code:'BOOKING_PRICE_CHANGED',message:'預約項目價格已變更，請重新確認最新價格後再送出。'});
 assert.equal(bookingPriceError({message:'OTHER_ERROR'}),null);
 assert.equal(bookingPriceError({message:'BOOKING_PRICE_TIME_CONFLICT'}).status,409);
});
test('scheduled API price timestamps reject impossible calendar dates and ambiguous timezone input',async()=>{
 const {pricePublishTime}=await load();
 assert.equal(pricePublishTime('immediate','ignored'),null);
 assert.equal(pricePublishTime('scheduled','2036-02-29T09:30:00+08:00'),'2036-02-29T09:30:00+08:00');
 for(const at of ['2035-02-29T09:30:00+08:00','2035-11-10T24:00:00+08:00','2035-11-10T09:30','2035-11-10T09:30:01+08:00'])assert.throws(()=>pricePublishTime('scheduled',at),/INVALID_PRICE_PUBLISH_TIME/);
});
