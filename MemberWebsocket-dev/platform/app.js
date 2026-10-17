(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const form = el('tenantForm'), dialog = el('tenantDialog');
  const fields = form.elements;
  const lineKeys = ['adminChannelId','memberChannelId','messagingChannelId','adminLiffId','memberLiffId','pointsLiffId','eventLiffId','calendarLiffId','bookingLiffId'];
  const state = {config:null,idToken:'',features:{},tenants:[],applications:[],current:null,pending:null,busy:false,approval:null,merchant:null,merchantPending:null};
  const LOGIN_RETURN_KEY='platform-line-login-return-v1';
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
  function showLoginGate(message='每次進入總管理員控制台，請重新使用 LINE 確認身分。') {
    state.idToken='';
    state.pending=null;
    state.approval=null;
    state.merchantPending=null;
    for(const id of ['tenantDialog','approvalDialog']) {
      const dialog=el(id);
      if(dialog?.open)dialog.close();
    }
    el('platformWorkspace').hidden=true;
    el('merchantWorkspace').hidden=true;
    el('applicationWorkspace').hidden=true;
    el('platformLoginGate').hidden=false;
    el('platformLoginButton').disabled=false;
    el('platformStatus').textContent=message;
  }
  function clearLoginGate() { el('platformLoginGate').hidden=true; }
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
        if(response.status===401 && ['AUTH_INVALID','AUTH_REQUIRED'].includes(body.error?.code))
          showLoginGate('LINE 驗證已失效，請點選「重新使用 LINE 登入」。若仍失敗，請確認總管理員 LIFF 所屬的 Login Channel。');
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
    if (!state.tenants.length) {const p=document.createElement('p');p.className='empty';p.textContent='尚未新增商家。先建立管理員並設定功能與 LINE 資料。';list.append(p);return;}
    for (const tenant of state.tenants) {
      const card=document.createElement('article');card.className='tenant-card';
      const badge=document.createElement('span');badge.className='badge';badge.textContent=({pending_provisioning:'待佈建',suspended:'已停用',active:'已啟用'})[tenant.status] || '待確認';
      const title=document.createElement('h3');title.textContent=tenant.name;
      const info=document.createElement('p');info.textContent=`${tenant.slug} · 管理員 ${tenant.ownerLineUserId}`;
      const featureList=document.createElement('div');featureList.className='tenant-features';
      for (const [key,label] of Object.entries(state.features)) if (tenant.features[key]) {const tag=document.createElement('span');tag.textContent=label;featureList.append(tag);}
      if (!featureList.childNodes.length) featureList.textContent='尚未開放任何功能';
      const footer=document.createElement('footer');const edit=document.createElement('button');edit.type='button';edit.textContent='編輯設定';edit.addEventListener('click',()=>fill(tenant));footer.append(edit);
      if (tenant.status!=='suspended') {const suspend=document.createElement('button');suspend.type='button';suspend.className='secondary';suspend.textContent='停用商家';suspend.addEventListener('click',async()=>{
        if (!window.confirm(`停用「${tenant.name}」？`)) return;
        suspend.disabled=true;
        try {const result=await request('platform.tenant.suspend',{tenantId:tenant.id,expectedVersion:tenant.version,requestId:crypto.randomUUID()});state.tenants=state.tenants.map(item=>item.id===result.tenant.id?result.tenant:item);render();el('platformStatus').textContent='商家已停用。';}
        catch(error){el('platformStatus').textContent=error.message;}finally{suspend.disabled=false;}
      });footer.append(suspend);}
      card.append(badge,title,info,featureList,footer);list.append(card);
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

  // Applications are independent from the legacy admin membership table.
  const approvalDialog=el('approvalDialog'),approvalForm=el('approvalForm');
  function renderApplications() {
    const list=el('applicationList');list.replaceChildren();
    const pending=state.applications.filter(item=>item.status==='pending');
    if(!pending.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='目前沒有待審核的管理員。';list.append(empty);return;}
    for(const application of pending) {
      const card=document.createElement('article');card.className='tenant-card';
      const title=document.createElement('h3');title.textContent=application.businessName;
      const info=document.createElement('p');info.textContent=application.slug+' · 申請時間 '+new Date(application.requestedAt).toLocaleString('zh-TW');
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
      el('platformStatus').textContent='已審核通過；管理員現在可設定自己的 LINE，商家仍待獨立環境佈建。';
    }catch(error){
      el('approvalMessage').textContent=error.message;
      if(!error.uncertain)state.approval.features=null;
    }finally{el('confirmApproval').disabled=false;}
  });
  el('closeApproval').addEventListener('click',()=>{if(!el('confirmApproval').disabled){state.approval=null;approvalDialog.close();}});
  approvalDialog.addEventListener('cancel',e=>{if(el('confirmApproval').disabled)e.preventDefault();else state.approval=null;});

  const applicationForm=el('applicationForm'),merchantForm=el('merchantLineForm');
  function renderMine(data){
    state.merchant=data.tenant||null;state.features=data.features||state.features;
    const application=data.application;
    el('applicationWorkspace').hidden=false;
    el('applicationForm').hidden=Boolean(application&&application.status!=='rejected');
    const progress=el('applicationProgress');
    progress.hidden=!application;
    progress.textContent=application?('申請商家：'+application.businessName+' · '+
      ({pending:'等待總管理員審核',approved:'審核通過',rejected:'申請未通過，可重新提交'}[application.status]||'狀態待確認')):'';
    el('merchantWorkspace').hidden=application?.status!=='approved'||!data.tenant;
    if(!data.tenant)return;
    const tenant=data.tenant;
    el('merchantInfo').textContent=tenant.name+' · '+tenant.slug+' · '+(tenant.credentialsConfigured?'LINE 憑證已保存':'尚未設定 LINE 憑證');
    const tags=el('merchantFeatures');tags.replaceChildren();
    for(const [key,label] of Object.entries(state.features))if(tenant.features[key]){
      const tag=document.createElement('span');tag.textContent=label;tags.append(tag);
    }
    if(!tags.childNodes.length)tags.textContent='尚未核准任何業務功能';
    for(const key of lineKeys){
      const field=merchantForm.elements.namedItem(key);
      field.value=tenant.line?.[key]||'';
      const name={memberLiffId:'membership',pointsLiffId:'points',eventLiffId:'events',calendarLiffId:'calendar',bookingLiffId:'booking'}[key];
      if(name)field.required=tenant.features[name]===true;
    }
    for(const key of ['channelAccessToken','channelSecret']){
      const field=merchantForm.elements.namedItem(key);field.value='';field.required=!tenant.credentialsConfigured;
    }
    el('merchantMessage').textContent='';state.merchantPending=null;
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
  merchantForm.addEventListener('change',()=>{state.merchantPending=null;});
  merchantForm.addEventListener('submit',async event=>{
    event.preventDefault();if(!state.merchant||!merchantForm.reportValidity())return;
    const button=el('saveMerchantLine');button.disabled=true;el('merchantMessage').textContent='正在儲存 LINE 設定…';
    if(!state.merchantPending)state.merchantPending={
      requestId:crypto.randomUUID(),expectedVersion:state.merchant.version,
      line:Object.fromEntries(lineKeys.map(key=>[key,merchantForm.elements.namedItem(key).value.trim()])),
      credentials:{channelAccessToken:merchantForm.elements.namedItem('channelAccessToken').value.trim(),
        channelSecret:merchantForm.elements.namedItem('channelSecret').value.trim()},
    };
    try{
      const result=await request('platform.line.save',state.merchantPending);
      renderMine({application:{status:'approved',businessName:result.tenant.name},tenant:result.tenant,features:state.features});
      el('merchantMessage').textContent='LINE 設定已安全儲存。等待商家獨立資料環境完成驗證。';
    }catch(error){
      el('merchantMessage').textContent=error.message;
      if(!error.uncertain)state.merchantPending=null;
    }finally{button.disabled=false;}
  });

  async function start() {
    try {
      const response=await fetch('../config.json',{cache:'no-cache',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error('無法讀取平台公開設定。');
      state.config=await response.json();
      const platformLiffId=String(state.config.platformLiffId || '').trim();
      if(!/^2012065297-[A-Za-z0-9]+$/.test(platformLiffId))throw new Error('尚未正確設定總管理員專用 LIFF ID。');
      window.MemberSystem.validateConfig({...state.config,adminLiffId:platformLiffId},'admin');
      if(!window.liff)throw new Error('LIFF SDK 載入失敗，請確認網路後重試。');
      let initTimer;
      try {
        await Promise.race([window.liff.init({liffId:platformLiffId}),new Promise((_,reject)=>{initTimer=setTimeout(()=>reject(new Error('LINE 初始化逾時，請重新開啟此頁面。')),8000);})]);
      } catch {throw new Error('總管理員 LIFF 初始化失敗，請確認 Endpoint URL 與網路。');}
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
      let data,superAdmin=true;
      try{data=await refresh();}
      catch(error){
        if(error.code!=='PLATFORM_ADMIN_REQUIRED')throw error;
        superAdmin=false;
        data=await request('platform.application.bootstrap');
        renderMine(data);
      }
      if(!superAdmin){
        clearLoginGate();
        el('platformStatus').textContent='LINE 使用者 '+data.profile.displayName+'，請查看您的商家申請狀態。';
        return;
      }
      if(!returnedFromLine) {
        showLoginGate();
        return;
      }
      clearLoginGate();
      for(const [key,label] of Object.entries(data.features)) {const wrap=document.createElement('label');const input=document.createElement('input');input.type='checkbox';input.dataset.feature=key;wrap.append(input,document.createTextNode(label));el('featureFields').append(wrap);}
      el('platformWorkspace').hidden=false;el('platformStatus').textContent=`總管理員 ${data.profile.displayName}，已登入。`;
    } catch(error){
      el('platformStatus').textContent=error.message;
      if(['AUTH_INVALID','AUTH_REQUIRED'].includes(error.code))showLoginGate(
        'LINE 身分驗證未通過，請點選「重新使用 LINE 登入」。若仍失敗，請檢查平台 LIFF Channel。');
    }
  }
  void start();
})();
