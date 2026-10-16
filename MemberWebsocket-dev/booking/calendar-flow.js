(() => {
  'use strict';

  const state = {
    month: '',
    selectedDate: '',
    today: '',
    minAdvanceDays: 0,
    maxAdvanceDays: 0,
    minimumDate: '',
    maximumDate: '',
    config: null,
    occupancyRequestSeq: 0,
    reloadTimer: 0,
    occupiedByDate: new Map(),
    holidaysByDate: new Map(),
    lastDateTrigger: null,
    holidayTrigger: null,
  };

  const els = {};

  window.addEventListener('DOMContentLoaded', () => {
    [
      'bookingView', 'calendarMonthLabel', 'calendarGrid', 'previousMonthButton', 'nextMonthButton',
      'appointmentPanel', 'appointmentModalTitle', 'selectedDateSummary', 'closeAppointmentButton',
      'bookingDate', 'servicePicker', 'selectedServiceList', 'bookingList', 'bookingConfirmModal'
    ].forEach((id) => { els[id] = document.getElementById(id); });

    if (!els.calendarGrid || !els.bookingDate || !els.servicePicker || !els.appointmentPanel) return;

    ensureHolidayUi();
    state.today = taipeiDate();
    state.minimumDate = state.today;
    state.month = state.today.slice(0, 7);
    renderCalendar();

    els.previousMonthButton?.addEventListener('click', () => changeMonth(-1));
    els.nextMonthButton?.addEventListener('click', () => changeMonth(1));
    els.closeAppointmentButton?.addEventListener('click', () => closeAppointmentModal(true));
    els.appointmentPanel.addEventListener('click', (event) => {
      if (event.target === els.appointmentPanel && window.matchMedia('(max-width: 768px)').matches) {
        closeAppointmentModal(true);
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (els.bookingConfirmModal && !els.bookingConfirmModal.classList.contains('hidden')) return;
      if (els.holidayModal && !els.holidayModal.classList.contains('hidden')) {
        closeHolidayNotice(true);
        return;
      }
      closeAppointmentModal(true);
    });

    window.addEventListener('booking:settings-updated', (event) => {
      applyGlobalSettings(event.detail || {});
      scheduleMonthOccupancyReload();
    });
    window.addEventListener('booking:edit', (event) => {
      state.selectedDate = event.detail.date;
      state.month = state.selectedDate.slice(0, 7);
      renderCalendar();
      openAppointmentModal(state.selectedDate);
      scheduleMonthOccupancyReload();
    });
    window.addEventListener('booking:created', () => {
      closeAppointmentModal(false);
      scheduleMonthOccupancyReload();
    });

    window.addEventListener('booking:selection-changed', syncAfterSelectionMutation);
    window.addEventListener('booking:bookings-rendered', scheduleMonthOccupancyReload);
    window.addEventListener('booking:view-shown', loadMonthOccupancy);
    if (els.bookingView && !els.bookingView.classList.contains('hidden')) loadMonthOccupancy();
  });

  function ensureHolidayUi() {
    const legend = els.calendarGrid.parentElement?.querySelector('.calendar-legend');
    if (legend && !legend.querySelector('[data-holiday-legend]')) {
      const item = document.createElement('span');
      item.dataset.holidayLegend = '1';
      const dot = document.createElement('i');
      dot.className = 'legend-dot holiday-dot';
      dot.setAttribute('aria-hidden', 'true');
      item.append(dot, document.createTextNode('休假日（點選查看）'));
      legend.appendChild(item);
    }

    if (!document.getElementById('bookingHolidayModal')) {
      const modal = document.createElement('div');
      modal.id = 'bookingHolidayModal';
      modal.className = 'booking-modal hidden';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'bookingHolidayTitle');
      modal.innerHTML = `
        <div class="booking-modal-card booking-holiday-modal-card">
          <div class="booking-modal-heading">
            <div><p class="kicker">Holiday</p><h2 id="bookingHolidayTitle">休假日，無法預約</h2></div>
            <button id="closeBookingHolidayButton" class="booking-modal-close" type="button" aria-label="關閉休假提示">×</button>
          </div>
          <p id="bookingHolidayDate" class="booking-holiday-date"></p>
          <div id="bookingHolidayDetails" class="booking-holiday-details"></div>
        </div>`;
      document.body.appendChild(modal);
      els.holidayModal = modal;
      els.holidayDate = modal.querySelector('#bookingHolidayDate');
      els.holidayDetails = modal.querySelector('#bookingHolidayDetails');
      els.closeHolidayButton = modal.querySelector('#closeBookingHolidayButton');
      els.closeHolidayButton.addEventListener('click', () => closeHolidayNotice(true));
      modal.addEventListener('click', (event) => {
        if (event.target === modal && window.matchMedia('(max-width: 768px)').matches) closeHolidayNotice(true);
      });
    } else {
      els.holidayModal = document.getElementById('bookingHolidayModal');
      els.holidayDate = document.getElementById('bookingHolidayDate');
      els.holidayDetails = document.getElementById('bookingHolidayDetails');
      els.closeHolidayButton = document.getElementById('closeBookingHolidayButton');
    }

  }

  function taipeiDate() {
    const parts = {};
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date()).forEach((part) => {
      if (part.type !== 'literal') parts[part.type] = part.value;
    });
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function addDays(date, days) {
    const parsed = new Date(`${date}T00:00:00Z`);
    parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));
    return parsed.toISOString().slice(0, 10);
  }

  function shiftMonth(key, delta) {
    const [year, month] = String(key).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1 + delta, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  function safeHolidayAccent(value) {
    const accent = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(accent) ? accent.toLowerCase() : '#df6b4d';
  }

  function holidayAccentForeground(value) {
    const hex = safeHolidayAccent(value).slice(1);
    const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const luminance = channels.reduce((sum, channel, index) => sum + (channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)) * [0.2126, 0.7152, 0.0722][index], 0);
    return luminance > 0.179 ? '#000000' : '#ffffff';
  }

  function applyHolidayAccent(element, value) {
    if (!(element instanceof HTMLElement)) return;
    const accent = safeHolidayAccent(value);
    element.style.setProperty('--holiday-accent', accent);
    element.style.setProperty('--holiday-foreground', holidayAccentForeground(accent));
  }

  function changeMonth(delta) {
    const minimumMonth = state.today.slice(0, 7);
    const maximumMonth = state.maximumDate ? state.maximumDate.slice(0, 7) : '';
    const next = shiftMonth(state.month, delta);
    if (next < minimumMonth || (maximumMonth && next > maximumMonth)) return;
    closeHolidayNotice(false);
    state.month = next;
    renderCalendar();
    loadMonthOccupancy();
  }

  function applyGlobalSettings(detail) {
    const today = String(detail.today || state.today || taipeiDate()).slice(0, 10);
    const rawDays = Number(detail.settings?.minAdvanceDays ?? state.minAdvanceDays ?? 0);
    const rawMaxDays = Number(detail.settings?.maxAdvanceDays ?? state.maxAdvanceDays ?? 0);
    const minAdvanceDays = Number.isInteger(rawDays) && rawDays >= 0 && rawDays <= 365 ? rawDays : 0;
    const maxAdvanceDays = Number.isInteger(rawMaxDays) && rawMaxDays >= 0 && rawMaxDays <= 365 ? rawMaxDays : 0;
    state.today = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : taipeiDate();
    state.minAdvanceDays = minAdvanceDays;
    state.maxAdvanceDays = maxAdvanceDays > 0 && maxAdvanceDays < minAdvanceDays ? 0 : maxAdvanceDays;
    state.minimumDate = addDays(state.today, minAdvanceDays);
    state.maximumDate = state.maxAdvanceDays > 0 ? addDays(state.today, state.maxAdvanceDays) : '';
    const actualDate = String(els.bookingDate?.value || '');
    if (actualDate && actualDate >= state.minimumDate && (!state.maximumDate || actualDate <= state.maximumDate) && actualDate !== state.selectedDate && !state.holidaysByDate.has(actualDate)) {
      state.selectedDate = actualDate;
      state.month = actualDate.slice(0, 7);
    } else if (state.selectedDate && (state.selectedDate < state.minimumDate || (state.maximumDate && state.selectedDate > state.maximumDate) || state.holidaysByDate.has(state.selectedDate))) {
      clearSelectedDate();
      closeAppointmentModal(false);
    }
    renderCalendar();
  }

  function clearSelectedDate() {
    state.selectedDate = '';
    if (els.bookingDate) {
      els.bookingDate.value = '';
      els.bookingDate.disabled = true;
      els.bookingDate.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function renderCalendar() {
    const today = state.today || taipeiDate();
    const minimumDate = state.minimumDate || today;
    const maximumDate = state.maximumDate || '';
    const [year, month] = state.month.split('-').map(Number);
    const firstDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();

    els.calendarMonthLabel.textContent = `${year} 年 ${month} 月`;
    if (els.previousMonthButton) els.previousMonthButton.disabled = state.month <= today.slice(0, 7);
    if (els.nextMonthButton) els.nextMonthButton.disabled = Boolean(maximumDate && state.month >= maximumDate.slice(0, 7));
    els.calendarGrid.replaceChildren();

    for (let index = 0; index < 42; index += 1) {
      const day = index - firstDay + 1;
      if (day < 1 || day > dayCount) {
        const blank = document.createElement('span');
        blank.className = 'calendar-day-placeholder';
        blank.setAttribute('aria-hidden', 'true');
        els.calendarGrid.appendChild(blank);
        continue;
      }

      const date = `${state.month}-${String(day).padStart(2, '0')}`;
      const isPast = date < today;
      const isAdvanceBlocked = !isPast && date < minimumDate;
      const isRangeBlocked = Boolean(maximumDate && date > maximumDate);
      const holidays = state.holidaysByDate.get(date) || [];
      const isHoliday = holidays.length > 0;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'calendar-day';
      button.dataset.date = date;
      button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-selected', state.selectedDate === date ? 'true' : 'false');
      button.disabled = isPast || ((isAdvanceBlocked || isRangeBlocked) && !isHoliday);
      if (isPast) button.classList.add('past-disabled');
      if ((isAdvanceBlocked || isRangeBlocked) && !isHoliday) button.classList.add('advance-disabled');
      if (isHoliday) {
        button.classList.add('holiday-disabled');
        applyHolidayAccent(button, holidays[0]?.accent);
      }
      if (date === today) button.classList.add('today');
      if (date === state.selectedDate) button.classList.add('selected');

      const number = document.createElement('strong');
      number.className = 'calendar-day-number';
      number.textContent = String(day);
      button.appendChild(number);

      if (isHoliday) {
        const label = document.createElement('span');
        label.className = 'calendar-holiday-label';
        label.textContent = holidays.length === 1 ? (holidays[0].title || '休假日') : `休假日 · ${holidays.length} 項`;
        button.appendChild(label);
      }

      const intervals = state.occupiedByDate.get(date) || [];
      if (intervals.length && !isHoliday) {
        button.classList.add('has-booking');
        const list = document.createElement('span');
        list.className = 'calendar-booking-times';
        intervals.slice(0, 2).forEach((interval) => {
          const label = document.createElement('small');
          label.textContent = `${interval.startAt && interval.startAt !== date ? '隔日 ' : ''}${interval.startTime}–${interval.endTime}${interval.endAt && interval.endAt !== date ? '（隔日結束）' : ''}`;
          list.appendChild(label);
        });
        if (intervals.length > 2) {
          const more = document.createElement('small');
          more.textContent = `+${intervals.length - 2} 個時段`;
          list.appendChild(more);
        }
        button.appendChild(list);
      }

      if (isPast) {
        button.title = isHoliday ? '休假日；日期已過，無法預約' : '日期已過，無法預約';
        button.setAttribute('aria-label', `${formatDate(date)}，${button.title}`);
      } else if (isHoliday) {
        button.title = '休假日，無法預約；點選查看說明';
        button.setAttribute('aria-label', `${formatDate(date)}，休假日，無法預約，點選查看休假說明`);
        button.addEventListener('click', () => showHolidayNotice(date, holidays, button));
      } else if (isAdvanceBlocked) {
        const reason = `需提前 ${state.minAdvanceDays} 天，最早可預約 ${formatDate(minimumDate)}`;
        button.title = reason;
        button.setAttribute('aria-label', `${formatDate(date)}，${reason}`);
      } else if (isRangeBlocked) {
        const reason = `超過可預約範圍，最遠可預約 ${formatDate(maximumDate)}`;
        button.title = reason;
        button.setAttribute('aria-label', `${formatDate(date)}，${reason}`);
      } else {
        const occupiedText = intervals.length ? `，有 ${intervals.length} 個我的預約時段` : '';
        button.setAttribute('aria-label', `${formatDate(date)}${occupiedText}，可開啟預約`);
        button.addEventListener('click', () => selectDate(date, button));
      }
      els.calendarGrid.appendChild(button);
    }
  }

  async function loadMonthOccupancy() {
    if (!window.BookingSystem) return;
    const testSessionToken = window.TestModeClient && typeof window.TestModeClient.getSessionToken === 'function'
      ? window.TestModeClient.getSessionToken()
      : '';
    if (!testSessionToken && (!window.liff || typeof window.liff.isLoggedIn !== 'function' || !window.liff.isLoggedIn())) return;
    const idToken = !testSessionToken && typeof window.liff?.getIDToken === 'function' ? window.liff.getIDToken() : '';
    if (!idToken && !testSessionToken) return;

    const month = state.month;
    const requestSeq = ++state.occupancyRequestSeq;
    try {
      state.config = state.config || await window.BookingSystem.loadConfig();
      const result = await requestCalendar(state.config, idToken, month);
      if (requestSeq !== state.occupancyRequestSeq || month !== state.month) return;

      if (result.settings || result.today) {
        applyGlobalSettings({ settings: result.settings || {}, today: result.today || state.today });
      }
      if (typeof result.earliestBookingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(result.earliestBookingDate)) {
        state.minimumDate = result.earliestBookingDate;
      }
      if (typeof result.latestBookingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(result.latestBookingDate)) {
        state.maximumDate = result.latestBookingDate;
      } else if (Number(result.settings?.maxAdvanceDays || 0) === 0) {
        state.maximumDate = '';
      }

      clearMonthEntries(month);
      for (const item of Array.isArray(result.occupiedDates) ? result.occupiedDates : []) {
        const date = String(item?.date || '').slice(0, 10);
        if (!date.startsWith(`${month}-`)) continue;
        const intervals = Array.isArray(item?.intervals)
          ? item.intervals.map((interval) => ({
              startTime: String(interval?.startTime || '').slice(0, 5),
              endTime: String(interval?.endTime || '').slice(0, 5),
              startAt: String(interval?.startAt || '').slice(0, 10),
              endAt: String(interval?.endAt || '').slice(0, 10),
            })).filter((interval) => /^\d{2}:\d{2}$/.test(interval.startTime) && /^\d{2}:\d{2}$/.test(interval.endTime))
          : [];
        if (intervals.length) state.occupiedByDate.set(date, intervals);
      }
      for (const raw of Array.isArray(result.holidays) ? result.holidays : []) {
        addHolidayToMonth(month, raw);
      }
      if (state.selectedDate && state.holidaysByDate.has(state.selectedDate)) {
        clearSelectedDate();
        closeAppointmentModal(false);
      }
      renderCalendar();
    } catch (_) {
      // Monthly occupancy/holiday decorations are supplemental. Booking creation remains protected server-side.
    }
  }

  function addHolidayToMonth(month, raw) {
    const startsOn = String(raw?.startsOn || '').slice(0, 10);
    const endsOn = String(raw?.endsOn || startsOn).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn) || !/^\d{4}-\d{2}-\d{2}$/.test(endsOn) || endsOn < startsOn) return;
    const holiday = {
      calendarItemId: String(raw?.calendarItemId || ''),
      title: String(raw?.title || '休假日').slice(0, 200),
      description: String(raw?.description || '').slice(0, 2000),
      startsOn,
      endsOn,
      accent: safeHolidayAccent(raw?.accent),
    };
    let date = startsOn < `${month}-01` ? `${month}-01` : startsOn;
    const monthEndExclusive = `${shiftMonth(month, 1)}-01`;
    let guard = 0;
    while (date <= endsOn && date < monthEndExclusive && guard < 32) {
      if (date.startsWith(`${month}-`)) {
        const rows = state.holidaysByDate.get(date) || [];
        if (!rows.some((item) => item.calendarItemId && item.calendarItemId === holiday.calendarItemId)) rows.push(holiday);
        else if (!holiday.calendarItemId && !rows.some((item) => item.title === holiday.title && item.startsOn === holiday.startsOn && item.endsOn === holiday.endsOn)) rows.push(holiday);
        state.holidaysByDate.set(date, rows);
      }
      date = addDays(date, 1);
      guard += 1;
    }
  }

  async function requestCalendar(config, idToken, month) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const endpoint = `${String(config.supabaseUrl).replace(/\/$/, '')}/functions/v1/booking-calendar-api`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': String(config.supabasePublishableKey),
        },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify(window.TestModeClient && typeof window.TestModeClient.payload === 'function'
          ? window.TestModeClient.payload({ idToken, month })
          : { idToken, month }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok !== true) {
        const error = new Error(String(payload?.error?.message || '無法取得本月預約時段。'));
        error.code = String(payload?.error?.code || 'CALENDAR_API_ERROR');
        throw error;
      }
      return payload.data || {};
    } finally {
      window.clearTimeout(timer);
    }
  }

  function clearMonthEntries(month) {
    for (const date of [...state.occupiedByDate.keys()]) {
      if (String(date).startsWith(`${month}-`)) state.occupiedByDate.delete(date);
    }
    for (const date of [...state.holidaysByDate.keys()]) {
      if (String(date).startsWith(`${month}-`)) state.holidaysByDate.delete(date);
    }
  }

  function scheduleMonthOccupancyReload() {
    window.clearTimeout(state.reloadTimer);
    state.reloadTimer = window.setTimeout(loadMonthOccupancy, 350);
  }

  function selectDate(date, trigger) {
    if (date < (state.minimumDate || state.today) || (state.maximumDate && date > state.maximumDate)) return;
    const holidays = state.holidaysByDate.get(date) || [];
    if (holidays.length) {
      showHolidayNotice(date, holidays, trigger);
      return;
    }
    state.selectedDate = date;
    state.lastDateTrigger = trigger || null;
    els.bookingDate.disabled = false;
    els.bookingDate.value = date;
    els.bookingDate.dispatchEvent(new Event('change', { bubbles: true }));
    renderCalendar();
    openAppointmentModal(date);
    window.dispatchEvent(new CustomEvent('booking:date-selected'));
  }

  function showHolidayNotice(date, holidays, trigger) {
    closeAppointmentModal(false);
    state.holidayTrigger = trigger instanceof HTMLElement ? trigger : null;
    if (els.holidayDate) els.holidayDate.textContent = `${formatDate(date)}｜此日休假，無法預約`;
    if (els.holidayDetails) {
      els.holidayDetails.replaceChildren(...holidays.map((holiday) => {
        const item = document.createElement('section');
        item.className = 'booking-holiday-detail';
        applyHolidayAccent(item, holiday.accent);
        const title = document.createElement('strong');
        title.textContent = holiday.title || '休假日';
        item.appendChild(title);
        const description = String(holiday.description || '').trim();
        if (description) {
          const text = document.createElement('p');
          text.textContent = description;
          item.appendChild(text);
        }
        return item;
      }));
    }
    els.holidayModal?.classList.remove('hidden');
    window.setTimeout(() => els.closeHolidayButton?.focus(), 0);
  }

  function closeHolidayNotice(returnFocus) {
    if (!els.holidayModal || els.holidayModal.classList.contains('hidden')) return;
    els.holidayModal.classList.add('hidden');
    const trigger = state.holidayTrigger;
    state.holidayTrigger = null;
    if (returnFocus && trigger && document.contains(trigger)) window.setTimeout(() => trigger.focus(), 0);
  }

  function openAppointmentModal(date) {
    if (els.selectedDateSummary) {
      els.selectedDateSummary.textContent = `${formatDate(date)}｜請選擇預約項目與時間`;
    }
    els.appointmentPanel.classList.remove('hidden');
    document.body.classList.add('booking-selection-open');
    window.setTimeout(() => els.closeAppointmentButton?.focus(), 0);
  }

  function closeAppointmentModal(returnFocus) {
    if (!els.appointmentPanel || els.appointmentPanel.classList.contains('hidden')) return;
    els.appointmentPanel.classList.add('hidden');
    document.body.classList.remove('booking-selection-open');
    if (returnFocus) window.setTimeout(() => state.lastDateTrigger?.focus(), 0);
  }

  function syncAfterSelectionMutation() {
    if (!state.selectedDate) return;

    if (!els.bookingDate.value) {
      els.bookingDate.disabled = false;
      els.bookingDate.value = state.selectedDate;
      if (els.selectedDateSummary) els.selectedDateSummary.textContent = `${formatDate(state.selectedDate)}｜請選擇預約項目與時間`;
      return;
    }

    const actualDate = els.bookingDate.value;
    if (state.holidaysByDate.has(actualDate)) {
      clearSelectedDate();
      closeAppointmentModal(false);
      return;
    }
    if (actualDate !== state.selectedDate) {
      state.selectedDate = actualDate;
      state.month = actualDate.slice(0, 7);
      renderCalendar();
      loadMonthOccupancy();
    }
    if (els.selectedDateSummary) els.selectedDateSummary.textContent = `${formatDate(actualDate)}｜請選擇預約項目與時間`;
  }

  function formatDate(date) {
    if (window.BookingSystem?.formatDate) return window.BookingSystem.formatDate(date);
    const [year, month, day] = String(date).split('-');
    return `${year}/${month}/${day}`;
  }
})();
