(() => {
  'use strict';

  const state = { config: null, idToken: '', updatedAt: '', savedLimit: null, saving: false, loading: null };

  function extensionUrl() {
    const base = String(state.config && state.config.supabaseUrl || '').replace(/\/$/, '');
    return `${base}/functions/v1/pointcard-extension-api`;
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

  async function extensionRequest(operation, payload = {}) {
    if (!state.config || !state.idToken) throw new Error('尚未取得管理端登入資訊。');
    const response = await fetch(extensionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: String(state.config.supabasePublishableKey || '') },
      cache: 'no-store',
      body: JSON.stringify({ ...payload, operation, idToken: state.idToken })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      const error = new Error(result && result.error && result.error.message || '集點卡設定暫時無法完成。');
      error.code = result && result.error && result.error.code || 'API_ERROR';
      throw error;
    }
    return result.data || {};
  }

  function limitText(value) {
    return value === 0 ? '不限張數' : `${value} 張／次`;
  }

  function ensurePanel() {
    let panel = document.getElementById('pointCardGlobalTicketSettings');
    if (panel) return panel;
    const settingsPanel = document.getElementById('cardSettingsPanel');
    const workspace = settingsPanel && settingsPanel.querySelector('.card-workspace');
    if (!settingsPanel || !workspace) return null;

    panel = document.createElement('section');
    panel.id = 'pointCardGlobalTicketSettings';
    panel.className = 'tier-settings usage-policy-card point-card-global-settings';
    panel.setAttribute('aria-labelledby', 'pointCardGlobalTicketSettingsTitle');
    panel.innerHTML = `
      <header class="usage-policy-heading">
        <div><p class="kicker">Point ticket policy</p><h3 id="pointCardGlobalTicketSettingsTitle">集點卡票券使用設定</h3><p>所有集點卡共用這項設定，跨集點卡選取的票券會合併計算單次張數。</p></div>
        <div class="usage-policy-current"><span>目前生效</span><strong id="globalTicketCurrentLimit">載入中…</strong></div>
      </header>
      <div class="usage-policy-body">
        <div class="usage-policy-control">
          <label for="globalMaxTicketsPerRedemption">單次最多使用票券數</label>
          <div class="usage-policy-number"><input id="globalMaxTicketsPerRedemption" type="number" min="0" max="50" step="1" inputmode="numeric" value="1" required aria-describedby="globalMaxTicketsPerRedemptionHint" disabled><span>張／次</span></div>
          <small id="globalMaxTicketsPerRedemptionHint">0 代表不限張數；1–50 代表會員每次核銷可使用的總票券數。</small>
          <div class="usage-policy-presets" role="group" aria-label="快速設定集點卡票券張數">
            <button type="button" data-policy-limit="0">不限張數</button><button type="button" data-policy-limit="1">1 張</button><button type="button" data-policy-limit="3">3 張</button><button type="button" data-policy-limit="5">5 張</button><button type="button" data-policy-limit="10">10 張</button>
          </div>
        </div>
        <div class="usage-policy-preview" aria-live="polite"><span>設定預覽</span><strong id="globalTicketPreview">正在讀取設定…</strong><p id="globalTicketPreviewHint">僅影響單次核銷張數，不變更各集點卡的集點與兌換條件。</p></div>
      </div>
      <div id="globalTicketSettingMessage" class="form-message hidden" role="status" aria-live="polite"></div>
      <footer class="usage-policy-footer"><span id="globalTicketChangeStatus">設定載入中</span><button id="saveGlobalTicketSettingButton" class="button button-dark" type="button" disabled>儲存票券使用設定</button></footer>
    `;
    settingsPanel.insertBefore(panel, workspace);
    const input = panel.querySelector('#globalMaxTicketsPerRedemption');
    input.addEventListener('input', render);
    input.addEventListener('change', render);
    panel.querySelectorAll('[data-policy-limit]').forEach((button) => {
      button.addEventListener('click', () => {
        if (state.savedLimit === null || state.saving) return;
        input.value = button.dataset.policyLimit;
        render();
      });
    });
    panel.querySelector('#saveGlobalTicketSettingButton').addEventListener('click', saveSetting);
    render();
    return panel;
  }

  function showMessage(message, error = false) {
    const box = document.getElementById('globalTicketSettingMessage');
    if (!box) return;
    box.textContent = message;
    box.classList.toggle('hidden', !message);
    box.classList.toggle('is-error', Boolean(error));
  }

  function render() {
    const panel = document.getElementById('pointCardGlobalTicketSettings');
    if (!panel) return;
    const input = panel.querySelector('#globalMaxTicketsPerRedemption');
    const value = validLimit(input.value);
    const loaded = state.savedLimit !== null;
    const dirty = loaded && value !== state.savedLimit;
    const status = panel.querySelector('#globalTicketChangeStatus');
    const preview = panel.querySelector('#globalTicketPreview');
    panel.querySelector('#globalTicketCurrentLimit').textContent = loaded ? limitText(state.savedLimit) : '載入中…';
    preview.textContent = value === null ? '請輸入 0–50 的整數' : `單次最多可使用 ${limitText(value)}`;
    status.textContent = !loaded ? '設定載入中' : value === null ? '輸入值不正確' : dirty ? '有尚未儲存的變更' : '已與目前設定同步';
    panel.querySelector('#globalTicketPreviewHint').textContent = value === 0
      ? '不限張數只取消單次上限；仍須符合點數、票券效期及其他使用限制。'
      : '跨集點卡合併計數；不會改變票券效期、點數與核銷資格。';
    input.disabled = !loaded || state.saving;
    input.setAttribute('aria-invalid', String(loaded && value === null));
    panel.querySelector('#saveGlobalTicketSettingButton').disabled = !loaded || state.saving || !dirty || value === null;
    panel.dataset.dirty = String(dirty);
    panel.querySelectorAll('[data-policy-limit]').forEach((button) => {
      const active = Number(button.dataset.policyLimit) === value;
      button.setAttribute('aria-pressed', String(active));
      button.disabled = !loaded || state.saving;
    });
  }

  async function saveSetting() {
    if (state.saving || state.savedLimit === null) return;
    const input = document.getElementById('globalMaxTicketsPerRedemption');
    const button = document.getElementById('saveGlobalTicketSettingButton');
    if (!input || !button) return;
    const maxTicketsPerRedemption = validLimit(input.value);
    if (maxTicketsPerRedemption === null) { showMessage('請輸入 0–50 的整數。', true); render(); return; }
    state.saving = true;
    button.textContent = '儲存中…';
    showMessage('');
    render();
    try {
      const result = await extensionRequest('admin.settings.save', {
        maxTicketsPerRedemption,
        expectedUpdatedAt: state.updatedAt || ''
      });
      state.updatedAt = String(result.updatedAt || '');
      state.savedLimit = normalizeLimit(result.maxTicketsPerRedemption);
      input.value = String(state.savedLimit);
      showMessage(state.savedLimit === 0 ? '已儲存：集點卡票券單次使用張數不限。' : `已儲存：會員單次最多可使用 ${state.savedLimit} 張集點卡票券。`);
    } catch (error) {
      showMessage(error && error.message || '儲存失敗，請重新載入後再試。', true);
    } finally {
      state.saving = false;
      button.textContent = '儲存票券使用設定';
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
      const result = await extensionRequest('admin.settings.get');
      state.updatedAt = String(result.updatedAt || '');
      state.savedLimit = normalizeLimit(result.maxTicketsPerRedemption);
      const input = document.getElementById('globalMaxTicketsPerRedemption');
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
        const panel = document.getElementById('pointCardGlobalTicketSettings');
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
