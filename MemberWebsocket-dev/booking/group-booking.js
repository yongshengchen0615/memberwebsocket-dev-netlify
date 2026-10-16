(() => {
  'use strict';

  const system = window.BookingSystem;
  if (!system || typeof system.request !== 'function') return;

  const originalRequest = system.request.bind(system);
  const STORE_SERVICE_ID = '00000000-0000-4000-8000-000000000010';
  const TYPE_PREFIX = '__TYPE__:';
  const DEFAULT_STORE_SERVICE_MINUTES = 10;
  const state = {
    config: null,
    idToken: '',
    maxPartySize: 1,
    partySize: 1,
    primaryTechnicianId: '',
    requirePrimaryTechnician: true,
    technicians: [],
    participantTechnicians: [],
    services: [],
    serviceTypeRewards: [],
    primaryItems: [],
    extras: [],
    storeServiceMinutes: DEFAULT_STORE_SERVICE_MINUTES,
    bookingGroups: new Map(),
    editingBookingId: '',
    primaryPicker: null,
    primarySelected: null,
    openCards: new Set([0]),
  };

  system.request = async function groupBookingRequest(config, clientType, idToken, action, payload = {}) {
    if (clientType !== 'member') return originalRequest(config, clientType, idToken, action, payload);
    state.config = config;
    state.idToken = idToken;

    if (action === 'user.booking.bootstrap') {
      const [base, group] = await Promise.all([
        originalRequest(config, clientType, idToken, action, payload),
        groupRequest('user.booking.group.bootstrap'),
      ]);
      state.maxPartySize = clamp(Number(group.settings?.maxPartySize || 1), 1, 10);
      state.primaryTechnicianId = String(group.settings?.primaryTechnicianId || '');
      state.requirePrimaryTechnician = group.settings?.requirePrimaryTechnician !== false;
      state.technicians = Array.isArray(group.technicians) ? group.technicians.filter((item) => item.isActive) : [];
      const storeService = Array.isArray(base.services)
        ? base.services.find((item) => item.serviceId === STORE_SERVICE_ID)
        : null;
      const configuredStoreMinutes = Number(storeService?.durationMinutes ?? DEFAULT_STORE_SERVICE_MINUTES);
      state.storeServiceMinutes = Number.isInteger(configuredStoreMinutes) && configuredStoreMinutes >= 0
        ? configuredStoreMinutes
        : DEFAULT_STORE_SERVICE_MINUTES;
      state.services = Array.isArray(base.services) ? base.services.filter((item) => item.serviceId !== STORE_SERVICE_ID) : [];
      state.serviceTypeRewards = Array.isArray(base.settings?.serviceTypeRewards) ? base.settings.serviceTypeRewards : [];
      state.bookingGroups = new Map(Object.entries(group.bookingGroups || {}));
      ensureParticipantCount(true);
      base.settings = {
        ...(base.settings || {}),
        maxPartySize: state.maxPartySize,
        primaryTechnicianId: state.primaryTechnicianId,
        requirePrimaryTechnician: state.requirePrimaryTechnician,
      };
      base.technicians = state.technicians;
      base.bookings = (base.bookings || []).map((booking) => normalizeBookingForMember(booking, state.bookingGroups.get(booking.bookingId)));
      renderGroupControls();
      return base;
    }

    if (action === 'user.booking.slots') {
      ensureEditingGroup(payload.bookingId);
      const participants = buildParticipants(payload.items);
      updateCardSummaries();
      updateSelectionSummary();
      if (!participants) {
        return {
          settings: { maxPartySize: state.maxPartySize, primaryTechnicianId: state.primaryTechnicianId },
          totalDurationMinutes: 0,
          totalAmount: 0,
          slots: [],
        };
      }
      const result = await groupRequest('user.booking.group.slots', {
        bookingId: payload.bookingId,
        bookingDate: payload.bookingDate,
        participants,
      });
      updateSelectionSummary();
      return result;
    }

    if (action === 'user.booking.create' || action === 'user.booking.update') {
      ensureEditingGroup(payload.bookingId);
      const participants = buildParticipants(payload.items, true);
      const result = await groupRequest(action === 'user.booking.create' ? 'user.booking.group.create' : 'user.booking.group.update', {
        ...payload,
        items: undefined,
        participants,
        ...contactPayload(),
        ...(action === 'user.booking.create' ? {serviceRecipientMemberCode:window.MemberFriends?.selected()||''} : {}),
      });
      if (result?.booking) {
        const groupMeta = {
          serviceRecipientMemberCode:result.booking.serviceRecipientMemberCode,
          serviceRecipientName:result.booking.serviceRecipientName,
          technicianId: result.booking.technicianId,
          technicianName: result.booking.technicianName,
          partySize: result.booking.partySize,
          participants: result.booking.participants || participants,
        };
        state.bookingGroups.set(result.booking.bookingId, groupMeta);
        result.booking = normalizeBookingForMember(result.booking, groupMeta);
        resetGroupSelection();
        window.MemberFriends?.clear();
      }
      return result;
    }

    if (action === 'user.booking.cancel') {
      const result = await originalRequest(config, clientType, idToken, action, payload);
      if (result?.booking) result.booking = normalizeBookingForMember(result.booking, state.bookingGroups.get(result.booking.bookingId));
      return result;
    }

    return originalRequest(config, clientType, idToken, action, payload);
  };

  window.addEventListener('booking:selection-changed', (event) => {
    syncPrimaryItems(event?.detail?.items);
    syncBenefitServiceContext();
    updateCardSummaries();
    updateSelectionSummary();
  });

  window.addEventListener('booking:date-selected', () => {
    if (!state.editingBookingId) return;
    state.editingBookingId = '';
    resetGroupSelection();
  });

  window.addEventListener('DOMContentLoaded', () => {
    injectGroupControls();
    document.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button) return;
      if (button.id === 'cancelEditBookingButton') {
        state.editingBookingId = '';
        resetGroupSelection();
        return;
      }
      if (button.textContent?.trim() !== '修改預約') return;
      const bookingId = String(button.closest('.booking-item')?.dataset.bookingId || '');
      if (!bookingId) return;
      state.editingBookingId = bookingId;
      applyBookingGroup(bookingId);
    }, true);
    window.addEventListener('booking:created', () => {
      state.editingBookingId = '';
      resetGroupSelection();
    });
  });

  async function groupRequest(action, payload = {}) {
    const functionName = action === 'user.booking.group.slots' ? 'booking-group-slots-api' : 'booking-group-api';
    const endpoint = `${String(state.config?.supabaseUrl || '').replace(/\/$/, '')}/functions/v1/${functionName}`;
    const isWrite = action === 'user.booking.group.create' || action === 'user.booking.group.update';
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          apikey: String(state.config?.supabasePublishableKey || ''),
        },
        body: JSON.stringify(window.TestModeClient && typeof window.TestModeClient.payload === 'function'
          ? window.TestModeClient.payload({ ...payload, action, clientType: 'member', idToken: state.idToken })
          : { ...payload, action, clientType: 'member', idToken: state.idToken }),
      });
      let data;
      try { data = await response.json(); }
      catch {
        if (isWrite) throw system.clientError('API_RESPONSE_UNCERTAIN', '無法確認這次多人預約操作的回應；請重新整理確認。');
        throw system.clientError('API_INVALID_RESPONSE', '多人預約服務回傳格式不正確。');
      }
      if (!response.ok || data?.ok !== true) {
        const error = new Error(String(data?.error?.message || '多人預約服務暫時無法完成操作。'));
        error.code = String(data?.error?.code || 'API_ERROR');
        error.details = data?.error?.details || null;
        throw error;
      }
      return data.data || {};
    } catch (error) {
      if (error?.code === 'API_RESPONSE_UNCERTAIN') throw error;
      if (isWrite && (error?.name === 'AbortError' || !error?.code)) {
        throw system.clientError('API_RESPONSE_UNCERTAIN', '無法確認這次多人預約操作是否已送達；系統不會自動重送，請重新整理確認。');
      }
      if (error?.name === 'AbortError') throw system.clientError('API_TIMEOUT', '多人預約服務回應逾時，請稍後再試。');
      if (error?.code) throw error;
      throw system.clientError('NETWORK_ERROR', '多人預約服務目前無法連線，請檢查網路後再試。');
    } finally {
      window.clearTimeout(timer);
    }
  }

  function injectGroupControls() {
    const picker = document.querySelector('.service-picker-fieldset');
    const selected = document.querySelector('.selected-service-fieldset');
    if (!picker || !selected || document.getElementById('groupBookingFields')) return;
    state.primaryPicker = picker;
    state.primarySelected = selected;

    const section = document.createElement('fieldset');
    section.id = 'groupBookingFields';
    section.className = 'group-booking-fieldset';
    section.innerHTML = `
      <legend>多人預約</legend>
      <div class="group-booking-topline">
        <label>預約人數<select id="bookingPartySize" aria-label="預約人數"></select></label>
      </div>
      <div id="primaryTechnicianRule" class="group-booking-rule" role="note"></div>
      <div id="participantCardList" class="participant-card-list"></div>`;
    picker.insertAdjacentElement('beforebegin', section);
    document.getElementById('bookingPartySize').addEventListener('change', partySizeChanged);
    renderGroupControls();
  }

  function renderGroupControls() {
    const party = document.getElementById('bookingPartySize');
    if (!party) return;
    const previousSize = state.partySize;
    party.replaceChildren();
    for (let value = 1; value <= state.maxPartySize; value += 1) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = `${value} 人`;
      party.appendChild(option);
    }
    state.partySize = clamp(previousSize, 1, state.maxPartySize);
    party.value = String(state.partySize);
    ensureParticipantCount(false);
    renderPrimaryRule();
    renderParticipantCards();
    syncBenefitServiceContext();
  }

  function renderPrimaryRule() {
    const rule = document.getElementById('primaryTechnicianRule');
    if (!rule) return;
    const primary = technicianById(state.primaryTechnicianId);
    if (!state.requirePrimaryTechnician) {
      rule.className = 'group-booking-rule';
      rule.textContent = '目前不必預約主要技師也能成立預約，可選其他開放技師或現場安排；未預約主要技師的服務不計入主要技師集點與會員服務時間。';
      return;
    }
    if (!primary) {
      rule.className = 'group-booking-rule error';
      rule.textContent = '管理端尚未設定可用的主要技師，目前無法送出預約。';
      return;
    }
    rule.className = 'group-booking-rule';
    rule.textContent = `預約成立條件：不論預約幾位，至少一位必須預約主要技師「${primary.name}」才能成立預約；其他服務對象可選其他技師或現場安排。`;
  }

  function partySizeChanged(event) {
    state.partySize = clamp(Number(event.target.value || 1), 1, state.maxPartySize);
    ensureParticipantCount(false);
    renderParticipantCards();
    updateSelectionSummary();
    reloadSlots();
  }

  function ensureParticipantCount(initial) {
    const previous = state.participantTechnicians.slice();
    while (state.participantTechnicians.length < state.partySize) state.participantTechnicians.push('');
    if (state.participantTechnicians.length > state.partySize) state.participantTechnicians.length = state.partySize;
    while (state.extras.length < Math.max(0, state.partySize - 1)) state.extras.push([]);
    if (state.extras.length > Math.max(0, state.partySize - 1)) state.extras.length = Math.max(0, state.partySize - 1);

    if (initial || !previous.length) {
      state.participantTechnicians[0] = state.requirePrimaryTechnician && state.primaryTechnicianId && technicianById(state.primaryTechnicianId) ? state.primaryTechnicianId : '';
    }
  }

  function renderParticipantCards() {
    const root = document.getElementById('participantCardList');
    if (!root) return;
    root.replaceChildren();
    for (let index = 0; index < state.partySize; index += 1) {
      const details = document.createElement('details');
      details.className = 'participant-card';
      details.dataset.participantIndex = String(index);
      details.open = state.openCards.has(index) || index === 0;
      details.addEventListener('toggle', () => {
        if (details.open) state.openCards.add(index); else state.openCards.delete(index);
      });

      const summary = document.createElement('summary');
      const heading = document.createElement('span');
      heading.className = 'participant-heading';
      const title = document.createElement('strong');
      title.textContent = participantLabel(index);
      const meta = document.createElement('span');
      meta.dataset.participantSummary = String(index);
      heading.append(title, meta);
      const chevron = document.createElement('span');
      chevron.className = 'participant-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '⌄';
      summary.append(heading, chevron);
      details.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'participant-card-body';
      body.appendChild(createTechnicianField(index));

      if (index === 0) {
        if (state.primaryPicker) body.appendChild(state.primaryPicker);
        if (state.primarySelected) body.appendChild(state.primarySelected);
      } else {
        body.appendChild(createExtraServicePicker(index));
      }
      details.appendChild(body);
      root.appendChild(details);
    }
    updateCardSummaries();
    updateSelectionSummary();
  }

  function createTechnicianField(index) {
    const wrap = document.createElement('label');
    wrap.className = 'participant-technician-field';
    const text = document.createElement('span');
    text.textContent = '預約技師';
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${participantLabel(index)}預約技師`);

    const onsite = document.createElement('option');
    onsite.value = '';
    onsite.textContent = '現場安排';
    select.appendChild(onsite);

    const selectedElsewhere = new Set(state.participantTechnicians.filter((id, i) => i !== index && id));
    state.technicians.forEach((technician) => {
      const option = document.createElement('option');
      option.value = technician.technicianId;
      option.textContent = technician.technicianId === state.primaryTechnicianId ? `${technician.name}（主要技師）` : technician.name;
      option.disabled = selectedElsewhere.has(technician.technicianId);
      select.appendChild(option);
    });
    select.value = state.participantTechnicians[index] || '';
    select.addEventListener('change', () => {
      state.participantTechnicians[index] = String(select.value || '');
      state.openCards.add(index);
      renderParticipantCards();
      reloadSlots();
    });
    wrap.append(text, select);
    return wrap;
  }

  function createExtraServicePicker(index) {
    const extraIndex = index - 1;
    const selections = Array.isArray(state.extras[extraIndex]) ? state.extras[extraIndex] : [];
    const fragment = document.createDocumentFragment();

    const picker = document.createElement('fieldset');
    picker.className = 'service-picker-fieldset';
    const pickerLegend = document.createElement('legend');
    pickerLegend.textContent = '可選預約項目';
    const pickerHint = document.createElement('p');
    pickerHint.className = 'slot-hint';
    pickerHint.textContent = '相同類型服務會集中在同一區塊；按下「增加」後會加入下方「目前選擇」。';
    const choices = document.createElement('div');
    choices.className = 'service-picker';

    const availableServices = state.services.filter((service) => (
      !selections.some((selection) => selection.serviceId === service.serviceId)
    ));
    if (availableServices.length) {
      appendServiceCategoryGroups(
        choices,
        availableServices,
        (service) => service,
        (service) => createExtraServiceChoiceRow(index, extraIndex, selections, service),
        'service-picker',
      );
    } else if (state.services.length) {
      choices.appendChild(createCompactEmptyState('可選項目已全部加入目前選擇'));
    }

    const pickerEmpty = document.createElement('div');
    pickerEmpty.className = `empty-state compact${state.services.length ? ' hidden' : ''}`;
    const pickerEmptyText = document.createElement('strong');
    pickerEmptyText.textContent = '目前沒有開放的預約項目';
    pickerEmpty.appendChild(pickerEmptyText);
    picker.append(pickerLegend, pickerHint, choices, pickerEmpty);

    const selectedFieldset = document.createElement('fieldset');
    selectedFieldset.className = 'selected-service-fieldset';
    const selectedLegend = document.createElement('legend');
    selectedLegend.textContent = '目前選擇';
    const selectedHint = document.createElement('p');
    selectedHint.className = 'slot-hint';
    selectedHint.textContent = '相同類型會集中顯示；每一筆選擇都可單獨移除。';
    const selectedList = document.createElement('div');
    selectedList.className = 'selected-service-list';

    const selectedEntries = selections
      .map((selection) => ({
        selection,
        service: state.services.find((item) => item.serviceId === selection.serviceId) || null,
      }))
      .filter((entry) => entry.service);
    if (selectedEntries.length) {
      appendServiceCategoryGroups(
        selectedList,
        selectedEntries,
        (entry) => entry.service,
        (entry) => createExtraSelectedServiceRow(index, extraIndex, selections, entry),
        'selected-service-list',
      );
    }

    const selectedEmpty = document.createElement('div');
    selectedEmpty.className = `empty-state compact${selectedEntries.length ? ' hidden' : ''}`;
    const selectedEmptyTitle = document.createElement('strong');
    selectedEmptyTitle.textContent = '尚未選擇預約項目';
    const selectedEmptyHint = document.createElement('span');
    selectedEmptyHint.textContent = '請從上方可選項目加入。';
    selectedEmpty.append(selectedEmptyTitle, selectedEmptyHint);
    selectedFieldset.append(selectedLegend, selectedHint, selectedList, selectedEmpty);

    fragment.append(picker, selectedFieldset);
    return fragment;
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
      const colorSlot = window.BookingServiceTypeColor.slot(group.label);
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

  function createExtraServiceChoiceRow(index, extraIndex, selections, service) {
    const row = document.createElement('article');
    row.className = 'service-choice';

    const main = document.createElement('div');
    main.className = 'service-choice-main';
    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = service.title;
    const meta = document.createElement('small');
    meta.textContent = `服務 ${Number(service.durationMinutes || 0)} 分鐘 · ${formatServiceMoney(service.priceAmount)}${service.requiresCompanionService ? ' · 加購／需搭配一般項目' : ''}`;
    text.append(title, meta);
    main.appendChild(text);

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'service-add-button';
    addButton.textContent = '增加';
    addButton.setAttribute('aria-label', `${participantLabel(index)}增加 ${service.title}`);
    addButton.addEventListener('click', () => {
      if (!confirmExtraServiceSelection(service, selections)) return;
      clearParticipantFormMessage();
      selections.push({ selectionId: crypto.randomUUID(), serviceId: service.serviceId });
      state.extras[extraIndex] = selections;
      state.openCards.add(index);
      renderParticipantCards();
      updateSelectionSummary();
      reloadSlots();
    });

    row.append(main, addButton);
    return row;
  }

  function createExtraSelectedServiceRow(index, extraIndex, selections, entry) {
    const { selection, service } = entry;
    const row = document.createElement('article');
    row.className = 'selected-service-item';

    const text = document.createElement('div');
    text.className = 'selected-service-main';
    const title = document.createElement('strong');
    title.textContent = service.title;
    const meta = document.createElement('small');
    meta.textContent = `服務 ${Number(service.durationMinutes || 0)} 分鐘 · ${formatServiceMoney(service.priceAmount)}${service.requiresCompanionService ? ' · 加購／需搭配一般項目' : ''}`;
    text.append(title, meta);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'selected-service-remove';
    removeButton.textContent = '移除';
    removeButton.setAttribute('aria-label', `${participantLabel(index)}移除 ${service.title}`);
    removeButton.addEventListener('click', () => {
      const selectionIndex = selections.findIndex((item) => item.selectionId === selection.selectionId);
      if (selectionIndex < 0) return;
      const remainingServices = selections
        .filter((_, currentIndex) => currentIndex !== selectionIndex)
        .map((item) => state.services.find((candidate) => candidate.serviceId === item.serviceId))
        .filter(Boolean);
      if (remainingServices.some((item) => item.requiresCompanionService)
          && !remainingServices.some((item) => !item.requiresCompanionService)) {
        system.showNotice('加購項目不能單獨保留，請先移除加購項目再移除最後一個一般項目。', { title: '加購項目提醒' });
        return;
      }
      selections.splice(selectionIndex, 1);
      clearParticipantFormMessage();
      state.extras[extraIndex] = selections;
      state.openCards.add(index);
      renderParticipantCards();
      updateSelectionSummary();
      reloadSlots();
    });

    row.append(text, removeButton);
    return row;
  }

  function createCompactEmptyState(titleText) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact';
    const title = document.createElement('strong');
    title.textContent = titleText;
    empty.appendChild(title);
    return empty;
  }

  function confirmExtraServiceSelection(service, selections) {
    const existingServices = selections
      .map((selection) => state.services.find((item) => item.serviceId === selection.serviceId))
      .filter(Boolean);
    if (service.requiresCompanionService && !existingServices.some((item) => !item.requiresCompanionService)) {
      system.showNotice(`${service.title} 是加購項目，請先選擇一個一般項目後再加入。`, { title: '加購項目提醒' });
      return false;
    }
    const duplicateCount = selections.filter((selection) => selection.serviceId === service.serviceId).length;
    if (duplicateCount >= 2) {
      showParticipantFormMessage(`${service.title} 已加入兩次，無法再重複加入。`, 'error');
      return false;
    }

    const warnings = [];
    if (duplicateCount > 0) warnings.push(`${service.title} 已有選擇。`);
    const serviceType = serviceTypeOf(service);
    if (serviceType) {
      const sameTypeRows = selections
        .map((selection) => state.services.find((item) => item.serviceId === selection.serviceId))
        .filter((item) => item && serviceTypeKey(serviceTypeOf(item)) === serviceTypeKey(serviceType));
      if (sameTypeRows.length) {
        const names = [...new Set(sameTypeRows.map((item) => item.title))].join('、');
        warnings.push(`目前已選擇相同類型「${serviceType}」的項目：${names}。`);
      }
    }
    if (warnings.length && !window.confirm(`${warnings.join('\n')}\n\n仍要加入這個預約項目嗎？`)) return false;
    return true;
  }

  function showParticipantFormMessage(message, type) {
    const node = document.getElementById('formMessage');
    if (!node) return;
    node.textContent = message;
    node.className = `form-message ${type || ''}`;
  }

  function clearParticipantFormMessage() {
    const node = document.getElementById('formMessage');
    if (!node) return;
    node.textContent = '';
    node.className = 'form-message hidden';
  }

  function extraSelectionsToItems(selections) {
    const counts = new Map();
    for (const selection of Array.isArray(selections) ? selections : []) {
      const serviceId = String(selection?.serviceId || '');
      if (!serviceId) continue;
      counts.set(serviceId, (counts.get(serviceId) || 0) + 1);
    }
    return [...counts.entries()].map(([serviceId, quantity]) => ({ serviceId, quantity }));
  }

  function participantSelections(participant) {
    return (Array.isArray(participant?.items) ? participant.items : []).flatMap((item) => {
      const serviceId = String(item?.serviceId || '');
      if (!serviceId) return [];
      const quantity = Math.max(1, Math.min(2, Math.trunc(Number(item?.quantity || 1))));
      return Array.from({ length: quantity }, () => ({ selectionId: crypto.randomUUID(), serviceId }));
    });
  }

  function updateCardSummaries() {
    document.querySelectorAll('[data-participant-summary]').forEach((node) => {
      const index = Number(node.dataset.participantSummary || 0);
      const tech = technicianLabel(state.participantTechnicians[index]);
      const count = index === 0 ? countItems(state.primaryItems) : (state.extras[index - 1]?.length || 0);
      const amount = participantMetrics(index).amount;
      node.textContent = `${count ? `已選 ${count} 項` : '尚未選項目'} · 金額 ${formatMoney(amount)} · ${tech}`;
    });
  }

  function syncPrimaryItems(items) {
    state.primaryItems = (Array.isArray(items) ? items : [])
      .filter((item) => item.serviceId !== STORE_SERVICE_ID)
      .map((item) => ({ serviceId: item.serviceId, quantity: Number(item.quantity || 1) }));
  }

  function validateCompanionItems(items, label, strict) {
    const services = (Array.isArray(items) ? items : [])
      .map((item) => state.services.find((service) => service.serviceId === item.serviceId))
      .filter(Boolean);
    if (services.some((service) => service.requiresCompanionService)
        && !services.some((service) => !service.requiresCompanionService)) {
      const message = `${label}只有加購項目；加購項目必須搭配至少一個一般項目。`;
      if (strict) throw clientError('BOOKING_ADD_ON_REQUIRES_COMPANION', message);
      system.showNotice(message, { title: '加購項目提醒' });
      return false;
    }
    return true;
  }

  function buildParticipants(primaryItems, strict = false) {
    syncPrimaryItems(primaryItems);

    if (!state.primaryItems.length) {
      if (strict) throw clientError('INVALID_BOOKING_ITEMS', '第一位預約尚未選擇預約項目。');
      return null;
    }
    if (!validateCompanionItems(state.primaryItems, participantLabel(0), strict)) return null;
    ensureParticipantCount(false);
    const primaryCount = state.participantTechnicians.filter((id) => id && id === state.primaryTechnicianId).length;
    if (state.requirePrimaryTechnician && (!state.primaryTechnicianId || primaryCount < 1)) {
      if (strict) throw clientError('BOOKING_PRIMARY_TECHNICIAN_REQUIRED', '每筆預約至少一位服務對象須預約主要技師，才能成立預約。');
      return null;
    }
    const selectedTechs = state.participantTechnicians.filter(Boolean);
    if (new Set(selectedTechs).size !== selectedTechs.length) {
      if (strict) throw clientError('DUPLICATE_PARTICIPANT_TECHNICIAN', '同一位技師不能同時安排給兩位預約人。');
      return null;
    }

    const participants = [{
      technicianId: state.participantTechnicians[0] || null,
      items: state.primaryItems,
    }];
    for (let index = 0; index < state.extras.length; index += 1) {
      const items = extraSelectionsToItems(state.extras[index]);
      if (!items.length) {
        if (strict) throw clientError('INVALID_BOOKING_ITEMS', `${participantLabel(index + 1)}尚未選擇預約項目。`);
        return null;
      }
      if (!validateCompanionItems(items, participantLabel(index + 1), strict)) return null;
      participants.push({
        technicianId: state.participantTechnicians[index + 1] || null,
        items,
      });
    }
    return participants;
  }

  function ensureEditingGroup(bookingId) {
    const id = String(bookingId || state.editingBookingId || '');
    if (!id || id === state.editingBookingId) return;
    state.editingBookingId = id;
    applyBookingGroup(id);
  }

  function applyBookingGroup(bookingId) {
    const group = state.bookingGroups.get(bookingId);
    if (!group) return;
    window.MemberFriends?.lock(group.serviceRecipientMemberCode,group.serviceRecipientName);
    state.partySize = clamp(Number(group.partySize || 1), 1, state.maxPartySize);
    const participants = Array.isArray(group.participants) ? group.participants : [];
    state.participantTechnicians = participants.map((participant) => String(participant.technicianId || ''));
    state.primaryItems = Array.isArray(participants[0]?.items)
      ? participants[0].items.map((item) => ({ serviceId: item.serviceId, quantity: Number(item.quantity || 1) }))
      : [];
    state.extras = participants.slice(1).map((participant) => participantSelections(participant));
    ensureParticipantCount(false);
    state.openCards = new Set([0]);
    renderGroupControls();
  }

  function resetGroupSelection() {
    window.MemberFriends?.clear();
    state.partySize = 1;
    state.primaryItems = [];
    state.extras = [];
    state.participantTechnicians = [state.requirePrimaryTechnician && state.primaryTechnicianId && technicianById(state.primaryTechnicianId) ? state.primaryTechnicianId : ''];
    state.openCards = new Set([0]);
    renderGroupControls();
  }

  function normalizeBookingForMember(booking, group) {
    if (!booking || !group) return booking;
    const store = Array.isArray(booking.items) ? booking.items.find((item) => item.serviceId === STORE_SERVICE_ID) : null;
    const participantOneItems = Array.isArray(group.participants?.[0]?.items) ? group.participants[0].items : [];
    return {
      ...booking,
      serviceRecipientMemberCode:group.serviceRecipientMemberCode||booking.serviceRecipientMemberCode||'',
      serviceRecipientName:group.serviceRecipientName||booking.serviceRecipientName||'',
      partySize: Number(group.partySize || 1),
      technicianId: group.technicianId || '',
      technicianName: group.technicianName || '',
      participants: group.participants || [],
      items: [...participantOneItems, ...(store ? [store] : [])],
    };
  }

  function contactPayload() {
    const source = String(document.querySelector('input[name="bookingContactSource"]:checked')?.value || 'member');
    if (source !== 'custom') return { contactSource: 'member' };
    return {
      contactSource: 'custom',
      contactSurname: String(document.getElementById('bookingContactSurname')?.value || '').trim(),
      contactSalutation: String(document.getElementById('bookingContactSalutation')?.value || '').trim(),
      contactPhone: String(document.getElementById('bookingContactPhone')?.value || '').trim(),
    };
  }

  function updateSelectionSummary() {
    const root = document.getElementById('selectionSummary');
    if (!root) return;
    if (!state.primaryItems.length) {
      root.replaceChildren();
      root.classList.add('hidden');
      root.classList.remove('group-selection-summary');
      return;
    }
    const metrics = [];
    for (let index = 0; index < state.partySize; index += 1) metrics.push(participantMetrics(index));
    const overallMinutes = metrics.reduce((max, item) => Math.max(max, item.totalMinutes), 0);
    const overallAmount = metrics.reduce((sum, item) => sum + item.amount, 0);
    const minimumDate = String(document.getElementById('bookingDate')?.min || '');
    const maximumDate = String(document.getElementById('bookingDate')?.max || '');

    root.replaceChildren();
    root.classList.remove('hidden');
    root.classList.add('group-selection-summary');
    metrics.forEach((metric, index) => {
      const block = document.createElement('div');
      block.className = 'group-selection-participant';
      const heading = document.createElement('strong');
      heading.textContent = participantLabel(index);
      const services = document.createElement('p');
      services.textContent = `服務項目：${metric.labels.join('、') || '尚未選擇'}`;
      const duration = document.createElement('p');
      duration.textContent = metric.totalMinutes
        ? `總時間：${metric.totalMinutes}分鐘（含店內服務 ${state.storeServiceMinutes} 分鐘）`
        : '總時間：尚未計算';
      const amount = document.createElement('p');
      amount.textContent = `金額：${formatMoney(metric.amount)}`;
      const technician = document.createElement('p');
      technician.textContent = `預約技師：${technicianLabel(state.participantTechnicians[index])}`;
      block.append(heading, services, duration, amount, technician);
      root.appendChild(block);
    });

    const totals = document.createElement('div');
    totals.className = 'group-selection-totals';
    const duration = document.createElement('strong');
    duration.textContent = `總服務時間：${overallMinutes}分鐘`;
    const durationNote = document.createElement('span');
    durationNote.textContent = '（以各預約人最長總時間計）';
    duration.appendChild(durationNote);
    const amount = document.createElement('p');
    amount.textContent = `總金額：${formatMoney(overallAmount)}`;
    totals.append(duration, amount);
    if (minimumDate) {
      const earliest = document.createElement('p');
      earliest.textContent = `最早可預約 ${system.formatDate(minimumDate)}`;
      totals.appendChild(earliest);
    }
    if (maximumDate) {
      const latest = document.createElement('p');
      latest.textContent = `最遠可預約 ${system.formatDate(maximumDate)}`;
      totals.appendChild(latest);
    }
    root.appendChild(totals);
  }

  function participantMetrics(index) {
    const items = participantItems(index);
    let serviceMinutes = 0;
    let amount = 0;
    const labels = [];
    items.forEach((item) => {
      const service = state.services.find((candidate) => candidate.serviceId === item.serviceId);
      if (!service) return;
      const quantity = Math.max(1, Number(item.quantity || 1));
      const duration = Number(service.durationMinutes || 0);
      serviceMinutes += duration * quantity;
      amount += Number(service.priceAmount || 0) * quantity;
      labels.push(`${service.title}（${duration}分鐘）${quantity > 1 ? `×${quantity}` : ''}`);
    });
    return {
      labels,
      amount,
      totalMinutes: items.length ? serviceMinutes + state.storeServiceMinutes : 0,
    };
  }

  function participantItems(index) {
    if (index === 0) return state.primaryItems;
    return extraSelectionsToItems(state.extras[index - 1]);
  }

  function storedParticipantAmount(participant) {
    return (Array.isArray(participant?.items) ? participant.items : []).reduce((sum, item) => {
      const subtotal = Number(item?.subtotalAmount);
      if (Number.isFinite(subtotal)) return sum + subtotal;
      return sum + (Number(item?.unitPriceAmount || 0) * Math.max(1, Number(item?.quantity || 1)));
    }, 0);
  }

  function renderConfirmation() {
    const root = document.getElementById('bookingConfirmSummary');
    if (!root) return false;

    const metrics = [];
    for (let index = 0; index < state.partySize; index += 1) metrics.push(participantMetrics(index));
    if (!metrics.length || metrics.some((metric) => !metric.labels.length)) return false;

    const box = document.createElement('div');
    box.className = 'group-confirm-summary booking-detailed-confirmation';
    box.dataset.groupConfirm = 'true';

    const heading = document.createElement('strong');
    heading.textContent = `本次預約 ${state.partySize} 位`;
    box.appendChild(heading);
    const recipient=document.createElement('p');recipient.textContent='實際受服務者：'+(document.getElementById('friendBookingRecipient')?.selectedOptions[0]?.textContent||'本人');box.appendChild(recipient);

    const bookingDate = String(document.getElementById('bookingDate')?.value || '');
    const selectedSlot = String(document.querySelector('#slotGrid .slot-button.selected')?.textContent || '').trim();
    if (bookingDate || selectedSlot) {
      const time = document.createElement('p');
      time.className = 'booking-confirm-time';
      time.textContent = [bookingDate ? system.formatDate(bookingDate) : '', selectedSlot].filter(Boolean).join(' ');
      box.appendChild(time);
    }

    metrics.forEach((metric, index) => {
      const card = document.createElement('div');
      card.className = 'group-confirm-participant';

      const title = document.createElement('strong');
      title.textContent = participantLabel(index);
      const items = document.createElement('p');
      items.textContent = `預約項目：${metric.labels.join('、')}`;
      const technician = document.createElement('p');
      technician.textContent = `預約技師：${technicianLabel(state.participantTechnicians[index])}`;
      const duration = document.createElement('p');
      duration.textContent = `個別總時間：${metric.totalMinutes} 分鐘${state.storeServiceMinutes > 0 ? `（含店內服務 ${state.storeServiceMinutes} 分鐘）` : ''}`;
      const amount = document.createElement('p');
      amount.textContent = `個別金額：${formatMoney(metric.amount)}`;

      card.append(title, items, technician, duration, amount);
      box.appendChild(card);
    });

    const overallMinutes = metrics.reduce((max, item) => Math.max(max, item.totalMinutes), 0);
    const overallAmount = metrics.reduce((sum, item) => sum + item.amount, 0);
    const totals = document.createElement('div');
    totals.className = 'group-confirm-participant booking-confirm-overall';
    const duration = document.createElement('strong');
    duration.textContent = `整體總服務時間：${overallMinutes} 分鐘`;
    const durationNote = document.createElement('p');
    durationNote.textContent = '以所有預約人中最長的個別總時間計算。';
    const amount = document.createElement('p');
    amount.textContent = `預約總金額：${formatMoney(overallAmount)}`;
    totals.append(duration, durationNote, amount);
    box.appendChild(totals);

    const contact = confirmationContactSummary();
    const contactBox = document.createElement('div');
    contactBox.className = 'group-confirm-participant booking-confirm-contact';
    const contactTitle = document.createElement('strong');
    contactTitle.textContent = '預約聯絡資料';
    const contactValue = document.createElement('p');
    contactValue.textContent = contact;
    contactBox.append(contactTitle, contactValue);
    box.appendChild(contactBox);

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
    note.textContent = String(document.getElementById('memberNote')?.value || '').trim() || '未填寫';
    noteBox.append(noteTitle, note);
    box.appendChild(noteBox);

    root.replaceChildren(box);
    return true;
  }

  function confirmationContactSummary() {
    const source = String(document.querySelector('input[name="bookingContactSource"]:checked')?.value || 'member');
    if (source !== 'custom') {
      const member = String(document.getElementById('bookingMemberContactSummary')?.textContent || '').trim();
      return member ? `使用會員資料：${member}` : '使用會員資料';
    }
    const surname = String(document.getElementById('bookingContactSurname')?.value || '').trim();
    const salutationValue = String(document.getElementById('bookingContactSalutation')?.value || '').trim();
    const salutation = salutationValue === 'mr' ? '先生' : salutationValue === 'ms' ? '小姐' : '';
    const phone = String(document.getElementById('bookingContactPhone')?.value || '').trim();
    return `本次重新填寫：${surname}${salutation}${phone ? ` · ${phone}` : ''}`;
  }

  function renderBookingHistoryCard(node, booking) {
    if (!node || !booking) return;
    const group = state.bookingGroups.get(String(booking.bookingId || ''));
    const participants = Array.isArray(booking.participants) && booking.participants.length
      ? booking.participants
      : Array.isArray(group?.participants) ? group.participants : [];
    if (!participants.length) return;
    const storeItem = Array.isArray(booking.items) ? booking.items.find((item) => item?.serviceId === STORE_SERVICE_ID) : null;
    const historicalStoreMinutes = storeItem
      ? Number(storeItem.unitDurationMinutes || DEFAULT_STORE_SERVICE_MINUTES) * Math.max(1, Number(storeItem.quantity || 1))
      : 0;

    const box = document.createElement('div');
    box.dataset.groupHistory = 'true';
    box.className = 'group-history-summary';
    const head = document.createElement('strong');
    head.textContent = `${participants.length} 位預約`;
    box.appendChild(head);

    participants.forEach((participant, index) => {
      const card = document.createElement('div');
      card.className = 'group-history-participant';
      const title = document.createElement('strong');
      title.textContent = participantLabel(index);

      const items = Array.isArray(participant?.items) ? participant.items : [];
      const itemLine = document.createElement('p');
      itemLine.textContent = `項目：${items.map((item) => {
        const name = String(item?.serviceTitle || '預約項目');
        const minutes = Number(item?.unitDurationMinutes || 0);
        const quantity = Math.max(1, Number(item?.quantity || 1));
        return `${name}${minutes > 0 ? `（${minutes}分鐘）` : ''}${quantity > 1 ? `×${quantity}` : ''}`;
      }).join('、') || '—'}`;

      const serviceMinutes = items.reduce((sum, item) => (
        sum + Number(item?.unitDurationMinutes || 0) * Math.max(1, Number(item?.quantity || 1))
      ), 0);
      const duration = document.createElement('p');
      duration.textContent = `總時間：${serviceMinutes + historicalStoreMinutes} 分鐘${historicalStoreMinutes > 0 ? `（含店內服務 ${historicalStoreMinutes} 分鐘）` : ''}`;

      const amount = document.createElement('p');
      amount.textContent = `金額：${formatMoney(storedParticipantAmount(participant))}`;
      const tech = document.createElement('p');
      tech.textContent = `技師：${participant.technicianName || '現場安排'}`;
      card.append(title, itemLine, duration, amount, tech);
      box.appendChild(card);
    });

    const top = node.querySelector(':scope > .booking-item-top');
    if (top) top.insertAdjacentElement('afterend', box);
    else node.prepend(box);
  }

  window.BookingGroupUI = Object.freeze({
    renderSelectionSummary: updateSelectionSummary,
    renderConfirmation,
    renderBookingHistoryCard,
    renderControls: renderGroupControls,
  });

  function syncBenefitServiceContext() {
    const serviceIds = [];
    for (const item of state.primaryItems) {
      const serviceId = String(item?.serviceId || '').trim();
      if (serviceId) serviceIds.push(serviceId);
    }
    for (const selections of state.extras) {
      for (const selection of Array.isArray(selections) ? selections : []) {
        const serviceId = String(selection?.serviceId || '').trim();
        if (serviceId) serviceIds.push(serviceId);
      }
    }
    window.BookingBenefits?.setServiceContext?.([...new Set(serviceIds)]);
  }

  function participantServiceNames(index) {
    return participantMetrics(index).labels;
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
    return state.serviceTypeRewards.find((reward) => serviceTypeKey(reward?.serviceType) === key) || null;
  }

  function serviceTypeRewardText(label) {
    const reward = serviceTypeRewardOf(label);
    const minutes = Number(reward?.minutesPerPoint || 0);
    const card = String(reward?.pointCardTitle || '').trim();
    return Number.isInteger(minutes) && minutes > 0 && card
      ? `僅主要技師項目計算：每 ${minutes} 分鐘於「${card}」集點卡獲得 1 點`
      : '';
  }

  function formatServiceMoney(value) {
    const amount = Number(value || 0);
    return `NT$${Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)).toLocaleString('zh-Hant-TW') : '0'}`;
  }

  function formatMoney(value) {
    return `NT ${Number(value || 0).toLocaleString('zh-Hant-TW')}`;
  }

  function participantLabel(index) {
    return `${ordinal(index + 1)}位預約`;
  }

  function ordinal(value) {
    const names = ['第一', '第二', '第三', '第四', '第五', '第六', '第七', '第八', '第九', '第十'];
    return names[value - 1] || `第 ${value} `;
  }

  function technicianLabel(id) {
    if (!id) return '現場安排';
    const tech = technicianById(id);
    if (!tech) return '現場安排';
    return id === state.primaryTechnicianId ? `${tech.name}（主要技師）` : tech.name;
  }

  function technicianById(id) {
    return state.technicians.find((item) => item.technicianId === id) || null;
  }

  function countItems(items) {
    return (Array.isArray(items) ? items : []).reduce((sum, item) => sum + Math.max(1, Number(item.quantity || 1)), 0);
  }

  function reloadSlots() {
    const date = document.getElementById('bookingDate');
    if (date?.value) date.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function clientError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  }
})();
