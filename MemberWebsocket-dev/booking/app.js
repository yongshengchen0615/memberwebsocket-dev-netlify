(() => {
  'use strict';

  const STORE_SERVICE_ID = '00000000-0000-4000-8000-000000000010';
  const TYPE_PREFIX = '__TYPE__:';
  const DEFAULT_STORE_SERVICE_MINUTES = 10;
  const state = {
    config: null,
    idToken: '',
    data: { today: '', settings: {}, services: [], bookings: [] },
    profile: {},
    selections: [],
    selectedSlot: null,
    loadingSlots: false,
    slotRequestSequence: 0,
    submitting: false,
    pendingBookingWrite: null,
    editing: null,
    realtimeUnsubscribe: null,
    bookingRenderCount: 0,
    historyDate: '',
    historyMemberId: '',
    refreshSequence: 0,
    serverClockEpochMs: 0,
    serverClockMonotonicMs: 0,
    serverClockOffsetMs: 0,
  };
  const els = {};
  const STATUS_LABELS = {
    pending: '等待管理端確認',
    confirmed: '已確認',
    completed: '服務已完成',
    rejected: '未通過',
    cancelled: '已取消',
    no_show: '無故未到',
    cancel_requested: '取消待確認',
  };

  window.addEventListener('DOMContentLoaded', () => {
    [
      'loadingView', 'errorView', 'errorTitle', 'errorMessage', 'joinMemberButton', 'retryButton', 'bookingView',
      'memberName', 'memberProfileName', 'memberCode', 'memberTier', 'workHoursBadge',
      'bookingForm', 'servicePicker', 'serviceEmpty', 'selectedServiceList', 'selectedServiceEmpty', 'selectionSummary',
      'bookingDate', 'slotHint', 'slotGrid', 'memberNote', 'bookingReminderEnabled', 'bookingReminderTime', 'bookingReminderConfirmSummary', 'formMessage', 'submitBookingButton',
      'bookingList', 'bookingEmpty', 'bookingConfirmModal', 'closeBookingConfirmButton', 'cancelBookingConfirmButton',
      'bookingConfirmSummary', 'bookingConfirmMessage', 'confirmBookingButton'
    ].forEach((id) => { els[id] = document.getElementById(id); });

    els.retryButton.addEventListener('click', () => window.location.reload());
    els.joinMemberButton.addEventListener('click', () => window.BookingSystem.openMemberJoin(state.config));
    els.bookingDate.addEventListener('change', dateChanged);
    els.bookingForm.addEventListener('submit', openConfirmation);
    els.bookingReminderEnabled.addEventListener('change', () => {
      els.bookingReminderTime.disabled = !els.bookingReminderEnabled.checked;
      state.pendingBookingWrite = null;
    });
    els.bookingReminderTime.addEventListener('change', () => { state.pendingBookingWrite = null; });
    document.getElementById('cancelEditBookingButton').addEventListener('click', endEditing);
    window.addEventListener('booking:date-selected', beginNewBookingFromDateSelection);
    window.addEventListener('booking:history-date-selected', (event) => {
      state.historyDate = String(event.detail?.date || '');
      renderBookings({ recordsOnly: true });
    });
    window.addEventListener('booking:member-loaded', event => {
      const memberId = String(event.detail?.profile?.lineUserId || '');
      if (memberId !== state.historyMemberId) state.historyDate = '';
      state.historyMemberId = memberId;
    });
    els.closeBookingConfirmButton.addEventListener('click', closeConfirmation);
    els.cancelBookingConfirmButton.addEventListener('click', closeConfirmation);
    els.confirmBookingButton.addEventListener('click', confirmBooking);
    els.bookingConfirmModal.addEventListener('click', (event) => {
      if (event.target === els.bookingConfirmModal && window.matchMedia('(max-width: 768px)').matches) closeConfirmation();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !els.bookingConfirmModal.classList.contains('hidden')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeConfirmation();
        return;
      }
      if (event.key !== 'Tab') return;
      const modal = [document.getElementById('bookingNoticeModal'), els.bookingConfirmModal, document.getElementById('bookingHolidayModal'), document.getElementById('appointmentPanel')]
        .find((node) => node && !node.classList.contains('hidden'));
      if (!modal) return;
      const focusable = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]')]
        .filter((node) => node.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    });
    window.addEventListener('beforeunload', () => { if (state.realtimeUnsubscribe) state.realtimeUnsubscribe(); });
    boot();
  });

  async function boot() {
    showView('loading');
    try {
      state.config = await window.BookingSystem.loadConfig();
      state.idToken = await window.BookingSystem.signIn(state.config, 'booking');
      const hasTestSession = window.TestModeClient && typeof window.TestModeClient.getSessionToken === 'function' && window.TestModeClient.getSessionToken();
      const decoded = !hasTestSession && typeof window.liff?.getDecodedIDToken === 'function' ? window.liff.getDecodedIDToken() : null;
      const fallbackName = String(decoded?.name || 'LINE 會員');
      els.memberName.textContent = fallbackName;
      els.memberProfileName.textContent = fallbackName;
      await refresh(false);
      showView('booking');
      window.requestAnimationFrame(() => document.querySelector('.booking-detail-target')?.scrollIntoView?.({block:'center'}));
      window.dispatchEvent(new CustomEvent('user-tour:ready', { detail: { surface: 'booking', profile: state.profile } }));
      window.BookingBenefits?.setServiceContext?.(
        selectedServiceRows().map((item) => String(item.service?.serviceId || item.serviceId || '').trim()).filter(Boolean)
      );
      window.BookingBenefits?.start(state.config, state.idToken);
      state.realtimeUnsubscribe = window.BookingSystem.subscribeRealtime(state.config, () => refresh(false), 'member', (signal = {}) => {
        const scope = String(signal?.scope || '');
        const eventType = String(signal?.eventType || '');
        const pointChanged = scope === 'points'
          || eventType === 'admin.stamps.add'
          || eventType === 'admin.member-grants.add'
          || eventType.startsWith('data.db.point_');
        if (pointChanged || scope === 'reconnect') window.BookingBenefits?.syncNow?.();
        else window.BookingBenefits?.invalidate?.();
      });
    } catch (error) {
      showError(error);
    }
  }

  async function refresh(showMessage = true) {
    const refreshSequence = ++state.refreshSequence;
    try {
      const [bookingData, profile] = await Promise.all([
        window.BookingSystem.request(state.config, 'member', state.idToken, 'user.booking.bootstrap',{bookingId:new URLSearchParams(window.location.search).get('bookingId') || ''}),
        window.BookingSystem.memberProfile(state.config, state.idToken),
      ]);
      // Realtime、手動刷新與 QA refresh 可能同時進行；只允許最後發出的 refresh
      // 寫回畫面，避免較舊的 Bootstrap 回應覆蓋較新的預約狀態。
      if (refreshSequence !== state.refreshSequence) return false;
      state.data = bookingData || state.data;
      syncServerClock(state.data.serverNow);
      state.profile = profile || {};
      window.dispatchEvent(new CustomEvent('booking:member-loaded', { detail: { profile: state.profile } }));
      pruneSelections();
      renderMemberProfile();
      renderBookingRestriction();
      renderSettings();
      renderServices();
      renderBookings();
      applySelectionConstraints(false);
      window.dispatchEvent(new CustomEvent('booking:settings-updated', { detail: { settings: state.data.settings, today: state.data.today } }));
      if (selectedItems().length && els.bookingDate.value) await loadSlots();
      if (refreshSequence !== state.refreshSequence) return false;
      window.BookingBenefits?.invalidate();
      if (showMessage) showFormMessage('資料已更新。', 'success');
      return true;
    } catch (error) {
      if (refreshSequence !== state.refreshSequence) return false;
      // Let boot own initial failures; otherwise it would reveal an empty booking
      // view and subscribe to realtime immediately after showError returned.
      if (!state.data.today) throw error;
      showFormMessage(error?.message || '資料暫時無法更新。', 'error');
      return false;
    }
  }

  function pruneSelections() {
    const valid = new Set(userServices().map((service) => service.serviceId));
    state.selections = state.selections.filter((selection) => valid.has(selection.serviceId));
  }

  function userServices() {
    return (state.data.services || []).filter((service) => service.serviceId !== STORE_SERVICE_ID);
  }

  function bookingRestricted() {
    const r=state.data.bookingRestriction;
    return !state.editing && r?.restricted===true && Date.parse(r.expiresAt)>currentServerTimeMs();
  }
  function renderBookingRestriction() {
    document.getElementById('bookingRestrictionNotice')?.remove();
    const r=state.data.bookingRestriction;if(r?.restricted!==true || Date.parse(r.expiresAt)<=currentServerTimeMs())return;
    const notice=document.createElement('section');notice.id='bookingRestrictionNotice';notice.setAttribute('role','status');
    const title=document.createElement('h3');title.textContent='線上預約暫時受限';
    const text=document.createElement('p');text.textContent='到期時間：'+new Date(r.expiresAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})+'。既有預約與會員權益仍可查詢。如需預約，請洽：'+(r.contactText||'店家客服或電話預約。');notice.append(title,text);
    els.bookingForm.before(notice);
  }
  function renderMemberProfile() {
    const profile = state.profile || {};
    const name = String(profile.displayName || els.memberName.textContent || 'LINE 會員');
    els.memberName.textContent = name;
    els.memberProfileName.textContent = name;
    els.memberCode.textContent = String(profile.memberCode || '—');
    els.memberTier.textContent = String(profile.tier || '一般會員');
  }

  function renderSettings() {
    const settings = state.data.settings || {};
    const hours = settings.workStartTime && settings.workEndTime
      ? `${settings.workStartTime}–${settings.workEndTime}`
      : '上班時間未設定';
    const advanceDays = Number(settings.minAdvanceDays || 0);
    const maxAdvanceDays = Number(settings.maxAdvanceDays || 0);
    const labels = [hours];
    if (settings.workStartTime && settings.workEndTime && settings.workEndTime < settings.workStartTime) labels.push('隔日結束');
    if (advanceDays > 0) labels.push(`提前 ${advanceDays} 天`);
    if (maxAdvanceDays > 0) labels.push(`可預約 ${maxAdvanceDays} 天內`);
    els.workHoursBadge.textContent = labels.join(' · ');
  }

  function renderServices() {
    const services = userServices();
    const selectedIds = new Set(state.selections.map((selection) => selection.serviceId));
    const available = services.filter((service) => !selectedIds.has(service.serviceId));
    els.servicePicker.replaceChildren();

    if (available.length) {
      appendServiceCategoryGroups(
        els.servicePicker,
        available,
        (service) => service,
        (service) => createServiceChoiceRow(service),
        'service-picker',
      );
    }

    const noServices = services.length === 0;
    const allSelected = services.length > 0 && available.length === 0;
    els.serviceEmpty.classList.toggle('hidden', !noServices && !allSelected);
    const emptyTitle = els.serviceEmpty.querySelector('strong');
    if (emptyTitle) emptyTitle.textContent = allSelected ? '可選項目已全部加入目前選擇' : '目前沒有開放的預約項目';

    renderSelectedServices();
    window.BookingBenefits?.setServiceContext?.(
      selectedServiceRows().map((item) => String(item.service?.serviceId || item.serviceId || '').trim()).filter(Boolean)
    );
  }

  function createServiceChoiceRow(service) {
    const row = document.createElement('article');
    row.className = 'service-choice';
    row.dataset.serviceId = String(service.serviceId || '');

    const main = document.createElement('div');
    main.className = 'service-choice-main';
    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = service.title;
    const meta = document.createElement('small');
    meta.textContent = `服務 ${Number(service.durationMinutes || 0)} 分鐘 · ${formatMoney(service.priceAmount)}${service.requiresCompanionService ? ' · 加購／需搭配一般項目' : ''}`;
    text.append(title, meta);
    main.appendChild(text);

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'service-add-button';
    addButton.textContent = '增加';
    addButton.setAttribute('aria-label', `增加 ${service.title}`);
    addButton.addEventListener('click', () => addSelection(service));

    row.append(main, addButton);
    return row;
  }

  function renderSelectedServices() {
    const rows = selectedServiceRows();
    els.selectedServiceList.replaceChildren();
    els.selectedServiceEmpty.classList.toggle('hidden', rows.length > 0);

    if (!rows.length) return;
    appendServiceCategoryGroups(
      els.selectedServiceList,
      rows,
      (entry) => entry.service,
      (entry) => createSelectedServiceRow(entry),
      'selected-service-list',
    );
  }

  function createSelectedServiceRow(item) {
    const row = document.createElement('article');
    row.className = 'selected-service-item';

    const text = document.createElement('div');
    text.className = 'selected-service-main';
    const title = document.createElement('strong');
    title.textContent = item.service.title;
    const meta = document.createElement('small');
    meta.textContent = `服務 ${Number(item.service.durationMinutes || 0)} 分鐘 · ${formatMoney(item.service.priceAmount)}${item.service.requiresCompanionService ? ' · 加購／需搭配一般項目' : ''}`;
    text.append(title, meta);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'selected-service-remove';
    removeButton.textContent = '移除';
    removeButton.setAttribute('aria-label', `移除 ${item.service.title}`);
    removeButton.addEventListener('click', () => removeSelection(item.selectionId));

    row.append(text, removeButton);
    return row;
  }

  function appendServiceCategoryGroups(container, entries, getService, createRow, listClass) {
    const groups = new Map();
    for (const entry of entries) {
      const service = getService(entry);
      if (!service) continue;
      const label = serviceTypeOf(service) || '其他';
      const key = serviceTypeKey(label) || '其他';
      let group = groups.get(key);
      if (!group) {
        group = { label, entries: [] };
        groups.set(key, group);
      }
      group.entries.push(entry);
    }

    for (const group of groups.values()) {
      const section = document.createElement('section');
      const colorSlot = window.BookingServiceTypeColor?.slot?.(group.label) ?? 0;
      section.className = `service-info service-type-group service-type-color-${colorSlot}`;
      section.dataset.serviceTypeColor = String(colorSlot);
      section.setAttribute('aria-label', `${group.label}服務`);

      const heading = document.createElement('strong');
      heading.textContent = `${group.label}（${group.entries.length}）`;
      const rewardText = serviceTypeRewardText(group.label);
      const reward = document.createElement('small');
      reward.className = 'service-type-reward';
      reward.textContent = rewardText;
      reward.classList.toggle('hidden', !rewardText);
      const list = document.createElement('div');
      list.className = listClass;
      group.entries.forEach((entry) => list.appendChild(createRow(entry)));
      section.append(heading, reward, list);
      container.appendChild(section);
    }
  }

  function addSelection(service) {
    const existingServices = selectedServiceRows().map((item) => item.service);
    if (service.requiresCompanionService && !existingServices.some((item) => !item.requiresCompanionService)) {
      window.BookingSystem.showNotice(`${service.title} 是加購項目，請先選擇一個一般項目後再加入。`, { title: '加購項目提醒' });
      return;
    }
    const duplicateCount = state.selections.filter((selection) => selection.serviceId === service.serviceId).length;
    if (duplicateCount >= 2) {
      showFormMessage(`${service.title} 已加入兩次，無法再重複加入。`, 'error');
      return;
    }

    const warnings = [];
    if (duplicateCount > 0) warnings.push(`${service.title} 已有選擇。`);
    const serviceType = serviceTypeOf(service);
    if (serviceType) {
      const sameTypeRows = selectedServiceRows().filter((item) => serviceTypeKey(serviceTypeOf(item.service)) === serviceTypeKey(serviceType));
      if (sameTypeRows.length) {
        const names = [...new Set(sameTypeRows.map((item) => item.service.title))].join('、');
        warnings.push(`目前已選擇相同類型「${serviceType}」的項目：${names}。`);
      }
    }
    if (warnings.length && !window.confirm(`${warnings.join('\n')}\n\n仍要加入這個預約項目嗎？`)) return;

    state.selections.push({
      selectionId: crypto.randomUUID(),
      serviceId: service.serviceId,
    });
    selectionChanged();
  }

  function removeSelection(selectionId) {
    const index = state.selections.findIndex((selection) => selection.selectionId === selectionId);
    if (index < 0) return;
    const serviceMap = new Map(userServices().map((service) => [service.serviceId, service]));
    const remainingServices = state.selections
      .filter((_, selectionIndex) => selectionIndex !== index)
      .map((selection) => serviceMap.get(selection.serviceId))
      .filter(Boolean);
    if (remainingServices.some((service) => service.requiresCompanionService)
        && !remainingServices.some((service) => !service.requiresCompanionService)) {
      window.BookingSystem.showNotice('加購項目不能單獨保留，請先移除加購項目再移除最後一個一般項目。', { title: '加購項目提醒' });
      return;
    }
    state.selections.splice(index, 1);
    selectionChanged();
  }

  function selectedItems() {
    const counts = new Map();
    for (const selection of state.selections) {
      counts.set(selection.serviceId, (counts.get(selection.serviceId) || 0) + 1);
    }
    const items = [...counts.entries()]
      .filter(([, count]) => count >= 1 && count <= 2)
      .map(([serviceId, count]) => ({ serviceId, quantity: count }));
    if (items.length) items.push({ serviceId: STORE_SERVICE_ID, quantity: 1 });
    return items;
  }

  function selectedServiceRows() {
    const byId = new Map(userServices().map((service) => [service.serviceId, service]));
    return state.selections
      .map((selection) => ({ ...selection, service: byId.get(selection.serviceId) }))
      .filter((item) => item.service);
  }

  function serviceDurationMinutes() {
    return selectedServiceRows().reduce((sum, item) => sum + Number(item.service.durationMinutes || 0), 0);
  }

  function storeServiceMinutes() {
    const service = (state.data.services || []).find((item) => item.serviceId === STORE_SERVICE_ID);
    const value = Number(service?.durationMinutes ?? DEFAULT_STORE_SERVICE_MINUTES);
    return Number.isInteger(value) && value >= 0 ? value : DEFAULT_STORE_SERVICE_MINUTES;
  }

  function totalDurationMinutes() {
    return serviceDurationMinutes() + storeServiceMinutes();
  }

  function totalAmount() {
    const services = new Map((state.data.services || []).map((service) => [service.serviceId, service]));
    return selectedItems().reduce((sum, item) => {
      const service = services.get(item.serviceId);
      return sum + (Number(service?.priceAmount || 0) * Number(item.quantity || 0));
    }, 0);
  }

  function serviceTypeOf(service) {
    const description = String(service?.description || '');
    return description.startsWith(TYPE_PREFIX) ? description.slice(TYPE_PREFIX.length).trim() : '';
  }

  function serviceTypeKey(value) {
    return String(value || '').trim().toLocaleLowerCase('zh-Hant-TW');
  }

  function serviceTypeRewardOf(label) {
    const key = serviceTypeKey(label);
    return (state.data.settings?.serviceTypeRewards || []).find((reward) => serviceTypeKey(reward?.serviceType) === key) || null;
  }

  function serviceTypeRewardText(label) {
    const reward = serviceTypeRewardOf(label);
    const minutes = Number(reward?.minutesPerPoint || 0);
    const card = String(reward?.pointCardTitle || '').trim();
    return Number.isInteger(minutes) && minutes > 0 && card
      ? `僅主要技師項目計算：每 ${minutes} 分鐘於「${card}」集點卡獲得 1 點`
      : '';
  }

  function duplicateTypeGroups(rows = selectedServiceRows()) {
    const groups = new Map();
    for (const item of rows) {
      const label = serviceTypeOf(item.service);
      const key = serviceTypeKey(label);
      if (!key) continue;
      const group = groups.get(key) || { label, titles: [], count: 0 };
      group.count += 1;
      group.titles.push(item.service.title);
      groups.set(key, group);
    }
    return [...groups.values()].filter((group) => group.count > 1);
  }

  function globalMinimumDate() {
    return window.BookingSystem.addDays(state.data.today, Number(state.data.settings?.minAdvanceDays || 0));
  }

  function globalMaximumDate() {
    const maxAdvanceDays = Number(state.data.settings?.maxAdvanceDays || 0);
    return maxAdvanceDays > 0 ? window.BookingSystem.addDays(state.data.today, maxAdvanceDays) : '';
  }

  function selectionChanged() {
    clearFormMessage();
    state.selectedSlot = null;
    renderServices();
    applySelectionConstraints(true);
  }

  function applySelectionConstraints(loadAfter) {
    const rows = selectedServiceRows();
    els.slotGrid.replaceChildren();
    state.selectedSlot = null;
    els.submitBookingButton.disabled = true;
    const minimumDate = globalMinimumDate();
    const maximumDate = globalMaximumDate();
    els.bookingDate.min = minimumDate;
    els.bookingDate.max = maximumDate;

    if (!rows.length) {
      els.bookingDate.disabled = !els.bookingDate.value;
      els.selectionSummary.classList.add('hidden');
      els.slotHint.textContent = '請先選擇至少一個預約項目。';
      notifySelectionChanged();
      return;
    }

    const serviceMinutes = serviceDurationMinutes();
    const includedMinutes = storeServiceMinutes();
    const totalMinutes = serviceMinutes + includedMinutes;
    els.bookingDate.disabled = false;
    if (!els.bookingDate.value || els.bookingDate.value < minimumDate || (maximumDate && els.bookingDate.value > maximumDate)) els.bookingDate.value = minimumDate;
    els.selectionSummary.classList.remove('hidden');
    els.selectionSummary.replaceChildren();
    notifySelectionChanged();
    els.slotHint.textContent = '正在計算整段服務時間可使用的時段…';
    if (loadAfter && els.bookingDate.value) loadSlots();
  }

  function notifySelectionChanged() {
    window.dispatchEvent(new CustomEvent('booking:selection-changed', {
      detail: { items: selectedItems() },
    }));
  }

  async function dateChanged() {
    clearFormMessage();
    state.selectedSlot = null;
    await loadSlots();
  }

  async function loadSlots() {
    const items = selectedItems();
    const bookingDate = els.bookingDate.value;
    if (!items.length || !bookingDate) return;
    const maximumDate = globalMaximumDate();
    if (maximumDate && bookingDate > maximumDate) {
      els.slotGrid.replaceChildren();
      els.slotHint.textContent = `此日期超過可預約範圍，最遠可預約 ${window.BookingSystem.formatDate(maximumDate)}。`;
      els.submitBookingButton.disabled = true;
      return;
    }
    const requestSequence = ++state.slotRequestSequence;
    state.loadingSlots = true;
    const previouslySelected = state.selectedSlot?.startTime || '';
    state.selectedSlot = null;
    els.submitBookingButton.disabled = true;
    els.slotGrid.replaceChildren();
    els.slotHint.textContent = '正在取得可預約時段…';
    try {
      const result = await window.BookingSystem.request(state.config, 'member', state.idToken, 'user.booking.slots', {
        items,
        bookingDate,
        bookingId: state.editing?.bookingId,
      });
      if (requestSequence !== state.slotRequestSequence) return;
      syncServerClock(result.serverNow);
      if (result.settings) {
        state.data.settings = { ...state.data.settings, ...result.settings };
        renderSettings();
        window.dispatchEvent(new CustomEvent('booking:settings-updated', { detail: { settings: state.data.settings, today: state.data.today } }));
      }
      renderSlots(result.slots || [], previouslySelected, Number(result.totalDurationMinutes || totalDurationMinutes()));
    } catch (error) {
      if (requestSequence !== state.slotRequestSequence) return;
      els.slotHint.textContent = error?.message || '目前無法取得可預約時段。';
    } finally {
      if (requestSequence === state.slotRequestSequence) state.loadingSlots = false;
    }
  }

  function renderSlots(slots, previouslySelected, totalDuration) {
    els.slotGrid.replaceChildren();
    const availableCount = slots.filter((slot) => slot.available).length;
    els.slotHint.textContent = slots.length
      ? availableCount
        ? `預約共 ${totalDuration} 分鐘（已含店內服務 ${storeServiceMinutes()} 分鐘），共有 ${availableCount} 個可開始時段。已被其他預約重疊的時間不可選。`
        : '這一天目前沒有可容納完整服務時間的時段。'
      : '這一天沒有可預約時段。';

    for (const slot of slots) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'slot-button';
      button.textContent = `${slot.startAt?.slice(0, 10) !== els.bookingDate.value ? '隔日 ' : ''}${slot.startTime}–${slot.endTime}${slot.endAt?.slice(0, 10) !== els.bookingDate.value ? '（隔日結束）' : ''}`;
      button.disabled = !slot.available;
      button.setAttribute('aria-pressed', 'false');
      if (!slot.available) button.title = '這段時間與其他預約重疊、已經過期或超出上班時間';
      button.addEventListener('click', () => selectSlot(button, slot));
      els.slotGrid.appendChild(button);
      if (slot.available && slot.startTime === previouslySelected) selectSlot(button, slot);
    }
  }

  function selectSlot(button, slot) {
    state.selectedSlot = { startTime: slot.startTime, endTime: slot.endTime, startAt: slot.startAt, endAt: slot.endAt };
    els.slotGrid.querySelectorAll('.slot-button').forEach((item) => {
      const selected = item === button;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    els.submitBookingButton.disabled = state.submitting || !state.selectedSlot || bookingRestricted();
    clearFormMessage();
  }

  function reminderPreference() {
    return {
      reminderEnabled: els.bookingReminderEnabled.checked,
      reminderTime: els.bookingReminderTime.value || '18:00',
    };
  }

  function resetReminderPreference() {
    els.bookingReminderEnabled.checked = false;
    els.bookingReminderTime.value = '18:00';
    els.bookingReminderTime.disabled = true;
  }

  function reminderError() {
    const { reminderEnabled, reminderTime } = reminderPreference();
    if (!reminderEnabled) return '';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) return '請選擇有效的前一天提醒時間。';
    const actualStartDate = String(state.selectedSlot?.startAt || els.bookingDate.value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(actualStartDate)) return '請重新選擇預約時段。';
    const previous = new Date(`${actualStartDate}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const due = Date.parse(`${previous.toISOString().slice(0, 10)}T${reminderTime}:00+08:00`);
    if (!Number.isFinite(due) || due <= currentServerTimeMs()) {
      return '所選前一天提醒時間已過，請調整提醒時間，或取消提醒後繼續預約。';
    }
    return '';
  }

  function openConfirmation(event) {
    event.preventDefault();
    if (state.submitting) return;
    if (bookingRestricted()) return showFormMessage('目前暫停新的線上預約，請查看到期時間或聯絡店家。','error');
    const items = selectedServiceRows();
    if (!items.length || !els.bookingDate.value || !state.selectedSlot) {
      return showFormMessage('請完整選擇預約項目、日期與時間。', 'error');
    }
    const reminderValidation = reminderError();
    if (reminderValidation) return showFormMessage(reminderValidation, 'error');
    const { reminderEnabled, reminderTime } = reminderPreference();
    els.bookingReminderConfirmSummary.textContent = reminderEnabled
      ? `前一天 LINE 提醒：${reminderTime}（台北時間）`
      : '前一天 LINE 提醒：不提醒';
    renderConfirmation(items);
    clearConfirmMessage();
    els.bookingConfirmModal.classList.remove('hidden');
    els.confirmBookingButton.focus();
  }

  function renderConfirmation(items) {
    if (window.BookingGroupUI?.renderConfirmation?.()) return;

    const box = document.createElement('div');
    box.className = 'group-confirm-summary booking-detailed-confirmation';
    const heading = document.createElement('strong');
    heading.textContent = '本次預約 1 位';
    box.appendChild(heading);

    const time = document.createElement('p');
    time.className = 'booking-confirm-time';
    time.textContent = `${window.BookingSystem.formatDate(els.bookingDate.value)} 營業班次：${state.selectedSlot.startAt?.slice(0, 10) || els.bookingDate.value} ${state.selectedSlot.startTime}–${state.selectedSlot.endAt?.slice(0, 10) || els.bookingDate.value} ${state.selectedSlot.endTime}`;
    box.appendChild(time);

    const card = document.createElement('div');
    card.className = 'group-confirm-participant';
    const title = document.createElement('strong');
    title.textContent = '第一位預約';
    const serviceLine = document.createElement('p');
    serviceLine.textContent = `預約項目：${items.map((item) => `${item.service.title}（${item.service.durationMinutes}分鐘）`).join('、')}`;
    const duration = document.createElement('p');
    duration.textContent = `個別總時間：${totalDurationMinutes()} 分鐘（含店內服務 ${storeServiceMinutes()} 分鐘）`;
    const amount = document.createElement('p');
    amount.textContent = `個別金額：${formatMoney(totalAmount())}`;
    card.append(title, serviceLine, duration, amount);
    box.appendChild(card);

    const benefits = (window.BookingBenefits?.selectionSummary?.() || [])
      .filter((item) => item?.kind === 'points' || item?.kind === 'event');
    const benefitBox = document.createElement('div');
    benefitBox.className = 'group-confirm-participant booking-confirm-benefits';
    const benefitTitle = document.createElement('strong');
    benefitTitle.textContent = '本次使用票券';
    benefitBox.appendChild(benefitTitle);
    if (benefits.length) {
      const ticketKinds = { points: '集點卡票券', event: '活動票券' };
      const ticketList = document.createElement('ul');
      ticketList.className = 'booking-confirm-ticket-list';
      benefits.forEach((item) => {
        const ticket = document.createElement('li');
        const sourceTitle = item.kind === 'points' && item.cardTitle ? `${item.cardTitle}｜` : '';
        ticket.textContent = `${ticketKinds[item.kind] || '票券'}：${sourceTitle}${item.title || '未命名票券'}`;
        ticketList.appendChild(ticket);
      });
      benefitBox.appendChild(ticketList);
    } else {
      const benefitCopy = document.createElement('p');
      benefitCopy.textContent = '本次未使用票券';
      benefitBox.appendChild(benefitCopy);
    }
    box.appendChild(benefitBox);

    const noteBox = document.createElement('div');
    noteBox.className = 'group-confirm-participant booking-confirm-note';
    const noteTitle = document.createElement('strong');
    noteTitle.textContent = '預約備註';
    const note = document.createElement('p');
    note.textContent = els.memberNote.value.trim() || '未填寫';
    noteBox.append(noteTitle, note);
    box.appendChild(noteBox);

    els.bookingConfirmSummary.replaceChildren(box);
  }

  function closeConfirmation() {
    if (state.submitting || els.bookingConfirmModal.classList.contains('hidden')) return;
    els.bookingConfirmModal.classList.add('hidden');
    clearConfirmMessage();
    els.submitBookingButton.focus();
  }

  function bookingWriteFingerprint(items, bookingDate, startTime) {
    return JSON.stringify({
      bookingId: state.editing?.bookingId || '',
      expectedUpdatedAt: state.editing?.updatedAt || '',
      items: items.map((item) => ({ serviceId: item.serviceId, quantity: item.quantity })),
      bookingDate,
      startTime,
      memberNote: String(els.memberNote.value || ''),
      ...reminderPreference(),
      benefits: window.BookingBenefits?.selectionPayload?.() || [],
    });
  }

  async function recoverUncertainBookingWrite(requestId) {
    try {
      const fresh = await window.BookingSystem.request(state.config, 'member', state.idToken, 'user.booking.bootstrap');
      state.data = fresh;
      syncServerClock(state.data.serverNow);
      renderBookings();
      return (fresh.bookings || []).find((item) => item.requestId === requestId) || null;
    } catch (_) {
      return null;
    }
  }

  function bookingMemberChatText(booking) {
    const bookingDate = String(booking?.bookingDate || '').trim();
    const startDate = String(booking?.startAt || '').slice(0, 10) || bookingDate;
    const endDate = String(booking?.endAt || '').slice(0, 10) || bookingDate;
    const startTime = String(booking?.startTime || '').trim();
    const endTime = String(booking?.endTime || '').trim();
    const lines = [
      '【預約申請】',
      '狀態：等待管理員確認預約',
      startDate ? `預約日期：${window.BookingSystem.formatDate(startDate)}` : '',
      startTime ? `時段：${startDate} ${startTime}–${endDate} ${endTime}` : '',
      `預約項目：${bookingDisplayTitle(booking)}`,
    ];
    if (Number(booking?.partySize || 1) > 1) lines.push(`預約人數：${Number(booking.partySize)} 位`);
    lines.push(`查看預約明細：https://liff.line.me/${encodeURIComponent(state.config?.bookingLiffId || '')}?bookingId=${encodeURIComponent(String(booking?.bookingId || ''))}`);
    return lines.filter(Boolean).join('\n');
  }

  async function sendBookingMemberChatMessage(booking) {
    const result = await window.BookingSystem.sendMemberChatMessage?.(bookingMemberChatText(booking));
    if (result?.sent) {
      showFormMessage('預約已送出，並已由你的 LINE 將「等待管理員確認預約」傳送到官方帳號聊天。', 'success');
      return;
    }
    showFormMessage(
      result?.reason === 'not_in_line_chat'
        ? '預約已送出，等待管理端確認；目前不是從 LINE 官方帳號聊天內開啟，因此未自動傳送聊天訊息。'
        : '預約已送出，等待管理端確認；LINE 聊天訊息暫時未傳送，請回到官方帳號聊天確認。',
      'success'
    );
  }

  async function confirmBooking() {
    if (state.submitting) return;
    if (bookingRestricted()) return showConfirmMessage('目前暫停新的線上預約，請聯絡店家。','error');
    const items = selectedItems();
    const bookingDate = els.bookingDate.value;
    const startTime = state.selectedSlot?.startTime || '';
    const reminderValidation = reminderError();
    if (reminderValidation) return showConfirmMessage(reminderValidation, 'error');
    if (!items.length || !bookingDate || !startTime) {
      showConfirmMessage('預約內容已變更，請返回重新選擇。', 'error');
      return;
    }

    const wasEditing = Boolean(state.editing);
    const fingerprint = bookingWriteFingerprint(items, bookingDate, startTime);
    if (!state.pendingBookingWrite || state.pendingBookingWrite.fingerprint !== fingerprint) {
      state.pendingBookingWrite = { fingerprint, requestId: `BOOK-${crypto.randomUUID()}` };
    }
    const requestId = state.pendingBookingWrite.requestId;
    state.submitting = true;
    els.confirmBookingButton.disabled = true;
    els.confirmBookingButton.textContent = '送出中…';
    els.submitBookingButton.disabled = true;
    clearConfirmMessage();
    try {
      const result = await window.BookingSystem.request(state.config, 'member', state.idToken, state.editing ? 'user.booking.update' : 'user.booking.create', {
        bookingId: state.editing?.bookingId,
        expectedUpdatedAt: state.editing?.updatedAt,
        requestId,
        items,
        bookingDate,
        startTime,
        memberNote: els.memberNote.value,
        ...reminderPreference(),
        benefits: window.BookingBenefits?.selectionPayload?.() || [],
      });
      state.pendingBookingWrite = null;
      state.data.bookings = [result.booking, ...(state.data.bookings || []).filter((item) => item.bookingId !== result.booking.bookingId)];
      els.bookingConfirmModal.classList.add('hidden');
      state.editing = null;
      updateEditingLabel();
      els.memberNote.value = '';
      resetReminderPreference();
      window.BookingBenefits?.setBookingContext?.('');
      window.BookingBenefits?.clearSelection?.();
      state.selections = [];
      state.selectedSlot = null;
      renderServices();
      applySelectionConstraints(false);
      renderBookings();
      showFormMessage('預約已送出，整段服務時間已保留，等待管理端確認。', 'success');
      if (!wasEditing) await sendBookingMemberChatMessage(result.booking);
      window.dispatchEvent(new CustomEvent('booking:created', { detail: { booking: result.booking } }));
    } catch (error) {
      if (error?.code === 'API_RESPONSE_UNCERTAIN' || error?.code === 'API_TIMEOUT') {
        const recovered = await recoverUncertainBookingWrite(requestId);
        if (recovered) {
          state.pendingBookingWrite = null;
          els.bookingConfirmModal.classList.add('hidden');
          state.editing = null;
          resetReminderPreference();
          updateEditingLabel();
          window.BookingBenefits?.setBookingContext?.('');
          window.BookingBenefits?.clearSelection?.();
          state.selections = [];
          state.selectedSlot = null;
          renderServices();
          applySelectionConstraints(false);
          showFormMessage('預約已成功送出，整段時間已保留，等待管理端確認。', 'success');
          if (!wasEditing) await sendBookingMemberChatMessage(recovered);
          window.dispatchEvent(new CustomEvent('booking:created', { detail: { booking: recovered } }));
          return;
        }
        showConfirmMessage('目前無法確認送出結果。請先重新整理確認；若保持相同內容再次按確認，系統會沿用同一操作識別，不會重複建立預約。', 'error');
        return;
      }

      state.pendingBookingWrite = null;
      showConfirmMessage(error?.message || '預約送出失敗，請返回重新選擇時間。', 'error');
      if (error?.code === 'BOOKING_SLOT_TAKEN') {
        await loadSlots();
        showConfirmMessage('這段時間剛被其他會員預約，請返回選擇其他時間。', 'error');
      }
    } finally {
      state.submitting = false;
      els.confirmBookingButton.disabled = false;
      els.confirmBookingButton.textContent = '確認送出';
      els.submitBookingButton.disabled = !state.selectedSlot || bookingRestricted();
    }
  }

  function bookingVisibleItems(booking) {
    return Array.isArray(booking?.items) ? booking.items.filter((service) => service.serviceId !== STORE_SERVICE_ID) : [];
  }

  function bookingStoreItem(booking) {
    return Array.isArray(booking?.items) ? booking.items.find((service) => service.serviceId === STORE_SERVICE_ID) : null;
  }

  function bookingDisplayTitle(booking) {
    const titles = bookingVisibleItems(booking).map((service) => service.serviceTitle).filter(Boolean);
    return titles.length ? titles.join(' + ') : booking.serviceTitle || '預約項目';
  }

  function bookingBenefitPresentation(benefit) {
    const kind = String(benefit?.kind || '');
    const kindLabel = kind === 'points' ? '集點卡票券' : kind === 'event' ? '活動票券' : '預約票券';
    let sourceTitle = String(benefit?.cardTitle || '').trim();
    let ticketTitle = String(benefit?.title || '可用權益').trim() || '可用權益';

    if (kind === 'points') {
      const separator = ticketTitle.indexOf('｜');
      if (!sourceTitle && separator > 0) {
        sourceTitle = ticketTitle.slice(0, separator).trim();
        ticketTitle = ticketTitle.slice(separator + 1).trim() || '集點卡票券';
      } else if (sourceTitle && ticketTitle.startsWith(`${sourceTitle}｜`)) {
        ticketTitle = ticketTitle.slice(sourceTitle.length + 1).trim() || '集點卡票券';
      }
    }

    const status = String(benefit?.status || 'pending');
    let statusLabel = ({ pending: '待核銷', redeemed: '已核銷', applied: '已核銷', cancelled: '已取消' })[status] || status;
    if (status === 'cancelled' && benefit?.cancellationReason === 'booking_services_changed') statusLabel = '項目變更，已解除綁定';
    return { kind, kindLabel, sourceTitle, ticketTitle, status, statusLabel };
  }

  function renderBookingBenefitCards(benefits, options = {}) {
    const rows = (Array.isArray(benefits) ? benefits : [])
      .filter((benefit) => benefit?.kind === 'points' || benefit?.kind === 'event');
    if (!rows.length) return null;

    const section = document.createElement('section');
    section.className = 'booking-ticket-summary';
    section.setAttribute('aria-label', options.heading || '本次使用票券');

    const heading = document.createElement('div');
    heading.className = 'booking-ticket-summary-heading';
    const headingTitle = document.createElement('strong');
    headingTitle.textContent = options.heading || '本次使用票券';
    const count = document.createElement('span');
    count.className = 'booking-ticket-count';
    count.textContent = `${rows.length} 張`;
    heading.append(headingTitle, count);

    const grid = document.createElement('div');
    grid.className = 'booking-ticket-grid';

    rows.forEach((benefit) => {
      const view = bookingBenefitPresentation(benefit);
      const card = document.createElement('article');
      card.className = `booking-ticket-card kind-${view.kind || 'other'}`;

      const top = document.createElement('div');
      top.className = 'booking-ticket-card-top';
      const kind = document.createElement('span');
      kind.className = 'booking-ticket-kind';
      kind.textContent = view.kindLabel;
      top.appendChild(kind);

      if (options.showStatus !== false) {
        const status = document.createElement('span');
        status.className = `booking-ticket-status status-${view.status || 'pending'}`;
        status.textContent = view.statusLabel;
        top.appendChild(status);
      }

      const body = document.createElement('div');
      body.className = 'booking-ticket-body';

      if (view.kind === 'points' && view.sourceTitle) {
        const sourceField = document.createElement('div');
        sourceField.className = 'booking-ticket-field booking-ticket-source';
        const sourceLabel = document.createElement('small');
        sourceLabel.textContent = '來源集點卡';
        const sourceValue = document.createElement('strong');
        sourceValue.textContent = view.sourceTitle;
        sourceField.append(sourceLabel, sourceValue);
        body.appendChild(sourceField);
      }

      const titleField = document.createElement('div');
      titleField.className = 'booking-ticket-field';
      const titleLabel = document.createElement('small');
      titleLabel.textContent = '票券名稱';
      const titleValue = document.createElement('strong');
      titleValue.textContent = view.ticketTitle;
      titleField.append(titleLabel, titleValue);
      body.appendChild(titleField);

      card.append(top, body);
      grid.appendChild(card);
    });

    section.append(heading, grid);
    return section;
  }

  function renderBookings({ recordsOnly = false } = {}) {
    const allBookings = state.data.bookings || [];
    const bookings = state.historyDate ? allBookings.filter(booking => booking.bookingDate === state.historyDate) : allBookings;
    els.bookingList.replaceChildren();
    els.bookingEmpty.classList.toggle('hidden', bookings.length > 0);

    for (const booking of bookings) {
      const item = document.createElement('article');
      item.className = `booking-item member-booking-format-card status-${booking.status}`;
      item.dataset.bookingId = String(booking.bookingId || '');
      item.dataset.bookingDate = String(booking.bookingDate || '');
      const hasParticipantDetails = Array.isArray(booking.participants) && booking.participants.length > 0;
      item.dataset.participantDetails = hasParticipantDetails ? '1' : '0';

      const top = document.createElement('div');
      top.className = 'booking-item-top';
      const titleBox = document.createElement('div');
      titleBox.append(
        summaryRow('日期', window.BookingSystem.formatDate(booking.bookingDate)),
        summaryRow('時間', `${booking.startAt?.slice(0, 10) || booking.bookingDate} ${booking.startTime}–${booking.endAt?.slice(0, 10) || booking.bookingDate} ${booking.endTime}`),
      );

      const statusKey = bookingDisplayStatus(booking);
      const status = document.createElement('span');
      status.className = `status-badge status-${statusKey}`;
      status.textContent = STATUS_LABELS[statusKey] || statusKey;
      top.append(titleBox, status);
      item.appendChild(top);
      if(booking.serviceRecipientMemberCode){const recipient=document.createElement('p');recipient.className='service-info';recipient.textContent='代好友預約 · 受服務者：'+booking.serviceRecipientName+' · '+booking.serviceRecipientMemberCode;item.append(recipient);}

      if (hasParticipantDetails) {
        window.BookingGroupUI?.renderBookingHistoryCard?.(item, booking);
      } else {
        const visibleItems = bookingVisibleItems(booking);
        if (visibleItems.length) {
          const servicesLabel = document.createElement('p');
          servicesLabel.className = 'member-booking-format-services-label';
          servicesLabel.textContent = '服務項目';
          const serviceList = document.createElement('ul');
          serviceList.className = 'booking-service-items';
          visibleItems.forEach((service) => {
            const repeat = Math.max(1, Number(service.quantity || 1));
            for (let index = 0; index < repeat; index += 1) {
              const li = document.createElement('li');
              li.textContent = `${service.serviceTitle}（${Number(service.unitDurationMinutes || 0)}分鐘） · ${formatMoney(service.unitPriceAmount)}`;
              serviceList.appendChild(li);
            }
          });
          item.append(servicesLabel, serviceList);
        }
      }

      const totals = document.createElement('div');
      totals.className = 'member-booking-format-totals';
      const scheduledMinutes = Math.max(0, Number(booking.totalDurationMinutes || 0));
      totals.append(
        summaryRow('總服務時間', `${scheduledMinutes} 分鐘`),
        summaryRow('總金額', formatMoney(booking.totalAmount)),
      );
      item.appendChild(totals);

      const benefitCards = renderBookingBenefitCards(booking.benefits, { heading: '本次使用票券', showStatus: true });
      if (benefitCards) item.appendChild(benefitCards);
      if (booking.memberNote) {
        const note = document.createElement('p');
        note.className = 'booking-note';
        note.textContent = `備註：${booking.memberNote}`;
        item.appendChild(note);
      }
      if (booking.adminNote) {
        const adminNote = document.createElement('p');
        adminNote.className = 'booking-note admin-note';
        adminNote.textContent = `管理端說明：${booking.adminNote}`;
        item.appendChild(adminNote);
      }

      const requestedBooking = new URLSearchParams(window.location.search).get('bookingId');
      if (requestedBooking === String(booking.bookingId)) item.classList.add('booking-detail-target');

      if (canCancel(booking)) {
        const actions = document.createElement('div');
        actions.className = 'booking-actions';
        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'text-danger-button';
        cancelButton.textContent = '申請取消';
        cancelButton.addEventListener('click', () => cancelBooking(booking, cancelButton));
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'button button-light';
        editButton.textContent = '修改預約';
        editButton.addEventListener('click', () => editBooking(booking));
        actions.append(editButton, cancelButton);
        item.appendChild(actions);
      }

      els.bookingList.appendChild(item);
    }

    window.BookingMemberUI?.organizeBookingHistory?.();
    state.bookingRenderCount += 1;
    window.dispatchEvent(new CustomEvent('booking:bookings-rendered', { detail: {
      renderCount: state.bookingRenderCount,
      recordsOnly,
      // Only the authenticated member's already-loaded booking times; do not expose profile or tokens.
      bookings: allBookings.map(({ bookingDate, startTime, endTime, startAt, endAt, status }) => ({
        bookingDate, startTime, endTime, startAt, endAt, status,
      })),
    } }));
  }

  function summaryRow(label, value) {
    const row = document.createElement('p');
    row.className = 'member-booking-format-row';
    const key = document.createElement('span');
    key.className = 'member-booking-format-label';
    key.textContent = `${label}：`;
    const content = document.createElement('strong');
    content.className = 'member-booking-format-value';
    content.textContent = String(value ?? '');
    row.append(key, content);
    return row;
  }

  function syncServerClock(value) {
    const epochMs = Date.parse(String(value || ''));
    if (!Number.isFinite(epochMs)) return;
    state.serverClockEpochMs = epochMs;
    state.serverClockOffsetMs = epochMs - Date.now();
    state.serverClockMonotonicMs = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : 0;
  }

  function currentServerTimeMs() {
    if (state.serverClockEpochMs > 0 && typeof performance !== 'undefined' && typeof performance.now === 'function') {
      const elapsed = performance.now() - state.serverClockMonotonicMs;
      if (Number.isFinite(elapsed) && elapsed >= 0) return state.serverClockEpochMs + elapsed;
    }
    return Date.now() + Number(state.serverClockOffsetMs || 0);
  }

  function bookingDisplayStatus(booking) {
    const cancellationPending = Boolean(booking?.cancellationRequestedAt && !booking?.cancellationReviewedAt);
    return cancellationPending ? 'cancel_requested' : String(booking?.status || '');
  }

  function canCancel(booking) {
    const cancellationPending = Boolean(booking?.cancellationRequestedAt && !booking?.cancellationReviewedAt);
    const startsAt = Date.parse(booking.startAt || `${booking.bookingDate}T${booking.startTime}:00+08:00`);
    return ['pending', 'confirmed'].includes(booking.status)
      && !cancellationPending
      && Number.isFinite(startsAt)
      && startsAt > currentServerTimeMs();
  }

  function updateEditingLabel() {
    const editing = Boolean(state.editing);
    document.getElementById('editingBookingNotice').classList.toggle('hidden', !editing);
    document.getElementById('appointmentModalTitle').textContent = editing ? '修改預約' : '預約';
    document.getElementById('bookingConfirmTitle').textContent = editing ? '確認修改預約' : '確認預約';
    els.submitBookingButton.textContent = editing ? '確認修改內容' : '確認預約內容';
  }

  function beginNewBookingFromDateSelection() {
    if (state.editing) endEditing();
    else updateEditingLabel();
  }

  function endEditing() {
    if (state.submitting) return;
    state.editing = null;
    state.selections = [];
    state.selectedSlot = null;
    ++state.slotRequestSequence;
    els.memberNote.value = '';
    resetReminderPreference();
    window.BookingBenefits?.setBookingContext?.('');
    window.BookingBenefits?.clearSelection?.();
    updateEditingLabel();
    renderServices();
    applySelectionConstraints(false);
  }

  function editBooking(booking) {
    if (state.submitting || !canCancel(booking)) return;
    state.editing = { bookingId: booking.bookingId, updatedAt: booking.updatedAt };
    const activeIds = new Set(userServices().map((service) => service.serviceId));
    state.selections = bookingVisibleItems(booking).filter((item) => activeIds.has(item.serviceId))
      .flatMap((item) => Array.from({ length: Number(item.quantity || 1) }, () => ({ serviceId: item.serviceId, selectionId: crypto.randomUUID() })));
    els.memberNote.value = booking.memberNote || '';
    els.bookingReminderEnabled.checked = booking.reminderEnabled === true;
    els.bookingReminderTime.value = String(booking.reminderTime || '18:00').slice(0, 5);
    els.bookingReminderTime.disabled = !els.bookingReminderEnabled.checked;
    window.BookingBenefits?.setBookingContext?.(booking.bookingId);
    window.BookingBenefits?.setSelection?.(booking.benefits || []);
    els.bookingDate.value = booking.bookingDate;
    renderServices();
    applySelectionConstraints(false);
    state.selectedSlot = booking.startTime
      ? { startTime: String(booking.startTime), endTime: String(booking.endTime || ''), startAt: booking.startAt, endAt: booking.endAt }
      : null;
    updateEditingLabel();
    window.dispatchEvent(new CustomEvent('booking:edit', { detail: { date: els.bookingDate.value } }));
    showFormMessage('修改後將重新等待管理端確認，原預約會保留至修改成功。已停用的項目需重新選擇。', 'success');
    loadSlots();
  }

  async function cancelBooking(booking, button) {
    if (!window.confirm(`確定取消 ${bookingDisplayTitle(booking)} ${booking.startAt?.slice(0, 10) || booking.bookingDate} ${booking.startTime}–${booking.endAt?.slice(0, 10) || booking.bookingDate} ${booking.endTime} 的預約嗎？`)) return;
    button.disabled = true;
    try {
      const result = await window.BookingSystem.request(state.config, 'member', state.idToken, 'user.booking.cancel', { bookingId: booking.bookingId });
      state.data.bookings = (state.data.bookings || []).map((item) => item.bookingId === result.booking.bookingId ? result.booking : item);
      renderBookings();
      showFormMessage('已送出取消申請，等待管理端確認；確認前原預約時段仍會保留。', 'success');
      if (selectedItems().length && els.bookingDate.value === booking.bookingDate) await loadSlots();
    } catch (error) {
      button.disabled = false;
      showFormMessage(error?.message || '目前無法取消預約。', 'error');
    }
  }

  function formatMoney(value) {
    const amount = Number(value || 0);
    return `NT$${Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)).toLocaleString('zh-Hant-TW') : '0'}`;
  }

  function showFormMessage(message, type) {
    els.formMessage.textContent = message;
    els.formMessage.className = `form-message ${type || ''}`;
  }

  function clearFormMessage() {
    els.formMessage.textContent = '';
    els.formMessage.className = 'form-message hidden';
  }

  function showConfirmMessage(message, type) {
    els.bookingConfirmMessage.textContent = message;
    els.bookingConfirmMessage.className = `form-message ${type || ''}`;
  }

  function clearConfirmMessage() {
    els.bookingConfirmMessage.textContent = '';
    els.bookingConfirmMessage.className = 'form-message hidden';
  }

  function showView(view) {
    els.loadingView.classList.toggle('hidden', view !== 'loading');
    els.errorView.classList.toggle('hidden', view !== 'error');
    els.bookingView.classList.toggle('hidden', view !== 'booking');
    if (view === 'booking') window.dispatchEvent(new CustomEvent('booking:view-shown'));
  }

  function showError(error) {
    const membershipRequired = error && error.code === 'MEMBERSHIP_REQUIRED';
    const maintenance = error && error.code === 'SYSTEM_MAINTENANCE';
    els.errorTitle.textContent = maintenance ? '系統維護中' : membershipRequired ? '請先加入會員' : '預約功能暫時無法使用';
    els.errorMessage.textContent = membershipRequired
      ? '加入會員並完成會員資料後，才能使用預約功能。'
      : error?.message || '無法連線預約服務，請稍後再試。';
    els.joinMemberButton.classList.toggle('hidden', !membershipRequired);
    els.retryButton.classList.toggle('hidden', membershipRequired);
    showView('error');
  }
  function qaBookingSnapshot(bookingId) {
    const id = String(bookingId || '');
    const booking = (Array.isArray(state.data?.bookings) ? state.data.bookings : [])
      .find((row) => String(row?.bookingId || '') === id);
    if (!booking) return null;
    try { return JSON.parse(JSON.stringify(booking)); }
    catch { return null; }
  }

  window.MemberClientQaHooks = Object.freeze({
    surface: 'booking',
    refresh: () => refresh(false),
    getRenderCount: () => Number(state.bookingRenderCount || 0),
    getBookingSnapshot: (bookingId) => qaBookingSnapshot(bookingId)
  });
})();
