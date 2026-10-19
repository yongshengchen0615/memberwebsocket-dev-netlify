// One server-side action map for every existing management/member endpoint.
// Unknown scoped actions fail closed. Bootstrap/session are workspace operations.
export const businessFeatures=['membership','points','events','calendar','integrations','booking','testing','usage'];
export function actionFeatures(action,body={}) {
 if(['admin.bootstrap','admin.session.claim','admin.session.logout','admin.summary','public.status','session.status'].includes(action)
   || /^user\.[a-z]+\.session\.(claim|status|logout)$/.test(action))return [];
 if(action==='admin.settings.copy')return [({card:'points',pointcard:'points',point_card:'points',ticket:'points',event:'events',event_ticket:'events',calendar:'calendar',calendar_item:'calendar',fixed:'events',fixed_ticket:'events'})[body.kind]||'integrations'];
 if(action==='admin.member-grants.add')return [...new Set([...(body.points?.length||body.cardId?['points']:[]),...(Number(body.serviceTime?.minutes||body.serviceMinutes||body.serviceTimeMinutes)>0?['membership']:[])])];
 if(action==='admin.service-grants.add'||action==='admin.service-grants.catalog'||action==='admin.service-grants.preview')return ['membership','points'];
 if(action.startsWith('admin.booking.')||action.startsWith('user.booking.'))return ['booking'];
 if(/^admin\.(test-|e2e-)/.test(action)||action.startsWith('test-mode.')||action.startsWith('user.qa.'))return ['testing'];
 if(action==='admin.audit.query'||action==='admin.member-records.list')return ['usage'];
 if(action==='admin.integration-overview')return ['integrations'];
 if(/^admin\.(pointcards?|tickets|stamps)\./.test(action)||action.startsWith('user.pointcard'))return ['points'];
 if(/^admin\.(event-|fixed-tickets)/.test(action)||/^user\.event/.test(action))return ['events'];
 if(action.startsWith('admin.calendar-items.')||action.startsWith('user.calendar.'))return ['calendar'];
 if(/^admin\.(member[.s-]|terms\.|service_minutes\.|grant-message-presets\.)/.test(action)||action.startsWith('user.member.')||action.startsWith('member.'))return ['membership'];
 if(action==='admin.ticket-visibility.get'||action==='admin.ticket-visibility.save')return ['points','events'];
 return null;
}
export function assertBusinessAction(context,action,body={}) {
 if(context.status!=='active'||!/^business_[a-f0-9]{32}$/.test(context.runtime_schema||''))throw Object.assign(Error('此商家已停用或尚未完成開通。'),{code:'TENANT_SUSPENDED',status:403});
 const features=actionFeatures(action,body);
 if(features&&Array.isArray(body.benefits))for(const benefit of body.benefits){if(benefit?.kind==='points')features.push('points');if(benefit?.kind==='event')features.push('events');}
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
