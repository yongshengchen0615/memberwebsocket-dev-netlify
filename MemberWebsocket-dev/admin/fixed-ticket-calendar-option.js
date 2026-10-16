(() => {
  'use strict';

  const endpointSuffix = '/functions/v1/fixed-ticket-automation';
  const templateById = new Map();
  const originalFetch = window.fetch.bind(window);
  const TARGETED_MESSAGE = '此日曆項目由壽星固定票券自動管理；請回到活動票券中的固定票券設定修改或關閉。';
  const FIXED_TIER_HELP = '固定票券只有符合所選會員等級才會自動取得並可使用；票券頁只顯示已取得的票券。日曆呈現依「會員階級顯示規則」，較高階鎖定預覽不可領取或使用。';

  function isFixedTicketRequest(input) {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input || '');
    return url.includes(endpointSuffix);
  }

  function captureTemplates(payload) {
    const data = payload && payload.data && typeof payload.data === 'object' ? payload.data : {};
    const templates = Array.isArray(data.templates) ? data.templates : data.template ? [data.template] : [];
    for (const template of templates) {
      const id = String(template && template.fixedTicketId || '');
      if (id) templateById.set(id, template);
    }
  }

  function ensureControl() {
    const section = document.getElementById('fixedTicketScheduleFields');
    if (!section) return null;
    let input = document.getElementById('fixedTicketCalendarEnabled');
    if (input) return input;

    const block = document.createElement('div');
    block.className = 'fixed-ticket-inline-actions';

    const label = document.createElement('label');
    label.className = 'fixed-ticket-notify';
    input = document.createElement('input');
    input.id = 'fixedTicketCalendarEnabled';
    input.type = 'checkbox';
    label.append(input, document.createTextNode(' 加入會員日曆'));

    const summary = document.createElement('p');
    summary.id = 'fixedTicketCalendarSummary';
    summary.className = 'fixed-ticket-schedule-summary';
    summary.setAttribute('aria-live', 'polite');

    block.append(label);
    const runActions = section.querySelector('.fixed-ticket-inline-actions');
    if (runActions) runActions.before(block, summary);
    else section.append(block, summary);

    input.addEventListener('change', updateSummary);
    updateSummary();
    return input;
  }

  function updateSummary() {
    const input = ensureControl();
    const summary = document.getElementById('fixedTicketCalendarSummary');
    if (!input || !summary) return;
    if (!input.checked) {
      summary.textContent = '此固定票券不會顯示在會員日曆。';
      return;
    }
    const scheduleType = String(document.getElementById('fixedTicketScheduleType')?.value || 'birthday_month');
    summary.textContent = scheduleType === 'birthday_month'
      ? '會加入會員日曆，但只有生日月份相符的當月壽星看得到；其他會員不會收到這筆日曆資料。會員階級是否顯示依共用規則決定；高階預覽顯示「需升級」。'
      : '會依固定票券的每個發放週期自動建立或更新會員日曆項目；日曆是否顯示依共用階級規則決定；高階預覽不可使用票券。';
  }

  function updateTierHelp() {
    const fieldset = document.getElementById('eventTicketAllowedTiers');
    const help = fieldset?.querySelector('p');
    if (!help) return;
    if (!help.dataset.defaultTierHelp) help.dataset.defaultTierHelp = help.textContent || '';
    const fixed = document.getElementById('eventTicketType')?.value === 'fixed';
    const text = fixed ? FIXED_TIER_HELP : help.dataset.defaultTierHelp;
    // This help is inside the observed form. Even assigning identical text
    // creates a childList mutation, so only write when the content changes.
    if (help.textContent !== text) help.textContent = text;
  }

  function syncSelectedTemplate(fixedTicketId) {
    const input = ensureControl();
    if (!input) return;
    const template = templateById.get(String(fixedTicketId || ''));
    input.checked = Boolean(template && template.calendarEnabled);
    updateSummary();
    updateTierHelp();
  }

  function resetControl() {
    const input = ensureControl();
    if (input) input.checked = false;
    updateSummary();
    updateTierHelp();
  }

  function ensureTargetedStatusOption() {
    const status = document.getElementById('calendarItemStatus');
    if (!(status instanceof HTMLSelectElement)) return null;
    if (!Array.from(status.options).some((option) => option.value === 'targeted')) {
      const option = new Option('壽星限定（系統管理）', 'targeted');
      option.disabled = true;
      status.append(option);
    }
    return status;
  }

  function updateTargetedCalendarGuard() {
    const status = ensureTargetedStatusOption();
    const save = document.getElementById('saveCalendarItemButton');
    const del = document.getElementById('deleteCalendarItemButton');
    const id = document.getElementById('calendarItemId');
    const message = document.getElementById('calendarItemFormMessage');
    if (!status || !save || !del) return;

    const targeted = status.value === 'targeted';
    if (targeted) {
      save.dataset.fixedCalendarGuard = '1';
      del.dataset.fixedCalendarGuard = '1';
      save.disabled = true;
      del.disabled = true;
      if (message) {
        message.textContent = TARGETED_MESSAGE;
        message.classList.remove('hidden', 'success');
        message.dataset.fixedCalendarGuard = '1';
      }
      return;
    }

    if (save.dataset.fixedCalendarGuard === '1') {
      delete save.dataset.fixedCalendarGuard;
      save.disabled = false;
    }
    if (del.dataset.fixedCalendarGuard === '1') {
      delete del.dataset.fixedCalendarGuard;
      del.disabled = !String(id && id.value || '').trim();
    }
    if (message && message.dataset.fixedCalendarGuard === '1') {
      delete message.dataset.fixedCalendarGuard;
      if (message.textContent === TARGETED_MESSAGE) {
        message.textContent = '';
        message.classList.add('hidden');
      }
    }
  }

  window.fetch = async function fixedTicketCalendarFetch(input, init) {
    if (!isFixedTicketRequest(input)) return originalFetch(input, init);

    let nextInit = init;
    if (init && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (body && body.action === 'admin.fixed-tickets.save' && body.template && typeof body.template === 'object') {
          const calendarEnabled = Boolean(ensureControl()?.checked);
          body.template = { ...body.template, calendarEnabled };
          nextInit = { ...init, body: JSON.stringify(body) };
        }
      } catch (_) {}
    }

    const response = await originalFetch(input, nextInit);
    try {
      const payload = await response.clone().json();
      captureTemplates(payload);
    } catch (_) {}
    return response;
  };

  function ready() {
    const form = document.getElementById('eventTicketForm');
    if (!form) return;
    ensureControl();
    ensureTargetedStatusOption();
    updateTierHelp();

    new MutationObserver(() => {
      ensureControl();
      updateTierHelp();
    }).observe(form, { childList: true, subtree: true });

    document.getElementById('fixedTicketScheduleType')?.addEventListener('change', updateSummary);
    form.addEventListener('change', (event) => {
      if (event.target && event.target.id === 'fixedTicketScheduleType') updateSummary();
      if (event.target && event.target.id === 'eventTicketType') window.queueMicrotask(updateTierHelp);
    });

    document.getElementById('eventTicketListItems')?.addEventListener('click', (event) => {
      const fixed = event.target instanceof Element ? event.target.closest('[data-fixed-ticket-id]') : null;
      if (!fixed) return;
      const id = String(fixed.getAttribute('data-fixed-ticket-id') || '');
      window.setTimeout(() => syncSelectedTemplate(id), 0);
    });

    document.getElementById('newEventTicketButton')?.addEventListener('click', () => window.setTimeout(resetControl, 0));
    document.getElementById('resetEventTicketButton')?.addEventListener('click', () => window.setTimeout(resetControl, 0));

    const calendarForm = document.getElementById('calendarItemForm');
    const calendarEditorStatus = document.getElementById('calendarItemEditorStatus');
    if (calendarForm) {
      calendarForm.addEventListener('submit', (event) => {
        if (document.getElementById('calendarItemStatus')?.value !== 'targeted') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        updateTargetedCalendarGuard();
      }, true);
    }
    document.getElementById('deleteCalendarItemButton')?.addEventListener('click', (event) => {
      if (document.getElementById('calendarItemStatus')?.value !== 'targeted') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      updateTargetedCalendarGuard();
    }, true);
    if (calendarEditorStatus) {
      new MutationObserver(() => window.queueMicrotask(updateTargetedCalendarGuard))
        .observe(calendarEditorStatus, { childList: true, characterData: true, subtree: true, attributes: true });
    }
    window.setTimeout(() => {
      updateTargetedCalendarGuard();
      updateTierHelp();
    }, 0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
})();
