(() => {
  'use strict';

  const state = { config: null, idToken: '', updatedAt: '', savedLimit: null, saving: false, loading: null };

  function endpoint() {
    const base = String(state.config && state.config.supabaseUrl || '').replace(/\/$/, '');
    return `${base}/functions/v1/event-ticket-extension-api`;
  }

  function normalizeLimit(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 50 ? parsed : 1;
  }

  function validLimit(value) {
    if (String(value).trim() === '') return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 50 ? parsed : null;
  }

  async function request(operation, payload = {}) {
    if (!state.config || !state.idToken) throw new Error('尚未取得管理端登入資訊。');
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: String(state.config.supabasePublishableKey || '') },
      cache: 'no-store',
      body: JSON.stringify({ ...payload, operation, idToken: state.idToken })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      const error = new Error(result && result.error && result.error.message || '活動票券設定暫時無法完成。');
      error.code = result && result.error && result.error.code || 'API_ERROR';
      throw error;
    }
    return result.data || {};
  }

  function limitText(value) {
    return value === 0 ? '不限張數' : `${value} 張／日`;
  }

  function ensurePanel() {
    let panel = document.getElementById('eventTicketGlobalUsageSettings');
    if (panel) return panel;
    const eventsPanel = document.getElementById('eventsPanel');
    const workspace = eventsPanel && eventsPanel.querySelector('.card-workspace');
    if (!eventsPanel || !workspace) return null;

    panel = document.createElement('section');
    panel.id = 'eventTicketGlobalUsageSettings';
    panel.className = 'tier-settings usage-policy-card event-ticket-global-settings';
    panel.setAttribute('aria-labelledby', 'eventTicketGlobalUsageSettingsTitle');
    panel.innerHTML = `
      <header class="usage-policy-heading">
        <div><p class="kicker">Event ticket policy</p><h3 id="eventTicketGlobalUsageSettingsTitle">活動票券使用設定</h3><p>所有活動票券共用這項設定，每日用量依 Asia/Taipei 日期計算。</p></div>
        <div class="usage-policy-current"><span>目前生效</span><strong id="eventTicketCurrentLimit">載入中…</strong></div>
      </header>
      <div class="usage-policy-body">
        <div class="usage-policy-control">
          <label for="eventMaxTicketsPerDay">每日最多使用活動票券數</label>
          <div class="usage-policy-number"><input id="eventMaxTicketsPerDay" type="number" min="0" max="50" step="1" inputmode="numeric" value="1" required aria-describedby="eventMaxTicketsPerDayHint" disabled><span>張／日</span></div>
          <small id="eventMaxTicketsPerDayHint">0 代表不限張數；1–50 代表每位會員一天內可使用的總票券數。</small>
          <div class="usage-policy-presets" role="group" aria-label="快速設定活動票券每日張數">
            <button type="button" data-policy-limit="0">不限張數</button><button type="button" data-policy-limit="1">1 張</button><button type="button" data-policy-limit="3">3 張</button><button type="button" data-policy-limit="5">5 張</button><button type="button" data-policy-limit="10">10 張</button>
          </div>
        </div>
        <div class="usage-policy-preview" aria-live="polite"><span>設定預覽</span><strong id="eventTicketPreview">正在讀取設定…</strong><p id="eventTicketPreviewHint">僅影響每日活動票券用量，仍遵守票券領取數、會員階級與活動期間限制。</p></div>
      </div>
      <div id="eventTicketSettingMessage" class="form-message hidden" role="status" aria-live="polite"></div>
      <footer class="usage-policy-footer"><span id="eventTicketChangeStatus">設定載入中</span><button id="saveEventTicketSettingButton" class="button button-dark" type="button" disabled>儲存活動票券使用設定</button></footer>
    `;
    eventsPanel.insertBefore(panel, workspace);
    const input = panel.querySelector('#eventMaxTicketsPerDay');
    input.addEventListener('input', render);
    input.addEventListener('change', render);
    panel.querySelectorAll('[data-policy-limit]').forEach((button) => {
      button.addEventListener('click', () => {
        if (state.savedLimit === null || state.saving) return;
        input.value = button.dataset.policyLimit;
        render();
      });
    });
    panel.querySelector('#saveEventTicketSettingButton').addEventListener('click', saveSetting);
    render();
    return panel;
  }

  function showMessage(message, error = false) {
    const box = document.getElementById('eventTicketSettingMessage');
    if (!box) return;
    box.textContent = message;
    box.classList.toggle('hidden', !message);
    box.classList.toggle('is-error', Boolean(error));
  }

  function render() {
    const panel = document.getElementById('eventTicketGlobalUsageSettings');
    if (!panel) return;
    const input = panel.querySelector('#eventMaxTicketsPerDay');
    const value = validLimit(input.value);
    const loaded = state.savedLimit !== null;
    const dirty = loaded && value !== state.savedLimit;
    const status = panel.querySelector('#eventTicketChangeStatus');
    const preview = panel.querySelector('#eventTicketPreview');
    panel.querySelector('#eventTicketCurrentLimit').textContent = loaded ? limitText(state.savedLimit) : '載入中…';
    preview.textContent = value === null ? '請輸入 0–50 的整數' : `每日最多可使用 ${limitText(value)}`;
    status.textContent = !loaded ? '設定載入中' : value === null ? '輸入值不正確' : dirty ? '有尚未儲存的變更' : '已與目前設定同步';
    panel.querySelector('#eventTicketPreviewHint').textContent = value === 0
      ? '不限張數只取消每日上限；仍須符合活動期間、會員資格與持有票券限制。'
      : '依台灣當日累計使用張數；不會變更票券效期、持有數及會員核銷資格。';
    input.disabled = !loaded || state.saving;
    input.setAttribute('aria-invalid', String(loaded && value === null));
    panel.querySelector('#saveEventTicketSettingButton').disabled = !loaded || state.saving || !dirty || value === null;
    panel.dataset.dirty = String(dirty);
    panel.querySelectorAll('[data-policy-limit]').forEach((button) => {
      const active = Number(button.dataset.policyLimit) === value;
      button.setAttribute('aria-pressed', String(active));
      button.disabled = !loaded || state.saving;
    });
  }

  async function saveSetting() {
    if (state.saving || state.savedLimit === null) return;
    const input = document.getElementById('eventMaxTicketsPerDay');
    const button = document.getElementById('saveEventTicketSettingButton');
    if (!input || !button) return;
    const maxTicketsPerDay = validLimit(input.value);
    if (maxTicketsPerDay === null) { showMessage('請輸入 0–50 的整數。', true); render(); return; }
    state.saving = true;
    button.textContent = '儲存中…';
    showMessage('');
    render();
    try {
      const result = await request('admin.settings.save', {
        maxTicketsPerDay,
        expectedUpdatedAt: state.updatedAt || ''
      });
      state.updatedAt = String(result.updatedAt || '');
      state.savedLimit = normalizeLimit(result.maxTicketsPerDay);
      input.value = String(state.savedLimit);
      showMessage(state.savedLimit === 0 ? '已儲存：活動票券每日使用張數不限。' : `已儲存：會員每日最多可使用 ${state.savedLimit} 張活動票券。`);
    } catch (error) {
      showMessage(error && error.message || '儲存失敗，請重新載入後再試。', true);
    } finally {
      state.saving = false;
      button.textContent = '儲存活動票券使用設定';
      render();
    }
  }

  async function waitForLogin() {
    if (!window.MemberAdminSession || typeof window.MemberAdminSession.wait !== 'function') throw new Error('管理端登入服務尚未準備完成。');
    const session = await window.MemberAdminSession.wait();
    state.config = session.config;
    state.idToken = session.idToken;
  }

  async function loadSetting() {
    if (state.loading) return state.loading;
    state.loading = (async () => {
      const result = await request('admin.settings.get');
      state.updatedAt = String(result.updatedAt || '');
      state.savedLimit = normalizeLimit(result.maxTicketsPerDay);
      const input = document.getElementById('eventMaxTicketsPerDay');
      if (input) input.value = String(state.savedLimit);
      showMessage('');
      render();
    })();
    try { await state.loading; } finally { state.loading = null; }
  }

  async function boot() {
    ensurePanel();
    try {
      await waitForLogin();
      await loadSetting();
      window.addEventListener('member-admin-data-refreshed', () => {
        const panel = document.getElementById('eventTicketGlobalUsageSettings');
        if (!state.saving && panel && panel.dataset.dirty !== 'true') {
          loadSetting().catch((error) => showMessage(error && error.message || '無法同步票券使用設定。', true));
        }
      });
    } catch (error) {
      showMessage(error && error.message || '無法載入票券使用設定。', true);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
