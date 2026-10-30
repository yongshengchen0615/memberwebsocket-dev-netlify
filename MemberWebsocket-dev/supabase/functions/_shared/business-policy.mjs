import { tenantExpired } from './tenant-access.mjs';
// One server-side action map for every existing management/member endpoint.
// Unknown scoped actions fail closed. Bootstrap/session are workspace operations.
export const businessFeatures=['membership','points','events','calendar','integrations','booking','testing','usage'];
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
  const feature={points:'points',event:'events',calendar:'calendar'}[benefit?.kind];
  if(feature)features.push(feature);
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
 const foundation=/^admin\.terms\.|^user\.member\.(bootstrap|profile\.save|terms\.accept)$/.test(action)
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
 const benefitAllowed=item=>features[({points:'points',event:'events',calendar:'calendar'})[item?.kind]]===true;
 if(action==='user.booking.benefits'||action==='admin.booking.benefits.list'){
  for(const key of ['items','benefits','selectedBenefits'])if(Array.isArray(out[key]))out[key]=out[key].filter(benefitAllowed);
  if(data.catalog)out.catalog={...data.catalog,items:(data.catalog.items||[]).filter(benefitAllowed)};
 }
 if(action==='admin.booking.manage.bootstrap'&&features.points!==true){
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

// The caller supplies the already tenant-scoped database client. Inspect stored
// dependencies before invoking a settlement RPC: revocation must also cover
// selections/rules saved before the current request, not just its JSON body.
export async function assertBusinessRpc(context,name,params={},db){
 const f=context.features||{};
 const requireFeature=feature=>{if(f[feature]!==true)throw Object.assign(Error('總管理員尚未核准這項功能，請聯絡總管理員。'),{code:'FEATURE_DISABLED',status:403});};
 const read=async query=>{const result=await query;if(result.error)throw Object.assign(Error('目前無法確認連動功能權限。'),{code:'BUSINESS_ACCESS_UNAVAILABLE',status:503});return result.data||[];};
 if(name==='issue_fixed_tickets'&&f.calendar!==true){
  if((await read(db.from('fixed_ticket_templates').select('calendar_enabled').eq('status','active').eq('calendar_enabled',true))).length)requireFeature('calendar');
 }
 if(name==='grant_member_benefits_with_event_bonus'&&f.calendar!==true&&params.p_points?.length){
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Taipei'});
  const items=await read(db.from('calendar_items').select('starts_on,ends_on,bonus_points').eq('status','active').eq('bonus_points_enabled',true));
  if(items.some(item=>Number(item.bonus_points)>0&&item.starts_on<=today&&(item.ends_on||item.starts_on)>=today))requireFeature('calendar');
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
