(() => {
  'use strict';

  if (!window.MemberSystem || typeof window.MemberSystem.request !== 'function') return;

  const base = window.MemberSystem;
  const originalRequest = base.request.bind(base);
  const calendarCache = new Map();
  const EVENT_TICKET_TIER_LABELS = { general: '一般會員', silver: '銀級會員', gold: '金級會員', platinum: '白金會員' };
  let lastCalendarItemId = null;
  let lastEventTicketId = null;
  let lastAdminConfig = null;
  let lastAdminIdToken = '';
  let eventCalendarSyncVersion = 0;
  let managedCalendarInfoOpener = null;
  let managedCalendarObserver = null;

  function cacheCalendarResult(result) {
    if (!result || typeof result !== 'object') return result;
    const rows = Array.isArray(result.calendarItems) ? result.calendarItems : [];
    rows.forEach((item) => {
      if (item && item.calendarItemId) calendarCache.set(String(item.calendarItemId), item);
    });
    if (result.calendarItem && result.calendarItem.calendarItemId) {
      calendarCache.set(String(result.calendarItem.calendarItemId), result.calendarItem);
    }
    return result;
  }

  function clientError(code, message, status = 0, details = null) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.details = details;
    return error;
  }

  async function automationRequest(config, idToken, action, payload) {
    const url = String(config && config.supabaseGrantAutomationUrl || '').trim();
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/grant-automation$/i.test(url)) {
      throw clientError('CONFIG_ERROR', '尚未設定發放自動化 Edge Function URL。');
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = window.setTimeout(() => { if (controller) controller.abort(); }, 30000);
    let response;
    let text;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': String(config.supabasePublishableKey || '') },
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
        body: JSON.stringify({ ...payload, action, clientType: 'admin', idToken })
      });
      text = await response.text();
    } catch (_) {
      throw clientError('API_RESPONSE_UNCERTAIN', '無法確認這次操作是否已送達；請先重新整理確認，請勿重複送出。');
    } finally {
      window.clearTimeout(timer);
    }
    let data;
    try { data = JSON.parse(text); }
    catch { throw clientError('API_RESPONSE_UNCERTAIN', '資料服務回應格式異常；請先重新整理確認，請勿重複送出。'); }
    if (!data || data.ok !== true) {
      throw clientError(data && data.error && data.error.code || 'API_ERROR', data && data.error && data.error.message || '資料服務拒絕此請求。', Number(data && data.status || response.status || 0), data && data.error && data.error.details || null);
    }
    return cacheCalendarResult(data.data || {});
  }

  function selectedNotificationMode() {
    const selected = document.querySelector('input[name="grantNotificationMode"]:checked');
    return selected ? String(selected.value) : 'immediate';
  }

  function scheduledAtIso() {
    const input = document.getElementById('grantNotificationScheduledAt');
    const value = String(input && input.value || '').trim();
    if (!value) return '';
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return value;
    return `${value}:00+08:00`;
  }

  function decorateGrantPayload(payload) {
    const mode = selectedNotificationMode();
    return {
      ...payload,
      notificationMode: mode,
      scheduledAt: mode === 'scheduled' ? scheduledAtIso() : ''
    };
  }

  function decorateCalendarPayload(payload) {
    const item = payload && payload.calendarItem && typeof payload.calendarItem === 'object' ? payload.calendarItem : {};
    const enabled = Boolean(document.getElementById('calendarBonusPointsEnabled')?.checked) && String(item.itemType || '') === 'event';
    const amount = enabled ? Number(document.getElementById('calendarBonusPoints')?.value || 0) : 0;
    return {
      ...payload,
      calendarItem: { ...item, bonusPointsEnabled: enabled, bonusPoints: amount }
    };
  }

  async function mergeCalendarBonusList(config, idToken, result) {
    cacheCalendarResult(result);
    try {
      const bonusResult = await automationRequest(config, idToken, 'admin.calendar-items.list', {});
      if (Array.isArray(bonusResult.calendarItems)) result.calendarItems = bonusResult.calendarItems;
    } catch (_) {
      // Bootstrap must remain usable if the optional extension endpoint is unavailable.
    }
    return cacheCalendarResult(result);
  }

  function eventTicketCalendarLink(eventTicketId) {
    const url = new URL('../event/', window.location.href);
    url.searchParams.set('source', 'event-ticket-calendar');
    url.searchParams.set('eventTicketId', String(eventTicketId || '').trim());
    return url.toString();
  }

  function eventTicketIdFromCalendarItem(item) {
    if (!item || String(item.itemType || '') !== 'event') return '';
    try {
      const url = new URL(String(item.linkUrl || ''), window.location.href);
      return url.searchParams.get('source') === 'event-ticket-calendar'
        ? String(url.searchParams.get('eventTicketId') || '').trim()
        : '';
    } catch (_) {
      return '';
    }
  }

  function isManagedEventTicketCalendarItem(item, eventTicketId) {
    const expectedId = String(eventTicketId || '').trim();
    return Boolean(expectedId && eventTicketIdFromCalendarItem(item) === expectedId);
  }

  function managedEventTicketCalendarItemById(calendarItemId) {
    const item = calendarCache.get(String(calendarItemId || '').trim()) || null;
    return eventTicketIdFromCalendarItem(item) ? item : null;
  }

  function assertCalendarDeleteAllowed(action, payload) {
    const directItemId = String(payload && payload.calendarItem && payload.calendarItem.calendarItemId || payload && payload.calendarItemId || '').trim();
    if ((action === 'admin.calendar-items.save' || action === 'admin.calendar-items.delete') && managedEventTicketCalendarItemById(directItemId)) {
      throw clientError(
        'EVENT_TICKET_CALENDAR_MANAGED',
        action === 'admin.calendar-items.delete'
          ? '此活動由活動票券管理，請至活動票券取消「加入日曆」或刪除票券。'
          : '此活動由活動票券管理，日曆中只能查看資訊；請至活動票券修改設定。',
        409
      );
    }
    if (action === 'admin.calendar-items.batch') {
      const operations = Array.isArray(payload && payload.calendarItemOperations) ? payload.calendarItemOperations : [];
      const hasManagedOperation = operations.some((operation) => {
        const calendarItemId = String(operation && (operation.calendarItemId || operation.calendarItem && operation.calendarItem.calendarItemId) || '').trim();
        return Boolean(calendarItemId && managedEventTicketCalendarItemById(calendarItemId));
      });
      if (hasManagedOperation) {
        throw clientError(
          'EVENT_TICKET_CALENDAR_MANAGED',
          '選取項目包含由活動票券管理的活動；這類活動在日曆中只能查看資訊，不能批次修改或刪除。',
          409
        );
      }
    }
  }

  function syncManagedEventTicketDeleteButton() {
    const calendarItemId = String(document.getElementById('calendarItemId')?.value || '').trim();
    const item = managedEventTicketCalendarItemById(calendarItemId);
    const button = document.getElementById('deleteCalendarItemButton');
    if (!button) return;
    if (item) {
      button.disabled = true;
      button.textContent = '由活動票券管理';
      button.title = '請至活動票券取消「加入日曆」或刪除票券。';
    } else if (button.title) {
      button.removeAttribute('title');
    }
  }

  function managedEventTicketStatusLabel(value) {
    const status = String(value || 'draft');
    return status === 'active' ? '啟用中' : status === 'archived' ? '已封存' : '草稿';
  }

  function managedEventTicketDateRange(item) {
    const startsOn = String(item && item.startsOn || '').trim();
    const endsOn = String(item && item.endsOn || '').trim();
    if (!startsOn) return '未設定';
    return endsOn && endsOn !== startsOn ? `${startsOn} ～ ${endsOn}` : startsOn;
  }

  function managedEventTicketTierLabels(item) {
    const keys = Array.isArray(item && item.allowedTierKeys) ? item.allowedTierKeys : [];
    if (!keys.length) return '未設定';
    return keys.map((key) => EVENT_TICKET_TIER_LABELS[String(key)] || String(key)).join('、');
  }

  function createManagedEventTicketInfoRow(labelText, valueText) {
    const row = document.createElement('p');
    const label = document.createElement('strong');
    const value = document.createElement('span');
    label.textContent = String(labelText || '');
    value.textContent = String(valueText || '');
    row.append(label, document.createElement('br'), value);
    return row;
  }

  function closeManagedEventTicketInfo(restoreFocus = true) {
    const modal = document.getElementById('eventTicketCalendarInfoModal');
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    const opener = managedCalendarInfoOpener;
    managedCalendarInfoOpener = null;
    if (restoreFocus && opener && document.contains(opener)) opener.focus();
  }

  function ensureManagedEventTicketInfoModal() {
    let modal = document.getElementById('eventTicketCalendarInfoModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'eventTicketCalendarInfoModal';
    modal.className = 'modal editor-modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'eventTicketCalendarInfoTitle');

    const card = document.createElement('div');
    card.className = 'modal-card editor-modal-card';
    const heading = document.createElement('div');
    heading.className = 'editor-heading';
    const headingText = document.createElement('div');
    const kicker = document.createElement('p');
    kicker.className = 'kicker';
    kicker.textContent = 'Activity ticket calendar';
    const title = document.createElement('h3');
    title.id = 'eventTicketCalendarInfoTitle';
    title.textContent = '活動票券資訊';
    headingText.append(kicker, title);
    const actions = document.createElement('div');
    actions.className = 'editor-heading-actions';
    const closeButton = document.createElement('button');
    closeButton.id = 'closeEventTicketCalendarInfoButton';
    closeButton.type = 'button';
    closeButton.className = 'button button-outline';
    closeButton.textContent = '關閉';
    actions.append(closeButton);
    heading.append(headingText, actions);

    const notice = document.createElement('p');
    notice.className = 'editor-hint';
    notice.textContent = '此項目由活動票券同步管理，日曆中僅供查看；如需修改或移除，請至「活動票券」設定。';
    const content = document.createElement('section');
    content.id = 'eventTicketCalendarInfoContent';
    content.className = 'calendar-event-link-fields';
    card.append(heading, notice, content);
    modal.append(card);
    document.body.append(modal);

    closeButton.addEventListener('click', () => closeManagedEventTicketInfo());
    modal.addEventListener('click', (event) => {
      if (event.target !== modal) return;
      const coarsePointer = typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
      if (coarsePointer) closeManagedEventTicketInfo();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeManagedEventTicketInfo();
    });
    return modal;
  }

  function openManagedEventTicketInfo(item, opener) {
    if (!item || !eventTicketIdFromCalendarItem(item)) return;
    const modal = ensureManagedEventTicketInfoModal();
    const content = document.getElementById('eventTicketCalendarInfoContent');
    const title = document.getElementById('eventTicketCalendarInfoTitle');
    const ticketId = eventTicketIdFromCalendarItem(item);
    if (!content || !title) return;
    title.textContent = String(item.title || '活動票券資訊');
    const rows = [
      createManagedEventTicketInfoRow('來源', '活動票券同步'),
      createManagedEventTicketInfoRow('活動票券識別', ticketId),
      createManagedEventTicketInfoRow('活動期間', managedEventTicketDateRange(item)),
      createManagedEventTicketInfoRow('公開狀態', managedEventTicketStatusLabel(item.status)),
      createManagedEventTicketInfoRow('適用會員等級', managedEventTicketTierLabels(item)),
      createManagedEventTicketInfoRow('票券說明', String(item.description || '尚未提供說明。'))
    ];
    if (item.bonusPointsEnabled) rows.push(createManagedEventTicketInfoRow('活動加贈點數', `每張本次發放集點卡 +${Number(item.bonusPoints || 0)} 點`));
    content.replaceChildren(...rows);
    managedCalendarInfoOpener = opener instanceof HTMLElement ? opener : null;
    modal.classList.remove('hidden');
    document.getElementById('closeEventTicketCalendarInfoButton')?.focus();
  }

  function decorateManagedEventTicketCalendarRows() {
    const grid = document.getElementById('adminCalendarGrid');
    if (!grid) return;
    grid.querySelectorAll('[data-admin-calendar-item-id]').forEach((button) => {
      const calendarItemId = String(button.dataset.adminCalendarItemId || '').trim();
      const item = managedEventTicketCalendarItemById(calendarItemId);
      if (!item) return;
      const row = button.closest('.admin-calendar-item-row');
      if (row) {
        row.dataset.eventTicketCalendarManaged = 'true';
        row.classList.remove('is-selected-for-batch');
        row.querySelector('[data-admin-calendar-item-select]')?.remove();
      }
      button.dataset.eventTicketCalendarReadonly = 'true';
      button.setAttribute('aria-label', `查看活動票券資訊：${String(item.title || '未命名活動')}`);
      button.title = '由活動票券管理；點擊查看資訊';
    });
  }

  function handleManagedEventTicketCalendarClick(event) {
    const button = event.target instanceof Element ? event.target.closest('[data-admin-calendar-item-id]') : null;
    if (!button) return;
    const item = managedEventTicketCalendarItemById(button.dataset.adminCalendarItemId);
    if (!item) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openManagedEventTicketInfo(item, button);
  }

  function handleManagedEventTicketCalendarSelection(event) {
    const input = event.target instanceof HTMLInputElement ? event.target.closest('[data-admin-calendar-item-select]') : null;
    if (!input) return;
    const item = managedEventTicketCalendarItemById(input.dataset.adminCalendarItemSelect);
    if (!item) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    input.checked = false;
    decorateManagedEventTicketCalendarRows();
  }

  function bindManagedEventTicketCalendarReadOnly() {
    const grid = document.getElementById('adminCalendarGrid');
    if (!grid) return;
    grid.addEventListener('click', handleManagedEventTicketCalendarClick, true);
    grid.addEventListener('change', handleManagedEventTicketCalendarSelection, true);
    if (typeof MutationObserver !== 'undefined') {
      managedCalendarObserver = new MutationObserver(() => decorateManagedEventTicketCalendarRows());
      managedCalendarObserver.observe(grid, { childList: true, subtree: true });
    }
    decorateManagedEventTicketCalendarRows();
  }

  async function fetchCalendarItemsForEventSync(config, idToken) {
    const result = await automationRequest(config, idToken, 'admin.calendar-items.list', {});
    return Array.isArray(result.calendarItems) ? result.calendarItems : [];
  }

  function setEventTicketCalendarStatus(message) {
    const status = document.getElementById('eventTicketCalendarStatus');
    if (status) status.textContent = String(message || '');
  }

  function setEventTicketFormMessage(message) {
    const box = document.getElementById('eventTicketFormMessage');
    if (!box) return;
    box.textContent = String(message || '');
    box.classList.remove('hidden');
  }

  function updateEventTicketCalendarHint() {
    const checkbox = document.getElementById('eventTicketAddToCalendar');
    if (!checkbox || checkbox.disabled) return;
    setEventTicketCalendarStatus(checkbox.checked
      ? '儲存票券時，會同步建立或更新日曆中的「活動」；休假日不顯示活動，移除休假後會自動恢復。'
      : '目前不加入日曆；若先前已同步，儲存後會從日曆移除。');
  }

  function handleEventTicketCalendarSubmitCapture(event) {
    const checkbox = document.getElementById('eventTicketAddToCalendar');
    if (!checkbox || checkbox.disabled || !checkbox.checked) return;
    const startsOn = String(document.getElementById('eventTicketStartsOn')?.value || '').trim();
    if (startsOn) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const message = '要加入日曆時，活動票券必須設定開始日。';
    setEventTicketCalendarStatus(message);
    setEventTicketFormMessage(message);
    document.getElementById('eventTicketStartsOn')?.focus();
  }

  async function syncEventTicketCalendarChoiceFromSelection(force = false) {
    const eventTicketId = String(document.getElementById('eventTicketId')?.value || '').trim();
    if (!force && eventTicketId === lastEventTicketId) return;
    lastEventTicketId = eventTicketId;
    const checkbox = document.getElementById('eventTicketAddToCalendar');
    if (!checkbox) return;
    if (!eventTicketId) {
      checkbox.checked = false;
      checkbox.disabled = false;
      checkbox.dataset.syncUnknown = '0';
      updateEventTicketCalendarHint();
      return;
    }
    if (!lastAdminConfig || !lastAdminIdToken) return;
    const version = ++eventCalendarSyncVersion;
    checkbox.disabled = true;
    checkbox.dataset.syncUnknown = '1';
    setEventTicketCalendarStatus('正在確認這張票券的日曆設定…');
    try {
      const rows = await fetchCalendarItemsForEventSync(lastAdminConfig, lastAdminIdToken);
      if (version !== eventCalendarSyncVersion || String(document.getElementById('eventTicketId')?.value || '').trim() !== eventTicketId) return;
      checkbox.checked = rows.some((item) => isManagedEventTicketCalendarItem(item, eventTicketId));
      checkbox.disabled = false;
      checkbox.dataset.syncUnknown = '0';
      updateEventTicketCalendarHint();
    } catch (_) {
      if (version !== eventCalendarSyncVersion) return;
      checkbox.disabled = true;
      checkbox.dataset.syncUnknown = '1';
      setEventTicketCalendarStatus('暫時無法確認日曆設定；本次儲存票券時會保留原本的日曆狀態。');
    }
  }

  async function syncEventTicketCalendarAfterSave(config, idToken, result) {
    const ticket = result && result.eventTicket && typeof result.eventTicket === 'object' ? result.eventTicket : null;
    if (!ticket || !ticket.eventTicketId) return;
    const checkbox = document.getElementById('eventTicketAddToCalendar');
    if (!checkbox || checkbox.dataset.syncUnknown === '1') return;
    const enabled = Boolean(checkbox.checked);
    try {
      const rows = await fetchCalendarItemsForEventSync(config, idToken);
      const existing = rows.find((item) => isManagedEventTicketCalendarItem(item, ticket.eventTicketId)) || null;
      if (!enabled) {
        if (existing && existing.calendarItemId) {
          await originalRequest(config, 'admin', idToken, 'admin.calendar-items.delete', {
            calendarItemId: existing.calendarItemId,
            expectedUpdatedAt: String(existing.updatedAt || '')
          });
          calendarCache.delete(String(existing.calendarItemId));
          setEventTicketCalendarStatus('活動票券已儲存，並已從日曆移除。');
        } else {
          setEventTicketCalendarStatus('活動票券已儲存，目前未加入日曆。');
        }
        return;
      }
      const startsOn = String(ticket.startsOn || '').trim();
      if (!startsOn) {
        setEventTicketCalendarStatus('活動票券已儲存，但缺少開始日，因此未加入日曆。');
        return;
      }
      const calendarItem = {
        calendarItemId: existing ? String(existing.calendarItemId || '') : '',
        title: String(ticket.title || '活動票券'),
        itemType: 'event',
        description: String(ticket.description || ''),
        startsOn,
        endsOn: String(ticket.endsOn || ''),
        status: String(ticket.status || 'draft'),
        accent: String(ticket.accent || '#df6b4d'),
        allowedTierKeys: Array.isArray(ticket.allowedTierKeys) ? ticket.allowedTierKeys : [],
        linkLabel: '查看活動票券',
        linkUrl: eventTicketCalendarLink(ticket.eventTicketId),
        bonusPointsEnabled: Boolean(existing && existing.bonusPointsEnabled),
        bonusPoints: existing && Number(existing.bonusPoints) > 0 ? Number(existing.bonusPoints) : 0
      };
      const saved = await automationRequest(config, idToken, 'admin.calendar-items.save', {
        calendarItem,
        expectedUpdatedAt: existing ? String(existing.updatedAt || '') : ''
      });
      cacheCalendarResult(saved);
      setEventTicketCalendarStatus(existing
        ? '活動票券已儲存，日曆活動已同步更新。'
        : '活動票券已儲存，並已加入日曆。');
    } catch (error) {
      setEventTicketCalendarStatus(`活動票券已儲存，但日曆同步失敗：${String(error && error.message || '請稍後重試')}`);
    }
  }

  async function saveEventTicketWithCalendarSync(config, clientType, idToken, action, payload) {
    const result = cacheCalendarResult(await originalRequest(config, clientType, idToken, action, payload));
    await syncEventTicketCalendarAfterSave(config, idToken, result);
    return result;
  }

  async function deleteEventTicketWithCalendarCleanup(config, clientType, idToken, action, payload) {
    const eventTicketId = String(payload && payload.eventTicketId || '').trim();
    const result = cacheCalendarResult(await originalRequest(config, clientType, idToken, action, payload));
    if (!eventTicketId) return result;
    try {
      const rows = await fetchCalendarItemsForEventSync(config, idToken);
      const existing = rows.find((item) => isManagedEventTicketCalendarItem(item, eventTicketId));
      if (existing && existing.calendarItemId) {
        await originalRequest(config, 'admin', idToken, 'admin.calendar-items.delete', {
          calendarItemId: existing.calendarItemId,
          expectedUpdatedAt: String(existing.updatedAt || '')
        });
        calendarCache.delete(String(existing.calendarItemId));
      }
    } catch (_) {
      // Deleting the ticket remains the primary operation; stale calendar cleanup can be retried later.
    }
    return result;
  }

  function request(config, clientType, idToken, action, payload = {}) {
    if (clientType === 'admin') {
      lastAdminConfig = config;
      lastAdminIdToken = idToken;
    }
    if (clientType === 'admin') assertCalendarDeleteAllowed(action, payload);
    if (clientType === 'admin' && action === 'admin.member-grants.add') {
      return automationRequest(config, idToken, action, decorateGrantPayload(payload));
    }
    if (clientType === 'admin' && action === 'admin.calendar-items.save') {
      return automationRequest(config, idToken, action, decorateCalendarPayload(payload));
    }
    if (clientType === 'admin' && action === 'admin.calendar-items.list') {
      return automationRequest(config, idToken, action, payload);
    }
    if (clientType === 'admin' && action === 'admin.event-tickets.save') {
      return saveEventTicketWithCalendarSync(config, clientType, idToken, action, payload);
    }
    if (clientType === 'admin' && action === 'admin.event-tickets.delete') {
      return deleteEventTicketWithCalendarCleanup(config, clientType, idToken, action, payload);
    }
    if (clientType === 'admin' && action === 'admin.bootstrap') {
      return Promise.resolve(originalRequest(config, clientType, idToken, action, payload)).then((result) => mergeCalendarBonusList(config, idToken, result));
    }
    return Promise.resolve(originalRequest(config, clientType, idToken, action, payload)).then(cacheCalendarResult);
  }

  window.MemberSystem = Object.freeze({ ...base, request });

  function createGrantNotificationControls() {
    const form = document.getElementById('grantForm');
    const selector = form && form.querySelector('.grant-message-selector');
    if (!form || !selector || document.getElementById('grantNotificationControls')) return;
    const fieldset = document.createElement('fieldset');
    fieldset.id = 'grantNotificationControls';
    fieldset.className = 'grant-option';
    fieldset.innerHTML = `
      <legend>LINE 訊息傳送</legend>
      <div class="grant-option-fields">
        <div class="form-grid">
          <label class="grant-toggle"><input type="radio" name="grantNotificationMode" value="immediate" checked>立即傳送</label>
          <label class="grant-toggle"><input type="radio" name="grantNotificationMode" value="scheduled">預約傳送</label>
          <label class="grant-toggle"><input type="radio" name="grantNotificationMode" value="none">不傳送</label>
        </div>
        <label id="grantNotificationScheduledField" class="hidden">預約傳送時間（台灣時間）
          <input id="grantNotificationScheduledAt" type="datetime-local" step="60">
          <small class="field-help">點數與服務時間會立即入帳，只有 LINE 訊息延後傳送。</small>
        </label>
        <p id="grantNotificationHint" class="editor-hint">目前設定：發放完成後立即傳送 LINE 訊息。</p>
      </div>`;
    selector.insertAdjacentElement('afterend', fieldset);
    fieldset.addEventListener('change', updateGrantNotificationControls);
    form.addEventListener('reset', () => window.setTimeout(() => {
      const immediate = form.querySelector('input[name="grantNotificationMode"][value="immediate"]');
      if (immediate) immediate.checked = true;
      const scheduled = document.getElementById('grantNotificationScheduledAt');
      if (scheduled) scheduled.value = '';
      updateGrantNotificationControls();
    }, 0));
    updateGrantNotificationControls();
  }

  function updateGrantNotificationControls() {
    const mode = selectedNotificationMode();
    const field = document.getElementById('grantNotificationScheduledField');
    const input = document.getElementById('grantNotificationScheduledAt');
    const hint = document.getElementById('grantNotificationHint');
    if (field) field.classList.toggle('hidden', mode !== 'scheduled');
    if (input) {
      input.disabled = mode !== 'scheduled';
      input.required = mode === 'scheduled';
    }
    if (hint) {
      hint.textContent = mode === 'scheduled'
        ? '點數與服務時間立即入帳；LINE 訊息會在指定時間傳送。'
        : mode === 'none'
          ? '點數與服務時間照常入帳，本次不傳送 LINE 訊息。'
          : '發放完成後立即傳送 LINE 訊息。';
    }
  }

  function createCalendarBonusControls() {
    const form = document.getElementById('calendarItemForm');
    const linkFields = document.getElementById('calendarItemEventLinkFields');
    if (!form || !linkFields || document.getElementById('calendarBonusPointsControls')) return;
    const section = document.createElement('section');
    section.id = 'calendarBonusPointsControls';
    section.className = 'calendar-event-link-fields';
    section.innerHTML = `
      <div><p class="kicker">Event bonus</p><h4>活動加贈點數</h4><p>活動生效期間，管理員發放集點時會自動把加贈點數加入每張本次發放的集點卡，並在會員訊息中說明。</p></div>
      <label class="grant-toggle"><input id="calendarBonusPointsEnabled" type="checkbox">此活動啟用加贈點數</label>
      <label id="calendarBonusPointsField" class="hidden">每張本次發放集點卡額外增加
        <input id="calendarBonusPoints" type="number" min="1" max="100" step="1" value="1">
        <small class="field-help">可設定 1–100 點；多個同日有效活動會累加。</small>
      </label>`;
    linkFields.insertAdjacentElement('afterend', section);
    document.getElementById('calendarBonusPointsEnabled')?.addEventListener('change', updateCalendarBonusControls);
    document.getElementById('calendarItemType')?.addEventListener('change', () => {
      if (String(document.getElementById('calendarItemType')?.value || '') !== 'event') {
        const enabled = document.getElementById('calendarBonusPointsEnabled');
        if (enabled) enabled.checked = false;
      }
      updateCalendarBonusControls();
    });
    form.addEventListener('reset', () => window.setTimeout(() => syncCalendarBonusFromSelection(true), 0));
    updateCalendarBonusControls();
  }

  function updateCalendarBonusControls() {
    const isEvent = String(document.getElementById('calendarItemType')?.value || '') === 'event';
    const enabled = document.getElementById('calendarBonusPointsEnabled');
    const field = document.getElementById('calendarBonusPointsField');
    const input = document.getElementById('calendarBonusPoints');
    if (enabled) enabled.disabled = !isEvent;
    const active = isEvent && Boolean(enabled && enabled.checked);
    if (field) field.classList.toggle('hidden', !active);
    if (input) {
      input.disabled = !active;
      input.required = active;
    }
  }

  function syncCalendarBonusFromSelection(force = false) {
    const id = String(document.getElementById('calendarItemId')?.value || '').trim();
    if (!force && id === lastCalendarItemId) return;
    lastCalendarItemId = id;
    const item = id ? calendarCache.get(id) : null;
    const enabled = document.getElementById('calendarBonusPointsEnabled');
    const points = document.getElementById('calendarBonusPoints');
    if (enabled) enabled.checked = Boolean(item && item.itemType === 'event' && item.bonusPointsEnabled);
    if (points) points.value = String(item && Number(item.bonusPoints) > 0 ? Number(item.bonusPoints) : 1);
    updateCalendarBonusControls();
  }

  function bindCalendarSelectionSync() {
    document.addEventListener('click', () => window.setTimeout(() => {
      syncCalendarBonusFromSelection(false);
      syncManagedEventTicketDeleteButton();
      decorateManagedEventTicketCalendarRows();
    }, 0));
    document.getElementById('calendarItemForm')?.addEventListener('focusin', () => {
      syncCalendarBonusFromSelection(false);
      syncManagedEventTicketDeleteButton();
    });
    document.getElementById('newCalendarItemButton')?.addEventListener('click', () => window.setTimeout(() => {
      syncCalendarBonusFromSelection(true);
      syncManagedEventTicketDeleteButton();
    }, 0));
  }

  function createEventTicketCalendarControls() {
    const form = document.getElementById('eventTicketForm');
    const dateRange = document.getElementById('eventTicketDateRangeTitle')?.closest('.date-range-control');
    if (!form || !dateRange || document.getElementById('eventTicketCalendarControls')) return;
    const section = document.createElement('section');
    section.id = 'eventTicketCalendarControls';
    section.className = 'calendar-event-link-fields';
    section.innerHTML = `
      <div><p class="kicker">Calendar sync</p><h4>加入活動日曆</h4><p>可將這張活動票券同步成會員日曆中的活動；名稱、期間、公開狀態、顏色與適用會員等級會跟著票券更新。活動期間遇到休假時只隱藏休假當日，移除休假後會自動恢復。</p></div>
      <label class="grant-toggle"><input id="eventTicketAddToCalendar" type="checkbox">將這張活動票券加入日曆</label>
      <p id="eventTicketCalendarStatus" class="editor-hint" aria-live="polite">目前不加入日曆。</p>`;
    dateRange.insertAdjacentElement('afterend', section);
    document.getElementById('eventTicketAddToCalendar')?.addEventListener('change', updateEventTicketCalendarHint);
    form.addEventListener('submit', handleEventTicketCalendarSubmitCapture, true);
    form.addEventListener('reset', () => window.setTimeout(() => syncEventTicketCalendarChoiceFromSelection(true), 0));
    updateEventTicketCalendarHint();
  }

  function bindEventTicketCalendarSelectionSync() {
    document.addEventListener('click', () => window.setTimeout(() => syncEventTicketCalendarChoiceFromSelection(false), 0));
    document.getElementById('eventTicketForm')?.addEventListener('focusin', () => syncEventTicketCalendarChoiceFromSelection(false));
    document.getElementById('newEventTicketButton')?.addEventListener('click', () => window.setTimeout(() => syncEventTicketCalendarChoiceFromSelection(true), 0));
  }

  window.addEventListener('DOMContentLoaded', () => {
    createGrantNotificationControls();
    createCalendarBonusControls();
    bindCalendarSelectionSync();
    createEventTicketCalendarControls();
    bindEventTicketCalendarSelectionSync();
    bindManagedEventTicketCalendarReadOnly();
    window.setTimeout(() => {
      syncCalendarBonusFromSelection(true);
      syncEventTicketCalendarChoiceFromSelection(true);
      syncManagedEventTicketDeleteButton();
      decorateManagedEventTicketCalendarRows();
    }, 0);
  });
})();