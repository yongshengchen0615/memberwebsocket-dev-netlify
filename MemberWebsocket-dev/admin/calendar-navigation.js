/* Month/day interaction shared by the existing administrator calendars.
   It only consumes authorized snapshots; all edits use the original forms. */
(function (root) {
  'use strict';
  const instances = new WeakMap();
  const dayFormatter = new Intl.DateTimeFormat('zh-Hant-TW', {timeZone:'UTC', year:'numeric', month:'long', day:'numeric', weekday:'long'});
  const labels = { activity:'會員活動', ticket:'活動票券', booking:'預約' };
  const dateKeys = { activity:'adminCalendarDate', ticket:'ticketCalendarDate', booking:'bookingCalendarDate' };
  const dateAttributes = { activity:'data-admin-calendar-date', ticket:'data-ticket-calendar-date', booking:'data-booking-calendar-date' };
  const entrySelector = '[data-admin-calendar-item-id], [data-ticket-calendar-item-id], [data-booking-calendar-id], [data-booking-calendar-holiday-id]';

  function parseDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1000 && date.getUTCFullYear() <= 9999 && date.toISOString().slice(0, 10) === value ? date : null;
  }
  function shiftDate(value, days) {
    const date = parseDate(value);
    if (!date || !Number.isSafeInteger(days)) return '';
    date.setUTCDate(date.getUTCDate() + days);
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1000 && date.getUTCFullYear() <= 9999 ? date.toISOString().slice(0, 10) : '';
  }
  function monthSequence(value) {
    const date = parseDate(value);
    if (!date) return [];
    date.setUTCDate(1);
    return Array.from({length:13}, (_, index) => {
      const month = new Date(date);
      month.setUTCMonth(month.getUTCMonth() + index - 2);
      return month.getUTCFullYear() >= 1000 && month.getUTCFullYear() <= 9999 ? month.toISOString().slice(0, 10) : '';
    }).filter(Boolean);
  }
  function minutes(value) {
    const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value || ''));
    return match && +match[1] < 24 && +match[2] < 60 ? +match[1] * 60 + +match[2] : null;
  }
  function bookingSegment(booking, date) {
    if (!parseDate(booking?.bookingDate) || !parseDate(date)) return null;
    const start = minutes(booking.startTime), end = minutes(booking.endTime);
    if (start === null || end === null || start === end) return null;
    if (booking.bookingDate === date) return {start, end:end < start ? 1440 : end, fromPreviousDay:false, continues:end < start};
    if (end < start && end > 0 && shiftDate(booking.bookingDate, 1) === date) return {start:0, end, fromPreviousDay:true, continues:false};
    return null;
  }
  function dateLabel(value) {
    return dayFormatter.format(parseDate(value));
  }
  function node(tag, className, text) {
    const element = root.document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function button(text, attribute, label) {
    const element = node('button', 'calendar-navigation-button', text);
    element.type = 'button';
    element.setAttribute(attribute, '');
    if (label) element.setAttribute('aria-label', label);
    return element;
  }
  function occursOn(row, date) {
    const start = row.startsOn || row.bookingDate;
    const end = row.endsOn || start;
    return parseDate(start) && parseDate(end) && start <= date && date <= end;
  }

  function connect(options) {
    if (!options.grid || !labels[options.scope] || !parseDate(options.month) || !parseDate(options.today)) return;
    let ui = instances.get(options.grid);
    if (!ui) {
      ui = mount(options.grid, options.scope);
      instances.set(options.grid, ui);
    }
    ui.options = options;
    if (!ui.date || ui.date.slice(0, 7) !== options.month.slice(0, 7)) {
      ui.date = options.today.slice(0, 7) === options.month.slice(0, 7) ? options.today : options.month;
    }
    render(ui);
  }

  function mount(grid, scope) {
    const workspace = grid.closest('.admin-calendar');
    const ui = {grid, workspace, scope, view:'month', date:'', options:null, gesture:null, suppressClick:false};
    workspace.classList.add('calendar-navigation');
    const controls = node('div', 'calendar-navigation-controls');
    const monthLabel = node('label', 'calendar-month-picker-label', '選擇月份');
    ui.monthPicker = node('input');
    ui.monthPicker.type = 'month';
    ui.monthPicker.min = '1000-01';
    ui.monthPicker.max = '9999-12';
    ui.monthPicker.setAttribute('data-calendar-month-picker', '');
    ui.monthPicker.setAttribute('aria-label', labels[scope] + '選擇月份');
    monthLabel.append(ui.monthPicker);
    const openDay = button('當日檢視', 'data-calendar-open-day');
    controls.append(monthLabel, openDay);
    ui.monthStrip = node('div', 'calendar-month-strip');
    ui.monthStrip.setAttribute('role', 'group');
    ui.monthStrip.setAttribute('aria-label', labels[scope] + '快速切換月份');
    workspace.querySelector('.admin-calendar-weekdays').before(controls, ui.monthStrip);

    ui.day = node('section', 'calendar-day-view');
    ui.day.setAttribute('data-calendar-day-view', '');
    const dayToolbar = node('div', 'calendar-day-toolbar');
    const back = button('‹ 月曆', 'data-calendar-month-view', '返回月曆');
    const previous = button('‹', 'data-calendar-previous-day', '前一天');
    const next = button('›', 'data-calendar-next-day', '後一天');
    const today = button('今天', 'data-calendar-today', '回到今天');
    ui.datePicker = node('input');
    ui.datePicker.type = 'date';
    ui.datePicker.min = '1000-01-01';
    ui.datePicker.max = '9999-12-31';
    ui.datePicker.setAttribute('data-calendar-date-picker', '');
    ui.datePicker.setAttribute('aria-label', labels[scope] + '選擇日期');
    const datePager = node('div', 'calendar-day-pager');
    datePager.append(previous, ui.datePicker, next);
    dayToolbar.append(back, today, datePager);
    ui.dayTitle = node('h4', 'calendar-day-title');
    ui.dayTitle.tabIndex = -1;
    ui.dayBody = node('div', 'calendar-day-body');
    ui.day.append(dayToolbar, ui.dayTitle, ui.dayBody);
    grid.after(ui.day);

    const createArea = node('div', 'calendar-create-area');
    ui.menu = node('div', 'calendar-create-menu');
    ui.menu.id = grid.id + 'CreateMenu';
    ui.menu.hidden = true;
    ui.menu.setAttribute('data-calendar-create-menu', '');
    const action = scope === 'booking' ? 'holiday' : scope;
    const create = button(scope === 'booking' ? '設定休假日' : '新增' + labels[scope], 'data-calendar-create');
    create.setAttribute('data-calendar-create', action);
    ui.menu.append(create);
    ui.add = button('＋', 'data-calendar-add', labels[scope] + '新增選單');
    ui.add.classList.add('calendar-add-button');
    ui.add.setAttribute('aria-expanded', 'false');
    ui.add.setAttribute('aria-controls', ui.menu.id);
    createArea.append(ui.menu, ui.add);
    workspace.append(createArea);

    ui.monthPicker.addEventListener('change', () => selectMonth(ui, ui.monthPicker.value + '-01'));
    workspace.addEventListener('click', event => {
      const target = event.target.closest('[data-calendar-month]');
      if (target && ui.monthStrip.contains(target)) selectMonth(ui, target.dataset.calendarMonth);
    });
    ui.datePicker.addEventListener('change', () => openDate(ui, ui.datePicker.value, false));
    ui.datePicker.addEventListener('blur', () => {
      if (!parseDate(ui.datePicker.value)) ui.datePicker.value = ui.date;
    });
    ui.monthPicker.addEventListener('blur', () => {
      if (!parseDate(ui.monthPicker.value + '-01')) ui.monthPicker.value = ui.options.month.slice(0, 7);
    });
    openDay.addEventListener('click', () => openDate(ui, ui.date));
    previous.addEventListener('click', () => openDate(ui, shiftDate(ui.date, -1)));
    next.addEventListener('click', () => openDate(ui, shiftDate(ui.date, 1)));
    today.addEventListener('click', () => openDate(ui, ui.options.today));
    const monthToday = workspace.querySelector('.admin-calendar-today-button');
    if (monthToday) {
      monthToday.textContent = '回到今天';
      monthToday.addEventListener('click', event => {
        event.stopImmediatePropagation();
        selectMonth(ui, ui.options.today.slice(0, 7) + '-01');
      }, true);
    }
    back.addEventListener('click', () => {
      ui.view = 'month';
      closeMenu(ui);
      render(ui);
      grid.querySelector('button[' + dateAttributes[scope] + '="' + ui.date + '"]')?.focus({preventScroll:true});
    });
    ui.add.addEventListener('click', () => {
      ui.menu.hidden = !ui.menu.hidden;
      ui.add.setAttribute('aria-expanded', String(!ui.menu.hidden));
      if (!ui.menu.hidden) create.focus({preventScroll:true});
    });
    create.addEventListener('click', () => {
      closeMenu(ui);
      ui.options.onCreate(ui.date, ui.add);
    });
    workspace.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !ui.menu.hidden) {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(ui);
        ui.add.focus({preventScroll:true});
      }
    });
    root.document.addEventListener('click', event => {
      if (!createArea.contains(event.target)) closeMenu(ui);
    });
    grid.addEventListener('click', event => {
      if (ui.suppressClick && event.detail !== 0) {
        ui.suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.target.closest(entrySelector)) return;
      const cell = event.target.closest('[' + dateAttributes[scope] + ']');
      if (!cell) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openDate(ui, cell.dataset[dateKeys[scope]]);
    }, true);
    for (const surface of [grid, ui.dayBody]) {
      surface.addEventListener('pointerdown', event => {
        ui.suppressClick = false;
        ui.gesture = null;
        if (event.pointerType === 'mouse' || event.isPrimary === false || event.target.closest('input, select, textarea')) return;
        ui.gesture = {id:event.pointerId, x:event.clientX, y:event.clientY};
      });
      surface.addEventListener('pointercancel', () => { ui.gesture = null; });
      surface.addEventListener('pointerup', event => {
        const start = ui.gesture;
        ui.gesture = null;
        if (!start || start.id !== event.pointerId) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        ui.suppressClick = true;
        const direction = dx < 0 ? 1 : -1;
        if (ui.view === 'day') openDate(ui, shiftDate(ui.date, direction));
        else {
          const date = parseDate(ui.options.month);
          date.setUTCMonth(date.getUTCMonth() + direction);
          if (date.getUTCFullYear() >= 1000 && date.getUTCFullYear() <= 9999) selectMonth(ui, date.toISOString().slice(0, 10));
        }
      });
    }
    return ui;
  }

  function closeMenu(ui) {
    ui.menu.hidden = true;
    ui.add.setAttribute('aria-expanded', 'false');
  }
  function selectMonth(ui, month) {
    if (!parseDate(month)) {
      if (root.document.activeElement !== ui.monthPicker) ui.monthPicker.value = ui.options.month.slice(0, 7);
      return;
    }
    ui.view = 'month';
    ui.date = ui.options.today.slice(0, 7) === month.slice(0, 7) ? ui.options.today : month;
    closeMenu(ui);
    ui.options.onMonthChange(month);
  }
  function openDate(ui, date, focusTitle = true) {
    if (!parseDate(date)) {
      if (root.document.activeElement !== ui.datePicker) ui.datePicker.value = ui.date;
      return;
    }
    ui.date = date;
    ui.view = 'day';
    closeMenu(ui);
    if (date.slice(0, 7) !== ui.options.month.slice(0, 7)) ui.options.onMonthChange(date.slice(0, 7) + '-01');
    else render(ui);
    if (focusTitle) ui.dayTitle.focus({preventScroll:true});
  }
  function render(ui) {
    const {grid, workspace, options} = ui;
    const isDay = ui.view === 'day';
    workspace.dataset.calendarView = ui.view;
    grid.hidden = isDay;
    ui.day.hidden = !isDay;
    workspace.querySelector('.admin-calendar-weekdays').hidden = isDay;
    ui.monthStrip.hidden = isDay;
    if (root.document.activeElement !== ui.monthPicker) ui.monthPicker.value = options.month.slice(0, 7);
    if (root.document.activeElement !== ui.datePicker) ui.datePicker.value = ui.date;
    workspace.querySelector('[data-calendar-previous-day]').disabled = ui.date === '1000-01-01';
    workspace.querySelector('[data-calendar-next-day]').disabled = ui.date === '9999-12-31';
    workspace.querySelectorAll('.admin-calendar-month-button').forEach(button => {
      button.disabled = button.id.endsWith('PreviousMonthButton') ? options.month === '1000-01-01' : options.month === '9999-12-01';
    });
    ui.dayTitle.textContent = dateLabel(ui.date) + ' · ' + labels[ui.scope];
    const chips = monthSequence(options.month).map(month => {
      const year = month.slice(0, 4), number = Number(month.slice(5, 7));
      const chip = button((number === 1 ? year + '年 ' : '') + number + '月', 'data-calendar-month');
      chip.dataset.calendarMonth = month;
      chip.setAttribute('aria-label', year + '年' + number + '月');
      chip.setAttribute('aria-pressed', String(month === options.month));
      return chip;
    });
    const restoreMonthFocus = ui.monthStrip.contains(root.document.activeElement);
    // A new strip starts at its first chip without synchronous layout/scroll
    // measurement. Keep delegated handlers on the persistent workspace.
    const strip = ui.monthStrip.cloneNode(false);
    strip.append(...chips);
    ui.monthStrip.replaceWith(strip);
    ui.monthStrip = strip;
    const selected = chips.find(chip => chip.dataset.calendarMonth === options.month);
    if (restoreMonthFocus) selected?.focus({preventScroll:true});
    grid.querySelectorAll('.admin-calendar-day-button').forEach(day => {
      day.setAttribute('aria-label', dateLabel(day.dataset[dateKeys[ui.scope]]) + '，查看當日' + labels[ui.scope]);
      if (day.dataset[dateKeys[ui.scope]] === ui.date) day.setAttribute('aria-current', 'date');
      else day.removeAttribute('aria-current');
    });
    if (isDay) renderDay(ui);
  }

  function entryButton(ui, row, segment) {
    const isBooking = Boolean(row.bookingId);
    const id = row.bookingId || row.eventTicketId || row.calendarItemId;
    const title = isBooking ? String(row.memberDisplayName || row.memberCode || '會員') : String(row.title || '未命名項目');
    const entry = button('', 'data-calendar-entry');
    entry.dataset.calendarEntry = String(id || '');
    entry.classList.add('calendar-day-entry', row.itemType === 'holiday' ? 'is-holiday' : 'is-event');
    if (isBooking) entry.setAttribute('data-business-requires', 'booking');
    const accent = /^#[a-f0-9]{6}$/i.test(String(row.accent || '')) ? row.accent : '';
    if (accent) entry.style.setProperty('--calendar-item-accent', accent);
    const time = segment ? (segment.fromPreviousDay ? '前日 ' : '') + String(row.startTime || '').slice(0,5) + '–' + String(row.endTime || '').slice(0,5) + (segment.continues ? '（跨日）' : '') : (isBooking ? '時間未提供' : '全天');
    entry.append(node('small', 'calendar-day-entry-time', time), node('strong', '', title));
    if (isBooking) {
      const status = ({pending:'待確認',confirmed:'已確認',completed:'已完成'})[row.status] || '';
      const details = [status, row.technicianName, row.partySize > 1 ? row.partySize + ' 人' : ''].filter(Boolean).join(' · ');
      entry.append(node('small', '', details));
    }
    entry.addEventListener('click', () => ui.options.onOpen(row, entry));
    return entry;
  }
  function renderDay(ui) {
    const allDay = [], timed = [];
    for (const row of ui.options.rows || []) {
      const segment = row.bookingId ? bookingSegment(row, ui.date) : null;
      if (segment) timed.push({row, segment});
      else if (occursOn(row, ui.date)) allDay.push(row);
    }
    const content = [];
    if (allDay.length) {
      const section = node('div', 'calendar-all-day');
      section.append(node('span', 'calendar-time-label', '全天'));
      const entries = node('div', 'calendar-day-entries');
      allDay.forEach(row => entries.append(entryButton(ui, row)));
      section.append(entries);
      content.push(section);
    }
    if (!allDay.length && !timed.length) {
      const empty = node('p', 'calendar-day-empty', '這一天沒有' + (ui.scope === 'booking' ? '預約或休假安排' : labels[ui.scope]) + '，可點選右下角「＋」新增。');
      empty.setAttribute('role', 'status');
      content.push(empty);
    }
    if (ui.scope === 'booking') {
      timed.sort((a,b) => a.segment.start - b.segment.start || String(a.row.bookingId).localeCompare(String(b.row.bookingId)));
      const timeline = node('div', 'calendar-day-timeline');
      for (let hour=0; hour<24; hour++) {
        const slot = node('div', 'calendar-hour-row');
        slot.append(node('span', 'calendar-time-label', String(hour).padStart(2,'0') + ':00'));
        const entries = node('div', 'calendar-day-entries');
        timed.filter(item => Math.floor(item.segment.start / 60) === hour).forEach(item => entries.append(entryButton(ui, item.row, item.segment)));
        slot.append(entries);
        timeline.append(slot);
      }
      content.push(timeline);
    }
    ui.dayBody.replaceChildren(...content);
  }

  const api = Object.freeze({connect, shiftDate, monthSequence, bookingSegment});
  root.MemberAdminCalendarNavigation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
