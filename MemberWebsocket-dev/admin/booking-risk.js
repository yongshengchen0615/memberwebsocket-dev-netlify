(() => {
 'use strict';
 const node=(tag,text,attributes={})=>{const el=document.createElement(tag);if(text)el.textContent=text;for(const [key,value]of Object.entries(attributes))el.setAttribute(key,String(value));return el;};
 const time=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})+'（台北）':'未提供時間';
 const validDates=r=>Number.isFinite(Date.parse(r.starts_at))&&Number.isFinite(Date.parse(r.ends_at))&&Date.parse(r.ends_at)>Date.parse(r.starts_at);
 const active=r=>!r.revoked_at&&validDates(r)&&Date.parse(r.starts_at)<=Date.now()&&Date.parse(r.ends_at)>Date.now();
 window.BookingRiskSettings={mount(container,{data,request}){
  if(!data?.policy || !container || container.querySelector('#bookingRiskSettings'))return;
  const section=node('section','',{id:'bookingRiskSettings','aria-labelledby':'bookingRiskTitle'});container.append(section);
  let current=data,busy=false,dirty=false,conflict=false;
  const draw=()=>{
   const restrictions=current.restrictions||[],pending=(current.appeals||[]).filter(a=>!a.resolved_at);
   const eventsByMember=new Map((current.events||[]).map(e=>[e.member_id,e]));
   const member=record=>record.member_code||eventsByMember.get(record.member_id)?.member_code||'會員識別：'+(record.member_id||'未提供');
   section.replaceChildren(node('h3','爽約與線上預約限制',{id:'bookingRiskTitle'}),node('p','只限制新的線上預約，保留登入、既有預約、票券與點數；政策停用期間不執行限制。'));
   const summary=node('div','',{class:'booking-risk-overview','aria-label':'爽約政策概況'});
   const metric=(title,value,detail)=>{const card=node('div','',{class:'booking-risk-metric'});card.append(node('span',title),node('strong',String(value)),node('small',detail));summary.append(card);};
   metric('目前政策',current.policy.enabled?'啟用':'停用','不追溯歷史爽約；停用時暫停限制');
   metric('未到期的限制',restrictions.filter(active).length,'包含停用期間保留的紀錄');
   metric('待處理申覆',pending.length,'回覆不會自動解除限制');
   section.append(summary,node('p','政策最近變更：'+time(current.policy.updated_at)),node('h4','限制政策設定',{class:'booking-risk-policy-heading'}));
   const form=node('form','',{class:'booking-admin-form booking-admin-settings-form booking-risk-policy-form',novalidate:''}),p=current.policy,fields={},errors={};
   let target=form;
   const group=(title,help)=>{const block=node('div','',{class:'booking-risk-field-group'});block.append(node('h5',title),node('p',help));target=node('div','',{class:'booking-risk-field-grid'});block.append(target);form.append(block);};
   const addField=(key,title,input)=>{
    input.id='bookingRisk-'+key;input.name=key;
    const label=node('label',title,{for:input.id}),error=node('small','',{id:input.id+'-error',class:'booking-risk-field-error'});
    const block=node('div','',{class:'booking-risk-field'});
    input.setAttribute('aria-describedby',error.id);label.append(input);block.append(label,error);target.append(block);fields[key]=input;errors[key]=error;return input;
   };
   const ranges={lookback_days:[1,3650],threshold_count:[1,100],duration_count:[1,120],grace_minutes:[0,1440]};
   const field=(key,title,type='number',value=p[key])=>{
    const input=node('input','',{type});input.value=value??'';
    if(type==='checkbox')input.checked=value===true;else if(type==='number'){input.min=ranges[key][0];input.max=ranges[key][1];input.step='1';}
    return addField(key,title,input);
   };
   group('政策開關','預設停用；儲存並確認後才會生效。');field('enabled','啟用限制','checkbox');
   group('一、爽約計次','依現有服務結束時間及伺服器規則判定；啟用後才開始計次，不追溯歷史。');
   field('lookback_days','計次期間（天）');field('threshold_count','達到幾次爽約');field('grace_minutes','服務結束後寬限（分鐘）');
   group('二、限制期限','只影響新線上預約，不會取消既有預約；既有限制保留原政策快照及期限。');field('duration_count','限制期限數量');
   const duration=node('select');
   for(const [value,text]of [['','請選擇'],['weeks','週'],['months','個月']])duration.append(node('option',text,{value}));duration.value=p.duration_unit||'';addField('duration_unit','限制期限單位',duration);
   group('三、會員申覆與客服','會員可透過聯絡方式詢問或使用電話預約。');field('appeal_enabled','允許會員申覆','checkbox');
   field('contact_text','電話預約／客服聯絡方式','text');fields.contact_text.maxLength=500;
   const save=node('button','儲存政策',{type:'submit',class:'button button-dark'}),refresh=node('button',conflict?'重新載入最新政策（捨棄草稿）':'更新紀錄',{type:'button',class:'button button-outline','data-risk-refresh':''}),status=node('p','',{role:'status','aria-live':'polite',tabindex:'-1'});
   const preview=node('div','',{class:'booking-risk-preview','aria-live':'polite'}),draft=node('p','',{class:'booking-risk-draft'});
   const discard=node('button','還原變更',{type:'button',class:'button button-outline',disabled:''});
   const actions=node('div','',{class:'booking-risk-form-actions'});actions.append(discard,save);form.append(preview,draft,actions);section.append(form,refresh,status);
   const collect=()=>{const policy={version:p.version};for(const [key,input]of Object.entries(fields))policy[key]=input.type==='checkbox'?input.checked:input.value;return policy;};
   const baseline=JSON.stringify(collect());
   const policyText=next=>next.lookback_days+' 天內達到 '+next.threshold_count+' 次爽約，限制新線上預約 '+next.duration_count+(next.duration_unit==='weeks'?' 週':' 個月')+'；寬限 '+next.grace_minutes+' 分鐘。';
   const updateDraft=()=>{
    const next=collect();dirty=JSON.stringify(next)!==baseline;discard.disabled=busy||!dirty||conflict;
    draft.textContent=dirty?'有未儲存的變更，請儲存或還原。':'已載入目前政策，尚未修改。';
    const valid=Object.keys(ranges).every(k=>next[k]!==''&&Number.isInteger(Number(next[k])));
    preview.textContent=(dirty?'尚未儲存｜':'目前政策｜')+(next.enabled?(valid&&['weeks','months'].includes(next.duration_unit)?policyText(next):'請完整設定計次、限制期限與客服聯絡方式。'):'限制未啟用，不會依此政策阻擋新的線上預約。');
   };
   form.addEventListener('input',event=>{if(event.target.name&&errors[event.target.name]){errors[event.target.name].textContent='';event.target.removeAttribute('aria-invalid');}updateDraft();});form.addEventListener('change',updateDraft);
   discard.addEventListener('click',()=>{if(busy||!dirty||conflict)return;draw();section.querySelector('[role=status]').textContent='已還原未儲存的政策變更。';section.querySelector('[name=enabled]').focus();});updateDraft();
   const announce=message=>{const output=section.querySelector('[role=status]');output.textContent=message;return output;};
   const run=async(action,body)=>{
    if(busy||(conflict&&action!=='get'))return;
    busy=true;const controls=[...section.querySelectorAll('button,input,select')],disabled=controls.map(control=>control.disabled);
    controls.forEach(control=>control.disabled=true);section.setAttribute('aria-busy','true');status.textContent='正在處理，請稍候…';
    try{
     const result=await request(action,body);if(!result?.policy)throw Error('無法確認操作結果，請更新後核對。');
     current=result;conflict=false;draw();
     const messages={get:'已更新紀錄。',save:'政策已儲存並重新載入。',revoke:'已撤銷該筆爽約計次，限制狀態已重新核對。',release:'已人工解除指定限制，爽約計次與歷程仍保留。',resolve:'已記錄申覆回覆；未解除限制。'};
     const output=announce(messages[action]);(action==='get'?section.querySelector('[data-risk-refresh]'):output).focus();
    }catch(error){
     if(error?.code==='BOOKING_CONFLICT')conflict=true;
     status.textContent=(error.message||'操作失敗。')+(conflict?' 輸入內容已保留；政策版本已更新，請重新載入後核對，不會自動重送。':' 輸入內容已保留，請核對後重試。');
     if(conflict)refresh.textContent='重新載入最新政策（捨棄草稿）';
    }finally{
     busy=false;controls.forEach((control,index)=>control.disabled=disabled[index]);section.setAttribute('aria-busy','false');
     if(section.contains(form)){updateDraft();if(conflict){save.disabled=true;for(const button of section.querySelectorAll('[data-risk-action]'))button.disabled=true;}}
    }
   };
   const validate=policy=>{
    let first;
    for(const [key,input]of Object.entries(fields)){input.removeAttribute('aria-invalid');errors[key].textContent='';}
    const invalid=(key,message)=>{fields[key].setAttribute('aria-invalid','true');errors[key].textContent=message;first??=fields[key];};
    for(const [key,[lo,hi]]of Object.entries(ranges)){
     if(policy[key]===''&&!policy.enabled)continue;
     if(policy[key]===''||!Number.isInteger(Number(policy[key]))||Number(policy[key])<lo||Number(policy[key])>hi)invalid(key,'請輸入 '+lo+'–'+hi+' 的整數。');
    }
    if((policy.enabled||policy.duration_unit)&&!['weeks','months'].includes(policy.duration_unit))invalid('duration_unit','請選擇週或個月。');
    if(policy.enabled&&!policy.contact_text.trim())invalid('contact_text','啟用前請填寫聯絡方式。');
    if(policy.contact_text.length>500)invalid('contact_text','聯絡方式不得超過 500 字。');
    if(first){status.textContent='啟用前請完整設定所有參數與聯絡方式；限制參數需在有效範圍。';first.focus();return false;}return true;
   };
   form.addEventListener('submit',event=>{
    event.preventDefault();if(busy||conflict)return;const policy=collect();if(!validate(policy))return;
    const message=policy.enabled?policyText(policy)+'\n啟用後才開始計次，不追溯歷史爽約；既有限制保留原期限，尚未到期者會恢復執行。\n只影響新的線上預約；不取消既有預約，也不影響登入、點數與票券。\n確認儲存此政策？':p.enabled?'停用後限制暫停執行，紀錄不刪除；再次啟用時，尚未到期的既有限制依原期限恢復。\n確認停用政策？':null;
    if(message&&!window.confirm(message)){status.textContent='已取消儲存，政策草稿仍保留。';save.focus();return;}void run('save',{policy});
   });
   refresh.addEventListener('click',()=>{
    if(busy)return;
    if(conflict){if(!window.confirm('重新載入會捨棄未儲存的政策草稿，改用伺服器最新政策。確認重新載入？')){refresh.focus();return;}}
    else if(dirty){status.textContent='有未儲存的變更，請先儲存或還原後更新紀錄。';return;}
    void run('get',{});
   });
   const reasonLabel=node('label','撤銷／解除／回覆原因（必填）',{for:'bookingRisk-action-reason'}),reason=node('input','',{id:'bookingRisk-action-reason',name:'action_reason',type:'text',maxLength:500});reasonLabel.append(reason);section.append(reasonLabel);
   const effects={revoke:'撤銷這筆爽約計次，依原政策快照重新核對限制；保留原事件與稽核。',release:'只解除指定限制，保留爽約計次與稽核。',resolve:'只記錄申覆回覆，不會自動解除限制。'};
   const action=(label,kind,body,record)=>{
    const button=node('button',label,{type:'button',class:'button button-outline','data-risk-action':kind});
    button.addEventListener('click',()=>{
     if(busy||conflict)return;
     if(dirty){status.textContent='有未儲存的政策變更，請先儲存或還原再處理紀錄。';return;}
     if(!reason.value.trim()){status.textContent='請先填寫核對原因。';reason.focus();return;}
     const message=label+'\n會員：'+member(record)+'\n目標：'+Object.values(body).join(' / ')+'\n原因：'+reason.value.trim()+'\n'+effects[kind]+'\n確認執行？';
     if(!window.confirm(message)){status.textContent='已取消'+label+'，原因已保留。';button.focus();return;}
     void run(kind,{...body,reason:reason.value.trim()});
    });return button;
   };
   const detail=(li,text)=>li.append(node('p',text,{class:'booking-risk-record-detail'}));
   const events=node('ul','',{class:'booking-risk-record-list'});
   if(!(current.events||[]).length)events.append(node('li','目前沒有爽約計次紀錄。',{class:'booking-risk-empty'}));
   for(const e of current.events||[]){
    const li=node('li');li.append(node('p',`${member(e)} · ${time(e.occurred_at)} · ${e.revoked_at?'已撤銷':'有效爽約'}`));
    detail(li,'預約：'+e.booking_id+'；服務結束：'+time(e.occurred_at)+'；標記：'+time(e.marked_at));
    if(e.revoked_at)detail(li,'撤銷：'+time(e.revoked_at)+'；原因：'+(e.revoke_reason||'未提供'));
    else li.append(action('撤銷誤判','revoke',{bookingId:e.booking_id},e));events.append(li);
   }
   section.append(node('h4','最近 100 筆計次'),events);
   const restrictionList=node('ul','',{class:'booking-risk-record-list'});
   if(!restrictions.length)restrictionList.append(node('li','目前沒有有效限制紀錄。',{class:'booking-risk-empty'}));
   for(const r of restrictions){
    const state=r.revoked_at?'已解除':!validDates(r)?'期限資料不完整':active(r)?(p.enabled?'限制生效中':'政策停用，暫停執行'):Date.parse(r.ends_at)<=Date.now()?'已到期':'尚未生效';
    const li=node('li');li.append(node('p',member(r)+' · '+state));
    detail(li,'限制：'+r.id+'；來源預約：'+(r.source_booking_id||'未提供'));
    detail(li,'生效：'+time(r.starts_at)+'；限制至 '+time(r.ends_at));
    if(r.revoked_at)detail(li,'解除：'+time(r.revoked_at)+'；原因：'+(r.revoke_reason||'未提供'));
    if(active(r))li.append(action('人工解除','release',{restrictionId:r.id},r));restrictionList.append(li);
   }
   section.append(node('h4','限制紀錄（最近 100 筆）'),restrictionList);
   const appeals=node('ul','',{class:'booking-risk-record-list'});
   if(!(current.appeals||[]).length)appeals.append(node('li','目前沒有會員申覆。',{class:'booking-risk-empty'}));
   for(const a of current.appeals||[]){
    const li=node('li');li.append(node('p',`${a.reason} · ${a.resolved_at?'已回覆':'待處理'}`));
    detail(li,member(a)+'；申覆：'+a.id+'；限制：'+a.restriction_id+'；來源預約：'+(a.source_booking_id||'未提供'));
    detail(li,'申覆時間：'+time(a.created_at));
    if(a.resolved_at)detail(li,'回覆：'+time(a.resolved_at)+'；內容：'+(a.resolution||'未提供'));
    else li.append(action('記錄回覆','resolve',{appealId:a.id},a));appeals.append(li);
   }
   section.append(node('h4','會員申覆'),node('p','回覆只記錄核對結果；需要恢復資格時，請另行撤銷誤判或人工解除。'),appeals);
  };
  draw();
 }};
})();
