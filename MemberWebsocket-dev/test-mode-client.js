(() => {
  'use strict';

  const STORAGE_KEY = 'member-test-session-v1';
  const SESSION_READY_EVENT = 'member-test-session-ready';
  const AVAILABILITY_EVENT = 'member-test-account-availability-changed';
  const SESSION_REVOKED_EVENT = 'member-test-session-revoked';
  let activeSessionToken = '';
  let realtimeWatcher = null;
  let realtimeWatcherKey = '';
  let realtimeSurface = '';

  function announceSessionReady() {
    try { window.dispatchEvent(new Event(SESSION_READY_EVENT)); } catch (_) {}
  }


  function dispatchAvailabilityChanged() {
    try { window.dispatchEvent(new Event(AVAILABILITY_EVENT)); } catch (_) {}
  }

  function dispatchSessionRevoked(reason) {
    try {
      window.dispatchEvent(new CustomEvent(SESSION_REVOKED_EVENT, {
        detail: { reason: String(reason || 'revoked') }
      }));
    } catch (_) {}
  }

  let forcedLogoutTerminating = false;

  function terminateForcedTestSession(message, reason = 'admin-force-logout') {
    if (forcedLogoutTerminating) return;
    forcedLogoutTerminating = true;
    clearSession();
    dispatchSessionRevoked(reason);
    const notice = String(message || '').trim() || '您的測試登入工作階段已由管理員強制結束。';
    try { window.alert(notice); } catch (_) {}
    if (window.liff && typeof window.liff.closeWindow === 'function') {
      try {
        window.liff.closeWindow();
        return;
      } catch (_) {}
    }
    try { window.close(); } catch (_) {}
    try {
      if (!window.closed && window.location && typeof window.location.replace === 'function') {
        window.location.replace('about:blank');
      }
    } catch (_) {}
  }

  function surfaceInUse(account, surface) {
    if (!account) return false;
    if (account.currentSurfaceInUse === true) return true;
    return Array.isArray(account.activeSurfaces) && account.activeSurfaces.includes(surface);
  }

  function renderAccountOptions(select, accounts, surface, allowDuplicateTestLogin = false) {
    const previous = String(select.value || '');
    const enabledIds = [];
    select.replaceChildren();
    for (const account of accounts) {
      const option = document.createElement('option');
      option.value = String(account.memberId || '');
      const inUse = surfaceInUse(account, surface);
      const unavailable = inUse && !allowDuplicateTestLogin;
      option.disabled = unavailable;
      option.textContent = [account.displayName, account.memberCode, inUse ? (allowDuplicateTestLogin ? '已登入 · 新登入將踢除舊連線' : '此用戶端已登入') : '可登入'].filter(Boolean).join('｜');
      select.append(option);
      if (!unavailable && option.value) enabledIds.push(option.value);
    }
    if (previous && enabledIds.includes(previous)) select.value = previous;
    else if (enabledIds.length) select.value = enabledIds[0];
    select.disabled = enabledIds.length === 0;
    return enabledIds.length;
  }

  function stopRealtimeWatcher() {
    const watcher = realtimeWatcher;
    realtimeWatcher = null;
    realtimeWatcherKey = '';
    realtimeSurface = '';
    if (!watcher) return;
    try { Promise.resolve(watcher.client.removeChannel(watcher.channel)).catch(() => {}); } catch (_) {}
  }

  function ensureRealtimeWatcher(config, surface) {
    if (config?.realtimeEnabled === false || !window.supabase || typeof window.supabase.createClient !== 'function') return;
    const key = String(config.supabaseUrl || '') + '|' + String(config.supabasePublishableKey || '');
    if (!key || realtimeWatcherKey === key && realtimeWatcher) {
      realtimeSurface = surface || realtimeSurface;
      return;
    }
    stopRealtimeWatcher();
    const client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    });
    realtimeWatcherKey = key;
    realtimeSurface = surface;
    const channel = client
      .channel('test-mode-client-' + Math.random().toString(36).slice(2, 10))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'realtime_events' }, (payload) => {
        const row = payload && payload.new && typeof payload.new === 'object' ? payload.new : {};
        const eventType = String(row.event_type || '');
        const scope = String(row.scope || '');
        if ((eventType === 'admin.member.force-logout' || eventType === 'member.removal.started') && (scope === 'all' || scope === realtimeSurface) && getSessionToken()) {
          void sessionStatus(config, realtimeSurface).catch((error) => {
            if (error && ['SESSION_REVOKED', 'TEST_SESSION_INVALID', 'MEMBER_REMOVED'].includes(error.code)) terminateForcedTestSession(error.message);
          });
          return;
        }
        if (!eventType.startsWith('test_mode.')) return;
        // The new session is committed before this notification. An older tab
        // rechecks server-side revocation; never trusts a broadcast as identity.
        if (eventType === 'test_mode.session.started' && getSessionToken()) {
          void sessionStatus(config, realtimeSurface).catch(() => {});
        }
        dispatchAvailabilityChanged();
        if (eventType === 'test_mode.data.purged') {
          const hadSession = Boolean(getSessionToken());
          clearSession();
          dispatchSessionRevoked('test-data-purged');
          if (hadSession) window.setTimeout(() => window.location.reload(), 50);
          return;
        }
        if (eventType === 'test_mode.account.deleted' && getSessionToken()) {
          void validateStoredSession(config, realtimeSurface).then((session) => {
            if (session && session.active) return;
            dispatchSessionRevoked('test-account-deleted');
            window.setTimeout(() => window.location.reload(), 50);
          }).catch(() => {
            clearSession();
            dispatchSessionRevoked('test-account-deleted');
            window.setTimeout(() => window.location.reload(), 50);
          });
        }
      })
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED' || !getSessionToken()) return;
        void sessionStatus(config, realtimeSurface).catch((error) => {
          if (error && error.code === 'SESSION_REVOKED') terminateForcedTestSession(error.message);
        });
      });
    realtimeWatcher = { client, channel };
  }

  function clientError(code, message, status = 0) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
  }

  function endpoint(config) {
    const url = String(config && config.supabaseUrl || '').replace(/\/$/, '');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
      throw clientError('CONFIG_ERROR', '測試模式服務設定不完整。');
    }
    return url + '/functions/v1/test-mode-api';
  }

  async function post(config, body) {
    const response = await fetch(endpoint(config), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: String(config && config.supabasePublishableKey || '')
      },
      cache: 'no-store',
      body: JSON.stringify(body || {})
    });
    let payload;
    try { payload = await response.json(); }
    catch { throw clientError('TEST_MODE_RESPONSE_ERROR', '測試模式服務暫時未正常回應。', response.status); }
    if (!response.ok || !payload || payload.ok !== true) {
      const error = clientError(
        payload?.error?.code || 'TEST_MODE_ERROR',
        payload?.error?.message || '測試模式服務拒絕此請求。',
        Number(payload?.status || response.status || 0)
      );
      error.details = payload?.error?.details || null;
      if (error.code === 'SESSION_REVOKED' || error.code === 'SESSION_REPLACED') {
        terminateForcedTestSession(error.message, error.code === 'SESSION_REPLACED' ? 'replaced-by-new-login' : 'admin-force-logout');
      }
      throw error;
    }
    return payload.data || {};
  }

  function readStoredToken() {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      const token = String(parsed && parsed.token || '');
      const expiresAt = Number(parsed && parsed.expiresAt || 0);
      if (!token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        window.sessionStorage.removeItem(STORAGE_KEY);
        return '';
      }
      return token;
    } catch (_) {
      return '';
    }
  }

  function storeToken(token, expiresAt) {
    activeSessionToken = String(token || '');
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        token: activeSessionToken,
        expiresAt: new Date(expiresAt).getTime()
      }));
    } catch (_) {
      throw clientError('AUTH_STORAGE_UNAVAILABLE', '瀏覽器無法保存本次測試登入狀態。');
    }
    announceSessionReady();
  }

  function clearSession() {
    activeSessionToken = '';
    try { window.sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  function getSessionToken() {
    if (activeSessionToken) return activeSessionToken;
    activeSessionToken = readStoredToken();
    return activeSessionToken;
  }

  async function status(config) {
    return post(config, { action: 'public.status' });
  }

  async function validateStoredSession(config, surface = '') {
    const token = getSessionToken();
    if (!token) return null;
    try {
      const result = await post(config, { action: 'session.status', clientType: surface || undefined, testSessionToken: token });
      activeSessionToken = token;
      announceSessionReady();
      return result;
    } catch (_) {
      clearSession();
      return null;
    }
  }

  async function sessionStatus(config, surface = '') {
    const token = getSessionToken();
    if (!token) return null;
    const result = await post(config, { action: 'session.status', clientType: surface || undefined, testSessionToken: token });
    activeSessionToken = token;
    announceSessionReady();
    return result;
  }

  function maintenanceError(message) {
    return clientError('SYSTEM_MAINTENANCE', String(message || '').trim() || '系統維護中，請稍後再試。', 503);
  }

  function isMobileDevice() {
    const uaData = navigator.userAgentData;
    if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile;
    const ua = String(navigator.userAgent || '');
    if (/Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(ua)) return true;
    return String(navigator.platform || '') === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1;
  }

  function selector(config, surface, accounts, allowDuplicateTestLogin = false) {
    return new Promise((resolve) => {
      const existing = document.getElementById('testModeAccountModal');
      if (existing) existing.remove();

      const modal = document.createElement('section');
      modal.id = 'testModeAccountModal';
      modal.className = 'test-mode-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'testModeAccountTitle');

      const card = document.createElement('div');
      card.className = 'test-mode-modal-card';

      const kicker = document.createElement('p');
      kicker.className = 'test-mode-kicker';
      kicker.textContent = 'Test mode';

      const title = document.createElement('h1');
      title.id = 'testModeAccountTitle';
      title.textContent = '選擇測試帳號';

      const description = document.createElement('p');
      description.textContent = '目前為測試模式。請直接選擇要登入的虛擬會員帳號。';

      const label = document.createElement('label');
      label.className = 'test-mode-field';
      label.append(document.createTextNode('測試帳號'));

      const select = document.createElement('select');
      select.id = 'testModeAccountSelect';
      select.setAttribute('aria-label', '選擇測試帳號');
      let currentAccounts = Array.isArray(accounts) ? accounts.slice() : [];
      let duplicateLoginAllowed = allowDuplicateTestLogin === true;
      const enabledCount = renderAccountOptions(select, currentAccounts, surface, duplicateLoginAllowed);
      label.append(select);

      const message = document.createElement('p');
      message.className = 'test-mode-message';
      if (!enabledCount) message.textContent = '目前所有測試帳號都已在此用戶端登入；關閉既有視窗後會自動恢復可選。';
      message.setAttribute('role', 'status');
      message.setAttribute('aria-live', 'polite');

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'test-mode-primary-button';
      button.textContent = '登入測試帳號';

      card.append(kicker, title, description, label, message, button);
      modal.append(card);
      document.body.append(modal);

      let refreshing = false;
      const refreshAvailability = async () => {
        if (refreshing || !document.body.contains(modal)) return;
        refreshing = true;
        try {
          const result = await post(config, { action: 'test-mode.accounts', clientType: surface });
          currentAccounts = Array.isArray(result.accounts) ? result.accounts : [];
          duplicateLoginAllowed = result.allowDuplicateTestLogin === true;
          const count = renderAccountOptions(select, currentAccounts, surface, duplicateLoginAllowed);
          if (!count) message.textContent = '目前所有測試帳號都已在此用戶端登入；關閉既有視窗後會自動恢復可選。';
          else if (/所有測試帳號/.test(message.textContent || '')) message.textContent = '';
        } catch (_) {
          // 保留目前列表；下一個 Realtime 訊號或視窗 focus 會再嘗試。
        } finally {
          refreshing = false;
        }
      };
      const onAvailability = () => { void refreshAvailability(); };
      const onFocus = () => { void refreshAvailability(); };
      window.addEventListener(AVAILABILITY_EVENT, onAvailability);
      window.addEventListener('focus', onFocus);

      const cleanupSelector = () => {
        window.removeEventListener(AVAILABILITY_EVENT, onAvailability);
        window.removeEventListener('focus', onFocus);
      };

      const finish = () => {
        const memberId = String(select.value || '');
        const selectedOption = select.selectedOptions && select.selectedOptions[0];
        if (!memberId || selectedOption?.disabled) {
          message.textContent = selectedOption?.disabled ? '此測試帳號已在目前用戶端登入，請選擇其他帳號。' : '請先選擇測試帳號。';
          void refreshAvailability();
          return;
        }
        button.disabled = true;
        select.disabled = true;
        message.textContent = '正在建立測試登入…';
        cleanupSelector();
        resolve({ memberId, modal, button, select, message });
      };
      button.addEventListener('click', finish);
      select.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish();
        }
      });
      window.setTimeout(() => select.focus(), 0);
    });
  }

  async function prepare(config, surface, normalSignIn) {
    ensureRealtimeWatcher(config, surface);
    if (surface === 'admin') {
      clearSession();
      return { idToken: await normalSignIn(), testSessionToken: '', testAccount: null };
    }

    const mode = await status(config);
    if (!mode.maintenanceEnabled) {
      clearSession();
      return { idToken: await normalSignIn(), testSessionToken: '', testAccount: null };
    }
    const mobile = isMobileDevice();
    const deviceAllowed = mobile
      ? Boolean(mode.allowMobileTestLogin)
      : Boolean(mode.allowPcTestLogin);
    if (!deviceAllowed) {
      clearSession();
      throw maintenanceError(mode.maintenanceMessage);
    }

    const existing = await validateStoredSession(config, surface);
    if (existing && existing.active) {
      return {
        idToken: '',
        testSessionToken: getSessionToken(),
        testAccount: existing.account || null
      };
    }

    const accountsResult = await post(config, {
      action: 'test-mode.accounts',
      clientType: surface
    });

    const accounts = Array.isArray(accountsResult.accounts)
      ? accountsResult.accounts.filter((account) => account && account.memberId)
      : [];
    if (!accounts.length) {
      throw clientError('NO_TEST_ACCOUNTS', '目前尚未建立可登入的測試帳號。', 409);
    }

    const selection = await selector(config, surface, accounts, accountsResult.allowDuplicateTestLogin === true);
    try {
      const login = await post(config, {
        action: 'test-mode.login',
        clientType: surface,
        memberId: selection.memberId
      });
      storeToken(login.testSessionToken, login.expiresAt);
      selection.modal.remove();
      return {
        idToken: '',
        testSessionToken: getSessionToken(),
        testAccount: login.account || null
      };
    } catch (error) {
      selection.button.disabled = false;
      selection.select.disabled = false;
      selection.message.textContent = error && error.message ? error.message : '測試登入失敗，請重試。';
      if (error && error.code === 'TEST_SURFACE_ALREADY_ACTIVE') {
        selection.modal.remove();
        dispatchAvailabilityChanged();
        return prepare(config, surface, normalSignIn);
      }
      throw error;
    }
  }

  function payload(extra = {}) {
    const token = getSessionToken();
    return token ? { ...extra, testSessionToken: token } : { ...extra };
  }

  window.TestModeClient = Object.freeze({
    prepare,
    payload,
    getSessionToken,
    clearSession,
    status,
    sessionStatus,
    isMobileDevice,
    ensureRealtimeWatcher
  });
})();
