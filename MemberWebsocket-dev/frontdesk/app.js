(() => {
 'use strict';
 const params=new URLSearchParams(location.search),nested=new URLSearchParams((params.get('liff.state')||'').split('?').pop());
 const business=params.get('business')||nested.get('business'),bookingId=params.get('bookingId')||nested.get('bookingId');
 const status=document.getElementById('status'),account=document.getElementById('account'),list=document.getElementById('bookings'),refresh=document.getElementById('refresh');
 let config,idToken,busy=false,epoch=0;const pending=new Map();
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
 function lock(value){busy=value;for(const b of document.querySelectorAll('button'))b.disabled=value;}
 async function request(action,body={}){
  let response,data;try{response=await fetch(config.supabaseFunctionUrl.replace(/\/api\/?$/,'/frontdesk-api'),{method:'POST',cache:'no-store',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',apikey:config.supabasePublishableKey},body:JSON.stringify({...body,action,business,idToken})});data=await response.json();}
  catch{throw Object.assign(Error('無法確認伺服器結果，請重試相同操作。'),{uncertain:true});}
  if(!response.ok||!data.ok)throw Object.assign(Error(data.error?.message||'櫃檯服務暫時無法使用。'),{code:data.error?.code,denied:response.status===401||response.status===403,uncertain:response.status>=500});
  return data.data;
 }
 function failure(error,keepAccount=false){status.textContent=error.message;if(error.denied){epoch++;list.replaceChildren();if(!keepAccount)account.replaceChildren();}if(['AUTH_INVALID','FRONTDESK_AUTH_INVALID'].includes(error.code)){const b=node('button','重新登入 LINE');b.type='button';b.onclick=()=>{window.liff.logout();window.liff.login({redirectUri:location.href});};account.replaceChildren(b);list.replaceChildren();}}
 async function review(booking,next,button){
  if(busy)return;const key=booking.id,known=pending.get(key);
  if(known&&known.status!==next){status.textContent='前次操作結果尚未確認，請先重試相同操作。';return;}
  const body=known||{bookingId:key,status:next,expectedUpdatedAt:booking.updatedAt,requestId:crypto.randomUUID()};pending.set(key,body);lock(true);const generation=epoch;
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
    const actions=node('div');actions.className='frontdesk-actions';
    for(const [next,label]of [['confirmed','確認預約'],['rejected','拒絕預約']]){
     const b=node('button',label);b.type='button';b.dataset.reviewAction=next;
     b.className=next==='confirmed'?'frontdesk-primary':'frontdesk-danger';
     b.onclick=()=>void review(booking,next,b);actions.append(b);
    }
    card.append(actions);
   }else if(booking.cancellationPending){
    const hint=node('p','取消申請待審核，請交由商家管理員處理。');hint.className='frontdesk-cancellation';card.append(hint);
   }
   list.append(card);
  }
 }
 async function load(){
  const generation=++epoch,data=await request('frontdesk.bootstrap');if(generation!==epoch)return;
  account.replaceChildren();list.replaceChildren();showBookingToolbar(false);
  const person=data.staff;
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
   const result=await request('frontdesk.bookings',bookingId?{bookingId}:{});if(generation!==epoch)return;
   renderBookings(result.bookings||[]);
   status.textContent='審核已通過，可處理目前商家的待確認預約。';
  }else{
   account.append(node('p','管理員已核准「僅接收預約訊息」，不會顯示會員資料與預約操作。'));
   status.textContent='審核已通過，已開通 LINE 預約通知權限。';
  }
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
 window.addEventListener('pagehide',()=>{epoch++;idToken=null;list.replaceChildren();},{once:true});
 void start();
})();
