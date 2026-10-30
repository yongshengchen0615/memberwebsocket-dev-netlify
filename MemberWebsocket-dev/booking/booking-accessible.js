(() => {
  'use strict';
  const keyPrefix = 'booking-mode:v2:';
  const el = id => document.getElementById(id);
  let enabled = false;
  let memberId = '';
  let lastChatFeedback = null;
  const SNAPSHOT_HISTORY_GROUPS = [
    { key: 'pending', label: '待審核', empty: '目前沒有待審核的快照' },
    { key: 'registered', label: '已登記', empty: '目前沒有已登記的快照' },
    { key: 'attention', label: '需處理', empty: '目前沒有需要處理的快照' },
    { key: 'withdrawn', label: '已撤回', empty: '目前沒有已撤回的快照' },
  ];
  let activeSnapshotHistoryGroup = 'pending';
  let snapshotHistoryTabSelected = false;
  let lastScrolledSnapshotId = '';
  let historyDate = '';
  let historySubmissions = [];
  function snapshotChatFeedback(result) {
    if (result?.alreadyApplied === true) return '此快照先前已送出，不會重複傳送 LINE 訊息。';
    if (result?.chatResult?.sent === true) return '已由你的 LINE 將「快照確認」傳送到官方帳號聊天。';
    if (result?.chatResult?.reason === 'not_in_line_chat')
      return '目前不是從 LINE 官方帳號聊天內開啟，未自動傳送聊天訊息；可回到官方帳號聊天告知管理員。';
    return 'LINE 聊天訊息未成功傳送，請回到官方帳號聊天告知管理員；快照送審不受影響。';
  }
  window.BookingAccessibility = Object.freeze({ getPreferenceKey: () => memberId ? keyPrefix + memberId : '' });
  function renderLocationState({ status = 'idle', message = '' } = {}) {
    const statusLabel = el('bookingSnapshotLocationStatus');
    const retry = el('bookingSnapshotLocationRetry');
    const upload = el('bookingAccessibleUpload');
    if (upload) upload.disabled = enabled && status !== 'ready' && status !== 'optional';
    if (retry) retry.classList.toggle('hidden', status !== 'error');
    if (!statusLabel) return;
    statusLabel.textContent = status === 'ready'
      ? 'GPS 已定位，可以拍攝快照收據。送出時會再次確認定位有效性。'
      : status === 'optional' ? '管理端未要求快照定位，可直接拍攝收據。部分票券仍有獨立的定位限制。'
      : status === 'checking' ? '正在確認管理端的快照定位設定…'
      : status === 'requesting' ? '正在取得 GPS 定位，請允許裝置提供位置…'
      : status === 'error' ? (message || '目前無法確認定位設定，請按「重新定位」。')
      : '進入快照模式後，系統會依管理端設定確認是否需要 GPS。';
    statusLabel.classList.toggle('error', status === 'error');
  }

  function setMode(value, persist = false) {
    enabled = Boolean(value);
    document.body.classList.toggle('booking-accessible-mode', enabled);
    el('bookingAccessiblePanel')?.classList.toggle('hidden', !enabled);
    const toggle = el('bookingAccessibleToggle');
    toggle?.setAttribute('aria-pressed', String(enabled));
    if (toggle) toggle.textContent = enabled ? '返回一般預約模式' : '開啟快照模式';
    if (el('bookingModeTitle')) el('bookingModeTitle').textContent = enabled ? '快照模式' : '一般預約模式';
    if (el('bookingModeDescription')) el('bookingModeDescription').textContent = enabled
      ? '完成服務後拍收據，交由管理員核對登記。'
      : '自行選擇日期、服務項目與時段。';
    if (persist && memberId) {
      try { localStorage.setItem(keyPrefix + memberId, enabled ? 'accessible' : 'general'); }
      catch { if (el('bookingModePreference')) el('bookingModePreference').textContent = '此裝置無法儲存偏好；重新開啟時會使用一般模式。'; }
    }
    if (enabled) {
      renderLocationState({ status: 'checking' });
      // Check the administrator policy before accessing device geolocation.
      void window.BookingReceipts?.beginSnapshotMode?.().catch(() => {});
      renderTickets(window.BookingBenefits?.getItems?.() || []);
      void window.BookingReceipts?.refresh?.();
    } else {
      window.BookingReceipts?.endSnapshotMode?.();
      renderLocationState();
    }
  }
  function renderTickets(items) {
    const host = el('bookingAccessibleTickets');
    if (!host) return;
    host.replaceChildren();
    const tickets = (Array.isArray(items) ? items : []).filter(item =>
      ['points', 'event'].includes(item.kind)
      // A future general reservation does not block a separate snapshot when
      // the server confirms surplus points can cover both redemptions.
      && (item.selectable === true || (item.kind === 'event' && item.claimRequired === true)));
    tickets.forEach(item => {
      const card = document.createElement('article');
      card.className = 'ui-ticket snapshot-overview-ticket';
      card.dataset.kind = item.kind;
      if (item.kind === 'points') card.dataset.cardStyle = window.MemberUI.pointCardStyleKey(item.cardStyleKey);
      const heading = document.createElement('div');
      heading.className = 'snapshot-overview-heading';
      const headingCopy = document.createElement('div');
      headingCopy.className = 'snapshot-overview-heading-copy';
      const kind = document.createElement('span');
      kind.className = 'snapshot-overview-kind';
      kind.textContent = item.kind === 'points' ? '集點卡票券' : '活動票券';
      const title = document.createElement('h4');
      title.textContent = String(item.title || '可用票券');
      headingCopy.append(kind, title);
      const state = document.createElement('span');
      state.className = 'snapshot-overview-status';
      state.textContent = item.claimRequired ? '尚未領取' : '可供登記';
      heading.append(headingCopy, state);
      card.append(heading);
      if (item.cardTitle && item.kind === 'points') {
        const source = document.createElement('p');
        source.className = 'snapshot-overview-source';
        source.textContent = '來源集點卡：' + String(item.cardTitle);
        card.append(source);
      }
      const condition = document.createElement('p');
      condition.className = 'snapshot-overview-condition';
      condition.textContent = String(item.conditionLabel || item.subtitle || '依票券使用條件核對');
      const expiry = document.createElement('p');
      expiry.className = 'snapshot-overview-expiry';
      expiry.textContent = item.endsOn ? `有效至 ${item.endsOn}` : '依票券有效期限使用';
      card.append(condition, expiry);
      if (item.kind === 'points') card.append(window.MemberUI.pointTicketDetails(item));
      if (item.claimRequired) {
        const help = document.createElement('p');
        help.className = 'snapshot-overview-claim-help';
        help.textContent = '拍攝快照時可先領取，領取後仍需符合票券條件。';
        card.append(help);
      }
      host.append(card);
    });
    if (el('bookingAccessibleTicketsStatus')) {
      el('bookingAccessibleTicketsStatus').textContent = tickets.length
        ? `目前有 ${tickets.length} 張可登記／待領取票券，請於拍攝快照時勾選。`
        : '目前沒有可登記或可領取的票券；仍可送出快照收據。';
    }
  }
  function snapshotHistoryGroup(row) {
    if (row.cancelled === true) return 'withdrawn';
    if (row.dismissed === true || row.status === 'failed') return 'attention';
    if (row.status === 'bound') return 'registered';
    return 'pending';
  }

  function snapshotHistoryStatusLabel(row) {
    if (row.cancelled === true) return '已撤回';
    if (row.dismissed === true) return '需重新提供收據';
    if (row.status === 'failed') return '處理未完成';
    if (row.status === 'bound') return '已登記';
    return '待審核';
  }

  function activateSnapshotHistoryGroup(host, key, focus = false) {
    if (!SNAPSHOT_HISTORY_GROUPS.some(group => group.key === key)) return;
    activeSnapshotHistoryGroup = key;
    SNAPSHOT_HISTORY_GROUPS.forEach(group => {
      const selected = group.key === key;
      const tab = host.querySelector('#snapshotHistoryTab-' + group.key);
      const panel = host.querySelector('#snapshotHistoryPanel-' + group.key);
      if (tab) {
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        tab.classList.toggle('is-active', selected);
        if (selected && focus) tab.focus();
      }
      if (panel) panel.hidden = !selected;
    });
  }

  function installSnapshotHistoryTabs(host) {
    if (host.dataset.snapshotTabsBound === '1') return;
    host.dataset.snapshotTabsBound = '1';
    host.addEventListener('click', event => {
      const tab = event.target?.closest?.('[data-snapshot-history-tab]');
      if (!tab || !host.contains(tab)) return;
      snapshotHistoryTabSelected = true;
      activateSnapshotHistoryGroup(host, tab.dataset.snapshotHistoryTab);
    });
    host.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tab = event.target?.closest?.('[data-snapshot-history-tab]');
      if (!tab || !host.contains(tab)) return;
      const index = SNAPSHOT_HISTORY_GROUPS.findIndex(group => group.key === tab.dataset.snapshotHistoryTab);
      if (index < 0) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? SNAPSHOT_HISTORY_GROUPS.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + SNAPSHOT_HISTORY_GROUPS.length) % SNAPSHOT_HISTORY_GROUPS.length;
      snapshotHistoryTabSelected = true;
      activateSnapshotHistoryGroup(host, SNAPSHOT_HISTORY_GROUPS[nextIndex].key, true);
    });
  }

  function renderSnapshotHistory(submissions) {
    const view = el('bookingView');
    if (!view) return;
    let host = el('bookingSnapshotHistory');
    if (!host) {
      host = document.createElement('section');
      host.id = 'bookingSnapshotHistory';
      host.className = 'booking-card booking-snapshot-history';
      view.append(host);
    }
    installSnapshotHistoryTabs(host);
    const existingDetails = new Map([...host.querySelectorAll('details[data-receipt-id]')]
      .map(details => [details.dataset.receiptId, details.open]));
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    const focusedTab = focused?.dataset.snapshotHistoryTab;
    const focusedReceiptId = focused?.matches('summary')
      ? focused.closest('details')?.dataset.receiptId : '';
    historySubmissions = Array.isArray(submissions) ? submissions : [];
    const rows = historyDate ? historySubmissions.filter(row => snapshotDate(row.createdAt) === historyDate) : historySubmissions;
    host.hidden = !rows.length;
    const empty = el('bookingSnapshotDayEmpty');
    if (empty) empty.hidden = rows.length > 0;
    host.replaceChildren();
    if (!rows.length) {
      window.dispatchEvent(new CustomEvent('booking:snapshot-history-rendered'));
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = '快照預約明細';
    heading.id = 'snapshotHistoryTitle';
    host.setAttribute('aria-labelledby', heading.id);
    const groups = new Map(SNAPSHOT_HISTORY_GROUPS.map(group => [group.key, []]));
    const requestedId = new URLSearchParams(window.location.search).get('receiptId');
    let targetDetails = null;

    for (const row of rows) {
      const details = document.createElement('details');
      details.className = 'member-booking-details';
      details.dataset.receiptId = String(row.receiptId || '');
      details.dataset.recordDate = snapshotDate(row.createdAt);
      details.open = existingDetails.get(details.dataset.receiptId) === true;
      const summary = document.createElement('summary');
      summary.textContent = snapshotHistoryStatusLabel(row) + ' · ' + String(row.receiptId || '');
      details.append(summary);
      const add = value => {
        const p = document.createElement('p');
        p.textContent = value;
        details.append(p);
      };
      const submittedAt = new Date(row.createdAt || '');
      add('送出時間：' + (Number.isFinite(submittedAt.getTime())
        ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'short' }).format(submittedAt)
        : '—'));
      const benefits = Array.isArray(row.requestedBenefits) ? row.requestedBenefits : [];
      add('本次登記票券：' + (benefits.map(item => String(item.title || item.id || '票券')).join('、') || '未選用'));
      const settlement = Array.isArray(row.settlement) ? row.settlement[0] : row.settlement;
      if (settlement) add('已核准服務時間：' + Number(settlement.service_minutes || 0) + ' 分鐘');
      if (requestedId && requestedId === details.dataset.receiptId) {
        details.classList.add('booking-detail-target');
        if (!existingDetails.has(details.dataset.receiptId)) details.open = true;
        targetDetails = details;
      }
      groups.get(snapshotHistoryGroup(row)).push(details);
    }

    const tabs = document.createElement('div');
    tabs.className = 'booking-history-tabs booking-snapshot-history-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '快照預約明細分類');
    const panels = [];
    SNAPSHOT_HISTORY_GROUPS.forEach(group => {
      const items = groups.get(group.key);
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.id = 'snapshotHistoryTab-' + group.key;
      tab.className = 'booking-history-tab';
      tab.dataset.snapshotHistoryTab = group.key;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'snapshotHistoryPanel-' + group.key);
      tab.setAttribute('aria-label', group.label + '，共 ' + items.length + ' 筆');
      const label = document.createElement('span');
      label.className = 'booking-history-tab-label';
      label.textContent = group.label;
      const count = document.createElement('span');
      count.className = 'booking-history-tab-count';
      count.textContent = items.length + ' 筆';
      tab.append(label, count);
      tabs.append(tab);

      const panel = document.createElement('section');
      panel.id = 'snapshotHistoryPanel-' + group.key;
      panel.className = 'snapshot-history-panel';
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.tabIndex = 0;
      if (items.length) panel.append(...items);
      else {
        const empty = document.createElement('p');
        empty.className = 'snapshot-history-empty';
        empty.textContent = group.empty;
        panel.append(empty);
      }
      panels.push(panel);
    });

    if (!snapshotHistoryTabSelected && targetDetails) {
      activeSnapshotHistoryGroup = snapshotHistoryGroup(rows.find(row => String(row.receiptId || '') === requestedId));
    } else if (!snapshotHistoryTabSelected && !groups.get(activeSnapshotHistoryGroup).length) {
      activeSnapshotHistoryGroup = SNAPSHOT_HISTORY_GROUPS.find(group => groups.get(group.key).length)?.key || 'pending';
    }
    host.append(heading, tabs, ...panels);
    activateSnapshotHistoryGroup(host, activeSnapshotHistoryGroup);
    window.dispatchEvent(new CustomEvent('booking:snapshot-history-rendered'));
    const focusTarget = focusedTab
      ? [...tabs.children].find(tab => tab.dataset.snapshotHistoryTab === focusedTab)
      : focusedReceiptId
        ? [...host.querySelectorAll('details')].find(details => details.dataset.receiptId === focusedReceiptId)?.querySelector('summary')
        : null;
    if (focusTarget && !focusTarget.closest('[hidden]')) focusTarget.focus({ preventScroll: true });
    if (targetDetails && !snapshotHistoryTabSelected && lastScrolledSnapshotId !== requestedId) {
      lastScrolledSnapshotId = requestedId;
      window.requestAnimationFrame(() => {
        if (host.contains(targetDetails) && !targetDetails.closest('[hidden]')) {
          targetDetails.scrollIntoView?.({ block: 'center' });
        }
      });
    }
  }
  function snapshotDate(value) {
    const date = new Date(value || '');
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }
  window.addEventListener('booking:history-date-selected', event => {
    historyDate = String(event.detail?.date || '');
    snapshotHistoryTabSelected = false;
    renderSnapshotHistory(historySubmissions);
  });
  function renderStatus(submissions) {
    renderSnapshotHistory(submissions);
    const status = el('bookingAccessibleStatus');
    if (!status) return;
    const latest = (Array.isArray(submissions) ? submissions : []).find(r => ['awaiting_review','bound'].includes(r.status) || r.dismissed || r.cancelled);
    if (!latest) { status.textContent = '尚未送出收據。'; return; }
    if (latest.status === 'awaiting_review') {
      status.textContent = '收據已送出，等待管理員登記。再次拍攝會取代目前待登記收據。';
      if (latest.requestedBenefits?.length) status.textContent += ` 登記票券：${latest.requestedBenefits.map(item => item.title || item.id).join('、')}。`;
      const cancel = document.createElement('button'); cancel.type='button'; cancel.className='button button-outline'; cancel.textContent='撤回登記';
      cancel.addEventListener('click', async () => {
        if (!window.confirm('撤回這次收據與票券登記？尚未核准的票券不會核銷。')) return;
        cancel.disabled=true;
        try { const session=window.BookingSystem.getSession(); await window.BookingSystem.request(session.config,'booking',session.idToken,'user.booking.receipt.cancel',{receiptId:latest.receiptId,expectedUpdatedAt:latest.updatedAt}); await window.BookingReceipts.refresh(); }
        catch(error) {status.textContent=error?.message||'無法撤回，請重新整理後確認狀態。';}
      });
      status.append(cancel);
      if (lastChatFeedback?.receiptId === String(latest.receiptId || '')) {
        status.append(document.createTextNode(' ' + lastChatFeedback.message));
      }
    } else if (latest.cancelled) {
      status.textContent = '已撤回收據與票券登記，未執行核銷。';
    } else if (latest.dismissed) {
      status.textContent = '管理員請您重新提供收據，請確認內容後再次拍攝。';
    } else {
      const settlement = Array.isArray(latest.settlement) ? latest.settlement[0] : latest.settlement;
      const minutes = Number(settlement?.service_minutes || 0);
      const rewards = Array.isArray(settlement?.reward_details) ? settlement.reward_details : [];
      const points = rewards.reduce((sum, reward) => sum + Math.max(0,Number(reward.points || 0)),0);
      status.textContent = `管理員已登記完成${settlement ? `：累積服務 ${minutes} 分鐘，獲得 ${points} 點。` : '，點數與服務時間已依規則記錄。'}`;
    }
  }
  window.addEventListener('DOMContentLoaded', () => {
    el('bookingAccessibleToggle')?.addEventListener('click', () => setMode(!enabled, true));
    el('bookingSnapshotLocationRetry')?.addEventListener('click', () => {
      if (!enabled) return;
      renderLocationState({ status: 'requesting' });
      void window.BookingReceipts?.beginSnapshotMode?.().catch(() => {});
    });
    window.addEventListener('booking:snapshot-location-state', event => {
      if (enabled) renderLocationState(event.detail);
    });
    el('bookingAccessibleUpload')?.addEventListener('click', () => window.BookingReceipts?.openAccessible?.());
    el('bookingAccessibleRefresh')?.addEventListener('click', () => {
      el('bookingAccessibleStatus').textContent = '正在更新登記狀態…';
      window.BookingBenefits?.syncNow?.(); void window.BookingReceipts?.refresh?.();
    });
    setMode(false);
  });
  // Resolve before revealing the booking view; the old shared key is deliberately ignored.
  window.addEventListener('booking:member-loaded', event => {
    const nextId = String(event.detail?.profile?.lineUserId || '');
    if (nextId === memberId) return;
    // Never display the previous member's receipt history while a new identity loads.
    activeSnapshotHistoryGroup = 'pending';
    snapshotHistoryTabSelected = false;
    lastScrolledSnapshotId = '';
    historyDate = '';
    historySubmissions = [];
    const history = el('bookingSnapshotHistory');
    if (history) {
      history.replaceChildren();
      history.hidden = true;
    }
    if (el('bookingAccessibleStatus')) el('bookingAccessibleStatus').textContent = '正在載入收據狀態…';
    memberId = nextId;
    let preferred = false;
    if (el('bookingModePreference')) el('bookingModePreference').textContent = '切換後會記住此會員在本裝置的偏好。';
    try { preferred = Boolean(memberId) && localStorage.getItem(keyPrefix + memberId) === 'accessible'; }
    catch { if (el('bookingModePreference')) el('bookingModePreference').textContent = '此裝置無法儲存偏好；重新開啟時會使用一般模式。'; }
    setMode(preferred);
  });
  window.addEventListener('booking:benefits-loaded', event => renderTickets(event.detail?.items));
  window.addEventListener('booking:snapshot-benefit-options', event => { if (enabled) renderTickets(event.detail?.items); });
  window.addEventListener('booking:receipts-updated', event => renderStatus(event.detail?.submissions));
  window.addEventListener('booking:receipt-load-error', () => {
    if (el('bookingAccessibleStatus')) el('bookingAccessibleStatus').textContent = '暫時無法更新收據狀態，請按「更新登記狀態與票券」重試。';
  });
  window.addEventListener('booking:accessible-receipt-submitted', event => {
    const result = event.detail || {};
    const message = snapshotChatFeedback(result);
    lastChatFeedback = { receiptId: String(result.receiptId || ''), message };
    if (el('bookingAccessibleStatus')) {
      el('bookingAccessibleStatus').textContent = '收據已送出，等待管理員登記。' + ' ' + message;
    }
  });
  window.addEventListener('booking:view-shown', () => { if (enabled) void window.BookingReceipts?.refresh?.(); });
})();
