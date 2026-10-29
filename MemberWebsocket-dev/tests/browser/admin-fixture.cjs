// Local-only transport fixture. The HTML, CSS and all UI handlers are production
// files; only authentication, external services and persistence are substituted.
// Never imported by a deployed page. Unknown API calls fail closed.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const tiers = ['general', 'silver', 'gold', 'platinum'];
const version = '2026-10-04T00:00:00.000Z';
const today = () => new Date().toLocaleDateString('en-CA', {timeZone:'Asia/Taipei'});
function fixture() {
  const ticket = {ticketTemplateId:'ticket-1',title:'QA coupon',ticketType:'coupon',description:'QA description',usageMethod:'QA usage',usageInstructions:'QA instructions',status:'active',updatedAt:version,prizes:[],redemptionLocations:[]};
  const card = n => ({cardId:'card-'+n,title:'QA card '+n,status:'active',styleKey:'denim',pointCardStyleKey:'denim',expiryMode:'unlimited',expiresOn:'',accent:'#df6b4d',usageMethod:'QA',usageInstructions:'QA',benefitDescription:'QA',updatedAt:version,sortOrder:n,rewards:[{thresholdStamps:5,ticketTemplateId:'ticket-1',requiredServiceIds:[],requiredServiceMatchMode:'any'}]});
  const member = n => ({memberId:'member-'+n,lineUserId:'test:member-'+n,memberCode:'TEST'+n,displayName:'QA Member '+n,surname:'QA',salutation:'mr',birthday:'1980-01-01',phone:'+886912345678',status:'active',isTestAccount:true,membershipStatus:'active',tierKey:'general',tier:'一般會員',serviceMinutesTotal:0,joinedAt:version,updatedAt:version,isOnline:true,onlineSurfaces:['member']});
  return {
    testSettings:{maintenanceEnabled:true,allowPcTestLogin:true,allowMobileTestLogin:true,allowDuplicateTestLogin:true},serviceGrantResults:{},
    visibilityPolicy:'eligible_only',visibilityVersion:version,copies:{},calls:[],unexpected:[],fault:null,hold:null,seq:10,receiptResults:{},settlements:[],
    members:[member(1),member(2),member(3)],cards:[card(1),card(2)],tickets:[ticket],eventTickets:[],calendarItems:[],messagePresets:[],templates:[],
    tierSettings:tiers.map((tierKey,i)=>({tierKey,requiredServiceMinutes:i*100,styleKey:'forest'})),
    terms:[{id:'terms-1',version:'1',title:'QA terms',summary:'QA summary',body:'QA terms body',effectiveAt:version,status:'active',required:true,reconsentExisting:false}],
    limits:{'pointcard-extension-api':{maxTicketsPerRedemption:1,updatedAt:version},'event-ticket-extension-api':{maxTicketsPerDay:1,updatedAt:version}},
    settings:{workStartTime:'09:00',workEndTime:'18:00',minAdvanceDays:0,maxAdvanceDays:60,slotIntervalMinutes:30,storeServiceMinutes:10,bookingNotice:'QA notice',closedWeekdays:[],updatedAt:version,maxPartySize:2,primaryTechnicianId:'tech-1'},
    serviceTypes:[{id:'type-1',name:'Body',sortOrder:0}],
    services:[{serviceId:'service-1',title:'QA service',serviceType:'Body',durationMinutes:30,priceAmount:100,isActive:true,updatedAt:version,rewardRules:[]},{serviceId:'service-2',title:'QA second service',serviceType:'Body',durationMinutes:30,priceAmount:200,isActive:true,updatedAt:version,rewardRules:[]}],
    technicians:[{technicianId:'tech-1',name:'QA primary',sortOrder:0,isActive:true,updatedAt:version},{technicianId:'tech-2',name:'QA secondary',sortOrder:1,isActive:true,updatedAt:version}],
    bookings:[],groups:{},benefitCatalog:{items:[]},receipts:[],submissions:[],accessibleRecords:[],grants:[],
  };
}
function transport(s, action, p={}, slug='api',record=true) {
  if(record)s.calls.push({action,payload:structuredClone(p),slug});
  if(s.hold?.action===action&&action!=='admin.booking.receipt.register'){const wait=s.hold.wait;s.hold=null;return wait.then(()=>transport(s,action,p,slug,false));}
  if(s.fault && !s.fault.afterCommit && s.fault.action===action && (!s.fault.onCall || s.calls.filter(c=>c.action===action).length===s.fault.onCall)){const f=s.fault;s.fault=null;throw Object.assign(new Error(f.message||'QA rejected write'),{code:f.code||'CONFLICT'});}
  const stamp=()=>new Date(Date.parse(version)+(++s.seq)*1000).toISOString();
  const save=(table,key,value)=>{const row={...value,[key]:value[key]||'qa-'+(++s.seq),updatedAt:stamp()};const i=s[table].findIndex(x=>x[key]===row[key]);if(i<0)s[table].push(row);else s[table][i]=row;return structuredClone(row);};
  const del=(table,key,id)=>{s[table]=s[table].filter(x=>x[key]!==id);return {deleted:true};};
  const page=()=>{const members=s.members.filter(m=>!p.memberQuery||JSON.stringify(m).toLowerCase().includes(p.memberQuery.toLowerCase()));const n=p.memberPage||1;return {members:members.slice((n-1)*2,n*2),memberPage:{page:n,pageSize:2,total:members.length,totalPages:Math.max(1,Math.ceil(members.length/2)),query:p.memberQuery||''}};};
  const bootstrap=()=>({...page(),profile:{displayName:'QA Admin'},role:'Admin',tierSettings:s.tierSettings,cards:s.cards,tickets:s.tickets,eventTickets:s.eventTickets,calendarItems:s.calendarItems,messagePresets:s.messagePresets,bookingServices:s.services,stats:{memberCount:s.members.length,activeMemberCount:s.members.length,activeCardCount:s.cards.length,todayEntryCount:0,activeEventTicketCount:s.eventTickets.length}});
  if(action==='admin.ticket-visibility.get')return {visibilityPolicy:s.visibilityPolicy,updatedAt:s.visibilityVersion};
  if(action==='admin.ticket-visibility.save'){if(p.expectedUpdatedAt!==s.visibilityVersion)throw Object.assign(new Error('設定已更新'),{code:'CONFLICT'});s.visibilityPolicy=p.visibilityPolicy;s.visibilityVersion=stamp();return {visibilityPolicy:s.visibilityPolicy,updatedAt:s.visibilityVersion};}
  if(action==='admin.settings.copy'){
    if(s.copies[p.requestId])return s.copies[p.requestId];
    const [table,key]=({card:['cards','cardId'],ticket:['tickets','ticketTemplateId'],event:['eventTickets','eventTicketId'],fixed:['templates','fixedTicketId']})[p.kind];
    const source=s[table].find(x=>x[key]===p.sourceId);if(!source)throw new Error('COPY_SOURCE_NOT_FOUND');
    const row=save(table,key,{...structuredClone(source),[key]:'',title:p.title,status:'draft',...(p.kind==='fixed'?{notifyLine:false,calendarEnabled:false}:{})});
    if(p.kind==='card')row.rewards=row.rewards.map(reward=>{const template=s.tickets.find(t=>t.ticketTemplateId===reward.ticketTemplateId);const child=save('tickets','ticketTemplateId',{...template,ticketTemplateId:'',status:'draft'});return {...reward,ticketTemplateId:child.ticketTemplateId};});
    s[table][s[table].length-1]=row;return s.copies[p.requestId]={publicId:row[key],status:'draft',kind:p.kind};
  }
  if(action==='admin.test-mode.bootstrap')return {settings:s.testSettings,accounts:s.members.filter(m=>m.isTestAccount)};
  if(action==='admin.test-mode.save'){
    Object.assign(s.testSettings,{maintenanceEnabled:p.maintenanceEnabled,allowPcTestLogin:p.allowPcTestLogin,allowMobileTestLogin:p.allowMobileTestLogin,allowDuplicateTestLogin:p.allowDuplicateTestLogin});
    const n=++s.seq;const template=s.members[0];s.members.push({...template,memberId:'member-'+n,lineUserId:'test:member-'+n,memberCode:'TEST'+n,serviceMinutesTotal:0});return {settings:s.testSettings,accounts:s.members.filter(m=>m.isTestAccount)};
  }
  if(action==='admin.test-mode.delete-accounts'){const count=s.members.length;s.members=s.members.filter(m=>!p.memberIds.includes(m.memberId));return {deletedAccountCount:count-s.members.length};}
  if(action==='admin.service-grants.catalog')return {services:s.services.filter(x=>x.isActive).map(x=>({...x,countsTowardMembership:true,requiresCompanionService:false}))};
  if(action==='admin.service-grants.preview' || action==='admin.service-grants.add'){
    const member=s.members.find(m=>m.lineUserId===p.lineUserId);
    const items=p.items.map(item=>({...s.services.find(service=>service.serviceId===item.serviceId),quantity:item.quantity}));
    const minutes=items.reduce((n,i)=>n+i.durationMinutes*i.quantity,0);
    const preview={items,serviceMinutes:minutes,totalMinutes:minutes,points:[{cardId:'card-1',cardTitle:'QA card 1',amount:Math.floor(minutes/30)}],rules:[]};
    if(action.endsWith('preview'))return {preview};
    if(s.serviceGrantResults[p.requestId])return {...s.serviceGrantResults[p.requestId],alreadyApplied:true};
    if(JSON.stringify(p.expectedPreview)!==JSON.stringify(preview))throw Object.assign(new Error('預覽已變更'),{code:'SERVICE_GRANT_PREVIEW_STALE'});
    member.serviceMinutesTotal+=minutes;s.grants.push(structuredClone(p));const result={member,grant:{preview},notification:{status:'suppressed'}};s.serviceGrantResults[p.requestId]=structuredClone(result);
    if(s.fault?.action===action&&s.fault.afterCommit){const f=s.fault;s.fault=null;throw Object.assign(new Error('QA response lost after commit'),{code:f.code});}
    return result;
  }
  if(action==='admin.bootstrap'  ||action==='admin.summary')return bootstrap();
  if(action==='admin.members.list')return page();
  if(action==='admin.members.presence.list')return {members:s.members};
  if(action==='admin.member.update'){const m=s.members.find(m=>m.lineUserId===p.lineUserId);return {member:save('members','memberId',{...m,...p,...p.profile})};}
  if(action==='admin.member.remove'){const m=s.members.find(m=>m.lineUserId===p.lineUserId);if(m.memberCode!==p.confirmMemberCode)throw Object.assign(new Error('confirmation mismatch'),{code:'CONFIRMATION_MISMATCH'});s.members=s.members.filter(m=>m.lineUserId!==p.lineUserId);return {state:'complete',jobId:'qa-removal'};}
  if(action==='admin.member.force-logout'){s.members.find(m=>m.lineUserId===p.lineUserId).isOnline=false;return {revoked:true};}
  if(action==='admin.member-tiers.save'){s.tierSettings=p.tierSettings;return bootstrap();}
  if(action==='admin.member-records.list')return {member:s.members.find(m=>m.lineUserId===p.lineUserId),records:[],pointCards:[],eventTickets:[],bookings:[],calendar:[],testAutomation:[],presence:[],summary:{}};
  if(action==='admin.member-grants.add'){s.grants.push(p);return {member:s.members.find(m=>m.memberId===p.memberId),grants:p.points||[],serviceMinutesAdded:p.serviceMinutes||0};}
  if(action==='admin.grant-message-presets.save'){const messagePreset=save('messagePresets','presetId',p.messagePreset);return {messagePreset,messagePresets:s.messagePresets};}
  if(action==='admin.terms.list')return {terms:s.terms};
  if(action==='admin.terms.draft.save')return save('terms','id',{...p,status:'draft'});
  if(action==='admin.terms.activate'){s.terms.forEach(t=>t.status=t.id===p.id?'active':'archived');return {id:p.id};}
  if(action==='admin.pointcards.list')return bootstrap();
  if(action==='admin.pointcards.save')return {card:save('cards','cardId',p.card)};
  if(action==='admin.pointcards.archive')return {card:save('cards','cardId',{...s.cards.find(c=>c.cardId===p.cardId),status:'archived'})};
  if(action==='admin.pointcards.delete')return del('cards','cardId',p.cardId);
  if(action==='admin.pointcards.reorder'){s.cards=p.cardOrders.map(x=>({...s.cards.find(c=>c.cardId===x.cardId),sortOrder:x.sortOrder,updatedAt:stamp()}));return {cards:s.cards};}
  if(action==='admin.tickets.save')return {ticket:save('tickets','ticketTemplateId',p.ticket)};
  if(action==='admin.tickets.delete'){
    const row=s.tickets.find(t=>t.ticketTemplateId===p.ticketTemplateId);
    if(!row)throw Object.assign(new Error('找不到指定的集點卡票券。'),{code:'TICKET_TEMPLATE_DELETE_NOT_FOUND'});
    if(row.updatedAt!==p.expectedUpdatedAt)throw Object.assign(new Error('票券已被其他管理者更新，請重新整理。'),{code:'CONFLICT'});
    if(s.cards.some(card=>(card.rewards||[]).some(reward=>reward.ticketTemplateId===p.ticketTemplateId)))
      throw Object.assign(new Error('這張票券仍被集點卡兌換節點引用，請先從相關集點卡移除該節點後再刪除。'),{code:'TICKET_TEMPLATE_IN_USE'});
    del('tickets','ticketTemplateId',p.ticketTemplateId);
    return {deleted:true,ticketTemplateId:p.ticketTemplateId,preservedTicketCount:0};
  }
  if(action==='admin.event-tickets.list')return bootstrap();
  if(action==='admin.event-tickets.save')return {eventTicket:save('eventTickets','eventTicketId',p.eventTicket)};
  if(action==='admin.event-tickets.delete')return del('eventTickets','eventTicketId',p.eventTicketId);
  if(action==='admin.calendar-items.list')return {calendarItems:s.calendarItems};
  if(action==='admin.calendar-items.save')return {calendarItem:save('calendarItems','calendarItemId',p.calendarItem)};
  if(action==='admin.calendar-items.delete')return del('calendarItems','calendarItemId',p.calendarItemId);
  if(action==='admin.calendar-items.batch'){const savedCalendarItems=[],deletedCalendarItemIds=[];for(const op of p.calendarItemOperations){if(op.operation==='delete'){del('calendarItems','calendarItemId',op.calendarItemId);deletedCalendarItemIds.push(op.calendarItemId);}else savedCalendarItems.push(save('calendarItems','calendarItemId',op.calendarItem));}return {savedCalendarItems,deletedCalendarItemIds};}
  if(action==='admin.settings.get')return s.limits[slug];
  if(action==='admin.settings.save'){s.limits[slug]={...s.limits[slug],...p,updatedAt:stamp()};return s.limits[slug];}
  if(action==='admin.fixed-tickets.list')return {templates:s.templates};
  if(action==='admin.fixed-tickets.save'){const template=save('templates','fixedTicketId',p.template);return {template,templates:s.templates,run:{issued:0,queued:0}};}
  if(action==='admin.fixed-tickets.run')return {templates:s.templates,run:{issued:1,queued:0}};
  if(action==='admin.fixed-tickets.delete'){del('templates','fixedTicketId',p.fixedTicketId);return {templates:s.templates};}
  if(action==='admin.booking.summary')return {pendingCount:s.bookings.filter(b=>b.status==='pending').length,unreadCount:1,latestNotificationId:1,accessibleReceiptPendingCount:s.submissions.length};
  if(action==='admin.booking.notifications.read')return {unreadCount:0,latestNotificationId:1};
  if(action==='admin.booking.bootstrap')return {settings:s.settings,bookings:s.bookings};
  if(action==='admin.booking.manage.bootstrap')return {settings:s.settings,services:s.services,serviceTypes:s.serviceTypes,pointCards:s.cards.map(c=>({...c,id:c.cardId}))};
  if(action==='admin.booking.resources.bootstrap')return {settings:s.settings,technicians:s.technicians};
  if(action==='admin.booking.contacts')return {contacts:s.bookings.filter(b=>p.bookingIds?.includes(b.bookingId) && b.bookingSource==='phone').map(b=>({
    bookingId:b.bookingId,contactSource:'custom',contactSurname:b.contactSurname,
    contactSalutation:b.contactSalutation,contactPhone:b.contactPhone
  }))};
  if(action==='admin.booking.group.details')return {bookingGroups:s.groups,technicians:s.technicians,primaryTechnicianId:s.settings.primaryTechnicianId};
  if(action==='admin.booking.settings.save'||action==='admin.booking.resources.settings.save'){s.settings={...s.settings,...p,updatedAt:stamp()};return {settings:s.settings};}
  if(action==='admin.booking.resources.technician.save')return {technician:save('technicians','technicianId',p)};
  if(action==='admin.booking.type.create'||action==='admin.booking.type.update')return {type:save('serviceTypes','id',{...p,id:p.typeId})};
  if(action==='admin.booking.type.delete')return del('serviceTypes','id',p.typeId);
  if(action==='admin.booking.service.save')return {service:save('services','serviceId',p)};
  if(action==='admin.booking.service.delete')return del('services','serviceId',p.serviceId);
  if(action==='admin.booking.services.batch'){for(const op of p.operations){if(op.op==='delete')del('services','serviceId',op.serviceId);else save('services','serviceId',op);}return {services:s.services};}
  if(action==='admin.list')return {requests:s.bookings.filter(b=>b.cancellationRequestedAt)};
  if(action==='admin.approve'||action==='admin.reject'){const b=s.bookings.find(b=>b.bookingId===p.bookingId);if(b){if(action==='admin.approve')b.status='cancelled';b.cancellationRequestedAt=null;}return {booking:b};}
  if(action==='admin.booking.items.update'){const b=s.bookings.find(b=>b.bookingId===p.bookingId);b.items=p.items.map(i=>({...i,serviceTitle:s.services.find(s=>s.serviceId===i.serviceId).title}));b.updatedAt=stamp();return {booking:b};}
  if(action==='admin.booking.completed.preview'||action==='admin.booking.completed.correct'){
    const b=s.bookings.find(b=>b.bookingId===p.bookingId);
    const before=b.items.reduce((n,i)=>n+i.unitDurationMinutes*i.quantity,0);
    const after=p.participants.flatMap(person=>person.items).reduce((n,i)=>n+i.minutes*i.quantity,0);
    const adjustment={before:{serviceMinutes:before,friendRewardMinutes:0},after:{serviceMinutes:after,friendRewardMinutes:0},serviceMinutesDelta:after-before,pointDeltas:[{memberId:b.memberId,cardTitle:'QA card',delta:Math.floor(after/30)-Math.floor(before/30)}]};
    if(action.endsWith('.correct')){b.items=p.participants[0].items.map(i=>({...i,unitDurationMinutes:i.minutes,serviceTitle:s.services.find(x=>x.serviceId===i.serviceId)?.title}));b.updatedAt=stamp();}
    return {adjustment,booking:b};
  }
  if(action==='admin.booking.benefits.list')return {booking:s.bookings.find(b=>b.bookingId===p.bookingId),catalog:s.benefitCatalog};
  if(action==='admin.booking.benefits.update'){const b=s.bookings.find(b=>b.bookingId===p.bookingId);b.benefits=p.benefits.map(i=>({...i,status:'pending',title:'QA selected benefit'}));b.updatedAt=stamp();return {booking:b};}
  if(action==='admin.booking.participants.items.update'||action==='admin.booking.participants.technicians.update'){const group=s.groups[p.bookingId];group.participants=p.participants.map((v,i)=>({...group.participants[i],...v}));s.bookings.find(b=>b.bookingId===p.bookingId).updatedAt=stamp();return {group};}
  if(action==='admin.booking.phone.slots'){
    const storeServiceMinutes=Number(s.settings.storeServiceMinutes??10);
    const requested=(p.items||[]).map(item=>({service:s.services.find(x=>x.serviceId===item.serviceId),quantity:Number(item.quantity||1)}));
    if(!requested.length||requested.some(item=>!item.service))throw Object.assign(new Error('無效項目'),{code:'INVALID_BOOKING_ITEMS'});
    const serviceMinutes=requested.reduce((sum,item)=>sum+Number(item.service.durationMinutes||0)*item.quantity,0);
    const totalDurationMinutes=serviceMinutes+storeServiceMinutes;
    const slots=[];
    const workStart=Number(s.settings.workStartTime.slice(0,2))*60+Number(s.settings.workStartTime.slice(3,5));
    const workEnd=Number(s.settings.workEndTime.slice(0,2))*60+Number(s.settings.workEndTime.slice(3,5))+(s.settings.workEndTime<s.settings.workStartTime?1440:0);
    const toTime=mins=>String(Math.floor(mins/60)%24).padStart(2,'0')+':'+String(mins%60).padStart(2,'0');
    const toDate=mins=>new Date(Date.parse(p.bookingDate+'T00:00:00Z')+(mins>=1440?86400000:0)).toISOString().slice(0,10);
    for(let cursor=workStart;cursor+totalDurationMinutes<=workEnd;cursor+=Number(s.settings.slotIntervalMinutes||30)){
      const start=Date.parse(p.bookingDate+'T00:00:00Z')+cursor*60000;
      const end=start+totalDurationMinutes*60000;
      const overlap=s.bookings.some(b=>{
        if(!['pending','confirmed'].includes(b.status))return false;
        const from=Date.parse(b.bookingDate+'T'+b.startTime+':00Z');
        const until=from+Number(b.totalDurationMinutes||0)*60000;
        return start<until&&end>from;
      });
      slots.push({startTime:toTime(cursor),endTime:toTime(cursor+totalDurationMinutes),startAt:toDate(cursor),endAt:toDate(cursor+totalDurationMinutes),available:!overlap,unavailableReason:overlap?'occupied':null});
    }
    return {slots,totalDurationMinutes,storeServiceMinutes};
  }
  if(action==='admin.booking.phone.create'){
    const old=s.bookings.find(b=>b.requestId===p.requestId);
    if(old)return {bookingId:old.bookingId,bookingSource:'phone',status:old.status};
    const requestedStart=Date.parse(p.bookingDate+'T'+p.startTime+':00Z');
    const requested=p.items.map(item=>({service:s.services.find(x=>x.serviceId===item.serviceId),quantity:Number(item.quantity||1)}));
    if(!requested.length||requested.some(item=>!item.service))throw Object.assign(new Error('無效項目'),{code:'INVALID_BOOKING_ITEMS'});
    const itemMinutes=requested.reduce((sum,item)=>sum+Number(item.service.durationMinutes||0)*item.quantity,0);
    const storeMinutes=Number(s.settings.storeServiceMinutes??10);
    const requestedEnd=requestedStart+(itemMinutes+storeMinutes)*60000;
    const occupied=s.bookings.some(b=>{
      if(!['pending','confirmed'].includes(b.status))return false;
      const from=Date.parse(b.bookingDate+'T'+b.startTime+':00Z');
      const until=from+Number(b.totalDurationMinutes||0)*60000;
      return requestedStart<until&&requestedEnd>from;
    });
    if(occupied)throw Object.assign(new Error('此時段已有預約，請先取消原預約，或選擇其他時段。'),{code:'PHONE_BOOKING_CONFLICT'});

    const bookingId='phone-'+(++s.seq);
    const start=Number(p.startTime.slice(0,2))*60+Number(p.startTime.slice(3,5));
    const end=(start+itemMinutes+storeMinutes)%(24*60);
    const row={
      bookingId,requestId:p.requestId,bookingSource:'phone',memberId:null,memberCode:'',memberDisplayName:'',
      bookingDate:p.bookingDate,startTime:p.startTime,
      endTime:String(Math.floor(end/60)).padStart(2,'0')+':'+String(end%60).padStart(2,'0'),
      status:'confirmed',adminNote:p.adminNote,memberNote:'',
      contactSurname:p.contactSurname,contactSalutation:p.contactSalutation,contactPhone:p.contactPhone,
      totalDurationMinutes:itemMinutes+storeMinutes,totalAmount:requested.reduce((sum,item)=>sum+Number(item.service.priceAmount||0)*item.quantity,0),
      items:requested.map(item=>({serviceId:item.service.serviceId,serviceTitle:item.service.title,unitDurationMinutes:item.service.durationMinutes,
        unitPriceAmount:item.service.priceAmount,quantity:item.quantity})),updatedAt:stamp(),
    };
    s.bookings.push(row);
    return {bookingId,bookingSource:'phone',status:'confirmed'};
  }
  if(action==='admin.booking.status.update'||action==='admin.booking.status.complete'){const b=s.bookings.find(b=>b.bookingId===p.bookingId);Object.assign(b,p,{status:action.endsWith('.complete')?'completed':p.status,updatedAt:stamp()});return {booking:b};}
  if(action==='admin.booking.receipt.list')return {submissions:s.submissions,accessibleRecords:s.accessibleRecords,bookings:s.bookings,receipts:s.receipts};
  if(action==='admin.booking.receipt.url')return {signedUrl:'https://fixture.supabase.co/storage/v1/object/sign/booking-receipts/qa.svg?token=fixture'};
  if(action==='admin.booking.receipt.options')return {services:s.services.map(x=>({id:x.serviceId,title:x.title,service_type:x.serviceType,duration_minutes:x.durationMinutes})),bookings:s.bookings,primaryTechnicianConfigured:true,rewardRules:[],benefitCatalog:s.benefitCatalog,currentBenefits:s.bookings.find(b=>b.bookingId===p.bookingId)?.benefits||[],currentBookingStatus:s.bookings.find(b=>b.bookingId===p.bookingId)?.status||''};
  if(action==='admin.booking.receipt.register'){
    if(s.hold?.action===action){const wait=s.hold.wait;s.hold=null;return wait.then(()=>transport(s,action,p,slug,false));}
    if(s.receiptResults[p.receiptId])return {...structuredClone(s.receiptResults[p.receiptId]),alreadyApplied:true};
    const serviceMinutes=p.bookingId?s.bookings.find(b=>b.bookingId===p.bookingId)?.totalDurationMinutes||0:p.items.reduce((n,i)=>n+i.minutes*i.quantity,0);
    // Explicit test reward: two points per review. This fixture is UI evidence only.
    const result={bookingId:p.bookingId||'qa-completed',settlement:{serviceMinutes,rewards:[{points:2}],redemptions:p.benefits||[]}};
    s.receiptResults[p.receiptId]=structuredClone(result);s.settlements.push(result.settlement);
    s.submissions=s.submissions.filter(r=>r.receiptId!==p.receiptId);
    s.accessibleRecords=s.accessibleRecords.filter(r=>r.receiptId!==p.receiptId).concat({receiptId:p.receiptId,bookingId:result.bookingId,status:'bound',reviewStatus:'completed',memberName:'QA Member',memberCode:'TEST1',createdAt:version,completedAt:stamp(),bookingDate:p.bookingDate,startTime:p.startTime,serviceMinutes,points:2,services:p.items.map(i=>({title:s.services.find(service=>service.serviceId===i.serviceId)?.title,minutes:i.minutes,quantity:i.quantity})),benefits:p.benefits||[]});
    if(s.fault?.action===action&&s.fault.afterCommit){const fault=s.fault;s.fault=null;throw Object.assign(new Error('QA response lost after commit'),{code:fault.code});}
    return result;
  }
  if(action==='admin.booking.receipt.dismiss'){s.submissions=[];return {dismissed:true};}
  if(action==='admin.integration-overview')return {generatedAt:version,stats:bootstrap().stats,pointSources:[{title:'QA source',detail:'30 分鐘',pointCardTitle:'QA card 1',status:'active'}],campaigns:s.eventTickets,settlements:[],automation:{fixedTickets:s.templates},notifications:['pending','sent','failed'].map(status=>({status,memberDisplayName:'QA '+status,memberCode:status,scheduledFor:version,attemptCount:1}))};
  s.unexpected.push({action,slug});throw Object.assign(new Error('Unimplemented fixture action '+action),{code:'FIXTURE_UNEXPECTED_ACTION'});
}
async function startFixture() {
  const sessions=new Map();let base;
  const scripts=['theme.js','admin/admin-session.js','admin/coupon-location-editor.js','admin/app.js','admin/ticket-visibility.js','admin/member-workspace-tabs.js','admin/terms.js','admin/grant-automation.js','admin/fixed-ticket-admin-integration.js','admin/fixed-ticket-calendar-option.js','admin/fixed-ticket-admin.js','admin/pointcard-redemption-limit.js','admin/event-ticket-redemption-limit.js','booking-copy-text.js','booking-copy-format.js','admin/booking-panel.js','admin/booking-receipt-admin.js','admin/booking-accessible-admin.js'];
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');const id=/qa=([^;]+)/.exec(req.headers.cookie||'')?.[1];
    const send=(status,type,body)=>{res.writeHead(status,{'Content-Type':type});res.end(body);};
    try {
      if(url.pathname==='/admin/'){
        const key=url.searchParams.get('run');if(!sessions.has(key))sessions.set(key,fixture());res.setHeader('Set-Cookie','qa='+key+'; Path=/; SameSite=Strict');
        const html=fs.readFileSync(path.join(root,'admin/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
        return send(200,'text/html',html.replace('</body>',`<script src="/fixture.js"></script>${scripts.map(src=>`<script src="/${src}"></script>`).join('')}</body>`));
      }
      if(url.pathname==='/fixture.js')return send(200,'text/javascript',`
        const config={supabaseUrl:location.origin,supabasePublishableKey:'local-fixture',supabaseGrantAutomationUrl:'https://fixture.supabase.co/functions/v1/grant-automation'};
        const token='local-fixture';
        async function request(c,t,k,action,payload={}){const r=await fetch('/functions/v1/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...payload})});const v=await r.json();if(!v.ok)throw Object.assign(new Error(v.error.message),{code:v.error.code});return v.data;}
        window.MemberSystem={loadConfig:async()=>config,signIn:async()=>token,getSession:()=>({config,idToken:token}),request,subscribeRealtime:()=>()=>{},bindDialogKeyboard(){},initials:v=>String(v||'QA').slice(0,2),formatDateTime:v=>String(v||''),formatDate:v=>String(v||''),logout(){location.href='/logged-out';}};
        window.liff={getIDToken:()=>token};
      `);
      if(url.pathname.startsWith('/functions/v1/')){
        const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));const {action,operation,...payload}=body;
        const data=await transport(sessions.get(id),action||operation,payload,url.pathname.split('/').at(-1));
        return send(200,'application/json',JSON.stringify({ok:true,data}));
      }
      if(url.pathname==='/receipt.svg')return send(200,'image/svg+xml','<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text y="40">QA Receipt</text></svg>');
      const local=path.resolve(root,'.'+decodeURIComponent(url.pathname));
      if(!local.startsWith(root+path.sep)||!fs.existsSync(local)||!fs.statSync(local).isFile())return send(404,'text/plain','Not found');
      return send(200,local.endsWith('.js')?'text/javascript':local.endsWith('.css')?'text/css':'application/octet-stream',fs.readFileSync(local));
    }catch(e){send(400,'application/json',JSON.stringify({ok:false,error:{code:e.code||'FIXTURE_ERROR',message:e.message}}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  return {base,sessions,close:()=>new Promise(resolve=>server.close(resolve))};
}
module.exports={startFixture,fixture,today,version,transport};
