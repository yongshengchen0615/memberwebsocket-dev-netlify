(() => {
  'use strict';
  const modules = {
    membership: ['members', '會員卡', 'member', 'memberLiffId'],
    points: ['cards', '集點卡', 'points', 'pointsLiffId'],
    events: ['events', '活動票券', 'event', 'eventLiffId'],
    calendar: ['calendar', '營運日曆', 'calendar', 'calendarLiffId'],
    booking: ['booking', '預約', 'booking', 'bookingLiffId'],
    integrations: ['operationsHub', '整合中心'], testing: ['testMode', '測試'], usage: ['operationAudit', '使用紀錄'],
  };
  // Login identity belongs to the business; LIFF and notification routes belong to each feature.
  const businessLogin = {
    adminChannelId: '商家管理端 Login Channel ID',
    adminLiffId: '商家管理端 LIFF ID',
  };
  const moduleMessaging = {
    messagingChannelId: '本功能 Messaging API Channel ID',
    channelAccessToken: '本功能 Channel access token',
    channelSecret: '本功能 Channel secret',
  };
  const featureGuides = {
    membership: '會員加入與會員卡入口：設定會員卡 LIFF；需要會員通知時再設定通知通道。',
    points: '集點與兌換入口：設定集點卡 LIFF；需要集點通知時再設定通知通道。',
    events: '活動與票券入口：設定活動票券 LIFF；需要票券通知時再設定通知通道。',
    calendar: '營運日曆入口：設定日曆 LIFF。目前沒有自動 LINE 推播事件，不必另外設定通知接收用途。',
    booking: '線上預約入口：設定預約 LIFF；預約管理員通知與會員通知可分開設定。',
  };
  let grants = {}, tenant = null, loading = false, saving = false, activeFeature = null, navSignature = '';
  const views = new Map();
  const pendingOperation = () => [...views.values()].some(v => v.pending || [...(v.routes?.values() || [])].some(r => r.pending || r.testPending));
  function node(tag, text, className) {
    const result = document.createElement(tag); if (text) result.textContent = text;
    if (className) result.className = className; return result;
  }
  async function request(action, payload = {}) {
    const session = window.MemberAdminSession.get();
    if (!session) throw Error('登入狀態已失效，請重新登入。');
    const url = new URL(session.config.supabaseFunctionUrl);
    url.pathname = url.pathname.replace(/\/api\/?$/, '/platform-api');
    let response;
    try {
      response = await fetch(url.href, {method:'POST', cache:'no-store', signal:AbortSignal.timeout(15000),
        headers:{'Content-Type':'application/json', apikey:session.config.supabasePublishableKey},
        body:JSON.stringify({action, ...payload, business:session.config.business, idToken:session.idToken})});
    } catch { throw Object.assign(Error('無法確認儲存結果，請重試相同操作。'), {uncertain:true}); }
    let body;
    try { body = await response.json(); }
    catch { throw Object.assign(Error('無法確認伺服器回應，請重試相同操作。'), {uncertain:true}); }
    if (!response.ok || !body.ok) throw Object.assign(Error(body.error?.message || '無法取得 LINE 設定。'), {code:body.error?.code,uncertain:response.status>=500});
    return body.data;
  }
  function lock() {
    for (const view of views.values()) {
      const blocked = saving || pendingOperation();
      for (const input of view.form?.querySelectorAll('input') || []) {
        const sharedIdentity = Object.hasOwn(businessLogin, input.name);
        input.disabled = blocked || (sharedIdentity && Boolean(view.identityBlock?.hidden));
      }
      if (view.save) { view.save.disabled = saving || (blocked && !view.pending); view.save.textContent = view.pending ? '重試相同儲存操作' : '儲存' + view.label + ' LINE 設定'; }
      view.reload.disabled = blocked;
      if(view.webhook){
        view.webhook.refresh.disabled=blocked;
        view.webhook.check.disabled=blocked || view.dirty.size>0;
        view.webhook.copy.disabled=blocked || !view.webhook.endpoint.value;
      }
      for (const route of view.routes?.values() || []) {
        for (const input of route.form.querySelectorAll('input,select,button')) input.disabled = blocked;
        if (!saving && route.pending) route.save.disabled = false;
        route.test.disabled = blocked || route.dirty || tenant?.moduleLine?.[view.feature]?.notifications?.[route.purpose]?.mode === 'disabled';
        if (!saving && route.testPending) route.test.disabled = false;
        route.test.textContent = route.testPending ? '重試相同測試操作' : '傳送測試給我';
        route.save.textContent = route.pending ? '重試相同儲存操作' : '驗證並儲存通知設定';
      }
    }
  }
  function addField(form, key, labelText, secret = false) {
    const label = node('label', labelText), input = node('input');
    input.name = key; input.id = form.id + '-' + key; input.maxLength = key === 'channelAccessToken' ? 4000 : 100;
    input.type = secret ? 'password' : 'text'; input.autocomplete = secret ? 'new-password' : 'off';
    input.spellcheck = false;
    input.pattern = key === 'channelSecret' ? '[a-fA-F0-9]{32}' : key.endsWith('ChannelId') ? '[0-9]{5,30}' : key.endsWith('LiffId') ? '[0-9]{5,30}-(?:[A-Za-z0-9_]|-)+' : '.*';
    const help = node('small', key.endsWith('LiffId') ? 'LINE Developers → LINE Login Channel → LIFF → LIFF ID。Endpoint URL 請使用本區塊下方的完整網址。'
      : key === 'channelAccessToken' ? 'Messaging API Channel → Messaging API → Channel access token (long-lived)。留空保留已存憑證。'
      : key === 'channelSecret' ? 'Messaging API Channel → Basic settings → Channel secret。與 token 一起更新，儲存後不回填。'
      : 'LINE Developers → ' + (key === 'messagingChannelId' ? 'Messaging API' : 'LINE Login') + ' Channel → Basic settings → Channel ID。');
    help.id = input.id + '-help'; input.setAttribute('aria-describedby', help.id);
    label.append(input, help); form.append(label); return input;
  }
  function update(view, reset = false) {
    if (!tenant) return;
    if(view.webhook && view.webhookVersion!==tenant.version){
      view.webhookVersion=tenant.version;view.webhook.endpoint.value='';view.webhook.copy.disabled=true;
      view.webhook.status.textContent='讀取狀態可查看已儲存的設定；檢查連線會確認 LINE Channel，真人收件需另外驗收。';
    }
    for (const [purpose, route] of view.routes || []) {
      const saved = tenant.moduleLine?.[view.feature]?.notifications?.[purpose];
      if (!route.dirty && !route.pending) {
        route.mode.value = saved?.mode || 'inherit';
        route.channel.value = saved?.channelId || '';
        route.token.value = '';
      }
      route.fields.hidden = route.mode.value !== 'custom';
      route.channel.required = route.token.required = route.mode.value === 'custom';
      route.summary.textContent = saved?.mode === 'disabled' ? '已停用：此用途不發送通知。'
        : saved?.mode === 'custom' ? '已驗證獨立 Channel ' + saved.channelId + '；Token 已加密保存。'
        : (tenant.moduleLine?.[view.feature]?.credentialsConfigured || tenant.credentialsConfigured) ? '共用本模組的 Messaging API 憑證；尚未驗證通知連線。' : '未設定：請先設定本模組 Channel，或選用獨立通知 Channel。';
    }
    if (view.identityBlock) {
      // Other features should not ask again after the first module seeds shared Login identity.
      view.identityBlock.hidden = Boolean(tenant.line?.adminChannelId && tenant.line?.adminLiffId);
    }
    if (view.form) for (const input of view.form.querySelectorAll('input')) {
      const secret = ['channelAccessToken','channelSecret'].includes(input.name);
      const sharedIdentity = Object.hasOwn(businessLogin, input.name);
      if (reset || !view.dirty.has(input.name)) input.value = secret ? '' : {...tenant.line,...tenant.moduleLine?.[view.feature]?.line}[input.name] || '';
      input.required = !secret && input.name !== 'messagingChannelId'
        && !(sharedIdentity && view.identityBlock?.hidden);
      input.disabled = sharedIdentity && Boolean(view.identityBlock?.hidden);
      if(['adminChannelId','adminLiffId'].includes(input.name))input.readOnly=Boolean(tenant.line?.[input.name]);
    }
    view.links.replaceChildren();
    if (!view.path) { view.links.textContent = '此管理功能不需要額外 LINE 用戶端入口。'; return; }
    const endpoint = new URL('/' + view.path + '/', location.origin);
    endpoint.searchParams.set('business', tenant.slug);
    const a = node('a', '開啟' + view.label + '用戶端', 'button button-outline');
    a.href = endpoint.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.dataset.featureClient = view.feature;
    const code = node('code', endpoint.href); code.dataset.featureEndpoint = view.feature;
    const copy = node('button', '複製用戶端連結', 'button button-outline'); copy.type = 'button';
    copy.onclick = async () => { try { await navigator.clipboard.writeText(endpoint.href); view.status.textContent = '已複製' + view.label + '用戶端連結。'; } catch { view.status.textContent = '請複製下方的完整網址。'; } };
    view.links.append(a, copy, node('p', 'LIFF Endpoint URL（含商家代碼）'), code);
    const id = {...tenant.line,...tenant.moduleLine?.[view.feature]?.line}[view.key];
    if (id?.startsWith({...tenant.line,...tenant.moduleLine?.[view.feature]?.line}.memberChannelId+'-') && /^\d{5,30}-[A-Za-z0-9_-]+$/.test(id || '')) {
      const liff = node('a', '開啟已儲存的 LINE 入口'); liff.href = 'https://liff.line.me/' + id;
      liff.target = '_blank'; liff.rel = 'noopener noreferrer'; view.links.append(liff);
    }
  }
  async function save(view, event) {
    event.preventDefault();
    if (saving || (!view.pending && pendingOperation()) || !tenant || grants[view.feature] !== true || tenant.features?.[view.feature] !== true) return;
    if (!view.pending) {
      if (!view.form.reportValidity()) return;
      const line = {...tenant.line,...tenant.moduleLine?.[view.feature]?.line};
      // Merge only this form's edited fields into the last server snapshot.
      // Other modules' unsaved drafts never enter this request.
      for (const input of view.form.querySelectorAll('input')) if (!['channelAccessToken','channelSecret'].includes(input.name)
        && (view.dirty.has(input.name) || !line[input.name])) line[input.name] = input.value.trim();
      view.pending = {feature:view.feature, expectedVersion:tenant.version, requestId:crypto.randomUUID(), line,
        credentials:{channelAccessToken:view.form.elements.channelAccessToken.value.trim(),channelSecret:view.form.elements.channelSecret.value.trim()}};
    }
    saving = true; lock(); view.status.textContent = '正在儲存' + view.label + ' LINE 設定…';
    try {
      const result = await request('platform.line.save', view.pending);
      tenant = result.tenant; view.pending = null; view.dirty.clear();
      for (const v of views.values()) update(v, v === view);
      view.status.textContent = view.label + ' LINE 設定已儲存，其他功能的 Channel、LIFF 與憑證均維持原設定。';
    } catch (error) {
      view.status.textContent = error.message;
      if (!error.uncertain) view.pending = null;
      if (['FEATURE_DISABLED','TENANT_SUSPENDED','PLATFORM_APPLICATION_NOT_APPROVED','BUSINESS_FORBIDDEN','AUTH_INVALID','TENANT_EXPIRED','TENANT_REAUTH_REQUIRED'].includes(error.code)) {
        tenant = null; for (const v of views.values()) { v.form?.reset(); v.section.hidden = true; }
      }
      if (error.code === 'PLATFORM_CONFLICT') view.status.textContent += ' 請先載入最新設定，再確認本區塊內容後儲存。';
    } finally { saving = false; lock(); }
  }
  async function saveNotification(view, route, event) {
    event.preventDefault();
    if (saving || (!route.pending && pendingOperation()) || !tenant || grants[view.feature] !== true) return;
    if (!route.pending) {
      if (!route.form.reportValidity()) return;
      route.pending = {feature:view.feature,purpose:route.purpose,mode:route.mode.value,expectedVersion:tenant.version,
        requestId:crypto.randomUUID(),messagingChannelId:route.channel.value.trim(),channelAccessToken:route.token.value.trim()};
    }
    saving = true; lock(); route.status.textContent = '正在驗證並儲存通知設定…';
    try {
      const result = await request('platform.notifications.save',route.pending);
      tenant = result.tenant; route.pending = null; route.dirty = false; route.token.value = '';
      for (const v of views.values()) update(v);
      route.status.textContent = '通知設定已儲存。';
    } catch (error) {
      route.status.textContent = error.message;
      if (!error.uncertain) route.pending = null;
      if (error.code === 'PLATFORM_CONFLICT') route.status.textContent += ' 請載入最新設定後重試。';
      if (['FEATURE_DISABLED','TENANT_SUSPENDED','BUSINESS_FORBIDDEN','AUTH_INVALID','TENANT_EXPIRED','TENANT_REAUTH_REQUIRED'].includes(error.code)) {
        tenant = null; for (const v of views.values()) { v.form?.reset(); for (const r of v.routes?.values() || []) {r.form.reset();r.pending=null;} v.section.hidden=true; }
      }
    } finally { saving = false; lock(); }
  }
  async function testNotification(view,route) {
    if (saving || (!route.testPending && pendingOperation()) || !tenant || grants[view.feature] !== true || route.dirty) return;
    route.testPending ||= {feature:view.feature,purpose:route.purpose,expectedVersion:tenant.version,requestId:crypto.randomUUID()};
    saving=true;lock();route.status.textContent='正在傳送測試通知給目前登入的管理員…';
    try {
      await request('platform.notifications.test',route.testPending);route.testPending=null;
      route.status.textContent='LINE 已接受測試通知，請確認目前帳號已加入該官方帳號好友。';
    } catch(error) {route.status.textContent=error.message;if(!error.uncertain)route.testPending=null;}
    finally{saving=false;lock();}
  }
  function notificationForms(view) {
    view.routes = new Map();
    if (!view.path) return;
    if (view.feature === 'calendar') return; // There is no calendar push event yet.
    const details = node('details'); details.append(node('summary','本功能通知接收用途（需要時設定）'));
    const purposeHelp = {membership:'會員加入與權益',points:'集點與兌換',events:'活動與票券',booking:'預約狀態'}[view.feature];
    details.append(node('p',purposeHelp + '通知可共用本功能憑證，或另設專用 Messaging API Channel。兩種 Channel 須屬於相同 LINE Provider；預約管理通知僅送給商家已授權管理員。'));
    for (const purpose of view.feature === 'booking' ? ['admin','member'] : ['member']) {
      const form = node('form'); form.id = 'notification-' + view.feature + '-' + purpose;
      form.append(node('h3',purpose === 'admin' ? '管理員接收通知' : '會員接收通知'));
      const label=node('label','通知通道'),mode=node('select'); mode.name='mode';
      for (const [value,text] of [['inherit','共用本模組憑證'],['custom','使用獨立通知 Channel'],['disabled','停用此用途通知']]) {const o=node('option',text);o.value=value;mode.append(o);}
      label.append(mode);form.append(label);
      const fields=node('div','','business-line-fields');fields.id=form.id+'-fields';
      const channel=addField(fields,'messagingChannelId','通知 Messaging API Channel ID');
      const token=addField(fields,'channelAccessToken','通知 Channel access token（long-lived）',true);
      token.nextElementSibling.textContent='Messaging API → Channel access token (long-lived)。重新驗證或輪替時需輸入完整 Token；儲存後不回填。';
      form.append(fields);
      const summary=node('p'),status=node('p'); status.setAttribute('role','status');status.setAttribute('aria-live','polite');
      const save=node('button','驗證並儲存通知設定','button button-outline');save.type='submit';
      const test=node('button','傳送測試給我','button button-outline');test.type='button';
      const route={purpose,form,mode,channel,token,fields,summary,status,save,test,dirty:false,pending:null,testPending:null};
      test.onclick=()=>void testNotification(view,route);
      form.append(summary,save,test,status);form.addEventListener('submit',event=>void saveNotification(view,route,event));
      form.addEventListener('input',()=>{route.dirty=true;fields.hidden=mode.value!=='custom';channel.required=token.required=mode.value==='custom';status.textContent='本用途有尚未儲存的設定。';lock();});
      view.routes.set(purpose,route);details.append(form);
    }
    view.section.append(details);
  }
  function selectFeature(feature) {
    activeFeature = views.has(feature) ? feature : views.keys().next().value || null;
    for (const [name, view] of views) {
      const selected = name === activeFeature;
      view.section.hidden = !selected;
      const button = document.getElementById('businessLineFeatureTab-' + name);
      if (button) {button.setAttribute('aria-selected',String(selected));button.tabIndex = selected ? 0 : -1;}
    }
  }
  function renderNav() {
    const nav = document.getElementById('businessLineFeatureNav');
    if (!nav) return;
    const signature = [...views.keys()].join('|');
    if (signature !== navSignature) {
      navSignature = signature;
      nav.replaceChildren();
      for (const [feature, view] of views) {
        const button = node('button',view.label);
        button.id='businessLineFeatureTab-'+feature;button.type='button';button.setAttribute('role','tab');
        button.setAttribute('aria-controls',view.section.id);
        button.onclick=()=>selectFeature(feature);
        button.addEventListener('keydown',event=>{
          if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
          const available=[...nav.querySelectorAll('[role="tab"]')].filter(tab=>!tab.hidden&&!tab.disabled);
          const index=available.indexOf(button);if(index<0||!available.length)return;
          event.preventDefault();
          const next=event.key==='Home'?0:event.key==='End'?available.length-1:(index+(event.key==='ArrowRight'?1:-1)+available.length)%available.length;
          available[next].click();available[next].focus();
        });
        nav.append(button);
      }
    }
    selectFeature(activeFeature);
  }
  function webhookPanel(view){
    const panel=node('details');panel.dataset.lineWebhook=view.feature;
    panel.append(node('summary','Webhook 連線診斷'));
    panel.append(node('p','僅使用 LIFF 入口時可略過。需要接收事件時，先儲存 Messaging API 設定，再檢查連線。設定 Webhook URL 前，請確認該 Channel 的現有回呼用途。'));
    const refresh=node('button','讀取 Webhook 狀態','button button-outline'),check=node('button','檢查 LINE 連線','button button-outline'),copy=node('button','複製 Webhook URL','button button-outline');
    for(const button of [refresh,check,copy])button.type='button';copy.disabled=true;
    const label=node('label','已確認的接收網址'),endpoint=node('input');endpoint.type='url';endpoint.readOnly=true;
    endpoint.id='lineWebhookEndpoint-'+view.feature;label.htmlFor=endpoint.id;label.append(endpoint);
    const status=node('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const run=async(action)=>{
      if(saving || pendingOperation() || !tenant || grants[view.feature]!==true || (action==='platform.webhook.check' && view.dirty.size>0))return;
      saving=true;lock();status.textContent='正在檢查…';
      try{
        const result=await request(action,{feature:view.feature});endpoint.value=result.endpoint;
        status.textContent=(result.configurationState==='optional'?'LIFF 入口可獨立使用；Messaging API 尚未設定。':'Messaging API 設定已儲存。')
          +' LINE API：'+(result.apiState==='accepted'?'已接受連線檢查':'尚未確認')
          +'；Webhook 簽章：'+(result.ingressState==='verified'?'已驗證':'尚未收到有效請求')
          +'；真人收件：待驗收。'
          +(result.lastEventAt?' 最後事件：'+new Date(result.lastEventAt).toLocaleString('zh-TW')+'。':'');
      }catch(error){
        endpoint.value='';status.textContent=error.message;
        if(['FEATURE_DISABLED','TENANT_SUSPENDED','BUSINESS_FORBIDDEN','AUTH_INVALID','TENANT_EXPIRED','TENANT_REAUTH_REQUIRED','PLATFORM_QUALIFICATION_REQUIRED','PLATFORM_QUALIFICATION_SUSPENDED','PLATFORM_APPLICATION_NOT_FOUND'].includes(error.code)){
          tenant=null;for(const v of views.values()){v.form?.reset();if(v.webhook)v.webhook.endpoint.value='';v.section.hidden=true;}
        }
      }finally{saving=false;lock();}
    };
    refresh.onclick=()=>void run('platform.webhook.status');check.onclick=()=>void run('platform.webhook.check');
    copy.onclick=async()=>{try{await navigator.clipboard.writeText(endpoint.value);status.textContent='Webhook URL 已複製；請先確認 Channel 現有回呼用途，再由授權人員設定。';}catch{endpoint.focus();endpoint.select();status.textContent='請複製上方已選取的 Webhook URL。';}};
    panel.append(refresh,check,label,copy,status);view.webhook={refresh,check,copy,endpoint,status};view.section.append(panel);
  }
  function render() {
    const container = document.getElementById('businessLineFeatureContent');
    if (!container) return;
    for (const [feature, [panelName, label, path, key]] of Object.entries(modules)) {
      const allowed = grants[feature] === true && tenant?.features?.[feature] === true;
      if (!allowed || !path) { views.get(feature)?.section.remove(); views.delete(feature); continue; }
      if (views.has(feature)) continue;
      const section = node('section', '', 'business-line-settings'); section.dataset.businessLineFeature = feature;
      section.id='businessLineSection-'+feature;section.setAttribute('role','tabpanel');section.setAttribute('aria-labelledby','businessLineFeatureTab-'+feature);
      section.append(node('h2', label + '｜LINE 設定與用戶端連結'));
      section.append(node('p', featureGuides[feature]));
      const status = node('p'); status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
      const view = {feature, label, path, key, section, status, dirty:new Set(), links:node('div','','business-client-links')};
      const reload = node('button','載入最新 LINE 設定','button button-outline'); reload.type = 'button'; view.reload = reload;
      reload.onclick = () => void load(true, view);
      if (path) {
        const form = node('form'); form.id = 'businessLine-' + feature; view.form = form;
        addField(form, 'memberChannelId', label + '會員 Login Channel ID');
        addField(form, key, label + ' LIFF ID');
        const identity = node('div','','business-line-identity'); identity.id = 'businessLineIdentity-' + feature;
        const identityFields = node('div','','business-line-fields');
        for (const [name,text] of Object.entries(businessLogin)) addField(identityFields,name,text);
        for (const input of identityFields.querySelectorAll('input')) { input.id = form.id + '-' + input.name; input.setAttribute('aria-describedby',input.id+'-help'); input.nextElementSibling.id=input.id+'-help'; }
        identity.append(node('h3','商家共用登入設定（僅首次設定）'),node('p','商家管理端 LINE Login 身分跨功能共用；會員端 Login Channel 與 LIFF 則依功能獨立設定。'),identityFields);
        form.append(identity); view.identityBlock = identity;
        const shared = node('details'); shared.open = false;
        shared.append(node('summary','本功能 Messaging API 憑證（需要通知時設定）'));
        shared.append(node('p','有效的 Login Channel 與 LIFF 即可啟用本功能入口；不發送通知時，本區可全部留空。需要通知時請同時設定 Messaging API Channel、Token 與 Secret，再驗證通知通道。已設定的憑證留空即保留；更換 Channel 時必須同時更新憑證。'));
        const grid = node('div','','business-line-fields');
        for (const [name,text] of Object.entries(moduleMessaging)) addField(grid,name,text,['channelAccessToken','channelSecret'].includes(name));
        for (const input of grid.querySelectorAll('input')) { input.id = form.id + '-' + input.name; input.setAttribute('aria-describedby',input.id+'-help'); input.nextElementSibling.id=input.id+'-help'; }
        shared.append(grid); form.append(shared);
        const button = node('button','儲存' + label + ' LINE 設定','button button-dark'); button.type='submit'; view.save=button;
        form.append(button); form.addEventListener('submit', event => void save(view,event));
        form.addEventListener('input', event => { view.dirty.add(event.target.name); status.textContent = '本區塊有尚未儲存的設定。'; lock(); });
        section.append(form);
      }
      section.append(status); notificationForms(view);webhookPanel(view);
      section.append(view.links, reload); container.append(section); views.set(feature,view); update(view);
    }
    renderNav();
  }
  async function load(force = false, source = null) {
    if (loading || saving || pendingOperation()) return;
    const session = window.MemberAdminSession?.get(); if (!session?.config.business) return;
    loading = true;
    try {
      const result = await request('platform.application.bootstrap');
      if (!result.tenant || result.tenant.slug !== session.config.business || result.application?.status !== 'approved' || (result.tenant.status === 'suspended' || result.tenant.expired)) throw Error('此商家的 LINE 設定權限尚未開放。');
      tenant = result.tenant; render();
      for (const view of views.values()) {
        if (force && view === source) view.dirty.clear();
        update(view, force && view === source);
      }
      if(source)source.status.textContent='已載入本區塊最新 LINE 設定，請確認後再儲存。';
    } catch (error) {
      let status=document.getElementById('businessLineLoadStatus');
      if(!status){status=node('p');status.id='businessLineLoadStatus';status.setAttribute('role','alert');document.getElementById('businessWorkspaceStatus')?.append(status);}
      status.textContent=error.message;
      if(source)source.status.textContent=error.message;
    } finally { loading=false; }
  }
  function apply(data) {
    const changed = JSON.stringify(grants) !== JSON.stringify(data.features);
    grants = {...data.features}; render();
    if (!tenant || changed) return load();
  }
  window.addEventListener('member-admin-ready', () => void load());
  window.BusinessLineSettings = Object.freeze({apply,select:selectFeature});
})();
