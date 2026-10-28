(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const merchantEntry = document.documentElement.dataset.workspace === 'merchant';
  const selectedBusiness=window.BusinessContext?.slug || new URLSearchParams(location.search).get('business') || '';
  // Preserve the legacy API contract while retiring these management features.
  const featureKeys=['membership','points','events','calendar','integrations','booking','testing','usage'];
  const visibleFeatureKeys=featureKeys.filter(key=>key!=='testing'&&key!=='usage');
  const isV2=()=>state.config?.merchantApprovalVersion===2;
  const isAccount=()=>merchantEntry&&isV2()&&!selectedBusiness;
  let refreshTimer=null,refreshBusy=false;
  const form = el('tenantForm'), dialog = el('tenantDialog');
  const fields = form.elements;
  const lineKeys = ['adminChannelId','memberChannelId','messagingChannelId','adminLiffId','memberLiffId','pointsLiffId','eventLiffId','calendarLiffId','bookingLiffId'];
  const state = {config:null,idToken:'',features:{},tenants:[],applications:[],current:null,pending:null,busy:false,approval:null,merchant:null,merchantPending:null,qualification:null,qualifications:[],ownerApplications:[]};
  const LOGIN_RETURN_KEY=merchantEntry?'admin-line-login-return-v1':'platform-line-login-return-v1';
  const LOGIN_RETURN_TTL_MS=180_000;
  const AUTO_LOGIN_ATTEMPT_KEY=merchantEntry?'admin-line-auto-attempt-v1':'platform-line-auto-attempt-v1';
  let rejectedLoginReturn=false;
  function markAutomaticLoginAttempt() {
    // Per-role one-attempt guard prevents redirect or reload loops when LIFF is unavailable.
    // This browser hint never grants access; every ID token is verified server-side.
    try {
      const now=Date.now();
      const previous=Number(window.sessionStorage.getItem(AUTO_LOGIN_ATTEMPT_KEY));
      if(Number.isFinite(previous)&&previous>0&&now>=previous&&now-previous<=LOGIN_RETURN_TTL_MS)return false;
      window.sessionStorage.setItem(AUTO_LOGIN_ATTEMPT_KEY,String(now));
      return true;
    } catch { return false; }
  }
  function consumeLoginReturn() {
    // A one-use navigation hint only. Authorization still happens in LINE Verify + SQL.
    let issuedAt=0;
    try {
      const raw=window.sessionStorage.getItem(LOGIN_RETURN_KEY);
      issuedAt=Number(raw);
      window.sessionStorage.removeItem(LOGIN_RETURN_KEY);
      rejectedLoginReturn=raw!==null && (!Number.isFinite(issuedAt)||issuedAt<=0||Date.now()<issuedAt||Date.now()-issuedAt>LOGIN_RETURN_TTL_MS);
    } catch { return false; }
    return !rejectedLoginReturn && Number.isFinite(issuedAt) && issuedAt>0
      && Date.now()>=issuedAt && Date.now()-issuedAt<=LOGIN_RETURN_TTL_MS;
  }
  function showLoginGate(message=merchantEntry?'請重新使用 LINE 確認管理員身分。':'每次進入總管理員控制台，請重新使用 LINE 確認身分。') {
    state.idToken='';
    state.pending=null;
    state.approval=null;
    state.merchantPending=null;
    if(isV2()){clearAccount();clearPrivateMerchant();state.qualification=null;state.qualifications=[];state.tenants=[];state.applications=[];el('tenantList')?.replaceChildren();el('applicationList')?.replaceChildren();el('qualificationList')?.replaceChildren();}
    for(const key of ['channelAccessToken','channelSecret']) {
      const field=el('merchantLineForm')?.elements.namedItem(key);if(field)field.value='';
    }
    if(el('onboardingJourney'))el('onboardingJourney').hidden=true;
    for(const id of ['tenantDialog','approvalDialog','grantDialog','expiryDialog','v2ReviewDialog']) {
      const dialog=el(id);
      if(dialog?.open)dialog.close();
    }
    const authorizationNotice=el('platformAuthorizationNotice');
    if(authorizationNotice)authorizationNotice.hidden=true;
    el('platformWorkspace').hidden=true;
    el('merchantWorkspace').hidden=true;
    el('applicationWorkspace').hidden=true;
    el('platformStatus').hidden=false;
    el('platformStatus').textContent=message;
    const header=el('platformHeader');
    if(header)header.hidden=false;
  }
  function showAuthorizationDenied() {
    if(merchantEntry)return;
    // Only called for PLATFORM_ADMIN_REQUIRED after successful server-side LINE verification.
    // No client-side approval, privileged mutation, or account enumeration.
    showLoginGate('');
    el('platformAuthorizationNotice').hidden=false;
    el('platformStatus').hidden=true;
    const header=el('platformHeader');
    if(header)header.hidden=true;
    // A verified denial completes this attempt; a later page visit may retry LINE.
    try { window.sessionStorage.removeItem(AUTO_LOGIN_ATTEMPT_KEY); } catch {}
  }
  function clearLoginGate() {
    const header=el('platformHeader');
    if(header)header.hidden=false;
    el('platformStatus').hidden=false;
    const authorizationNotice=el('platformAuthorizationNotice');
    if(authorizationNotice)authorizationNotice.hidden=true;
  }
  function freshLineLogin() {
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
      el('platformStatus').textContent='無法啟動 LINE 登入，請重新開啟此頁。';
    }
  }
  window.addEventListener('pageshow',event=>{
    if(event.persisted && !merchantEntry) {
      // Restoring a cached Platform page must re-verify LINE, not strand the user
      // on a gate without a login button or expose a stale privileged workspace.
      showLoginGate('正在確認 LINE 身分…');
      void start();
    }
  });
  function message(text) { el('tenantFormStatus').textContent=text; }
  function uncertainError() { return Object.assign(new Error('儲存結果尚未確認。請重試同一操作，避免重複建立。'),{uncertain:true}); }
  async function request(action, payload = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),20000);
    try {
      const url = new URL(state.config.supabaseFunctionUrl);
      const readOnlyPreview = action === 'platform.member-oa.readiness' && location.hostname === 'integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app';
      url.pathname = url.pathname.replace(/\/api\/?$/, readOnlyPreview ? '/platform-api-preview' : '/platform-api');
      if (!url.pathname.endsWith(readOnlyPreview ? '/platform-api-preview' : '/platform-api')) throw new Error('總管理員 API 設定不正確。');
      let response;
      try { response=await fetch(url.href,{method:'POST',headers:{'Content-Type':'application/json',apikey:state.config.supabasePublishableKey},body:JSON.stringify({action,idToken:state.idToken,...payload}),signal:controller.signal}); }
      catch { throw uncertainError(); }
      let body;
      try { body=await response.json(); } catch { throw uncertainError(); }
      if (!response.ok || !body.ok) {
        if (response.status>=500 && ['PLATFORM_DATABASE_UNAVAILABLE','PLATFORM_UNAVAILABLE'].includes(body.error?.code)) throw uncertainError();
        if(response.status===403 && body.error?.code==='PLATFORM_ADMIN_REQUIRED'&&!merchantEntry)showAuthorizationDenied();
        if(isV2()&&merchantEntry&&[403,404].includes(response.status)){
          clearPrivateMerchant();clearAccount();
          if(isAccount()){el('qualificationWorkspace').hidden=false;el('qualificationStatus').textContent=body.error?.message||'目前無法確認管理員資格，請重新檢查。';}
        }
        if(response.status===401 && ['AUTH_INVALID','AUTH_REQUIRED','TENANT_REAUTH_REQUIRED'].includes(body.error?.code))
          showLoginGate(merchantEntry?(body.error?.message || '一般管理員 LINE 驗證已失效，請重新登入。'):'總管理員 LINE 驗證已失效，請確認專用 LINE Login Channel。');
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
      const badge=document.createElement('span');badge.className='badge';badge.textContent=tenant.status==='suspended'?'已停用':tenant.expired?'使用期限已到':tenant.onboarding?.adminReady?'已核准・可立即使用'
        :tenant.onboarding?.configurationComplete?'設定齊全・待平台開通':'已核准・待 LINE 設定';
      const title=document.createElement('h3');title.textContent=tenant.name;
      const info=document.createElement('p');info.textContent=`${tenant.slug} · 管理員 ${tenant.ownerLineUserId}`;
      const featureList=document.createElement('div');featureList.className='tenant-features';
      for (const [key,label] of Object.entries(state.features)) if (visibleFeatureKeys.includes(key) && tenant.features[key]) {const tag=document.createElement('span');tag.textContent=label;featureList.append(tag);}
      if (!featureList.childNodes.length) featureList.textContent='尚未開放任何功能';
      const footer=document.createElement('footer');const edit=document.createElement('button');edit.type='button';edit.textContent='調整開放功能';edit.addEventListener('click',()=>openGrantDialog(tenant));footer.append(edit);
      const expiry=document.createElement('button');expiry.type='button';expiry.className='secondary';expiry.textContent='設定使用期限';
      expiry.addEventListener('click',()=>openExpiryDialog(tenant));footer.append(expiry);
      const access=document.createElement('button');access.type='button';access.className='secondary';
      const suspended=tenant.status==='suspended';access.textContent=suspended?'復權':'停用商家';let pending=null,working=false;
      access.addEventListener('click',async()=>{
        if(working)return;
        if(!pending&&!window.confirm(suspended?`復權「${tenant.name}」？期限與功能授權維持原設定，管理員須重新使用 LINE 登入。`:`停用「${tenant.name}」？管理員與用戶會立即失去使用資格。`))return;
        if(!pending)pending={tenantId:tenant.id,expectedVersion:tenant.version,requestId:crypto.randomUUID()};
        working=true;for(const button of footer.querySelectorAll('button'))button.disabled=true;
        try{
          await request(suspended?'platform.tenant.resume':'platform.tenant.suspend',pending);
          pending=null;await refresh();el('platformStatus').textContent=suspended?'已復權，請重新使用 LINE 登入；既有期限與授權維持不變。':'商家已停用，舊憑證已撤銷。';
        }catch(error){
          el('platformStatus').textContent=error.message;
          if(error.uncertain){access.textContent='重試相同'+(suspended?'復權':'停用')+'操作';}
          else{pending=null;await refresh().catch(()=>{});}
        }finally{working=false;access.disabled=false;if(!pending)for(const button of footer.querySelectorAll('button'))button.disabled=false;}
      });footer.append(access);
      const expiryInfo=document.createElement('p');expiryInfo.textContent='使用期限：'+(tenant.expiresAt?new Date(tenant.expiresAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})+'（台灣時間）':'無到期日');
      const setup=document.createElement('p');
      const onboarding=tenant.onboarding;
      setup.textContent=tenant.status==='suspended'?'已停用；管理員與用戶均不可使用。':tenant.expired?'使用期限已到；請由總管理員調整期限，延長後須重新登入。':onboarding?.adminReady?'已核准功能已開通，管理員可設定業務內容並分享專屬用戶連結。'
        :onboarding?.configurationComplete?'LINE 設定已完整保存；下一步由平台完成商家專屬服務與 LINE 實測。目前管理業務與用戶端尚未開放。'
        :'審核已通過；下一步由一般管理員完成共用 LINE 與各項功能設定。目前管理業務與用戶端尚未開放。';
      card.append(badge,title,info,featureList,expiryInfo,setup,footer);list.append(card);
    }
  }
  const expiryDialog=el('expiryDialog'),expiryForm=el('expiryForm');
  let expiryTenant=null,expiryPending=null,expiryBusy=false;
  function openExpiryDialog(tenant){
    expiryTenant=tenant;expiryPending=null;expiryBusy=false;
    for(const input of expiryForm.querySelectorAll('input'))input.disabled=false;
    el('saveExpiry').textContent='儲存使用期限';
    el('expiryDescription').textContent=tenant.name+' · '+tenant.slug;
    el('expiryUnlimited').checked=!tenant.expiresAt;
    el('expiryAt').value=tenant.expiresAt?new Date(Date.parse(tenant.expiresAt)+8*3600000).toISOString().slice(0,16):'';
    el('expiryAt').disabled=!tenant.expiresAt;el('expiryAt').required=Boolean(tenant.expiresAt);
    for(const button of expiryForm.querySelectorAll('button'))button.disabled=false;
    el('expiryMessage').textContent='';expiryDialog.showModal();
  }
  el('expiryUnlimited').addEventListener('change',()=>{
    el('expiryAt').disabled=el('expiryUnlimited').checked;el('expiryAt').required=!el('expiryUnlimited').checked;
  });
  expiryForm.addEventListener('submit',async event=>{
    event.preventDefault();if(expiryBusy||!expiryTenant)return;
    if(!expiryPending){
      if(!expiryForm.reportValidity())return;
      const expiresAt=el('expiryUnlimited').checked?null:new Date(el('expiryAt').value+':00+08:00').toISOString();
      if(!window.confirm(`更新「${expiryTenant.name}」的使用期限？${expiresAt?' 到期即停止管理員與用戶存取。':' 將設定為無到期日。'}`))return;
      expiryPending={tenantId:expiryTenant.id,expectedVersion:expiryTenant.version,requestId:crypto.randomUUID(),expiresAt};
    }
    expiryBusy=true;for(const node of expiryForm.querySelectorAll('input,button'))node.disabled=true;
    el('expiryMessage').textContent='正在更新使用期限…';
    try{
      await request('platform.tenant.expiry.save',expiryPending);expiryPending=null;await refresh();expiryDialog.close();
      el('platformStatus').textContent='使用期限已更新；停用狀態與功能授權維持原設定。';
    }catch(error){
      el('expiryMessage').textContent=error.message;
      if(error.uncertain){el('saveExpiry').textContent='重試相同期限操作';el('saveExpiry').disabled=false;}
      else{expiryPending=null;for(const node of expiryForm.querySelectorAll('input,button'))node.disabled=false;el('expiryAt').disabled=el('expiryUnlimited').checked;}
    }finally{expiryBusy=false;}
  });
  el('closeExpiry').addEventListener('click',()=>{if(!expiryBusy&&!expiryPending)expiryDialog.close();});
  expiryDialog.addEventListener('cancel',event=>{if(expiryBusy||expiryPending)event.preventDefault();});
  // The version flag coordinates presentation only. Every request is authorized by the server.
  let qualificationPending=null,qualificationBusy=false,merchantApplicationPending=null,merchantApplicationTarget=null,merchantApplicationBusy=false;
  let reviewPending=null,reviewSelection=null,reviewBusy=false;
  function clearPrivateMerchant(){
    const simple=el('merchantSimpleLine');
    if(simple?.dataset.mounted==='true'){window.BusinessLineSettings?.clear();delete simple.dataset.mounted;simple.hidden=true;}
    state.merchant=null;state.merchantPending=null;merchantDirty=false;latestMine=null;
    const settings=el('merchantLineForm');
    if(settings)for(const input of settings.querySelectorAll('input'))input.value='';
    for(const id of ['merchantInfo','merchantReadiness','merchantFeatures','merchantChecklist','merchantFeatureNav','merchantMessage','merchantSyncStatus'])el(id)?.replaceChildren();
    el('merchantLaunchStatus')?.querySelectorAll('[data-business-launch]').forEach(node=>node.remove());
    if(el('merchantWorkspace'))el('merchantWorkspace').hidden=true;
    if(el('applicationWorkspace'))el('applicationWorkspace').hidden=true;
    if(el('onboardingJourney'))el('onboardingJourney').hidden=true;
  }
  function clearAccount(){
    state.ownerApplications=[];merchantApplicationPending=null;merchantApplicationTarget=null;qualificationPending=null;
    if(el('myMerchantsWorkspace'))el('myMerchantsWorkspace').hidden=true;
    if(el('qualificationWorkspace'))el('qualificationWorkspace').hidden=true;
    el('myMerchantList')?.replaceChildren();el('merchantApplicationForm')?.reset();
    for(const id of ['merchantApplicationMessage','qualificationReason','qualificationMessage'])if(el(id))el(id).textContent='';
  }
  const qualificationLabels={pending:'管理員資格等待總管理員審核',approved:'管理員資格已通過',rejected:'管理員資格未通過，可補充資料後重新申請',suspended:'管理員資格已停用，請聯絡總管理員'};
  function renderQualification(qualification){
    state.qualification=qualification;
    el('qualificationWorkspace').hidden=false;
    el('qualificationStatus').textContent=qualificationLabels[qualification?.status]||'尚未申請管理員資格';
    el('qualificationReason').textContent=qualification?.reviewReason?'審核理由：'+qualification.reviewReason:'';
    const button=el('submitQualification');button.hidden=Boolean(qualification&&!['rejected'].includes(qualification.status));
    button.disabled=qualificationBusy;button.textContent=qualificationPending?'重試相同資格申請':qualification?.status==='rejected'?'重新申請管理員資格':'申請管理員資格';
    if(qualification?.status!=='approved'){
      state.ownerApplications=[];merchantApplicationPending=null;merchantApplicationTarget=null;
      el('myMerchantsWorkspace').hidden=true;el('myMerchantList').replaceChildren();el('merchantApplicationForm').reset();
      if(qualification?.status==='pending')qualificationPending=null;
    }
  }
  async function refreshAccount(){
    if(refreshBusy||qualificationBusy||merchantApplicationBusy)return;
    refreshBusy=true;
    try{
      const {qualification}=await request('platform.qualification.bootstrap');
      renderQualification(qualification);
      if(qualification?.status==='approved'){
        const data=await request('platform.merchant.list');
        state.ownerApplications=data.applications||[];renderMyMerchants();
      }
      return true;
    }catch(error){el('platformStatus').textContent=error.message;return false;}
    finally{refreshBusy=false;}
  }
  function renderMyMerchants(){
    el('myMerchantsWorkspace').hidden=false;
    const list=el('myMerchantList');list.replaceChildren();
    if(!state.ownerApplications.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='尚未申請商家，請填寫下方資料。';list.append(empty);}
    for(const application of state.ownerApplications){
      const card=document.createElement('article');card.className='tenant-card';card.dataset.applicationId=application.id;
      const title=document.createElement('h3');title.textContent=application.businessName;
      const info=document.createElement('p');info.textContent=application.slug;
      const badge=document.createElement('span');badge.className='badge';
      const tenant=application.tenant;
      const ready=application.status==='approved'&&tenant?.status==='active'&&!tenant.expired&&tenant.onboarding?.adminReady===true;
      badge.textContent=application.status==='pending'?'等待商家審核':application.status==='rejected'?'商家申請未通過':tenant?.status==='suspended'?'商家已停用':tenant?.expired?'商家使用期限已到':ready?'已核准・可管理':'已核准・等待開通';
      card.append(badge,title,info);
      if(application.reviewReason){const reason=document.createElement('p');reason.textContent='審核理由：'+application.reviewReason;card.append(reason);}
      const actions=document.createElement('footer');
      if(ready){
        const manage=document.createElement('a');manage.href='/admin/?business='+encodeURIComponent(application.slug);manage.textContent='管理商家';manage.dataset.manageMerchant='true';
        const line=document.createElement('a');line.href='/admin/workspace.html?business='+encodeURIComponent(application.slug);line.textContent='LINE 設定';line.dataset.merchantLine='true';actions.append(manage,line);
      }else{
        const unavailable=document.createElement('p');unavailable.textContent=application.status==='pending'?'審核通過並開通後，即可管理此商家。':application.status==='rejected'?'請依審核理由修正此申請。':'請聯絡總管理員確認開通、停用或使用期限。';actions.append(unavailable);
      }
      if(application.status==='rejected'){
        const retry=document.createElement('button');retry.type='button';retry.className='secondary';retry.dataset.resubmitMerchant='true';retry.textContent='修正並重新申請';retry.disabled=Boolean(merchantApplicationPending)||merchantApplicationBusy;
        retry.addEventListener('click',()=>resetMerchantApplication(application));actions.append(retry);
      }
      card.append(actions);list.append(card);
    }
    el('newMerchantApplication').disabled=Boolean(merchantApplicationPending)||merchantApplicationBusy;
  }
  function lockMerchantApplication(locked){
    for(const node of el('merchantApplicationForm').querySelectorAll('input,button'))node.disabled=locked;
    el('newMerchantApplication').disabled=locked;
    for(const node of document.querySelectorAll('[data-resubmit-merchant]'))node.disabled=locked;
  }
  function resetMerchantApplication(application=null){
    if(merchantApplicationPending||merchantApplicationBusy)return;
    merchantApplicationTarget=application;const form=el('merchantApplicationForm');form.reset();lockMerchantApplication(false);
    form.elements.namedItem('businessName').value=application?.businessName||'';
    el('merchantApplicationTitle').textContent=application?'修正商家申請：'+application.businessName:'新增商家申請';
    el('cancelMerchantResubmit').hidden=!application;el('merchantApplicationMessage').textContent='';
    el('submitMerchantApplication').textContent=application?'重新提交此商家':'提交商家申請';
    form.elements.namedItem('businessName').focus();
  }
  el('submitQualification')?.addEventListener('click',async()=>{
    if(!isAccount()||qualificationBusy||state.qualification&&state.qualification.status!=='rejected')return;
    if(!qualificationPending)qualificationPending={requestId:crypto.randomUUID()};
    qualificationBusy=true;el('submitQualification').disabled=true;el('qualificationMessage').textContent='正在提交管理員資格申請…';
    try{
      const data=await request('platform.qualification.submit',qualificationPending);qualificationPending=null;
      renderQualification(data.qualification);el('qualificationMessage').textContent='資格申請已送出。';
    }catch(error){
      if(!error.uncertain)qualificationPending=null;
      if(error.status===409){qualificationPending=null;qualificationBusy=false;await refreshAccount();}
      el('qualificationMessage').textContent=error.message;
    }finally{qualificationBusy=false;el('submitQualification').disabled=false;el('submitQualification').textContent=qualificationPending?'重試相同資格申請':'申請管理員資格';}
  });
  el('newMerchantApplication')?.addEventListener('click',()=>resetMerchantApplication());
  el('cancelMerchantResubmit')?.addEventListener('click',()=>resetMerchantApplication());
  el('merchantApplicationForm')?.addEventListener('submit',async event=>{
    event.preventDefault();if(!isAccount()||state.qualification?.status!=='approved'||merchantApplicationBusy)return;
    const form=el('merchantApplicationForm');
    if(!merchantApplicationPending){
      if(!form.reportValidity())return;
      merchantApplicationPending={businessName:form.elements.namedItem('businessName').value.trim(),requestId:crypto.randomUUID(),
        ...(merchantApplicationTarget?{applicationId:merchantApplicationTarget.id,expectedVersion:merchantApplicationTarget.version}:{})};
    }
    merchantApplicationBusy=true;lockMerchantApplication(true);el('merchantApplicationMessage').textContent='正在提交商家申請…';
    try{
      const data=await request('platform.merchant.submit',merchantApplicationPending);
      state.ownerApplications=[...state.ownerApplications.filter(item=>item.id!==data.application.id),data.application];
      merchantApplicationPending=null;merchantApplicationTarget=null;merchantApplicationBusy=false;resetMerchantApplication();renderMyMerchants();
      el('merchantApplicationMessage').textContent='商家申請已送出，既有商家維持原狀。';
    }catch(error){
      if(!error.uncertain)merchantApplicationPending=null;
      if(error.status===409){merchantApplicationTarget=null;merchantApplicationBusy=false;await refreshAccount();}
      el('merchantApplicationMessage').textContent=error.message;
    }finally{
      merchantApplicationBusy=false;lockMerchantApplication(Boolean(merchantApplicationPending));
      el('submitMerchantApplication').disabled=false;el('submitMerchantApplication').textContent=merchantApplicationPending?'重試相同商家申請':'提交商家申請';
    }
  });
  function reviewButton(kind,item,decision,label){
    const button=document.createElement('button');button.type='button';button.className=decision==='approved'?'':'secondary';button.dataset.reviewDecision=decision;button.textContent=label;
    button.addEventListener('click',()=>openV2Review(kind,item,decision));return button;
  }
  function renderQualifications(){
    el('qualificationReviews').hidden=false;const list=el('qualificationList');list.replaceChildren();
    if(!state.qualifications.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='目前沒有管理員資格申請。';list.append(empty);}
    for(const qualification of state.qualifications){
      const card=document.createElement('article');card.className='tenant-card';card.dataset.qualificationId=qualification.id;
      const title=document.createElement('h3');title.textContent=qualification.displayName||qualification.applicantLineUserId||'LINE 管理員';
      const status=document.createElement('p');status.textContent=qualificationLabels[qualification.status]||qualification.status;
      const reason=document.createElement('p');reason.textContent=qualification.reviewReason?'審核理由：'+qualification.reviewReason:'';
      const actions=document.createElement('footer');
      if(['pending','suspended'].includes(qualification.status))actions.append(reviewButton('qualification',qualification,'approved',qualification.status==='suspended'?'恢復管理員資格':'核准資格'));
      if(qualification.status==='pending')actions.append(reviewButton('qualification',qualification,'rejected','拒絕資格'));
      if(qualification.status==='approved')actions.append(reviewButton('qualification',qualification,'suspended','停用資格'));
      card.append(title,status,reason,actions);list.append(card);
    }
  }
  function renderMerchantReviews(){
    const list=el('applicationList');list.replaceChildren();
    if(!state.applications.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='目前沒有商家申請。';list.append(empty);}
    for(const application of state.applications){
      const card=document.createElement('article');card.className='tenant-card';card.dataset.applicationId=application.id;
      const title=document.createElement('h3');title.textContent=application.businessName;
      const info=document.createElement('p');info.textContent=application.slug+' · '+({pending:'等待商家審核',approved:'已核准',rejected:'未通過'}[application.status]||application.status)+' · LINE 使用者 '+(application.applicantLineUserId||'資料待確認');
      const reason=document.createElement('p');reason.textContent=application.reviewReason?'審核理由：'+application.reviewReason:'';
      const actions=document.createElement('footer');
      if(application.status==='pending')actions.append(reviewButton('merchant',application,'approved','核准商家與功能'),reviewButton('merchant',application,'rejected','拒絕商家申請'));
      card.append(title,info,reason,actions);list.append(card);
    }
  }
  function lockV2Review(locked){
    for(const node of el('v2ReviewForm').querySelectorAll('input,textarea,button'))node.disabled=locked;
  }
  function openV2Review(kind,item,decision){
    if(reviewBusy||reviewPending)return;
    reviewSelection={kind,item,decision};const approvesMerchant=kind==='merchant'&&decision==='approved';
    el('v2ReviewTitle').textContent=(kind==='qualification'?'管理員資格':'商家申請')+'審核';
    el('v2ReviewDescription').textContent=(item.businessName||item.displayName||item.applicantLineUserId||'LINE 管理員')+' · '+({approved:'核准',rejected:'拒絕',suspended:'停用'}[decision]);
    el('v2ReviewGrants').hidden=!approvesMerchant;const list=el('v2ReviewFeatures');list.replaceChildren();
    if(approvesMerchant)for(const key of visibleFeatureKeys){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.dataset.v2Feature=key;label.append(input,document.createTextNode(state.features[key]||key));list.append(label);}
    el('reviewReason').value='';el('reviewReason').required=decision!=='approved';el('v2ReviewMessage').textContent='';el('confirmV2Review').textContent='確認審核';lockV2Review(false);el('v2ReviewDialog').showModal();
    (decision==='approved'?el('confirmV2Review'):el('reviewReason')).focus();
  }
  el('v2ReviewForm')?.addEventListener('submit',async event=>{
    event.preventDefault();if(!isV2()||!reviewSelection||reviewBusy)return;
    if(!reviewPending){
      if(!el('v2ReviewForm').reportValidity())return;
      const {kind,item,decision}=reviewSelection;const reason=el('reviewReason').value.trim();
      if(Array.from(reason).length>500){el('v2ReviewMessage').textContent='審核理由最多 500 個字。';return;}
      reviewPending={...(kind==='qualification'?{qualificationId:item.id}:{applicationId:item.id}),expectedVersion:item.version,decision,reason,requestId:crypto.randomUUID(),
        ...(kind==='merchant'&&decision==='approved'?{features:Object.fromEntries(featureKeys.map(key=>[key,visibleFeatureKeys.includes(key) && el('v2ReviewFeatures').querySelector('[data-v2-feature="'+key+'"]').checked]))}:{})};
    }
    reviewBusy=true;lockV2Review(true);el('v2ReviewMessage').textContent='正在儲存審核結果…';
    try{
      const kind=reviewSelection.kind;const data=await request('platform.'+kind+'.review',reviewPending);
      if(kind==='qualification'){state.qualifications=state.qualifications.map(item=>item.id===data.qualification.id?data.qualification:item);renderQualifications();}
      else{state.applications=state.applications.map(item=>item.id===data.application.id?data.application:item);await refresh();}
      reviewPending=null;reviewSelection=null;el('v2ReviewDialog').close();el('platformStatus').textContent='審核結果已更新。';
    }catch(error){
      if(!error.uncertain)reviewPending=null;
      if(error.status===409){reviewSelection=null;el('v2ReviewDialog').close();await refresh();el('platformStatus').textContent='資料版本已更新，已重新載入。請確認最新資料後再次審核。';}
      else el('v2ReviewMessage').textContent=error.message;
    }finally{
      reviewBusy=false;lockV2Review(Boolean(reviewPending));el('confirmV2Review').disabled=false;el('confirmV2Review').textContent=reviewPending?'重試相同審核操作':'確認審核';
    }
  });
  el('closeV2Review')?.addEventListener('click',()=>{if(!reviewBusy&&!reviewPending){reviewSelection=null;el('v2ReviewDialog').close();}});
  el('v2ReviewDialog')?.addEventListener('cancel',event=>{if(reviewBusy||reviewPending)event.preventDefault();else reviewSelection=null;});

  async function refresh() {
    const data=await request('platform.bootstrap');
    state.tenants=data.tenants;state.applications=data.applications||[];
    state.features=data.features;
    if(isV2()){const result=await request('platform.qualification.list');state.qualifications=result.qualifications||[];renderQualifications();el('applicationListTitle').textContent='商家申請審核';}
    render();renderApplications();
    return data;
  }
  function collect() {return {name:fields.namedItem('name').value.trim(),slug:fields.namedItem('slug').value.trim(),ownerLineUserId:fields.namedItem('ownerLineUserId').value.trim(),
    features:Object.fromEntries(featureKeys.map(key=>[key,visibleFeatureKeys.includes(key) && Boolean(form.querySelector('[data-feature="'+key+'"]')?.checked)])),
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
    for(const [key,label] of Object.entries(state.features).filter(([key])=>visibleFeatureKeys.includes(key))) {
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
      features:Object.fromEntries(featureKeys.map(key=>[key,visibleFeatureKeys.includes(key) && Boolean(grantForm.querySelector('[data-grant-feature="'+key+'"]')?.checked)]))
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
    if(isV2()){renderMerchantReviews();return;}
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
        for(const [key,label] of Object.entries(state.features).filter(([key])=>visibleFeatureKeys.includes(key))) {
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
      featureKeys.map(key=>[key,visibleFeatureKeys.includes(key) && Boolean(approvalForm.querySelector('[data-approve-feature="'+key+'"]')?.checked)]));
    el('confirmApproval').disabled=true;el('approvalMessage').textContent='正在審核…';
    try{
      const result=await request('platform.application.approve',state.approval);
      state.tenants=[result.tenant,...state.tenants.filter(x=>x.id!==result.tenant.id)];
      state.applications=state.applications.map(x=>x.id===state.approval.applicationId?{...x,status:'approved'}:x);
      state.approval=null;approvalDialog.close();render();renderApplications();
      el('platformStatus').textContent='已審核通過；已核准的管理功能與用戶端已開放，一般管理員可在管理工作台各功能區塊設定 LINE。';
    }catch(error){
      el('approvalMessage').textContent=error.message;
      if(!error.uncertain)state.approval.features=null;
    }finally{el('confirmApproval').disabled=false;}
  });
  el('closeApproval').addEventListener('click',()=>{if(!el('confirmApproval').disabled){state.approval=null;approvalDialog.close();}});
  approvalDialog.addEventListener('cancel',e=>{if(el('confirmApproval').disabled)e.preventDefault();else state.approval=null;});

  const applicationForm=el('applicationForm'),merchantForm=el('merchantLineForm');
  const featureLiffNames={membership:'memberLiffId',points:'pointsLiffId',events:'eventLiffId',calendar:'calendarLiffId',booking:'bookingLiffId'};
  let merchantPanel='shared',merchantWorkspaceTab='overview',merchantDirty=false,merchantSaving=false,latestMine=null;
  const hasFeatureLine = tenant => merchantEntry && tenant?.moduleLine !== undefined;
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
    list.replaceChildren();let status=tenant.onboarding;
    if(hasFeatureLine(tenant)){
      const configured={};
      for(const [feature,key]of Object.entries(featureLiffNames))if(tenant.features?.[feature]){
        const line={...tenant.line,...tenant.moduleLine?.[feature]?.line},id=line[key];
        const ready=/^\d{5,30}-[A-Za-z0-9_-]+$/.test(id||'')&&id.startsWith(line.memberChannelId+'-');
        configured[feature]={configured:ready,missing:ready?[]:[key]};
      }
      const commonMissing=['adminChannelId','adminLiffId'].filter(key=>!tenant.line?.[key]);
      status={...tenant.onboarding,commonMissing,features:configured,configurationComplete:!commonMissing.length&&Object.values(configured).every(x=>x.configured)};
    }
    const row=(name,detail,panel)=>{
      const article=document.createElement('article'),body=document.createElement('div'),title=document.createElement('strong'),p=document.createElement('p');
      title.textContent=name;p.textContent=detail;body.append(title,p);article.append(body);
      if(panel){const button=document.createElement('button');button.type='button';button.className='secondary';button.dataset.setupFeature=panel;button.textContent='前往設定';button.addEventListener('click',()=>{selectMerchantPanel(panel);merchantForm.scrollIntoView?.({block:'start'});});article.append(button);}
      list.append(article);
    };
    const missing=status?.commonMissing;
    row(hasFeatureLine(tenant)?'商家管理端登入（僅首次設定）':'共用 LINE 設定',!status?'設定檢查服務尚未更新，請重新整理後再試。':missing.length?'尚缺：'+missing.map(key=>lineLabels[key]||key).join('、'):'必填資料已保存，仍需實際 LINE 驗證。','shared');
    for(const [key,label] of Object.entries(state.features))if(visibleFeatureKeys.includes(key)&&tenant.features?.[key]===true) {
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
      +'\n核准功能：'+Object.entries(state.features).filter(([key])=>visibleFeatureKeys.includes(key)&&tenant.features?.[key]===true).map(([,label])=>label).join('、')
      +(status?.adminReady?'\n管理業務／用戶端：已開放\n管理入口：'+location.origin+'/admin/?business='+tenant.slug:'\n管理業務／用戶端：尚未開放\n請聯絡總管理員確認申請。');
    try{await navigator.clipboard.writeText(summary);el('copySetupMessage').textContent='開通狀態已複製，可貼給平台聯絡人；不含憑證。';}
    catch{el('copySetupMessage').textContent='無法自動複製，請將本頁顯示的商家代碼與開通狀態提供給平台聯絡人。';}
  });
  function selectMerchantWorkspaceTab(requested) {
    const granted = (hasFeatureLine(state.merchant)?Object.keys(featureLiffNames):visibleFeatureKeys).some(key => state.merchant?.features?.[key] === true);
    merchantWorkspaceTab = requested === 'line' && granted ? 'line' : 'overview';
    const lineTab = el('merchantLineSettingsTab'),overviewTab = el('merchantOverviewTab');
    if (!lineTab || !overviewTab || !el('merchantOverviewPanel') || !el('merchantLineSettingsPanel')) return;
    lineTab.hidden = !granted; lineTab.disabled = !granted;
    lineTab.setAttribute('aria-selected',String(merchantWorkspaceTab === 'line'));
    overviewTab.setAttribute('aria-selected',String(merchantWorkspaceTab === 'overview'));
    // Roving tab stops let keyboard users enter only the currently selected panel.
    lineTab.tabIndex = merchantWorkspaceTab === 'line' ? 0 : -1;
    overviewTab.tabIndex = merchantWorkspaceTab === 'overview' ? 0 : -1;
    el('merchantLineSettingsPanel').hidden = merchantWorkspaceTab !== 'line';
    el('merchantOverviewPanel').hidden = merchantWorkspaceTab !== 'overview';
  }
  function handleMerchantWorkspaceTabKeydown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const lineTab = el('merchantLineSettingsTab');
    // A withheld module never becomes visible or keyboard-reachable.
    if (!lineTab || lineTab.hidden || lineTab.disabled) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'line'
      : merchantWorkspaceTab === 'overview' ? 'line' : 'overview';
    selectMerchantWorkspaceTab(next);
    el(next === 'line' ? 'merchantLineSettingsTab' : 'merchantOverviewTab')?.focus();
  }
  el('merchantOverviewTab')?.addEventListener('click',()=>selectMerchantWorkspaceTab('overview'));
  el('merchantLineSettingsTab')?.addEventListener('click',()=>selectMerchantWorkspaceTab('line'));
  el('merchantOverviewTab')?.addEventListener('keydown',handleMerchantWorkspaceTabKeydown);
  el('merchantLineSettingsTab')?.addEventListener('keydown',handleMerchantWorkspaceTabKeydown);
  function selectMerchantPanel(feature, reveal = true) {
    if(merchantSaving||state.merchantPending)return;
    const tenant=state.merchant;
    if(hasFeatureLine(tenant)){
      if(reveal)selectMerchantWorkspaceTab('line');
      window.BusinessLineSettings?.select(feature);return;
    }
    // A stale bookmark or a forged query string never exposes an unapproved feature.
    merchantPanel=feature==='shared'||(visibleFeatureKeys.includes(feature)&&tenant?.features?.[feature]===true)?feature:'shared';
    if (reveal) selectMerchantWorkspaceTab('line');
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
    el('saveMerchantLine').disabled=merchantPanel==='integrations';
    el('merchantMessage').textContent='';
    try {
      const url=new URL(window.location.href);
      if(merchantPanel==='shared')url.searchParams.delete('feature');
      else url.searchParams.set('feature',merchantPanel);
      window.history.replaceState(window.history.state,'',url.href);
    } catch {}
  }
  function renderMerchantNav(tenant) {
    const simple=el('merchantSimpleLine'),modern=hasFeatureLine(tenant);
    if(simple){simple.hidden=!modern;el('merchantFeatureNav').hidden=modern;merchantForm.hidden=modern;}
    if(modern){
      for(const input of merchantForm.querySelectorAll('input'))input.disabled=true;
      if(!simple||!window.BusinessLineSettings?.mount)throw Error('LINE 設定元件尚未載入，請重新整理後再試。');
      const requested=new URLSearchParams(location.search).get('feature');simple.dataset.mounted='true';
      window.BusinessLineSettings.mount({root:simple,data:{tenant},
        request:(action,payload)=>request(action,{...payload,business:selectedBusiness||tenant.slug}),
        onUpdate:updated=>{state.merchant=updated;state.mineSignature=JSON.stringify(['approved',updated.version,updated.status,updated.expired]);renderChecklist(updated);},
        onSelect:feature=>{try{const url=new URL(location.href);if(feature)url.searchParams.set('feature',feature);else url.searchParams.delete('feature');history.replaceState(history.state,'',url.href);}catch{}}
      });
      if(requested)window.BusinessLineSettings.select(requested);
      return;
    }
    const nav=el('merchantFeatureNav');nav.replaceChildren();
    // Fail closed: only server-returned grants are rendered on the top bar.
    // Productized business mutations remain unavailable until isolated APIs exist.
    for(const [feature,label] of [['shared','共用 LINE 設定'],...Object.entries(state.features).filter(([key])=>visibleFeatureKeys.includes(key))]) {
      if(feature!=='shared'&&tenant.features?.[feature]!==true)continue;
      const button=document.createElement('button');
      button.type='button';button.dataset.lineFeature=feature;button.textContent=label;
      button.addEventListener('click',()=>selectMerchantPanel(feature));
      nav.append(button);
    }
    const requested=new URLSearchParams(window.location.search).get('feature');
    selectMerchantPanel(requested||merchantPanel, false);
  }
  function renderMine(data){
    state.mineSignature=JSON.stringify([data.application?.status,data.tenant?.version,data.tenant?.status,data.tenant?.expired]);
    state.merchant=data.tenant||null;state.features=data.features||state.features;
    state.merchantPending=null;merchantDirty=false;latestMine=null;lockMerchant(false);
    if(el('merchantSyncStatus'))el('merchantSyncStatus').textContent='';
    if(el('reloadMerchantSettings'))el('reloadMerchantSettings').hidden=true;
    const application=data.application;
    if(!data.tenant||(data.tenant.status==='suspended'||data.tenant.expired))for(const key of ['channelAccessToken','channelSecret'])merchantForm.elements.namedItem(key).value='';
    if(isV2()&&selectedBusiness){el('onboardingJourney').hidden=true;}else renderJourney(application,data.tenant);
    el('applicationWorkspace').hidden=isV2()&&Boolean(selectedBusiness);
    el('applicationForm').hidden=Boolean(application&&application.status!=='rejected');
    const progress=el('applicationProgress');
    progress.hidden=!application;
    progress.textContent=application?('申請商家：'+application.businessName+' · '+
      ({pending:'等待總管理員審核',approved:'審核通過',rejected:'申請未通過，可重新提交'}[application.status]||'狀態待確認')):'';
    el('merchantWorkspace').hidden=application?.status!=='approved'||!data.tenant||(data.tenant.status==='suspended'||data.tenant.expired);
    if((data.tenant?.status==='suspended'||data.tenant?.expired))progress.textContent=data.tenant?.expired?'使用期限已到，請聯絡總管理員。':'此管理員已停用，請聯絡總管理員。';
    if(el('applicationNextStep'))el('applicationNextStep').textContent=(data.tenant?.status==='suspended'||data.tenant?.expired)?'請聯絡總管理員確認停用原因。'
      :application?.status==='pending'?'下一步由總管理員審核並勾選開放功能。你現在不必填 LINE 資料；請保留此入口，審核結果會在本頁更新。申請時間：'+new Date(application.requestedAt).toLocaleString('zh-TW')
      :application?.status==='approved'?(data.tenant?.onboarding?.adminReady?'審核已通過，管理功能與專屬用戶端已開放。請進入管理功能儲存業務設定，並分享下方用戶連結。':'審核已通過。正在確認業務空間，請重新檢查進度。')
      :application?.status==='rejected'?'請確認商家資料後重新提交；如需了解原因，請聯絡總管理員。':'填寫商家資料並提交，由總管理員審核。';
    if(isV2()&&(!data.tenant||data.application?.status!=='approved'||data.tenant.status==='suspended'||data.tenant.expired)){clearPrivateMerchant();return;}
    if(!data.tenant)return;
    const tenant=data.tenant;
    if(!isV2()&&tenant.onboarding?.adminReady&&['/admin/','/admin/workspace.html'].includes(location.pathname)&&!new URLSearchParams(location.search).has('business')){
      const target=new URL('/admin/',location.origin);target.searchParams.set('business',tenant.slug);
      const requested=new URLSearchParams(location.search).get('feature');
      if(tenant.features[requested]===true)target.searchParams.set('feature',requested);
      location.replace(target.href);return;
    }
    el('merchantInfo').textContent=tenant.name+' · '+tenant.slug+' · '+(tenant.credentialsConfigured?'LINE 憑證已保存':'尚未設定 LINE 憑證');
    const readiness=el('merchantReadiness');
    if(readiness) {
      readiness.textContent=tenant.onboarding?.adminReady?'審核已通過，已核准功能與用戶端已開放。自有 LINE 入口與通知設定可隨時保存。':tenant.onboarding?.configurationComplete
        ? 'LINE 必填設定已保存，等待平台開通商家專屬服務。尚未驗證實際 LINE 登入與訊息傳送。'
        : '你已取得 LINE 設定權。請完成共用資料與各項已核准功能的設定，再由平台完成開通與實測。';
    }
    const tags=el('merchantFeatures');tags.replaceChildren();
    for(const [key,label] of Object.entries(state.features))if(visibleFeatureKeys.includes(key)&&tenant.features[key]){
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
    const deepLink=new URLSearchParams(location.search).get('feature');
    renderMerchantNav(tenant);
    selectMerchantWorkspaceTab(deepLink && tenant.features?.[deepLink]===true ? 'line' : merchantWorkspaceTab);
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
    if(!merchantEntry||!state.idToken||refreshBusy||merchantSaving||(!isV2()&&state.merchantPending))return;
    if(isAccount()){await refreshAccount();return;}
    refreshBusy=true;
    try {
      const data=await request('platform.application.bootstrap');
      const signature=JSON.stringify([data.application?.status,data.tenant?.version,data.tenant?.status,data.tenant?.expired]);
      const accessChanged=data.application?.status!=='approved'||(data.tenant?.status==='suspended'||data.tenant?.expired)
        ||JSON.stringify(data.tenant?.features)!==JSON.stringify(state.merchant?.features);
      if(signature!==state.mineSignature){
        if((merchantDirty||state.merchantPending)&&!accessChanged){
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
  window.addEventListener('pageshow',event=>{if(event.persisted&&merchantEntry){showLoginGate('正在重新確認 LINE 身分…');void start();}});
  async function start() {
    try {
      const response=await fetch('../config.json',{cache:'no-cache',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error('無法讀取平台公開設定。');
      state.config=await response.json();
      if(isV2()&&merchantEntry&&selectedBusiness){
        if(typeof window.BusinessContext?.configure!=='function')throw new Error('無法載入所選商家的登入設定。');
        state.config=await window.BusinessContext.configure({...state.config});
      }
      if(isV2()&&merchantEntry){const subtitle=document.querySelector('header.topbar p:last-child');if(subtitle)subtitle.textContent=selectedBusiness?'此頁設定所選商家的 LINE。返回我的商家可切換其他商家。':'先完成管理員資格，再獨立申請商家。選擇商家後可管理內容或設定 LINE。';}
      const platformLiffId=String((merchantEntry?state.config.adminLiffId:state.config.platformLiffId) || '').trim();
      const merchantLiffPattern=isV2()&&selectedBusiness?/^\d{5,30}-[A-Za-z0-9_-]+$/:/^2010791619-[A-Za-z0-9]+$/;
      if(!(merchantEntry?merchantLiffPattern:/^2012065297-[A-Za-z0-9]+$/).test(platformLiffId))throw new Error(merchantEntry?'尚未正確設定一般管理員 LIFF ID。':'尚未正確設定總管理員專用 LIFF ID。');
      window.MemberSystem.validateConfig({...state.config,adminLiffId:platformLiffId},'admin');
      if(!window.liff)throw new Error('LIFF SDK 載入失敗，請確認網路後重試。');
      let initTimer;
      try {
        await Promise.race([window.liff.init({liffId:platformLiffId}),new Promise((_,reject)=>{initTimer=setTimeout(()=>reject(new Error('LINE 初始化逾時，請重新開啟此頁面。')),8000);})]);
      } catch {throw new Error(merchantEntry?'一般管理員 LIFF 初始化失敗，請確認 Endpoint URL 與網路。':'總管理員 LIFF 初始化失敗，請確認 Endpoint URL 與網路。');}
      finally {clearTimeout(initTimer);}
      const returnedFromLine=consumeLoginReturn();
      const inLiffClient=window.liff.isInClient();
      if(!window.liff.isLoggedIn()) {
        if(returnedFromLine || rejectedLoginReturn) {
          showLoginGate('LINE 登入未完成，請重新開啟頁面。');
          return;
        }
        if(inLiffClient){
          // LIFF browser signs in during init; a failed first initialization
          // gets one automatic reload. liff.login() must not be called in LIFF.
          if(markAutomaticLoginAttempt()) {
            if(merchantEntry) {
              el('platformStatus').textContent='正在重新初始化 LINE 登入…';
              window.location.reload();
            } else freshLineLogin();
            return;
          }
          showLoginGate('LINE 登入未完成，請在 LINE 中重新開啟此頁面。');
          return;
        }
        // A cancelled/failed external LINE callback must not cause a redirect loop.
        if(!markAutomaticLoginAttempt()) {
          showLoginGate('LINE 登入未完成，請重新開啟頁面。');
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
          showLoginGate('無法啟動 LINE 登入，請重新開啟頁面。');
        }
        return;
      }
      state.idToken=window.liff.getIDToken() || '';
      if(!state.idToken) {
        showLoginGate('無法取得 LINE 身分憑證，請確認 LIFF 已開通 openid 權限，並重新開啟頁面。');
        return;
      }
      // Every external entry, including the general-admin portal, must complete
      // this visit's fresh LINE redirect before using any previously cached token.
      // LIFF in-app browsing is verified by liff.init() + the server bootstrap:
      // liff.login() is unsupported in the LINE client.
      if(!inLiffClient && !returnedFromLine) {
        if(!rejectedLoginReturn && markAutomaticLoginAttempt()) {
          freshLineLogin();
        } else {
          showLoginGate(rejectedLoginReturn
            ? 'LINE 登入回跳已過期，請重新開啟頁面。'
            : 'LINE 驗證未完成，請重新開啟頁面。');
        }
        return;
      }
      if(merchantEntry){
        // A verified LINE visit is not consent to apply; only the form submits a review request.
        let data;
        if(isAccount()){data={accountLoaded:await refreshAccount()};}
        else{data=await request('platform.application.bootstrap');renderMine(data);}
        clearLoginGate();
        if(isV2()&&selectedBusiness&&el('backToMyMerchants'))el('backToMyMerchants').hidden=false;
        // Clear only after LINE and server verification have both succeeded.
        try { window.sessionStorage.removeItem(AUTO_LOGIN_ATTEMPT_KEY); } catch {}
        if(data.accountLoaded!==false)el('platformStatus').textContent=data.profile?.displayName?'管理員 '+data.profile.displayName+'，已登入。':'已確認 LINE 身分。';
        if(refreshTimer)clearInterval(refreshTimer);
        refreshTimer=setInterval(()=>{if(!document.hidden)void refreshMine();},15000);
        return;
      }
      const data=await refresh();
      clearLoginGate();
      for(const [key,label] of Object.entries(data.features).filter(([key])=>visibleFeatureKeys.includes(key))) {const wrap=document.createElement('label');const input=document.createElement('input');input.type='checkbox';input.dataset.feature=key;wrap.append(input,document.createTextNode(label));el('featureFields').append(wrap);}
      el('platformWorkspace').hidden=false;el('platformStatus').textContent=`總管理員 ${data.profile.displayName}，已登入。`;
      try { window.sessionStorage.removeItem(AUTO_LOGIN_ATTEMPT_KEY); } catch {}
    } catch(error){
      if(error.code==='PLATFORM_ADMIN_REQUIRED'&&!merchantEntry) {
        showAuthorizationDenied();
        return;
      }
      showLoginGate(['AUTH_INVALID','AUTH_REQUIRED'].includes(error.code)
        ? (merchantEntry?'一般管理員 LINE 身分驗證未通過，請重新登入。':'總管理員 LINE 身分驗證未通過，請使用專用 LINE 登入。')
        : error?.message || 'LINE 驗證尚未完成，請檢查網路後手動重試。');

    }
  }
  void start();
})();
