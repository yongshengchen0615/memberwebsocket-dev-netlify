(() => {
  'use strict';

  // This entry owns its LINE login and page lifecycle. The management
  // workbench is never imported, and all permissions are checked on the API.
  const el = id => document.getElementById(id);
  const root = el('frontdeskSettingsRoot');
  const status = el('frontdeskPageStatus');
  const gate = el('frontdeskPageGate');
  const content = el('frontdeskPageContent');
  const loginButton = el('frontdeskPageLogin');
  const RETURN_KEY = 'frontdesk-settings-line-return-v1';
  const ATTEMPT_KEY = 'frontdesk-settings-line-attempt-v1';
  const BUSINESS_KEY = 'frontdesk-settings-merchant-return-v1';
  const RETURN_TTL_MS = 180000;
  const deniedCodes = new Set([
    'AUTH_REQUIRED', 'AUTH_INVALID', 'TENANT_REAUTH_REQUIRED',
    'TENANT_EXPIRED', 'TENANT_SUSPENDED', 'FEATURE_DISABLED',
    'BUSINESS_FORBIDDEN', 'PLATFORM_APPLICATION_NOT_APPROVED',
    'PLATFORM_APPLICATION_NOT_FOUND', 'PLATFORM_QUALIFICATION_REQUIRED',
    'PLATFORM_QUALIFICATION_SUSPENDED'
  ]);
  let config = null, business = '', idToken = '', epoch = 0, checking = false;
  let reconcileTimer = null;
  function stopReconciliation() {
    if (reconcileTimer !== null) {
      window.clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
  }

  function setStatus(message) { status.textContent = message; }
  function hint() {
    const params = new URLSearchParams(location.search);
    if (!(params.has('liff.state') || (params.has('code') && params.has('state')))) return '';
    try {
      const value = JSON.parse(sessionStorage.getItem(BUSINESS_KEY) || 'null');
      const age = Date.now() - Number(value?.at);
      return age >= 0 && age <= RETURN_TTL_MS ? String(value?.business || '') : '';
    } catch { return ''; }
  }
  function resolveBusiness() {
    const selected = window.BusinessContext?.slug || hint();
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(selected)) {
      throw new Error('請從「我的商家」選擇商家，再進入櫃檯設定。');
    }
    business = selected;
    if (window.BusinessContext.slug !== business) window.BusinessContext.set(business);
    // The browser hint is only for a LINE callback losing the query string.
    // It is not used as proof of identity or merchant access.
    sessionStorage.setItem(BUSINESS_KEY, JSON.stringify({ business, at: Date.now() }));
    const manage = el('frontdeskManageBusiness');
    manage.href = '/admin/?business=' + encodeURIComponent(business);
    manage.hidden = false;
    return business;
  }
  function dismiss(message, allowLogin = true) {
    stopReconciliation();
    epoch++;
    idToken = '';
    window.FrontdeskSettings?.clear(root);
    content.hidden = true;
    gate.hidden = !allowLogin;
    setStatus(message);
  }
  function markAttempt() {
    try {
      const now = Date.now();
      const previous = Number(sessionStorage.getItem(ATTEMPT_KEY));
      if (previous > 0 && now >= previous && now - previous <= RETURN_TTL_MS) return false;
      sessionStorage.setItem(ATTEMPT_KEY, String(now));
      return true;
    } catch { return false; }
  }
  function consumeReturn() {
    let timestamp = 0;
    try {
      timestamp = Number(sessionStorage.getItem(RETURN_KEY));
      sessionStorage.removeItem(RETURN_KEY);
    } catch { return false; }
    return timestamp > 0 && Date.now() >= timestamp &&
      Date.now() - timestamp <= RETURN_TTL_MS;
  }
  function beginLogin({ force = false } = {}) {
    if (!markAttempt()) {
      dismiss('LINE 登入未完成。請點選重新登入，或在 LINE 中重新開啟此頁。');
      return;
    }
    try {
      sessionStorage.setItem(RETURN_KEY, String(Date.now()));
      idToken = '';
      if (force && window.liff.isLoggedIn()) window.liff.logout();
      if (window.liff.isInClient()) {
        setStatus('正在重新初始化 LINE 登入…');
        location.reload();
      } else {
        setStatus('正在前往 LINE 確認身分…');
        window.liff.login();
      }
    } catch {
      sessionStorage.removeItem(RETURN_KEY);
      dismiss('無法啟動 LINE 登入，請重新開啟此頁。');
    }
  }
  async function request(action, payload = {}) {
    if (!config || !idToken) throw Object.assign(new Error('請先使用 LINE 確認管理員身分。'), { code: 'AUTH_REQUIRED' });
    const requestEpoch = epoch;
    const isWrite = new Set([
      'platform.frontdesk.settings.save',
      'platform.frontdesk.preferences.save',
      'platform.frontdesk.rejection-settings.save',
      'platform.frontdesk.staff.save',
      'platform.frontdesk.staff.batch',
      'platform.frontdesk.staff.delete',
    ]).has(action);
    const finishFeedback = isWrite
      ? window.AsyncActionFeedback?.begin('正在儲存櫃檯設定並等待後端確認…') : null;
    try {
    const endpoint = new URL(config.supabaseFunctionUrl);
    endpoint.pathname = endpoint.pathname.replace(/\/api\/?$/, '/platform-api');
    if (!endpoint.pathname.endsWith('/platform-api')) throw new Error('商家 API 設定不正確。');
    let response;
    try {
      response = await fetch(endpoint.href, {
        method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', apikey: config.supabasePublishableKey },
        body: JSON.stringify({ action, ...payload, business, idToken })
      });
    } catch {
      throw Object.assign(new Error('無法確認伺服器結果，請使用相同操作重試。'), { uncertain: true });
    }
    let body;
    try { body = await response.json(); }
    catch { throw Object.assign(new Error('無法確認伺服器回應，請使用相同操作重試。'), { uncertain: true }); }
    if (requestEpoch !== epoch) throw Object.assign(new Error('登入狀態已變更。'), { code: 'AUTH_INVALID' });
    if (!response.ok || !body.ok) {
      const error = Object.assign(new Error(body.error?.message || '操作未完成。'), {
        code: body.error?.code, uncertain: response.status >= 500, status: response.status
      });
      if (deniedCodes.has(error.code) || response.status === 401 || response.status === 403) {
        dismiss('櫃檯權限已變更或登入失效。' + error.message);
      }
      throw error;
    }
    return body.data;
    } finally { finishFeedback?.(); }
  }
  function assertAccess(data) {
    if (data.application?.status !== 'approved' ||
        data.tenant?.slug !== business || data.tenant?.status !== 'active' ||
        data.tenant?.expired || data.tenant?.onboarding?.adminReady !== true ||
        data.tenant?.features?.booking !== true ||
        data.tenant?.features?.frontdesk !== true) {
      throw Object.assign(new Error('此商家尚未獲得櫃檯設定授權，或商家已停用。'), { code: 'BUSINESS_FORBIDDEN' });
    }
  }
  async function checkAccess() {
    if (!idToken || checking || document.hidden) return;
    const currentEpoch = epoch;
    checking = true;
    try {
      const data = await request('platform.application.bootstrap');
      if (epoch !== currentEpoch) return;
      assertAccess(data);
      setStatus('已確認 ' + data.tenant.name + ' 的櫃檯設定權限。');
      // Keep focus, online, visibility and heartbeat in the same cycle until
      // the authorized settings refresh has settled.
      await window.FrontdeskSettings.refresh({ business });
    } catch (error) {
      if (epoch !== currentEpoch) return;
      if (deniedCodes.has(error.code)) dismiss(error.message);
      else setStatus('目前無法重新確認權限，請確認網路後重新整理。');
    } finally {
      checking = false;
    }
  }
  async function start({ reauthenticate = false } = {}) {
    stopReconciliation();
    const currentEpoch = ++epoch;
    content.hidden = true;
    gate.hidden = true;
    setStatus('正在確認 LINE 身分與商家授權…');
    try {
      resolveBusiness();
      const response = await fetch('../../config/config.json', {
        cache: 'no-store', signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error('無法載入商家公開設定。');
      const base = await response.json();
      config = await window.BusinessContext.configure({ ...base });
      if (epoch !== currentEpoch) return;
      const liffId = String(config.adminLiffId || '').trim();
      if (!/^\d{5,30}-[A-Za-z0-9_-]+$/.test(liffId)) throw new Error('尚未設定有效的商家管理端 LIFF ID。');
      window.MemberSystem.validateConfig({ ...config, adminLiffId: liffId }, 'admin');
      if (!window.liff) throw new Error('無法載入 LINE LIFF SDK。');
      await window.liff.init({ liffId });
      if (epoch !== currentEpoch) return;
      const returned = consumeReturn();
      // Navigation from My Merchants must reuse the existing LIFF session.
      // Only an explicit recovery click can log out and start a new login.
      if (reauthenticate) { beginLogin({ force: true }); return; }
      if (!window.liff.isLoggedIn()) {
        if (returned) throw new Error('LINE 登入未完成，請重新進入櫃檯設定。');
        if (window.liff.isInClient()) {
          if (markAttempt()) { location.reload(); return; }
          throw new Error('LINE 登入尚未完成，請在 LINE 中重新開啟此頁。');
        }
        beginLogin();
        return;
      }
      idToken = window.liff.getIDToken() || '';
      if (!idToken) throw new Error('無法取得 LINE 身分憑證，請確認 openid 權限。');
      const data = await request('platform.application.bootstrap');
      if (epoch !== currentEpoch) return;
      assertAccess(data);
      gate.hidden = true;
      content.hidden = false;
      el('frontdeskMerchantTitle').textContent = data.tenant.name;
      setStatus('已確認管理員身分及櫃檯權限。');
      sessionStorage.removeItem(ATTEMPT_KEY);
      window.FrontdeskSettings.mount({ root, request, business });
      const details = root.querySelector('[data-frontdesk-settings]');
      // The panel's toggle handler owns its initial load.
      if (details) details.open = true;
      // A cross-device application cannot publish a same-browser event. Retain
      // the original 15-second server reconciliation while this page is visible.
      // timer-policy: heartbeat; reason=Reconcile remote staff applications against verified tenant rights; cleanup=dismiss and pagehide; test=frontdesk-booking.spec.cjs
      reconcileTimer = window.setInterval(() => {
        if (!document.hidden) void checkAccess();
      }, 15000);
    } catch (error) {
      if (epoch === currentEpoch) dismiss(error.message || '櫃檯設定驗證未完成。');
    }
  }
  loginButton.addEventListener('click', () => {
    try { sessionStorage.removeItem(ATTEMPT_KEY); } catch {}
    void start({ reauthenticate: true });
  });
  window.addEventListener('online', () => void checkAccess());
  window.addEventListener('focus', () => void checkAccess());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void checkAccess();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      dismiss('正在重新確認管理員身分…', false);
      location.reload();
    }
  });
  window.addEventListener('pagehide', () => {
    stopReconciliation();
    epoch++;
    idToken = '';
    window.FrontdeskSettings?.clear(root);
    content.hidden = true;
  });
  void start();
})();
