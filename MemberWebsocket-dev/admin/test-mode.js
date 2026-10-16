(() => {
  'use strict';

  const els = {};
  let loaded = false;
  let loading = null;
  let busy = false;
  let currentAccounts = [];
  let selectedAccountIds = new Set();

  window.addEventListener('DOMContentLoaded', () => {
    [
      'testModeTab', 'testModePanel', 'testModeForm', 'systemMaintenanceEnabled',
      'testModePcLoginEnabled', 'testModeMobileLoginEnabled', 'testModeDuplicateLoginEnabled', 'testModeMaintenanceMessage',
      'testModeAddAccountCount', 'saveTestModeButton', 'testModeFormMessage',
      'testModeAccountCount', 'testModeAccountList', 'testModeAccountEmpty',
      'testModeSelectAllAccounts', 'testModeSelectedCount', 'deleteSelectedTestAccountsButton',
      'testModeAccountActionMessage',
      'systemMaintenanceBadge', 'testModePcLoginBadge', 'testModeMobileLoginBadge'
    ].forEach((id) => { els[id] = document.getElementById(id); });

    if (!els.testModeTab || !els.testModeForm) return;
    els.testModeTab.addEventListener('click', () => load().catch(showError));
    els.testModeForm.addEventListener('submit', save);
    els.testModeSelectAllAccounts?.addEventListener('change', () => {
      if (busy) return;
      selectedAccountIds = els.testModeSelectAllAccounts.checked
        ? new Set(currentAccounts.map((account) => String(account.memberId || '')).filter(Boolean))
        : new Set();
      syncAccountSelection();
    });
    els.deleteSelectedTestAccountsButton?.addEventListener('click', () => {
      removeAccounts([...selectedAccountIds], true).catch((error) => setAccountMessage(error?.message || '批次移除測試帳號失敗。', true));
    });
    document.querySelectorAll('[data-test-account-count]').forEach((button) => {
      button.addEventListener('click', () => {
        const value = Number(button.dataset.testAccountCount || 0);
        if (!Number.isInteger(value) || value < 0 || value > 50) return;
        els.testModeAddAccountCount.value = String(value);
        els.testModeAddAccountCount.focus();
      });
    });
    window.addEventListener('member-admin-ready', () => {
      if (els.testModeTab.getAttribute('aria-selected') === 'true') load().catch(showError);
    });
  });

  function apiUrl(config) {
    const base = String(config && config.supabaseUrl || '').replace(/\/$/, '');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(base)) {
      throw new Error('測試模式服務設定不完整。');
    }
    return base + '/functions/v1/test-mode-api';
  }

  async function request(action, payload = {}) {
    const session = await window.MemberAdminSession.wait();
    const response = await fetch(apiUrl(session.config), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: String(session.config.supabasePublishableKey || '')
      },
      cache: 'no-store',
      body: JSON.stringify({
        ...payload,
        action,
        clientType: 'admin',
        idToken: session.idToken
      })
    });

    let body;
    try { body = await response.json(); }
    catch { throw new Error('測試模式服務暫時未正常回應。'); }
    if (!response.ok || !body || body.ok !== true) {
      const error = new Error(body?.error?.message || '測試模式服務拒絕此操作。');
      error.code = body?.error?.code || 'TEST_MODE_ERROR';
      throw error;
    }
    return body.data || {};
  }

  async function load(force = false) {
    if (loaded && !force) return;
    if (loading) return loading;
    setMessage('正在讀取環境設定…');
    loading = request('admin.test-mode.bootstrap')
      .then((data) => {
        render(data);
        loaded = true;
        setMessage('');
      })
      .finally(() => { loading = null; });
    return loading;
  }

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    const addAccountCount = Number(els.testModeAddAccountCount.value || 0);
    if (!Number.isInteger(addAccountCount) || addAccountCount < 0 || addAccountCount > 50) {
      return setMessage('本次新增測試帳號數量必須是 0–50 的整數。', true);
    }
    const maintenanceMessage = String(els.testModeMaintenanceMessage.value || '').trim();
    if (maintenanceMessage.length > 500) {
      return setMessage('系統維護訊息不可超過 500 字。', true);
    }

    setBusy(true);
    setMessage('正在儲存並建立測試帳號…');
    try {
      const data = await request('admin.test-mode.save', {
        maintenanceEnabled: els.systemMaintenanceEnabled.checked,
        allowPcTestLogin: els.testModePcLoginEnabled.checked,
        allowMobileTestLogin: els.testModeMobileLoginEnabled.checked,
        allowDuplicateTestLogin: els.testModeDuplicateLoginEnabled.checked,
        maintenanceMessage,
        addAccountCount
      });
      render(data);
      els.testModeAddAccountCount.value = '0';
      const created = Number(data.createdAccountCount || 0);
      setMessage(created > 0 ? '設定已儲存，已建立 ' + created + ' 個測試帳號。' : '環境設定已儲存。');
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  function render(data) {
    const settings = data && data.settings && typeof data.settings === 'object' ? data.settings : {};
    const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
    currentAccounts = accounts;
    const availableIds = new Set(accounts.map((account) => String(account.memberId || '')).filter(Boolean));
    selectedAccountIds = new Set([...selectedAccountIds].filter((id) => availableIds.has(id)));
    const maintenanceEnabled = Boolean(settings.maintenanceEnabled);
    const allowPcTestLogin = Boolean(settings.allowPcTestLogin);
    const allowMobileTestLogin = Boolean(settings.allowMobileTestLogin);
    const allowDuplicateTestLogin = Boolean(settings.allowDuplicateTestLogin);

    els.systemMaintenanceEnabled.checked = maintenanceEnabled;
    els.testModePcLoginEnabled.checked = allowPcTestLogin;
    els.testModeMobileLoginEnabled.checked = allowMobileTestLogin;
    els.testModeDuplicateLoginEnabled.checked = allowDuplicateTestLogin;
    els.testModeMaintenanceMessage.value = String(settings.maintenanceMessage || '');
    els.testModeAccountCount.textContent = accounts.length + ' 個';
    els.testModeAccountList.replaceChildren(...accounts.map(renderAccount));
    els.testModeAccountEmpty.classList.toggle('hidden', accounts.length !== 0);
    syncAccountSelection();

    updateStatusBadge(
      els.systemMaintenanceBadge,
      maintenanceEnabled ? '系統維護：啟用中' : '系統維護：未啟用',
      maintenanceEnabled ? 'is-warning' : 'is-off'
    );
    const pcLoginAvailable = maintenanceEnabled && allowPcTestLogin;
    const mobileLoginAvailable = maintenanceEnabled && allowMobileTestLogin;
    updateStatusBadge(
      els.testModePcLoginBadge,
      pcLoginAvailable ? 'PC 測試登入：可用' : 'PC 測試登入：停用',
      pcLoginAvailable ? 'is-active' : 'is-off'
    );
    updateStatusBadge(
      els.testModeMobileLoginBadge,
      mobileLoginAvailable ? '行動裝置測試登入：可用' : '行動裝置測試登入：停用',
      mobileLoginAvailable ? 'is-active' : 'is-off'
    );
  }

  function updateStatusBadge(element, text, stateClass) {
    if (!element) return;
    element.textContent = text;
    element.className = 'test-mode-status-badge ' + stateClass;
  }

  function renderAccount(account) {
    const row = document.createElement('div');
    row.className = 'test-account-row';

    const memberId = String(account.memberId || '');
    const displayName = String(account.displayName || '測試會員');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'test-account-checkbox';
    checkbox.checked = selectedAccountIds.has(memberId);
    checkbox.disabled = busy || !memberId;
    checkbox.setAttribute('aria-label', '選取 ' + displayName);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedAccountIds.add(memberId);
      else selectedAccountIds.delete(memberId);
      syncAccountSelection();
    });

    const identity = document.createElement('div');
    identity.className = 'test-account-identity';

    const avatar = document.createElement('span');
    avatar.className = 'test-account-avatar';
    avatar.textContent = displayName.trim().slice(0, 1) || '測';

    const copy = document.createElement('div');
    copy.className = 'test-account-copy';
    const name = document.createElement('strong');
    name.textContent = displayName;
    const code = document.createElement('small');
    code.textContent = String(account.memberCode || '');
    copy.append(name, code);
    identity.append(avatar, copy);

    const available = account.status === 'active' && account.membershipStatus === 'active';
    const status = document.createElement('span');
    status.className = 'test-account-status' + (available ? '' : ' is-disabled');
    status.textContent = available ? '可登入' : '不可登入';

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'button button-danger test-account-delete-button';
    removeButton.dataset.testAccountDelete = memberId;
    removeButton.textContent = '移除';
    removeButton.disabled = busy || !memberId;
    removeButton.addEventListener('click', () => {
      removeAccounts([memberId], false, displayName).catch((error) => setAccountMessage(error?.message || '移除測試帳號失敗。', true));
    });

    const actions = document.createElement('div');
    actions.className = 'test-account-actions';
    actions.append(status, removeButton);

    row.append(checkbox, identity, actions);
    return row;
  }

  function syncAccountSelection() {
    const total = currentAccounts.length;
    const selected = selectedAccountIds.size;

    document.querySelectorAll('.test-account-checkbox').forEach((checkbox) => {
      const memberId = String(checkbox.closest('.test-account-row')?.querySelector('[data-test-account-delete]')?.dataset.testAccountDelete || '');
      checkbox.checked = selectedAccountIds.has(memberId);
      checkbox.disabled = busy || !memberId;
    });

    if (els.testModeSelectedCount) {
      els.testModeSelectedCount.textContent = '已選 ' + selected + ' 個';
    }
    if (els.testModeSelectAllAccounts) {
      els.testModeSelectAllAccounts.checked = total > 0 && selected === total;
      els.testModeSelectAllAccounts.indeterminate = selected > 0 && selected < total;
      els.testModeSelectAllAccounts.disabled = busy || total === 0;
    }
    if (els.deleteSelectedTestAccountsButton) {
      els.deleteSelectedTestAccountsButton.disabled = busy || selected === 0;
    }
  }

  async function removeAccounts(memberIds, batch = false, displayName = '') {
    if (busy) return;
    const ids = [...new Set((Array.isArray(memberIds) ? memberIds : []).map((value) => String(value || '').trim()).filter(Boolean))];
    if (!ids.length) return;

    const subject = batch || ids.length > 1
      ? ids.length + ' 個測試帳號'
      : '「' + (displayName || '此測試帳號') + '」';
    const confirmed = window.confirm(
      '確定移除' + subject + '？\n\n此操作會永久清除該測試帳號與所有相關測試資料，包括預約、點數、票券、服務時間、登入 session、操作紀錄與相關系統資料，且無法復原。'
    );
    if (!confirmed) return;

    setBusy(true);
    setAccountMessage('正在移除測試帳號…');
    try {
      const data = await request('admin.test-mode.delete-accounts', { memberIds: ids });
      selectedAccountIds.clear();
      render(data);
      const deleted = Number(data.deletedAccountCount || ids.length);
      setAccountMessage('已完整移除 ' + deleted + ' 個測試帳號與所有相關資料。');
    } catch (error) {
      setAccountMessage(error && error.message ? error.message : '移除測試帳號失敗，請稍後再試。', true);
    } finally {
      setBusy(false);
    }
  }

  function setBusy(value) {
    busy = Boolean(value);
    els.saveTestModeButton.disabled = busy;
    els.systemMaintenanceEnabled.disabled = busy;
    els.testModePcLoginEnabled.disabled = busy;
    els.testModeMobileLoginEnabled.disabled = busy;
    els.testModeDuplicateLoginEnabled.disabled = busy;
    els.testModeMaintenanceMessage.disabled = busy;
    els.testModeAddAccountCount.disabled = busy;
    document.querySelectorAll('[data-test-account-count]').forEach((button) => {
      button.disabled = busy;
    });
    document.querySelectorAll('[data-test-account-delete]').forEach((button) => {
      button.disabled = busy;
    });
    syncAccountSelection();
  }

  function setMessage(message, error = false) {
    els.testModeFormMessage.textContent = String(message || '');
    els.testModeFormMessage.classList.toggle('hidden', !message);
    els.testModeFormMessage.classList.toggle('error', Boolean(error));
  }

  function setAccountMessage(message, error = false) {
    if (!els.testModeAccountActionMessage) return;
    els.testModeAccountActionMessage.textContent = String(message || '');
    els.testModeAccountActionMessage.classList.toggle('hidden', !message);
    els.testModeAccountActionMessage.classList.toggle('error', Boolean(error));
  }

  function showError(error) {
    setMessage(error && error.message ? error.message : '環境設定操作失敗，請稍後再試。', true);
  }
})();