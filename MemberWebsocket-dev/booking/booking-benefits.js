(() => {
  'use strict';
  let config = null;
  let idToken = '';
  let sequence = 0;
  let timer = null;
  let inFlight = false;
  let queued = false;
  let disposed = false;
  let renderedItems = [];
  let eventTicketMaxPerDay = 1;
  let pointTicketMaxPerRedemption = 1;
  let currentBookingId = '';
  let claimingEventTicketId = '';
  let currentServiceIds = new Set();
  const selected = new Map();
  const kinds = { points: '集點卡票券', event: '活動票券', calendar: '會員活動' };
  const kindOrder = ['calendar', 'points', 'event'];
  const selectableKinds = new Set(['points', 'event']);
  const el = (id) => document.getElementById(id);
  const keyFor = (kind, id) => `${String(kind || '')}:${String(id || '')}`;

  function state(value, message) {
    const section = el('bookingBenefits');
    if (!section) return;
    section.dataset.state = value;
    el('bookingBenefitsStatus').textContent = message;
    el('bookingBenefitsRetry').classList.toggle('hidden', value !== 'error');
    el('bookingBenefitsList').setAttribute('aria-busy', String(value === 'loading'));
  }

  function destination(item) {
    // Booking is the action surface for tickets: members select/redemption-intent
    // here, so point/event tickets do not need a secondary "details" navigation.
    if (item?.kind !== 'calendar') return '';
    return new URL('../calendar/', window.location.href).href;
  }

  function selectionPayload() {
    return [...selected.values()].map((item) => ({ kind: item.kind, id: item.id }));
  }

  function selectionSummary() {
    return [...selected.values()].map((item) => ({
      kind: item.kind,
      id: item.id,
      title: item.title || kinds[item.kind] || '可用權益',
      cardTitle: item.cardTitle || '',
      status: item.status || 'pending',
    }));
  }

  function emitSelectionChange() {
    window.dispatchEvent(new CustomEvent('booking:benefits-changed', {
      detail: { benefits: selectionPayload(), summary: selectionSummary() },
    }));
  }

  function selectedCount(kind) {
    return [...selected.values()].filter((item) => item.kind === kind).length;
  }

  function selectedEventCount() {
    return selectedCount('event');
  }

  function selectedPointCount() {
    return selectedCount('points');
  }

  function normalizeLimit(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 50 ? parsed : 1;
  }

  function hasLimit(value) {
    return Number(value) > 0;
  }

  function limitLabel(value, unitLabel) {
    return hasLimit(value) ? `${value} 張` : `不限張數${unitLabel ? `（${unitLabel}）` : ''}`;
  }

  function requiredServiceIds(item) {
    return (Array.isArray(item?.requiredServiceIds) ? item.requiredServiceIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean);
  }

  function requiredServiceTitles(item) {
    const titles = (Array.isArray(item?.requiredServiceTitles) ? item.requiredServiceTitles : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    return titles.length ? titles : requiredServiceIds(item);
  }

  function serviceIdKey(value) {
    return String(value || '').trim();
  }

  function serviceRequirementMet(item) {
    const groups = Array.isArray(item?.requiredServiceGroups) ? item.requiredServiceGroups : [];
    if (groups.length) {
      return groups.some(group => Array.isArray(group) && group.length > 0
        && group.every(serviceId => currentServiceIds.has(serviceIdKey(serviceId))));
    }
    const required = requiredServiceIds(item);
    if (!required.length) return true;
    const matchMode = item?.requiredServiceMatchMode === 'all' ? 'all' : 'any';
    return matchMode === 'all'
      ? required.every((serviceId) => currentServiceIds.has(serviceIdKey(serviceId)))
      : required.some((serviceId) => currentServiceIds.has(serviceIdKey(serviceId)));
  }

  function serviceRequirementMessage(item) {
    const compact = String(item?.requiredServiceRequirementLabel || '').trim();
    if (compact) return `${compact}才能使用這張票券。`;
    const required = requiredServiceTitles(item);
    return required.length ? `需先預約「${required.join('、')}」其中一個項目才能使用這張票券。` : '';
  }

  function pointItemForSelection(selectionId) {
    const id = String(selectionId || '');
    return renderedItems.find((item) => item?.kind === 'points' && String(item.selectionId || '') === id) || null;
  }

  function selectedPointSpend(cardId) {
    const key = String(cardId || '');
    let total = 0;
    for (const item of selected.values()) {
      if (item.kind !== 'points') continue;
      const offer = pointItemForSelection(item.id);
      if (!offer || String(offer.cardId || '') !== key) continue;
      total += Math.max(0, Number(offer.pointCost || 0));
    }
    return total;
  }

  function pointBudget(item) {
    const balance = Math.max(0, Number(item?.pointBalance || 0));
    const cost = Math.max(0, Number(item?.pointCost || 0));
    const spent = selectedPointSpend(item?.cardId);
    return {
      balance,
      cost,
      spent,
      affordable: cost > 0 && spent + cost <= balance,
    };
  }

  function setRefreshing(message) {
    const list = el('bookingBenefitsList');
    const hasVisibleContent = renderedItems.length > 0 && Boolean(list?.children.length);
    state(hasVisibleContent ? 'ready' : 'loading', message);
    list?.setAttribute('aria-busy', 'true');
  }

  function reconcileSelectedItems(items) {
    const byKey = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const kind = String(item?.kind || '');
      const id = String(item?.selectionId || '');
      if (selectableKinds.has(kind) && id) byKey.set(keyFor(kind, id), item);
    }

    const pointSpendByCard = new Map();
    let changed = false;
    for (const [key, selection] of [...selected.entries()]) {
      const item = byKey.get(key);
      if (!item || item.selectable !== true || !serviceRequirementMet(item)) {
        selected.delete(key);
        changed = true;
        continue;
      }
      if (selection.kind !== 'points') continue;

      const cardId = String(item.cardId || '');
      const balance = Math.max(0, Number(item.pointBalance || 0));
      const cost = Math.max(0, Number(item.pointCost || 0));
      const spent = Number(pointSpendByCard.get(cardId) || 0);
      if (!cardId || cost <= 0 || spent + cost > balance) {
        selected.delete(key);
        changed = true;
        continue;
      }
      pointSpendByCard.set(cardId, spent + cost);
    }
    return changed;
  }

  async function handleSelectionChange(item, input) {
    const selectionId = String(item.selectionId || '');
    const selectedKey = selectionId ? keyFor(item.kind, selectionId) : '';
    if (!input.checked) {
      if (selectedKey) selected.delete(selectedKey);
      render(renderedItems);
      emitSelectionChange();
      return;
    }

    if (!serviceRequirementMet(item)) {
      input.checked = false;
      const message = serviceRequirementMessage(item);
      render(renderedItems);
      state('ready', message);
      el('bookingBenefitsStatus')?.focus?.({ preventScroll: false });
      return;
    }

    if (item.kind === 'event' && hasLimit(eventTicketMaxPerDay) && selectedEventCount() >= eventTicketMaxPerDay) {
      input.checked = false;
      state('ready', `活動票券每日最多可選 ${eventTicketMaxPerDay} 張。`);
      render(renderedItems);
      return;
    }
    if (item.kind === 'points' && hasLimit(pointTicketMaxPerRedemption) && selectedPointCount() >= pointTicketMaxPerRedemption) {
      input.checked = false;
      state('ready', `集點卡票券每筆預約最多可選 ${pointTicketMaxPerRedemption} 張。`);
      render(renderedItems);
      return;
    }
    if (item.kind === 'points') {
      const budget = pointBudget(item);
      if (!budget.affordable) {
        input.checked = false;
        const cardTitle = String(item.cardTitle || '集點卡');
        state('ready', `${cardTitle}目前 ${budget.balance} 點，本次已選票券需 ${budget.spent} 點，無法再使用需 ${budget.cost} 點的票券。`);
        render(renderedItems);
        return;
      }
    }

    if (item.kind === 'event' && item.claimRequired === true) {
      const title = String(item.title || '活動票券');
      if (!window.confirm(`勾選「${title}」即代表領取此活動票券。\n\n領取後會直接加入本次預約使用，是否繼續？`)) {
        input.checked = false;
        render(renderedItems);
        return;
      }
      claimingEventTicketId = String(item.id || '');
      render(renderedItems);
      try {
        const result = await window.BookingSystem.claimEventTicket(config, idToken, item.id);
        const claimId = String(result?.ticket?.claimId || '');
        if (!claimId) throw new Error('票券已領取，但無法取得票券識別，請重新整理後再試。');
        renderedItems = renderedItems.map((current) => current?.kind === 'event' && current?.id === item.id
          ? { ...current, claimRequired: false, selectionId: claimId, selectable: true, statusLabel: '可使用', subtitle: '已領取，尚未使用' }
          : current);
        selected.set(keyFor('event', claimId), {
          kind: 'event', id: claimId, title, status: 'pending',
        });
        state('ready', result?.alreadyClaimed ? '這張活動票券已領取，已加入本次預約。' : '活動票券已領取並加入本次預約。');
        emitSelectionChange();
      } catch (error) {
        state('ready', String(error?.message || '活動票券領取失敗，請重新整理後再試。'));
      } finally {
        claimingEventTicketId = '';
        render(renderedItems);
      }
      return;
    }

    if (!selectionId) {
      input.checked = false;
      render(renderedItems);
      return;
    }
    selected.set(selectedKey, { kind: item.kind, id: selectionId, title: String(item.title || ''), cardTitle: item.kind === 'points' ? String(item.cardTitle || '') : '', status: 'pending' });
    render(renderedItems);
    emitSelectionChange();
  }

  function updateReadyMessage(cardCount) {
    if (!cardCount) {
      state('empty', '目前沒有可用活動或票券，仍可正常預約。');
      return;
    }
    const count = selected.size;
    state('ready', count
      ? `已選擇 ${count} 張票券；服務完成時由管理端重新驗證並核銷。`
      : `${cardCount} 項活動／票券 · 活動僅顯示；集點卡票券單次 ${limitLabel(pointTicketMaxPerRedemption, '0 代表不限')};活動票券每日 ${limitLabel(eventTicketMaxPerDay, '0 代表不限')}。`);
  }

  function render(items = renderedItems) {
    renderedItems = Array.isArray(items) ? items : [];
    window.dispatchEvent(new CustomEvent('booking:benefits-loaded', { detail: { items: renderedItems } }));
    const list = el('bookingBenefitsList');
    if (!list) return;
    list.replaceChildren();
    let cardCount = 0;

    for (const kind of kindOrder) {
      const groupItems = renderedItems.filter((item) => item?.kind === kind);
      if (!groupItems.length) continue;

      const group = document.createElement('section');
      group.className = 'booking-benefit-group';
      group.dataset.benefitKind = kind;

      const heading = document.createElement('div');
      heading.className = 'booking-benefit-group-heading';
      const groupTitle = document.createElement('h3');
      groupTitle.className = 'booking-benefit-group-title';
      groupTitle.textContent = kinds[kind];
      const groupCount = document.createElement('span');
      groupCount.className = 'booking-benefit-group-count';
      groupCount.textContent = String(groupItems.length) + ' 項';
      heading.append(groupTitle, groupCount);

      const grid = document.createElement('div');
      grid.className = 'booking-benefit-group-grid';

      for (const item of groupItems) {
        const selectionId = String(item.selectionId || '');
        const controlId = selectionId || (item.kind === 'event' && item.claimRequired === true ? String(item.id || '') : '');
        const key = keyFor(item.kind, selectionId);
        const isSelected = Boolean(selectionId && selected.has(key));
        const selectable = selectableKinds.has(item.kind) && item.selectable === true && Boolean(controlId);
        const claiming = item.kind === 'event' && String(item.id || '') === claimingEventTicketId;
        const pointLimitBlocked = item.kind === 'points' && hasLimit(pointTicketMaxPerRedemption) && !isSelected && selectedPointCount() >= pointTicketMaxPerRedemption;
        const pointBudgetBlocked = item.kind === 'points' && !isSelected && !pointBudget(item).affordable;
        const serviceBlocked = selectableKinds.has(item.kind) && !serviceRequirementMet(item);
        const pointUnavailable = item.kind === 'points'
          && !isSelected
          && (!selectable || pointBudgetBlocked || serviceBlocked);

        const eventUnavailable = item.kind === 'event' && !isSelected && (!selectable || serviceBlocked || (hasLimit(eventTicketMaxPerDay) && selectedEventCount() >= eventTicketMaxPerDay));
        const card = item.kind === 'event' && window.EventTicketUI
          ? window.EventTicketUI.create(item, { fixed: Boolean(item.fixedTicketTemplateId), stateLabel: item.statusLabel, stateClass: item.locked ? 'tier-locked' : eventUnavailable ? 'ended' : 'open' })
          : document.createElement('article');
        card.classList.add('booking-benefit', 'ui-ticket');
        card.classList.toggle('is-selected', isSelected);
        card.classList.toggle('is-unavailable', pointUnavailable || eventUnavailable);
        card.dataset.benefitKind = item.kind;
        if (pointUnavailable || eventUnavailable) card.setAttribute('aria-disabled', 'true');
        if (item.kind === 'points') card.dataset.cardStyle = window.MemberUI.pointCardStyleKey(item.cardStyleKey);

        const meta = document.createElement('p');
        meta.className = 'booking-benefit-meta';
        meta.textContent = String(item.statusLabel || '');

        const title = document.createElement('h4');
        title.textContent = String(item.title || '可用權益');

        const copy = document.createElement('p');
        copy.textContent = String(item.subtitle || '');

        const expires = document.createElement('small');
        expires.textContent = item.endsOn ? `有效至 ${String(item.endsOn).replaceAll('-', '/')}` : '依使用說明適用';

        const condition = document.createElement('small');
        condition.className = 'booking-benefit-condition';
        condition.textContent = String(item.conditionLabel || '服務限制：目前未設定');

        if (controlId && selectableKinds.has(item.kind)) {
          const choose = document.createElement('label');
          choose.className = 'booking-benefit-select';
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = isSelected;
          input.disabled = claiming
            || (item.kind === 'event' && Boolean(claimingEventTicketId) && !isSelected)
            || ((!selectable
              || (item.kind === 'event' && hasLimit(eventTicketMaxPerDay) && !isSelected && selectedEventCount() >= eventTicketMaxPerDay)
              || pointLimitBlocked
              || pointBudgetBlocked || serviceBlocked) && !isSelected);
          input.dataset.bookingBenefitKind = item.kind;
          input.dataset.bookingBenefitId = controlId;
          if (item.kind === 'event' && item.claimRequired === true) input.dataset.bookingBenefitClaimRequired = 'true';
          input.setAttribute('aria-label', `本次預約使用${String(item.title || '此權益')}`);
          const label = document.createElement('span');
          label.textContent = claiming
            ? '領取中…'
            : item.kind === 'event' && item.claimRequired === true
              ? '勾選並領取'
              : isSelected
                ? '已選擇（可取消）'
                : pointBudgetBlocked
                  ? '點數不足'
                  : pointLimitBlocked
                    ? '已達單次上限'
                    : item.kind === 'event' && (item.reservedInSnapshot || (item.reservedForBooking && !item.reservedForCurrentBooking))
                      ? '已登記，不能重複登記'
                    : serviceBlocked
                      ? `需先預約：${item.requiredServiceRequirementLabel || requiredServiceTitles(item).join('、')}`
                      : selectable ? '本次預約使用' : '目前不可勾選';
          choose.append(input, label);
          input.addEventListener('change', () => {
            if (input.checked && !selectable) {
              input.checked = false;
              return;
            }
            void handleSelectionChange(item, input);
          });
          if (card.classList.contains('event-ticket')) card.append(condition, choose);
          else card.append(meta, title, copy, expires, condition, choose);
        } else {
          if (card.classList.contains('event-ticket')) card.append(condition);
          else card.append(meta, title, copy, expires, condition);
        }

        if (item.kind === 'points') {
          card.insertBefore(window.MemberUI.pointTicketDetails(item), card.querySelector('.booking-benefit-select'));
        }

        if (serviceBlocked) {
          const reason = document.createElement('small');
          reason.className = 'booking-benefit-disabled-reason';
          reason.textContent = serviceRequirementMessage(item);
          card.appendChild(reason);
        }

        if (!selectable && item.disabledReason) {
          const reason = document.createElement('small');
          reason.className = 'booking-benefit-disabled-reason';
          reason.textContent = String(item.disabledReason);
          card.appendChild(reason);
        }

        const href = destination(item);
        if (href) {
          const link = document.createElement('a');
          link.className = 'booking-benefit-link';
          link.href = href;
          link.textContent = '查看詳情';
          link.setAttribute('aria-label', `查看${String(item.title || '可用權益')}詳情`);
          card.appendChild(link);
        }
        grid.appendChild(card);
        cardCount += 1;
      }

      group.append(heading, grid);
      list.appendChild(group);
    }
    updateReadyMessage(cardCount);
  }

  function setServiceContext(serviceIds) {
    currentServiceIds = new Set(
      (Array.isArray(serviceIds) ? serviceIds : [])
        .map(serviceIdKey)
        .filter(Boolean)
    );
    const changed = reconcileSelectedItems(renderedItems);
    render(renderedItems);
    if (changed) {
      emitSelectionChange();
      state('ready', '目前選取的預約項目不符合部分票券使用條件，已自動取消那些票券。');
    }
  }

  function setSelection(items) {
    selected.clear();
    for (const item of Array.isArray(items) ? items : []) {
      const kind = String(item?.kind || item?.benefitKind || '');
      const id = String(item?.id || item?.benefitRef || '');
      if (!selectableKinds.has(kind) || !id) continue;
      selected.set(keyFor(kind, id), {
        kind, id,
        title: String(item?.title || item?.titleSnapshot || ''),
        cardTitle: String(item?.cardTitle || ''),
        status: String(item?.status || 'pending'),
      });
    }
    if (el('bookingBenefitsList')) render(renderedItems);
    emitSelectionChange();
  }

  function clearSelection() {
    if (!selected.size) return;
    selected.clear();
    if (el('bookingBenefitsList')) render(renderedItems);
    emitSelectionChange();
  }

  function setBookingContext(bookingId = '') {
    const nextBookingId = String(bookingId || '');
    if (nextBookingId === currentBookingId) return;
    currentBookingId = nextBookingId;
    if (config && !disposed) syncNow();
  }

  async function load() {
    if (!config || disposed) return;
    if (inFlight) { queued = true; return; }
    const current = ++sequence;
    inFlight = true;
    setRefreshing(renderedItems.length ? '正在背景同步可用權益…' : '正在確認你的可用權益…');
    try {
      const result = await window.BookingSystem.bookingBenefits(config, idToken, currentBookingId);
      if (current !== sequence || disposed) return;
      const nextEventLimit = normalizeLimit(result?.eventTicketMaxPerDay);
      const nextPointLimit = normalizeLimit(result?.pointTicketMaxPerRedemption);
      const nextItems = Array.isArray(result?.items) ? result.items : [];
      const selectionChanged = reconcileSelectedItems(nextItems);
      const changed = nextEventLimit !== eventTicketMaxPerDay
        || nextPointLimit !== pointTicketMaxPerRedemption
        || JSON.stringify(nextItems) !== JSON.stringify(renderedItems);
      eventTicketMaxPerDay = nextEventLimit;
      pointTicketMaxPerRedemption = nextPointLimit;
      if (changed || selectionChanged) render(nextItems);
      else updateReadyMessage(renderedItems.length);
      if (selectionChanged) emitSelectionChange();
    } catch (_) {
      if (current !== sequence || disposed) return;
      if (renderedItems.length) state('ready', '可用權益同步失敗，已保留目前資料；可稍後重試。');
      else state('error', '活動與票券暫時無法載入，仍可正常預約。');
    } finally {
      inFlight = false;
      if (queued && !disposed) { queued = false; syncNow(); }
    }
  }

  function invalidate() {
    if (!config || disposed) return;
    if (inFlight) {
      sequence += 1;
      queued = true;
      return;
    }
    if (timer !== null) return;
    setRefreshing('正在背景同步可用權益…');
    timer = window.setTimeout(() => { timer = null; void load(); }, 450);
  }

  function syncNow() {
    if (!config || disposed) return;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    setRefreshing('正在同步最新點數與可用票券…');
    void load();
  }

  function start(nextConfig, token) {
    if (config || !el('bookingBenefits')) return;
    config = nextConfig;
    idToken = token;
    el('bookingBenefitsRetry')?.addEventListener('click', () => {
      if (timer !== null) { window.clearTimeout(timer); timer = null; }
      void load();
    });
    void load();
  }

  let freshness = null;
  function scheduleMidnight() {
    const day = 86_400_000;
    const localTime = (Date.now() + 8 * 3_600_000) % day;
    freshness = window.setTimeout(() => {
      if (document.visibilityState !== 'hidden' && navigator.onLine) invalidate();
      scheduleMidnight();
    }, day - localTime + 1000);
  }
  scheduleMidnight();
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    disposed = true;
    sequence += 1;
    window.clearTimeout(freshness);
    if (timer !== null) window.clearTimeout(timer);
  });

  window.BookingBenefits = Object.freeze({
    start,
    getItems: () => renderedItems.map(item => ({ ...item })),
    invalidate,
    syncNow,
    selectionPayload,
    selectionSummary,
    setBookingContext,
    setServiceContext,
    setSelection,
    clearSelection,
  });
})();
