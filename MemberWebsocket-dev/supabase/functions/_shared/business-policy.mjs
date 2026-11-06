import { tenantExpired } from './tenant-access.mjs';
// One server-side action map for every existing management/member endpoint.
// Unknown scoped actions fail closed. Bootstrap/session are workspace operations.
export const businessFeatures=['membership','points','events','calendar','integrations','booking','testing','usage'];
const benefitFeature=kind=>({points:'points',event:'events',calendar:'calendar'})[String(kind||'').trim().toLowerCase()];
const disabled=()=>Object.assign(Error('總管理員尚未核准這項功能，請聯絡總管理員。'),{code:'FEATURE_DISABLED',status:403});
function primaryFeatures(action,body={}) {
 if(action==='admin.sync.status')return [];
 const sync=/^user\.(member|points|event|calendar|booking)\.sync\.status$/.exec(action);
 if(sync)return [({member:'membership',points:'points',event:'events',calendar:'calendar',booking:'booking'})[sync[1]]];
 if(['admin.bootstrap','admin.session.claim','admin.session.logout','admin.summary','public.status','session.status'].includes(action)
   || /^user\.[a-z]+\.session\.(claim|status|logout)$/.test(action))return [];
 if(action==='admin.settings.copy')return [({card:'points',pointcard:'points',point_card:'points',ticket:'points',event:'events',event_ticket:'events',calendar:'calendar',calendar_item:'calendar',fixed:'events',fixed_ticket:'events'})[body.kind]||'integrations'];
 if(action==='admin.member-grants.add')return [...new Set([...(body.points?.length||body.cardId?['points']:[]),...(Number(body.serviceTime?.minutes||body.serviceMinutes||body.serviceTimeMinutes)>0?['membership']:[])])];
 if(action==='admin.service-grants.add'||action==='admin.service-grants.catalog'||action==='admin.service-grants.preview')return ['membership','points','booking'];
 if(action.startsWith('admin.booking.')||action.startsWith('user.booking.'))return ['booking'];
 if(/^admin\.(test-|e2e-)/.test(action)||action.startsWith('test-mode.')||action.startsWith('user.qa.'))return ['testing'];
 // Retired standalone audit has no grantable business action, even for legacy usage grants.
 if(action==='admin.audit.query')return null;
 // Member-card history is a membership operation, not the retired audit product.
 if(action==='admin.member-records.list')return ['membership'];
 if(action==='admin.integration-overview')return ['integrations'];
 if(/^admin\.(pointcards?|tickets|stamps)\./.test(action)||action.startsWith('user.pointcard'))return ['points'];
 if(/^admin\.(event-|fixed-tickets)/.test(action)||/^user\.event/.test(action))return ['events'];
 if(action.startsWith('admin.calendar-items.')||action.startsWith('user.calendar.'))return ['calendar'];
 if(/^admin\.(member[.s-]|terms\.|service_minutes\.|grant-message-presets\.)/.test(action)||action.startsWith('user.member.')||action.startsWith('member.'))return ['membership'];
 if(action==='admin.ticket-visibility.get'||action==='admin.ticket-visibility.save')return ['points','events'];
 return null;
}
export function actionFeatures(action,body={}) {
 const features=primaryFeatures(action,body);
 if(features===null)return null;
 if(action==='user.booking.event-ticket.claim')features.push('events');
 // Inspect only integration contracts consumed by handlers. Never infer grants
 // from client-supplied feature flags or from names in unrelated free text.
 const benefits=[...(Array.isArray(body.benefits)?body.benefits:[]),
  ...(Array.isArray(body.participants)?body.participants:[]).flatMap(p=>Array.isArray(p?.benefits)?p.benefits:[])];
 for(const benefit of benefits){
  const feature=benefitFeature(benefit?.kind);
  if(!feature)throw Object.assign(Error('票券種類不合法。'),{code:'INVALID_BENEFIT_KIND',status:400});
  features.push(feature);
 }
 if(/^admin\.booking\.type\.(create|update)$/.test(action)
  && (Number(body.rewardMinutesPerPoint)>0||body.rewardPointCardId))features.push('points');
 const calendarItems=[body.calendarItem,...(Array.isArray(body.calendarItemOperations)?body.calendarItemOperations:[]).map(op=>op?.calendarItem)];
 if(action.startsWith('admin.calendar-items.')&&calendarItems.some(item=>Boolean(item?.bonusPointsEnabled)||Number(item?.bonusPoints)>0))features.push('points');
 if(action==='admin.fixed-tickets.save'&&Boolean(body.template?.calendarEnabled))features.push('calendar');
 const restrictions=[body.eventTicket,...(Array.isArray(body.card?.rewards)?body.card.rewards:[])];
 if(['admin.event-tickets.save','admin.pointcards.save'].includes(action)&&restrictions.some(item=>
  item?.requiredServiceIds?.length||item?.requiredServiceGroups?.length||item?.requiredServiceTypes?.length))features.push('booking');
 return [...new Set(features)];
}
export function assertBusinessAction(context,action,body={},now=Date.now()) {
 if(context.status!=='active'||!/^business_[a-f0-9]{32}$/.test(context.runtime_schema||''))throw Object.assign(Error('此商家已停用或尚未完成開通。'),{code:'TENANT_SUSPENDED',status:403});
 if(tenantExpired(context,now))throw Object.assign(Error('使用期限已到，請聯絡總管理員。'),{code:'TENANT_EXPIRED',status:403});
 const features=actionFeatures(action,body);
 if(features===null)throw Object.assign(Error('此功能尚未取得商家授權。'),{code:'FEATURE_ACTION_UNMAPPED',status:403});
 if(/^admin\.booking\.benefits\./.test(action)&&!['points','events'].some(key=>context.features?.[key]===true))throw disabled();
 const foundation=/^admin\.terms\.|^user\.member\.(bootstrap|profile\.save|phone\.send|terms\.accept)$/.test(action)
  && ['membership','points','events','calendar','booking'].some(key=>context.features?.[key]===true);
 if(!foundation&&features.some(feature=>context.features?.[feature]!==true))throw Object.assign(Error('總管理員尚未核准這項功能，請聯絡總管理員。'),{code:'FEATURE_DISABLED',status:403});
}
export function businessBootstrap(data,context){
 const f=context.features||{},out={...data,features:f,business:{slug:context.slug,name:context.name}};
 if(!f.membership){out.members=[];out.memberPage={page:1,pageSize:100,total:0,totalPages:1,query:''};out.tierSettings=[];out.messagePresets=[];}
 if(!f.points){out.cards=[];out.tickets=[];}
 if(!f.events)out.eventTickets=[];
 if(!f.calendar)out.calendarItems=[];
 if(!f.booking){out.bookingServices=[];out.bookingServiceTypes=[];}
 out.stats={};
 return out;
}
export function businessResponse(data,context,action){
 if(action==='admin.bootstrap')return businessBootstrap(data,context);
 const features=context.features||{},out={...data};
 const benefitAllowed=item=>features[benefitFeature(item?.kind)]===true;
 if(/^(admin|user)\.booking\./.test(action)){
  const scrub=booking=>booking&&typeof booking==='object'?{...booking,...(Array.isArray(booking.benefits)?{benefits:booking.benefits.filter(benefitAllowed)}:{})}:booking;
  if(data.booking)out.booking=scrub(data.booking);
  if(Array.isArray(data.bookings))out.bookings=data.bookings.map(scrub);
 }
 if(action==='user.booking.benefits'||action==='admin.booking.benefits.list'){
  for(const key of ['items','benefits','selectedBenefits'])if(Array.isArray(out[key]))out[key]=out[key].filter(benefitAllowed);
  if(data.catalog)out.catalog={...data.catalog,items:(data.catalog.items||[]).filter(benefitAllowed)};
 }
 if((action==='admin.booking.manage.bootstrap'||/^admin\.booking\.type\.(create|update|delete)$/.test(action))&&features.points!==true){
  out.pointCards=[];
  out.serviceTypes=(data.serviceTypes||[]).map(type=>({...type,rewardPointCardId:null,rewardPointCardTitle:'',rewardMinutesPerPoint:null}));
 }
 if(action==='admin.member-records.list'){
  out.records={...data.records};out.counts={...data.counts};
  for(const [key,feature]of Object.entries({pointCards:'points',eventTickets:'events',calendar:'calendar',bookings:'booking',testAutomation:'testing'})){
   if(features[feature]!==true){out.records[key]=[];out.counts[key]=0;}
  }
 }
 return out;
}

// Existing hidden rules are read-only after revocation. Compare against trusted
// tenant rows, preserve omitted fields, and pin the existing optimistic lock.
export async function prepareBusinessAction(context,action,body,db){
 const f=context.features||{};
 if(!(f.booking!==true&&['admin.event-tickets.save','admin.pointcards.save'].includes(action))
  &&!(f.points!==true&&action==='admin.booking.type.update')&&!(f.calendar!==true&&action==='admin.fixed-tickets.save'))return {body,policyBody:body};
 const forward=structuredClone(body),policyBody=structuredClone(body);
 const read=async query=>{const result=await query;if(result.error)throw Object.assign(Error('目前無法確認連動功能權限。'),{code:'BUSINESS_ACCESS_UNAVAILABLE',status:503});return result.data||[];};
 const rules=['requiredServiceIds','requiredServiceMatchMode','requiredServiceGroups','requiredServiceTypes'];
 const preserve=(input,policy,row={})=>{
  const stored={requiredServiceIds:row.required_service_ids||[],requiredServiceGroups:row.required_service_groups||[],requiredServiceMatchMode:row.required_service_groups?.length?'groups':row.required_service_match_mode||'any',requiredServiceTypes:[]};
  for(const key of rules){
   if(Object.hasOwn(input,key)&&JSON.stringify(input[key])!==JSON.stringify(stored[key]))throw disabled();
   input[key]=stored[key];delete policy[key];
  }
 };
 if(f.booking!==true&&action==='admin.event-tickets.save'){
  const input=forward.eventTicket||{};
  const rows=input.eventTicketId?await read(db.from('event_tickets').select('required_service_ids,required_service_groups,required_service_match_mode,updated_at').eq('event_ticket_id',input.eventTicketId)):[];
  preserve(input,policyBody.eventTicket||{},rows[0]);
  if(rows[0]&&!forward.expectedUpdatedAt)forward.expectedUpdatedAt=rows[0].updated_at;
 }
 if(f.booking!==true&&action==='admin.pointcards.save'){
  const card=forward.card||{};
  const cards=card.cardId?await read(db.from('point_cards').select('id,updated_at').eq('card_id',card.cardId)):[];
  const rewards=cards[0]?await read(db.from('point_card_rewards').select('threshold_stamps,required_service_ids,required_service_groups,required_service_match_mode').eq('point_card_id',cards[0].id)):[];
  for(const [index,reward]of (Array.isArray(card.rewards)?card.rewards:[]).entries())preserve(reward,policyBody.card.rewards[index],rewards.find(row=>Number(row.threshold_stamps)===Number(reward.thresholdStamps)));
  if(cards[0]&&!forward.expectedUpdatedAt)forward.expectedUpdatedAt=cards[0].updated_at;
 }
 if(f.points!==true&&action==='admin.booking.type.update'&&['rewardPointCardId','rewardMinutesPerPoint'].some(key=>Object.hasOwn(body,key))){
  if((await read(db.from('booking_service_type_rewards').select('service_type_id').eq('service_type_id',body.typeId))).length)throw disabled();
 }
 if(f.calendar!==true&&action==='admin.fixed-tickets.save'&&body.template?.fixedTicketId&&Object.hasOwn(body.template,'calendarEnabled')){
  const rows=await read(db.from('fixed_ticket_templates').select('calendar_enabled').eq('fixed_ticket_id',body.template.fixedTicketId));
  if(rows[0]?.calendar_enabled===true&&!body.template.calendarEnabled)throw disabled();
 }
 return {body:forward,policyBody};
}

// The caller supplies the already tenant-scoped database client. Inspect stored
// dependencies before invoking a settlement RPC: revocation must also cover
// selections/rules saved before the current request, not just its JSON body.
export async function assertBusinessRpc(context,name,params={},db){
 const f=context.features||{};
 const requireFeature=feature=>{if(f[feature]!==true)throw Object.assign(Error('總管理員尚未核准這項功能，請聯絡總管理員。'),{code:'FEATURE_DISABLED',status:403});};
 const read=async query=>{const result=await query;if(result.error)throw Object.assign(Error('目前無法確認連動功能權限。'),{code:'BUSINESS_ACCESS_UNAVAILABLE',status:503});return result.data||[];};
 if(name==='issue_fixed_tickets'&&f.calendar!==true){
  let query=db.from('fixed_ticket_templates').select('calendar_enabled').eq('status','active').eq('calendar_enabled',true);
  if(params.p_template_id)query=query.eq('id',params.p_template_id);
  if(params.p_fixed_ticket_id)query=query.eq('fixed_ticket_id',params.p_fixed_ticket_id);
  if((await read(query)).length)requireFeature('calendar');
 }
 if(name==='admin_replace_booking_benefit_selections_request'){
  const current=await read(db.from('booking_benefit_selections').select('benefit_kind,benefit_ref').eq('booking_id',params.p_booking_id).eq('status','pending'));
  const withheld=current.filter(row=>f[benefitFeature(row.benefit_kind)]!==true).map(row=>({kind:row.benefit_kind,id:row.benefit_ref}));
  return {...params,p_selections:[...(params.p_selections||[]),...withheld]};
 }
 if(name==='grant_member_benefits_with_event_bonus'&&f.calendar!==true&&params.p_points?.length){
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Taipei'});
  const items=(await read(db.from('calendar_items').select('starts_on,ends_on,bonus_points,allowed_tier_keys').eq('item_type','event').eq('status','active').eq('bonus_points_enabled',true)))
   .filter(item=>Number(item.bonus_points)>0&&item.starts_on<=today&&(item.ends_on||item.starts_on)>=today);
  if(items.length){
   const members=await read(db.from('members').select('id').eq('line_user_id',params.p_member_line_user_id));
   if(members[0]){
    const tier=await db.rpc('current_tier_key',{p_member_id:members[0].id});
    if(tier.error)throw Object.assign(Error('目前無法確認連動功能權限。'),{code:'BUSINESS_ACCESS_UNAVAILABLE',status:503});
    if(items.some(item=>!item.allowed_tier_keys?.length||item.allowed_tier_keys.includes(String(tier.data||'general'))))requireFeature('calendar');
   }
  }
 }
 const settlement=['complete_booking_with_benefits_request','complete_booking_with_rewards_request','admin_confirm_booking_receipt_request','correct_completed_booking_request','register_snapshot_receipt_v2'].includes(name);
 if(!settlement||['membership','points','events','calendar'].every(key=>f[key]===true))return;
 const bookingId=params.p_booking_id;
 let items=[];
 if(bookingId){
  const [stored,selections]=await Promise.all([
   read(db.from('booking_items').select('service_type,counts_toward_membership').eq('booking_id',bookingId)),
   read(db.from('booking_benefit_selections').select('benefit_kind').eq('booking_id',bookingId).eq('status','pending')),
  ]);
  items=stored;
  for(const selection of selections){const feature={points:'points',event:'events',calendar:'calendar'}[selection.benefit_kind];if(feature)requireFeature(feature);}
 }
 for(const benefit of Array.isArray(params.p_benefits)?params.p_benefits:[]){const feature={points:'points',event:'events',calendar:'calendar'}[benefit?.kind];if(feature)requireFeature(feature);}
 const proposed=[...(Array.isArray(params.p_items)?params.p_items:[]),...(Array.isArray(params.p_participants)?params.p_participants:[]).flatMap(p=>Array.isArray(p?.items)?p.items:[])];
 const serviceIds=[...new Set(proposed.map(item=>item?.serviceId).filter(Boolean))];
 if(serviceIds.length)items.push(...await read(db.from('booking_services').select('service_type,counts_toward_membership').in('id',serviceIds)));
 if(items.some(item=>item.counts_toward_membership!==false))requireFeature('membership');
 if(f.points!==true&&items.length){
  const keys=new Set(items.map(item=>String(item.service_type||'').trim().toLowerCase()));
  const types=await read(db.from('booking_service_types').select('id,name'));
  const ids=types.filter(type=>keys.has(String(type.name||'').trim().toLowerCase())).map(type=>type.id);
  if(ids.length&&(await read(db.from('booking_service_type_rewards').select('service_type_id').in('service_type_id',ids))).length)requireFeature('points');
 }
 // Corrections can reverse points awarded by a historical settlement even
 // after the original reward rule has been removed.
 if(name==='correct_completed_booking_request'&&f.points!==true&&bookingId){
  const settlements=await read(db.from('booking_completion_settlements').select('reward_details,correction_context').eq('booking_id',bookingId));
  const adjustments=await read(db.from('booking_completion_adjustments').select('after_settlement').eq('booking_id',bookingId));
  if(settlements.some(row=>row.reward_details?.length||row.correction_context?.rules?.length)
   ||adjustments.some(row=>row.after_settlement?.rewards?.length||row.after_settlement?.friendRewards?.length))requireFeature('points');
 }
}
