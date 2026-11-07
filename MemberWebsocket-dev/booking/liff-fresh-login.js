(() => {
  'use strict';

  if (!window.BookingSystem || typeof window.BookingSystem.signIn !== 'function') return;

  const FRESH_LOGIN_QUERY = 'booking_system_reauth';
  const FRESH_LOGIN_STORAGE_KEY = 'booking_system_reauth:booking';
  const FRESH_LOGIN_MAX_AGE_MS = 5 * 60 * 1000;
  const originalSignIn = window.BookingSystem.signIn.bind(window.BookingSystem);

  function authError(code, message) {
    if (typeof window.BookingSystem.clientError === 'function') {
      return window.BookingSystem.clientError(code, message);
    }
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function redirectToFreshLogin() {
    const redirectUrl = new URL(window.location.href);
    // The callback marker is not a credential; bind it to this tab and pathname
    // so a bookmarked or replayed URL cannot reuse a previous LINE login.
    let nonce;
    try {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      nonce = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      window.sessionStorage.setItem(FRESH_LOGIN_STORAGE_KEY, JSON.stringify({
        nonce, pathname: redirectUrl.pathname, createdAt: Date.now()
      }));
    } catch (_) {
      throw authError('AUTH_STORAGE_UNAVAILABLE', '無法安全啟動 LINE 登入，請允許此網站使用工作階段儲存空間。');
    }
    redirectUrl.searchParams.set(FRESH_LOGIN_QUERY, 'booking.' + nonce);
    window.liff.login({ redirectUri: redirectUrl.toString() });
  }

  function consumeFreshLoginQuery() {
    const current = new URL(window.location.href);
    const marker = current.searchParams.get(FRESH_LOGIN_QUERY);
    if (marker === null) return false;
    current.searchParams.delete(FRESH_LOGIN_QUERY);
    window.history.replaceState({}, document.title, current.pathname + current.search + current.hash);
    let record;
    try {
      const raw = window.sessionStorage.getItem(FRESH_LOGIN_STORAGE_KEY);
      window.sessionStorage.removeItem(FRESH_LOGIN_STORAGE_KEY);
      record = raw ? JSON.parse(raw) : null;
    } catch (_) {
      throw authError('AUTH_REQUIRED', 'LINE 登入回跳無法確認，請重新開啟預約頁面。');
    }
    const age = Date.now() - Number(record && record.createdAt);
    if (!record || !/^[a-f0-9]{32}$/.test(record.nonce)
      || marker !== 'booking.' + record.nonce
      || record.pathname !== current.pathname
      || !Number.isFinite(age) || age < 0 || age > FRESH_LOGIN_MAX_AGE_MS) {
      throw authError('AUTH_REQUIRED', 'LINE 登入回跳已失效，請重新開啟預約頁面。');
    }
    return true;
  }

  async function freshBookingSignIn(config) {
    const liffId = String(config && config.bookingLiffId || '').trim();
    if (!liffId) throw authError('LIFF_CONFIG_MISSING', '尚未設定預約 LIFF ID。');
    if (!window.liff) throw authError('LIFF_SDK_MISSING', 'LINE LIFF SDK 尚未載入。');

    try {
      await window.liff.init({ liffId });
    } catch (_) {
      throw authError('LIFF_INIT_ERROR', 'LIFF 初始化失敗，請重新開啟預約頁面。');
    }

    const inLiffClient = typeof window.liff.isInClient === 'function' && window.liff.isInClient();
    if (inLiffClient) {
      if (!window.liff.isLoggedIn()) {
        throw authError('AUTH_REQUIRED', 'LINE LIFF 尚未完成登入，請重新開啟此 LIFF。');
      }
    } else {
      const returnedFromFreshLogin = consumeFreshLoginQuery();
      if (!returnedFromFreshLogin) {
        if (window.liff.isLoggedIn()) {
          try { window.liff.logout(); }
          catch (_) { throw authError('AUTH_LOGOUT_FAILED', '無法清除先前的 LINE 工作階段，請重新開啟預約頁面。'); }
          if (window.liff.isLoggedIn()) throw authError('AUTH_LOGOUT_FAILED', '先前的 LINE 工作階段仍有效，請重新開啟預約頁面。');
        }
        redirectToFreshLogin();
        return new Promise(() => {});
      }
      if (!window.liff.isLoggedIn()) {
        throw authError('AUTH_REQUIRED', 'LINE 登入未完成，請重新開啟預約頁面再試。');
      }
    }

    const idToken = window.liff.getIDToken() || '';
    if (!idToken) throw authError('LIFF_ID_TOKEN_MISSING', '無法取得 LINE 登入憑證，請重新登入。');
    return idToken;
  }

  window.BookingSystem.signIn = async (config, clientType) => {
    if (clientType !== 'booking') return originalSignIn(config, clientType);
    let idToken;
    if (window.TestModeClient && typeof window.TestModeClient.prepare === 'function') {
      const prepared = await window.TestModeClient.prepare(config, 'booking', () => freshBookingSignIn(config));
      idToken = String(prepared && prepared.idToken || '');
    } else {
      idToken = await freshBookingSignIn(config);
    }
    // Use the same authenticated completion as BookingSystem.signIn().
    // In particular this must register the claimed token for getSession();
    // the receipt/snapshot code must not mistake a valid login for a
    // closed Presence connection. Test-mode sessions may have no LINE token.
    return await window.BookingSystem.completeSignIn(config, 'booking', idToken);
  };
})();
