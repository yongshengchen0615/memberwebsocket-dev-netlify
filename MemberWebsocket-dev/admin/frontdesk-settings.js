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
    details.append(node('summary', '櫃檯管理項目'));
    const status = node('p');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const content = node('div', '', 'frontdesk-settings-content');
    const reload = node('button', '重新整理', 'button button-outline');
    reload.type = 'button';
    const syncState = node('p', '尚未取得最新櫃檯設定。', 'frontdesk-sync-state');
    // The primary status is the sole live region; this is a visual sync hint.
    // Keep the settings form and staff approvals in LINE settings; action records
    // are fetched lazily from the authenticated merchant API, never from a
    // browser-maintained booking status cache.
    const tabs = node('div', '', 'frontdesk-settings-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '櫃檯設定分類');
    const historyPanel = node('section', '', 'frontdesk-history-panel');
    historyPanel.id = 'frontdesk-history-panel';
    historyPanel.setAttribute('role', 'tabpanel');
    historyPanel.hidden = true;
    content.id = 'frontdesk-line-panel';
    content.setAttribute('role', 'tabpanel');
    const tabButtons = new Map();
    let selectedTab = 'line', historyEpoch = 0;
    for (const [key, title] of [['line', 'LINE 設定'], ['confirmed', '確認預約'], ['rejected', '拒絕預約']]) {
      const tab = node('button', title, 'frontdesk-settings-tab');
      tab.type = 'button';
      tab.id = 'frontdesk-tab-' + key;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', key === 'line' ? content.id : historyPanel.id);
      tab.setAttribute('aria-selected', key === 'line' ? 'true' : 'false');
      tab.tabIndex = key === 'line' ? 0 : -1;
      tab.addEventListener('click', () => selectTab(key));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const keys = [...tabButtons.keys()], at = keys.indexOf(key);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 :
          (at + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
        const target = tabButtons.get(keys[next]);
        target.focus();
        target.click();
      });
      tabButtons.set(key, tab);
      tabs.append(tab);
    }
    content.setAttribute('aria-labelledby', 'frontdesk-tab-line');
    historyPanel.setAttribute('aria-labelledby', 'frontdesk-tab-confirmed');
    // <details> owns an internal content box in Chromium. Put all open-state
    // controls in one explicit grid instead of treating its children as grid
    // items: otherwise tab changes can reflow into different implicit tracks.
    const body = node('div', '', 'frontdesk-settings-body');
    body.append(status, syncState, reload, tabs, content, historyPanel);
    details.append(body);
    root.append(details);
    let data = null, busy = false, pending = null, dirty = false, snapshot = '';
    const channel = typeof window.BroadcastChannel === 'function'
      ? new window.BroadcastChannel('frontdesk-settings-v1') : null;
    const alive = () => details.isConnected;
    const visible = () => alive() && details.open && !document.hidden &&
      !details.closest('[role="tabpanel"]')?.hidden;
    function selectTab(key) {
      if (!tabButtons.has(key) || !alive()) return;
      selectedTab = key;
      historyEpoch++;
      content.hidden = key !== 'line';
      historyPanel.hidden = key === 'line';
      historyPanel.setAttribute('aria-labelledby', 'frontdesk-tab-' + (key === 'line' ? 'confirmed' : key));
      for (const [name, tab] of tabButtons) {
        const chosen = name === key;
        tab.setAttribute('aria-selected', String(chosen));
        tab.tabIndex = chosen ? 0 : -1;
      }
      if (key !== 'line') void loadHistory();
    }
    const formatActionAt = value => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '時間未提供' :
        date.toLocaleString('zh-TW', { timeZone:'Asia/Taipei', year:'numeric', month:'2-digit',
          day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
    };
    const displayStatus = value => ({pending:'待確認',confirmed:'已確認',
      rejected:'已拒絕',cancelled:'已取消',completed:'已完成'}[value] || '其他狀態');
    const rejectionText = value => ({
      technician_leave:'技師請假',
      unrecorded_phone_booking:'該時段已被現場人員預約但未登記'
    }[value] || (value ? '其他拒絕原因' : '未提供'));
    function bookingDetails(parent, booking) {
      if (!booking) {
        parent.append(node('p', '預約資料已不存在；操作紀錄仍保留。', 'frontdesk-history-muted'));
        return;
      }
      const date = booking.bookingDate || String(booking.startAt || '').slice(0, 10) || '—';
      const start = booking.startTime || String(booking.startAt || '').slice(11, 16) || '—';
      const end = booking.endTime || String(booking.endAt || '').slice(11, 16) || '—';
      const lines = [
        ['預約日期：', date],
        ['預約時間：', start + ' – ' + end],
        ['預約人：', booking.name || '—'],
        ['電話：', booking.phone || '—'],
        ['預約人數：', Number.isFinite(Number(booking.partySize)) ? booking.partySize + ' 位' : '—']
      ];
      for (const [label, value] of lines) parent.append(node('p', label + value));
      const participants = Array.isArray(booking.participants) ? booking.participants : [];
      if (participants.length) {
        for (const person of participants) {
          const part = node('div', '', 'frontdesk-history-participant');
          part.append(node('strong', '第 ' + (Number(person.position) || 1) + ' 位預約'));
          const items = Array.isArray(person.services) ? person.services : [];
          for (const item of items) part.append(node('p', '預約項目：' + (item.title || '未命名項目') +
            (Number(item.quantity) > 1 ? ' × ' + item.quantity : '')));
          part.append(node('p', '預約技師：' + (person.technician || '現場安排')));
          if (person.note) part.append(node('p', '個別備註：' + person.note));
          parent.append(part);
        }
      } else {
        for (const item of Array.isArray(booking.services) ? booking.services : [])
          parent.append(node('p', '預約項目：' + (item.title || '未命名項目') +
            (Number(item.quantity) > 1 ? ' × ' + item.quantity : '')));
      }
      if (booking.note) parent.append(node('p', '預約備註：' + booking.note));
      if (booking.adminNote) parent.append(node('p', '管理備註：' + booking.adminNote));
    }
    async function loadHistory() {
      if (selectedTab === 'line' || !visible()) return;
      const statusKey = selectedTab, sequence = ++historyEpoch;
      historyPanel.replaceChildren();
      const heading = node('h3', statusKey === 'confirmed' ? '櫃檯確認預約紀錄' : '櫃檯拒絕預約紀錄');
      const hint = node('p', '依櫃檯實際處理時間排序，顯示最近 50 筆。預約明細為目前資料，並非操作當時的歷史快照。', 'frontdesk-history-muted');
      const state = node('p', '正在載入預約紀錄…', 'frontdesk-history-state');
      state.setAttribute('role', 'status');
      historyPanel.append(heading, hint, state);
      try {
        const result = await request('platform.frontdesk.history.list', {status:statusKey});
        if (!alive() || historyEpoch !== sequence || selectedTab !== statusKey) return;
        const records = Array.isArray(result?.items) ? result.items : [];
        state.textContent = records.length ? '已取得 ' + records.length + ' 筆櫃檯處理紀錄。' :
          (statusKey === 'confirmed' ? '尚無櫃檯確認預約紀錄。' : '尚無櫃檯拒絕預約紀錄。');
        for (const record of records) {
          const card = node('article', '', 'frontdesk-history-card');
          const booking = record.booking;
          card.append(node('h4', '預約編號：' + String(record.bookingId || '—')));
          card.append(node('p', '處理時間：' + formatActionAt(record.actionAt)));
          card.append(node('p', '處理人員：' + String(record.actorName || '櫃檯人員')));
          if (statusKey === 'rejected') card.append(node('p', '拒絕原因：' + rejectionText(record.rejectionReason)));
          if (record.currentStatus && record.currentStatus !== statusKey)
            card.append(node('p', '目前狀態：' + displayStatus(record.currentStatus) + '（與當時操作不同）',
              'frontdesk-history-state'));
          bookingDetails(card, booking);
          if (statusKey === 'rejected' && record.phoneBooking) {
            const replacement = node('section', '', 'frontdesk-history-replacement');
            replacement.append(node('h5', '後續登記的現場／電話預約'));
            bookingDetails(replacement, record.phoneBooking);
            card.append(replacement);
          }
          historyPanel.append(card);
        }
      } catch (error) {
        if (!alive() || historyEpoch !== sequence || selectedTab !== statusKey) return;
        state.textContent = error.message || '無法取得預約紀錄。';
        const retry = node('button', '重試載入紀錄', 'button button-outline');
        retry.type = 'button';
        retry.addEventListener('click', () => void loadHistory());
        historyPanel.append(retry);
      }
    }
    function lock() {
      for (const control of details.querySelectorAll('input,textarea,select,button:not([role="tab"])')) control.disabled = busy || Boolean(pending);
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
        else {
          button.textContent = '重試相同儲存操作';
          // A destructive retry must have the same accessible label as its
          // current action; the original per-person aria-label is now stale.
          if (action === 'platform.frontdesk.staff.delete') button.setAttribute('aria-label', '重試相同儲存操作');
        }
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
      overview.append(node('p', cfg.enabled === false ? '此商家的櫃檯服務目前已停用，請檢查下方通知設定。' :
        hasSettings ? '登入與通知資料已設定。你可以檢查設定，或在右側管理人員權限。' :
        '先完成 LINE 登入與官方帳號設定，再審核櫃檯人員的使用申請。'));
      content.append(overview);
      const form = node('form', '', 'frontdesk-config-form');
      const login = node('fieldset', '', 'frontdesk-setup-card');
      login.append(node('legend', '1. 櫃檯登入入口'));
      login.append(node('p', '設定櫃檯人員使用的 LINE 登入入口。可直接貼上完整 LIFF 網址，系統會擷取 ID。'));
      const entry = node('div', '', 'business-line-fields');
      const liff = field('liffId', '櫃檯 LIFF ID／入口網址', '可貼入 LIFF ID 或網址。取得位置：LINE Developers → LINE Login Channel → LIFF。', cfg.liffId || '');
      const channel = field('loginChannelId', '登入 Channel ID', '在 LINE Developers → LINE Login Channel → Basic settings 查看；貼入 LIFF 網址可自動帶入。', cfg.loginChannelId || '');
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
      login.append(node('p', '櫃檯頁面網址（請貼到 LINE Developers 的 LIFF Endpoint URL 欄位）'));
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
      const messaging = field('messagingChannelId', '通知用 Messaging API Channel ID',
        'LINE Official Account Manager → 設定 → Messaging API；也可在 LINE Developers → Messaging API Channel → Basic settings 查看。',
        cfg.messagingChannelId || '');
      const token = field('channelAccessToken', '通知用 Channel access token',
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

      // The conflict start window is derived from each original booking; only
      // the staff-facing page title remains a merchant preference.
      const preferences = node('form', '', 'frontdesk-preferences-form frontdesk-setup-card');
      const preferenceTitle = node('h3', '3. 櫃檯頁面抬頭');
      const preferenceHint = node('p', '衝突預約開始時間由原預約區間自動產生，每 10 分鐘一格，包含結束時間；不需另外設定上下限。');
      const pageTitle = field('pageTitle', '櫃檯頁面抬頭', '留空則顯示商家名稱＋「櫃檯」，不改動管理端抬頭。', cfg.pageTitle || '', false);
      pageTitle.input.maxLength = 60;
      pageTitle.input.placeholder = '例如：門市預約櫃檯';
      const savePreferences = node('button', '儲存櫃檯頁面抬頭', 'button button-outline frontdesk-primary');
      savePreferences.type = 'submit';
      preferences.append(preferenceTitle, preferenceHint, pageTitle.wrap, savePreferences);
      preferences.addEventListener('input', markDirty);
      preferences.addEventListener('submit', event => {
        event.preventDefault();
        if (pending) {
          if (pending.action === 'platform.frontdesk.preferences.save') void save(pending.action, pending.body, savePreferences);
          return;
        }
        if (!preferences.reportValidity()) return;
        void save('platform.frontdesk.preferences.save', {
          expectedVersion: data.version,
          preferences: { pageTitle: pageTitle.input.value.trim() }
        }, savePreferences);
      });
      content.append(preferences);

      // Only expose the editor after the authenticated database response advertises
      // the new policy contract. Older deployments continue using fixed reasons.
      if (cfg.rejectionSettings && Array.isArray(cfg.rejectionSettings.reasons)) {
        const settings = node('form', '', 'frontdesk-setup-card frontdesk-rejection-settings');
        settings.dataset.frontdeskRejectionSettings = 'true';
        settings.append(node('h3', '拒絕預約設定'), node('p', '可新增、編輯、排序或停用拒絕原因。停用後保留歷史紀錄；對外說明將用於會員通知。'));
        const title = field('rejectionDropdownTitle', '櫃檯端下拉式選單標題', '留空使用「請選擇拒絕原因」。', cfg.rejectionSettings.dropdownTitle || '', false);
        title.input.maxLength = 60;
        settings.append(title.wrap);
        const rows = node('div', '', 'frontdesk-settings-content');
        const draft = cfg.rejectionSettings.reasons.map(reason => ({...reason}));
        const add = node('button', '新增拒絕原因', 'button button-outline');
        add.type = 'button';
        const saveSettings = node('button', '儲存拒絕預約設定', 'button button-outline frontdesk-primary');
        saveSettings.type = 'submit';
        const rerender = () => {
          rows.replaceChildren();
          draft.forEach((reason, index) => {
            const card = node('fieldset', '', 'frontdesk-setup-card');
            card.append(node('legend', '拒絕原因 ' + (index + 1)));
            const label = field('rejection-label-' + reason.id, '櫃檯端選項名稱', '此名稱供櫃檯人員選擇。', reason.label);
            const descriptionLabel = node('label', '用戶端拒絕原因說明');
            const description = node('textarea');
            description.rows = 3; description.required = true; description.maxLength = 400;
            description.value = reason.memberDescription;
            descriptionLabel.append(description);
            const check = (caption, key) => {
              const wrap = node('label', '', 'business-notification-toggle');
              const input = node('input');
              input.type = 'checkbox'; input.checked = reason[key];
              input.addEventListener('change', () => { reason[key] = input.checked; markDirty(); });
              wrap.append(input, node('span', caption));
              return wrap;
            };
            label.input.addEventListener('input', () => { reason.label = label.input.value; });
            description.addEventListener('input', () => { reason.memberDescription = description.value; });
            card.append(label.wrap, descriptionLabel,
              check('啟用此拒絕原因', 'enabled'),
              check('需要設定衝突時間並登記現場預約', 'requiresConflictTime'));
            const controls = node('div', '', 'business-line-fields');
            for (const [direction, caption] of [[-1, '上移'], [1, '下移']]) {
              const move = node('button', caption, 'button button-outline');
              move.type = 'button';
              move.setAttribute('aria-label', '原因 ' + (index + 1) + ' ' + caption);
              move.hidden = index + direction < 0 || index + direction >= draft.length;
              move.onclick = () => {
                if (busy || pending || move.hidden) return;
                [draft[index], draft[index + direction]] = [draft[index + direction], draft[index]];
                markDirty(); rerender();
              };
              controls.append(move);
            }
            card.append(controls);
            rows.append(card);
          });
          add.hidden = draft.length >= 30;
        };
        add.onclick = () => {
          if (busy || pending || draft.length >= 30) return;
          draft.push({id:'custom_' + crypto.randomUUID(), label:'', memberDescription:'', enabled:true, requiresConflictTime:false});
          markDirty(); rerender();
          rows.lastElementChild?.querySelector('input')?.focus();
        };
        settings.addEventListener('input', markDirty);
        settings.addEventListener('change', markDirty);
        settings.addEventListener('submit', event => {
          event.preventDefault();
          if (pending) {
            if (pending.action === 'platform.frontdesk.rejection-settings.save') void save(pending.action, pending.body, saveSettings);
            return;
          }
          if (!settings.reportValidity()) return;
          if (!draft.some(reason => reason.enabled)) {
            status.textContent = '請至少啟用一個拒絕原因。'; return;
          }
          void save('platform.frontdesk.rejection-settings.save', {
            expectedVersion: data.version,
            rejectionSettings: {dropdownTitle: title.input.value.trim(), reasons: draft.map(reason => ({
              id:reason.id,label:reason.label.trim(),memberDescription:reason.memberDescription.trim(),
              enabled:reason.enabled,requiresConflictTime:reason.requiresConflictTime
            }))}
          }, saveSettings);
        });
        rerender();
        settings.append(rows, add, saveSettings);
        content.append(settings);
      }

      const approvals = node('section', '', 'frontdesk-approvals');
      approvals.append(node('h3', '4. 櫃檯人員申請與權限'));
      approvals.append(node('p', '人員須先從商家專屬櫃檯頁面申請，再由管理員逐人審核。未核准者無法查看預約或接收通知。'));
      const people = [...(data.staff || [])].sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0));
      const waiting = people.filter(person => person.status === 'pending').length;
      approvals.append(node('p', '待審核 ' + waiting + ' 人｜已記錄申請 ' + people.length + ' 人', 'business-line-summary'));
      if (!people.length) approvals.append(node('p', '目前沒有申請。櫃檯人員請透過商家專屬 frontdesk 頁面提出申請。'));
      for (const person of people) {
        const row = node('form', '', 'frontdesk-person');
        const current = {pending:'待審核',approved:'已核准',rejected:'申請未通過',suspended:'已停用'}[person.status] || person.status;
        row.append(node('h4', person.displayName || '櫃檯人員'), node('p', '申請狀態：' + current, 'frontdesk-person-status'));
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
      if (selectedTab !== 'line') void loadHistory();
    };
    details.addEventListener('toggle', () => { if (details.open) void load(); });
    const loadWhenVisible = () => visible() ? load() : undefined;
    const refreshVisible = () => Promise.all([
      loadWhenVisible(),
      selectedTab === 'line' ? Promise.resolve() : loadHistory()
    ]);
    const onRefresh = event => {
      if (!event.detail?.business || event.detail.business === business) void refreshVisible();
    };
    const onBroadcast = event => {
      if (event.data?.business === business) void refreshVisible();
    };
    window.addEventListener('frontdesk:refresh', onRefresh);
    channel?.addEventListener('message', onBroadcast);
    active.set(root, {
      business,
      load: refreshVisible,
      dispose() {
        window.removeEventListener('frontdesk:refresh', onRefresh);
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
    const entries = [...active.values()].filter(entry => !business || entry.business === business);
    return Promise.all(entries.map(entry => entry.load()));
  }
  window.FrontdeskSettings = Object.freeze({ mount, clear, refresh });
})();
