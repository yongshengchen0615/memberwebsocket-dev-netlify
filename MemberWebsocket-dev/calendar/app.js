(() => {
  'use strict';

  const initialMonth = firstOfMonth(taipeiToday());
  const state = { config: null, idToken: '', profile: null, items: [], ongoingTickets: [], initialMonth: initialMonth, visibleMonth: initialMonth, detailTrigger: null, touchStart: null, suppressCalendarDayClickUntil: 0 };
  const els = {};
  const LOGIN_PROGRESS_TICK_MS = 650;
  let loginProgressTimer = null;
  let loginProgressValue = 8;

  window.addEventListener('DOMContentLoaded', () => {
    window.MemberSystem.bindDialogKeyboard();
    ['app', 'loadingView', 'loadingProgress', 'loadingProgressBar', 'loadingProgressText', 'loadingStatus', 'errorView', 'errorTitle', 'errorMessage', 'joinMemberButton', 'retryButton', 'calendarView', 'displayName', 'membershipProgress', 'previousMonthButton', 'nextMonthButton', 'todayButton', 'monthTitle', 'calendarSummary', 'calendarRangeNotice', 'calendarGrid', 'calendarOngoingTickets', 'calendarOngoingTicketList', 'emptyView', 'calendarDetailModal', 'closeCalendarDetailButton', 'calendarDetailTitle', 'calendarDetailDate', 'calendarDetailItems'].forEach((id) => { els[id] = document.getElementById(id); });
    els.retryButton.addEventListener('click', () => window.location.reload());
    els.joinMemberButton.addEventListener('click', () => window.MemberSystem.openMemberJoin(state.config));
    els.previousMonthButton.addEventListener('click', () => changeMonth(-1));
    els.nextMonthButton.addEventListener('click', () => changeMonth(1));
    els.todayButton.addEventListener('click', showInitialMonth);
    els.calendarGrid.addEventListener('click', handleCalendarDayClick);
    els.calendarGrid.addEventListener('touchstart', handleCalendarTouchStart, { passive: true });
    els.calendarGrid.addEventListener('touchend', handleCalendarTouchEnd, { passive: true });
    els.closeCalendarDetailButton.addEventListener('click', closeCalendarItemDetail);
    els.calendarDetailModal.addEventListener('click', (event) => { if (event.target === els.calendarDetailModal) closeCalendarItemDetail(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeCalendarItemDetail(); });
    boot();
  });

  async function boot() {
    setView('loading');
    try {
      startLoginProgress('正在取得開啟設定…', 18);
      state.config = await window.MemberSystem.loadConfig();
      startLoginProgress('正在驗證 LINE 身分…', 48);
      state.idToken = await window.MemberSystem.signIn(state.config, 'calendar');
      startLoginProgress('正在同步月曆資料…', 92);
      await loadCalendar();
      await completeLoginProgress('月曆資料已準備完成');
      setView('calendar');
      window.dispatchEvent(new CustomEvent('user-tour:ready', { detail: { surface: 'calendar', profile: state.profile } }));
      window.MemberSystem.subscribeRealtime(state.config, 'calendar', loadCalendar);
    } catch (error) {
      stopLoginProgress();
      showError(error);
    } finally {
      stopLoginProgress();
      els.app.setAttribute('aria-busy', 'false');
    }
  }

  function changeMonth(offset) {
    const nextMonth = addMonths(state.visibleMonth, offset);
    closeCalendarItemDetail(false);
    state.visibleMonth = nextMonth;
    renderCalendar();
  }

  function showInitialMonth() {
    closeCalendarItemDetail(false);
    state.visibleMonth = state.initialMonth;
    renderCalendar();
  }

  async function loadCalendar() {
    const result = await window.MemberSystem.request(state.config, 'calendar', state.idToken, 'user.calendar.bootstrap', { includeAll: true, compact: false });
    applyCalendarSnapshot(result);
    renderCalendar();
  }

  function applyCalendarSnapshot(payload) {
    state.profile = payload && payload.profile && typeof payload.profile === 'object' ? payload.profile : {};
    state.items = Array.isArray(payload && payload.items) ? payload.items : [];
    state.ongoingTickets = Array.isArray(payload && payload.ongoingTickets) ? payload.ongoingTickets : [];
    els.displayName.textContent = String(state.profile.displayName || 'LINE 使用者');
    window.MembershipProgress.render(els.membershipProgress, state.profile);
    window.MemberMonthlyTierBenefits?.bind(document.querySelector('[data-member-monthly-tier-widget]'), state.config, state.idToken, state.profile, 'calendar');
  }

  function renderCalendar() {
    const visibleRange = visibleRangeForMonth(state.visibleMonth);
    const monthRange = calendarMonthRange(state.visibleMonth);
    const displayedDates = [];
    let day = parseIsoDate(monthRange.start);
    const lastDay = parseIsoDate(monthRange.end);
    while (day && lastDay && day <= lastDay) {
      const entries = visibleCalendarItemsOnDate(state.items, toIsoDate(day));
      if (entries.length) displayedDates.push(entries);
      day.setUTCDate(day.getUTCDate() + 1);
    }
    const holidayCount = displayedDates.filter((entries) => entries.some((item) => item.itemType === 'holiday')).length;
    const eventCount = new Set(displayedDates.flat().filter((item) => item.itemType === 'event')
      .map((item) => item.calendarDisplaySourceId || item.calendarItemId || item)).size;
    els.monthTitle.textContent = calendarMonthLabel(state.visibleMonth);
    els.calendarGrid.replaceChildren(...weekdayHeaders(), ...calendarDays(visibleRange));
    els.calendarSummary.textContent = displayedDates.length
      ? String(displayedDates.length) + ' 個日期 · ' + String(holidayCount) + ' 個休假日 · ' + String(eventCount) + ' 個活動'
      : '這個月尚未設定日期';
    els.calendarOngoingTickets.classList.toggle('hidden', state.ongoingTickets.length === 0);
    els.calendarOngoingTicketList.replaceChildren(...state.ongoingTickets.map(createCalendarDetailItem));
    els.emptyView.classList.toggle('hidden', displayedDates.length !== 0 || state.ongoingTickets.length !== 0);
  }

  function weekdayHeaders() {
    return ['日', '一', '二', '三', '四', '五', '六'].map((label) => {
      const heading = document.createElement('div');
      heading.className = 'weekday';
      heading.textContent = label;
      return heading;
    });
  }

  // A holiday owns its date in both the grid and the details modal.
  // Keep the original events in the snapshot so removing the holiday restores them.
  function visibleCalendarItemsOnDate(items, isoDate) {
    const entries = items.filter((item) => itemOnDate(item, isoDate));
    const holidays = entries.filter((item) => item.itemType === 'holiday' && (!item.status || item.status === 'active'));
    return holidays.length ? holidays : entries;
  }

  // Only classify entries returned by the member-scoped calendar API. Never
  // synthesize hidden offers from ticket catalogs or client tier preferences.
  function splitCalendarDateItems(items) {
    const groups = { available: [], locked: [], notices: [] };
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (item.itemType === 'holiday') groups.notices.push(item);
      else if (item.itemType === 'event' && (item.locked === true || item.tierEligible === false)) groups.locked.push(item);
      else if (item.itemType === 'event') groups.available.push(item);
      else groups.notices.push(item);
    });
    return groups;
  }

  function calendarDays(range) {
    const result = [];
    let current = parseIsoDate(range.start);
    const end = parseIsoDate(range.end);
    const today = taipeiToday();
    while (current && end && current <= end) {
      const isoDate = toIsoDate(current);
      const entries = visibleCalendarItemsOnDate(state.items, isoDate);
      const cell = document.createElement(entries.length ? 'button' : 'article');
      cell.className = 'calendar-day' + (current.getUTCMonth() !== state.visibleMonth.getUTCMonth() ? ' outside' : '') + (isoDate === today ? ' today' : '');
      if (entries.length) {
        cell.type = 'button';
        cell.classList.add('has-entries');
        cell.dataset.calendarDate = isoDate;
        cell.setAttribute('aria-haspopup', 'dialog');
        cell.setAttribute('aria-label', `查看${calendarDateLabel(isoDate)}的 ${entries.length} 項日期說明`);
      }
      const number = document.createElement('span');
      number.className = 'day-number';
      number.textContent = String(current.getUTCDate());
      cell.append(number);
      entries.forEach((item) => cell.append(createCalendarItem(item)));
      result.push(cell);
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return result;
  }

  function createCalendarItem(item) {
    const entry = document.createElement('span');
    entry.className = 'calendar-item ' + (item.itemType === 'holiday' ? 'holiday' : 'event');
    if (item.itemType === 'event' && item.tierEligible === false) entry.classList.add('tier-ineligible');
    applyCalendarItemAccent(entry, item.accent);
    const marker = document.createElement('i');
    marker.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.textContent = (item.locked?'🔒 需升級 · ':'') + String(item.title || (item.itemType === 'holiday' ? '休假日' : '活動'));
    entry.append(marker, title);
    return entry;
  }

  function handleCalendarDayClick(event) {
    if (Date.now() < state.suppressCalendarDayClickUntil) return;
    const trigger = event.target instanceof Element ? event.target.closest('[data-calendar-date]') : null;
    if (!trigger) return;
    const isoDate = String(trigger.dataset.calendarDate || '');
    if (parseIsoDate(isoDate)) openCalendarDateDetails(isoDate, trigger);
  }

  function handleCalendarTouchStart(event) {
    const touch = event.touches && event.touches.length === 1 ? event.touches[0] : null;
    state.touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  function handleCalendarTouchEnd(event) {
    const start = state.touchStart;
    const touch = event.changedTouches && event.changedTouches.length === 1 ? event.changedTouches[0] : null;
    state.touchStart = null;
    if (!start || !touch) return;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) < 48 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
    state.suppressCalendarDayClickUntil = Date.now() + 500;
    changeMonth(deltaX < 0 ? 1 : -1);
  }

  async function openCalendarDateDetails(isoDate, trigger) {
    const items = visibleCalendarItemsOnDate(state.items, isoDate);
    if (!items.length) return;
    const groups = splitCalendarDateItems(items);
    const sections = [];
    if (groups.notices.length) sections.push(createCalendarDetailGroup('休假提醒', groups.notices, 'notice'));
    if (groups.available.length) sections.push(createCalendarDetailGroup('當日可用的活動與票券', groups.available, 'available'));
    if (groups.locked.length) sections.push(createCalendarDetailGroup('未解鎖的活動與票券', groups.locked, 'locked'));
    state.detailTrigger = trigger instanceof HTMLElement ? trigger : null;
    els.calendarDetailTitle.textContent = calendarDateLabel(isoDate);
    els.calendarDetailDate.textContent = groups.notices.length
      ? `${items.length} 項相關日期說明`
      : `${groups.available.length} 項可用 · ${groups.locked.length} 項未解鎖`;
    els.calendarDetailItems.replaceChildren(...sections);
    els.calendarDetailModal.classList.remove('hidden');
    els.closeCalendarDetailButton.focus();
  }

  function createCalendarDetailGroup(label, items, category) {
    const group = document.createElement('section');
    group.className = 'calendar-detail-group ' + category;
    const heading = document.createElement('div');
    heading.className = 'calendar-detail-group-header';
    const title = document.createElement('h3');
    title.textContent = label;
    const count = document.createElement('span');
    count.className = 'calendar-detail-group-count';
    count.textContent = `${items.length} 項`;
    heading.append(title, count);
    const list = document.createElement('div');
    list.className = 'calendar-detail-group-list';
    list.append(...items.map(createCalendarDetailItem));
    group.append(heading, list);
    return group;
  }

  function isManagedCalendarTicket(item) {
    if (item.eventTicketId || item.calendarDisplaySourceId) return true;
    try {
      return new URL(String(item.linkUrl || ''), window.location.href).searchParams.get('source') === 'event-ticket-calendar';
    } catch (_) { return false; }
  }

  function createCalendarDetailItem(item) {
    const detail = document.createElement('section');
    detail.className = 'calendar-detail-item';
    detail.style.setProperty('--item-accent', safeAccent(item.accent));
    const isLocked = item.itemType === 'event' && (item.locked === true || item.tierEligible === false);
    if (isLocked) detail.classList.add('is-locked');
    const heading = document.createElement('div');
    heading.className = 'calendar-detail-item-heading';
    const type = document.createElement('span');
    type.className = 'calendar-detail-type';
    type.textContent = item.itemType === 'holiday' ? '休假提醒' : isManagedCalendarTicket(item) ? '活動票券' : '會員活動';
    const title = document.createElement('h4');
    title.textContent = (isLocked ? '🔒 ' : '') + String(item.title || (item.itemType === 'holiday' ? '休假日' : '活動'));
    heading.append(type, title);
    const description = document.createElement('p');
    description.textContent = String(item.description || '尚未提供其他說明。');
    detail.append(heading, description);
    if (item.itemType === 'event') {
      const tierAccess = document.createElement('p');
      tierAccess.className = 'calendar-detail-tier-access' + (isLocked ? ' ineligible' : '');
      const labels = Array.isArray(item.allowedTierLabels) && item.allowedTierLabels.length ? item.allowedTierLabels.join('、') : '未設定';
      tierAccess.textContent = isLocked
        ? String(item.lockReason || `可參加階級：${labels}。目前會員階級尚未解鎖。`)
        : `可參加階級：${labels}。`;
      detail.append(tierAccess);
      const rules = Array.isArray(item.usageConditionLabels) ? item.usageConditionLabels.filter(Boolean) : [];
      if (rules.length) {
        const requirements = document.createElement('div'); requirements.className = 'calendar-detail-usage-conditions';
        const heading = document.createElement('strong'); heading.textContent = '活動使用條件';
        const list = document.createElement('ul');
        rules.forEach(rule => { const row = document.createElement('li'); row.textContent = String(rule); list.append(row); });
        const hint = document.createElement('p'); hint.textContent = '須符合上述預約條件才能使用；是否可用以實際預約資料為準。';
        requirements.append(heading,list,hint); detail.append(requirements);
      }
      const linkUrl = resolveCalendarLink(item.linkUrl) || resolveCalendarLinkForItem(item);
      const linkLabel = String(item.linkLabel || '').trim();
      if (item.tierEligible !== false && linkLabel && isSafeCalendarLink(linkUrl) && !isLocked) {
        const link = document.createElement('a');
        link.className = 'calendar-detail-link';
        link.href = linkUrl;
        link.textContent = linkLabel;
        link.addEventListener('click', (event) => {
          event.preventDefault();
          openCalendarLinkInLine(link.href);
        });
        detail.append(link);
      }
    }
    return detail;
  }

  function resolveCalendarLinkForItem(item) {
    const ticketId = String(item && item.eventTicketId || '').trim();
    if (/^[A-Za-z0-9_-]{1,128}$/.test(ticketId)) {
      const url = new URL('../event/', window.location.href);
      url.searchParams.set('source', 'event-ticket-calendar');
      url.searchParams.set('eventTicketId', ticketId);
      const business = window.BusinessContext?.slug || new URL(window.location.href).searchParams.get('business') || '';
      if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(business)) url.searchParams.set('business', business);
      return url.href;
    }
    return resolveCalendarLink(item && item.linkUrl);
  }

  function resolveCalendarLink(value) {
    const storedUrl = String(value || '').trim();
    if (!isSafeCalendarLink(storedUrl)) return '';
    let parsed;
    try { parsed = new URL(storedUrl); } catch (_) { return ''; }
    if (parsed.searchParams.get('source') !== 'event-ticket-calendar') return storedUrl;
    const eventTicketId = String(parsed.searchParams.get('eventTicketId') || '').trim();
    if (!eventTicketId) return '';
    // Database links may refer to an older deployment. Navigate to the current
    // website's event page, preserving the ticket ID and deployment path.
    const localEventUrl = new URL('../event/', window.location.href);
    localEventUrl.searchParams.set('source', 'event-ticket-calendar');
    localEventUrl.searchParams.set('eventTicketId', eventTicketId);
    // A calendar ticket link belongs to the current merchant, never to a
    // possibly stale business saved in the original calendar record.
    // Include it before opening: LINE's click handler uses this URL directly.
    const activeBusiness = window.BusinessContext?.slug || new URL(window.location.href).searchParams.get('business') || '';
    if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(activeBusiness)) localEventUrl.searchParams.set('business', activeBusiness);
    return localEventUrl.toString();
  }

  function openCalendarLinkInLine(url) {
    if (!isSafeCalendarLink(url)) return;
    if (window.liff && typeof window.liff.openWindow === 'function') {
      window.liff.openWindow({ url, external: false });
      return;
    }
    window.location.assign(url);
  }

  function closeCalendarItemDetail(restoreFocus = true) {
    if (!els.calendarDetailModal || els.calendarDetailModal.classList.contains('hidden')) return;
    els.calendarDetailModal.classList.add('hidden');
    const trigger = state.detailTrigger;
    state.detailTrigger = null;
    if (restoreFocus && trigger && document.contains(trigger)) trigger.focus();
  }

  function calendarDateLabel(isoDate) {
    const date = parseIsoDate(isoDate);
    return date ? new Intl.DateTimeFormat('zh-Hant-TW', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(date) : '日期說明';
  }

  function itemOnDate(item, date) {
    const startsOn = String(item && item.startsOn || '');
    const endsOn = String(item && item.endsOn || startsOn);
    return Boolean(startsOn && endsOn && startsOn <= date && endsOn >= date);
  }

  function isSafeCalendarLink(value) {
    const url = String(value || '').trim();
    return /^https:\/\/[^\s<>"']+$/i.test(url) && /^https:\/\/[^\/?#@]+(?:[\/?#]|$)/i.test(url);
  }

  function calendarItemOverlapsRange(item, start, end) {
    const startsOn = String(item && item.startsOn || '');
    const endsOn = String(item && item.endsOn || startsOn);
    return Boolean(startsOn && endsOn && startsOn <= end && endsOn >= start);
  }

  function visibleRangeForMonth(month) {
    const first = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
    const start = new Date(first);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 41);
    return { start: toIsoDate(start), end: toIsoDate(end) };
  }

  function calendarMonthRange(month) {
    const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
    const end = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
    return { start: toIsoDate(start), end: toIsoDate(end) };
  }

  function calendarMonthLabel(month) {
    return new Intl.DateTimeFormat('zh-Hant-TW', { timeZone: 'UTC', year: 'numeric', month: 'long' }).format(month);
  }

  function taipeiToday() {
    const values = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).forEach((part) => { if (part.type !== 'literal') values[part.type] = part.value; });
    return values.year + '-' + values.month + '-' + values.day;
  }

  function firstOfMonth(value) {
    const date = parseIsoDate(value);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }

  function addMonths(date, amount) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + Number(amount || 0), 1));
  }

  function parseIsoDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]) ? date : null;
  }

  function toIsoDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function safeAccent(value) {
    return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : '#df6b4d';
  }

  function applyCalendarItemAccent(element, value) {
    const accent = safeAccent(value);
    element.style.setProperty('--item-accent', accent);
    element.style.setProperty('--item-foreground', accentForeground(accent));
  }

  function accentForeground(value) {
    const hex = safeAccent(value).slice(1);
    const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const luminance = channels.reduce((sum, channel, index) => sum + (channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)) * [0.2126, 0.7152, 0.0722][index], 0);
    return luminance > 0.179 ? '#000000' : '#ffffff';
  }

  function setView(view) {
    els.loadingView.classList.toggle('hidden', view !== 'loading');
    els.errorView.classList.toggle('hidden', view !== 'error');
    els.calendarView.classList.toggle('hidden', view !== 'calendar');
  }

  function startLoginProgress(status, ceiling) {
    stopLoginProgress();
    const maximum = Math.max(loginProgressValue, Math.min(98, Number(ceiling) || loginProgressValue));
    setLoginProgress(loginProgressValue, status);
    loginProgressTimer = window.setInterval(() => {
      const remaining = maximum - loginProgressValue;
      if (remaining <= 0) return stopLoginProgress();
      setLoginProgress(Math.min(maximum, loginProgressValue + Math.max(1, Math.ceil(remaining * .12))), status);
    }, LOGIN_PROGRESS_TICK_MS);
  }

  function stopLoginProgress() {
    if (loginProgressTimer !== null) window.clearInterval(loginProgressTimer);
    loginProgressTimer = null;
  }

  function completeLoginProgress(status) {
    stopLoginProgress();
    // 資料就緒便交還操作，不讓裝飾性動畫阻塞主要畫面。
    setLoginProgress(100, status);
    return Promise.resolve();
  }

  function setLoginProgress(value, status) {
    const progress = Math.max(loginProgressValue, Math.max(0, Math.min(100, Math.round(Number(value) || 0))));
    loginProgressValue = progress;
    els.loadingProgress.setAttribute('aria-valuenow', String(progress));
    els.loadingProgress.setAttribute('aria-valuetext', `${progress}%`);
    els.loadingProgressBar.style.width = `${progress}%`;
    els.loadingProgressText.textContent = `${progress}%`;
    if (status) els.loadingStatus.textContent = status;
  }

  function showError(error) {
    const membershipRequired = error && error.code === 'MEMBERSHIP_REQUIRED';
    const maintenance = error && error.code === 'SYSTEM_MAINTENANCE';
    els.errorTitle.textContent = maintenance ? '系統維護中' : error && error.code === 'CONFIG_ERROR' ? '系統尚未完成設定' : membershipRequired ? '請先加入會員' : '活動日曆暫時無法載入';
    els.errorMessage.textContent = membershipRequired ? '加入會員並完成會員資料後，才能使用活動日曆功能。' : error && error.message ? error.message : '請稍後重新整理再試。';
    els.joinMemberButton.classList.toggle('hidden', !membershipRequired);
    els.retryButton.classList.toggle('hidden', membershipRequired);
    setView('error');
  }
  window.MemberClientQaHooks = Object.freeze({ surface: 'calendar', refresh: () => loadCalendar() });
})();
