(() => {
  'use strict';

  const TIER_KEYS = ['general', 'silver', 'gold', 'platinum'];
  const WEEKDAYS = { 1: '星期一', 2: '星期二', 3: '星期三', 4: '星期四', 5: '星期五', 6: '星期六', 7: '星期日' };
  const EXPIRY_MODES = ['month_end', 'week_end', 'days_after_issue', 'fixed_date'];
  let config = null;
  let templates = [];
  let selectedFixedTicketId = '';
  let selectedUpdatedAt = '';
  let busy = false;
  let renderingList = false;
  let loadTemplatesPromise = null;

  function ready(callback) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', callback, { once: true });
    else callback();
  }

  function taipeiDate() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  ready(() => {
    document.getElementById('birthdayBenefitSettings')?.remove();

    const form = document.getElementById('eventTicketForm');
    const type = document.getElementById('eventTicketType');
    const dateRange = document.querySelector('#eventTicketForm .date-range-control');
    if (!form || !type || !dateRange || document.getElementById('fixedTicketScheduleFields')) return;

    if (!Array.from(type.options).some((option) => option.value === 'fixed')) {
      type.append(new Option('固定票券', 'fixed'));
    }

    const section = document.createElement('section');
    section.id = 'fixedTicketScheduleFields';
    section.className = 'fixed-ticket-schedule hidden';
    section.setAttribute('aria-labelledby', 'fixedTicketScheduleTitle');
    section.innerHTML = `
      <div class="fixed-ticket-schedule-heading">
        <div>
          <p class="kicker">Automatic issue</p>
          <h4 id="fixedTicketScheduleTitle">固定發放週期</h4>
          <p>系統會直接把票券發到符合條件的會員帳戶，不需要會員自行領取。</p>
        </div>
      </div>
      <div class="form-grid fixed-ticket-schedule-grid">
        <label>發放週期
          <select id="fixedTicketScheduleType">
            <option value="birthday_month">會員生日當月 1 號</option>
            <option value="yearly">每年</option>
            <option value="monthly">每月</option>
            <option value="weekly">每週</option>
          </select>
        </label>
        <label id="fixedTicketYearlyMonthField" class="hidden">每年月份
          <select id="fixedTicketScheduleMonth"></select>
        </label>
        <label id="fixedTicketScheduleDayField" class="hidden">發放日期
          <input id="fixedTicketScheduleDay" type="number" min="1" max="31" step="1" value="1">
        </label>
        <label id="fixedTicketWeekdayField" class="hidden">每週發放日
          <select id="fixedTicketScheduleWeekday">
            <option value="1">星期一</option><option value="2">星期二</option><option value="3">星期三</option>
            <option value="4">星期四</option><option value="5">星期五</option><option value="6">星期六</option><option value="7">星期日</option>
          </select>
        </label>
      </div>
      <p id="fixedTicketScheduleSummary" class="fixed-ticket-schedule-summary" aria-live="polite"></p>
      <div class="form-grid fixed-ticket-schedule-grid">
        <label>使用期限
          <select id="fixedTicketExpiryMode">
            <option value="month_end">當月月底</option>
            <option value="week_end">當週</option>
            <option value="days_after_issue">發放後設定天數</option>
            <option value="fixed_date">指定日期</option>
          </select>
        </label>
        <label id="fixedTicketExpiryDaysField" class="hidden">發放後可使用天數
          <input id="fixedTicketExpiryDays" type="number" min="1" max="3650" step="1" value="7" inputmode="numeric">
        </label>
        <label id="fixedTicketExpiryDateField" class="hidden">指定到期日
          <input id="fixedTicketExpiryDate" type="date">
        </label>
      </div>
      <p id="fixedTicketExpirySummary" class="fixed-ticket-schedule-summary" aria-live="polite"></p>
      <section class="fixed-ticket-notification" aria-labelledby="fixedTicketNotificationTitle">
        <div class="fixed-ticket-notification-heading">
          <h4 id="fixedTicketNotificationTitle">LINE 通知</h4>
          <span class="fixed-ticket-timezone">台北時間 UTC+8</span>
        </div>
        <label class="fixed-ticket-notify">
          <input id="fixedTicketNotifyLine" type="checkbox" aria-describedby="fixedTicketNotifyHint" checked>
          <span><strong>發放後傳送 LINE 通知</strong><small id="fixedTicketNotifyHint">關閉通知，票券仍會照常發放。</small></span>
        </label>
        <div class="fixed-ticket-notification-grid">
          <label>通知時間
            <input id="fixedTicketNotifyTime" type="time" step="60" aria-describedby="fixedTicketNotifyTimeHint">
            <small id="fixedTicketNotifyTimeHint">留空即為發放後通知。</small>
          </label>
          <p id="fixedTicketNotifySummary" class="fixed-ticket-notification-summary" aria-live="polite"></p>
        </div>
        <details class="fixed-ticket-notification-details">
          <summary>通知時間與停用規則</summary>
          <p>指定時間已過時，會在票券發放後立即通知。停用會取消待發通知；重新開啟只恢復仍有效且未發送的通知。</p>
        </details>
      </section>
      <div class="fixed-ticket-inline-actions">
        <button id="fixedTicketRunButton" class="button button-outline" type="button" disabled>立即檢查發放</button>
      </div>`;
    form.insertBefore(section, dateRange);

    const month = document.getElementById('fixedTicketScheduleMonth');
    for (let value = 1; value <= 12; value += 1) month.append(new Option(`${value} 月`, String(value)));
    month.value = '1';
    document.getElementById('fixedTicketExpiryDate').min = taipeiDate();

    type.addEventListener('change', () => {
      if (type.value !== 'fixed') {
        selectedFixedTicketId = '';
        selectedUpdatedAt = '';
      }
      updateFixedUI();
    });
    document.getElementById('fixedTicketScheduleType').addEventListener('change', updateFixedScheduleUI);
    document.getElementById('fixedTicketScheduleMonth').addEventListener('change', updateFixedScheduleUI);
    document.getElementById('fixedTicketScheduleDay').addEventListener('input', updateFixedScheduleUI);
    document.getElementById('fixedTicketScheduleWeekday').addEventListener('change', updateFixedScheduleUI);
    document.getElementById('fixedTicketExpiryMode').addEventListener('change', updateFixedExpiryUI);
    document.getElementById('fixedTicketExpiryDays').addEventListener('input', updateFixedExpiryUI);
    document.getElementById('fixedTicketExpiryDate').addEventListener('change', updateFixedExpiryUI);
    document.getElementById('fixedTicketNotifyLine').addEventListener('change', updateFixedNotificationUI);
    document.getElementById('fixedTicketNotifyTime').addEventListener('input', updateFixedNotificationUI);
    document.getElementById('fixedTicketNotifyTime').addEventListener('change', updateFixedNotificationUI);
    document.getElementById('fixedTicketRunButton').addEventListener('click', runFixedNow);

    form.addEventListener('submit', (event) => {
      if (type.value !== 'fixed') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      saveFixedTicket();
    }, true);

    const deleteButton = document.getElementById('deleteEventTicketButton');
    deleteButton?.addEventListener('click', (event) => {
      if (!selectedFixedTicketId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      deleteFixedTicket();
    }, true);

    document.getElementById('newEventTicketButton')?.addEventListener('click', () => window.setTimeout(resetFixedState, 0));
    document.getElementById('resetEventTicketButton')?.addEventListener('click', () => window.setTimeout(resetFixedState, 0));

    const list = document.getElementById('eventTicketListItems');
    list?.addEventListener('click', (event) => {
      const fixed = event.target instanceof Element ? event.target.closest('[data-fixed-ticket-id]') : null;
      if (fixed) {
        event.preventDefault();
        loadFixedTicket(String(fixed.dataset.fixedTicketId || ''));
        return;
      }
      const regular = event.target instanceof Element ? event.target.closest('[data-event-ticket-id]') : null;
      if (regular) {
        selectedFixedTicketId = '';
        selectedUpdatedAt = '';
        window.setTimeout(updateFixedUI, 0);
      }
    });

    window.addEventListener('member-admin-event-ticket-list-rendered', renderFixedList);

    updateFixedUI();
    if (document.documentElement.dataset.memberAdminReady === 'true') loadTemplates();
    else window.addEventListener('member-admin-ready', loadTemplates, { once: true });
    window.addEventListener('member-admin-data-refreshed', () => {
      if (document.documentElement.dataset.memberAdminReady === 'true' && !busy) loadTemplates();
    });
    window.addEventListener('test-data-purged', () => {
      templates = [];
      selectedFixedTicketId = '';
      selectedUpdatedAt = '';
      renderFixedList();
      if (document.documentElement.dataset.memberAdminReady === 'true' && !busy) loadTemplates();
    });
  });

  async function adminSession() {
    if (!window.MemberAdminSession || typeof window.MemberAdminSession.wait !== 'function') {
      throw new Error('管理端登入服務尚未準備完成。');
    }
    return window.MemberAdminSession.wait();
  }

  async function loadConfig() {
    if (config) return config;
    config = (await adminSession()).config;
    return config;
  }

  async function waitForAdminIdToken() {
    return String((await adminSession()).idToken || '');
  }

  async function request(action, payload = {}) {
    const currentConfig = await loadConfig();
    const idToken = await waitForAdminIdToken();
    const endpoint = `${String(currentConfig.supabaseUrl || '').replace(/\/$/, '')}/functions/v1/fixed-ticket-automation`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: String(currentConfig.supabasePublishableKey || '') },
      cache: 'no-store',
      body: JSON.stringify({ action, idToken, ...payload }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok !== true) throw new Error(String(data?.error?.message || '固定票券服務暫時無法完成操作。'));
    return data.data || {};
  }

  async function loadTemplates() {
    if (loadTemplatesPromise) return loadTemplatesPromise;
    loadTemplatesPromise = (async () => {
      try {
        const data = await request('admin.fixed-tickets.list');
        templates = Array.isArray(data.templates) ? data.templates : [];
        renderFixedList();
      } catch (error) {
        showMessage(error?.message || '固定票券設定載入失敗。');
      }
    })();
    try {
      await loadTemplatesPromise;
    } finally {
      loadTemplatesPromise = null;
    }
  }

  function renderFixedList() {
    const list = document.getElementById('eventTicketListItems');
    if (!list || renderingList) return;
    renderingList = true;
    try {
      list.querySelectorAll('[data-fixed-ticket-id]').forEach((node) => node.remove());
      list.querySelectorAll('[data-event-ticket-id^="FIXED-"]').forEach((node) => node.remove());

      const nodes = templates.map((template) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'card-list-item fixed-ticket-list-item';
        button.dataset.fixedTicketId = String(template.fixedTicketId || '');
        button.setAttribute('aria-selected', String(template.fixedTicketId || '') === selectedFixedTicketId ? 'true' : 'false');
        const title = document.createElement('strong');
        title.textContent = String(template.title || '未命名固定票券');
        const meta = document.createElement('small');
        meta.textContent = `固定票券 · ${scheduleLabel(template)} · ${expiryLabel(template)} · ${statusLabel(template.status)}`;
        button.append(title, meta);
        return button;
      });
      for (let index = nodes.length - 1; index >= 0; index -= 1) list.prepend(nodes[index]);

      const regularCount = list.querySelectorAll('[data-event-ticket-id]:not([data-event-ticket-id^="FIXED-"])').length;
      const total = regularCount + templates.length;
      const count = document.getElementById('eventTicketResultCount');
      if (count) count.textContent = String(total);
      document.getElementById('eventTicketEmptyState')?.classList.toggle('hidden', total !== 0);
    } finally {
      window.setTimeout(() => { renderingList = false; }, 0);
    }
  }

  function statusLabel(status) {
    return status === 'active' ? '啟用中' : status === 'archived' ? '已封存' : '草稿';
  }

  function scheduleLabel(template) {
    if (template.scheduleType === 'birthday_month') return '生日當月 1 號';
    if (template.scheduleType === 'yearly') return `每年 ${Number(template.scheduleMonth || 1)}/${Number(template.scheduleDay || 1)}`;
    if (template.scheduleType === 'monthly') return `每月 ${Number(template.scheduleDay || 1)} 日`;
    return `每週${WEEKDAYS[Number(template.scheduleWeekday || 1)]?.replace('星期', '') || '一'}`;
  }

  function expiryLabel(template) {
    const mode = String(template.expiryMode || 'month_end');
    if (mode === 'fixed_date' && template.expiryDate) return `期限 ${String(template.expiryDate).replaceAll('-', '/')}`;
    if (mode === 'week_end') return '當週到期';
    if (mode === 'days_after_issue') return `發放後 ${Number(template.expiryDays || 0)} 天`;
    return '當月月底到期';
  }

  function resetFixedState() {
    selectedFixedTicketId = '';
    selectedUpdatedAt = '';
    const type = document.getElementById('eventTicketType');
    if (type?.value === 'fixed') type.value = 'coupon';
    const expiryMode = document.getElementById('fixedTicketExpiryMode');
    const expiryDate = document.getElementById('fixedTicketExpiryDate');
    const expiryDays = document.getElementById('fixedTicketExpiryDays');
    if (expiryMode) expiryMode.value = 'month_end';
    if (expiryDate) expiryDate.value = '';
    if (expiryDays) expiryDays.value = '7';
    document.getElementById('fixedTicketNotifyLine').checked = true;
    document.getElementById('fixedTicketNotifyTime').value = '';
    updateFixedUI();
    renderFixedList();
  }

  function loadFixedTicket(fixedTicketId) {
    const template = templates.find((item) => String(item.fixedTicketId || '') === fixedTicketId);
    if (!template) return;
    selectedFixedTicketId = fixedTicketId;
    selectedUpdatedAt = String(template.updatedAt || '');

    document.getElementById('eventTicketId').value = '';
    document.getElementById('eventTicketExpectedUpdatedAt').value = selectedUpdatedAt;
    document.getElementById('eventTicketTitle').value = String(template.title || '');
    document.getElementById('eventTicketType').value = 'fixed';
    document.getElementById('eventTicketStatus').value = String(template.status || 'draft');
    document.getElementById('eventTicketDescription').value = String(template.description || '');
    document.getElementById('eventTicketUsageMethod').value = String(template.usageMethod || '');
    document.getElementById('eventTicketUsageInstructions').value = String(template.usageInstructions || '');
    document.getElementById('eventTicketStartsOn').value = '';
    document.getElementById('eventTicketEndsOn').value = '';
    document.getElementById('eventTicketQuota').value = String(Number(template.quota || 0));
    document.getElementById('eventTicketRequiresLocation').checked = Boolean(template.requiresLocation);
    window.TicketLocationEditors?.event?.set(Array.isArray(template.redemptionLocations) ? template.redemptionLocations : []);
    document.getElementById('eventTicketAccent').value = /^#[0-9a-f]{6}$/i.test(String(template.accent || '')) ? template.accent : '#df6b4d';
    document.getElementById('eventTicketAccentValue').textContent = String(document.getElementById('eventTicketAccent').value || '#df6b4d').toUpperCase();
    document.querySelectorAll('#eventTicketAllowedTiers input[name="eventTicketAllowedTierKey"]').forEach((input) => {
      input.checked = (Array.isArray(template.allowedTierKeys) ? template.allowedTierKeys : TIER_KEYS).includes(input.value);
    });
    document.getElementById('eventTicketAllowedTiers')?.dispatchEvent(new Event('change', { bubbles: true }));

    document.getElementById('fixedTicketScheduleType').value = String(template.scheduleType || 'birthday_month');
    document.getElementById('fixedTicketScheduleMonth').value = String(Number(template.scheduleMonth || 1));
    document.getElementById('fixedTicketScheduleDay').value = String(Number(template.scheduleDay || 1));
    document.getElementById('fixedTicketScheduleWeekday').value = String(Number(template.scheduleWeekday || 1));
    const expiryMode = EXPIRY_MODES.includes(String(template.expiryMode || '')) ? String(template.expiryMode) : 'month_end';
    document.getElementById('fixedTicketExpiryMode').value = expiryMode;
    document.getElementById('fixedTicketExpiryDate').value = String(template.expiryDate || '');
    document.getElementById('fixedTicketExpiryDays').value = String(Number(template.expiryDays || 7));
    document.getElementById('fixedTicketNotifyLine').checked = Boolean(template.notifyLine);
    document.getElementById('fixedTicketNotifyTime').value = String(template.notifyTime || '');

    document.getElementById('eventTicketEditorKicker').textContent = 'Edit fixed ticket';
    document.getElementById('eventTicketEditorTitle').textContent = String(template.title || '編輯固定票券');
    document.getElementById('deleteEventTicketButton').disabled = false;
    document.getElementById('deleteEventTicketButton').classList.remove('hidden');
    updateFixedUI();
    renderFixedList();
    hideMessage();
  }

  window.FixedTicketAdmin={selected:()=>templates.find(item=>item.fixedTicketId===selectedFixedTicketId)||null,loadCopy:async(id)=>{await loadTemplates();if(!templates.some(item=>item.fixedTicketId===id))throw new Error('複本已建立，但重新載入失敗；請重試同一操作。');loadFixedTicket(id);const input=document.getElementById('fixedTicketCalendarEnabled');if(input){input.checked=false;input.dispatchEvent(new Event('change',{bubbles:true}));}}};

  function updateFixedUI() {
    const fixed = document.getElementById('eventTicketType')?.value === 'fixed';
    const section = document.getElementById('fixedTicketScheduleFields');
    section?.classList.toggle('hidden', !fixed);
    document.querySelector('#eventTicketForm .date-range-control')?.classList.toggle('hidden', fixed);
    if (fixed) {
      document.getElementById('eventTicketStartsOn').value = '';
      document.getElementById('eventTicketEndsOn').value = '';
      document.getElementById('eventTicketPrizeEditor')?.classList.add('hidden');
    }

    const save = document.getElementById('saveEventTicketButton');
    if (save && !busy) save.textContent = fixed ? '儲存固定票券' : '儲存活動票券';
    const del = document.getElementById('deleteEventTicketButton');
    if (del && selectedFixedTicketId) {
      del.disabled = false;
      del.classList.remove('hidden');
      del.textContent = '刪除目前固定票券';
    } else if (del && fixed) {
      del.disabled = true;
      del.classList.add('hidden');
      del.textContent = '刪除目前固定票券';
    } else if (del && !fixed) {
      del.textContent = '刪除目前票券';
    }

    const note = document.querySelector('.event-ticket-note');
    if (note) note.textContent = fixed
      ? '固定票券由系統依週期自動發放；同一會員在同一週期只會取得一張，使用期限依固定票券設定。'
      : '已領取的會員會保留當下的票券說明；之後修改設定只影響新領取的票券。';

    document.getElementById('fixedTicketRunButton').disabled = busy || !selectedFixedTicketId;
    window.TicketLocationEditors?.event?.refresh();
    updateFixedScheduleUI();
    updateFixedExpiryUI();
    updateFixedNotificationUI();
  }

  function updateFixedNotificationUI() {
    const enabled = document.getElementById('fixedTicketNotifyLine')?.checked;
    const time = String(document.getElementById('fixedTicketNotifyTime')?.value || '');
    const summary = document.getElementById('fixedTicketNotifySummary');
    if (summary) summary.textContent = !enabled
      ? '儲存後停用通知，票券仍會依週期發放。設定的時間會保留。'
      : time ? `儲存後於發放日 ${time}（台北時間）通知；票券須先完成發放。`
        : '儲存後於票券發放完成時通知。';
    document.getElementById('fixedTicketScheduleFields')?.classList.toggle('fixed-ticket-notifications-off', !enabled);
  }

  function updateFixedScheduleUI() {
    const type = String(document.getElementById('fixedTicketScheduleType')?.value || 'birthday_month');
    document.getElementById('fixedTicketYearlyMonthField')?.classList.toggle('hidden', type !== 'yearly');
    document.getElementById('fixedTicketScheduleDayField')?.classList.toggle('hidden', !['yearly', 'monthly'].includes(type));
    document.getElementById('fixedTicketWeekdayField')?.classList.toggle('hidden', type !== 'weekly');

    const month = Number(document.getElementById('fixedTicketScheduleMonth')?.value || 1);
    const day = Number(document.getElementById('fixedTicketScheduleDay')?.value || 1);
    const weekday = Number(document.getElementById('fixedTicketScheduleWeekday')?.value || 1);
    const summary = document.getElementById('fixedTicketScheduleSummary');
    if (!summary) return;

    if (type === 'birthday_month') {
      summary.textContent = '每年在會員生日月份的 1 號自動發放；若會員在生日月 1 號後才新加入，只要本年度尚未取得這張票券就會補發。';
    } else if (type === 'yearly') {
      summary.textContent = `每年 ${month}/${day} 進入新週期並自動發放；若該月沒有 ${day} 日，會以當月最後一天計算。`;
    } else if (type === 'monthly') {
      summary.textContent = `每月 ${day} 日進入新週期並自動發放；若當月沒有 ${day} 日，會以當月最後一天計算。`;
    } else {
      summary.textContent = `每週${WEEKDAYS[weekday] || '星期一'}進入新週期並自動發放。`;
    }
  }

  function updateFixedExpiryUI() {
    const mode = String(document.getElementById('fixedTicketExpiryMode')?.value || 'month_end');
    const dateField = document.getElementById('fixedTicketExpiryDateField');
    const dateInput = document.getElementById('fixedTicketExpiryDate');
    const daysField = document.getElementById('fixedTicketExpiryDaysField');
    const daysInput = document.getElementById('fixedTicketExpiryDays');
    const summary = document.getElementById('fixedTicketExpirySummary');
    dateField?.classList.toggle('hidden', mode !== 'fixed_date');
    daysField?.classList.toggle('hidden', mode !== 'days_after_issue');
    if (!summary) return;
    if (mode === 'fixed_date') {
      const date = String(dateInput?.value || '');
      summary.textContent = date
        ? `票券可使用至 ${date.replaceAll('-', '/')}；到期後停止發放新的固定票券。`
        : '請選擇指定到期日；到期後系統會停止發放新的固定票券。';
    } else if (mode === 'week_end') {
      summary.textContent = '每次發放後可使用至發放當週的星期日。';
    } else if (mode === 'days_after_issue') {
      const days = Number(daysInput?.value || 0);
      summary.textContent = Number.isInteger(days) && days >= 1
        ? `自實際發放日起算，可使用 ${days} 天（含發放當日）。`
        : '請輸入發放後可使用天數。';
    } else {
      summary.textContent = '每次發放的票券可使用至該次發放月份的最後一天。';
    }
  }

  function collectTemplate() {
    const scheduleType = String(document.getElementById('fixedTicketScheduleType').value || 'birthday_month');
    const expiryMode = String(document.getElementById('fixedTicketExpiryMode').value || 'month_end');
    return {
      fixedTicketId: selectedFixedTicketId,
      title: String(document.getElementById('eventTicketTitle').value || '').trim(),
      description: String(document.getElementById('eventTicketDescription').value || '').trim(),
      usageMethod: String(document.getElementById('eventTicketUsageMethod').value || '').trim(),
      usageInstructions: String(document.getElementById('eventTicketUsageInstructions').value || '').trim(),
      status: String(document.getElementById('eventTicketStatus').value || ''),
      scheduleType,
      scheduleMonth: scheduleType === 'yearly' ? Number(document.getElementById('fixedTicketScheduleMonth').value) : null,
      scheduleDay: ['yearly', 'monthly'].includes(scheduleType) ? Number(document.getElementById('fixedTicketScheduleDay').value) : null,
      scheduleWeekday: scheduleType === 'weekly' ? Number(document.getElementById('fixedTicketScheduleWeekday').value) : null,
      expiryMode,
      expiryDate: expiryMode === 'fixed_date' ? String(document.getElementById('fixedTicketExpiryDate').value || '') : null,
      expiryDays: expiryMode === 'days_after_issue' ? Number(document.getElementById('fixedTicketExpiryDays').value) : null,
      quota: Number(document.getElementById('eventTicketQuota').value || 0),
      accent: String(document.getElementById('eventTicketAccent').value || '#df6b4d'),
      allowedTierKeys: Array.from(document.querySelectorAll('#eventTicketAllowedTiers input[name="eventTicketAllowedTierKey"]:checked')).map((input) => input.value),
      requiresLocation: document.getElementById('eventTicketRequiresLocation').checked,
      redemptionLocations: window.TicketLocationEditors?.event?.get() || [],
      notifyLine: document.getElementById('fixedTicketNotifyLine').checked,
      notifyTime: document.getElementById('fixedTicketNotifyTime').value || null,
    };
  }

  function validateTemplate(template) {
    if (!template.title || template.title.length > 100) return '請填寫固定票券名稱（最多 100 字）。';
    if (!template.description || template.description.length > 240) return '請填寫票券說明（最多 240 字）。';
    if (!template.usageMethod || template.usageMethod.length > 120) return '請填寫使用方式（最多 120 字）。';
    if (!template.usageInstructions || template.usageInstructions.length > 500) return '請填寫使用說明（最多 500 字）。';
    if (!['active', 'draft', 'archived'].includes(template.status)) return '請選擇公開狀態。';
    if (!template.allowedTierKeys.length) return '請至少選擇一個適用會員等級。';
    if (!Number.isInteger(template.quota) || template.quota < 0 || template.quota > 1000000) return '總發放上限必須是 0–1,000,000 的整數。';
    if (template.requiresLocation && (!template.redemptionLocations.length || template.redemptionLocations.length > 20 || template.redemptionLocations.some((location) => !location.name?.trim() || location.name.length > 100 || !Number.isFinite(Number(location.latitude)) || Math.abs(Number(location.latitude)) > 90 || !Number.isFinite(Number(location.longitude)) || Math.abs(Number(location.longitude)) > 180 || !Number.isInteger(Number(location.radiusMeters)) || Number(location.radiusMeters) < 50 || Number(location.radiusMeters) > 2000))) return '請設定 1–20 個有效地點（名稱、座標、50–2000 公尺半徑）。';
    if (template.scheduleType === 'yearly' && (!Number.isInteger(template.scheduleMonth) || template.scheduleMonth < 1 || template.scheduleMonth > 12)) return '請選擇每年發放月份。';
    if (['yearly', 'monthly'].includes(template.scheduleType) && (!Number.isInteger(template.scheduleDay) || template.scheduleDay < 1 || template.scheduleDay > 31)) return '發放日期必須是 1–31。';
    if (template.scheduleType === 'weekly' && (!Number.isInteger(template.scheduleWeekday) || template.scheduleWeekday < 1 || template.scheduleWeekday > 7)) return '請選擇每週發放日。';
    if (!EXPIRY_MODES.includes(template.expiryMode)) return '請選擇固定票券使用期限。';
    if (template.expiryMode === 'fixed_date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(template.expiryDate || ''))) return '請選擇指定到期日。';
      if (String(template.expiryDate) < taipeiDate()) return '指定到期日不可早於今天。';
    }
    if (template.expiryMode === 'days_after_issue' && (!Number.isInteger(template.expiryDays) || template.expiryDays < 1 || template.expiryDays > 3650)) {
      return '發放後使用天數必須是 1–3650 的整數。';
    }
    return '';
  }

  async function saveFixedTicket() {
    if (busy) return;
    const template = collectTemplate();
    const error = validateTemplate(template);
    if (error) return showMessage(error);
    setBusy(true);
    hideMessage();
    try {
      const data = await request('admin.fixed-tickets.save', { template, expectedUpdatedAt: selectedUpdatedAt });
      templates = Array.isArray(data.templates) ? data.templates : templates;
      const saved = data.template || template;
      selectedFixedTicketId = String(saved.fixedTicketId || selectedFixedTicketId);
      selectedUpdatedAt = String(saved.updatedAt || '');
      renderFixedList();
      loadFixedTicket(selectedFixedTicketId);
      const run = data.run || {};
      const issued = Number(run.issued || 0);
      showMessage(issued ? `固定票券已儲存，本次自動發放 ${issued} 張。` : '固定票券已儲存。', true);
    } catch (error) {
      showMessage(error?.message || '固定票券儲存失敗。');
    } finally {
      setBusy(false);
    }
  }

  async function runFixedNow() {
    if (busy || !selectedFixedTicketId) return;
    setBusy(true);
    hideMessage();
    try {
      const data = await request('admin.fixed-tickets.run', { fixedTicketId: selectedFixedTicketId });
      templates = Array.isArray(data.templates) ? data.templates : templates;
      renderFixedList();
      const run = data.run || {};
      showMessage(`檢查完成：新增 ${Number(run.issued || 0)} 張固定票券，排入 ${Number(run.queued || 0)} 則 LINE 通知。`, true);
    } catch (error) {
      showMessage(error?.message || '固定票券發放檢查失敗。');
    } finally {
      setBusy(false);
    }
  }

  async function deleteFixedTicket() {
    if (busy || !selectedFixedTicketId) return;
    const template = templates.find((item) => String(item.fixedTicketId || '') === selectedFixedTicketId);
    if (!window.confirm(`確定要刪除「${String(template?.title || '這張固定票券')}」嗎？尚未使用的會員票券會立即失效；已使用紀錄會保留。`)) return;
    setBusy(true);
    hideMessage();
    try {
      const data = await request('admin.fixed-tickets.delete', { fixedTicketId: selectedFixedTicketId, expectedUpdatedAt: selectedUpdatedAt });
      templates = Array.isArray(data.templates) ? data.templates : templates.filter((item) => String(item.fixedTicketId || '') !== selectedFixedTicketId);
      selectedFixedTicketId = '';
      selectedUpdatedAt = '';
      document.getElementById('resetEventTicketButton')?.click();
      renderFixedList();
      showMessage('固定票券已刪除；未使用的會員票券已立即失效，會員端會自動同步。已使用紀錄仍保留。', true);
    } catch (error) {
      showMessage(error?.message || '固定票券刪除失敗。');
    } finally {
      setBusy(false);
    }
  }

  function setBusy(value) {
    const wasBusy = busy;
    busy = value;
    const save = document.getElementById('saveEventTicketButton');
    if (save && (document.getElementById('eventTicketType')?.value === 'fixed' || (!value && wasBusy))) {
      // Deletion resets the editor to coupon before this request settles.
      // Release the save button owned by the completed fixed-ticket request.
      save.disabled = value;
      save.textContent = value ? '儲存中…' : document.getElementById('eventTicketType')?.value === 'fixed' ? '儲存固定票券' : '儲存活動票券';
    }
    const run = document.getElementById('fixedTicketRunButton');
    if (run) run.disabled = value || !selectedFixedTicketId;
  }

  function showMessage(message, success = false) {
    const element = document.getElementById('eventTicketFormMessage');
    if (!element) return;
    element.textContent = String(message || '');
    element.classList.remove('hidden');
    element.classList.toggle('success', success);
  }

  function hideMessage() {
    const element = document.getElementById('eventTicketFormMessage');
    if (!element) return;
    element.textContent = '';
    element.classList.add('hidden');
    element.classList.remove('success');
  }
})();
