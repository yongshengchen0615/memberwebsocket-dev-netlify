(() => {
 'use strict';
 const params=new URLSearchParams(location.search),nested=new URLSearchParams((params.get('liff.state')||'').split('?').pop());
 const business=params.get('business')||nested.get('business'),bookingId=params.get('bookingId')||nested.get('bookingId');
 const status=document.getElementById('status'),account=document.getElementById('account'),list=document.getElementById('bookings'),refresh=document.getElementById('refresh');
 let config,idToken,busy=false,epoch=0,historyEpoch=0,historyLoaded=false,frontdeskPolicy={};const pending=new Map();
 const legacyRejectionReasons=[
  {id:'technician_leave',label:'預約中有休假技師',memberDescription:'預約中有休假技師',enabled:true,requiresConflictTime:false},
  {id:'unrecorded_phone_booking',label:'該時段已被現場人員預約但未登記',memberDescription:'該時段已被現場人員預約但未登記',enabled:true,requiresConflictTime:true}
 ];
 let rejectionSettings={dropdownTitle:'請選擇拒絕原因',reasons:legacyRejectionReasons};

 const rejectionReasonById=id=>rejectionSettings.reasons.find(item=>item.id===id);
 let syncTimer=null,syncEnabled=false,syncInFlight=false,syncRevision=null,syncFailures=0,syncGeneration=0;
 const node=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
 const progress=document.getElementById('progress'),toolbar=document.querySelector('.frontdesk-toolbar');

 // External entries must complete a new LINE Login callback. LIFF in-app
 // signs in automatically on init and does not support explicit login/logout.
 const LOGIN_QUERY='frontdesk_line_reauth',LOGIN_KEY='frontdesk_line_reauth:'+business,LOGIN_AGE_MS=300000;
 const authError=(code,message)=>Object.assign(Error(message),{code,denied:true});
 function redirectToLineLogin(liffId){
  const target=new URL(location.href);
  target.searchParams.delete(LOGIN_QUERY);
  target.searchParams.delete('liff.state');
  target.searchParams.set('business',business);
  if(bookingId)target.searchParams.set('bookingId',bookingId);
  let nonce;
  try{
   const bytes=new Uint8Array(16);window.crypto.getRandomValues(bytes);
   nonce=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
   window.sessionStorage.setItem(LOGIN_KEY,JSON.stringify({
    nonce,pathname:target.pathname,business,liffId,createdAt:Date.now()
   }));
  }catch{throw authError('AUTH_STORAGE_UNAVAILABLE','無法安全啟動 LINE 登入，請允許此網站使用工作階段儲存空間。');}
  target.searchParams.set(LOGIN_QUERY,nonce);
  window.liff.login({redirectUri:target.toString()});
 }
 function consumeLineLoginCallback(liffId){
  const current=new URL(location.href),marker=current.searchParams.get(LOGIN_QUERY);
  if(marker===null)return false;
  current.searchParams.delete(LOGIN_QUERY);
  window.history.replaceState({},document.title,current.pathname+current.search+current.hash);
  let record;
  try{
   const raw=window.sessionStorage.getItem(LOGIN_KEY);
   window.sessionStorage.removeItem(LOGIN_KEY);
   record=raw?JSON.parse(raw):null;
  }catch{throw authError('AUTH_REQUIRED','LINE 登入回跳無法確認，請重新開啟商家櫃檯入口。');}
  const age=Date.now()-Number(record?.createdAt);
  if(!record||!/^[a-f0-9]{32}$/.test(record.nonce)||marker!==record.nonce
   ||record.pathname!==current.pathname||record.business!==business||record.liffId!==liffId
   ||!Number.isFinite(age)||age<0||age>LOGIN_AGE_MS)
   throw authError('AUTH_REQUIRED','LINE 登入回跳已失效，請重新開啟商家櫃檯入口。');
  return true;
 }
 async function authenticateLineOnOpen(liffId){
  if(!window.liff||typeof window.liff.isInClient!=='function')
   throw authError('LIFF_SDK_MISSING','LINE 登入元件未載入，請重新開啟商家櫃檯入口。');
  try{await window.liff.init({liffId});}
  catch{throw authError('LIFF_INIT_ERROR','無法完成 LINE 登入初始化，請重新開啟商家櫃檯入口。');}
  if(window.liff.isInClient()){
   if(!window.liff.isLoggedIn())
    throw authError('AUTH_REQUIRED','LINE 尚未完成登入，請從 LINE 再次開啟商家櫃檯入口。');
  }else if(!consumeLineLoginCallback(liffId)){
   if(window.liff.isLoggedIn()){
    try{window.liff.logout();}
    catch{throw authError('AUTH_LOGOUT_FAILED','無法清除先前的 LINE 登入，請重新開啟商家櫃檯入口。');}
    if(window.liff.isLoggedIn())
     throw authError('AUTH_LOGOUT_FAILED','先前的 LINE 登入仍有效，無法重新驗證身分。');
   }
   redirectToLineLogin(liffId);
   return null; // External browser is navigating to LINE Login.
  }else if(!window.liff.isLoggedIn()){
   throw authError('AUTH_REQUIRED','LINE 登入未完成，請重新開啟商家櫃檯入口。');
  }
  const token=window.liff.getIDToken();
  if(typeof token!=='string'||!token.trim())
   throw authError('LIFF_ID_TOKEN_MISSING','無法取得 LINE 身分憑證，請重新開啟商家櫃檯入口。');
  return token;
 }

 function showProgress(stage){
  if(!progress)return;
  progress.replaceChildren();progress.hidden=stage>=3;
  for(const [index,title] of ['1. LINE 身分登入','2. 申請櫃檯資格','3. 管理員審核'].entries()){
   const step=node('li',title),state=index<stage?'done':index===stage?'current':'waiting';
   step.dataset.state=state;
   if(index===stage)step.setAttribute('aria-current','step');
   step.append(node('small',state==='done'?'已完成':state==='current'?'目前階段':'尚未完成'));
   progress.append(step);
  }
 }
 function showBookingToolbar(visible){if(toolbar){toolbar.hidden=false;const heading=toolbar.querySelector('h2'),summary=toolbar.querySelector('#bookingSummary'),kicker=toolbar.querySelector('.frontdesk-kicker');for(const el of [heading,summary,kicker])if(el)el.hidden=!visible;}}
 function lock(value){
  busy=value;
  for(const button of document.querySelectorAll('button')){
   if(value){
    if(button.dataset.frontdeskLockPrevious===undefined)button.dataset.frontdeskLockPrevious=button.disabled?'disabled':'enabled';
    button.disabled=true;
   }else if(button.dataset.frontdeskLockPrevious!==undefined){
    button.disabled=button.dataset.frontdeskLockPrevious==='disabled';
    delete button.dataset.frontdeskLockPrevious;
   }
  }
 }
 // Coalesce only overlapping authorized reads, never a completed response or
 // a write. The key includes every credential, tenant and query input.
 const frontdeskReadActions=new Set(['frontdesk.public','frontdesk.bootstrap','frontdesk.bookings','frontdesk.history','frontdesk.sync.status']);
 const pendingReads=new Map();
 async function request(action,body={}){
  const endpoint=config.supabaseFunctionUrl.replace(/\/api\/?$/,'/frontdesk-api');
  const apiKey=config.supabasePublishableKey;
  const payload=JSON.stringify({...body,action,business,idToken});
  const read=frontdeskReadActions.has(action);
  const key=read?JSON.stringify([endpoint,apiKey,payload]):null;
  if(!read)pendingReads.clear();
  else if(pendingReads.has(key))return pendingReads.get(key);
  const operation=(async()=>{
   let response,data;
   try{
    response=await fetch(endpoint,{method:'POST',cache:'no-store',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',apikey:apiKey},body:payload});
    data=await response.json();
   }catch{throw Object.assign(Error('無法確認伺服器結果，請重試相同操作。'),{uncertain:true});}
   if(!response.ok||!data?.ok)throw Object.assign(Error(data?.error?.message||'櫃檯服務暫時無法使用。'),{code:data?.error?.code,denied:response.status===401||response.status===403,uncertain:response.status>=500});
   return data.data;
  })();
  if(read)pendingReads.set(key,operation);
  try{return await operation;}
  finally{
   if(read){if(pendingReads.get(key)===operation)pendingReads.delete(key);}
   else pendingReads.clear();
  }
 }
 function clearPrivateHistory(){
  historyEpoch++;
  const history=document.getElementById('frontdeskConflictHistory');
  if(history){history.hidden=true;history.querySelector('[data-frontdesk-history-items]')?.replaceChildren();}
 }
 function failure(error,keepAccount=false){
  status.textContent=error.message;
  const invalidIdentity=['AUTH_INVALID','FRONTDESK_AUTH_INVALID','AUTH_REQUIRED',
   'LIFF_ID_TOKEN_MISSING','AUTH_LOGOUT_FAILED','AUTH_STORAGE_UNAVAILABLE','LIFF_INIT_ERROR','LIFF_SDK_MISSING'].includes(error.code);
  if(error.denied||invalidIdentity){
   epoch++;stopSync();list.replaceChildren();showBookingToolbar(false);
   clearPrivateHistory();
   if(!keepAccount||invalidIdentity)account.replaceChildren();
  }
  if(invalidIdentity){
   idToken=null;
   if(['AUTH_INVALID','FRONTDESK_AUTH_INVALID'].includes(error.code))
    status.textContent='LINE 身分已失效，請重新開啟商家櫃檯入口完成身分驗證。';
  }
 }
 function confirmFrontdeskReview(booking,next,reason='',phoneBooking=null){
  const details=[`預約：${String(booking.name||booking.memberName||booking.customerName||booking.id)}`,`時間：${String(booking.startAt||booking.bookingDate||'')} ${String(booking.startTime||'')}`,`操作：${next==='confirmed'?'確認預約':'拒絕預約'}`];
  if(reason)details.push(`原因：${reason}`);
  if(phoneBooking)details.push(`現場預約：${phoneBooking.startTime}，${phoneBooking.totalDurationMinutes} 分鐘`);
  return window.confirm(`${details.join('\n')}\n\n請再次確認，此操作將更新預約狀態。`);
 }
 async function review(booking,next,button,rejectionReason,phoneBooking=null,onSuccess=null,vacationIds=null){
  if(busy)return;const key=booking.id,known=pending.get(key);
  if(known&&known.status!==next){status.textContent='前次操作結果尚未確認，請先重試相同操作。';return;}
  if(!known&&next==='rejected'&&!rejectionReasonById(rejectionReason)){
   status.textContent='請先選擇拒絕原因。';return;
  }
  const body=known||{bookingId:key,status:next,expectedUpdatedAt:booking.updatedAt,requestId:crypto.randomUUID(),...(next==='rejected'?{rejectionReason,...(Array.isArray(vacationIds)?{vacationTechnicianIds:vacationIds}:{})}:{}),...(phoneBooking?{phoneRequestId:'PHONE-'+crypto.randomUUID(),startTime:phoneBooking.startTime,totalDurationMinutes:phoneBooking.totalDurationMinutes}:{})};pending.set(key,body);lock(true);const generation=epoch;const finishFeedback=window.AsyncActionFeedback?.begin(next==='confirmed'?'正在確認預約並同步最新資料…':'正在拒絕預約並同步最新資料…');
  try{await request(body.phoneRequestId?'frontdesk.booking.reject-phone':'frontdesk.booking.update',body);if(generation!==epoch)return;pending.delete(key);await load();if(onSuccess)onSuccess();if(body.phoneRequestId)void loadConflictHistory();status.textContent=body.phoneRequestId?'原預約已拒絕，電話／現場預約已登記並直接確認，時段已保留。':next==='confirmed'?'預約已確認。':'預約已拒絕。';}
  catch(error){if(generation!==epoch)return;let refreshed=false;if(!error.uncertain){pending.delete(key);try{await load();refreshed=true;}catch{}}else button.textContent='重試相同操作';failure(error,refreshed);}
  finally{finishFeedback?.();lock(false);}
 }
 function renderBookings(bookings){
  list.replaceChildren();
  const summary=document.getElementById('bookingSummary');
  if(summary)summary.textContent=bookings.length?`共 ${bookings.length} 筆預約，請依狀態處理。`:'目前沒有需要處理的預約';
  if(!bookings.length){
   const empty=node('div');empty.className='frontdesk-empty';
   empty.append(node('h3','目前沒有待處理的預約'),node('p','新預約送達後會顯示在這裡。'));
   list.append(empty);return;
  }
  const labels={pending:'待確認',confirmed:'已確認',rejected:'已拒絕',cancelled:'已取消',completed:'已完成'};
  for(const booking of bookings){
   const card=node('article');card.className='frontdesk-card';
   const heading=node('div');heading.className='frontdesk-card-heading';
   const times=node('div');
   const date=String(booking.bookingDate||booking.startAt||'').slice(0,10);
   const startTime=String(booking.startTime||String(booking.startAt||'').slice(11,16));
   const endTime=String(booking.endTime||String(booking.endAt||'').slice(11,16));
   const dateLabel=node('p','預約日期：'+(date||'待確認'));dateLabel.className='frontdesk-time';
   const timeLabel=node('p','預約時間：'+(startTime||'待確認')+(endTime?' – '+endTime:''));timeLabel.className='frontdesk-time';
   times.append(dateLabel,timeLabel);
   const badge=node('span',booking.cancellationPending?'取消待審核':labels[booking.status]||booking.status||'待確認');
   badge.className='frontdesk-badge';badge.dataset.status=booking.status||'pending';
   heading.append(times,badge);card.append(heading);
   card.append(node('h3','預約人：'+(booking.name||'未提供預約姓名')));
   const details=node('div');details.className='frontdesk-card-details';
   const phoneField=node('p'),phoneLabel=node('span','聯絡電話'),phone=String(booking.phone||'').trim();
   phoneLabel.className='frontdesk-field-label';phoneLabel.textContent='電話';phoneField.append(phoneLabel);
   const dial=phone.replace(/[^\d+]/g,'');
   if(/^\+?\d{6,15}$/.test(dial)){
    const link=node('a',phone);link.href='tel:'+dial;link.setAttribute('aria-label','撥打 '+phone);phoneField.append(link);
   }else phoneField.append(node('span',phone||'未提供'));
   const peopleField=node('p'),peopleLabel=node('span','預約人數');peopleLabel.className='frontdesk-field-label';
   peopleField.append(peopleLabel,node('strong',String(booking.partySize||1)+' 位'));details.append(phoneField,peopleField);
   card.append(details);
   const serviceText=items=>(items||[]).map(item=>String(item.title||'未命名項目')+(Number(item.quantity)>1?' × '+String(item.quantity):'')).join('、')||'請至預約頁查看';
   const ordinal=n=>['第一','第二','第三','第四','第五','第六','第七','第八','第九','第十'][n-1]||'第 '+n;
   const participants=Array.isArray(booking.participants)?booking.participants:[];
   const people=participants.length?participants:[{position:1,services:booking.services||[],technician:booking.fallbackTechnician||'現場安排',note:''}];
   const participantGroup=node('div');participantGroup.className='frontdesk-participants';
   for(const [index,person] of people.entries()){
    const section=node('section');section.className='frontdesk-participant';
    const title=node('h4',ordinal(Number(person.position)||index+1)+'位預約');section.append(title);
    section.append(node('p','預約項目：'+serviceText(person.services)));
    section.append(node('p','預約技師：'+String(person.technician||'現場安排')));
    if(String(person.note||'').trim()){const note=node('p','個別備註：'+String(person.note).trim());note.className='frontdesk-note';section.append(note);}
    participantGroup.append(section);
   }
   card.append(participantGroup);
   if(booking.note&&!participants.some(p=>String(p.note||'').trim()===String(booking.note).trim())){
    const note=node('p','會員備註：'+booking.note);note.className='frontdesk-note';card.append(note);
   }
   if(String(booking.adminNote||'').trim()){
    const adminNote=node('p','管理端說明：'+String(booking.adminNote).trim());adminNote.className='frontdesk-note';card.append(adminNote);
   }
   if(booking.status==='pending'&&!booking.cancellationPending){
    const actions=node('div');actions.className='frontdesk-actions';
    for(const [next,label]of [['confirmed','確認預約'],['rejected','拒絕預約']]){
     const b=node('button',label);b.type='button';b.dataset.reviewAction=next;
     b.className=next==='confirmed'?'frontdesk-primary':'frontdesk-danger';
     b.onclick=()=>{if(next==='rejected'){const existing=pending.get(booking.id);if(existing&&existing.status!=='rejected'){status.textContent='前次操作結果尚未確認，請先重試相同操作。';return;}openRejectionDialog(booking,b);}else if(confirmFrontdeskReview(booking,'confirmed'))void review(booking,next,b);};actions.append(b);
    }
    card.append(actions);
   }else if(booking.cancellationPending){
    const hint=node('p','取消申請待審核，請交由商家管理員處理。');hint.className='frontdesk-cancellation';card.append(hint);
   }
   list.append(card);
  }
 }


 function renderConflictHistory(records){
  const panel=document.getElementById('frontdeskConflictHistory'),items=panel?.querySelector('[data-frontdesk-history-items]');
  if(!items)return;
  items.replaceChildren();
  // A LINE booking deep link is single-order context, never a staff-wide history view.
  const visible=bookingId?records.filter(record=>String(record?.booking?.id||'').toLowerCase()===bookingId.toLowerCase()):records;
  if(!visible.length){items.append(node('p',bookingId?'這筆預約尚無衝突處理紀錄。':'目前沒有你處理的衝突預約紀錄。'));return;}
  for(const record of visible){
   const original=record.booking,replacement=record.phoneBooking;
   const card=node('article');card.className='frontdesk-history-pair';
   const isAdminReview=record.actorRole==='admin';
   card.append(node('h3',isAdminReview?'管理端拒絕預約・衝突處理紀錄':'衝突預約處理紀錄'),node('p','處理時間：'+(record.actionAt?new Date(record.actionAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'—')));
   const details=(booking,label,isReplacement)=>{
    const group=node('section');group.className='frontdesk-history-booking';
    group.append(node('h4',label));
    if(!booking){group.append(node('p','預約資料已不存在，請聯絡管理員查看稽核紀錄。'));return group;}
    const date=String(booking.bookingDate||booking.startAt||'').slice(0,10);
    const time=String(booking.startTime||String(booking.startAt||'').slice(11,16)).slice(0,5);
    const end=String(booking.endTime||String(booking.endAt||'').slice(11,16)).slice(0,5);
    const mins=Number(booking.totalDurationMinutes);
    group.append(node('p','預約日期：'+(date||'—')),node('p','預約時間：'+(time||'—')+' – '+(end||'—')));
    if(Number.isInteger(mins)&&mins>0)group.append(node('p','總時長：'+mins+' 分鐘'));
    group.append(node('p','狀態：'+({pending:'待確認',confirmed:'已確認',rejected:'已拒絕',cancelled:'已取消'}[booking.status]||booking.status||'—')));
    if(isReplacement){group.append(node('p',isAdminReview?'預約來源：管理端（現場／電話預約）':'預約來源：櫃檯人員（現場／電話預約）'));}
    else{
     group.append(node('p','預約人：'+(booking.name||'—')),node('p','電話：'+(booking.phone||'—')),node('p','預約人數：'+(booking.partySize||1)+' 位'));
     for(const person of (Array.isArray(booking.participants)?booking.participants:[])){
      const services=(person.services||[]).map(i=>i.title+(Number(i.quantity)>1?' × '+i.quantity:'')).join('、');
      group.append(node('p','第 '+(Number(person.position)||1)+' 位：'+(services||'無服務項目')+'／'+(person.technician||'現場安排')));
     }
    }
    return group;
   };
   card.append(details(original,'原預約資料',false),details(replacement,isAdminReview?'管理端修改後的預約資料':'櫃檯新增的衝突預約',true));
   items.append(card);
  }
 }
 async function loadConflictHistory(manual=false){
  const panel=document.getElementById('frontdeskConflictHistory');
  if(!panel||panel.hidden||!idToken)return;
  const finishFeedback=manual?window.AsyncActionFeedback?.begin('正在載入衝突預約處理紀錄…'):null;
  const message=panel.querySelector('[data-frontdesk-history-status]'),generation=++historyEpoch;
  panel.querySelector('[data-frontdesk-history-items]')?.replaceChildren();
  if(message)message.textContent='正在取得衝突預約處理紀錄…';
  try{
   const result=await request('frontdesk.history',bookingId?{bookingId}:{});
   if(generation!==historyEpoch||panel.hidden)return;
   renderConflictHistory(Array.isArray(result.items)?result.items:[]);
   if(message)message.textContent=bookingId?'僅顯示本筆預約的衝突處理資料（預約資料為目前狀態）。':'最近的衝突預約紀錄（預約資料為目前狀態）。';
  }catch(error){if(generation!==historyEpoch)return;if(error.denied){failure(error);return;}if(message)message.textContent=error.message||'無法載入衝突預約紀錄。';}finally{finishFeedback?.();}
 }
 document.getElementById('frontdeskHistoryRefresh')?.addEventListener('click',()=>void loadConflictHistory(true));

 // Reconcile through the existing LINE-authenticated API. No booking data is
 // ever read directly from a publicly subscribed Realtime channel.
 const canSync=()=>syncEnabled&&idToken&&document.visibilityState!=='hidden'&&navigator.onLine!==false;
 function stopSync(){
  syncEnabled=false;syncGeneration++;syncRevision=null;
  if(syncTimer!==null){clearTimeout(syncTimer);syncTimer=null;}
 }
 function scheduleSync(delay=3000){
  if(syncTimer!==null){clearTimeout(syncTimer);syncTimer=null;}
  if(!canSync())return;
  // timer-policy: recovery; reason=private tenant authorization requires authenticated revision checks; cleanup=stopSync; test=frontdesk_live_sync.test.js
  syncTimer=setTimeout(()=>{syncTimer=null;void probeSync();},delay);
 }
 function startSync(){
  if(syncEnabled)return;
  syncEnabled=true;syncRevision=null;syncFailures=0;syncGeneration++;scheduleSync(0);
 }
 async function probeSync(){
  if(!canSync())return;
  if(syncInFlight||busy||pending.size){scheduleSync(3000);return;}
  const generation=syncGeneration;syncInFlight=true;
  try{
   const result=await request('frontdesk.sync.status');
   if(generation!==syncGeneration||!canSync()||busy||pending.size)return;
   const revision=result?.revision;
   if(typeof revision!=='string'||!/^[0-9]+$/.test(revision))throw Error('無法確認預約資料版本。');
   if(syncRevision!==revision){
    // Only accept the revision after all authorized booking reads succeed.
    const reloaded=await load();
    if(reloaded&&generation===syncGeneration&&canSync())syncRevision=revision;
   }
   syncFailures=0;
  }catch(error){
   if(generation!==syncGeneration||!syncEnabled)return;
   if(error.denied||['FRONTDESK_REVIEW_REQUIRED','FRONTDESK_AUTH_INVALID'].includes(error.code)){
    stopSync();failure(error);return;
   }
   syncFailures++;
   status.textContent='同步暫時中斷，恢復連線後會自動更新；也可手動重新整理。';
  }finally{
   syncInFlight=false;
   if(generation===syncGeneration&&canSync())
    scheduleSync(syncFailures?Math.min(30000,3000*2**Math.min(syncFailures,3)):3000);
  }
 }

 // The rejection dialog is scoped to a single booking. A walk-in replacement is
 // committed with the rejection in one server transaction, never in two writes.
 function openRejectionDialog(booking,trigger){
  if(document.querySelector('[data-frontdesk-rejection-dialog]'))return;
  const frozen=pending.get(booking.id);
  const overlay=node('div');overlay.className='frontdesk-modal-backdrop';overlay.dataset.frontdeskRejectionDialog='true';
  const dialog=node('section');dialog.className='frontdesk-rejection-modal';
  dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');
  const heading=node('h2','拒絕預約');heading.id='frontdesk-rejection-heading';dialog.setAttribute('aria-labelledby',heading.id);
  const help=node('p','請先選擇拒絕原因，再確認送出。');
  const form=node('form');form.noValidate=true;form.className='frontdesk-rejection-form';
  const reasonField=node('label',String(rejectionSettings.dropdownTitle||'請選擇拒絕原因')),reason=node('select');reason.required=true;
  reason.setAttribute('aria-label','選擇拒絕預約原因');
  const options=[{id:'',label:rejectionSettings.reasons.length?'請選擇拒絕原因':'目前沒有可使用的拒絕原因'},...rejectionSettings.reasons];
  if(frozen?.rejectionReason&&!options.some(item=>item.id===frozen.rejectionReason))options.push({id:frozen.rejectionReason,label:frozen.rejectionReasonLabel||'歷史拒絕原因'});
  for(const item of options){
   const option=node('option',item.label);option.value=item.id;reason.append(option);
  }
  reasonField.append(reason);
  const vacationPanel=node('fieldset');vacationPanel.className='frontdesk-vacation-technicians';vacationPanel.hidden=true;
  vacationPanel.append(node('legend','選擇休假的技師（可多選）'));
  const vacationHint=node('p','僅列出這筆預約實際指派的技師，主要技師不列入；至少勾選一位。');
  const vacationList=node('div');vacationList.className='frontdesk-vacation-options';
  vacationPanel.append(vacationHint,vacationList);
  const bookedVacationTechnicians=Array.isArray(booking.vacationTechnicians)?booking.vacationTechnicians.filter(item=>item&&typeof item.id==='string'&&typeof item.name==='string'):[];
  const vacationBoxes=new Map();
  const selectedVacationIds=()=>[...vacationBoxes].filter(([,input])=>input.checked).map(([id])=>id);
  const memberPreview=node('section');memberPreview.className='frontdesk-rejection-member-preview';memberPreview.hidden=true;
  memberPreview.append(node('strong','會員端拒絕說明預覽'));
  const memberPreviewText=node('p');
  memberPreview.append(memberPreviewText);
  const phonePanel=node('section');phonePanel.className='frontdesk-phone-settings';phonePanel.dataset.phoneRegistration='true';phonePanel.hidden=true;
  const title=node('h3','登記電話／現場預約');
  const hint=node('p','同一筆操作會拒絕原預約、登記並直接確認現場預約，無須等待管理員審核。');
  const bookingDate=String(booking.bookingDate||booking.startAt||'').slice(0,10);
  const dateLabel=node('div');dateLabel.className='frontdesk-phone-date';
  dateLabel.append(node('span','預約日期（原訂單）'),node('strong',bookingDate||'無法取得原預約日期'));
  const originalTime=String(booking.startTime||String(booking.startAt||'').slice(11,16)).slice(0,5);
  const originalEnd=String(booking.endTime||String(booking.endAt||'').slice(11,16)).slice(0,5);
  const originalDuration=Number(booking.totalDurationMinutes)||Math.round((Date.parse(booking.endAt)-Date.parse(booking.startAt))/60000);
  const original=node('section');original.className='frontdesk-original-booking';
  original.append(node('h3','原預約資料'),node('p','預約日期：'+(bookingDate||'—')),
    node('p','原預約時間：'+(originalTime||'—')+' – '+(originalEnd||'—')),
    node('p','原預約總時長：'+(Number.isFinite(originalDuration)&&originalDuration>0?originalDuration+' 分鐘':'未提供')));
  const clock=m=>String(Math.floor((m%1440)/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
  const timeLabel=node('label','衝突預約時間（每 10 分鐘）'),time=node('select');time.required=true;
  time.setAttribute('aria-label','衝突預約時間');
  const durationLabel=node('label','衝突預約總時長（每 10 分鐘）'),duration=node('select');duration.required=true;
  duration.setAttribute('aria-label','衝突預約總時長');
  for(let m=10;m<=1430;m+=10){const opt=node('option',m+' 分鐘');opt.value=String(m);duration.append(opt);}
  const recommendedDuration=Number.isInteger(originalDuration)?originalDuration:60;
  duration.value=Array.from(duration.options).some(x=>Number(x.value)===recommendedDuration)?String(recommendedDuration):(duration.options[0]?.value||'');
  timeLabel.append(time);durationLabel.append(duration);
  const toMinutes=value=>/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)?Number(value.slice(0,2))*60+Number(value.slice(3,5)):null;
  // Stored startAt carries the canonical calendar day for overnight shifts.
  // BookingDate is the merchant business day; they can differ after midnight.
  const dayNumber=value=>{
   if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value))return null;
   const parsed=Date.parse(value+'T00:00:00Z');
   return Number.isFinite(parsed)?Math.floor(parsed/86400000):null;
  };
  const bookingDay=dayNumber(String(booking.bookingDate||'').slice(0,10));
  const startDay=dayNumber(String(booking.startAt||'').slice(0,10));
  const dayOffset=bookingDay!==null&&startDay!==null?Math.max(0,Math.min(1,startDay-bookingDay)):0;
  const startClockMin=toMinutes(originalTime),originalClockEnd=toMinutes(originalEnd);
  const originalStartMin=startClockMin===null?null:startClockMin+dayOffset*1440;
  const originalEndMin=Number.isFinite(originalDuration)&&originalDuration>0&&originalStartMin!==null
   ?originalStartMin+originalDuration
   :originalStartMin!==null&&originalClockEnd!==null
    ?dayOffset*1440+originalClockEnd+(originalClockEnd<=startClockMin?1440:0):null;
  // Only offer clock starts inside the original appointment, including its
  // exact ending minute. An adjacent on-site reservation counts as conflict.
  if(originalStartMin!==null&&originalEndMin!==null&&originalEndMin>=originalStartMin){
   for(let m=Math.ceil(originalStartMin/10)*10;m<=originalEndMin;m+=10){
    const value=clock(m),opt=node('option',value);opt.value=value;time.append(opt);
   }
  }
  time.value=time.options[0]?.value||'';
  // BookingDate is the merchant business day; try the next calendar-day
  // occurrence too when the original appointment crosses midnight.
  const hasConflict=()=>{
   const candidateClock=toMinutes(time.value),minutes=Number(duration.value);
   return originalStartMin!==null&&originalEndMin!==null&&originalEndMin>=originalStartMin
    &&candidateClock!==null&&Number.isInteger(minutes)&&minutes>0
    &&[candidateClock,candidateClock+1440].some(candidateStart=>
      candidateStart>=originalStartMin&&candidateStart<=originalEndMin);
  };
  const guidance=node('p','開始時間只顯示原預約區間內每 10 分鐘的選項，包含原預約結束時間；前後預約相接也算衝突。服務總時長另行選擇。');
  phonePanel.append(title,hint,dateLabel,guidance,timeLabel,durationLabel);
  const feedback=node('p');feedback.className='frontdesk-phone-message';feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
  const footer=node('div');footer.className='frontdesk-modal-actions';
  const cancel=node('button','取消');cancel.type='button';cancel.className='frontdesk-modal-cancel';
  const submit=node('button','確認拒絕預約');submit.type='submit';submit.className='frontdesk-danger';submit.disabled=true;
  footer.append(cancel,submit);form.append(reasonField,vacationPanel,memberPreview,phonePanel,feedback,footer);
  dialog.append(heading,help,original,form);overlay.append(dialog);document.body.append(overlay);
  const close=(force=false)=>{
   if(busy&&!force||!overlay.isConnected)return;
   document.removeEventListener('keydown',keyHandler);overlay.remove();
   (trigger.isConnected?trigger:refresh).focus();
  };
  const keyHandler=event=>{
   if(!overlay.isConnected)return;
   if(event.key==='Escape'){event.preventDefault();close();return;}
   if(event.key!=='Tab')return;
   const enabled=Array.from(dialog.querySelectorAll('select,input,button')).filter(x=>!x.disabled&&!x.closest('[hidden]'));
   if(!enabled.length)return;
   if(event.shiftKey&&document.activeElement===enabled[0]){event.preventDefault();enabled[enabled.length-1].focus();}
   else if(!event.shiftKey&&document.activeElement===enabled[enabled.length-1]){event.preventDefault();enabled[0].focus();}
  };
  document.addEventListener('keydown',keyHandler);
  cancel.onclick=()=>close();overlay.onclick=event=>{if(event.target===overlay)close();};
  const validTime=()=>Array.from(time.options).some(option=>option.value===time.value);
  const validDuration=()=>Array.from(duration.options).some(option=>option.value===duration.value);
  const requiresConflictTime=()=>rejectionReasonById(reason.value)?.requiresConflictTime===true||
   (frozen?.rejectionReason===reason.value&&Boolean(frozen.phoneRequestId));
  const updateSubmit=()=>{
   const phone=requiresConflictTime();
   submit.textContent=frozen?'重試相同操作':phone?'確認拒絕並登記現場預約':'確認拒絕預約';
   const validPhone=bookingDate&&validTime()&&validDuration();
   const overlaps=phone&&validPhone&&hasConflict();
   const policy=rejectionReasonById(reason.value);
   const vacationRequired=policy?.hasVacationTechnicians===true;
   const hasVacation=selectedVacationIds().length>0;
   submit.disabled=!reason.value||(phone&&(!validPhone||!overlaps))||
     (!frozen&&vacationRequired&&!hasVacation);
   if(phone&&validPhone&&!overlaps){
    feedback.textContent='請選擇原預約時間區間內的開始時間（含結束時間），每 10 分鐘一格。';
   }else if(!frozen)feedback.textContent='';
  };
  const updatePreview=()=>{
   const selected=rejectionReasonById(reason.value)||
    (reason.value===frozen?.rejectionReason?rejectionSettings.reasons.find(item=>item.id===reason.value):null);
   memberPreview.hidden=!selected;
   const base=String(selected?.memberDescription||selected?.label||'').trim();
   const names=selectedVacationIds().map(id=>bookedVacationTechnicians.find(item=>item.id===id)?.name||'原選擇技師');
   const preface=names.length?'目前 '+names.join('、')+' 技師休假。\n':'';
   memberPreviewText.textContent=Array.from(preface+base).slice(0,400).join('');
   updateSubmit();
  };
  const updateReason=()=>{
   const selected=rejectionReasonById(reason.value)||
    (reason.value===frozen?.rejectionReason?rejectionSettings.reasons.find(item=>item.id===reason.value):null);
   const hasVacation=selected?.hasVacationTechnicians===true||
    (frozen?.rejectionReason===reason.value&&Array.isArray(frozen.vacationTechnicianIds)&&frozen.vacationTechnicianIds.length>0);
   vacationPanel.hidden=!hasVacation;
   vacationList.replaceChildren();
   vacationBoxes.clear();
   if(hasVacation){
    const known=bookedVacationTechnicians.slice();
    for(const id of frozen?.vacationTechnicianIds||[]){
     if(!known.some(item=>item.id===id))known.push({id,name:'原選擇技師（名單已更新）'});
    }
    if(!known.length)vacationList.append(node('p','本筆預約沒有可選擇的非主要技師。請確認預約中的技師分配。'));
    for(const technician of known){
     const option=node('label');option.className='frontdesk-vacation-option';
     const input=node('input');input.type='checkbox';input.value=technician.id;input.name='vacationTechnicianIds';
     input.disabled=Boolean(frozen);
     input.checked=Boolean(frozen?.vacationTechnicianIds?.includes(technician.id));
     input.addEventListener('change',()=>{
      if(selectedVacationIds().length>10){input.checked=false;feedback.textContent='最多可勾選 10 位休假技師。';}
      else feedback.textContent='';
      updatePreview();
     });
     vacationBoxes.set(technician.id,input);
     option.append(input,node('span',String(technician.name||'未命名技師')));
     vacationList.append(option);
    }
   }
   phonePanel.hidden=!requiresConflictTime();
   if(phonePanel.hidden&&!frozen)feedback.textContent='';
   updatePreview();
  };
  reason.onchange=updateReason;time.onchange=updateSubmit;duration.onchange=updateSubmit;
  if(frozen?.status==='rejected'){
   reason.value=frozen.rejectionReason||'';reason.disabled=true;
   if(frozen.phoneRequestId){if(!Array.from(time.options).some(option=>option.value===frozen.startTime)){const opt=node('option',frozen.startTime);opt.value=frozen.startTime;time.append(opt);}time.value=frozen.startTime||time.value;time.disabled=true;const frozenMinutes=String(frozen.totalDurationMinutes||duration.value);if(!Array.from(duration.options).some(option=>option.value===frozenMinutes)){const opt=node('option',frozenMinutes+' 分鐘');opt.value=frozenMinutes;duration.append(opt);}duration.value=frozenMinutes;duration.disabled=true;}
   feedback.textContent='上次結果尚未確認，僅能重試相同內容。';
  }
  form.onsubmit=event=>{
   event.preventDefault();if(busy)return;
   if(!reason.value){feedback.textContent='請選擇拒絕原因。';reason.focus();return;}
   const phone=requiresConflictTime();
   const policy=rejectionReasonById(reason.value);
   const vacationIds=policy?.hasVacationTechnicians===true?selectedVacationIds():null;
   if(!frozen&&vacationIds&&!vacationIds.length){
    feedback.textContent='請至少勾選一位休假技師。';return;
   }
   if(phone&&(!validDuration()||!validTime()||!bookingDate)){
   feedback.textContent='請選擇原預約區間內的衝突開始時間與服務總時長（每 10 分鐘）。';return;
  }
  if(phone&&!hasConflict()){
   feedback.textContent='請選擇原預約時間區間內的開始時間（含結束時間），每 10 分鐘一格。';return;
  }
  const detail=phone?{startTime:time.value,totalDurationMinutes:Number(duration.value)}:null;
   const names=vacationIds?.map(id=>bookedVacationTechnicians.find(item=>item.id===id)?.name||'技師').join('、');
   const label=reason.options[reason.selectedIndex]?.textContent||reason.value;
   if(!frozen&&!confirmFrontdeskReview(booking,'rejected',label+(names?'；休假技師：'+names:''),detail))return;
   void review(booking,'rejected',submit,reason.value,detail,()=>close(true),vacationIds);
  };
  updateReason();reason.focus();
 }
 // LIFF sends only to the current chat. Staff must open this entry in their
 // merchant OA one-on-one chat; the chat identifier is not exposed by LINE.
 function frontdeskApplicationText(){
  const store=String(document.getElementById('businessName')?.textContent||'商家')
   .replace(/[\r\n\t\u0000-\u001f]/g,' ').trim().slice(0,80);
  return ['【櫃檯人員權限申請】','商家：'+store,'狀態：等待商家管理員審核',
   '我已送出櫃檯使用權限申請，請協助審核。'].join('\n');
 }
 async function sendFrontdeskApplicationFromCurrentChat(person){
  if(person?.status!=='pending'||!/^@[A-Za-z0-9._-]{3,40}$/.test(String(frontdeskPolicy?.oaId||'')))return 'unavailable';
  const sdk=window.liff;
  if(!sdk?.isInClient?.()||typeof sdk.getContext!=='function'||typeof sdk.sendMessages!=='function')return 'unavailable';
  let context;
  try{context=sdk.getContext();}catch{return 'unavailable';}
  if(context?.type!=='utou'||!Array.isArray(context.scope)||!context.scope.includes('chat_message.write'))return 'unavailable';
  try{
   const permission=await sdk.permission?.query?.('chat_message.write');
   if(permission?.state!=='granted')return 'permission_required';
   await sdk.sendMessages([{type:'text',text:frontdeskApplicationText()}]);
   return 'sent';
  }catch{return 'failed';}
 }
 async function load(){
  const generation=++epoch,data=await request('frontdesk.bootstrap');if(generation!==epoch)return false;
  account.replaceChildren();list.replaceChildren();showBookingToolbar(false);
  const history=document.getElementById('frontdeskConflictHistory');
  const person=data.staff;
  // Authorized booking sync is not a logout: keep already loaded history visible.
  // Permission downgrade is a privacy boundary and always purges history.
  if(!person||person.status!=='approved'||person.permissionMode!=='review'){
   clearPrivateHistory();
  }
   if(!person||person.status!=='approved'||person.permissionMode!=='review')stopSync();
  if(!person){
   showProgress(1);
   account.append(node('h2','申請櫃檯人員資格'));
   account.append(node('p','請從商家的 LINE 官方帳號一對一聊天室開啟櫃檯入口，再提出申請。申請建立後會嘗試在目前聊天室自動發送訊息，不需再按 LINE 傳送。核准前無法查看或處理預約。'));
   const b=node('button','送出櫃檯人員申請');b.type='button';b.className='frontdesk-primary';
   b.onclick=async()=>{if(busy)return;lock(true);const finishFeedback=window.AsyncActionFeedback?.begin('正在送出櫃檯資格申請…');try{
     const result=await request('frontdesk.apply');
     const delivery=await sendFrontdeskApplicationFromCurrentChat(result.staff);
     await load();
     status.textContent=delivery==='sent'?'申請已建立，已在目前 LINE 聊天室以你的身分自動送出申請訊息；請等待管理員審核。':
      delivery==='permission_required'?'申請已建立，但 LINE 尚未授權聊天訊息發送（chat_message.write）；無法自動傳送，請聯絡管理員確認 LIFF 權限。':
      delivery==='failed'?'申請已建立，但 LINE 自動傳訊失敗；請從商家官方帳號聊天室重新進入並聯絡管理員確認申請。':
      '申請已建立，但目前不是具備聊天發訊授權的 LINE 一對一 LIFF 聊天室，無法自動傳送；請從商家官方帳號聊天室進入。';
    }catch(e){failure(e);}finally{finishFeedback?.();lock(false);}};
   account.append(b);status.textContent='尚未申請櫃檯資格。';
   return;
  }
  const state={pending:'等待商家管理員審核',approved:person.permissionMode==='review'?'可確認／拒絕預約':'僅接收預約訊息',rejected:'申請未通過，請聯絡商家管理員',suspended:'櫃檯權限已停用，請聯絡商家管理員'}[person.status];
  const identity=node('div');identity.className='frontdesk-identity';
  identity.append(node('h2',person.displayName||'櫃檯人員'));
  if(person.status==='approved'){const chip=node('span','已核准');chip.className='frontdesk-permission';identity.append(chip);}
  account.append(identity,node('p','審核狀態：'+(state||'尚未取得使用資格')));
  if(person.status==='pending'){
   showProgress(2);
   account.append(node('p','申請已送出。請商家管理員前往「LINE 設定 → 預約 → 櫃檯官方帳號與人員權限」核准資格。核准前無法收通知或操作預約。'));
   account.append(node('p','自動送訊僅支援從商家 LINE 官方帳號一對一聊天室開啟、且已授權 chat_message.write 的 LIFF；從其他聊天或瀏覽器開啟時，無法指定官方帳號為收件者。'));
   status.textContent='資格審核中，可以按「重新整理」查看結果。';return;
  }
  if(person.status!=='approved'){
   showProgress(2);
   account.append(node('p','此身分目前無法使用櫃檯功能。請聯絡商家管理員。'));
   status.textContent='尚未取得櫃檯使用資格。';return;
  }
  showProgress(3);
  if(person.permissionMode==='review'){
   showBookingToolbar(true);
   if(history)history.hidden=false;
   const result=await request('frontdesk.bookings',bookingId?{bookingId}:{});if(generation!==epoch)return false;
   if(result.rejectionSettings&&Array.isArray(result.rejectionSettings.reasons)){
     rejectionSettings=result.rejectionSettings;
    }else{
     rejectionSettings={dropdownTitle:'請選擇拒絕原因',reasons:legacyRejectionReasons};
    }
    renderBookings(result.bookings||[]);
   if(bookingId&&!historyLoaded){historyLoaded=true;void loadConflictHistory();}
    startSync();
   status.textContent='審核已通過，可處理目前商家的待確認預約。';
  }else{
   account.append(node('p','管理員已核准「僅接收預約訊息」，不會顯示會員資料與預約操作。'));
   status.textContent='審核已通過，已開通 LINE 預約通知權限。';
  }
  return person.permissionMode==='review';
 }
 async function start(){
  lock(true);const finishFeedback=window.AsyncActionFeedback?.begin('正在載入櫃檯身分與預約資料…');try{
   stopSync();epoch++;idToken=null;historyLoaded=false;clearPrivateHistory();
   account.replaceChildren();list.replaceChildren();
   showProgress(0);showBookingToolbar(false);status.textContent='正在確認 LINE 身分…';
   if(!business)throw Error('請使用商家提供的完整櫃檯入口。');
   const r=await fetch('/config/config.json',{cache:'no-store'});if(!r.ok)throw Error('無法取得本環境設定。');config=await r.json();
   const data=await request('frontdesk.public');frontdeskPolicy=data.frontdesk||{};const title=String(frontdeskPolicy.pageTitle||'').trim()||data.name+'｜櫃檯';document.getElementById('businessName').textContent=title;document.title=title+'｜櫃檯工作台';
   if(bookingId){const heading=document.getElementById('frontdeskHistoryHeading');if(heading)heading.textContent='本筆預約處理紀錄';const historyMessage=document.querySelector('[data-frontdesk-history-status]');if(historyMessage)historyMessage.textContent='僅顯示這筆預約的原預約資料及對應的現場預約資料。';}
   if(!data.frontdesk?.enabled||!data.frontdesk.liffId)throw Error('商家尚未啟用櫃檯入口，請聯絡管理員完成 LINE 設定後再申請。');
   idToken=await authenticateLineOnOpen(data.frontdesk.liffId);
   if(!idToken)return;
   await load();
  }catch(error){failure(error);}finally{finishFeedback?.();lock(false);window.dispatchEvent(new CustomEvent('frontdesk-ready'));}
 }
 refresh.onclick=async()=>{if(busy||pending.size){status.textContent='請先完成目前操作或重試相同操作。';return;}if(!idToken){status.textContent='請重新開啟商家櫃檯入口完成 LINE 身分驗證。';return;}lock(true);const finishFeedback=window.AsyncActionFeedback?.begin('正在更新櫃檯資格與預約清單…');try{await load();status.textContent='已更新櫃檯人員資格與預約權限。';}catch(e){failure(e);}finally{finishFeedback?.();lock(false);}};
 document.addEventListener('visibilitychange',()=>{if(canSync())scheduleSync(0);else if(syncTimer!==null){clearTimeout(syncTimer);syncTimer=null;}});
 window.addEventListener('online',()=>{if(canSync())scheduleSync(0);});
 window.addEventListener('focus',()=>{if(canSync())scheduleSync(0);});
 window.addEventListener('pageshow',event=>{if(event.persisted)void start();});
 window.addEventListener('pagehide',()=>{stopSync();epoch++;idToken=null;list.replaceChildren();clearPrivateHistory();});
 void start();
})();
