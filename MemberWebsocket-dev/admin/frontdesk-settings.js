(() => {
  'use strict';
  const mounted = new WeakSet();
  const active = new Map();
  const node = (tag, text, className) => {
    const result = document.createElement(tag);
    if (text) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
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
    const reload = node('button', '重新整理', 'button button-outline');
    reload.type = 'button';
    const syncState = node('p', '尚未取得最新櫃檯設定。', 'frontdesk-sync-state');
    // The primary status is the sole live region; this is a visual sync hint.
    details.append(status, syncState, reload, content);
    root.append(details);
    let data = null, busy = false, pending = null, dirty = false, snapshot = '';
    const channel = typeof window.BroadcastChannel === 'function'
      ? new window.BroadcastChannel('frontdesk-settings-v1') : null;
    const alive = () => details.isConnected;
    const visible = () => alive() && details.open && !document.hidden &&
      !details.closest('[role="tabpanel"]')?.hidden;
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
        dirty = false;
        snapshot = JSON.stringify([result.version, result.frontdesk, result.staff]);
        data = result;
        render();
        syncState.textContent = '最新版本已儲存並同步。';
        status.textContent = action === 'platform.frontdesk.staff.delete' ? '櫃檯帳號已移除；如需重新使用，須重新申請並審核。' : '櫃檯設定與人員權限已儲存。';
        // Invalidate other open tabs; never send credentials or staff data.
        channel?.postMessage({ business });
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
      const overview = node('div', '', 'frontdesk-settings-overview');
      overview.append(node('strong', cfg.enabled === false ? '櫃檯入口已停用' :
        hasSettings ? '櫃檯已設定 LINE 入口' : '尚待完成櫃檯設定'));
      overview.append(node('p', '總管理員控制開通；商家管理員設定 LINE 與逐人授權。'));
      content.append(overview);
      const form = node('form', '', 'frontdesk-config-form');
      const login = node('fieldset', '', 'frontdesk-setup-card');
      login.append(node('legend', '1. 櫃檯登入'));
      login.append(node('p', '填入 LINE Login Channel 與 LIFF ID，也可以貼上完整 LIFF 網址。'));
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
      notifications.append(node('legend', '2. 預約通知'));
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
      const markDirty = () => {
        if (busy || pending) return;
        dirty = true;
        syncState.textContent = '有尚未儲存的修改；自動同步不會覆蓋草稿。';
      };
      form.addEventListener('input', markDirty);
      form.addEventListener('change', markDirty);
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

      const approvals = node('section', '', 'frontdesk-approvals');
      approvals.append(node('h3', '3. 人員審核與權限'));
      approvals.append(node('p', '櫃檯人員透過商家專屬 frontdesk 頁面登入並申請；未核准者不能查看預約或接收通知。'));
      const people = [...(data.staff || [])].sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0));
      const waiting = people.filter(person => person.status === 'pending').length;
      approvals.append(node('p', '待審核 ' + waiting + ' 人｜已記錄申請 ' + people.length + ' 人', 'business-line-summary'));
      if (!people.length) approvals.append(node('p', '目前沒有申請。櫃檯人員請透過商家專屬 frontdesk 頁面提出申請。'));
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
        const remove = node('button', '移除帳號', 'button button-outline frontdesk-remove-staff');
        remove.type = 'button';
        remove.setAttribute('aria-label', '移除 ' + (person.displayName || '此櫃檯人員') + ' 的櫃檯帳號');
        remove.onclick = () => {
          if (busy || (pending && pending.action !== 'platform.frontdesk.staff.delete')) return;
          // An uncertain response must reuse the original requestId; do not re-confirm
          // or generate another destructive request while the first outcome is unknown.
          if (!pending && !window.confirm('確定永久移除「' + (person.displayName || '此櫃檯人員') + '」的櫃檯資格、申請資料及通知紀錄？此動作無法復原；如需使用，必須重新提出申請並經管理員核准。')) return;
          void save('platform.frontdesk.staff.delete', {staffId:person.id,expectedVersion:person.version}, remove);
        };
        row.append(remove);
        row.addEventListener('change', () => {
          if (busy || pending) return;
          dirty = true;
          syncState.textContent = '人員權限尚未儲存；自動同步不會覆蓋草稿。';
        });
        row.addEventListener('submit', event => {
          event.preventDefault();
          void save('platform.frontdesk.staff.save', {staffId:person.id,expectedVersion:person.version,status:state.value,permissionMode:mode.value}, button);
        });
        approvals.append(row);
      }
      content.append(approvals);
      lock();
    }
    async function load({ force = false } = {}) {
      if (busy || pending || !alive()) return;
      if (dirty && !force) {
        syncState.textContent = '偵測到資料同步需求；請先儲存草稿，或使用「重新整理」捨棄修改。';
        return;
      }
      busy = true;
      lock();
      status.textContent = '正在確認伺服器上的最新櫃檯設定…';
      try {
        const result = await request('platform.frontdesk.get');
        if (!alive()) return;
        const next = JSON.stringify([result.version, result.frontdesk, result.staff]);
        // An explicit discard must reconstruct the form even if the server
        // version did not change, or abandoned input values remain editable.
        if (force || next !== snapshot) {
          data = result;
          snapshot = next;
          dirty = false;
          render();
          status.textContent = '已同步最新櫃檯設定與人員申請。';
        } else {
          status.textContent = '櫃檯設定與伺服器一致。';
        }
        syncState.textContent = '最後確認：' + new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
      } catch (error) {
        if (alive()) {
          status.textContent = error.message || '暫時無法取得櫃檯設定。';
          syncState.textContent = '同步失敗；目前顯示的資料可能已過期。';
        }
      } finally {
        busy = false;
        if (alive()) lock();
      }
    }
    reload.onclick = () => {
      if (dirty && !window.confirm('確定捨棄尚未儲存的修改並載入伺服器最新版本？')) return;
      dirty = false;
      void load({ force: true });
    };
    details.addEventListener('toggle', () => { if (details.open) void load(); });
    const onFocus = () => { if (visible()) void load(); };
    const onVisibility = () => { if (!document.hidden) onFocus(); };
    const onRefresh = event => {
      if (!event.detail?.business || event.detail.business === business) onFocus();
    };
    const onBroadcast = event => {
      if (event.data?.business === business) onFocus();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    window.addEventListener('frontdesk:refresh', onRefresh);
    document.addEventListener('visibilitychange', onVisibility);
    channel?.addEventListener('message', onBroadcast);
    active.set(root, {
      business,
      load: onFocus,
      dispose() {
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('online', onFocus);
        window.removeEventListener('frontdesk:refresh', onRefresh);
        document.removeEventListener('visibilitychange', onVisibility);
        channel?.removeEventListener('message', onBroadcast);
        channel?.close();
      }
    });
  }
  function clear(root) {
    if (!root) return;
    active.get(root)?.dispose();
    active.delete(root);
    mounted.delete(root);
    root.querySelector('[data-frontdesk-settings]')?.remove();
  }
  function refresh({ business } = {}) {
    for (const entry of active.values()) if (!business || entry.business === business) entry.load();
  }
  window.FrontdeskSettings = Object.freeze({ mount, clear, refresh });
})();
