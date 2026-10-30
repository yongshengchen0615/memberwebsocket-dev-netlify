const test=require('node:test'),assert=require('node:assert/strict');
const policy=()=>import('../supabase/functions/_shared/business-policy.mjs');
const context=features=>({status:'active',runtime_schema:'business_'+'a'.repeat(32),features});

test('AC-002: booking integrations require each selected feature, including claim and nested participant selections',async()=>{
 const {assertBusinessAction}=await policy();
 for(const [action,body,missing] of [
  ['user.booking.event-ticket.claim',{eventTicketId:'E'},'events'],
  ['user.booking.create',{benefits:[{kind:'points',id:'P'}]},'points'],
  ['user.booking.create',{participants:[{benefits:[{kind:'event',id:'E'}]}]},'events'],
  ['admin.booking.benefits.update',{benefits:[{kind:'calendar',id:'C'}]},'calendar'],
 ]){
  const features={booking:true,points:true,events:true,calendar:true,[missing]:false};
  assert.throws(()=>assertBusinessAction(context(features),action,body),e=>e.code==='FEATURE_DISABLED',action);
  assert.doesNotThrow(()=>assertBusinessAction(context({...features,[missing]:true}),action,body));
 }
 assert.doesNotThrow(()=>assertBusinessAction(context({booking:true}),'user.booking.create',{benefits:[]}));
});

test('AC-003: saved integration payloads cannot enable unapproved points, calendar or booking functionality',async()=>{
 const {assertBusinessAction}=await policy();
 for(const [action,body,features] of [
  ['admin.booking.type.update',{rewardMinutesPerPoint:30,rewardPointCardId:'P'},{booking:true}],
  ['admin.calendar-items.save',{calendarItem:{bonusPointsEnabled:true,bonusPoints:2}},{calendar:true}],
  ['admin.calendar-items.batch',{calendarItemOperations:[{calendarItem:{bonusPointsEnabled:true,bonusPoints:2}}]},{calendar:true}],
  ['admin.fixed-tickets.save',{template:{calendarEnabled:true}},{events:true}],
  ['admin.fixed-tickets.save',{template:{calendarEnabled:'true'}},{events:true}],
  ['admin.event-tickets.save',{eventTicket:{requiredServiceIds:['S']}},{events:true}],
  ['admin.event-tickets.save',{eventTicket:{requiredServiceTypes:['Massage']}},{events:true}],
  ['admin.pointcards.save',{card:{rewards:[{requiredServiceGroups:[['A','B']]}]}},{points:true}],
  ['admin.service-grants.catalog',{}, {membership:true,points:true}],
 ])assert.throws(()=>assertBusinessAction(context(features),action,body),e=>e.code==='FEATURE_DISABLED',action);
 for(const [action,body,features] of [
  ['admin.booking.type.update',{name:'standalone'},{booking:true}],
  ['admin.calendar-items.save',{calendarItem:{bonusPointsEnabled:false,bonusPoints:0}},{calendar:true}],
  ['admin.fixed-tickets.save',{template:{calendarEnabled:false}},{events:true}],
  ['admin.member-grants.add',{serviceTime:{minutes:30}},{membership:true}],
 ])assert.doesNotThrow(()=>assertBusinessAction(context(features),action,body));
});

test('AC-001/002: cross-module responses omit disabled data without mutating the original historical records',async()=>{
 const {businessResponse}=await policy();
 const data={items:[{kind:'points',id:'P'},{kind:'event',id:'E'},{kind:'calendar',id:'C'}]};
 assert.deepEqual(businessResponse(data,context({booking:true,events:true}),'user.booking.benefits').items,[{kind:'event',id:'E'}]);
 assert.equal(data.items.length,3);
 const records={records:{pointCards:[{id:'P'}],eventTickets:[{id:'E'}],calendar:[{id:'C'}],bookings:[{id:'B'}],presence:[{id:'S'}],testAutomation:[]},counts:{pointCards:1,eventTickets:1,calendar:1,bookings:1,presence:1,testAutomation:0}};
 const filtered=businessResponse(records,context({membership:true,booking:true}),'admin.member-records.list');
 assert.deepEqual(filtered.records.pointCards,[]);assert.deepEqual(filtered.records.eventTickets,[]);
 assert.deepEqual(filtered.records.calendar,[]);assert.equal(filtered.counts.pointCards,0);
 assert.equal(filtered.records.bookings.length,1);assert.equal(records.records.pointCards.length,1);
 const admin=businessResponse({pointCards:[{id:'P'}],serviceTypes:[{id:'T',rewardPointCardId:'P',rewardMinutesPerPoint:30}],services:[{serviceId:'S'}]},context({booking:true}),'admin.booking.manage.bootstrap');
 assert.deepEqual(admin.pointCards,[]);assert.equal(admin.serviceTypes[0].rewardPointCardId,null);assert.equal(admin.services.length,1);
 const nested=businessResponse({catalog:data},context({booking:true,events:true}),'admin.booking.benefits.list');
 assert.deepEqual(nested.catalog.items,[{kind:'event',id:'E'}]);
});

function storedDb(tables){return {from(table){let rows=tables[table]||[];const q={select(){return q;},eq(k,v){rows=rows.filter(r=>r[k]===v);return q;},in(k,v){rows=rows.filter(r=>v.includes(r[k]));return q;},then(resolve){return Promise.resolve({data:rows,error:null}).then(resolve);}};return q;}};}
test('AC-004: stored selections and automatic reward rules cannot bypass a revoked grant during completion',async()=>{
 const {assertBusinessRpc}=await policy();
 const params={p_booking_id:'B'};
 const db=storedDb({booking_items:[{booking_id:'B',service_type:'Massage',counts_toward_membership:true}],booking_benefit_selections:[{booking_id:'B',status:'pending',benefit_kind:'event'}],booking_service_types:[{id:'T',name:'Massage'}],booking_service_type_rewards:[{service_type_id:'T'}]});
 await assert.rejects(assertBusinessRpc(context({booking:true,membership:true,points:true}),'complete_booking_with_benefits_request',params,db),e=>e.code==='FEATURE_DISABLED');
 await assert.rejects(assertBusinessRpc(context({booking:true,membership:true,events:true}),'complete_booking_with_benefits_request',params,db),e=>e.code==='FEATURE_DISABLED');
 await assert.doesNotReject(assertBusinessRpc(context({booking:true,membership:true,points:true,events:true,calendar:true}),'complete_booking_with_benefits_request',params,db));
 const standalone=storedDb({booking_items:[{booking_id:'B',service_type:'Other',counts_toward_membership:true}],booking_service_types:[{id:'T',name:'Massage'}],booking_service_type_rewards:[{service_type_id:'T'}]});
 await assert.doesNotReject(assertBusinessRpc(context({booking:true,membership:true}),'complete_booking_with_benefits_request',params,standalone));
 const historical=storedDb({booking_completion_settlements:[{booking_id:'B',reward_details:[],correction_context:{rules:[{pointCardId:'P'}]}}]});
 await assert.rejects(assertBusinessRpc(context({booking:true,membership:true}),'correct_completed_booking_request',params,historical),e=>e.code==='FEATURE_DISABLED');
});
test('AC-004: stored calendar integrations guard fixed issuance and calendar bonus grants, while standalone grants remain usable',async()=>{
 const {assertBusinessRpc}=await policy();
 const db=storedDb({fixed_ticket_templates:[{status:'active',calendar_enabled:true}],calendar_items:[{status:'active',bonus_points_enabled:true,bonus_points:2,starts_on:'2000-01-01',ends_on:'2999-01-01'}]});
 await assert.rejects(assertBusinessRpc(context({events:true}),'issue_fixed_tickets',{},db),e=>e.code==='FEATURE_DISABLED');
 await assert.rejects(assertBusinessRpc(context({membership:true,points:true}),'grant_member_benefits_with_event_bonus',{p_points:[{cardId:'P',amount:1}]},db),e=>e.code==='FEATURE_DISABLED');
 await assert.doesNotReject(assertBusinessRpc(context({membership:true}),'grant_member_benefits_with_event_bonus',{p_points:[],p_service_minutes:30},db));
 await assert.doesNotReject(assertBusinessRpc(context({points:true}),'grant_member_benefits_with_event_bonus',{p_points:[{cardId:'P',amount:1}]},storedDb({})));
});
