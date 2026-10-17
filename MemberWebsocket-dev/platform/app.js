(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const form = el('tenantForm'), dialog = el('tenantDialog');
  const fields = form.elements;
  const lineKeys = ['adminChannelId','memberChannelId','messagingChannelId','adminLiffId','memberLiffId','pointsLiffId','eventLiffId','calendarLiffId','bookingLiffId'];
  const state = {config:null,idToken:'',features:{},tenants:[],current:null,pending:null,busy:false};
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
  async function refresh() {const data=await request('platform.bootstrap');state.tenants=data.tenants;state.features=data.features;render();return data;}
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
        if(window.liff.isInClient())throw new Error('LINE LIFF 尚未完成登入，請重新開啟此 LIFF。');
        el('platformStatus').textContent='正在前往 LINE 登入…';
        // Let LIFF use its configured Endpoint. Merchant fresh-login URLs add
        // their own callback parameters and must not control platform redirects.
        window.liff.login();
        return;
      }
      state.idToken=window.liff.getIDToken() || '';
      if(!state.idToken)throw new Error('無法取得總管理員 LINE ID token，請確認 LIFF 已啟用 openid scope。');
      const data=await refresh();
      for(const [key,label] of Object.entries(data.features)) {const wrap=document.createElement('label');const input=document.createElement('input');input.type='checkbox';input.dataset.feature=key;wrap.append(input,document.createTextNode(label));el('featureFields').append(wrap);}
      el('platformWorkspace').hidden=false;el('platformStatus').textContent=`總管理員 ${data.profile.displayName}，已登入。`;
    } catch(error){el('platformStatus').textContent=error.message;}
  }
  void start();
})();
