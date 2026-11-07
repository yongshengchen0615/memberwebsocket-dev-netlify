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

function storedDb(tables,tier='general'){return {rpc:async()=>({data:tier,error:null}),from(table){let rows=tables[table]||[];const q={select(){return q;},eq(k,v){rows=rows.filter(r=>r[k]===v);return q;},in(k,v){rows=rows.filter(r=>v.includes(r[k]));return q;},then(resolve){return Promise.resolve({data:rows,error:null}).then(resolve);}};return q;}};}
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
 const db=storedDb({members:[{id:'M',line_user_id:'L'}],fixed_ticket_templates:[{status:'active',calendar_enabled:true}],calendar_items:[{item_type:'event',status:'active',bonus_points_enabled:true,bonus_points:2,starts_on:'2000-01-01',ends_on:'2999-01-01',allowed_tier_keys:[]}]});
 await assert.rejects(assertBusinessRpc(context({events:true}),'issue_fixed_tickets',{},db),e=>e.code==='FEATURE_DISABLED');
 await assert.rejects(assertBusinessRpc(context({membership:true,points:true}),'grant_member_benefits_with_event_bonus',{p_member_line_user_id:'L',p_points:[{cardId:'P',amount:1}]},db),e=>e.code==='FEATURE_DISABLED');
 await assert.doesNotReject(assertBusinessRpc(context({membership:true}),'grant_member_benefits_with_event_bonus',{p_points:[],p_service_minutes:30},db));
 await assert.doesNotReject(assertBusinessRpc(context({points:true}),'grant_member_benefits_with_event_bonus',{p_points:[{cardId:'P',amount:1}]},storedDb({})));
});
test('review: VIP-only calendar bonuses do not block unrelated ordinary-member point grants',async()=>{
 const {assertBusinessRpc}=await policy(),params={p_member_line_user_id:'L',p_points:[{cardId:'P',amount:1}]};
 const tables={members:[{id:'M',line_user_id:'L'}],calendar_items:[{item_type:'event',status:'active',bonus_points_enabled:true,bonus_points:2,starts_on:'2000-01-01',ends_on:'2999-01-01',allowed_tier_keys:['gold']}]};
 await assert.doesNotReject(assertBusinessRpc(context({points:true}),'grant_member_benefits_with_event_bonus',params,storedDb(tables,'general')));
 await assert.rejects(assertBusinessRpc(context({points:true}),'grant_member_benefits_with_event_bonus',params,storedDb(tables,'gold')),e=>e.code==='FEATURE_DISABLED');
 tables.calendar_items[0].item_type='holiday';
 await assert.doesNotReject(assertBusinessRpc(context({points:true}),'grant_member_benefits_with_event_bonus',params,storedDb(tables,'gold')));
});

test('review: canonical and nested benefit kinds cannot bypass revoked grants',async()=>{
 const {assertBusinessAction}=await policy();
 for(const benefits of [[{kind:' POINTS ',id:'P'}],[{kind:'EVent',id:'E'}],[{kind:' calendar ',id:'C'}]]){
  for(const body of [{benefits},{participants:[{benefits}]}])
   assert.throws(()=>assertBusinessAction(context({booking:true}),'user.booking.create',body),e=>e.code==='FEATURE_DISABLED');
 }
 for(const kind of ['unknown','',null])assert.throws(()=>assertBusinessAction(context({booking:true,points:true,events:true,calendar:true}),'user.booking.create',{benefits:[{kind}]}),e=>e.code==='INVALID_BENEFIT_KIND');
});

test('review: issuing a standalone template remains allowed beside a withheld linked template',async()=>{
 const {assertBusinessRpc}=await policy();
 const db=storedDb({fixed_ticket_templates:[{id:'linked',status:'active',calendar_enabled:true},{id:'standalone',status:'active',calendar_enabled:false}]});
 await assert.doesNotReject(assertBusinessRpc(context({events:true}),'issue_fixed_tickets',{p_template_id:'standalone'},db));
 await assert.rejects(assertBusinessRpc(context({events:true}),'issue_fixed_tickets',{p_template_id:'linked'},db),e=>e.code==='FEATURE_DISABLED');
});

test('review: actual booking and type-write response shapes omit revoked data and retain services/prices',async()=>{
 const {businessResponse}=await policy();
 const original={booking:{benefits:[{kind:'points',id:'P'},{kind:'event',id:'E'}]},catalog:{items:[{kind:'points',id:'P'},{kind:'event',id:'E'}]}};
 const result=businessResponse(original,context({booking:true,events:true}),'admin.booking.benefits.list');
 assert.deepEqual(result.booking.benefits,[{kind:'event',id:'E'}]);assert.equal(original.booking.benefits.length,2);
 for(const action of ['admin.booking.type.create','admin.booking.type.update','admin.booking.type.delete']){
  const result=businessResponse({pointCards:[{id:'P'}],serviceTypes:[{rewardPointCardId:'P',rewardMinutesPerPoint:30,price:100}],services:[{id:'S',price:100}]},context({booking:true}),action);
  assert.deepEqual(result.pointCards,[]);assert.equal(result.serviceTypes[0].rewardPointCardId,null);assert.equal(result.services[0].price,100);
 }
});

test('review: saving allowed booking tickets preserves withheld selections at the RPC boundary',async()=>{
 const {assertBusinessRpc}=await policy(),params={p_booking_id:'B',p_selections:[{kind:'event',id:'E2'}]};
 const db=storedDb({booking_benefit_selections:[{booking_id:'B',status:'pending',benefit_kind:'points',benefit_ref:'P'},{booking_id:'B',status:'pending',benefit_kind:'event',benefit_ref:'E1'}]});
 const result=await assertBusinessRpc(context({booking:true,events:true}),'admin_replace_booking_benefit_selections_request',params,db);
 assert.ok(result,'the authorization adapter must return the preserved RPC parameters');
 assert.deepEqual(result.p_selections,[{kind:'event',id:'E2'},{kind:'points',id:'P'}]);assert.equal(params.p_selections.length,1);
});

test('review: unchanged withheld booking rules permit a rename, while forged clearing is rejected',async()=>{
 const {prepareBusinessAction,assertBusinessAction}=await policy();assert.equal(typeof prepareBusinessAction,'function');
 const db=storedDb({event_tickets:[{event_ticket_id:'E',updated_at:'v1',required_service_ids:['S'],required_service_match_mode:'all',required_service_groups:[]}],point_cards:[{card_id:'P',id:'uuid',updated_at:'v2'}],point_card_rewards:[{point_card_id:'uuid',threshold_stamps:5,required_service_ids:['S'],required_service_match_mode:'all',required_service_groups:[]}],fixed_ticket_templates:[{fixed_ticket_id:'F',calendar_enabled:true}],booking_service_type_rewards:[{service_type_id:'T',point_card_id:'P',minutes_per_point:30}]});
 for(const [action,body,features] of [
  ['admin.event-tickets.save',{eventTicket:{eventTicketId:'E',title:'New',requiredServiceIds:['S'],requiredServiceMatchMode:'all',requiredServiceGroups:[]}},{events:true}],
  ['admin.pointcards.save',{card:{cardId:'P',title:'New',rewards:[{thresholdStamps:5,ticketTemplateId:'TT',requiredServiceIds:['S'],requiredServiceMatchMode:'all',requiredServiceGroups:[]}]}},{points:true}],
 ]){
  const result=await prepareBusinessAction(context(features),action,body,db);
  assert.doesNotThrow(()=>assertBusinessAction(context(features),action,result.policyBody));
  assert.equal((result.body.eventTicket||result.body.card).title,'New');
  const forged=structuredClone(body);const rule=forged.eventTicket||forged.card.rewards[0];rule.requiredServiceIds=[];
  await assert.rejects(prepareBusinessAction(context(features),action,forged,db),e=>e.code==='FEATURE_DISABLED');
 }
 const result=await prepareBusinessAction(context({events:true}),'admin.event-tickets.save',{eventTicket:{eventTicketId:'E',title:'New'}},db);
 assert.deepEqual(result.body.eventTicket.requiredServiceIds,['S']);assert.equal(result.body.expectedUpdatedAt,'v1');
 await assert.rejects(prepareBusinessAction(context({booking:true}),'admin.booking.type.update',{typeId:'T',name:'New',rewardPointCardId:null,rewardMinutesPerPoint:null},db),e=>e.code==='FEATURE_DISABLED');
 await assert.rejects(prepareBusinessAction(context({events:true}),'admin.fixed-tickets.save',{template:{fixedTicketId:'F',calendarEnabled:false}},db),e=>e.code==='FEATURE_DISABLED');
 await assert.doesNotReject(prepareBusinessAction(context({events:true}),'admin.fixed-tickets.save',{template:{calendarEnabled:false}},db));
});
