(() => {
  'use strict';

  const state = {
    config: null,
    idToken: '',
    maxTicketsPerDay: 1,
    remainingTodayCount: 1,
    usedTodayCount: 0,
    offers: [],
    selected: new Set(),
    claimingEventTickets: new Set(),
    busy: false,
    refreshPromise: null,
    initialized: false
  };

  let toolbar = null;
  let selectionText = null;
  let selectionHint = null;
  let useButton = null;
  let messageBox = null;
  let observer = null;

  function endpoint() {
    return `${String(state.config && state.config.supabaseUrl || '').replace(/\/$/, '')}/functions/v1/event-ticket-extension-api`;
  }

  function testSessionToken() {
    return window.TestModeClient && typeof window.TestModeClient.getSessionToken === 'function'
      ? String(window.TestModeClient.getSessionToken() || '')
      : '';
  }

  function normalizeLimit(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 50 ? parsed : 1;
  }

  async function extensionRequest(operation, payload = {}) {
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: String(state.config && state.config.supabasePublishableKey || '') },
      cache: 'no-store',
      body: JSON.stringify({
        ...payload,
        operation,
        idToken: state.idToken,
        testSessionToken: testSessionToken()
      })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      const error = new Error(result && result.error && result.error.message || '活動票券服務暫時無法完成操作。');
      error.code = result && result.error && result.error.code || 'API_ERROR';
      throw error;
    }
    return result.data || {};
  }

  function offerEventTicketId(offer) {
    return String(offer && offer.ticket && offer.ticket.eventTicketId || offer && offer.claim && offer.claim.eventTicketId || '').trim();
  }

  function offerClaimId(offer) {
    return String(offer && offer.claim && offer.claim.claimId || '').trim();
  }

  function selectableOffers() {
    return state.offers.filter((offer) => Boolean(
      offer && !offer.history && (
        (offer.claim && offer.canUse && offerClaimId(offer)) ||
        (!offer.claim && offer.canClaim)
      )
    ));
  }

  function usableOffers() {
    return state.offers.filter((offer) => Boolean(offer && !offer.history && offer.claim && offer.canUse && offerClaimId(offer)));
  }

  function selectedOffers() {
    const ids = state.selected;
    return usableOffers().filter((offer) => ids.has(offerClaimId(offer)));
  }

  function hasDailyLimit() {
    return state.maxTicketsPerDay > 0;
  }

  function selectionLimit() {
    return hasDailyLimit() ? Math.max(0, Math.min(state.maxTicketsPerDay, state.remainingTodayCount)) : Number.POSITIVE_INFINITY;
  }

  function dailyLimitLabel() {
    return hasDailyLimit() ? `${state.maxTicketsPerDay} 張` : '不限張數';
  }

  function ensureToolbar() {
    if (toolbar && document.contains(toolbar)) return toolbar;
    const eventToolbar = document.querySelector('.event-toolbar');
    if (!eventToolbar) return null;
    toolbar = document.createElement('section');
    toolbar.className = 'event-batch-toolbar';
    toolbar.setAttribute('aria-label', '活動票券多張使用');
    toolbar.innerHTML = '<div class="event-batch-copy"><strong data-event-batch-selection>尚未選擇票券</strong><small data-event-batch-hint>勾選活動票券；尚未領取的票券，確認勾選即代表領取。</small></div><button class="event-batch-use-button" type="button" disabled>使用已選票券</button><p class="event-batch-message hidden" role="status" aria-live="polite"></p>';
    eventToolbar.insertAdjacentElement('afterend', toolbar);
    selectionText = toolbar.querySelector('[data-event-batch-selection]');
    selectionHint = toolbar.querySelector('[data-event-batch-hint]');
    useButton = toolbar.querySelector('.event-batch-use-button');
    messageBox = toolbar.querySelector('.event-batch-message');
    useButton.addEventListener('click', redeemSelected);
    return toolbar;
  }

  function showMessage(message = '', error = false) {
    ensureToolbar();
    if (!messageBox) return;
    messageBox.textContent = message;
    messageBox.classList.toggle('hidden', !message);
    messageBox.classList.toggle('is-error', Boolean(error));
  }

  function updateToolbar() {
    ensureToolbar();
    if (!toolbar) return;
    const selectableCount = selectableOffers().length;
    const selectedCount = state.selected.size;
    const limit = selectionLimit();
    selectionText.textContent = selectedCount
      ? (hasDailyLimit()
        ? `已選 ${selectedCount} / ${limit} 張 · 今日已使用 ${state.usedTodayCount} / ${state.maxTicketsPerDay} 張`
        : `已選 ${selectedCount} 張 · 今日已使用 ${state.usedTodayCount} 張 · 每日上限不限張數`)
      : (hasDailyLimit()
        ? `今日還可使用 ${limit} 張 · 每日上限 ${state.maxTicketsPerDay} 張`
        : `目前可使用 ${selectableCount} 張 · 每日上限不限張數`);
    selectionHint.textContent = selectableCount
      ? `目前有 ${selectableCount} 張可勾選；尚未領取的票券，勾選確認後會先完成領取。`
      : (hasDailyLimit() && limit <= 0 ? '今日活動票券使用張數已達上限。' : '目前沒有可勾選的活動票券。');
    useButton.disabled = state.busy || selectedCount < 1 || selectedCount > limit;
    useButton.textContent = state.busy ? '核銷中…' : selectedCount > 1 ? `使用已選 ${selectedCount} 張` : '使用已選票券';
  }

  function findCard(eventTicketId) {
    const buttons = document.querySelectorAll('#eventList [data-event-ticket-id]');
    for (const button of buttons) {
      if (String(button.dataset.eventTicketId || '') === eventTicketId) return button.closest('.event-ticket');
    }
    return null;
  }

  function decorateCards() {
    const selectable = selectableOffers();
    const selectableByEvent = new Map(selectable.map((offer) => [offerEventTicketId(offer), offer]));
    const limit = selectionLimit();

    document.querySelectorAll('#eventList .event-ticket').forEach((card) => {
      const button = card.querySelector('[data-event-ticket-id]');
      const eventTicketId = String(button && button.dataset.eventTicketId || '');
      const offer = selectableByEvent.get(eventTicketId);
      const existing = card.querySelector('[data-event-batch-select]');
      if (!offer) {
        existing && existing.remove();
        return;
      }

      const claimId = offerClaimId(offer);
      let control = existing;
      if (!control) {
        control = document.createElement('label');
        control.className = 'event-batch-select';
        control.dataset.eventBatchSelect = 'true';
        control.innerHTML = '<input type="checkbox"><span></span>';
        const action = card.querySelector('.event-ticket-action') || card;
        action.insertBefore(control, action.firstChild);
        control.querySelector('input').addEventListener('change', (event) => { void handleSelectionChange(event); });
      }
      const input = control.querySelector('input');
      const label = control.querySelector('span');
      input.dataset.claimId = claimId;
      input.dataset.eventTicketId = eventTicketId;
      input.checked = Boolean(claimId && state.selected.has(claimId));
      const claiming = state.claimingEventTickets.has(eventTicketId);
      input.disabled = state.busy || claiming || (hasDailyLimit() && !input.checked && state.selected.size + state.claimingEventTickets.size >= limit);
      label.textContent = claiming ? '領取中…' : claimId ? '加入本次使用' : '勾選並領取';
    });
    updateToolbar();
  }

  async function handleSelectionChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const eventTicketId = String(input.dataset.eventTicketId || '');
    const offer = state.offers.find((item) => offerEventTicketId(item) === eventTicketId);
    if (!offer) return;
    const existingClaimId = offerClaimId(offer);
    showMessage('');

    if (!input.checked) {
      if (existingClaimId) state.selected.delete(existingClaimId);
      decorateCards();
      return;
    }

    const limit = selectionLimit();
    if (hasDailyLimit() && state.selected.size + state.claimingEventTickets.size >= limit) {
      input.checked = false;
      showMessage(`今日最多還能選擇 ${limit} 張活動票券；每日上限為 ${state.maxTicketsPerDay} 張。`, true);
      decorateCards();
      return;
    }

    if (existingClaimId) {
      state.selected.add(existingClaimId);
      decorateCards();
      return;
    }

    const title = String(offer.ticket && offer.ticket.title || '活動票券');
    if (!window.confirm(`勾選「${title}」即代表領取此活動票券。\n\n領取後會加入本次使用清單，是否繼續？`)) {
      input.checked = false;
      decorateCards();
      return;
    }

    state.claimingEventTickets.add(eventTicketId);
    decorateCards();
    try {
      const result = await window.MemberSystem.request(
        state.config, 'event', state.idToken, 'user.event.ticket.claim', { eventTicketId }
      );
      await refreshSnapshot();
      const claimedOffer = state.offers.find((item) => offerEventTicketId(item) === eventTicketId);
      const claimId = offerClaimId(claimedOffer);
      if (!claimId) throw new Error('票券已領取，但目前無法取得票券識別，請重新整理後再試。');
      if (hasDailyLimit() && state.selected.size >= selectionLimit()) {
        showMessage('票券已領取，但今日可使用張數已無剩餘額度，因此未加入本次使用。', true);
      } else {
        state.selected.add(claimId);
        showMessage(result && result.alreadyClaimed ? '這張票券已領取，已加入本次使用。' : '票券已領取並加入本次使用。');
      }
      window.dispatchEvent(new CustomEvent('event-ticket:selection-claimed', { detail: { eventTicketId, claimId } }));
    } catch (error) {
      input.checked = false;
      showMessage(error && error.message || '領取活動票券失敗，請稍後再試。', true);
    } finally {
      state.claimingEventTickets.delete(eventTicketId);
      decorateCards();
    }
  }

  function currentLocation() {
    if (!navigator.geolocation) return Promise.reject(new Error('此裝置無法定位，需要定位的票券尚未核銷。'));
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          observedAt: new Date(position.timestamp).toISOString()
        }),
        () => reject(new Error('定位遭拒或逾時，票券尚未核銷。請允許定位後重試。')),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
    });
  }

  function requestId() {
    if (crypto && typeof crypto.randomUUID === 'function') return 'EVB-' + crypto.randomUUID().replaceAll('-', '');
    return 'EVB-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  async function redeemSelected() {
    if (state.busy) return;
    const offers = selectedOffers();
    if (!offers.length) return;
    if (hasDailyLimit() && offers.length > selectionLimit()) {
      showMessage(`今日最多還能使用 ${selectionLimit()} 張活動票券；每日上限為 ${state.maxTicketsPerDay} 張。`, true);
      return;
    }

    const titles = offers.map((offer) => String(offer.ticket && offer.ticket.title || '活動票券'));
    const requiresLocation = offers.some((offer) => Boolean(offer.ticket && offer.ticket.requiresLocation));
    if (!window.confirm(`確定現在一次使用 ${offers.length} 張活動票券？\n\n${titles.map((title) => '・' + title).join('\n')}\n\n確認後將立即核銷且無法復原。`)) return;

    state.busy = true;
    decorateCards();
    showMessage(requiresLocation ? '正在取得定位並確認票券使用條件…' : '正在確認票券使用條件…');

    try {
      const location = requiresLocation ? await currentLocation() : null;
      const result = await extensionRequest('member.redeem', {
        claimIds: offers.map(offerClaimId),
        requestId: requestId(),
        location
      });
      state.selected.clear();
      const count = Number(result.ticketCount || offers.length);
      const lotteryResults = Array.isArray(result.tickets)
        ? result.tickets.filter((ticket) => ticket && ticket.ticketType === 'lottery' && ticket.result)
        : [];
      const extra = lotteryResults.length
        ? ' ' + lotteryResults.map((ticket) => `${ticket.ticketTitle}：${ticket.result.prizeTitle || '結果已記錄'}`).join('；')
        : '';
      showMessage(`已成功使用 ${count} 張活動票券。${extra}`);
      window.dispatchEvent(new CustomEvent('event-ticket:batch-redeemed', { detail: result }));
      await refreshSnapshot();
      window.setTimeout(() => {
        const refresh = document.getElementById('todayUsableTicketCount');
        if (refresh) window.dispatchEvent(new Event('focus'));
      }, 100);
    } catch (error) {
      showMessage(error && error.message || '活動票券核銷失敗，請重新整理後再試。', true);
    } finally {
      state.busy = false;
      decorateCards();
    }
  }

  async function refreshSnapshot() {
    if (!state.config || !state.idToken) return;
    if (state.refreshPromise) return state.refreshPromise;
    state.refreshPromise = (async () => {
      const [setting, today, snapshot] = await Promise.all([
        extensionRequest('member.settings.get'),
        extensionRequest('member.today-usable'),
        window.MemberSystem.request(state.config, 'event', state.idToken, 'user.event.bootstrap', { compact: false })
      ]);
      state.maxTicketsPerDay = normalizeLimit(setting.maxTicketsPerDay ?? setting.maxTicketsPerRedemption);
      state.usedTodayCount = Math.max(0, Number(today.usedTodayCount || 0));
      state.remainingTodayCount = hasDailyLimit()
        ? Math.max(0, Math.min(state.maxTicketsPerDay, Number(today.remainingTodayCount ?? (state.maxTicketsPerDay - state.usedTodayCount))))
        : Number.POSITIVE_INFINITY;
      state.offers = Array.isArray(snapshot && snapshot.offers) ? snapshot.offers : [];
      const validClaims = new Set(usableOffers().map(offerClaimId));
      for (const claimId of [...state.selected]) if (!validClaims.has(claimId)) state.selected.delete(claimId);
      while (hasDailyLimit() && state.selected.size > selectionLimit()) state.selected.delete([...state.selected].pop());
      ensureToolbar();
      decorateCards();
    })();
    try { await state.refreshPromise; } finally { state.refreshPromise = null; }
  }

  function connectObserver() {
    const list = document.getElementById('eventList');
    if (!list || observer) return;
    observer = new MutationObserver(() => {
      window.setTimeout(() => {
        decorateCards();
        if (!state.busy) refreshSnapshot().catch(() => {});
      }, 0);
    });
    observer.observe(list, { childList: true });
  }

  async function initialize() {
    const session = window.MemberSystem && typeof window.MemberSystem.getSession === 'function'
      ? window.MemberSystem.getSession('event')
      : null;
    if (!session) return;
    state.config = session.config;
    state.idToken = session.idToken;
    ensureToolbar();
    connectObserver();
    try {
      await refreshSnapshot();
      state.initialized = true;
    } catch (error) {
      showMessage(error && error.message || '活動票券多張使用設定暫時無法載入。', true);
    }
  }

  window.addEventListener('user-tour:ready', (event) => {
    if (event && event.detail && event.detail.surface === 'event') initialize();
  });
  window.addEventListener('focus', () => {
    if (state.initialized && !state.busy) refreshSnapshot().catch(() => {});
  });
  window.addEventListener('event-ticket:batch-redeemed', () => {
    if (!state.busy) refreshSnapshot().catch(() => {});
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      ensureToolbar();
      connectObserver();
      initialize();
    }, { once: true });
  } else {
    ensureToolbar();
    connectObserver();
    initialize();
  }
})();
