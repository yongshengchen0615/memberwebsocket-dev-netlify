(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const merchantEntry = document.documentElement.dataset.workspace === 'merchant';
  let refreshTimer=null,refreshBusy=false;
  const form = el('tenantForm'), dialog = el('tenantDialog');
  const fields = form.elements;
  const lineKeys = ['adminChannelId','memberChannelId','messagingChannelId','adminLiffId','memberLiffId','pointsLiffId','eventLiffId','calendarLiffId','bookingLiffId'];
  const state = {config:null,idToken:'',features:{},tenants:[],applications:[],current:null,pending:null,busy:false,approval:null,merchant:null,merchantPending:null};
  const LOGIN_RETURN_KEY=merchantEntry?'admin-line-login-return-v1':'platform-line-login-return-v1';
  const LOGIN_RETURN_TTL_MS=180_000;
  function consumeLoginReturn() {
    // A one-use navigation hint only. Authorization still happens in LINE Verify + SQL.
    let issuedAt=0;
    try {
      issuedAt=Number(window.sessionStorage.getItem(LOGIN_RETURN_KEY));
      window.sessionStorage.removeItem(LOGIN_RETURN_KEY);
    } catch { return false; }
    return Number.isFinite(issuedAt) && issuedAt>0 && Date.now()>=issuedAt
      && Date.now()-issuedAt<=LOGIN_RETURN_TTL_MS;
  }
  function showLoginGate(message=merchantEntry?'請重新使用 LINE 確認管理員身分。':'每次進入總管理員控制台，請重新使用 LINE 確認身分。') {
    state.idToken='';
    state.pending=null;
    state.approval=null;
    state.merchantPending=null;
    for(const key of ['channelAccessToken','channelSecret']) {
      const field=el('merchantLineForm')?.elements.namedItem(key);if(field)field.value='';
    }
    if(el('onboardingJourney'))el('onboardingJourney').hidden=true;
    for(const id of ['tenantDialog','approvalDialog','grantDialog']) {
      const dialog=el(id);
      if(dialog?.open)dialog.close();
    }
    const authorizationNotice=el('platformAuthorizationNotice');
    if(authorizationNotice)authorizationNotice.hidden=true;
    el('platformWorkspace').hidden=true;
    el('merchantWorkspace').hidden=true;
    el('applicationWorkspace').hidden=true;
    el('platformLoginGate').hidden=false;
    el('platformLoginButton').disabled=false;
    el('platformStatus').textContent=message;
  }
  function showAuthorizationDenied() {
    if(merchantEntry)return;
    // Only called for PLATFORM_ADMIN_REQUIRED after successful server-side LINE verification.
    // No client-side approval, privileged mutation, or account enumeration.
    showLoginGate('LINE 身分已驗證，但此帳號尚未取得總管理員授權。');
    el('platformAuthorizationNotice').hidden=false;
  }
  function clearLoginGate() {
    el('platformLoginGate').hidden=true;
    const authorizationNotice=el('platformAuthorizationNotice');
    if(authorizationNotice)authorizationNotice.hidden=true;
  }
  function freshLineLogin() {
    const button=el('platformLoginButton');
    button.disabled=true;
    el('platformStatus').textContent='正在重新啟動 LINE 登入…';
    try {
      window.sessionStorage.setItem(LOGIN_RETURN_KEY,String(Date.now()));
      const inClient=window.liff.isInClient();
      state.idToken='';
      // Discard the old ID token. LINE LIFF browser cannot call liff.login():
      // liff.init() automatically signs in again after a page reload.
      window.liff.logout();
      if(inClient) window.location.reload();
      else window.liff.login();
    } catch {
      try { window.sessionStorage.removeItem(LOGIN_RETURN_KEY); } catch {}
      button.disabled=false;
      el('platformStatus').textContent='無法啟動 LINE 重新登入，請重新從 LINE 官方入口開啟此頁。';
    }
  }
  el('platformLoginButton').addEventListener('click',freshLineLogin);
  window.addEventListener('pageshow',event=>{
    if(event.persisted && !el('platformWorkspace').hidden) showLoginGate();
  });
  function message(text) { el('tenantFormStatus').textContent=text; }
  function uncertainError() { return Object.assign(new Error('儲存結果尚未確認。請重試同一操作，避免重複建立。'),{uncertain:true}); }
  async function request(action, payload = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),20000);
    try {
      const url = new URL(state.config.supabaseFunctionUrl);
      url.pathname = url.pathname.replace(/\/api\/?$/, '/platform-api');
      if (!url.pathname.endsWith('/platform-api')) throw new Error('總管理員 API 設定不正確。');
      let response;
      try { response=await fetch(url.href,{method:'POST',headers:{'Content-Type':'application/json',apikey:state.config.supabasePublishableKey},body:JSON.stringify({action,idToken:state.idToken,...payload}),signal:controller.signal}); }
      catch { throw uncertainError(); }
      let body;
      try { body=await response.json(); } catch { throw uncertainError(); }
      if (!response.ok || !body.ok) {
        if (response.status>=500 && ['PLATFORM_DATABASE_UNAVAILABLE','PLATFORM_UNAVAILABLE'].includes(body.error?.code)) throw uncertainError();
        if(response.status===403 && body.error?.code==='PLATFORM_ADMIN_REQUIRED'&&!merchantEntry)showAuthorizationDenied();
        if(response.status===401 && ['AUTH_INVALID','AUTH_REQUIRED'].includes(body.error?.code))
          showLoginGate(merchantEntry?'一般管理員 LINE 驗證已失效，請重新登入。':'總管理員 LINE 驗證已失效，請確認專用 LINE Login Channel。');
        throw Object.assign(new Error(body.error?.message || '操作未完成。'),{code:body.error?.code,status:response.status});
      }
      return body.data;
    } finally { clearTimeout(timer); }
  }
  function featureRequirements() {
    const map={membership:'memberLiffId',points:'pointsLiffId',events:'eventLiffId',calendar:'calendarLiffId',booking:'bookingLiffId'};
    for (const [key,name] of Object.entries(map)) fields.namedItem(name).required=Boolean(form.querySelector(`[data-feature="${key}"]`)?.checked);
  }
  function resetSecrets() { fields.namedItem('channelAccessToken').value=''; fields.namedItem('channelSecret').value=''; }
  function lock(value) {
    state.busy=value;
    for (const node of form.querySelectorAll('input,button')) node.disabled=value;
  }
  function fill(tenant = null) {
    state.current=tenant;state.pending=null;form.reset();resetSecrets();message('');
    el('tenantDialogTitle').textContent=tenant?'編輯商家設定':'新增商家管理員';
    for (const key of ['name','slug','ownerLineUserId']) fields.namedItem(key).value=tenant?.[key] || '';
    for (const key of ['slug','ownerLineUserId']) fields.namedItem(key).readOnly=Boolean(tenant);
    for (const key of lineKeys) fields.namedItem(key).value=tenant?.line?.[key] || '';
    for (const input of form.querySelectorAll('[data-feature]')) input.checked=tenant?.features?.[input.dataset.feature]===true;
    for (const key of ['channelAccessToken','channelSecret']) fields.namedItem(key).required=!tenant;
    el('credentialHint').textContent=tenant?'憑證已安全保存。兩欄都留空可保留；若要更換，請同時填入新 token 與 secret。':'新增商家時必填；儲存後不會回傳憑證內容。';
    featureRequirements();el('saveTenant').textContent='儲存商家設定';lock(false);
    dialog.showModal();fields.namedItem('name').focus();
  }
  function render() {
    const list=el('tenantList');list.replaceChildren();
    if (!state.tenants.length) {const p=document.createElement('p');p.className='empty';p.textContent='尚無已審核的一般管理員。請從申請清單勾選功能並審核。';list.append(p);return;}
    for (const tenant of state.tenants) {
      const card=document.createElement('article');card.className='tenant-card';
      const badge=document.createElement('span');badge.className='badge';badge.textContent=tenant.status==='suspended'?'已停用':tenant.onboarding?.adminReady?'已核准・可立即使用'
        :tenant.onboarding?.configurationComplete?'設定齊全・待平台開通':'已核准・待 LINE 設定';
      const title=document.createElement('h3');title.textContent=tenant.name;
      const info=document.createElement('p');info.textContent=`${tenant.slug} · 管理員 ${tenant.ownerLineUserId}`;
      const featureList=document.createElement('div');featureList.className='tenant-features';
      for (const [key,label] of Object.entries(state.features)) if (tenant.features[key]) {const tag=document.createElement('span');tag.textContent=label;featureList.append(tag);}
      if (!featureList.childNodes.length) featureList.textContent='尚未開放任何功能';
      const footer=document.createElement('footer');const edit=document.createElement('button');edit.type='button';edit.textContent='調整開放功能';edit.addEventListener('click',()=>openGrantDialog(tenant));footer.append(edit);
      if (tenant.status!=='suspended') {const suspend=document.createElement('button');suspend.type='button';suspend.className='secondary';suspend.textContent='停用商家';suspend.addEventListener('click',async()=>{
        if (!window.confirm(`停用「${tenant.name}」？`)) return;
        suspend.disabled=true;
        try {const result=await request('platform.tenant.suspend',{tenantId:tenant.id,expectedVersion:tenant.version,requestId:crypto.randomUUID()});state.tenants=state.tenants.map(item=>item.id===result.tenant.id?result.tenant:item);render();el('platformStatus').textContent='商家已停用。';}
        catch(error){el('platformStatus').textContent=error.message;}finally{suspend.disabled=false;}
      });footer.append(suspend);}
      const setup=document.createElement('p');
      const onboarding=tenant.onboarding;
      setup.textContent=tenant.status==='suspended'?'已停用；管理員與用戶均不可使用。':onboarding?.adminReady?'已核准功能已開通，管理員可設定業務內容並分享專屬用戶連結。'
        :onboarding?.configurationComplete?'LINE 設定已完整保存；下一步由平台完成商家專屬服務與 LINE 實測。目前管理業務與用戶端尚未開放。'
        :'審核已通過；下一步由一般管理員完成共用 LINE 與各項功能設定。目前管理業務與用戶端尚未開放。';
      card.append(badge,title,info,featureList,setup,footer);list.append(card);
    }
  }
  async function refresh() {const data=await request('platform.bootstrap');state.tenants=data.tenants;state.applications=data.applications||[];state.features=data.features;render();renderApplications();return data;}
  function collect() {return {name:fields.namedItem('name').value.trim(),slug:fields.namedItem('slug').value.trim(),ownerLineUserId:fields.namedItem('ownerLineUserId').value.trim(),
    features:Object.fromEntries([...form.querySelectorAll('[data-feature]')].map(node=>[node.dataset.feature,node.checked])),
    line:Object.fromEntries(lineKeys.map(key=>[key,fields.namedItem(key).value.trim()])),
    credentials:{channelAccessToken:fields.namedItem('channelAccessToken').value.trim(),channelSecret:fields.namedItem('channelSecret').value.trim()}};}
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(state.busy)return;
    if(!state.pending&&!form.reportValidity())return;
    if(!state.pending)state.pending={requestId:crypto.randomUUID(),tenantId:state.current?.id || crypto.randomUUID(),expectedVersion:state.current?.version || 0,tenant:collect()};
    lock(true);message('正在安全儲存…');
    try {const result=await request('platform.tenant.save',state.pending);state.tenants=[result.tenant,...state.tenants.filter(item=>item.id!==result.tenant.id)];render();state.pending=null;resetSecrets();dialog.close();lock(false);el('platformStatus').textContent='商家設定已儲存。獨立資料環境驗證完成前維持待佈建。';}
    catch(error){
      message(error.message);
      if(error.uncertain&&state.pending){state.busy=false;el('saveTenant').disabled=false;el('saveTenant').textContent='重試相同儲存操作';}
      else {state.pending=null;lock(false);el('saveTenant').textContent='儲存商家設定';}
    }
  });
  el('closeTenant').addEventListener('click',()=>{if(!state.pending&&!state.busy){resetSecrets();dialog.close();}});
  dialog.addEventListener('cancel',event=>{if(state.pending||state.busy)event.preventDefault();else resetSecrets();});
  dialog.addEventListener('close',()=>{if(!state.pending)resetSecrets();});
  form.addEventListener('change',featureRequirements);
  el('newTenant').addEventListener('click',()=>fill());

  // Root feature-only editor: no merchant LINE fields or secrets are read.
  const grantDialog=el('grantDialog'),grantForm=el('grantForm');
  let grantPending=null,grantTenant=null;
  function openGrantDialog(tenant) {
    grantTenant=tenant;grantPending=null;
    el('grantDescription').textContent=tenant.name+' · '+tenant.slug;
    const list=el('grantFeatures');list.replaceChildren();
    for(const [key,label] of Object.entries(state.features)) {
      const wrap=document.createElement('label'),input=document.createElement('input');
      input.type='checkbox';input.dataset.grantFeature=key;input.checked=tenant.features?.[key]===true;
      wrap.append(input,document.createTextNode(label));list.append(wrap);
    }
    el('grantMessage').textContent='';el('saveGrant').disabled=false;
    grantDialog.showModal();
  }
  grantForm.addEventListener('change',()=>{grantPending=null;});
  grantForm.addEventListener('submit',async event=>{
    event.preventDefault();if(!grantTenant)return;
    if(!grantPending)grantPending={
      tenantId:grantTenant.id,expectedVersion:grantTenant.version,requestId:crypto.randomUUID(),
      features:Object.fromEntries([...grantForm.querySelectorAll('[data-grant-feature]')].map(node=>[node.dataset.grantFeature,node.checked]))
    };
    el('saveGrant').disabled=true;el('grantMessage').textContent='正在儲存授權…';
    try{
      const result=await request('platform.tenant.features.save',grantPending);
      state.tenants=state.tenants.map(x=>x.id===result.tenant.id?result.tenant:x);
      grantDialog.close();grantPending=null;grantTenant=null;render();
      el('platformStatus').textContent='功能授權已更新。商家 LINE 設定仍由管理員自行維護。';
    }catch(error){
      el('grantMessage').textContent=error.message;
      if(!error.uncertain)grantPending=null;
    }finally{el('saveGrant').disabled=false;}
  });
  el('closeGrant').addEventListener('click',()=>{if(!el('saveGrant').disabled){grantPending=null;grantTenant=null;grantDialog.close();}});
  grantDialog.addEventListener('cancel',event=>{if(el('saveGrant').disabled)event.preventDefault();else{grantPending=null;grantTenant=null;}});
  // Applications are independent from the legacy admin membership table.
  const approvalDialog=el('approvalDialog'),approvalForm=el('approvalForm');
  function renderApplications() {
    const list=el('applicationList');list.replaceChildren();
    const pending=state.applications.filter(item=>item.status==='pending');
    if(!pending.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='目前沒有待審核的管理員。';list.append(empty);return;}
    for(const application of pending) {
      const card=document.createElement('article');card.className='tenant-card';
      const title=document.createElement('h3');title.textContent=application.businessName;
      const info=document.createElement('p');info.textContent=application.slug+' · LINE 使用者 '+(application.applicantLineUserId||'資料待確認')+' · 申請時間 '+new Date(application.requestedAt).toLocaleString('zh-TW');
      const approve=document.createElement('button');approve.type='button';approve.textContent='審核與選擇功能';
      approve.addEventListener('click',()=>{
        state.approval={applicationId:application.id,requestId:crypto.randomUUID(),features:null};
        el('approvalDescription').textContent=application.businessName+' ('+application.slug+')';
        const box=el('approvalFeatures');box.replaceChildren();
        for(const [key,label] of Object.entries(state.features)) {
          const wrap=document.createElement('label'),input=document.createElement('input');
          input.type='checkbox';input.dataset.approveFeature=key;
          wrap.append(input,document.createTextNode(label));box.append(wrap);
        }
        el('approvalMessage').textContent='';el('confirmApproval').disabled=false;approvalDialog.showModal();
      });card.append(title,info,approve);list.append(card);
    }
  }
  approvalForm.addEventListener('change',()=>{if(state.approval)state.approval.features=null;});
  approvalForm.addEventListener('submit',async event=>{
    event.preventDefault();if(!state.approval)return;
    if(!state.approval.features)state.approval.features=Object.fromEntries(
      [...approvalForm.querySelectorAll('[data-approve-feature]')].map(node=>[node.dataset.approveFeature,node.checked]));
    el('confirmApproval').disabled=true;el('approvalMessage').textContent='正在審核…';
    try{
      const result=await request('platform.application.approve',state.approval);
      state.tenants=[result.tenant,...state.tenants.filter(x=>x.id!==result.tenant.id)];
      state.applications=state.applications.map(x=>x.id===state.approval.applicationId?{...x,status:'approved'}:x);
      state.approval=null;approvalDialog.close();render();renderApplications();
      el('platformStatus').textContent='已審核通過；一般管理員的管理頁會更新授權，現在可設定 LINE。LINE 設定完成後，仍需平台開通商家專屬服務並完成實測，才可讓用戶使用。';
    }catch(error){
      el('approvalMessage').textContent=error.message;
      if(!error.uncertain)state.approval.features=null;
    }finally{el('confirmApproval').disabled=false;}
  });
  el('closeApproval').addEventListener('click',()=>{if(!el('confirmApproval').disabled){state.approval=null;approvalDialog.close();}});
  approvalDialog.addEventListener('cancel',e=>{if(el('confirmApproval').disabled)e.preventDefault();else state.approval=null;});

  const applicationForm=el('applicationForm'),merchantForm=el('merchantLineForm');
  const featureLiffNames={membership:'memberLiffId',points:'pointsLiffId',events:'eventLiffId',calendar:'calendarLiffId',booking:'bookingLiffId'};
  let merchantPanel='shared',merchantDirty=false,merchantSaving=false,latestMine=null;
  const lineLabels={adminChannelId:'管理端 Login Channel ID',memberChannelId:'會員端 Login Channel ID',messagingChannelId:'Messaging API Channel ID',adminLiffId:'管理端 LIFF ID',memberLiffId:'會員卡 LIFF ID',pointsLiffId:'集點卡 LIFF ID',eventLiffId:'活動票券 LIFF ID',calendarLiffId:'營運日曆 LIFF ID',bookingLiffId:'預約 LIFF ID',credentials:'Messaging API token 與 secret'};
  function installFieldHelp() {
    for(const key of [...lineKeys,'channelAccessToken','channelSecret']) {
      const input=merchantForm.elements.namedItem(key);if(!input)continue;
      const help=document.createElement('small');help.id='lineHelp-'+key;
      help.textContent=key.endsWith('LiffId')?'LINE Developers → 對應 LINE Login Channel → LIFF → LIFF ID。需先取得平台提供的商家專屬 Endpoint URL。'
        :key==='channelAccessToken'?'LINE Developers → Messaging API Channel → Messaging API → Channel access token (long-lived)。已有 token 請沿用；重新發行會讓原 token 失效。'
        :key==='channelSecret'?'LINE Developers → Messaging API Channel → Basic settings → Channel secret。'
        :'LINE Developers → '+(key==='messagingChannelId'?'Messaging API':'LINE Login')+' Channel → Basic settings → Channel ID。';
      input.setAttribute('aria-describedby',help.id);input.insertAdjacentElement('afterend',help);
    }
  }
  installFieldHelp();
  function renderJourney(application,tenant) {
    const journey=el('onboardingJourney');if(!journey)return;
    journey.hidden=false;
    const approved=application?.status==='approved'&&tenant?.status!=='suspended';
    const complete=approved&&tenant?.onboarding?.configurationComplete===true;
    const steps=['submitted','approved','configured','verified','live'];
    const current=!application||application.status==='rejected'?0:!approved?1:tenant?.onboarding?.adminReady?4:!complete?2:3;
    for(const [index,key] of steps.entries()) {
      const node=journey.querySelector('[data-journey="'+key+'"]');
      node.dataset.state=index<current?'done':index===current?'current':'waiting';
      if(index===current)node.setAttribute('aria-current','step');else node.removeAttribute('aria-current');
    }
    if(tenant?.status==='suspended')for(const node of journey.querySelectorAll('[aria-current]'))node.removeAttribute('aria-current');
  }
  function renderChecklist(tenant) {
    const list=el('merchantChecklist');if(!list)return;
    list.replaceChildren();const status=tenant.onboarding;
    const row=(name,detail,panel)=>{
      const article=document.createElement('article'),body=document.createElement('div'),title=document.createElement('strong'),p=document.createElement('p');
      title.textContent=name;p.textContent=detail;body.append(title,p);article.append(body);
      if(panel){const button=document.createElement('button');button.type='button';button.className='secondary';button.dataset.setupFeature=panel;button.textContent='前往設定';button.addEventListener('click',()=>{selectMerchantPanel(panel);merchantForm.scrollIntoView?.({block:'start'});});article.append(button);}
      list.append(article);
    };
    const missing=status?.commonMissing;
    row('共用 LINE 設定',!status?'設定檢查服務尚未更新，請重新整理後再試。':missing.length?'尚缺：'+missing.map(key=>lineLabels[key]||key).join('、'):'必填資料已保存，仍需實際 LINE 驗證。','shared');
    for(const [key,label] of Object.entries(state.features))if(tenant.features?.[key]===true) {
      const feature=status?.features?.[key];
      row(label,status?.adminReady?'管理功能已開放。'+(feature?.missing.length?'自有 LINE 入口尚缺：'+feature.missing.map(name=>lineLabels[name]||name).join('、'):'可使用下方專屬入口。'):!feature?'等待伺服器確認設定。':feature.missing.length?'尚缺：'+feature.missing.map(name=>lineLabels[name]||name).join('、')
        :featureLiffNames[key]?'LIFF ID 已保存；用戶入口尚未開放。':'沿用共用 LINE 設定，無需額外 LIFF；功能尚未開放。',key);
    }
    const next=el('merchantNextAction');
    const firstMissing=Object.entries(status?.features||{}).find(([,item])=>!item.configured)?.[0];
    next.hidden=status?.configurationComplete===true||status?.grantedCount===0;
    next.textContent=missing?.length?'下一步：完成共用 LINE 設定':'下一步：設定'+(state.features[firstMissing]||'LINE');
    next.onclick=()=>{selectMerchantPanel(missing?.length?'shared':firstMissing||'shared');merchantForm.scrollIntoView?.({block:'start'});};
    el('merchantLaunchStatus').dataset.ready=String(status?.adminReady===true);
    const launch=el('merchantLaunchStatus').querySelector('.onboarding-actions');
    for(const old of launch.querySelectorAll('[data-business-launch]'))old.remove();
    for(const button of launch.querySelectorAll('button[disabled]'))button.hidden=status?.adminReady===true;
    if(status?.adminReady){
      const surfaces={membership:'member',points:'points',events:'event',calendar:'calendar',booking:'booking'};
      const link=(label,path)=>{const a=document.createElement('a');a.className='primary';a.textContent=label;a.dataset.businessLaunch='true';a.href=path;launch.prepend(a);};
      link('進入已核准的管理功能','/admin/?business='+encodeURIComponent(tenant.slug));
      for(const [feature,path]of Object.entries(surfaces))if(tenant.features[feature])link('開啟'+state.features[feature]+'用戶端','/'+path+'/?business='+encodeURIComponent(tenant.slug));
      const endpoints=document.createElement('div');endpoints.dataset.businessLaunch='true';
      const heading=document.createElement('strong');heading.textContent='LINE LIFF Endpoint URL（可直接複製）';endpoints.append(heading);
      for(const [feature,path]of Object.entries(surfaces))if(tenant.features[feature]){const p=document.createElement('p');p.textContent=state.features[feature]+'：'+location.origin+'/'+path+'/?business='+tenant.slug;endpoints.append(p);}
      launch.append(endpoints);
    }
    el('merchantLaunchMessage').textContent=status?.adminReady?'核准即開通。請進入管理功能設定會員條款、卡片、票券及預約內容；已儲存的公開內容會提供給此商家的用戶。自有 LINE 入口與通知可在下方設定，不需再次等待平台開通。':!status?'尚無法取得開通檢查結果，請稍後重新檢查。'
      :status.grantedCount===0?'總管理員尚未開放功能，請先聯絡總管理員調整功能授權。'
      :status.configurationComplete?'LINE 設定已完整保存。下一步由平台完成商家專屬服務及實際 LINE 登入驗證。你目前無需重複儲存；用戶端尚未開放。'
      :'下一步由你完成下方設定清單。可先儲存共用設定，再逐頁補齊已核准功能的 LIFF ID。';
  }
  function lockMerchant(value) {
    for(const node of merchantForm.querySelectorAll('input'))node.disabled=value;
    for(const node of document.querySelectorAll('#merchantFeatureNav button,#merchantChecklist button,#merchantNextAction,#reloadMerchantSettings'))node.disabled=value;
  }
  el('copySetupSummary')?.addEventListener('click',async()=>{
    const tenant=state.merchant;if(!tenant)return;
    const status=tenant.onboarding;
    const missing=[...(status?.commonMissing||[]),...Object.values(status?.features||{}).flatMap(item=>item.missing)];
    const summary='商家：'+tenant.name+'\n商家代碼：'+tenant.slug+'\nLINE 設定：'+(status?.configurationComplete?'必填資料已保存':status?'尚缺 '+missing.map(key=>lineLabels[key]||key).join('、'):'等待確認')
      +'\n核准功能：'+Object.entries(state.features).filter(([key])=>tenant.features?.[key]===true).map(([,label])=>label).join('、')
      +(status?.adminReady?'\n管理業務／用戶端：已開放\n管理入口：'+location.origin+'/admin/?business='+tenant.slug:'\n管理業務／用戶端：尚未開放\n請聯絡總管理員確認申請。');
    try{await navigator.clipboard.writeText(summary);el('copySetupMessage').textContent='開通狀態已複製，可貼給平台聯絡人；不含憑證。';}
    catch{el('copySetupMessage').textContent='無法自動複製，請將本頁顯示的商家代碼與開通狀態提供給平台聯絡人。';}
  });
  function selectMerchantPanel(feature) {
    if(merchantSaving||state.merchantPending)return;
    const tenant=state.merchant;
    // A stale bookmark or a forged query string never exposes an unapproved feature.
    merchantPanel=feature==='shared'||tenant?.features?.[feature]===true?feature:'shared';
    for(const panel of merchantForm.querySelectorAll('[data-merchant-panel]'))
      panel.hidden=panel.dataset.merchantPanel!==merchantPanel;
    for(const button of el('merchantFeatureNav').querySelectorAll('[data-line-feature]'))
      button.setAttribute('aria-current',button.dataset.lineFeature===merchantPanel?'page':'false');
    for(const name of ['adminChannelId','memberChannelId','messagingChannelId','adminLiffId'])
      merchantForm.elements.namedItem(name).required=merchantPanel==='shared';
    for(const [featureKey,name] of Object.entries(featureLiffNames))
      merchantForm.elements.namedItem(name).required=merchantPanel===featureKey;
    for(const name of ['channelAccessToken','channelSecret'])
      merchantForm.elements.namedItem(name).required=merchantPanel==='shared'&&!tenant?.credentialsConfigured;
    el('saveMerchantLine').disabled=['integrations','testing','usage'].includes(merchantPanel);
    el('merchantMessage').textContent='';
    try {
      const url=new URL(window.location.href);
      if(merchantPanel==='shared')url.searchParams.delete('feature');
      else url.searchParams.set('feature',merchantPanel);
      window.history.replaceState(window.history.state,'',url.href);
    } catch {}
  }
  function renderMerchantNav(tenant) {
    const nav=el('merchantFeatureNav');nav.replaceChildren();
    // Fail closed: only server-returned grants are rendered on the top bar.
    // Productized business mutations remain unavailable until isolated APIs exist.
    for(const [feature,label] of [['shared','共用 LINE 設定'],...Object.entries(state.features)]) {
      if(feature!=='shared'&&tenant.features?.[feature]!==true)continue;
      const button=document.createElement('button');
      button.type='button';button.dataset.lineFeature=feature;button.textContent=label;
      button.addEventListener('click',()=>selectMerchantPanel(feature));
      nav.append(button);
    }
    const requested=new URLSearchParams(window.location.search).get('feature');
    selectMerchantPanel(requested||merchantPanel);
  }
  function renderMine(data){
    state.mineSignature=JSON.stringify([data.application?.status,data.tenant?.version,data.tenant?.status]);
    state.merchant=data.tenant||null;state.features=data.features||state.features;
    state.merchantPending=null;merchantDirty=false;latestMine=null;lockMerchant(false);
    if(el('merchantSyncStatus'))el('merchantSyncStatus').textContent='';
    if(el('reloadMerchantSettings'))el('reloadMerchantSettings').hidden=true;
    const application=data.application;
    if(!data.tenant||data.tenant.status==='suspended')for(const key of ['channelAccessToken','channelSecret'])merchantForm.elements.namedItem(key).value='';
    renderJourney(application,data.tenant);
    el('applicationWorkspace').hidden=false;
    el('applicationForm').hidden=Boolean(application&&application.status!=='rejected');
    const progress=el('applicationProgress');
    progress.hidden=!application;
    progress.textContent=application?('申請商家：'+application.businessName+' · '+
      ({pending:'等待總管理員審核',approved:'審核通過',rejected:'申請未通過，可重新提交'}[application.status]||'狀態待確認')):'';
    el('merchantWorkspace').hidden=application?.status!=='approved'||!data.tenant||data.tenant.status==='suspended';
    if(data.tenant?.status==='suspended')progress.textContent='此管理員已停用，請聯絡總管理員。';
    if(el('applicationNextStep'))el('applicationNextStep').textContent=data.tenant?.status==='suspended'?'請聯絡總管理員確認停用原因。'
      :application?.status==='pending'?'下一步由總管理員審核並勾選開放功能。你現在不必填 LINE 資料；請保留此入口，審核結果會在本頁更新。申請時間：'+new Date(application.requestedAt).toLocaleString('zh-TW')
      :application?.status==='approved'?(data.tenant?.onboarding?.adminReady?'審核已通過，管理功能與專屬用戶端已開放。請進入管理功能儲存業務設定，並分享下方用戶連結。':'審核已通過。正在確認業務空間，請重新檢查進度。')
      :application?.status==='rejected'?'請確認商家資料後重新提交；如需了解原因，請聯絡總管理員。':'填寫商家資料並提交，由總管理員審核。';
    if(!data.tenant)return;
    const tenant=data.tenant;
    if(tenant.onboarding?.adminReady&&location.pathname==='/admin/'&&!new URLSearchParams(location.search).has('business')){
      location.replace('/admin/?business='+encodeURIComponent(tenant.slug));return;
    }
    el('merchantInfo').textContent=tenant.name+' · '+tenant.slug+' · '+(tenant.credentialsConfigured?'LINE 憑證已保存':'尚未設定 LINE 憑證');
    const readiness=el('merchantReadiness');
    if(readiness) {
      readiness.textContent=tenant.onboarding?.adminReady?'審核已通過，已核准功能與用戶端已開放。自有 LINE 入口與通知設定可隨時保存。':tenant.onboarding?.configurationComplete
        ? 'LINE 必填設定已保存，等待平台開通商家專屬服務。尚未驗證實際 LINE 登入與訊息傳送。'
        : '你已取得 LINE 設定權。請完成共用資料與各項已核准功能的設定，再由平台完成開通與實測。';
    }
    const tags=el('merchantFeatures');tags.replaceChildren();
    for(const [key,label] of Object.entries(state.features))if(tenant.features[key]){
      const tag=document.createElement('span');tag.textContent=label;tags.append(tag);
    }
    if(!tags.childNodes.length)tags.textContent='尚未核准任何業務功能';
    for(const key of lineKeys){
      const field=merchantForm.elements.namedItem(key);
      field.value=tenant.line?.[key]||'';
      const name={memberLiffId:'membership',pointsLiffId:'points',eventLiffId:'events',calendarLiffId:'calendar',bookingLiffId:'booking'}[key];
      if(name)field.required=false;
    }
    for(const key of ['channelAccessToken','channelSecret']){
      const field=merchantForm.elements.namedItem(key);field.value='';field.required=!tenant.credentialsConfigured;
    }
    el('merchantMessage').textContent='';state.merchantPending=null;
    renderMerchantNav(tenant);
    renderChecklist(tenant);
  }
  applicationForm.addEventListener('submit',async event=>{
    event.preventDefault();if(!applicationForm.reportValidity())return;
    const button=el('submitApplication');button.disabled=true;el('applicationMessage').textContent='正在提交申請…';
    try{
      const result=await request('platform.application.submit',{
        businessName:applicationForm.elements.namedItem('businessName').value.trim(),
        slug:applicationForm.elements.namedItem('slug').value.trim()});
      renderMine({...result,features:state.features});
      el('platformStatus').textContent='申請已送出，等待總管理員審核。';
    }catch(error){el('applicationMessage').textContent=error.message;}
    finally{button.disabled=false;}
  });
  merchantForm.addEventListener('input',()=>{
    if(merchantSaving||state.merchantPending)return;
    merchantDirty=true;
    if(el('merchantSyncStatus'))el('merchantSyncStatus').textContent='你有尚未儲存的設定。進度與清單仍依上次儲存資料顯示。';
  });
  merchantForm.addEventListener('change',()=>{if(!merchantSaving&&!state.merchantPending)merchantDirty=true;});
  merchantForm.addEventListener('submit',async event=>{
    event.preventDefault();if(merchantSaving||!state.merchant||state.merchant.status==='suspended')return;
    if(!state.merchantPending&&merchantPanel!=='shared'&&state.merchant.onboarding?.commonMissing?.length){
      selectMerchantPanel('shared');el('merchantMessage').textContent='請先完成並儲存共用 LINE 設定，再儲存功能頁。';return;
    }
    if(!state.merchantPending&&!merchantForm.reportValidity())return;
    const button=el('saveMerchantLine');button.disabled=true;el('merchantMessage').textContent='正在儲存 LINE 設定…';
    if(!state.merchantPending)state.merchantPending={
      requestId:crypto.randomUUID(),expectedVersion:state.merchant.version,
      line:Object.fromEntries(lineKeys.map(key=>[key,merchantForm.elements.namedItem(key).value.trim()])),
      credentials:{channelAccessToken:merchantForm.elements.namedItem('channelAccessToken').value.trim(),
        channelSecret:merchantForm.elements.namedItem('channelSecret').value.trim()},
    };
    merchantSaving=true;lockMerchant(true);
    try{
      const result=await request('platform.line.save',state.merchantPending);
      merchantSaving=false;
      renderMine({application:{status:'approved',businessName:result.tenant.name},tenant:result.tenant,features:state.features});
      el('merchantMessage').textContent=result.tenant.onboarding?.adminReady?'LINE 設定已安全儲存。已核准的管理功能持續可用；自有 LINE 入口與通知請依上方完整網址實際登入確認。':result.tenant.onboarding?.configurationComplete
        ?'LINE 設定已安全儲存，必填資料已齊全。下一步由平台開通商家專屬服務與完成 LINE 實測；管理業務及用戶端尚未開放。'
        :'LINE 設定已安全儲存。請依上方清單補齊其餘設定；管理業務及用戶端尚未開放。';
    }catch(error){
      el('merchantMessage').textContent=error.message;
      if(!error.uncertain)state.merchantPending=null;
      else el('merchantMessage').textContent='儲存結果尚未確認。設定已暫時鎖定，請按「重試相同儲存操作」確認結果。';
    }finally{
      merchantSaving=false;lockMerchant(Boolean(state.merchantPending));
      button.disabled=false;button.textContent=state.merchantPending?'重試相同儲存操作':'儲存此頁 LINE 設定';
    }
  });

  async function refreshMine() {
    if(!merchantEntry||!state.idToken||refreshBusy||merchantSaving||state.merchantPending)return;
    refreshBusy=true;
    try {
      const data=await request('platform.application.bootstrap');
      const signature=JSON.stringify([data.application?.status,data.tenant?.version,data.tenant?.status]);
      const accessChanged=data.application?.status!=='approved'||data.tenant?.status==='suspended'
        ||JSON.stringify(data.tenant?.features)!==JSON.stringify(state.merchant?.features);
      if(signature!==state.mineSignature){
        if(merchantDirty&&!accessChanged){
          latestMine=data;
          if(el('merchantSyncStatus'))el('merchantSyncStatus').textContent='偵測到較新的已儲存設定。你的草稿已保留；儲存前請載入最新設定，避免覆蓋。';
          if(el('reloadMerchantSettings'))el('reloadMerchantSettings').hidden=false;
        }else renderMine(data);
      }
      el('platformStatus').textContent=data.application?.status==='pending'?'申請已送出，等待總管理員審核。':'已更新目前的功能權限。';
    }catch(error){el('platformStatus').textContent=error.message;}
    finally{refreshBusy=false;}
  }
  el('refreshApplication')?.addEventListener('click',()=>void refreshMine());
  el('reloadMerchantSettings')?.addEventListener('click',()=>{
    if(latestMine&&window.confirm('捨棄尚未儲存的設定，載入最新版本？'))renderMine(latestMine);
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshMine();});
  window.addEventListener('pagehide',()=>{if(refreshTimer)clearInterval(refreshTimer);});
  window.addEventListener('pageshow',event=>{if(event.persisted&&merchantEntry)void start();});
  async function start() {
    try {
      const response=await fetch('../config.json',{cache:'no-cache',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error('無法讀取平台公開設定。');
      state.config=await response.json();
      const platformLiffId=String((merchantEntry?state.config.adminLiffId:state.config.platformLiffId) || '').trim();
      if(!(merchantEntry?/^2010791619-[A-Za-z0-9]+$/:/^2012065297-[A-Za-z0-9]+$/).test(platformLiffId))throw new Error(merchantEntry?'尚未正確設定一般管理員 LIFF ID。':'尚未正確設定總管理員專用 LIFF ID。');
      window.MemberSystem.validateConfig({...state.config,adminLiffId:platformLiffId},'admin');
      if(!window.liff)throw new Error('LIFF SDK 載入失敗，請確認網路後重試。');
      let initTimer;
      try {
        await Promise.race([window.liff.init({liffId:platformLiffId}),new Promise((_,reject)=>{initTimer=setTimeout(()=>reject(new Error('LINE 初始化逾時，請重新開啟此頁面。')),8000);})]);
      } catch {throw new Error(merchantEntry?'一般管理員 LIFF 初始化失敗，請確認 Endpoint URL 與網路。':'總管理員 LIFF 初始化失敗，請確認 Endpoint URL 與網路。');}
      finally {clearTimeout(initTimer);}
      if(!window.liff.isLoggedIn()) {
        if(window.liff.isInClient()){
          showLoginGate('LINE LIFF 尚未完成登入，請點選「重新使用 LINE 登入」進行驗證。');
          return;
        }
        el('platformStatus').textContent='正在前往 LINE 登入…';
        // An external-browser login initiated from a truly signed-out state
        // also counts as this visit's fresh LINE authentication.
        try { window.sessionStorage.setItem(LOGIN_RETURN_KEY,String(Date.now())); }
        catch { throw new Error('無法保存 LINE 登入回跳狀態，請允許此網站使用分頁儲存空間。'); }
        try { window.liff.login(); }
        catch {
          window.sessionStorage.removeItem(LOGIN_RETURN_KEY);
          showLoginGate('無法啟動 LINE 登入，請點選「重新使用 LINE 登入」重試。');
        }
        return;
      }
      const returnedFromLine=consumeLoginReturn();
      state.idToken=window.liff.getIDToken() || '';
      if(!state.idToken) {
        showLoginGate('無法取得 LINE ID token。請重新使用 LINE 登入，並確認 LIFF 已啟用 openid scope。');
        return;
      }
      if(merchantEntry){
        const data=await request('platform.application.ensure');
        renderMine(data);clearLoginGate();
        el('platformStatus').textContent='管理員 '+data.profile.displayName+'，已登入。';
        if(refreshTimer)clearInterval(refreshTimer);
        refreshTimer=setInterval(()=>{if(!document.hidden)void refreshMine();},15000);
        return;
      }
      const data=await refresh();
      if(!returnedFromLine) {
        showLoginGate();
        return;
      }
      clearLoginGate();
      for(const [key,label] of Object.entries(data.features)) {const wrap=document.createElement('label');const input=document.createElement('input');input.type='checkbox';input.dataset.feature=key;wrap.append(input,document.createTextNode(label));el('featureFields').append(wrap);}
      el('platformWorkspace').hidden=false;el('platformStatus').textContent=`總管理員 ${data.profile.displayName}，已登入。`;
    } catch(error){
      if(error.code==='PLATFORM_ADMIN_REQUIRED'&&!merchantEntry) {
        showAuthorizationDenied();
        return;
      }
      el('platformStatus').textContent=error.message;
      if(['AUTH_INVALID','AUTH_REQUIRED'].includes(error.code))showLoginGate(
        merchantEntry?'一般管理員 LINE 身分驗證未通過，請重新登入。':'總管理員 LINE 身分驗證未通過，請使用專用 LINE 登入。');

    }
  }
  void start();
})();
