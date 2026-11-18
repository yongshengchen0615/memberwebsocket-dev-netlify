(() => {
  'use strict';
  const modules = {
    membership: ['members', '會員卡', 'member', 'memberLiffId'],
    points: ['cards', '集點卡', 'points', 'pointsLiffId'],
    events: ['events', '活動票券', 'event', 'eventLiffId'],
    calendar: ['calendar', '營運日曆', 'calendar', 'calendarLiffId'],
    booking: ['booking', '預約', 'booking', 'bookingLiffId'],
  };
  // Login identity belongs to the business; LIFF and notification routes belong to each feature.
  const businessLogin = {
    adminChannelId: '商家管理端 Login Channel ID',
    adminLiffId: '商家管理端 LIFF ID',
  };
  const featureGuides = {
    membership: '會員加入與會員卡入口：設定會員卡 LIFF；需要會員通知時再設定通知通道。',
    points: '集點與兌換入口：設定集點卡 LIFF；需要集點通知時再設定通知通道。',
    events: '活動與票券入口：設定活動票券 LIFF；需要票券通知時再設定通知通道。',
    calendar: '營運日曆入口：設定日曆 LIFF。目前沒有自動 LINE 推播事件，不必另外設定通知接收用途。',
    booking: '線上預約入口：設定預約 LIFF；預約管理員通知與會員通知可分開設定。',
  };
  let grants = {}, tenant = null, loading = false, saving = false, activeFeature = null, navSignature = '';
  let adapter = null, generation = 0, shared = null;
  const views = new Map();
  const revokedCodes=new Set(['AUTH_REQUIRED','AUTH_INVALID','TENANT_REAUTH_REQUIRED','TENANT_EXPIRED','TENANT_SUSPENDED','FEATURE_DISABLED','BUSINESS_FORBIDDEN','PLATFORM_APPLICATION_NOT_APPROVED','PLATFORM_APPLICATION_NOT_FOUND','PLATFORM_QUALIFICATION_REQUIRED','PLATFORM_QUALIFICATION_SUSPENDED']);
  const find = id => adapter?.root.querySelector('#' + id) || (!adapter ? document.getElementById(id) : null);
  const navNode = () => adapter ? adapter.root.querySelector('[data-line-feature-nav]') : find('businessLineFeatureNav');
  const contentNode = () => adapter ? adapter.root.querySelector('[data-line-feature-content]') : find('businessLineFeatureContent');
  const domId = id => (adapter ? 'merchant-' : '') + id;
  function discard(view) {
    for(const input of view.section.querySelectorAll('input'))input.value='';
    view.pending=null;view.dirty.clear();
    for(const route of view.routes?.values()||[]){route.pending=null;route.testPending=null;route.dirty=false;}
    view.section.remove();
  }
  function clear() {
    generation++;for(const view of views.values())discard(view);views.clear();
    if(shared){for(const input of shared.form.querySelectorAll('input'))input.value='';shared.section.remove();shared=null;}
    navNode()?.replaceChildren();tenant=null;grants={};activeFeature=null;navSignature='';saving=false;loading=false;adapter=null;
  }
  function revoke(error) {
    if(!revokedCodes.has(error.code))return false;
    const target=adapter?.root||find('businessWorkspaceStatus')||contentNode();clear();
    const alert=node('p',error.message||'LINE 設定權限已變更，請重新確認登入與商家權限。');alert.setAttribute('role','alert');target?.append(alert);return true;
  }
  function mount(options) {
    if(!options?.root || typeof options.request!=='function' || !options.data?.tenant)throw Error('LINE 設定缺少商家內容。');
    const next=options.data.tenant;
    if(adapter?.root!==options.root || tenant?.id!==next.id || tenant?.slug!==next.slug || Object.keys(grants).some(key=>grants[key]===true&&next.features?.[key]!==true))clear();
    adapter={...options,business:next.slug};grants={...next.features};tenant=next;
    if(next.status==='suspended'||next.expired){revoke({code:'BUSINESS_FORBIDDEN',message:'此商家的 LINE 設定權限尚未開放。'});return;}
    const created=render();for(const view of views.values())if(!created.has(view))update(view);lock();
  }
  const pendingOperation = () => [...views.values()].some(v => v.pending || [...(v.routes?.values() || [])].some(r => r.pending || r.testPending));
  function node(tag, text, className) {
    const result = document.createElement(tag); if (text) result.textContent = text;
    if (className) result.className = className; return result;
  }
  async function request(action, payload = {}) {
    const epoch=generation,currentAdapter=adapter;
    if(currentAdapter){
      try{const result=await currentAdapter.request(action,payload);if(epoch!==generation)throw {stale:true};return result;}
      catch(error){if(epoch!==generation)throw {stale:true};revoke(error);throw error;}
    }
    const session = window.MemberAdminSession?.get();
    if (!session) {const error=Object.assign(Error('登入狀態已失效，請重新登入。'),{code:'AUTH_REQUIRED'});revoke(error);throw error;}
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
    if(epoch!==generation)throw {stale:true};
    if (!response.ok || !body.ok) {const error=Object.assign(Error(body.error?.message || '無法取得 LINE 設定。'), {code:body.error?.code,uncertain:response.status>=500});revoke(error);throw error;}
    if(epoch!==generation)throw {stale:true};return body.data;
  }
  function lock() {
    for (const view of views.values()) {
      const blocked = saving || pendingOperation();
      for (const input of view.form?.querySelectorAll('input') || []) {
        input.disabled = blocked;
      }
      if (view.save) { view.save.disabled = saving || (blocked && !view.pending); view.save.textContent = view.pending ? '重試相同儲存操作' : '儲存' + view.label + '入口設定'; }
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
    if(shared){
      const configured=Boolean(tenant?.line?.adminChannelId && tenant?.line?.adminLiffId);
      for(const input of shared.form.querySelectorAll('input'))input.disabled=saving || pendingOperation();
      shared.save.disabled=saving || pendingOperation() || configured;
      shared.save.textContent=[...views.values()].some(view=>view.pending)?'重試相同儲存操作':'儲存首次共用登入與目前功能入口';
    }
  }
  function liffValue(value) {
    const text=value.trim();if(/^\d{5,30}-[A-Za-z0-9_-]+$/.test(text))return text;
    return /^https:\/\/liff\.line\.me\/(\d{5,30}-[A-Za-z0-9_-]+)$/.exec(text)?.[1]||null;
  }
  function normalizeEntry(view,input) {
    for(const [key,channel] of [[view.key,'memberChannelId']]){
      const liff=view.form.elements.namedItem(key),id=view.form.elements.namedItem(channel);
      if(!liff||!id)continue;
      const normalized=liffValue(liff.value);
      if(input===liff && normalized){liff.value=normalized;if(!view.dirty.has(channel)||!id.value){id.value=normalized.split('-')[0];view.derived.add(channel);}}
      id.setCustomValidity(normalized && id.value && !normalized.startsWith(id.value+'-')?'Login Channel 與 LIFF ID 不一致，請確認此入口所屬帳號。':'');
    }
  }
  function normalizeShared(input) {
    if(!shared)return;
    const liff=shared.form.elements.namedItem('adminLiffId');
    const channel=shared.form.elements.namedItem('adminChannelId');
    const normalized=liffValue(liff.value);
    if(input===liff && normalized){
      liff.value=normalized;
      if(!shared.dirty.has('adminChannelId') || !channel.value){
        channel.value=normalized.split('-')[0];
        shared.derived.add('adminChannelId');
      }
    }
    channel.setCustomValidity(normalized && channel.value && !normalized.startsWith(channel.value+'-')?'商家管理端 Login Channel 與 LIFF ID 不一致。':'');
  }
  function updateShared() {
    if(!shared || !tenant)return;
    for(const input of shared.form.querySelectorAll('input')){
      if(!shared.dirty.has(input.name) && !shared.derived.has(input.name))
        input.value=tenant.line?.[input.name] || '';
      input.required=!tenant.line?.[input.name];
      input.readOnly=Boolean(tenant.line?.[input.name]);
    }
    normalizeShared();
    shared.status.textContent=tenant.line?.adminChannelId && tenant.line?.adminLiffId
      ? '商家共用登入設定已儲存。資料保持顯示供核對；既有登入身分不可由功能頁修改。'
      : '尚未完成首次設定：請同時填寫下方所選功能的會員 Login Channel 與 LIFF 入口，再儲存。';
    lock();
  }
  function renderShared() {
    const container=contentNode();
    if(!container)return;
    if(!views.size){shared?.section.remove();shared=null;return;}
    if(!shared){
      const section=node('section','','business-line-settings business-line-shared');
      section.id=domId('businessLineSharedSection');
      section.dataset.businessLineShared='true';
      section.append(node('h2','商家共用登入設定（僅首次設定）'),
        node('p','此設定跨功能共用，已儲存資料會持續顯示供核對。管理端 Login 身分首次設定後不可任意更換。'));
      const form=node('form');
      form.id=domId('businessLineSharedForm');form.noValidate=true;
      addField(form,'adminLiffId','商家管理端 LIFF ID 或 LINE 入口網址');
      addField(form,'adminChannelId',businessLogin.adminChannelId);
      const status=node('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
      const save=node('button','儲存首次共用登入與目前功能入口','button button-dark');
      save.type='submit';form.append(save,status);section.append(form);
      shared={section,form,status,save,dirty:new Set(),derived:new Set()};
      form.addEventListener('input',event=>{
        shared.dirty.add(event.target.name);shared.derived.delete(event.target.name);
        normalizeShared(event.target);status.textContent='共用登入設定尚未儲存，請同時完成目前功能入口。';lock();
      });
      form.addEventListener('submit',event=>{
        const view=[...views.values()].find(item=>item.pending)||views.get(activeFeature)||views.values().next().value;
        if(view)void saveEntry(view,event);
      });
    }
    if(shared.section.parentElement!==container)container.prepend(shared.section);
    updateShared();
  }
  function validForm(form) {
    const invalid=[...form.querySelectorAll('input,select')].find(input=>!input.disabled&&!input.validity.valid);
    if(invalid){for(let p=invalid.parentElement;p&&p!==form;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;invalid.focus();form.reportValidity();return false;}
    return true;
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
        route.disabled.checked = saved?.mode === 'disabled';
        route.channel.value = saved?.mode === 'custom' ? (saved.channelId || '') :
          (tenant.moduleLine?.[view.feature]?.line?.messagingChannelId || tenant.line?.messagingChannelId || '');
        route.token.value = '';
      }
      route.fields.hidden = false; // Keep the configured Channel visible even when notifications are disabled.
      route.channel.required = route.token.required = !route.disabled.checked;
      route.summary.textContent = saved?.mode === 'disabled' ? '已停用：此用途不發送通知。'
        : saved?.mode === 'custom' ? '已驗證獨立 Channel ' + saved.channelId + '；Token 已加密保存。'
        : (tenant.moduleLine?.[view.feature]?.credentialsConfigured || tenant.credentialsConfigured) ? '原設定沿用本功能官方帳號。要更換通知帳號，請輸入 Channel ID 及完整 Token。' : '尚未設定通知官方帳號，請輸入 Channel ID 及完整 Token。';
    }
    if (view.form) for (const input of view.form.querySelectorAll('input')) {
      if (reset || (!view.dirty.has(input.name)&&!view.derived.has(input.name))) input.value = {...tenant.line,...tenant.moduleLine?.[view.feature]?.line}[input.name] || '';
      input.required = input.name !== 'messagingChannelId';
      input.disabled = false;
    }
    if(view.form)normalizeEntry(view);
    if(view.entryState){const current={...tenant.line,...tenant.moduleLine?.[view.feature]?.line};view.entryState.textContent=current[view.key]?'入口設定已儲存；實際 LINE 登入仍需驗收。':'尚未設定入口：先貼上此功能的 LIFF ID 或 LINE 入口網址。';}
    view.links.replaceChildren();
    if (!view.path) { view.links.textContent = '此管理功能不需要額外 LINE 用戶端入口。'; return; }
    const endpoint = new URL('/' + view.path + '/', location.origin);
    endpoint.searchParams.set('business', tenant.slug);
    const a = node('a', '開啟' + view.label + '用戶端', 'button button-outline');
    a.href = endpoint.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.dataset.featureClient = view.feature;
    const code = node('code', endpoint.href); code.dataset.featureEndpoint = view.feature;
    const copy = node('button', '複製用戶端連結', 'button button-outline'); copy.type = 'button';
    copy.onclick = async () => { try { await navigator.clipboard.writeText(endpoint.href); view.status.textContent = '已複製' + view.label + '用戶端連結。'; } catch { view.status.textContent = '請複製下方的完整網址。'; } };
    const actions = node('div', '', 'business-client-actions');
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', view.label + '用戶端快捷操作');
    actions.append(a, copy);
    const currentLine = {...tenant.line,...tenant.moduleLine?.[view.feature]?.line};
    const id = currentLine[view.key];
    if (id?.startsWith(currentLine.memberChannelId+'-') && /^\d{5,30}-[A-Za-z0-9_-]+$/.test(id || '')) {
      const liff = node('a', '開啟已儲存的 LINE 入口', 'button business-client-line-link');
      liff.href = 'https://liff.line.me/' + id;
      liff.target = '_blank'; liff.rel = 'noopener noreferrer'; actions.append(liff);
    }
    view.links.append(actions, node('p', 'LIFF Endpoint URL（含商家代碼）'), code);
  }
  async function saveEntry(view, event) {
    event.preventDefault();
    const epoch=generation;
    if (saving || (!view.pending && pendingOperation()) || !tenant || grants[view.feature] !== true || tenant.features?.[view.feature] !== true) return;
    if (!view.pending) {
      normalizeEntry(view);normalizeShared();
      if(shared && !validForm(shared.form))return;
      if(!validForm(view.form)){
        if(shared)shared.status.textContent='請先填寫目前功能的 LIFF ID 與會員 Login Channel，才能完成首次共用登入設定。';
        return;
      }
      const line = {...tenant.line,...tenant.moduleLine?.[view.feature]?.line};
      // Merge only this form's edited fields into the last server snapshot.
      // Other modules' unsaved drafts never enter this request.
      for (const input of view.form.querySelectorAll('input'))
        if (view.dirty.has(input.name) || view.derived.has(input.name) || !line[input.name]) line[input.name] = input.value.trim();
      for (const input of shared?.form.querySelectorAll('input') || [])
        if(shared.dirty.has(input.name) || shared.derived.has(input.name) || !line[input.name])line[input.name]=input.value.trim();
      // Preserve stored legacy module secrets; LINE entry only edits identity and LIFF.
      view.pending = {feature:view.feature, expectedVersion:tenant.version, requestId:crypto.randomUUID(), line,
        credentials:{channelAccessToken:'',channelSecret:''}};
    }
    saving = true; lock(); view.status.textContent = '正在儲存' + view.label + ' LINE 設定…';
    try {
      const result = await request('platform.line.save', view.pending);
      tenant = result.tenant; view.pending = null; view.dirty.clear();view.derived.clear();
      if(shared){shared.dirty.clear();shared.derived.clear();}
      adapter?.onUpdate?.(tenant);
      for (const v of views.values()) update(v, v === view);
      updateShared();
      view.status.textContent = view.label + ' LINE 設定已儲存，其他功能的 Channel、LIFF 與憑證均維持原設定。';
    } catch (error) {
      if(epoch!==generation)return;
      view.status.textContent = error.message;
      if(shared)shared.status.textContent=error.message;
      if (!error.uncertain) view.pending = null;
      if (['FEATURE_DISABLED','TENANT_SUSPENDED','PLATFORM_APPLICATION_NOT_APPROVED','BUSINESS_FORBIDDEN','AUTH_INVALID','TENANT_EXPIRED','TENANT_REAUTH_REQUIRED'].includes(error.code)) {
        clear();
      }
      if (error.code === 'PLATFORM_CONFLICT') view.status.textContent += ' 請先載入最新設定，再確認本區塊內容後儲存。';
    } finally { if(epoch===generation){saving = false; lock();} }
  }
  async function saveNotification(view, route, event) {
    event.preventDefault();
    const epoch=generation;
    if (saving || (!route.pending && pendingOperation()) || !tenant || grants[view.feature] !== true) return;
    if (!route.pending) {
      if (!validForm(route.form)) return;
      route.pending = {feature:view.feature,purpose:route.purpose,mode:route.disabled.checked?'disabled':'custom',expectedVersion:tenant.version,
        requestId:crypto.randomUUID(),messagingChannelId:route.disabled.checked?'':route.channel.value.trim(),
        channelAccessToken:route.disabled.checked?'':route.token.value.trim()};
    }
    saving = true; lock(); route.status.textContent = '正在驗證並儲存通知設定…';
    try {
      const result = await request('platform.notifications.save',route.pending);
      tenant = result.tenant; route.pending = null; route.dirty = false; route.token.value = '';adapter?.onUpdate?.(tenant);
      for (const v of views.values()) update(v);
      route.status.textContent = '通知設定已儲存。';
    } catch (error) {
      if(epoch!==generation)return;
      route.status.textContent = error.message;
      if (!error.uncertain) route.pending = null;
      if (error.code === 'PLATFORM_CONFLICT') route.status.textContent += ' 請載入最新設定後重試。';
      if (['FEATURE_DISABLED','TENANT_SUSPENDED','BUSINESS_FORBIDDEN','AUTH_INVALID','TENANT_EXPIRED','TENANT_REAUTH_REQUIRED'].includes(error.code)) {
        clear();
      }
    } finally { if(epoch===generation){saving = false; lock();} }
  }
  async function testNotification(view,route) {
    const epoch=generation;
    if (saving || (!route.testPending && pendingOperation()) || !tenant || grants[view.feature] !== true || route.dirty) return;
    route.testPending ||= {feature:view.feature,purpose:route.purpose,expectedVersion:tenant.version,requestId:crypto.randomUUID()};
    saving=true;lock();route.status.textContent='正在傳送測試通知給目前登入的管理員…';
    try {
      await request('platform.notifications.test',route.testPending);route.testPending=null;
      route.status.textContent='LINE 已接受測試通知，請確認目前帳號已加入該官方帳號好友。';
    } catch(error) {if(epoch!==generation)return;route.status.textContent=error.message;if(!error.uncertain)route.testPending=null;}
    finally{if(epoch===generation){saving=false;lock();}}
  }
  function notificationForms(view) {
    view.routes = new Map();
    if (!view.path) return;
    if (view.feature === 'calendar') return; // There is no calendar push event yet.
    const details = node('details'); details.open=true;details.append(node('summary','本功能通知接收用途（需要時設定）'));
    const purposeHelp = {membership:'會員加入與權益',points:'集點與兌換',events:'活動與票券',booking:'預約狀態'}[view.feature];
    details.append(node('p',purposeHelp + '通知請直接輸入 LINE 官方帳號 Messaging API Channel ID 與完整 Channel access token。官方帳號與登入 Channel 須屬於相同 LINE Provider；預約管理通知僅送給商家已授權管理員。'));
    for (const purpose of view.feature === 'booking' ? ['admin','member'] : ['member']) {
      const form = node('form'); form.noValidate=true;form.id = domId('notification-' + view.feature + '-' + purpose);
      form.append(node('h3',purpose === 'admin' ? '管理員接收通知' : '會員接收通知'));
      const disabledLabel=node('label');disabledLabel.className='business-notification-toggle';const disabled=node('input');disabled.type='checkbox';disabled.name='notificationDisabled';
      disabledLabel.append(disabled,node('span','停用此用途通知'));form.append(disabledLabel);
      const fields=node('div','','business-line-fields');fields.id=form.id+'-fields';
      const channel=addField(fields,'messagingChannelId','LINE 官方帳號 Messaging API Channel ID');
      const token=addField(fields,'channelAccessToken','LINE 官方帳號 Channel access token（long-lived）',true);
      token.nextElementSibling.textContent='Messaging API → Channel access token (long-lived)。已儲存 Token 不會回填；新增、啟用或更換帳號時請輸入完整 Token。';
      form.append(fields);
      const summary=node('p'),status=node('p'); status.setAttribute('role','status');status.setAttribute('aria-live','polite');
      const save=node('button','驗證並儲存通知設定','button button-outline');save.type='submit';
      const test=node('button','傳送測試給我','button button-outline');test.type='button';
      const route={purpose,form,disabled,channel,token,fields,summary,status,save,test,dirty:false,pending:null,testPending:null};
      test.onclick=()=>void testNotification(view,route);
      form.append(summary,save,test,status);form.addEventListener('submit',event=>void saveNotification(view,route,event));
      form.addEventListener('input',()=>{route.dirty=true;
        channel.required=token.required=!disabled.checked;
        if(disabled.checked)token.value='';
        status.textContent='本用途有尚未儲存的設定。';lock();});
      view.routes.set(purpose,route);details.append(form);
    }
    view.section.append(details);
  }
  function selectFeature(feature) {
    activeFeature = views.has(feature) ? feature : views.keys().next().value || null;
    for (const [name, view] of views) {
      const selected = name === activeFeature;
      view.section.hidden = !selected;
      const button = find(domId('businessLineFeatureTab-' + name));
      if (button) {button.setAttribute('aria-selected',String(selected));button.tabIndex = selected ? 0 : -1;}
    }
    adapter?.onSelect?.(activeFeature);
  }
  function renderNav() {
    const nav = navNode();
    if (!nav) return;
    const signature = [...views.keys()].join('|');
    if (signature !== navSignature) {
      navSignature = signature;
      nav.replaceChildren();
      for (const [feature, view] of views) {
        const button = node('button',view.label);
        button.id=domId('businessLineFeatureTab-'+feature);button.type='button';button.setAttribute('role','tab');
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
    const panel=node('details');panel.open=true;panel.dataset.lineWebhook=view.feature;
    panel.append(node('summary','Webhook 連線診斷'));
    panel.append(node('p','僅使用 LIFF 入口時可略過。需要接收事件時，先儲存 Messaging API 設定，再檢查連線。設定 Webhook URL 前，請確認該 Channel 的現有回呼用途。'));
    const refresh=node('button','讀取 Webhook 狀態','button button-outline'),check=node('button','檢查 LINE 連線','button button-outline'),copy=node('button','複製 Webhook URL','button button-outline');
    for(const button of [refresh,check,copy])button.type='button';copy.disabled=true;
    const label=node('label','已確認的接收網址'),endpoint=node('input');endpoint.type='url';endpoint.readOnly=true;
    endpoint.id=domId('lineWebhookEndpoint-'+view.feature);label.htmlFor=endpoint.id;label.append(endpoint);
    const status=node('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const run=async(action)=>{
      const epoch=generation;
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
        if(epoch!==generation)return;
        endpoint.value='';status.textContent=error.message;
        if(['FEATURE_DISABLED','TENANT_SUSPENDED','BUSINESS_FORBIDDEN','AUTH_INVALID','TENANT_EXPIRED','TENANT_REAUTH_REQUIRED','PLATFORM_QUALIFICATION_REQUIRED','PLATFORM_QUALIFICATION_SUSPENDED','PLATFORM_APPLICATION_NOT_FOUND'].includes(error.code)){
          clear();
        }
      }finally{if(epoch===generation){saving=false;lock();}}
    };
    refresh.onclick=()=>void run('platform.webhook.status');check.onclick=()=>void run('platform.webhook.check');
    copy.onclick=async()=>{try{await navigator.clipboard.writeText(endpoint.value);status.textContent='Webhook URL 已複製；請先確認 Channel 現有回呼用途，再由授權人員設定。';}catch{endpoint.focus();endpoint.select();status.textContent='請複製上方已選取的 Webhook URL。';}};
    panel.append(refresh,check,label,copy,status);view.webhook={refresh,check,copy,endpoint,status};view.section.append(panel);
  }
  function render() {
    const created=new Set(),container = contentNode();
    if (!container) return created;
    for (const [feature, [panelName, label, path, key]] of Object.entries(modules)) {
      const allowed = grants[feature] === true && tenant?.features?.[feature] === true;
      if (!allowed || !path) { if(views.has(feature))discard(views.get(feature)); views.delete(feature); continue; }
      if (views.has(feature)) continue;
      const section = node('section', '', 'business-line-settings'); section.dataset.businessLineFeature = feature;
      section.id=domId('businessLineSection-'+feature);section.setAttribute('role','tabpanel');section.setAttribute('aria-labelledby',domId('businessLineFeatureTab-'+feature));
      section.append(node('h2', label + '｜LINE 設定'));
      section.append(node('p', featureGuides[feature]));
      const status = node('p'); status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
      const view = {feature, label, path, key, section, status, dirty:new Set(),derived:new Set(), links:node('div','','business-client-links')};
      const reload = node('button','載入最新 LINE 設定','button button-outline'); reload.type = 'button'; view.reload = reload;
      reload.onclick = () => void load(true, view);
      if (path) {
        const form = node('form'); form.noValidate=true;form.id = domId('businessLine-' + feature); view.form = form;
        const entryState=node('p','','business-line-summary');view.entryState=entryState;form.append(entryState);
        addField(form, key, '1. 貼上' + label + ' LIFF ID 或 LINE 入口網址');
        addField(form,'memberChannelId',label+'會員 Login Channel ID');
        const button = node('button','儲存' + label + '入口設定','button button-dark'); button.type='submit'; view.save=button;
        form.append(button); form.addEventListener('submit', event => void saveEntry(view,event));
        form.addEventListener('input', event => { view.dirty.add(event.target.name);view.derived.delete(event.target.name);normalizeEntry(view,event.target);status.textContent = '本區塊有尚未儲存的設定。'; lock(); });
        section.append(form);
      }
      section.append(status); notificationForms(view);webhookPanel(view);
      section.append(view.links, reload); container.append(section); views.set(feature,view);created.add(view);update(view);
      if(feature==='booking')window.FrontdeskSettings?.mount({root:section,request,business:tenant.slug});
    }
    renderShared();renderNav();
    return created;
  }
  async function load(force = false, source = null) {
    if (loading || saving || pendingOperation()) return;
    const epoch=generation,business=adapter?.business||window.MemberAdminSession?.get()?.config.business;if(!business)return;
    loading = true;
    try {
      const result = await request('platform.application.bootstrap');
      if (!result.tenant || result.tenant.slug !== business || result.application?.status !== 'approved' || (result.tenant.status === 'suspended' || result.tenant.expired)) throw Object.assign(Error('此商家的 LINE 設定權限尚未開放。'),{code:'BUSINESS_FORBIDDEN'});
      tenant = result.tenant; const created=render();
      updateShared();
      for (const view of views.values()) {
        if (force && view === source) {view.dirty.clear();view.derived.clear();}
        if(!created.has(view)||force&&view===source)update(view, force && view === source);
      }
      if(source)source.status.textContent='已載入本區塊最新 LINE 設定，請確認後再儲存。';
    } catch (error) {
      if(epoch!==generation)return;
      if(revoke(error))return;
      let status=find('businessLineLoadStatus');
      if(!status){status=node('p');status.id='businessLineLoadStatus';status.setAttribute('role','alert');document.getElementById('businessWorkspaceStatus')?.append(status);}
      status.textContent=error.message;
      if(source)source.status.textContent=error.message;
    } finally { if(epoch===generation)loading=false; }
  }
  function apply(data) {
    if(tenant&&(data.business?.slug&&data.business.slug!==tenant.slug || Object.keys(grants).some(key=>grants[key]===true&&data.features?.[key]!==true)))clear();
    const changed = JSON.stringify(grants) !== JSON.stringify(data.features);
    grants = {...data.features}; render();
    if (!tenant || changed) return load();
  }
  window.addEventListener('member-admin-ready', () => void load());
  window.BusinessLineSettings = Object.freeze({apply,select:selectFeature,mount,clear});
})();
