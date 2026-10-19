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
  const common = {
    adminChannelId: '管理端 Login Channel ID', memberChannelId: '會員端 Login Channel ID',
    messagingChannelId: 'Messaging API Channel ID', adminLiffId: '管理端 LIFF ID',
    channelAccessToken: 'Channel access token', channelSecret: 'Channel secret',
  };
  let grants = {}, tenant = null, loading = false, saving = false;
  const views = new Map();
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
      const blocked = saving || Boolean([...views.values()].find(v => v.pending));
      for (const input of view.form?.querySelectorAll('input') || []) input.disabled = blocked;
      if (view.save) { view.save.disabled = saving || (blocked && !view.pending); view.save.textContent = view.pending ? '重試相同儲存操作' : '儲存' + view.label + ' LINE 設定'; }
      view.reload.disabled = blocked;
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
    if (view.form) for (const input of view.form.querySelectorAll('input')) {
      const secret = ['channelAccessToken','channelSecret'].includes(input.name);
      if (reset || !view.dirty.has(input.name)) input.value = secret ? '' : (tenant.moduleLine?.[view.feature]?.line || tenant.line)?.[input.name] || '';
      input.required = !secret || !(tenant.moduleLine?.[view.feature]?.credentialsConfigured || tenant.credentialsConfigured);
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
    const id = (tenant.moduleLine?.[view.feature]?.line || tenant.line)?.[view.key];
    if ((tenant.moduleLine?.[view.feature]?.credentialsConfigured || tenant.onboarding?.configurationComplete) && /^\d{5,30}-[A-Za-z0-9_-]+$/.test(id || '')) {
      const liff = node('a', '開啟已儲存的 LINE 入口'); liff.href = 'https://liff.line.me/' + id;
      liff.target = '_blank'; liff.rel = 'noopener noreferrer'; view.links.append(liff);
    }
  }
  async function save(view, event) {
    event.preventDefault();
    if (saving || !tenant || grants[view.feature] !== true || tenant.features?.[view.feature] !== true) return;
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
  function render() {
    for (const [feature, [panelName, label, path, key]] of Object.entries(modules)) {
      const panel = document.getElementById(panelName + 'Panel');
      const allowed = grants[feature] === true && tenant?.features?.[feature] === true;
      if (!allowed) { views.get(feature)?.section.remove(); views.delete(feature); continue; }
      if (!panel || views.has(feature)) continue;
      const section = node('section', '', 'business-line-settings'); section.dataset.businessLineFeature = feature;
      section.append(node('h2', label + '｜LINE 設定與用戶端連結'));
      const status = node('p'); status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
      const view = {feature, label, path, key, section, status, dirty:new Set(), links:node('div','','business-client-links')};
      const reload = node('button','載入最新 LINE 設定','button button-outline'); reload.type = 'button'; view.reload = reload;
      reload.onclick = () => void load(true, view);
      if (path) {
        const form = node('form'); form.id = 'businessLine-' + feature; view.form = form;
        addField(form, key, label + ' LIFF ID');
        const shared = node('details'); shared.open = !(tenant.moduleLine?.[feature]?.credentialsConfigured || tenant.credentialsConfigured);
        shared.append(node('summary','此功能的 Channel 與通知憑證'));
        shared.append(node('p','此功能的用戶端 Channel、LIFF 與通知憑證獨立保存，不影響其他功能。管理員登入沿用商家已設定的 Channel；Login 與 Messaging API Channel 請建在同一個 LINE Provider。'));
        const grid = node('div','','business-line-fields');
        for (const [name,text] of Object.entries(common)) addField(grid,name,text,['channelAccessToken','channelSecret'].includes(name));
        // Give each field a unique accessible ID without introducing nested forms.
        for (const input of grid.querySelectorAll('input')) { input.id = form.id + '-' + input.name; input.setAttribute('aria-describedby',input.id+'-help'); input.nextElementSibling.id=input.id+'-help'; }
        shared.append(grid); form.append(shared);
        const button = node('button','儲存' + label + ' LINE 設定','button button-dark'); button.type='submit'; view.save=button;
        form.append(button); form.addEventListener('submit', event => void save(view,event));
        form.addEventListener('input', event => { view.dirty.add(event.target.name); status.textContent = '本區塊有尚未儲存的設定。'; });
        section.append(form);
      }
      section.append(view.links, reload, status); panel.prepend(section); views.set(feature,view); update(view);
    }
  }
  async function load(force = false, source = null) {
    if (loading || saving || [...views.values()].some(v=>v.pending)) return;
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
  window.BusinessLineSettings = Object.freeze({apply});
})();
