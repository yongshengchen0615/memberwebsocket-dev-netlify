(() => {
 'use strict';
 const node=(tag,text,attributes={})=>{const el=document.createElement(tag);if(text)el.textContent=text;for(const [key,value]of Object.entries(attributes))el.setAttribute(key,String(value));return el;};
 window.BookingRiskSettings={mount(container,{data,request}){
  if(!data?.policy || !container || container.querySelector('#bookingRiskSettings'))return;
  const section=node('section','',{id:'bookingRiskSettings','aria-labelledby':'bookingRiskTitle'});container.append(section);
  let current=data;
  const draw=()=>{
   section.replaceChildren(node('h3','爽約與線上預約限制',{id:'bookingRiskTitle'}),node('p','僅限制新的線上預約；保留登入、舊預約、票券與點數。政策預設停用，啟用時開始累計新紀錄。既有限制保留原政策，停用期間不執行限制。'));
   const form=node('form','',{class:'booking-admin-form booking-admin-settings-form'}),p=current.policy,fields={};
   const field=(key,title,type='number',value=p[key])=>{
    const label=node('label',title),input=node('input','',{name:key,type});input.value=value??'';
    if(type==='checkbox')input.checked=value===true;else if(type==='number'){input.min=key==='grace_minutes'?'0':'1';input.max=({threshold_count:100,lookback_days:3650,duration_count:120,grace_minutes:1440})[key];input.step='1';}
    label.append(input);form.append(label);fields[key]=input;return input;
   };
   field('enabled','啟用限制','checkbox');field('lookback_days','計次期間（天）');field('threshold_count','達到幾次爽約');field('duration_count','限制期限數量');
   const durationLabel=node('label','限制期限單位'),duration=node('select','',{name:'duration_unit'});
   for(const [value,text]of [['','請選擇'],['weeks','週'],['months','個月']])duration.append(node('option',text,{value}));duration.value=p.duration_unit||'';durationLabel.append(duration);form.append(durationLabel);fields.duration_unit=duration;
   field('grace_minutes','服務結束後寬限（分鐘）');field('appeal_enabled','允許會員申覆','checkbox');field('contact_text','電話預約／客服聯絡方式','text');fields.contact_text.maxLength=500;
   const save=node('button','儲存政策',{type:'submit',class:'button button-dark'}),refresh=node('button','更新紀錄',{type:'button',class:'button button-ghost'}),status=node('p','',{role:'status','aria-live':'polite'});
   form.append(save);section.append(form,refresh,status);
   const run=async(action,body)=>{save.disabled=true;refresh.disabled=true;try{current=await request(action,body);draw();}catch(error){status.textContent=error.message||'操作失敗，請更新資料。';}finally{save.disabled=false;refresh.disabled=false;}};
   form.addEventListener('submit',event=>{event.preventDefault();const policy={version:p.version};for(const [key,input]of Object.entries(fields))policy[key]=input.type==='checkbox'?input.checked:input.value;
    if(policy.enabled&&['threshold_count','lookback_days','duration_count','duration_unit','grace_minutes','contact_text'].some(k=>!String(policy[k]).trim())){status.textContent='啟用前請完整設定所有參數與聯絡方式。';return;}
    void run('save',{policy});
   });
   refresh.addEventListener('click',()=>void run('get',{}));
   const reasonLabel=node('label','撤銷／解除／回覆原因（必填）'),reason=node('input','',{type:'text',maxLength:500});reasonLabel.append(reason);section.append(reasonLabel);
   const action=(label,kind,body)=>{const button=node('button',label,{type:'button',class:'button button-ghost'});button.addEventListener('click',()=>{
    if(!reason.value.trim()){status.textContent='請先填寫核對原因。';reason.focus();return;}
    button.disabled=true;void run(kind,{...body,reason:reason.value.trim()});
   });return button;};
   const events=node('ul');for(const e of current.events||[]){const li=node('li',`${e.member_code||'會員'} · ${new Date(e.occurred_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})} · ${e.revoked_at?'已撤銷':'有效爽約'}`);if(!e.revoked_at)li.append(action('撤銷誤判','revoke',{bookingId:e.booking_id}));events.append(li);}section.append(node('h4','最近 100 筆計次'),events);
   const restrictions=node('ul');for(const r of current.restrictions||[]){if(r.revoked_at||Date.parse(r.ends_at)<=Date.now())continue;const li=node('li',`限制至 ${new Date(r.ends_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}`);li.append(action('人工解除','release',{restrictionId:r.id}));restrictions.append(li);}section.append(node('h4','有效限制'),restrictions);
   const appeals=node('ul');for(const a of current.appeals||[]){const li=node('li',`${a.reason} · ${a.resolved_at?'已回覆':'待處理'}`);if(!a.resolved_at)li.append(action('記錄回覆','resolve',{appealId:a.id}));appeals.append(li);}section.append(node('h4','會員申覆'),node('p','回覆只記錄核對結果；需要恢復資格時，請另行撤銷誤判或人工解除。'),appeals);
  };
  draw();
 }};
})();
