(() => {
 'use strict';
 const node=(tag,text,attributes={})=>{const el=document.createElement(tag);if(text)el.textContent=text;for(const [key,value]of Object.entries(attributes))el.setAttribute(key,String(value));return el;};
 window.BookingRiskSettings={mount(container,{data,request}){
  if(!data?.policy || !container || container.querySelector('#bookingRiskSettings'))return;
  const section=node('section','',{id:'bookingRiskSettings','aria-labelledby':'bookingRiskTitle'});container.append(section);
  let current=data,busy=false,dirty=false;
  const draw=()=>{
   const active=(current.restrictions||[]).filter(r=>!r.revoked_at&&Number.isFinite(Date.parse(r.ends_at))&&Date.parse(r.ends_at)>Date.now());
   const pending=(current.appeals||[]).filter(a=>!a.resolved_at);
   section.replaceChildren(node('h3','爽約與線上預約限制',{id:'bookingRiskTitle'}),node('p','只限制新的線上預約，保留登入、既有預約、票券與點數；政策停用期間不執行限制。'));
   const summary=node('div','',{class:'booking-risk-overview','aria-label':'爽約政策概況'});
   const metric=(title,value,detail)=>{const card=node('div','',{class:'booking-risk-metric'});card.append(node('span',title),node('strong',String(value)),node('small',detail));summary.append(card);};
   metric('目前政策',current.policy.enabled?'啟用':'停用','停用時不執行新的限制');
   metric('未到期的限制',active.length,'包含暫停期間保留的紀錄');
   metric('待處理申覆',pending.length,'回覆不會自動解除限制');
   section.append(summary,node('h4','限制政策設定',{class:'booking-risk-policy-heading'}));
   const form=node('form','',{class:'booking-admin-form booking-admin-settings-form booking-risk-policy-form'}),p=current.policy,fields={};
   let target=form;
   const group=(title,help)=>{const block=node('div','',{class:'booking-risk-field-group'});block.append(node('h5',title),node('p',help));target=node('div','',{class:'booking-risk-field-grid'});block.append(target);form.append(block);};
   const field=(key,title,type='number',value=p[key])=>{
    const label=node('label',title),input=node('input','',{name:key,type});input.value=value??'';
    if(type==='checkbox')input.checked=value===true;else if(type==='number'){input.min=key==='grace_minutes'?'0':'1';input.max=({threshold_count:100,lookback_days:3650,duration_count:120,grace_minutes:1440})[key];input.step='1';}
    label.append(input);target.append(label);fields[key]=input;return input;
   };
   group('政策開關','預設停用；儲存後才會生效。');field('enabled','啟用限制','checkbox');
   group('一、爽約計次','依現有服務結束時間及伺服器規則判定。');
   field('lookback_days','計次期間（天）');field('threshold_count','達到幾次爽約');field('grace_minutes','服務結束後寬限（分鐘）');
   group('二、限制期限','只影響新線上預約，不會取消既有預約。');field('duration_count','限制期限數量');
   const durationLabel=node('label','限制期限單位'),duration=node('select','',{name:'duration_unit'});
   for(const [value,text]of [['','請選擇'],['weeks','週'],['months','個月']])duration.append(node('option',text,{value}));duration.value=p.duration_unit||'';durationLabel.append(duration);target.append(durationLabel);fields.duration_unit=duration;
   group('三、會員申覆與客服','會員可透過聯絡方式詢問或使用電話預約。');field('appeal_enabled','允許會員申覆','checkbox');
   field('contact_text','電話預約／客服聯絡方式','text');fields.contact_text.maxLength=500;
   const save=node('button','儲存政策',{type:'submit',class:'button button-dark'}),refresh=node('button','更新紀錄',{type:'button',class:'button button-outline'}),status=node('p','',{role:'status','aria-live':'polite'});
   const preview=node('div','',{class:'booking-risk-preview','aria-live':'polite'}),draft=node('p','',{class:'booking-risk-draft'});
   const discard=node('button','還原變更',{type:'button',class:'button button-outline',disabled:''});
   const actions=node('div','',{class:'booking-risk-form-actions'});actions.append(discard,save);form.append(preview,draft,actions);section.append(form,refresh,status);
   const collect=()=>{const policy={version:p.version};for(const [key,input]of Object.entries(fields))policy[key]=input.type==='checkbox'?input.checked:input.value;return policy;};
   const baseline=JSON.stringify(collect());
   const updateDraft=()=>{
     const next=collect();dirty=JSON.stringify(next)!==baseline;discard.disabled=busy||!dirty;
     draft.textContent=dirty?'有未儲存的變更，請儲存或還原。':'已載入目前政策，尚未修改。';
     const valid=['lookback_days','threshold_count','duration_count','grace_minutes'].every(k=>next[k]!==''&&Number.isInteger(Number(next[k])));
     preview.textContent=(dirty?'尚未儲存｜':'目前政策｜')+(next.enabled?(valid&&['weeks','months'].includes(next.duration_unit)
       ?next.lookback_days+' 天內達到 '+next.threshold_count+' 次爽約，限制新線上預約 '+next.duration_count+(next.duration_unit==='weeks'?' 週':' 個月')+'；寬限 '+next.grace_minutes+' 分鐘。'
       :'請完整設定計次、限制期限與客服聯絡方式。'):'限制未啟用，不會依此政策阻擋新的線上預約。');
   };
   form.addEventListener('input',updateDraft);form.addEventListener('change',updateDraft);
   discard.addEventListener('click',()=>{if(busy||!dirty)return;draw();section.querySelector('[role=status]').textContent='已還原未儲存的政策變更。';});updateDraft();
   const run=async(action,body)=>{
    if(busy)return;
    busy=true;const controls=[...section.querySelectorAll('button,input,select')],disabled=controls.map(control=>control.disabled);
    controls.forEach(control=>control.disabled=true);section.setAttribute('aria-busy','true');status.textContent='正在處理，請稍候…';
    try{const result=await request(action,body);if(!result?.policy)throw Error('無法確認操作結果，請更新後核對。');current=result;draw();section.querySelector('[role=status]').textContent=action==='get'?'已更新紀錄。':action==='save'?'政策已儲存並重新載入。':'操作已完成，紀錄已更新。';}
    catch(error){status.textContent=(error.message||'操作失敗。')+' 輸入內容已保留，請核對後重試。';}
    finally{busy=false;controls.forEach((control,index)=>control.disabled=disabled[index]);section.setAttribute('aria-busy','false');if(section.contains(form))updateDraft();}
   };
   form.addEventListener('submit',event=>{event.preventDefault();if(busy)return;const policy=collect();
    if(policy.enabled&&['threshold_count','lookback_days','duration_count','duration_unit','grace_minutes','contact_text'].some(k=>!String(policy[k]).trim())){status.textContent='啟用前請完整設定所有參數與聯絡方式。';return;}
    if(policy.enabled&&Object.entries({lookback_days:[1,3650],threshold_count:[1,100],duration_count:[1,120],grace_minutes:[0,1440]}).some(([key,[lo,hi]])=>!Number.isInteger(Number(policy[key]))||Number(policy[key])<lo||Number(policy[key])>hi)){status.textContent='限制參數超出有效範圍，請確認數值。';return;}void run('save',{policy});
   });
   refresh.addEventListener('click',()=>{if(dirty){status.textContent='有未儲存的變更，請先儲存或還原後更新紀錄。';return;}void run('get',{});});
   const reasonLabel=node('label','撤銷／解除／回覆原因（必填）'),reason=node('input','',{type:'text',maxLength:500});reasonLabel.append(reason);section.append(reasonLabel);
   const action=(label,kind,body)=>{const button=node('button',label,{type:'button',class:'button button-outline'});button.addEventListener('click',()=>{
    if(dirty){status.textContent='有未儲存的政策變更，請先儲存或還原再處理紀錄。';return;}
    if(!reason.value.trim()){status.textContent='請先填寫核對原因。';reason.focus();return;}
    void run(kind,{...body,reason:reason.value.trim()});
   });return button;};
   const events=node('ul','',{class:'booking-risk-record-list'});if(!(current.events||[]).length)events.append(node('li','目前沒有爽約計次紀錄。',{class:'booking-risk-empty'}));for(const e of current.events||[]){const li=node('li',`${e.member_code||'會員'} · ${new Date(e.occurred_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})} · ${e.revoked_at?'已撤銷':'有效爽約'}`);if(!e.revoked_at)li.append(action('撤銷誤判','revoke',{bookingId:e.booking_id}));events.append(li);}section.append(node('h4','最近 100 筆計次'),events);
   const restrictions=node('ul','',{class:'booking-risk-record-list'});if(!active.length)restrictions.append(node('li','目前沒有有效限制紀錄。',{class:'booking-risk-empty'}));for(const r of current.restrictions||[]){if(r.revoked_at||Date.parse(r.ends_at)<=Date.now())continue;const li=node('li',`限制至 ${new Date(r.ends_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}`);li.append(action('人工解除','release',{restrictionId:r.id}));restrictions.append(li);}section.append(node('h4','有效限制'),restrictions);
   const appeals=node('ul','',{class:'booking-risk-record-list'});if(!(current.appeals||[]).length)appeals.append(node('li','目前沒有會員申覆。',{class:'booking-risk-empty'}));for(const a of current.appeals||[]){const li=node('li',`${a.reason} · ${a.resolved_at?'已回覆':'待處理'}`);if(!a.resolved_at)li.append(action('記錄回覆','resolve',{appealId:a.id}));appeals.append(li);}section.append(node('h4','會員申覆'),node('p','回覆只記錄核對結果；需要恢復資格時，請另行撤銷誤判或人工解除。'),appeals);
  };
  draw();
 }};
})();
