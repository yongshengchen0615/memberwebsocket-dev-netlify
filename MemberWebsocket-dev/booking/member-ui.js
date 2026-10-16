(() => {
  'use strict';

  if (!window.BookingSystem || typeof window.BookingSystem.memberProfile !== 'function') return;
  if (!window.MembershipProgress || typeof window.MembershipProgress.render !== 'function') return;

  const originalMemberProfile = window.BookingSystem.memberProfile.bind(window.BookingSystem);
  const originalRequest = window.BookingSystem.request.bind(window.BookingSystem);
  const originalConfirm = window.confirm.bind(window);
  const BOOKING_GROUPS = [
    { key: 'reserved', title: '已預約服務', tabTitle: '已預約', description: '等待確認、已確認與取消待確認的預約服務。' },
    { key: 'completed', title: '已完成的服務', tabTitle: '已完成', description: '已由管理端確認完成的服務紀錄。' },
    { key: 'cancelled', title: '已取消的服務', tabTitle: '已取消', description: '已由管理端確認取消或未通過的預約服務。' },
    { key: 'no_show', title: '無故未到', tabTitle: '無故未到', description: '由管理端標記為無故未到的預約紀錄。' },
  ];
  let lastProfile = null;
  let expandedBookingId = '';
  let activeBookingGroup = 'reserved';
  let bookingGroupManuallySelected = false;

  function membershipRequiredError() {
    if (typeof window.BookingSystem.clientError === 'function') {
      return window.BookingSystem.clientError('MEMBERSHIP_REQUIRED', '請先完成會員加入後再使用預約功能。');
    }
    const error = new Error('請先完成會員加入後再使用預約功能。');
    error.code = 'MEMBERSHIP_REQUIRED';
    return error;
  }

  function clientError(code, message) {
    if (typeof window.BookingSystem.clientError === 'function') return window.BookingSystem.clientError(code, message);
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function showMembershipRequiredView() {
    const loadingView = document.getElementById('loadingView');
    const bookingView = document.getElementById('bookingView');
    const errorView = document.getElementById('errorView');
    const errorTitle = document.getElementById('errorTitle');
    const errorMessage = document.getElementById('errorMessage');
    const joinMemberButton = document.getElementById('joinMemberButton');
    const retryButton = document.getElementById('retryButton');

    if (loadingView) loadingView.classList.add('hidden');
    if (bookingView) bookingView.classList.add('hidden');
    if (errorView) errorView.classList.remove('hidden');
    if (errorTitle) errorTitle.textContent = '請先加入會員';
    if (errorMessage) errorMessage.textContent = '加入會員並完成會員資料後，才能使用預約功能。';
    if (joinMemberButton) joinMemberButton.classList.remove('hidden');
    if (retryButton) retryButton.classList.add('hidden');
  }

  function renderMembershipProgress() {
    const root = document.getElementById('membershipProgress');
    if (!root || !lastProfile) return;
    window.MembershipProgress.render(root, lastProfile);
  }

  async function cancellationRequest(config, idToken, action, payload = {}) {
    const endpoint = `${String(config?.supabaseUrl || '').replace(/\/$/, '')}/functions/v1/booking-cancellation-api`;
    if (!endpoint.startsWith('https://')) throw clientError('API_CONFIG_MISSING', '取消申請服務尚未設定。');
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          apikey: String(config?.supabasePublishableKey || ''),
        },
        body: JSON.stringify(window.TestModeClient && typeof window.TestModeClient.payload === 'function'
          ? window.TestModeClient.payload({ ...payload, action, clientType: 'member', idToken })
          : { ...payload, action, clientType: 'member', idToken }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok !== true) {
        throw clientError(String(data?.error?.code || 'API_ERROR'), String(data?.error?.message || '取消申請服務拒絕此操作。'));
      }
      return data.data || {};
    } catch (error) {
      if (error?.code) throw error;
      if (error?.name === 'AbortError') throw clientError('API_TIMEOUT', '取消申請服務回應逾時，請更新後確認申請狀態。');
      throw clientError('NETWORK_ERROR', '目前無法連線取消申請服務。');
    } finally {
      window.clearTimeout(timer);
    }
  }

  function applyCancellationRequests(bookingData, requests) {
    if (!bookingData || !Array.isArray(bookingData.bookings)) return bookingData;
    const pending = new Map((Array.isArray(requests) ? requests : []).map((request) => [request.bookingId, request]));
    return {
      ...bookingData,
      bookings: bookingData.bookings.map((booking) => {
        const request = pending.get(booking.bookingId);
        if (!request) return booking;
        return {
          ...booking,
          baseStatus: booking.status,
          status: 'cancel_requested',
          cancellationRequestedAt: request.cancellationRequestedAt || null,
        };
      }),
    };
  }

  async function enrichBootstrapWithCancellationState(config, idToken, bookingData) {
    try {
      const cancellationData = await cancellationRequest(config, idToken, 'member.list');
      return applyCancellationRequests(bookingData, cancellationData.requests);
    } catch (error) {
      console.warn('booking cancellation state unavailable', error?.code || error?.message || error);
      return bookingData;
    }
  }

  function normalizeBookingUi(root) {
    if (!root) return;
    const badges = [];
    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.('.status-badge')) badges.push(root);
    if (typeof root.querySelectorAll === 'function') badges.push(...root.querySelectorAll('.status-badge'));
    badges.forEach((badge) => {
      if (badge.classList.contains('status-completed') && badge.textContent !== '完成服務') badge.textContent = '完成服務';
      if (badge.classList.contains('status-cancel_requested') && badge.textContent !== '取消待確認') badge.textContent = '取消待確認';
    });

    const buttons = [];
    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.('button')) buttons.push(root);
    if (typeof root.querySelectorAll === 'function') buttons.push(...root.querySelectorAll('button'));
    buttons.forEach((button) => {
      if (button.textContent?.trim() === '取消預約') button.textContent = '申請取消';
    });
  }

  function bookingGroupKey(item) {
    if (item.classList.contains('status-no_show')) return 'no_show';
    if (item.classList.contains('status-completed')) return 'completed';
    if (item.classList.contains('status-cancelled') || item.classList.contains('status-rejected')) return 'cancelled';
    return 'reserved';
  }

  function createBookingGroup(group, items) {
    const section = document.createElement('section');
    section.className = `booking-service-group booking-service-group-${group.key}`;
    section.id = `bookingHistoryPanel-${group.key}`;
    section.dataset.bookingServiceGroup = group.key;
    section.setAttribute('role', 'tabpanel');
    section.setAttribute('aria-labelledby', `bookingHistoryTab-${group.key}`);
    section.tabIndex = 0;

    const description = document.createElement('p');
    description.className = 'booking-history-panel-description';
    description.textContent = group.description;
    const list = document.createElement('div');
    list.className = 'booking-service-group-list';
    if (items.length) {
      list.append(...items);
    } else {
      const empty = document.createElement('div');
      empty.className = 'booking-service-group-empty';
      empty.textContent = group.key === 'no_show' ? '目前沒有無故未到的紀錄' : `目前沒有${group.title}`;
      list.appendChild(empty);
    }
    section.append(description, list);
    return section;
  }

  function createBookingTabs(grouped) {
    const tabs = document.createElement('div');
    tabs.className = 'booking-history-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '我的預約狀態');
    BOOKING_GROUPS.forEach((group) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'booking-history-tab';
      button.id = `bookingHistoryTab-${group.key}`;
      button.dataset.bookingTab = group.key;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', `bookingHistoryPanel-${group.key}`);
      const count = grouped.get(group.key).length;
      button.setAttribute('aria-label', `${group.title}，共 ${count} 筆`);
      const label = document.createElement('span');
      label.className = 'booking-history-tab-label';
      label.textContent = group.tabTitle;
      const badge = document.createElement('span');
      badge.className = 'booking-history-tab-count';
      badge.textContent = `${count} 筆`;
      button.append(label, badge);
      tabs.appendChild(button);
    });
    return tabs;
  }

  function activateBookingGroup(bookingList, key, focusTab = false) {
    if (!BOOKING_GROUPS.some((group) => group.key === key)) return;
    activeBookingGroup = key;
    BOOKING_GROUPS.forEach((group) => {
      const selected = group.key === key;
      const tab = bookingList.querySelector(`#bookingHistoryTab-${group.key}`);
      const panel = bookingList.querySelector(`#bookingHistoryPanel-${group.key}`);
      if (tab) {
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        tab.classList.toggle('is-active', selected);
        if (selected && focusTab) tab.focus();
      }
      if (panel) {
        panel.hidden = !selected;
        panel.classList.toggle('hidden', !selected);
      }
    });
  }

  function handleBookingTabClick(event) {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('[role="tab"][data-booking-tab]');
    const bookingList = button?.closest('#bookingList');
    if (!bookingList) return;
    bookingGroupManuallySelected = true;
    activateBookingGroup(bookingList, button.dataset.bookingTab);
  }

  function handleBookingTabKeydown(event) {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('[role="tab"][data-booking-tab]');
    const bookingList = button?.closest('#bookingList');
    if (!bookingList) return;
    const index = BOOKING_GROUPS.findIndex((group) => group.key === button.dataset.bookingTab);
    if (index < 0) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? BOOKING_GROUPS.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + BOOKING_GROUPS.length) % BOOKING_GROUPS.length;
    bookingGroupManuallySelected = true;
    activateBookingGroup(bookingList, BOOKING_GROUPS[nextIndex].key, true);
  }

  function bookingCardId(card) {
    return String(card?.dataset?.bookingId || '');
  }

  function applyBookingCardAccordionState(card, expanded) {
    if (!card) return;
    const top = card.querySelector(':scope > .booking-item-top');
    card.classList.add('booking-history-collapsible');
    card.classList.toggle('is-expanded', expanded);
    card.dataset.bookingExpanded = expanded ? '1' : '0';
    if (top) {
      top.setAttribute('role', 'button');
      top.setAttribute('tabindex', '0');
      top.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      top.setAttribute('aria-label', expanded ? '收合預約詳細資料' : '展開預約詳細資料');
    }
  }

  function syncBookingAccordionState(bookingList) {
    if (!bookingList) return;
    let expandedFound = false;
    const cards = bookingList.querySelectorAll('.booking-item[data-booking-id]');
    cards.forEach((card) => {
      const expanded = Boolean(expandedBookingId) && bookingCardId(card) === expandedBookingId;
      if (expanded) expandedFound = true;
      applyBookingCardAccordionState(card, expanded);
    });
    if (expandedBookingId && !expandedFound) expandedBookingId = '';
  }

  function toggleBookingCard(card) {
    if (!card) return;
    const bookingList = card.closest('#bookingList');
    if (!bookingList) return;
    const id = bookingCardId(card);
    const shouldExpand = !card.classList.contains('is-expanded');
    expandedBookingId = shouldExpand ? id : '';
    bookingList.querySelectorAll('.booking-item[data-booking-id]').forEach((item) => {
      applyBookingCardAccordionState(item, shouldExpand && item === card);
    });
  }

  function handleBookingHistoryClick(event) {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('button, a, input, select, textarea, label')) return;
    const summarySurface = event.target.closest('.booking-item-top, .member-booking-format-totals');
    if (!summarySurface) return;
    const card = summarySurface.closest('.booking-item[data-booking-id]');
    if (!card) return;
    toggleBookingCard(card);
  }

  function handleBookingHistoryKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!(event.target instanceof Element) || !event.target.matches('.booking-item-top[role="button"]')) return;
    const card = event.target.closest('.booking-item[data-booking-id]');
    if (!card) return;
    event.preventDefault();
    toggleBookingCard(card);
  }

  function organizeBookingHistory() {
    const bookingList = document.getElementById('bookingList');
    if (!bookingList) return;
    normalizeBookingUi(bookingList);

    const directItems = [...bookingList.children].filter((node) => node.classList?.contains('booking-item'));
    // Repeated calls must not replace already grouped cards with empty tab panels.
    if (!directItems.length && [...bookingList.children].some((node) => node.classList?.contains('booking-history-tabs'))) {
      syncBookingAccordionState(bookingList);
      return;
    }
    const grouped = new Map(BOOKING_GROUPS.map((group) => [group.key, []]));
    directItems.forEach((item) => grouped.get(bookingGroupKey(item)).push(item));

    // A booking-specific deep link opens its matching tab on initial load.
    if (!bookingGroupManuallySelected) {
      const target = directItems.find((item) => item.classList.contains('booking-detail-target'));
      if (target) activeBookingGroup = bookingGroupKey(target);
    }

    bookingList.replaceChildren(
      createBookingTabs(grouped),
      ...BOOKING_GROUPS.map((group) => createBookingGroup(group, grouped.get(group.key))),
    );
    document.getElementById('bookingEmpty')?.classList.add('hidden');
    activateBookingGroup(bookingList, activeBookingGroup);
    normalizeBookingUi(bookingList);
    syncBookingAccordionState(bookingList);
  }

  function installBookingHistoryInteractions() {
    const bookingList = document.getElementById('bookingList');
    if (!bookingList) return;
    bookingList.addEventListener('click', handleBookingTabClick);
    bookingList.addEventListener('keydown', handleBookingTabKeydown);
    bookingList.addEventListener('click', handleBookingHistoryClick);
    bookingList.addEventListener('keydown', handleBookingHistoryKeydown);
  }

  window.BookingMemberUI = Object.freeze({
    organizeBookingHistory,
  });

  window.confirm = (message) => {
    const text = String(message ?? '');
    if (text.startsWith('確定取消 ') && text.endsWith(' 的預約嗎？')) {
      return originalConfirm(`${text}\n\n確定取消後會送出申請，需由管理端確認；確認前原預約時段仍會保留。`);
    }
    return originalConfirm(message);
  };

  window.BookingSystem.memberProfile = async (...args) => {
    const profile = await originalMemberProfile(...args);
    lastProfile = profile && typeof profile === 'object' ? profile : {};
    if (lastProfile.membershipRequired === true) {
      showMembershipRequiredView();
      throw membershipRequiredError();
    }
    renderMembershipProgress();
    return profile;
  };

  window.BookingSystem.request = async (...args) => {
    const [config, clientType, idToken, action, payload] = args;
    try {
      if (clientType === 'member' && action === 'user.booking.bootstrap') {
        const bookingData = await originalRequest(...args);
        return await enrichBootstrapWithCancellationState(config, idToken, bookingData);
      }
      if (clientType === 'member' && action === 'user.booking.cancel') {
        const cancellation = await cancellationRequest(config, idToken, 'member.request', { bookingId: payload?.bookingId });
        const fresh = await originalRequest(config, clientType, idToken, 'user.booking.bootstrap');
        const booking = (fresh?.bookings || []).find((item) => item.bookingId === payload?.bookingId);
        if (!booking) throw clientError('BOOKING_NOT_FOUND', '取消申請已送出，但目前無法重新載入這筆預約。');
        return {
          booking: {
            ...booking,
            baseStatus: booking.status,
            status: 'cancel_requested',
            cancellationRequestedAt: cancellation?.request?.cancellationRequestedAt || null,
          },
        };
      }
      return await originalRequest(...args);
    } catch (error) {
      if (error && error.code === 'MEMBERSHIP_REQUIRED') showMembershipRequiredView();
      throw error;
    }
  };

  window.addEventListener('DOMContentLoaded', installBookingHistoryInteractions);
  window.addEventListener('beforeunload', () => {
    window.confirm = originalConfirm;
    const bookingList = document.getElementById('bookingList');
    if (bookingList) {
      bookingList.removeEventListener('click', handleBookingTabClick);
      bookingList.removeEventListener('keydown', handleBookingTabKeydown);
      bookingList.removeEventListener('click', handleBookingHistoryClick);
      bookingList.removeEventListener('keydown', handleBookingHistoryKeydown);
    }
  });
})();
