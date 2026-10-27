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
  let adapter = null, generation = 0;
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
        const sharedIdentity = Object.hasOwn(businessLogin, input.name);
        input.disabled = blocked || (sharedIdentity && Boolean(view.identityBlock?.hidden));
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
  }
  function liffValue(value) {
    const text=value.trim();if(/^\d{5,30}-[A-Za-z0-9_-]+$/.test(text))return text;
    return /^https:\/\/liff\.line\.me\/(\d{5,30}-[A-Za-z0-9_-]+)$/.exec(text)?.[1]||null;
  }
  function normalizeEntry(view,input) {
    for(const [key,channel] of [[view.key,'memberChannelId'],['adminLiffId','adminChannelId']]){
      const liff=view.form.elements.namedItem(key),id=view.form.elements.namedItem(channel);
      if(!liff||!id)continue;
      const normalized=liffValue(liff.value);
      if(input===liff && normalized){liff.value=normalized;if(!view.dirty.has(channel)||!id.value){id.value=normalized.split('-')[0];view.derived.add(channel);}}
      id.setCustomValidity(normalized && id.value && !normalized.startsWith(id.value+'-')?'Login Channel 與 LIFF ID 不一致，請確認此入口所屬帳號。':'');
    }
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
      if (reset || (!view.dirty.has(input.name)&&!view.derived.has(input.name))) input.value = secret ? '' : {...tenant.line,...tenant.moduleLine?.[view.feature]?.line}[input.name] || '';
      input.required = !secret && input.name !== 'messagingChannelId'
        && !(sharedIdentity && view.identityBlock?.hidden);
      input.disabled = sharedIdentity && Boolean(view.identityBlock?.hidden);
      if(['adminChannelId','adminLiffId'].includes(input.name))input.readOnly=Boolean(tenant.line?.[input.name]);
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
    view.links.append(a, copy, node('p', 'LIFF Endpoint URL（含商家代碼）'), code);
    const id = {...tenant.line,...tenant.moduleLine?.[view.feature]?.line}[view.key];
    if (id?.startsWith({...tenant.line,...tenant.moduleLine?.[view.feature]?.line}.memberChannelId+'-') && /^\d{5,30}-[A-Za-z0-9_-]+$/.test(id || '')) {
      const liff = node('a', '開啟已儲存的 LINE 入口'); liff.href = 'https://liff.line.me/' + id;
      liff.target = '_blank'; liff.rel = 'noopener noreferrer'; view.links.append(liff);
    }
  }
  async function save(view, event) {
    event.preventDefault();
    const epoch=generation;
    if (saving || (!view.pending && pendingOperation()) || !tenant || grants[view.feature] !== true || tenant.features?.[view.feature] !== true) return;
    if (!view.pending) {
      normalizeEntry(view);if (!validForm(view.form)) return;
      const line = {...tenant.line,...tenant.moduleLine?.[view.feature]?.line};
      // Merge only this form's edited fields into the last server snapshot.
      // Other modules' unsaved drafts never enter this request.
      for (const input of view.form.querySelectorAll('input')) if (!['channelAccessToken','channelSecret'].includes(input.name)
        && (view.dirty.has(input.name) || view.derived.has(input.name) || !line[input.name])) line[input.name] = input.value.trim();
      view.pending = {feature:view.feature, expectedVersion:tenant.version, requestId:crypto.randomUUID(), line,
        credentials:{channelAccessToken:view.form.elements.channelAccessToken.value.trim(),channelSecret:view.form.elements.channelSecret.value.trim()}};
    }
    saving = true; lock(); view.status.textContent = '正在儲存' + view.label + ' LINE 設定…';
    try {
      const result = await request('platform.line.save', view.pending);
      tenant = result.tenant; view.pending = null; view.dirty.clear();view.derived.clear();adapter?.onUpdate?.(tenant);
      for (const v of views.values()) update(v, v === view);
      view.status.textContent = view.label + ' LINE 設定已儲存，其他功能的 Channel、LIFF 與憑證均維持原設定。';
    } catch (error) {
      if(epoch!==generation)return;
      view.status.textContent = error.message;
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
      route.pending = {feature:view.feature,purpose:route.purpose,mode:route.mode.value,expectedVersion:tenant.version,
        requestId:crypto.randomUUID(),messagingChannelId:route.channel.value.trim(),channelAccessToken:route.token.value.trim()};
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
    const details = node('details'); details.append(node('summary','本功能通知接收用途（需要時設定）'));
    const purposeHelp = {membership:'會員加入與權益',points:'集點與兌換',events:'活動與票券',booking:'預約狀態'}[view.feature];
    details.append(node('p',purposeHelp + '通知可共用本功能憑證，或另設專用 Messaging API Channel。兩種 Channel 須屬於相同 LINE Provider；預約管理通知僅送給商家已授權管理員。'));
    for (const purpose of view.feature === 'booking' ? ['admin','member'] : ['member']) {
      const form = node('form'); form.noValidate=true;form.id = domId('notification-' + view.feature + '-' + purpose);
      form.append(node('h3',purpose === 'admin' ? '管理員接收通知' : '會員接收通知'));
      const label=node('label','通知通道'),mode=node('select'); mode.name='mode';
      for (const [value,text] of [['inherit','使用此功能的官方帳號'],['custom','使用其他官方帳號（進階）'],['disabled','不發送此用途通知']]) {const o=node('option',text);o.value=value;mode.append(o);}
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
    const panel=node('details');panel.dataset.lineWebhook=view.feature;
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
        const account=node('details');account.id=form.id+'-account-details';account.append(node('summary','登入帳號細節（自動帶入）'));
        addField(account,'memberChannelId',label+'會員 Login Channel ID');form.append(account);
        const identity = node('div','','business-line-identity'); identity.id = domId('businessLineIdentity-' + feature);
        const identityFields = node('div','','business-line-fields');
        addField(identityFields,'adminLiffId','商家管理端 LIFF ID（僅首次）');
        const adminDetails=node('details');adminDetails.append(node('summary','管理端登入帳號細節（自動帶入）'));addField(adminDetails,'adminChannelId',businessLogin.adminChannelId);identityFields.append(adminDetails);
        for (const input of identityFields.querySelectorAll('input')) { input.id = form.id + '-' + input.name; input.setAttribute('aria-describedby',input.id+'-help'); input.nextElementSibling.id=input.id+'-help'; }
        identity.append(node('h3','商家共用登入設定（僅首次設定）'),node('p','商家管理端 LINE Login 身分跨功能共用；會員端 Login Channel 與 LIFF 則依功能獨立設定。'),identityFields);
        form.append(identity); view.identityBlock = identity;
        const shared = node('details'); shared.open = false;
        shared.append(node('summary','2. 通知帳號憑證（需要通知或 Webhook 時設定）'));
        shared.append(node('p','有效的 Login Channel 與 LIFF 即可啟用本功能入口；不發送通知時，本區可全部留空。需要通知時請同時設定 Messaging API Channel、Token 與 Secret，再驗證通知通道。已設定的憑證留空即保留；更換 Channel 時必須同時更新憑證。'));
        const grid = node('div','','business-line-fields');
        for (const [name,text] of Object.entries(moduleMessaging)) addField(grid,name,text,['channelAccessToken','channelSecret'].includes(name));
        for (const input of grid.querySelectorAll('input')) { input.id = form.id + '-' + input.name; input.setAttribute('aria-describedby',input.id+'-help'); input.nextElementSibling.id=input.id+'-help'; }
        shared.append(grid); form.append(shared);
        const button = node('button','儲存' + label + '入口設定','button button-dark'); button.type='submit'; view.save=button;
        form.append(button); form.addEventListener('submit', event => void save(view,event));
        form.addEventListener('input', event => { view.dirty.add(event.target.name);view.derived.delete(event.target.name);normalizeEntry(view,event.target);status.textContent = '本區塊有尚未儲存的設定。'; lock(); });
        section.append(form);
      }
      section.append(status); notificationForms(view);webhookPanel(view);
      section.append(view.links, reload); container.append(section); views.set(feature,view);created.add(view);update(view);
    }
    renderNav();
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
