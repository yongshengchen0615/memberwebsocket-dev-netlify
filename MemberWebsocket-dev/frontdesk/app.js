(() => {
 'use strict';
 const params=new URLSearchParams(location.search),nested=new URLSearchParams((params.get('liff.state')||'').split('?').pop());
 const business=params.get('business')||nested.get('business'),bookingId=params.get('bookingId')||nested.get('bookingId');
 const status=document.getElementById('status'),account=document.getElementById('account'),list=document.getElementById('bookings'),refresh=document.getElementById('refresh');
 let config,idToken,busy=false,epoch=0;const pending=new Map();
 let syncTimer=null,syncEnabled=false,syncInFlight=false,syncRevision=null,syncFailures=0,syncGeneration=0;
 const node=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
 const progress=document.getElementById('progress'),toolbar=document.querySelector('.frontdesk-toolbar');
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
 async function request(action,body={}){
  let response,data;try{response=await fetch(config.supabaseFunctionUrl.replace(/\/api\/?$/,'/frontdesk-api'),{method:'POST',cache:'no-store',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',apikey:config.supabasePublishableKey},body:JSON.stringify({...body,action,business,idToken})});data=await response.json();}
  catch{throw Object.assign(Error('無法確認伺服器結果，請重試相同操作。'),{uncertain:true});}
  if(!response.ok||!data.ok)throw Object.assign(Error(data.error?.message||'櫃檯服務暫時無法使用。'),{code:data.error?.code,denied:response.status===401||response.status===403,uncertain:response.status>=500});
  return data.data;
 }
 function failure(error,keepAccount=false){status.textContent=error.message;if(error.denied){epoch++;list.replaceChildren();if(!keepAccount)account.replaceChildren();}if(['AUTH_INVALID','FRONTDESK_AUTH_INVALID'].includes(error.code)){const b=node('button','重新登入 LINE');b.type='button';b.onclick=()=>{window.liff.logout();window.liff.login({redirectUri:location.href});};account.replaceChildren(b);list.replaceChildren();}}
 async function review(booking,next,button,rejectionReason){
  if(busy)return;const key=booking.id,known=pending.get(key);
  if(known&&known.status!==next){status.textContent='前次操作結果尚未確認，請先重試相同操作。';return;}
  if(!known&&next==='rejected'&&!['technician_leave','unrecorded_phone_booking'].includes(rejectionReason)){
   status.textContent='請先選擇拒絕原因。';return;
  }
  const body=known||{bookingId:key,status:next,expectedUpdatedAt:booking.updatedAt,requestId:crypto.randomUUID(),...(next==='rejected'?{rejectionReason}:{})};pending.set(key,body);lock(true);const generation=epoch;
  try{await request('frontdesk.booking.update',body);if(generation!==epoch)return;pending.delete(key);await load();status.textContent=next==='confirmed'?'預約已確認。':'預約已拒絕。';}
  catch(error){if(generation!==epoch)return;let refreshed=false;if(!error.uncertain){pending.delete(key);try{await load();refreshed=true;}catch{}}else button.textContent='重試相同操作';failure(error,refreshed);}
  finally{lock(false);}
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
    const reasonLabel=node('label','拒絕預約原因');reasonLabel.className='frontdesk-rejection-field';
    const reasonSelect=node('select');reasonSelect.setAttribute('aria-label','選擇拒絕預約原因');
    for(const [code,label] of [['','請選擇拒絕原因'],['technician_leave','預約中有休假技師'],['unrecorded_phone_booking','該時段已被現場人員預約但未登記']]){
      const option=node('option',label);option.value=code;reasonSelect.append(option);
    }
    reasonLabel.append(reasonSelect);card.append(reasonLabel);
    const actions=node('div');actions.className='frontdesk-actions';
    for(const [next,label]of [['confirmed','確認預約'],['rejected','拒絕預約']]){
     const b=node('button',label);b.type='button';b.dataset.reviewAction=next;
     b.className=next==='confirmed'?'frontdesk-primary':'frontdesk-danger';
     b.onclick=()=>void review(booking,next,b,reasonSelect.value);actions.append(b);
    }
    card.append(actions);
   }else if(booking.cancellationPending){
    const hint=node('p','取消申請待審核，請交由商家管理員處理。');hint.className='frontdesk-cancellation';card.append(hint);
   }
   list.append(card);
  }
 }

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

 async function openPhoneBookingForm(button){
  const previous=account.querySelector('[data-phone-registration]');
  if(previous){previous.remove();button.setAttribute('aria-expanded','false');return;}
  const panel=node('section');panel.className='frontdesk-phone';panel.dataset.phoneRegistration='true';
  const form=node('form');form.className='frontdesk-phone-form';form.noValidate=false;
  const heading=node('h3','登記電話／現場預約');
  const hint=node('p','請登記客人預約的項目與開始時間。送出後立即保留整段時段，並交由管理端確認；其他用戶將無法選用被占用的時間。');
  const message=node('p');message.className='frontdesk-phone-message';message.setAttribute('role','status');message.setAttribute('aria-live','polite');
  const serviceField=node('label','預約項目');
  const serviceSelect=node('select');serviceSelect.required=true;serviceSelect.setAttribute('aria-label','選擇電話預約項目');
  serviceField.append(serviceSelect);
  const addButton=node('button','增加預約項目');addButton.type='button';
  const selectedList=node('div');selectedList.className='frontdesk-phone-items';
  const dateField=node('label','預約日期');
  const dateInput=node('input');dateInput.type='date';dateInput.required=true;
  dateField.append(dateInput);
  const timesField=node('fieldset');timesField.className='frontdesk-phone-times';
  timesField.append(node('legend','可預約開始時間'));
  const times=node('div');times.className='frontdesk-phone-slots';times.setAttribute('role','group');times.setAttribute('aria-label','電話預約開始時間');timesField.append(times);
  const surnameField=node('label','客人姓氏');
  const surname=node('input');surname.type='text';surname.required=true;surname.maxLength=40;surname.placeholder='例如：陳';surnameField.append(surname);
  const salutationField=node('label','稱謂');
  const salutation=node('select');
  for(const [value,label] of [['mr','先生'],['ms','小姐']]){const option=node('option',label);option.value=value;salutation.append(option);}
  salutationField.append(salutation);
  const phoneField=node('label','聯絡電話（選填）');
  const phone=node('input');phone.type='tel';phone.maxLength=35;phone.placeholder='例如：0912345678';phoneField.append(phone);
  const noteField=node('label','櫃檯備註（選填）');
  const note=node('textarea');note.maxLength=500;note.rows=2;noteField.append(note);
  const actions=node('div');actions.className='frontdesk-actions';
  const submit=node('button','送出，等待管理員確認');submit.className='frontdesk-primary';submit.type='submit';submit.disabled=true;
  const cancel=node('button','關閉');cancel.type='button';cancel.onclick=()=>{panel.remove();button.setAttribute('aria-expanded','false');};
  actions.append(submit,cancel);
  form.append(heading,hint,serviceField,addButton,selectedList,dateField,timesField,surnameField,salutationField,phoneField,noteField,message,actions);
  panel.append(form);account.append(panel);button.setAttribute('aria-expanded','true');
  let services=[],selected=new Map(),selectedTime='',slotGeneration=0,pendingCreate=null;
  const businessDate=()=>{
   const p={};new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'})
     .formatToParts(new Date()).forEach(x=>{if(x.type!=='literal')p[x.type]=x.value;});
   return p.year+'-'+p.month+'-'+p.day;
  };
  const shifted=(value,days)=>{const d=new Date(value+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
  const items=()=>Array.from(selected,([serviceId,quantity])=>({serviceId,quantity}));
  const renderSelected=()=>{
   selectedList.replaceChildren();
   for(const [id,quantity] of selected){
    const service=services.find(x=>x.id===id);if(!service)continue;
    const row=node('div');row.className='frontdesk-phone-item';
    row.append(node('span',service.title+' × '+quantity));
    const increase=node('button','增加');increase.type='button';increase.disabled=quantity>=2;
    increase.onclick=()=>{selected.set(id,quantity+1);renderSelected();void refreshSlots();};
    const decrease=node('button',quantity===1?'移除':'減少');decrease.type='button';
    decrease.onclick=()=>{if(quantity===1)selected.delete(id);else selected.set(id,quantity-1);renderSelected();void refreshSlots();};
    row.append(increase,decrease);selectedList.append(row);
   }
   if(!selected.size)selectedList.append(node('p','尚未選擇預約項目。'));
  };
  const refreshSlots=async()=>{
   const generation=++slotGeneration;selectedTime='';times.replaceChildren();submit.disabled=true;
   if(!selected.size){message.textContent='請先選擇預約項目。';return;}
   if(!dateInput.value){message.textContent='請選擇預約日期。';return;}
   if(pendingCreate){message.textContent='上次電話預約尚未確認結果，請先重試相同登記內容。';return;}
   message.textContent='正在取得可預約時段…';
   try{
    const data=await request('frontdesk.phone.slots',{bookingDate:dateInput.value,items:items()});
    if(generation!==slotGeneration||!panel.isConnected)return;
    const slots=Array.isArray(data.slots)?data.slots:[];
    if(!slots.length){message.textContent=data.reason==='holiday'?'當日為休假日，無法登記。':'這個日期沒有可登記的時間。';return;}
    for(const slot of slots){
     const b=node('button',slot.startTime);b.type='button';b.className='frontdesk-phone-slot';
     b.disabled=!slot.available;b.dataset.startTime=slot.startTime;b.dataset.available=String(!!slot.available);
     b.setAttribute('aria-pressed','false');
     b.title=slot.available?'可登記':'時間已被預約或不可使用';
     b.onclick=()=>{
      selectedTime=slot.startTime;
      times.querySelectorAll('button').forEach(el=>el.setAttribute('aria-pressed',String(el===b)));
      submit.disabled=false;message.textContent='已選擇 '+selectedTime+'，請確認聯絡資料。';
     };
     times.append(b);
    }
    message.textContent='灰色時段代表不可預約，請選擇可用時間。';
   }catch(error){if(generation===slotGeneration)message.textContent=error.message;}
  };
  addButton.onclick=()=>{
   const id=serviceSelect.value;
   if(!id||selected.size>=20&&!selected.has(id)){message.textContent='最多登記 20 個不同預約項目。';return;}
   selected.set(id,Math.min(2,(selected.get(id)||0)+1));renderSelected();void refreshSlots();
  };
  dateInput.addEventListener('change',()=>void refreshSlots());
  form.onsubmit=async event=>{
   event.preventDefault();if(busy||!selectedTime&&!pendingCreate)return;
   if(!pendingCreate)pendingCreate={
     requestId:'PHONE-'+crypto.randomUUID(),bookingDate:dateInput.value,startTime:selectedTime,
     contactSurname:surname.value.trim(),contactSalutation:salutation.value,
     contactPhone:phone.value.trim(),adminNote:note.value.trim(),items:items(),
   };
   const body=pendingCreate;lock(true);
   try{
    const result=await request('frontdesk.phone.create',body);
    if(result.status!=='pending')throw Object.assign(Error('無法確認是否已送達管理端，請使用相同資料重試。'),{uncertain:true});
    pendingCreate=null;await load();status.textContent='電話預約已登記，時間已保留，等待管理員確認。';
   }catch(error){
    if(!error.uncertain)pendingCreate=null;
    if(panel.isConnected){message.textContent=error.message;submit.disabled=false;}
    if(['PHONE_BOOKING_CONFLICT','BOOKING_SLOT_TAKEN'].includes(error.code)){pendingCreate=null;void refreshSlots();}
   }finally{lock(false);if(panel.isConnected)submit.disabled=!selectedTime&&!pendingCreate;}
  };
  message.textContent='正在載入店家可預約項目…';
  try{
   const data=await request('frontdesk.phone.catalog');if(!panel.isConnected)return;
   services=Array.isArray(data.services)?data.services:[];
   serviceSelect.replaceChildren();
   for(const service of services){const opt=node('option',service.title+'（'+service.durationMinutes+' 分鐘）');opt.value=service.id;serviceSelect.append(opt);}
   if(!services.length){message.textContent='店家尚未設定可登記項目。';return;}
   const cfg=data.settings||{},today=businessDate();
   dateInput.min=shifted(today,Number(cfg.minAdvanceDays||0));
   if(Number(cfg.maxAdvanceDays||0)>0)dateInput.max=shifted(today,Number(cfg.maxAdvanceDays));
   dateInput.value=dateInput.min;renderSelected();
   message.textContent='選擇預約項目後，即可查看尚未被占用的開始時段。';
  }catch(error){if(panel.isConnected)message.textContent=error.message;}
 }

 async function load(){
  const generation=++epoch,data=await request('frontdesk.bootstrap');if(generation!==epoch)return false;
  account.replaceChildren();list.replaceChildren();showBookingToolbar(false);
  const person=data.staff;
   if(!person||person.status!=='approved'||person.permissionMode!=='review')stopSync();
  if(!person){
   showProgress(1);
   account.append(node('h2','申請櫃檯人員資格'));
   account.append(node('p','使用 LINE 登入後，請確認已加入商家提供的櫃檯官方帳號，再按下方按鈕提出申請。商家管理員核准前，你無法收通知、查看或處理任何預約。'));
   const b=node('button','送出櫃檯人員申請');b.type='button';b.className='frontdesk-primary';
   b.onclick=async()=>{if(busy)return;lock(true);try{await request('frontdesk.apply');await load();}catch(e){failure(e);}finally{lock(false);}};
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
   const phoneButton=node('button','登記電話／現場預約');phoneButton.type='button';
   phoneButton.className='frontdesk-primary';phoneButton.setAttribute('aria-expanded','false');
   phoneButton.onclick=()=>void openPhoneBookingForm(phoneButton);
   account.append(phoneButton);
   const result=await request('frontdesk.bookings',bookingId?{bookingId}:{});if(generation!==epoch)return false;
   renderBookings(result.bookings||[]);
    startSync();
   status.textContent='審核已通過，可處理目前商家的待確認預約。';
  }else{
   account.append(node('p','管理員已核准「僅接收預約訊息」，不會顯示會員資料與預約操作。'));
   status.textContent='審核已通過，已開通 LINE 預約通知權限。';
  }
  return person.permissionMode==='review';
 }
 async function start(){
  lock(true);try{
   showProgress(0);showBookingToolbar(false);
   if(!business)throw Error('請使用商家提供的完整櫃檯入口。');
   const r=await fetch('/config/config.json',{cache:'no-store'});if(!r.ok)throw Error('無法取得本環境設定。');config=await r.json();
   const data=await request('frontdesk.public');document.getElementById('businessName').textContent=data.name+'｜櫃檯';
   if(!data.frontdesk?.enabled||!data.frontdesk.liffId)throw Error('商家尚未啟用櫃檯入口，請聯絡管理員完成 LINE 設定後再申請。');
   await window.liff.init({liffId:data.frontdesk.liffId});if(!window.liff.isLoggedIn()){window.liff.login({redirectUri:location.href});return;}
   idToken=window.liff.getIDToken();await load();
  }catch(error){failure(error);}finally{lock(false);window.dispatchEvent(new CustomEvent('frontdesk-ready'));}
 }
 refresh.onclick=async()=>{if(busy||pending.size){status.textContent='請先完成目前操作或重試相同操作。';return;}lock(true);try{await load();status.textContent='已更新櫃檯人員資格與預約權限。';}catch(e){failure(e);}finally{lock(false);}};
 document.addEventListener('visibilitychange',()=>{if(canSync())scheduleSync(0);else if(syncTimer!==null){clearTimeout(syncTimer);syncTimer=null;}});
 window.addEventListener('online',()=>{if(canSync())scheduleSync(0);});
 window.addEventListener('focus',()=>{if(canSync())scheduleSync(0);});
 window.addEventListener('pageshow',event=>{if(event.persisted)void start();});
 window.addEventListener('pagehide',()=>{stopSync();epoch++;idToken=null;list.replaceChildren();});
 void start();
})();
