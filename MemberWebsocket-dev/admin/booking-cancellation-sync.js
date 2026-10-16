(() => {
  'use strict';

  const FALLBACK_POLL_MS = 12000;
  const REALTIME_RECONCILE_MS = 120000;
  const MODE_CORE = 'core';
  const MODE_REQUESTS = 'requests';
  const MODE_CANCELLED = 'cancelled';
  let config = null;
  let loading = false;
  let refreshQueued = false;
  let refreshQueuedIncludeBookings = false;
  let refreshQueuedShowSuccess = false;
  let mounted = false;
  let realtimeBound = false;
  let realtimeConnected = false;
  let realtimeTimer = null;
  let pollTimer = null;
  let activeMode = MODE_CORE;
  let requestRows = [];
  let cancelledRows = [];
  const els = {};

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitForBookingPanel);
  else waitForBookingPanel();

  function waitForBookingPanel() {
    let attempts = 0;
    const run = () => {
      attempts += 1;
      const queuePanel = document.getElementById('bookingAdminQueuePanel');
      if (queuePanel) return mount(queuePanel);
      if (attempts < 100) window.setTimeout(run, 100);
    };
    run();
  }

  function mount(queuePanel) {
    if (mounted || document.getElementById('bookingCancellationReview')) return;
    const filter = queuePanel.querySelector('.booking-admin-filter');
    const coreQueue = document.getElementById('bookingAdminQueue');
    const coreEmpty = document.getElementById('bookingAdminQueueEmpty');
    if (!filter || !coreQueue || !coreEmpty) return;
    mounted = true;

    const requestButton = document.createElement('button');
    requestButton.id = 'bookingCancellationRequestFilter';
    requestButton.className = 'booking-admin-filter-button';
    requestButton.type = 'button';
    requestButton.textContent = '取消申請';

    const cancelledButton = document.createElement('button');
    cancelledButton.id = 'bookingCancelledFilter';
    cancelledButton.className = 'booking-admin-filter-button';
    cancelledButton.type = 'button';
    cancelledButton.textContent = '已取消';

    const confirmedButton = filter.querySelector('[data-booking-filter="confirmed"]');
    if (confirmedButton) {
      confirmedButton.insertAdjacentElement('afterend', requestButton);
      requestButton.insertAdjacentElement('afterend', cancelledButton);
    } else {
      filter.append(requestButton, cancelledButton);
    }

    const section = document.createElement('section');
    section.id = 'bookingCancellationReview';
    section.className = 'booking-admin-cancellation-review hidden';
    section.setAttribute('aria-labelledby', 'bookingCancellationReviewTitle');
    section.innerHTML = `
      <div class="booking-admin-section-heading booking-cancellation-heading">
        <div><p id="bookingCancellationReviewKicker" class="kicker">Cancellation requests</p><h3 id="bookingCancellationReviewTitle">取消申請</h3><p id="bookingCancellationReviewDescription">會員申請取消後，原預約時段仍保留；管理端確認取消後才會重新開放。</p></div>
        <span id="bookingCancellationReviewCount" class="booking-admin-status status-pending">0 筆</span>
      </div>
      <div id="bookingCancellationReviewMessage" class="form-message hidden" role="status" aria-live="polite"></div>
      <div id="bookingCancellationReviewList" class="booking-admin-queue"></div>
      <div id="bookingCancellationReviewEmpty" class="empty-state compact"><span aria-hidden="true">○</span><p>目前沒有待確認的取消申請</p></div>`;
    filter.insertAdjacentElement('afterend', section);

    els.filter = filter;
    els.coreQueue = coreQueue;
    els.coreEmpty = coreEmpty;
    els.requestButton = requestButton;
    els.cancelledButton = cancelledButton;
    ['bookingCancellationReview','bookingCancellationReviewKicker','bookingCancellationReviewTitle','bookingCancellationReviewDescription','bookingCancellationReviewCount','bookingCancellationReviewMessage','bookingCancellationReviewList','bookingCancellationReviewEmpty'].forEach((id) => { els[id] = document.getElementById(id); });

    requestButton.addEventListener('click', () => activateMode(MODE_REQUESTS));
    cancelledButton.addEventListener('click', () => activateMode(MODE_CANCELLED));
    filter.querySelectorAll('[data-booking-filter]').forEach((button) => button.addEventListener('click', () => activateMode(MODE_CORE)));
    document.getElementById('bookingAdminRefreshButton')?.addEventListener('click', () => window.setTimeout(() => refresh(false, true), 150));
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('beforeunload', teardown);
    waitForAdmin();
  }


  async function context() {
    if (!window.MemberAdminSession || typeof window.MemberAdminSession.wait !== 'function') {
      throw clientError('AUTH_REQUIRED', '管理端登入服務尚未準備完成。');
    }
    const session = await window.MemberAdminSession.wait();
    config = session.config;
    return { config, idToken: session.idToken };
  }

  function clientError(code, message) { const error = new Error(message); error.code = code; return error; }

  async function requestFunction(functionName, action, payload = {}) {
    const ctx = await context();
    const endpoint = `${String(ctx.config.supabaseUrl || '').replace(/\/$/, '')}/functions/v1/${functionName}`;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', apikey: String(ctx.config.supabasePublishableKey || '') },
        body: JSON.stringify({ ...payload, action, clientType: 'admin', idToken: ctx.idToken }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok !== true) throw clientError(String(data?.error?.code || 'API_ERROR'), String(data?.error?.message || '預約服務拒絕此操作。'));
      return data.data || {};
    } catch (error) {
      if (error?.code) throw error;
      if (error?.name === 'AbortError') throw clientError('API_TIMEOUT', '預約服務回應逾時。');
      throw clientError('NETWORK_ERROR', '目前無法連線預約服務。');
    } finally { window.clearTimeout(timer); }
  }

  const cancellationRequest = (action, payload = {}) => requestFunction('booking-cancellation-api', action, payload);
  const bookingRequest = (action, payload = {}) => requestFunction('booking-api', action, payload);
  const contactRequest = (action, payload = {}) => requestFunction('booking-contact-api', action, payload);
  const groupDetailsRequest = (action, payload = {}) => requestFunction('booking-group-details-api', action, payload);

  function waitForAdmin() {
    if (!window.MemberAdminSession || typeof window.MemberAdminSession.wait !== 'function') return;
    window.MemberAdminSession.wait()
      .then(async () => {
        await refresh(false, true);
        await setupRealtime();
        setupPolling();
      })
      .catch(() => {});
  }

  function onSharedRealtimeInvalidation(event) {
    const detail = event?.detail || {};
    if (String(detail.clientType || '') !== 'admin') return;
    const scope = String(detail.scope || '');
    const type = String(detail.eventType || '');
    if ((scope === 'admin' || scope === 'all') && type.startsWith('booking.')) scheduleRefresh();
  }

  function onSharedRealtimeStatus(event) {
    const detail = event?.detail || {};
    if (String(detail.clientType || '') !== 'admin') return;
    realtimeConnected = String(detail.status || '') === 'SUBSCRIBED';
    setupPolling();
    if (realtimeConnected) scheduleRefresh();
  }

  function setupRealtime() {
    if (realtimeBound) return;
    window.addEventListener('member-system:realtime-invalidation', onSharedRealtimeInvalidation);
    window.addEventListener('member-system:realtime-status', onSharedRealtimeStatus);
    realtimeBound = true;
    realtimeConnected = window.MemberSystem?.getRealtimeStatus?.('admin') === 'SUBSCRIBED';
    setupPolling();
  }

  function isBackgroundE2ERunner() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('e2eBackgroundRunner') === '1' && Boolean(params.get('e2eRunId'));
    } catch {
      return false;
    }
  }

  function setupPolling() {
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    const interval = realtimeConnected && !isBackgroundE2ERunner() ? REALTIME_RECONCILE_MS : FALLBACK_POLL_MS;
    pollTimer = window.setTimeout(() => {
      pollTimer = null;
      if ((document.visibilityState === 'visible' || isBackgroundE2ERunner()) && navigator.onLine) {
        refresh(false, activeMode !== MODE_CORE);
      }
      setupPolling();
    }, interval);
  }

  function scheduleRefresh() {
    if (realtimeTimer !== null) return;
    realtimeTimer = window.setTimeout(() => {
      realtimeTimer = null;
      refresh(false, true);
    }, 350);
  }

  function onVisibilityChange() { if (document.visibilityState === 'visible') { scheduleRefresh(); setupPolling(); } }
  function onFocus() { if (document.visibilityState === 'visible') { scheduleRefresh(); setupPolling(); } }
  function onOnline() { scheduleRefresh(); setupPolling(); }

  function teardown() {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('online', onOnline);
    if (realtimeBound) {
      window.removeEventListener('member-system:realtime-invalidation', onSharedRealtimeInvalidation);
      window.removeEventListener('member-system:realtime-status', onSharedRealtimeStatus);
      realtimeBound = false;
    }
    if (realtimeTimer !== null) window.clearTimeout(realtimeTimer);
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    realtimeTimer = null; pollTimer = null;
    realtimeConnected = false;
  }

  function activateMode(mode) {
    activeMode = [MODE_REQUESTS, MODE_CANCELLED].includes(mode) ? mode : MODE_CORE;
    els.requestButton.classList.toggle('active', activeMode === MODE_REQUESTS);
    els.cancelledButton.classList.toggle('active', activeMode === MODE_CANCELLED);

    if (activeMode === MODE_CORE) {
      els.bookingCancellationReview.classList.add('hidden');
      els.coreQueue.classList.remove('hidden');
      if (!els.coreQueue.children.length) els.coreEmpty.classList.remove('hidden');
      return;
    }

    els.filter.querySelectorAll('[data-booking-filter]').forEach((button) => button.classList.remove('active'));
    els.coreQueue.classList.add('hidden');
    els.coreEmpty.classList.add('hidden');
    els.bookingCancellationReview.classList.remove('hidden');
    renderActiveMode();
    refresh(false, activeMode === MODE_CANCELLED);
  }

  async function refresh(showSuccess, includeBookings) {
    if (loading) {
      refreshQueued = true;
      refreshQueuedIncludeBookings = refreshQueuedIncludeBookings || Boolean(includeBookings);
      refreshQueuedShowSuccess = refreshQueuedShowSuccess || Boolean(showSuccess);
      return false;
    }
    if (document.visibilityState === 'hidden' && !isBackgroundE2ERunner()) return false;
    loading = true;
    const errors = [];
    try {
      try {
        const data = await cancellationRequest('admin.list');
        requestRows = Array.isArray(data.requests) ? data.requests : [];
      } catch (error) {
        errors.push(error?.message || '取消申請同步失敗。');
      }

      if (includeBookings) {
        try {
          const data = await bookingRequest('admin.booking.bootstrap');
          const cancelled = (Array.isArray(data.bookings) ? data.bookings : []).filter((booking) => booking.status === 'cancelled');
          const bookingIds = cancelled.map((booking) => String(booking.bookingId || '')).filter(Boolean);
          let contacts = [];
          let groups = {};
          if (bookingIds.length) {
            const [contactData, groupData] = await Promise.all([
              contactRequest('admin.booking.contacts', { bookingIds }),
              groupDetailsRequest('admin.booking.group.details', { bookingIds }),
            ]);
            contacts = Array.isArray(contactData?.contacts) ? contactData.contacts : [];
            groups = groupData?.bookingGroups && typeof groupData.bookingGroups === 'object' ? groupData.bookingGroups : {};
          }
          const contactsById = new Map(contacts.map((contact) => [String(contact.bookingId || ''), contact]));
          cancelledRows = cancelled.map((booking) => {
            const id = String(booking.bookingId || '');
            const group = groups[id] || null;
            return {
              ...booking,
              ...(contactsById.get(id) || {}),
              partySize: Math.max(1, Number(group?.partySize || 1)),
              participants: Array.isArray(group?.participants) && group.participants.length
                ? group.participants
                : [{ position: 1, technicianName: '現場安排', items: Array.isArray(booking.items) ? booking.items : [] }],
            };
          });
        } catch (error) {
          errors.push(error?.message || '已取消預約同步失敗。');
        }
      }

      updateFilterLabels();
      if (activeMode !== MODE_CORE) renderActiveMode();
      if (errors.length) showMessage(errors.join(' '), 'error');
      else if (showSuccess) showMessage('取消預約資料已更新。', 'success');
      else clearMessage();
    } finally {
      loading = false;
      if (refreshQueued) {
        const queuedIncludeBookings = refreshQueuedIncludeBookings;
        const queuedShowSuccess = refreshQueuedShowSuccess;
        refreshQueued = false;
        refreshQueuedIncludeBookings = false;
        refreshQueuedShowSuccess = false;
        window.setTimeout(() => { refresh(queuedShowSuccess, queuedIncludeBookings); }, 0);
      }
    }
    return true;
  }

  function updateFilterLabels() {
    els.requestButton.textContent = requestRows.length ? `取消申請（${requestRows.length}）` : '取消申請';
    els.cancelledButton.textContent = cancelledRows.length ? `已取消（${cancelledRows.length}）` : '已取消';
  }

  function timestampValue(value) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function compareCancellationRequestsNewestFirst(a, b) {
    const timestampDiff = timestampValue(b?.cancellationRequestedAt || b?.updatedAt) - timestampValue(a?.cancellationRequestedAt || a?.updatedAt);
    if (timestampDiff) return timestampDiff;
    return String(b?.bookingId || '').localeCompare(String(a?.bookingId || ''));
  }

  function compareCancelledNewestFirst(a, b) {
    const timestampDiff = timestampValue(b?.cancelledAt || b?.updatedAt || b?.createdAt) - timestampValue(a?.cancelledAt || a?.updatedAt || a?.createdAt);
    if (timestampDiff) return timestampDiff;
    return String(b?.bookingId || '').localeCompare(String(a?.bookingId || ''));
  }

  function renderActiveMode() {
    if (activeMode === MODE_REQUESTS) renderRequests();
    else if (activeMode === MODE_CANCELLED) renderCancelled();
  }

  function renderRequests() {
    els.bookingCancellationReviewKicker.textContent = 'Cancellation requests';
    els.bookingCancellationReviewTitle.textContent = '取消申請';
    els.bookingCancellationReviewDescription.textContent = '會員申請取消後，原預約時段仍保留；管理端確認取消後才會重新開放。';
    els.bookingCancellationReviewCount.className = 'booking-admin-status status-pending';
    renderRows(requestRows.slice().sort(compareCancellationRequestsNewestFirst), '目前沒有待確認的取消申請', requestCard);
  }

  function renderCancelled() {
    els.bookingCancellationReviewKicker.textContent = 'Cancelled bookings';
    els.bookingCancellationReviewTitle.textContent = '已取消';
    els.bookingCancellationReviewDescription.textContent = '顯示已完成取消的預約紀錄；此分頁僅供查詢，不會重新開放或變更其他預約。';
    els.bookingCancellationReviewCount.className = 'booking-admin-status status-cancelled';
    renderRows(cancelledRows.slice().sort(compareCancelledNewestFirst), '目前沒有已取消的預約', cancelledCard);
  }

  function renderRows(rows, emptyText, cardFactory) {
    els.bookingCancellationReviewList.replaceChildren();
    els.bookingCancellationReviewCount.textContent = `${rows.length} 筆`;
    const emptyParagraph = els.bookingCancellationReviewEmpty.querySelector('p');
    if (emptyParagraph) emptyParagraph.textContent = emptyText;
    els.bookingCancellationReviewEmpty.classList.toggle('hidden', rows.length > 0);
    rows.forEach((row) => els.bookingCancellationReviewList.appendChild(cardFactory(row)));
  }

  function requestCard(row) {
    return bookingCard(row, {
      badgeClass: 'status-pending',
      badgeText: '取消待確認',
      footerText: `原狀態：${row.sourceStatus === 'confirmed' ? '已確認' : '待確認'} · 申請時間：${formatDateTime(row.cancellationRequestedAt)}`,
      actions: true,
    });
  }

  function cancelledCard(row) {
    return bookingCard(row, {
      badgeClass: 'status-cancelled',
      badgeText: '已取消',
      footerText: row.updatedAt ? `最後更新：${formatDateTime(row.updatedAt)}` : '',
      actions: false,
    });
  }

  function bookingCard(row, options) {
    const article = document.createElement('article');
    article.className = 'booking-admin-booking booking-summary-normalized';
    article.dataset.bookingId = String(row.bookingId || '');
    article.dataset.bookingDate = String(row.bookingDate || '');
    article.dataset.bookingStartTime = String(row.startTime || '');
    article.dataset.bookingEndTime = String(row.endTime || '');
    article.dataset.bookingStartAt = String(row.startAt || '');
    article.dataset.bookingEndAt = String(row.endAt || '');
    article.dataset.bookingCopyContactName = bookingContactName(row);
    article.dataset.bookingCopyPhone = String(row.contactPhone || '—');
    article.dataset.bookingCopyGroup = JSON.stringify({ partySize: row.partySize || row.participants?.length || 1, participants: row.participants?.length ? row.participants : Number(row.partySize || 1) === 1 ? [{ position: 1, technicianName: row.technicianName || '現場安排', items: row.items || [] }] : [] });
    article.dataset.bookingCopyItems = JSON.stringify(row.items || []);

    const heading = document.createElement('div');
    heading.className = 'booking-admin-booking-heading';
    const identity = document.createElement('div');
    const memberName = document.createElement('strong');
    memberName.textContent = row.memberDisplayName || '會員';
    const memberCode = document.createElement('small');
    memberCode.textContent = row.memberCode || '無會員編號';
    identity.append(memberName, memberCode);
    const badge = document.createElement('span');
    badge.className = `booking-admin-status ${options.badgeClass}`;
    badge.textContent = options.badgeText;
    heading.append(identity, badge);
    article.appendChild(heading);

    const summary = document.createElement('div');
    summary.className = 'booking-received-summary';

    const memberMeta = document.createElement('div');
    memberMeta.className = 'booking-member-meta';
    memberMeta.append(
      summaryMetaItem('LINE 名稱', String(row.memberDisplayName || '未取得')),
      summaryMetaItem('會員編號', String(row.memberCode || '未取得')),
      summaryMetaItem('總服務時間', `${Math.max(0, Number(row.totalDurationMinutes || 0))} 分鐘`),
      summaryMetaItem('總金額', formatMoney(row.totalAmount) || 'NT$0'),
    );
    summary.appendChild(memberMeta);

    const dateTime = document.createElement('p');
    dateTime.className = 'booking-received-datetime';
    dateTime.textContent = bookingDateTime(row);
    summary.appendChild(dateTime);

    const name = document.createElement('p');
    name.className = 'booking-received-name';
    name.textContent = bookingContactName(row);
    summary.appendChild(name);

    const phone = document.createElement('p');
    phone.className = 'booking-received-phone';
    phone.textContent = `電話：${String(row.contactPhone || '—')}`;
    summary.appendChild(phone);

    appendParticipants(summary, row.participants || []);

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'booking-copy-button';
    copyButton.dataset.bookingAdminAction = 'copy-booking';
    copyButton.textContent = '複製預約內容';
    copyButton.setAttribute('aria-label', `複製 ${bookingContactName(row)} 的預約內容`);
    copyButton.addEventListener('click', () => copyBooking(copyButton, row));
    summary.appendChild(copyButton);

    article.appendChild(summary);

    if (options.footerText) appendNote(article, options.footerText, true);
    if (row.memberNote) appendNote(article, `會員備註：${row.memberNote}`, false);
    if (row.adminNote) appendNote(article, `管理端說明：${row.adminNote}`, true);

    if (options.actions) {
      const actions = document.createElement('div');
      actions.className = 'booking-admin-actions';
      const keep = document.createElement('button');
      keep.type = 'button';
      keep.className = 'button button-outline';
      keep.dataset.bookingAdminAction = 'reject-cancellation';
      keep.textContent = '保留預約';
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'button button-danger';
      approve.dataset.bookingAdminAction = 'approve-cancellation';
      approve.textContent = '確認取消';
      keep.addEventListener('click', () => review(row, 'admin.reject', actions));
      approve.addEventListener('click', () => review(row, 'admin.approve', actions));
      actions.append(keep, approve);
      article.appendChild(actions);
    }

    return article;
  }

  function summaryMetaItem(label, value) {
    const item = document.createElement('div');
    item.className = 'booking-member-meta-item';
    const key = document.createElement('span');
    key.className = 'booking-member-meta-label';
    key.textContent = label;
    const content = document.createElement('strong');
    content.textContent = value;
    item.append(key, content);
    return item;
  }

  function bookingContactName(row) {
    const surname = String(row?.contactSurname || '').trim();
    const salutation = String(row?.contactSalutation || '').trim().toLowerCase();
    const label = salutation === 'mr' ? '先生' : salutation === 'ms' ? '小姐' : '';
    return surname && label ? `${surname}${label}` : '未取得預約人資料';
  }

  function appendParticipants(container, participants) {
    const rows = Array.isArray(participants) ? participants : [];
    if (!rows.length) return;
    const box = document.createElement('section');
    box.className = 'booking-group-admin-details';
    box.setAttribute('aria-label', '逐位預約明細');
    rows.forEach((participant, index) => {
      const block = document.createElement('div');
      block.className = 'booking-group-admin-participant';
      const heading = document.createElement('strong');
      heading.textContent = participantLabel(Number(participant.position || index + 1) - 1);
      const items = document.createElement('p');
      items.textContent = `預約項目：${participantItemsLabel(participant.items)}`;
      const technician = document.createElement('p');
      technician.textContent = `預約技師：${String(participant.technicianName || '現場安排').replace(/（主要技師）/g, '').trim() || '現場安排'}`;
      block.append(heading, items, technician);
      box.appendChild(block);
    });
    container.appendChild(box);
  }

  function participantItemsLabel(items) {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) return '—';
    return rows.map((item) => {
      const title = String(item.serviceTitle || '預約項目').trim();
      const quantity = Math.max(1, Number(item.quantity || 1));
      return quantity > 1 ? `${title} × ${quantity}` : title;
    }).join('、');
  }

  function participantLabel(index) {
    const names = ['第一', '第二', '第三', '第四', '第五', '第六', '第七', '第八', '第九', '第十'];
    return `${names[index] || `第 ${index + 1} `}位預約`;
  }

  function appendNote(article, text, admin) {
    const note = document.createElement('p');
    note.className = `booking-admin-note${admin ? ' admin' : ''}`;
    note.textContent = text;
    article.appendChild(note);
  }

  async function copyBooking(button, booking) {
    if (button.disabled) return;
    const originalLabel = button.textContent;
    button.disabled = true;
    try {
      await copyText(buildBookingCopyText(booking));
      button.textContent = '已複製';
    } catch (_) {
      button.textContent = '複製失敗';
    } finally {
      window.setTimeout(() => {
        button.disabled = false;
        button.textContent = originalLabel;
      }, 1500);
    }
  }

  function buildBookingCopyText(booking) {
    const lines = [
      bookingDateTime(booking),
      bookingContactName(booking),
      `電話：${String(booking.contactPhone || '—')}`,
      '服務項目：',
    ];
    const participants = Array.isArray(booking.participants) ? booking.participants : [];
    const items = participants.length
      ? participants.flatMap((participant) => Array.isArray(participant.items) ? participant.items : [])
      : Array.isArray(booking.items) ? booking.items : [];
    const visible = items.filter((item) => String(item?.serviceTitle || '').trim());
    if (!visible.length) lines.push('尚無會員服務項目');
    else visible.forEach((item) => {
      const quantity = Math.max(1, Number(item.quantity || 1));
      const title = String(item.serviceTitle || '服務項目').trim();
      for (let index = 0; index < quantity; index += 1) lines.push(title);
    });
    return lines.join('\n');
  }

  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.className = 'booking-cancellation-copy-buffer';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('COPY_FAILED');
  }

  async function review(row, action, actions) {
    const approving = action === 'admin.approve';
    const message = approving
      ? `確認取消 ${row.memberDisplayName || '此會員'} ${bookingDateTime(row)} 的預約？\n\n確認後原時段會重新開放。`
      : `確定保留 ${row.memberDisplayName || '此會員'} 的原預約？`;
    if (!window.confirm(message)) return;
    actions.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      await cancellationRequest(action, { bookingId: row.bookingId, expectedUpdatedAt: row.updatedAt });
      showMessage(approving ? '已確認取消，原預約時段已重新開放。' : '已保留預約，取消申請已結束。', 'success');
      await refresh(false, true);
      document.getElementById('bookingAdminRefreshButton')?.click();
    } catch (error) {
      showMessage(error?.message || '取消申請處理失敗。', 'error');
      actions.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    }
  }

  function showMessage(message, type) { els.bookingCancellationReviewMessage.textContent = message; els.bookingCancellationReviewMessage.className = `form-message ${type}`; }
  function clearMessage() { els.bookingCancellationReviewMessage.textContent = ''; els.bookingCancellationReviewMessage.className = 'form-message hidden'; }
  function formatBookingDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return String(value || '—');
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const weekday = weekdays[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] || '';
    return `${month}/${day}（${weekday}）`;
  }
  function formatDate(value) { return formatBookingDate(value); }
  function bookingDateTime(row) {
    const startDate = String(row.startAt || '').slice(0, 10) || row.bookingDate;
    const endDate = String(row.endAt || '').slice(0, 10) || row.bookingDate;
    return `營業日 ${row.bookingDate}｜${String(row.startTime || '—').slice(0, 5)}–${String(row.endTime || '—').slice(0, 5)}${endDate > startDate ? '（隔日）' : ''}`;
  }
  function formatDateTime(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-Hant-TW', { timeZone: 'Asia/Taipei', hour12: false }); }
  function formatMoney(value) { const amount = Number(value || 0); return Number.isFinite(amount) ? `NT$${Math.round(amount).toLocaleString('zh-Hant-TW')}` : ''; }
})();
