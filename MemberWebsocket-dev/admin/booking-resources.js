(() => {
  'use strict';

  const state = {
    config: null,
    idToken: '',
    data: null,
    loading: false,
    savingSettings: false,
    savingTechnician: false,
    technicianTab: 'active',
    restoringTechnicianId: '',
    disablingTechnicianId: '',
    initialized: false,
  };

  const ids = {
    section: 'bookingAdminResourceSettings',
    message: 'bookingAdminResourceMessage',
    settingsForm: 'bookingAdminPartySizeForm',
    maxPartySize: 'bookingAdminMaxPartySize',
    primaryTechnician: 'bookingAdminPrimaryTechnician',
    requirePrimaryTechnician: 'bookingAdminRequirePrimaryTechnician',
    settingsSave: 'bookingAdminSavePartySizeButton',
    technicianForm: 'bookingAdminTechnicianForm',
    technicianId: 'bookingAdminTechnicianId',
    technicianExpectedUpdatedAt: 'bookingAdminTechnicianExpectedUpdatedAt',
    technicianName: 'bookingAdminTechnicianName',
    technicianSortOrder: 'bookingAdminTechnicianSortOrder',
    technicianActive: 'bookingAdminTechnicianActive',
    technicianTitle: 'bookingAdminTechnicianFormTitle',
    technicianSave: 'bookingAdminSaveTechnicianButton',
    technicianNew: 'bookingAdminNewTechnicianButton',
    technicianList: 'bookingAdminTechnicianList',
    technicianEmpty: 'bookingAdminTechnicianEmpty',
    technicianEmptyText: 'bookingAdminTechnicianEmptyText',
    technicianActiveTab: 'bookingAdminTechnicianActiveTab',
    technicianDisabledTab: 'bookingAdminTechnicianDisabledTab',
    technicianActiveCount: 'bookingAdminTechnicianActiveCount',
    technicianDisabledCount: 'bookingAdminTechnicianDisabledCount',
    technicianModal: 'bookingAdminTechnicianModal',
    technicianModalClose: 'bookingAdminTechnicianModalClose',
    technicianModalCancel: 'bookingAdminTechnicianModalCancel',
    technicianModalMessage: 'bookingAdminTechnicianModalMessage',
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  function init() {
    if (startWhenReady()) return;

    const observer = new MutationObserver(() => {
      if (startWhenReady()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(() => observer.disconnect(), 30000);
  }

  function startWhenReady() {
    if (state.initialized) return true;
    if (!mount()) return false;

    state.initialized = true;
    bind();
    observeBookingPanel();
    boot();
    return true;
  }

  function mount() {
    if (document.getElementById(ids.section)) return true;
    const host = document.getElementById('bookingAdminTechnicianMount');
    if (!host) return false;

    const section = document.createElement('section');
    section.id = ids.section;
    section.className = 'booking-admin-resource-settings';
    section.setAttribute('aria-labelledby', 'bookingAdminResourceSettingsTitle');
    section.innerHTML = `
      <div class="booking-admin-section-heading booking-admin-resource-heading">
        <div>
          <p class="kicker">Capacity & technicians</p>
          <h3 id="bookingAdminResourceSettingsTitle">技師設定</h3>
          <p>管理預約成立條件、每筆人數上限與公開技師。</p>
        </div>
        <button id="bookingAdminResourceRefreshButton" class="button button-outline" type="button">更新設定</button>
      </div>

      <div class="booking-admin-resource-grid booking-admin-resource-grid-single">
        <form id="${ids.settingsForm}" class="booking-admin-resource-box booking-admin-policy-form" novalidate>
          <div class="booking-admin-policy-heading">
            <strong>預約成立條件</strong>
            <small>先決定是否限制主要技師，再設定人數與回饋對象。</small>
          </div>
          <label class="booking-admin-resource-toggle booking-admin-policy-toggle">
            <input id="${ids.requirePrimaryTechnician}" type="checkbox" aria-describedby="bookingAdminPrimaryRequirementHint" checked>
            <span><strong>必須預約主要技師才能成立預約</strong><small id="bookingAdminPrimaryRequirementHint">每筆預約至少一位服務對象須選擇主要技師。</small></span>
          </label>
          <div class="booking-admin-policy-fields">
            <label>主要技師
              <select id="${ids.primaryTechnician}" aria-label="主要技師" aria-describedby="bookingAdminPrimaryRewardHint"></select>
              <small>關閉成立條件後，仍可保留主要技師。</small>
            </label>
            <label>每筆預約最多人數
              <span class="booking-admin-policy-number">
                <input id="${ids.maxPartySize}" type="number" min="1" max="10" step="1" value="1" inputmode="numeric" aria-label="每筆預約最多人數" aria-describedby="bookingAdminPartySizeHint" required>
                <span aria-hidden="true">人</span>
              </span>
              <small id="bookingAdminPartySizeHint">可設定 1–10 人。</small>
            </label>
          </div>
          <p id="bookingAdminPrimaryRewardHint" class="booking-admin-policy-note"><strong>回饋計算</strong>只有主要技師的服務列入集點與會員服務時間；其他技師或現場安排不列入。</p>
          <div class="booking-admin-policy-actions">
            <p>儲存後套用於新建及修改預約。<br>既有預約不會自動改寫。</p>
            <button id="${ids.settingsSave}" class="button button-dark" type="submit">儲存預約設定</button>
          </div>
        </form>
      </div>

      <div id="${ids.message}" class="form-message hidden" role="status" aria-live="polite"></div>
      <div class="booking-admin-resource-list-heading">
        <div><strong>技師清單</strong></div>
        <button id="${ids.technicianNew}" class="button button-dark" type="button">＋ 新增技師</button>
      </div>
      <div class="booking-admin-technician-tabs" role="tablist" aria-label="技師狀態">
        <button id="${ids.technicianActiveTab}" class="booking-admin-technician-tab active" type="button" role="tab" aria-selected="true" data-tab="active">
          已公開 <span id="${ids.technicianActiveCount}">0</span>
        </button>
        <button id="${ids.technicianDisabledTab}" class="booking-admin-technician-tab" type="button" role="tab" aria-selected="false" data-tab="disabled">
          已停用 <span id="${ids.technicianDisabledCount}">0</span>
        </button>
      </div>
      <div id="${ids.technicianList}" class="booking-admin-technician-list" role="tabpanel"></div>
      <div id="${ids.technicianEmpty}" class="empty-state compact hidden">
        <span aria-hidden="true">○</span><p id="${ids.technicianEmptyText}">目前沒有已公開的技師。</p>
      </div>`;

    host.appendChild(section);

    if (!document.getElementById(ids.technicianModal)) {
      const modal = document.createElement('div');
      modal.id = ids.technicianModal;
      modal.className = 'booking-admin-modal hidden';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', ids.technicianTitle);
      modal.innerHTML = `
        <div class="booking-admin-modal-card booking-admin-technician-modal-card">
          <div class="booking-admin-modal-heading">
            <div><p class="kicker">Technician editor</p><h2 id="${ids.technicianTitle}">新增技師</h2></div>
            <button id="${ids.technicianModalClose}" class="booking-admin-modal-close" type="button" aria-label="關閉">×</button>
          </div>

          <form id="${ids.technicianForm}" class="booking-admin-form booking-admin-technician-modal-form" novalidate>
            <input id="${ids.technicianId}" type="hidden">
            <input id="${ids.technicianExpectedUpdatedAt}" type="hidden">
            <div class="booking-admin-form-grid">
              <label>技師名稱
                <input id="${ids.technicianName}" type="text" maxlength="80" placeholder="例如：小林" required>
              </label>
              <label>顯示排序
                <input id="${ids.technicianSortOrder}" type="number" min="0" max="9999" step="1" value="0" required>
              </label>
            </div>
            <label class="booking-admin-toggle">
              <input id="${ids.technicianActive}" type="checkbox" checked>
              <span><strong>公開給會員預約</strong><small>關閉後會移到「已停用」；主要技師不可直接停用，請先變更主要技師。</small></span>
            </label>
            <div class="booking-admin-modal-actions booking-admin-technician-modal-actions">
              <button id="${ids.technicianModalCancel}" class="button button-outline" type="button">取消</button>
              <button id="${ids.technicianSave}" class="button button-dark" type="submit">儲存技師</button>
            </div>
          </form>

          <div id="${ids.technicianModalMessage}" class="form-message hidden" role="status" aria-live="polite"></div>
        </div>`;
      document.body.appendChild(modal);
    }
    return true;
  }

  function bind() {
    document.getElementById(ids.settingsForm)?.addEventListener('submit', saveSettings);
    document.getElementById(ids.requirePrimaryTechnician)?.addEventListener('change', renderRequirementHint);
    document.getElementById(ids.technicianForm)?.addEventListener('submit', saveTechnician);
    document.getElementById(ids.technicianNew)?.addEventListener('click', openNewTechnicianModal);
    document.getElementById(ids.technicianModalClose)?.addEventListener('click', closeTechnicianModal);
    document.getElementById(ids.technicianModalCancel)?.addEventListener('click', closeTechnicianModal);
    document.getElementById(ids.technicianActiveTab)?.addEventListener('click', () => setTechnicianTab('active'));
    document.getElementById(ids.technicianDisabledTab)?.addEventListener('click', () => setTechnicianTab('disabled'));
    document.getElementById(ids.technicianModal)?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget && window.matchMedia('(max-width: 768px)').matches) closeTechnicianModal();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !document.getElementById(ids.technicianModal)?.classList.contains('hidden')) closeTechnicianModal();
    });
    document.getElementById('bookingAdminResourceRefreshButton')?.addEventListener('click', () => refresh(true));
  }

  function observeBookingPanel() {
    const panel = document.getElementById('bookingPanel');
    if (!panel) return;
    let wasVisible = !panel.classList.contains('hidden');
    const observer = new MutationObserver(() => {
      const visible = !panel.classList.contains('hidden');
      if (visible && !wasVisible) refresh(false);
      wasVisible = visible;
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
  }

  async function boot() {
    try {
      state.idToken = await waitForToken();
      await refresh(false);
    } catch (error) {
      showMessage(error?.message || '無法載入預約人數與技師設定。', 'error');
    }
  }

  async function waitForToken() {
    if (!window.MemberAdminSession || typeof window.MemberAdminSession.wait !== 'function') {
      throw clientError('AUTH_REQUIRED', '管理端登入服務尚未準備完成。');
    }
    const session = await window.MemberAdminSession.wait();
    state.config = session.config;
    return String(session.idToken || '');
  }

  async function request(action, payload = {}, write = false) {
    if (!state.config || !state.idToken) state.idToken = await waitForToken();
    const endpoint = `${String(state.config?.supabaseUrl || '').replace(/\/$/, '')}/functions/v1/booking-group-api`;
    if (!state.config?.supabaseUrl || !state.config?.supabasePublishableKey) throw clientError('CONFIG_ERROR', '預約服務設定不完整，請重新整理後再試。');

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), write ? 30000 : 15000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', apikey: String(state.config.supabasePublishableKey) },
        body: JSON.stringify({ ...payload, action, clientType: 'admin', idToken: state.idToken }),
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; }
      catch { throw clientError('API_RESPONSE_ERROR', '預約設定服務回傳格式不正確。'); }
      if (!response.ok || data?.ok !== true) throw clientError(String(data?.error?.code || 'API_ERROR'), String(data?.error?.message || '預約設定服務拒絕此操作。'));
      return data.data || {};
    } catch (error) {
      if (error?.name === 'AbortError') throw clientError('TIMEOUT', '預約設定服務逾時，請稍後再試。');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function refresh(showFeedback) {
    if (state.loading) return;
    state.loading = true;
    const button = document.getElementById('bookingAdminResourceRefreshButton');
    if (button) { button.disabled = true; button.textContent = '更新中…'; }
    try {
      const data = await request('admin.booking.resources.bootstrap');
      state.data = {
        settings: data.settings || {},
        technicians: Array.isArray(data.technicians) ? data.technicians : [],
      };
      document.getElementById(ids.maxPartySize).value = String(Number(state.data.settings.maxPartySize) || 1);
      document.getElementById(ids.requirePrimaryTechnician).checked = state.data.settings.requirePrimaryTechnician !== false;
      renderRequirementHint();
      renderPrimaryOptions();
      renderTechnicians();
      if (showFeedback) showMessage('預約人數、主要技師與技師清單已更新。', 'success');
    } catch (error) {
      showMessage(error?.message || '無法更新預約人數與技師設定。', 'error');
    } finally {
      state.loading = false;
      if (button) { button.disabled = false; button.textContent = '更新設定'; }
    }
  }

  function renderPrimaryOptions() {
    const select = document.getElementById(ids.primaryTechnician);
    if (!select) return;
    const current = String(state.data?.settings?.primaryTechnicianId || '');
    const active = (state.data?.technicians || []).filter((item) => item.isActive).slice().sort(sortTechnicians);
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = active.length ? (document.getElementById(ids.requirePrimaryTechnician)?.checked ? '請選擇主要技師' : '不指定主要技師') : '請先新增開放中的技師';
    select.appendChild(empty);
    active.forEach((technician) => {
      const option = document.createElement('option');
      option.value = technician.technicianId;
      option.textContent = technician.name;
      select.appendChild(option);
    });
    select.value = active.some((item) => item.technicianId === current) ? current : '';
    select.disabled = active.length === 0;
  }

  function renderRequirementHint() {
    const required = document.getElementById(ids.requirePrimaryTechnician)?.checked;
    const hint = document.getElementById('bookingAdminPrimaryRequirementHint');
    if (hint) hint.textContent = required
      ? '每筆預約至少一位服務對象須選擇主要技師。'
      : '不必預約主要技師，可選其他開放技師或現場安排。';
    const select = document.getElementById(ids.primaryTechnician);
    if (select && !select.disabled && select.options[0]) select.options[0].textContent = required ? '請選擇主要技師' : '不指定主要技師';
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (state.savingSettings) return;
    const value = Number(document.getElementById(ids.maxPartySize)?.value);
    const primaryTechnicianId = String(document.getElementById(ids.primaryTechnician)?.value || '');
    const requirePrimaryTechnician = document.getElementById(ids.requirePrimaryTechnician).checked;
    if (!Number.isInteger(value) || value < 1 || value > 10) return showMessage('預約人數上限必須是 1–10 的整數。', 'error');
    if (requirePrimaryTechnician && !primaryTechnicianId) return showMessage('請選擇主要技師。', 'error');

    const button = document.getElementById(ids.settingsSave);
    state.savingSettings = true;
    setButtonBusy(button, true, '儲存中…');
    try {
      const result = await request('admin.booking.resources.settings.save', {
        maxPartySize: value,
        primaryTechnicianId,
        requirePrimaryTechnician,
        expectedUpdatedAt: state.data?.settings?.updatedAt || undefined,
      }, true);
      state.data = state.data || { settings: {}, technicians: [] };
      state.data.settings = result.settings || { ...state.data.settings, maxPartySize: value, primaryTechnicianId, requirePrimaryTechnician };
      renderPrimaryOptions();
      renderTechnicians();
      const primary = (state.data.technicians || []).find((item) => item.technicianId === state.data.settings.primaryTechnicianId);
      showMessage(primary ? `預約設定已儲存；主要技師為 ${primary.name}，${requirePrimaryTechnician ? '必須預約主要技師才能成立預約' : '不必預約主要技師也能成立預約'}。` : '預約設定已儲存；不必預約主要技師也能成立預約，可由現場安排。', 'success');
    } catch (error) {
      showMessage(error?.code === 'CONFLICT' ? '預約設定已被其他管理者更新，已重新載入最新資料。' : error?.message || '預約設定儲存失敗。', 'error');
      if (error?.code === 'CONFLICT') await refresh(false);
    } finally {
      state.savingSettings = false;
      setButtonBusy(button, false, '儲存預約設定');
    }
  }

  async function saveTechnician(event) {
    event.preventDefault();
    if (state.savingTechnician) return;
    const name = String(document.getElementById(ids.technicianName)?.value || '').trim();
    const sortOrder = Number(document.getElementById(ids.technicianSortOrder)?.value);
    if (!name) return showMessage('請輸入技師名稱。', 'error');
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) return showMessage('技師排序必須是 0–9999 的整數。', 'error');

    const button = document.getElementById(ids.technicianSave);
    state.savingTechnician = true;
    setButtonBusy(button, true, '儲存中…');
    try {
      const result = await request('admin.booking.resources.technician.save', {
        technicianId: document.getElementById(ids.technicianId)?.value || undefined,
        expectedUpdatedAt: document.getElementById(ids.technicianExpectedUpdatedAt)?.value || undefined,
        name,
        sortOrder,
        isActive: Boolean(document.getElementById(ids.technicianActive)?.checked),
      }, true);
      const saved = result.technician;
      if (!saved?.technicianId) throw clientError('API_RESPONSE_ERROR', '無法確認技師儲存結果。');
      state.data = state.data || { settings: {}, technicians: [] };
      const rows = Array.isArray(state.data.technicians) ? state.data.technicians : [];
      const index = rows.findIndex((item) => item.technicianId === saved.technicianId);
      if (index >= 0) rows[index] = saved; else rows.push(saved);
      rows.sort(sortTechnicians);
      state.data.technicians = rows;
      renderPrimaryOptions();
      renderTechnicians();
      closeTechnicianModal(true);
      const needsPrimary = state.data.settings?.requirePrimaryTechnician !== false && !state.data.settings?.primaryTechnicianId && rows.some((item) => item.isActive);
      showMessage(needsPrimary ? '技師已儲存。請在「主要技師」選擇一位並儲存預約設定。' : '技師設定已儲存。', needsPrimary ? 'error' : 'success');
    } catch (error) {
      showTechnicianModalMessage(error?.code === 'CONFLICT' ? '技師資料已被其他管理者更新，請重新開啟技師資料。' : error?.message || '技師設定儲存失敗。', 'error');
      if (error?.code === 'CONFLICT') await refresh(false);
    } finally {
      state.savingTechnician = false;
      setButtonBusy(button, false, document.getElementById(ids.technicianId)?.value ? '儲存修改' : '儲存技師');
    }
  }

  function renderTechnicians() {
    const list = document.getElementById(ids.technicianList);
    if (!list) return;

    const allRows = Array.isArray(state.data?.technicians) ? state.data.technicians.slice().sort(sortTechnicians) : [];
    const activeRows = allRows.filter((item) => item.isActive);
    const disabledRows = allRows.filter((item) => !item.isActive);
    const rows = state.technicianTab === 'disabled' ? disabledRows : activeRows;
    const primaryId = String(state.data?.settings?.primaryTechnicianId || '');

    document.getElementById(ids.technicianActiveCount).textContent = String(activeRows.length);
    document.getElementById(ids.technicianDisabledCount).textContent = String(disabledRows.length);

    const activeTab = document.getElementById(ids.technicianActiveTab);
    const disabledTab = document.getElementById(ids.technicianDisabledTab);
    activeTab?.classList.toggle('active', state.technicianTab === 'active');
    disabledTab?.classList.toggle('active', state.technicianTab === 'disabled');
    activeTab?.setAttribute('aria-selected', state.technicianTab === 'active' ? 'true' : 'false');
    disabledTab?.setAttribute('aria-selected', state.technicianTab === 'disabled' ? 'true' : 'false');

    list.replaceChildren();
    document.getElementById(ids.technicianEmpty)?.classList.toggle('hidden', rows.length !== 0);
    const emptyText = document.getElementById(ids.technicianEmptyText);
    if (emptyText) {
      emptyText.textContent = state.technicianTab === 'disabled'
        ? '目前沒有已停用的技師。'
        : '目前沒有已公開的技師。';
    }

    rows.forEach((technician) => {
      const row = document.createElement('div');
      row.className = `booking-admin-technician-row${technician.isActive ? '' : ' inactive'}`;

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'booking-admin-technician-row-main';
      edit.dataset.bookingAdminAction = 'edit-technician';
      edit.setAttribute('aria-label', `編輯技師 ${technician.name || ''}`);

      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = String(technician.name || '未命名技師');
      const meta = document.createElement('small');
      const tags = [`排序 ${Number(technician.sortOrder) || 0}`, technician.isActive ? '已公開' : '已停用'];
      if (technician.technicianId === primaryId) tags.push('主要技師');
      meta.textContent = tags.join(' · ');
      copy.append(name, meta);

      const badge = document.createElement('span');
      badge.className = `booking-admin-resource-status ${technician.isActive ? 'active' : 'inactive'}`;
      badge.textContent = technician.technicianId === primaryId ? '主要' : technician.isActive ? '公開' : '停用';
      edit.append(copy, badge);
      edit.addEventListener('click', () => openEditTechnicianModal(technician));
      row.append(edit);

      const statusBusy = Boolean(state.restoringTechnicianId || state.disablingTechnicianId);
      const statusAction = document.createElement('button');
      statusAction.type = 'button';
      statusAction.className = 'button button-outline booking-admin-technician-status-action';
      statusAction.dataset.bookingAdminAction = technician.isActive ? 'disable-technician' : 'restore-technician';

      if (technician.isActive) {
        const isPrimary = technician.technicianId === primaryId;
        statusAction.textContent = state.disablingTechnicianId === technician.technicianId ? '停用中…' : '停用';
        statusAction.disabled = statusBusy || isPrimary;
        if (isPrimary) {
          statusAction.title = '主要技師需先改指定其他技師後才能停用';
          statusAction.setAttribute('aria-label', `主要技師 ${technician.name || ''} 需先更換主要技師才能停用`);
        } else {
          statusAction.addEventListener('click', () => disableTechnician(technician, statusAction));
        }
      } else {
        statusAction.textContent = state.restoringTechnicianId === technician.technicianId ? '恢復中…' : '恢復公開';
        statusAction.disabled = statusBusy;
        statusAction.addEventListener('click', () => restoreTechnician(technician, statusAction));
      }

      row.append(statusAction);
      list.append(row);
    });
  }

  function setTechnicianTab(tab) {
    state.technicianTab = tab === 'disabled' ? 'disabled' : 'active';
    renderTechnicians();
  }

  async function disableTechnician(technician, button) {
    const technicianId = String(technician?.technicianId || '');
    const expectedUpdatedAt = String(technician?.updatedAt || '');
    const primaryId = String(state.data?.settings?.primaryTechnicianId || '');
    if (!technicianId || !expectedUpdatedAt || state.disablingTechnicianId || state.restoringTechnicianId) return;
    if (technicianId === primaryId) {
      showMessage('主要技師不可直接停用，請先指定其他主要技師。', 'error');
      return;
    }

    state.disablingTechnicianId = technicianId;
    setButtonBusy(button, true, '停用');
    if (button) button.textContent = '停用中…';
    try {
      const result = await request('admin.booking.resources.technician.save', {
        technicianId,
        expectedUpdatedAt,
        name: String(technician.name || '').trim(),
        sortOrder: Number(technician.sortOrder) || 0,
        isActive: false,
      }, true);
      const saved = result.technician;
      if (!saved?.technicianId) throw clientError('API_RESPONSE_ERROR', '無法確認技師停用結果。');

      const rows = Array.isArray(state.data?.technicians) ? state.data.technicians : [];
      const index = rows.findIndex((item) => item.technicianId === saved.technicianId);
      if (index >= 0) rows[index] = saved; else rows.push(saved);
      rows.sort(sortTechnicians);
      state.data.technicians = rows;
      renderPrimaryOptions();
      renderTechnicians();
      showMessage(`技師「${saved.name || technician.name || ''}」已停用，已移至「已停用」。`, 'success');
      window.dispatchEvent(new CustomEvent('booking:technician-disabled', { detail: { technicianId } }));
    } catch (error) {
      showMessage(
        error?.code === 'CONFLICT'
          ? '技師資料已被其他管理者更新，已重新載入最新資料。'
          : error?.message || '技師停用失敗。',
        'error',
      );
      if (error?.code === 'CONFLICT') await refresh(false);
    } finally {
      state.disablingTechnicianId = '';
      renderTechnicians();
    }
  }

  async function restoreTechnician(technician, button) {
    const technicianId = String(technician?.technicianId || '');
    const expectedUpdatedAt = String(technician?.updatedAt || '');
    if (!technicianId || !expectedUpdatedAt || state.restoringTechnicianId || state.disablingTechnicianId) return;

    state.restoringTechnicianId = technicianId;
    setButtonBusy(button, true, '恢復公開');
    if (button) button.textContent = '恢復中…';
    try {
      const result = await request('admin.booking.resources.technician.save', {
        technicianId,
        expectedUpdatedAt,
        name: String(technician.name || '').trim(),
        sortOrder: Number(technician.sortOrder) || 0,
        isActive: true,
      }, true);
      const saved = result.technician;
      if (!saved?.technicianId) throw clientError('API_RESPONSE_ERROR', '無法確認技師恢復結果。');

      const rows = Array.isArray(state.data?.technicians) ? state.data.technicians : [];
      const index = rows.findIndex((item) => item.technicianId === saved.technicianId);
      if (index >= 0) rows[index] = saved; else rows.push(saved);
      rows.sort(sortTechnicians);
      state.data.technicians = rows;
      renderPrimaryOptions();
      renderTechnicians();
      showMessage(`技師「${saved.name || technician.name || ''}」已恢復公開。`, 'success');
      window.dispatchEvent(new CustomEvent('booking:technician-restored', { detail: { technicianId } }));
    } catch (error) {
      showMessage(
        error?.code === 'CONFLICT'
          ? '技師資料已被其他管理者更新，已重新載入最新資料。'
          : error?.message || '技師恢復失敗。',
        'error',
      );
      if (error?.code === 'CONFLICT') await refresh(false);
    } finally {
      state.restoringTechnicianId = '';
      renderTechnicians();
    }
  }

  function openEditTechnicianModal(technician) {
    const form = document.getElementById(ids.technicianForm);
    if (!form || !technician) return;
    form.reset();
    document.getElementById(ids.technicianId).value = String(technician.technicianId || '');
    document.getElementById(ids.technicianExpectedUpdatedAt).value = String(technician.updatedAt || '');
    document.getElementById(ids.technicianName).value = String(technician.name || '');
    document.getElementById(ids.technicianSortOrder).value = String(Number(technician.sortOrder) || 0);
    document.getElementById(ids.technicianActive).checked = Boolean(technician.isActive);
    document.getElementById(ids.technicianTitle).textContent = technician.technicianId === state.data?.settings?.primaryTechnicianId ? '修改主要技師' : '修改技師';
    document.getElementById(ids.technicianSave).textContent = '儲存修改';
    showTechnicianModal();
  }

  function openNewTechnicianModal() {
    const form = document.getElementById(ids.technicianForm);
    if (!form) return;
    form.reset();
    document.getElementById(ids.technicianId).value = '';
    document.getElementById(ids.technicianExpectedUpdatedAt).value = '';
    document.getElementById(ids.technicianSortOrder).value = '0';
    document.getElementById(ids.technicianActive).checked = true;
    document.getElementById(ids.technicianTitle).textContent = '新增技師';
    document.getElementById(ids.technicianSave).textContent = '儲存技師';
    showTechnicianModal();
  }

  function showTechnicianModal() {
    clearTechnicianModalMessage();
    const modal = document.getElementById(ids.technicianModal);
    modal?.classList.remove('hidden');
    window.requestAnimationFrame(() => document.getElementById(ids.technicianName)?.focus());
  }

  function closeTechnicianModal(force = false) {
    if (!force && state.savingTechnician) return;
    document.getElementById(ids.technicianModal)?.classList.add('hidden');
    clearTechnicianModalMessage();
  }

  function showTechnicianModalMessage(message, type) {
    const element = document.getElementById(ids.technicianModalMessage);
    if (!element) return;
    element.textContent = String(message || '');
    element.className = `form-message${type === 'success' ? ' success' : ''}`;
  }

  function clearTechnicianModalMessage() {
    const element = document.getElementById(ids.technicianModalMessage);
    if (!element) return;
    element.textContent = '';
    element.className = 'form-message hidden';
  }

  function sortTechnicians(a, b) {
    return (Number(a?.sortOrder) || 0) - (Number(b?.sortOrder) || 0) || String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-Hant-TW');
  }

  function setButtonBusy(button, busy, fallbackText) {
    if (!button) return;
    button.disabled = busy;
    if (!busy) button.textContent = fallbackText;
  }

  function showMessage(message, type) {
    const element = document.getElementById(ids.message);
    if (!element) return;
    element.textContent = String(message || '');
    element.className = `form-message${type === 'success' ? ' success' : ''}`;
  }

  function clientError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
})();
