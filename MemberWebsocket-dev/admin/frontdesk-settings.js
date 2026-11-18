(() => {
  'use strict';
  const mounted = new WeakSet();
  const node = (tag, text, className) => {
    const result = document.createElement(tag);
    if (text) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  const link = (label, url) => {
    const element = node('a', label);
    element.href = url;
    element.target = '_blank';
    element.rel = 'noopener noreferrer';
    return element;
  };
  const developersUrl = 'https://developers.line.biz/console/';
  const managerUrl = 'https://manager.line.biz/';
  function mount({ root, request, business }) {
    if (mounted.has(root)) return;
    mounted.add(root);
    const details = node('details', '', 'frontdesk-settings');
    details.dataset.frontdeskSettings = 'true';
    details.append(node('summary', '櫃檯官方帳號與人員權限'));
    const status = node('p');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const content = node('div', '', 'frontdesk-settings-content');
    const reload = node('button', '重新載入櫃檯設定與申請名單', 'button button-outline');
    reload.type = 'button';
    details.append(status, reload, content);
    root.append(details);
    let data = null, busy = false, pending = null;
    const alive = () => details.isConnected;
    function lock() {
      for (const control of details.querySelectorAll('input,select,button')) control.disabled = busy || Boolean(pending);
      const retry = details.querySelector('[data-frontdesk-retry]');
      if (!busy && pending && retry) retry.disabled = false;
    }
    async function save(action, payload, button) {
      if (busy || (pending && pending.action !== action)) return;
      const body = pending?.body || { ...payload, requestId: crypto.randomUUID() };
      pending = { action, body };
      busy = true;
      button.dataset.frontdeskRetry = 'true';
      lock();
      status.textContent = '正在確認並儲存櫃檯設定…';
      try {
        const result = await request(action, body);
        if (!alive()) return;
        pending = null;
        data = result;
        render();
        status.textContent = '櫃檯設定與人員權限已儲存。';
      } catch (error) {
        if (!alive()) return;
        if (!error.uncertain) pending = null;
        else button.textContent = '重試相同儲存操作';
        status.textContent = error.message || '儲存失敗，請確認設定。';
      } finally {
        busy = false;
        if (alive()) lock();
      }
    }
    function field(name, label, help, value = '', required = true) {
      const wrap = node('label', label);
      const input = node('input');
      input.name = name;
      input.type = name === 'channelAccessToken' ? 'password' : 'text';
      input.autocomplete = name === 'channelAccessToken' ? 'new-password' : 'off';
      input.spellcheck = false;
      input.maxLength = name === 'channelAccessToken' ? 4000 : 120;
      input.value = value;
      input.required = required;
      input.id = 'frontdesk-' + name;
      input.pattern = name === 'liffId' ? '[0-9]{5,30}-[A-Za-z0-9_-]+' :
        name.endsWith('ChannelId') ? '[0-9]{5,30}' : '.*';
      const guidance = node('small', help);
      guidance.id = input.id + '-help';
      input.setAttribute('aria-describedby', guidance.id);
      wrap.append(input, guidance);
      return { wrap, input };
    }
    function render() {
      content.replaceChildren();
      const cfg = data.frontdesk || {};
      const hasSettings = Boolean(cfg.liffId && cfg.messagingChannelId);
      const guide = node('section', '', 'frontdesk-setup-guide');
      guide.append(node('h3', '櫃檯開通流程'));
      const steps = node('ol');
      for (const line of [
        '管理員設定櫃檯 LINE 登入入口與通知官方帳號。',
        '櫃檯人員開啟專屬 frontdesk 頁面，用 LINE 登入並申請資格。',
        '商家管理員逐人審核；只有核准人員可接收通知或依權限審核預約。'
      ]) steps.append(node('li', line));
      guide.append(steps);
      content.append(guide);

      const form = node('form', '', 'frontdesk-config-form');
      const login = node('fieldset', '', 'frontdesk-setup-card');
      login.append(node('legend', '1. 設定櫃檯 LINE 登入入口'));
      login.append(node('p', '在 LINE Developers 的同一個 Provider 中選擇 LINE Login Channel，新增 LIFF App。可以直接貼上完整 LIFF 網址，系統會自動辨識 ID。'));
      const entry = node('div', '', 'business-line-fields');
      const liff = field('liffId', 'LIFF ID 或 LIFF 入口網址', 'LINE Developers → LINE Login Channel → LIFF → LIFF ID。', cfg.liffId || '');
      const channel = field('loginChannelId', 'LINE Login Channel ID', 'LINE Developers → LINE Login Channel → Basic settings → Channel ID。貼入 LIFF 後可自動帶入。', cfg.loginChannelId || '');
      if (cfg.liffId) {
        liff.input.readOnly = true;
        channel.input.readOnly = true;
      }
      const normalizeLiff = () => {
        const raw = liff.input.value.trim();
        const match = /^(?:https:\/\/liff\.line\.me\/)?(\d{5,30}-[A-Za-z0-9_-]+)\/?$/.exec(raw);
        if (match) {
          liff.input.value = match[1];
          if (!channel.input.value.trim()) channel.input.value = match[1].split('-')[0];
        }
        channel.input.setCustomValidity(
          liff.input.value && channel.input.value && !liff.input.value.startsWith(channel.input.value + '-')
            ? 'LINE Login Channel ID 與 LIFF ID 不一致。' : ''
        );
      };
      liff.input.addEventListener('change', normalizeLiff);
      channel.input.addEventListener('input', normalizeLiff);
      entry.append(liff.wrap, channel.wrap);
      login.append(entry);
      const dev = node('p');
      dev.append(link('開啟 LINE Developers 取得登入參數', developersUrl));
      login.append(dev);
      const endpoint = location.origin + '/frontdesk/?business=' + encodeURIComponent(business);
      login.append(node('p', 'LIFF Endpoint URL（貼到 LINE Developers → LIFF → Endpoint URL）'));
      const code = node('code', endpoint, 'frontdesk-endpoint');
      const copy = node('button', '複製 Endpoint URL', 'button button-outline');
      copy.type = 'button';
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(endpoint);
          status.textContent = '已複製 LIFF Endpoint URL。';
        } catch {
          status.textContent = '請手動複製上方的 Endpoint URL。';
        }
      };
      login.append(code, copy);
      form.append(login);

      const notifications = node('fieldset', '', 'frontdesk-setup-card frontdesk-notification-card');
      notifications.append(node('legend', '2. 櫃檯接收 LINE 預約通知'));
      const summary = node('p', cfg.enabled === false ? '已停用：此櫃檯入口不開放申請及推播通知。'
        : hasSettings ? '已驗證獨立 Channel ' + cfg.messagingChannelId + '；Token 已加密保存。'
        : '尚未設定櫃檯官方帳號；完成驗證後才能讓人員申請。', 'business-line-summary');
      notifications.append(summary);
      const disableLabel = node('label', '', 'business-notification-toggle frontdesk-notification-toggle');
      const disabled = node('input');
      disabled.type = 'checkbox';
      disabled.name = 'notificationDisabled';
      disabled.checked = cfg.enabled === false;
      disableLabel.append(disabled, node('span', '停用櫃檯入口及通知（停止人員申請與使用）'));
      notifications.append(disableLabel);
      const noticeFields = node('div', '', 'business-line-fields');
      const messaging = field('messagingChannelId', 'LINE 官方帳號 Messaging API Channel ID',
        'LINE Official Account Manager → 設定 → Messaging API；也可在 LINE Developers → Messaging API Channel → Basic settings 查看。',
        cfg.messagingChannelId || '');
      const token = field('channelAccessToken', 'Channel access token（long-lived）',
        'LINE Developers → Messaging API Channel → Messaging API → Channel access token。安全儲存不回顯；啟用設定時須重新貼入完整 Token。',
        '', cfg.enabled !== false);
      noticeFields.append(messaging.wrap, token.wrap);
      notifications.append(noticeFields);
      const noticeLinks = node('p');
      noticeLinks.append(link('開啟 LINE Official Account Manager', managerUrl), node('span', '　｜　'), link('開啟 LINE Developers', developersUrl));
      notifications.append(noticeLinks);
      notifications.append(node('small', '櫃檯 LINE Login 與通知 Messaging API 必須屬於同一 Provider；系統驗證 Channel 後才會儲存。櫃檯通知只發送給已核准且加入官方帳號的人員。'));
      const saveButton = node('button', '驗證並儲存櫃檯設定', 'button button-outline frontdesk-primary');
      saveButton.type = 'submit';
      form.append(notifications, saveButton);
      function toggleFields() {
        token.input.required = !disabled.checked;
        messaging.input.required = !disabled.checked;
        if (disabled.checked) token.input.value = '';
      }
      disabled.addEventListener('change', toggleFields);
      toggleFields();
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (pending) {
          if (pending.action === 'platform.frontdesk.settings.save') void save(pending.action, pending.body, saveButton);
          return;
        }
        normalizeLiff();
        if (!form.reportValidity()) return;
        void save('platform.frontdesk.settings.save', {
          expectedVersion: data.version,
          settings: {
            loginChannelId: channel.input.value.trim(),
            liffId: liff.input.value.trim(),
            messagingChannelId: messaging.input.value.trim(),
            enabled: !disabled.checked
          },
          channelAccessToken: token.input.value.trim()
        }, saveButton);
      });
      content.append(form);

      const links = node('div', '', 'frontdesk-quick-links');
      if (cfg.liffId) links.append(link('開啟櫃檯 LINE 入口', 'https://liff.line.me/' + cfg.liffId + '?business=' + encodeURIComponent(business)));
      links.append(link('開啟櫃檯專屬申請頁', endpoint));
      if (cfg.oaId) links.append(link('加入櫃檯官方帳號 ' + cfg.oaId, 'https://line.me/R/ti/p/' + encodeURIComponent(cfg.oaId)));
      content.append(links);

      const approvals = node('section', '', 'frontdesk-approvals');
      approvals.append(node('h3', '3. 審核櫃檯人員與逐人授權'));
      approvals.append(node('p', '人員無法從此處自行新增：必須先開啟自己的 frontdesk 頁面，使用 LINE 登入並提出申請。核准前不能收通知、查看預約或執行操作。'));
      const people = [...(data.staff || [])].sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0));
      const waiting = people.filter(person => person.status === 'pending').length;
      approvals.append(node('p', '待審核 ' + waiting + ' 人｜已記錄申請 ' + people.length + ' 人', 'business-line-summary'));
      if (!people.length) approvals.append(node('p', '目前沒有申請。請分享上方「櫃檯專屬申請頁」給人員。'));
      for (const person of people) {
        const row = node('form', '', 'frontdesk-person');
        const current = {pending:'待審核',approved:'已核准',rejected:'申請未通過',suspended:'已停用'}[person.status] || person.status;
        row.append(node('h4', person.displayName || '櫃檯人員'), node('p', '申請狀態：' + current));
        if (person.status === 'pending') row.append(node('p', '此人員尚未獲授權，預設為「僅接收預約訊息」。'));
        const states = node('label', '審核狀態'), state = node('select');
        state.name = 'staffStatus';
        for (const [value, text] of [['approved','核准'],['rejected','拒絕申請'],['suspended','停用']]) {
          const option = node('option', text);
          option.value = value;
          state.append(option);
        }
        state.value = person.status === 'pending' ? 'approved' : person.status;
        states.append(state);
        const modes = node('label', '預約權限'), mode = node('select');
        mode.name = 'permissionMode';
        for (const [value, text] of [['notify_only','僅接收預約訊息'],['review','接收通知，並可確認／拒絕預約']]) {
          const option = node('option', text);
          option.value = value;
          mode.append(option);
        }
        mode.value = person.permissionMode || 'notify_only';
        modes.append(mode);
        const controls = node('div', '', 'business-line-fields');
        controls.append(states, modes);
        const button = node('button', person.status === 'pending' ? '核准／更新此人員權限' : '儲存此人員權限', 'button button-outline');
        button.type = 'submit';
        row.append(controls, button);
        row.addEventListener('submit', event => {
          event.preventDefault();
          void save('platform.frontdesk.staff.save', {staffId:person.id,expectedVersion:person.version,status:state.value,permissionMode:mode.value}, button);
        });
        approvals.append(row);
      }
      content.append(approvals);
      lock();
    }
    async function load() {
      if (busy || pending) return;
      busy = true;
      lock();
      status.textContent = '正在讀取櫃檯設定與人員申請…';
      try {
        const result = await request('platform.frontdesk.get');
        if (!alive()) return;
        data = result;
        render();
        status.textContent = '已載入此商家的櫃檯設定與申請名單。';
      } catch (error) {
        if (alive()) status.textContent = error.message || '暫時無法取得櫃檯設定。';
      } finally {
        busy = false;
        if (alive()) lock();
      }
    }
    reload.onclick = () => void load();
    details.addEventListener('toggle', () => { if (details.open && !data) void load(); });
  }
  window.FrontdeskSettings = Object.freeze({ mount });
})();
