(() => {
  'use strict';

  const SUPABASE_URL_PATTERN = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i;
  const SUPABASE_FUNCTION_PATTERN = /^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/[A-Za-z0-9_-]+$/i;
  const FRESH_LOGIN_QUERY = 'member_system_reauth';
  const FRESH_LOGIN_MAX_AGE_MS = 5 * 60 * 1000;
  const READ_RETRY_DELAY_MS = 400;
  const READ_TIMEOUT_MS = 12000;
  const BOOTSTRAP_TIMEOUT_MS = 30000;
  const WRITE_TIMEOUT_MS = 30000;
  const pendingReads = new Map();
  const sessions = new Map();
  const realtimeSubscriptions = new Map();
  const realtimeStatuses = new Map();
  let realtimeClient = null;
  let realtimeClientKey = '';
  let presenceContext = null;
  let presenceHooksBound = false;
  let presenceHeartbeatTimer = null;
  let isTerminatingAccess = false;
  const PRESENCE_HEARTBEAT_MS = 30_000;
  const PRESENCE_RESUME_SIGNAL_MS = 60_000;

  const PRESENCE_BY_SURFACE = Object.freeze({
    member: Object.freeze({ clientType: 'member', prefix: 'user.member.presence' }),
    points: Object.freeze({ clientType: 'points', prefix: 'user.pointcard.presence' }),
    event: Object.freeze({ clientType: 'event', prefix: 'user.event.presence' }),
    calendar: Object.freeze({ clientType: 'calendar', prefix: 'user.calendar.presence' }),
    booking: Object.freeze({ clientType: 'booking', prefix: 'user.booking.presence' })
  });

  const WRITE_ACTIONS = Object.freeze([
    'user.member.presence.online',
    'user.member.presence.offline',
    'user.member.presence.heartbeat',
    'user.pointcard.presence.online',
    'user.pointcard.presence.offline',
    'user.pointcard.presence.heartbeat',
    'user.event.presence.online',
    'user.event.presence.offline',
    'user.event.presence.heartbeat',
    'user.calendar.presence.online',
    'user.calendar.presence.offline',
    'user.calendar.presence.heartbeat',
    'user.booking.presence.online',
    'user.booking.presence.offline',
    'user.booking.presence.heartbeat',
    'user.member.profile.save',
    'user.member.terms.accept',
    'admin.terms.draft.save',
    'admin.terms.activate',
    'admin.member.update',
    'admin.member.remove',
    'admin.member-tiers.save',
    'admin.pointcards.save',
    'admin.pointcards.reorder',
    'admin.pointcards.archive',
    'admin.pointcards.delete',
    'admin.pointcards.remove',
    'admin.tickets.save',
    'admin.event-tickets.save',
    'admin.event-tickets.delete',
    'admin.calendar-items.save',
    'admin.calendar-items.delete',
    'admin.calendar-items.batch',
    'admin.stamps.add',
    'admin.service_minutes.add',
    'admin.member-grants.add',
    'admin.grant-message-presets.save',
    'user.pointcard.booking-selections.update',
    'user.event.booking-selections.update',
    'user.pointcard.ticket.redeem',
    'user.event.ticket.claim',
    'user.event.ticket.redeem',
    'member.referral.bind',
    'member.invitation.create',
    'member.invitation.retry',
    'user.member.invitation.claim',
    'points.transfer.create',
    'admin.booking.receipt.register',
    'admin.booking.receipt.dismiss'
  ]);

  function clientError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  // The legacy business API is a single-merchant data plane. A tenant URL must
  // never silently fall through to another merchant's existing membership data.
  function assertLegacyTenantScope() {
    const search = String(window.location?.search || '').replace(/^\?/, '');
    const isTenantScoped = search.split('&').some(segment => {
      if (!segment) return false;
      try { return decodeURIComponent(segment.split('=')[0].replace(/\+/g, ' ')).toLowerCase() === 'tenant'; }
      catch { return true; } // Malformed query keys fail closed.
    });
    if (isTenantScoped) {
      throw clientError('TENANT_NOT_READY', '此商家的會員資料環境尚未獨立開通，請由商家專用入口登入。');
    }
  }

  async function loadConfig() {
    assertLegacyTenantScope();
    let lastError, config;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // Same-origin absolute path is stable for LIFF callback URLs and /admin/ routes.
        const result = await fetchWithTimeout('/config.json', { cache: 'no-store' }, READ_TIMEOUT_MS, (response) => response.text());
        if (!result.response.ok) throw clientError('CONFIG_ERROR', '讀取 config.json 失敗。');
        config = JSON.parse(result.body);
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw clientError('CONFIG_ERROR', 'config.json 格式不正確。');
        break;
      } catch (error) {
        config = null;
        lastError = error && error.code === 'CONFIG_ERROR' ? error : clientError('CONFIG_ERROR', '無法讀取公開設定，請確認網路後重試。');
        if (attempt === 0) await wait(READ_RETRY_DELAY_MS);
      }
    }
    if (!config) throw lastError || clientError('CONFIG_ERROR', '無法讀取公開設定。');
    // Business discovery is separate from the public config request. Preserve
    // BUSINESS_NOT_FOUND / authorization errors instead of misreporting network failure.
    if (window.BusinessContext) await window.BusinessContext.configure(config);
    return config;
  }

  function validateConfig(config, surface) {
    const keys = { member: 'memberLiffId', points: 'pointsLiffId', admin: 'adminLiffId', event: 'eventLiffId', calendar: 'calendarLiffId', booking: 'bookingLiffId' };
    const key = keys[surface];
    const liffId = String(config && config[key] || '').trim();
    const supabaseUrl = String(config && config.supabaseUrl || '').trim();
    const functionUrl = String(config && config.supabaseFunctionUrl || '').trim();
    const publishableKey = String(config && config.supabasePublishableKey || '').trim();

    if (!SUPABASE_URL_PATTERN.test(supabaseUrl) || supabaseUrl.includes('REPLACE_')) {
      throw clientError('CONFIG_ERROR', '尚未設定 Supabase Project URL。');
    }
    if (!SUPABASE_FUNCTION_PATTERN.test(functionUrl) || functionUrl.includes('REPLACE_')) {
      throw clientError('CONFIG_ERROR', '尚未設定 Supabase Edge Function URL。');
    }
    if (surface === 'calendar') {
      const calendarFunctionUrl = String(config && config.memberCalendarFunctionUrl || '').trim();
      if (!SUPABASE_FUNCTION_PATTERN.test(calendarFunctionUrl) || calendarFunctionUrl.includes('REPLACE_')) {
        throw clientError('CONFIG_ERROR', '尚未設定會員日曆 Supabase Edge Function URL。');
      }
    }
    if (!publishableKey || publishableKey.includes('REPLACE_')) {
      throw clientError('CONFIG_ERROR', '尚未設定 Supabase Publishable Key。');
    }
    // Realtime is optional for initial authentication and API access. If the
    // SDK fails to load, subscribeRealtime uses authenticated periodic reads.
    if (!key || !liffId || liffId.includes('REPLACE_WITH_')) {
      const label = surface === 'admin' ? 'Admin' : surface === 'points' ? 'Points' : surface === 'event' ? 'Event' : surface === 'calendar' ? 'Calendar' : surface === 'booking' ? 'Booking' : 'Member';
      throw clientError('CONFIG_ERROR', `尚未設定 ${label} LIFF ID。`);
    }
    const ids = Object.values(keys).map((name) => String(config && config[name] || '').trim()).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw clientError('CONFIG_ERROR', '會員、集點卡、活動票券、日曆、預約與管理端必須使用不同的 LIFF ID。');
  }

  async function signIn(config, surface) {
    let idToken;
    if (surface !== 'admin' && window.TestModeClient && typeof window.TestModeClient.prepare === 'function') {
      const prepared = await window.TestModeClient.prepare(config, surface, () => lineSignIn(config, surface));
      idToken = String(prepared && prepared.idToken || '');
    } else {
      idToken = await lineSignIn(config, surface);
    }
    // Admin sessions are verified per request using the admin LINE channel
    // and server-side role; member single-device claims apply only to users.
    if (idToken && surface !== 'admin' && !(window.TestModeClient?.getSessionToken?.())) {
      await claimBrowserSession(config, surface, idToken);
    }
    sessions.set(surface, Object.freeze({ config, idToken: String(idToken || '') }));
    if (surface !== 'admin') await startPresence(config, surface, idToken);
    return idToken;
  }

  const LOGIN_BROWSER_KEY = 'member-login-browser-v1' + (window.BusinessContext?.slug ? ':'+window.BusinessContext.slug : '');
  const LOGIN_REGISTERED_KEY = 'member-login-registered-v1' + (window.BusinessContext?.slug ? ':'+window.BusinessContext.slug : '');

  function browserLoginKey() {
    try {
      let key = window.localStorage.getItem(LOGIN_BROWSER_KEY);
      if (!key) {
        key = window.crypto.randomUUID() + window.crypto.randomUUID();
        window.localStorage.setItem(LOGIN_BROWSER_KEY, key);
      }
      if (!/^[a-f0-9-]{72}$/.test(key)) throw new Error('invalid browser key');
      return key;
    } catch (_) {
      throw clientError('AUTH_STORAGE_UNAVAILABLE', '無法安全保存登入連線，請允許本網站使用瀏覽器儲存空間。');
    }
  }

  async function claimBrowserSession(config, surface, idToken) {
    const browserKey = browserLoginKey();
    // Opening a LINE LIFF is a new authenticated login attempt, not a
    // background resume. The server atomically replaces older browser grants
    // only when the newly verified ID token was issued later.
    const mode = 'login';
    const action = surface === 'admin' ? 'admin.session.claim' : 'user.' + surface + '.session.claim';
    await sendRequest(config, surface, idToken, action, { browserKey, mode });
    window.localStorage.setItem(LOGIN_REGISTERED_KEY, '1');
  }

  function getSession(surface) {
    const session = sessions.get(surface);
    if (!session) return null;
    return { config: session.config, idToken: session.idToken };
  }

  async function lineSignIn(config, surface) {
    validateConfig(config, surface);
    if (!window.liff) throw clientError('LIFF_SDK_ERROR', 'LIFF SDK 載入失敗，請確認網路後重試。');
    const liffId = surface === 'admin' ? config.adminLiffId : surface === 'points' ? config.pointsLiffId : surface === 'event' ? config.eventLiffId : surface === 'calendar' ? config.calendarLiffId : surface === 'booking' ? config.bookingLiffId : config.memberLiffId;

    try {
      await withTimeout(window.liff.init({ liffId }), 8000, 'LINE 初始化逾時，請重新開啟此頁面。');
    } catch (_) {
      throw clientError('LIFF_INIT_ERROR', 'LIFF 初始化失敗，請檢查 LIFF ID 與 Endpoint URL。');
    }

    const inLiffClient = typeof window.liff.isInClient === 'function' && window.liff.isInClient();
    if (inLiffClient) {
      if (!window.liff.isLoggedIn()) throw clientError('AUTH_REQUIRED', 'LINE LIFF 尚未完成登入，請重新開啟此 LIFF。');
    } else {
      const returned = consumeFreshLoginQuery(surface);
      if (!returned) {
        if (window.liff.isLoggedIn()) {
          try { window.liff.logout(); }
          catch (_) { throw clientError('AUTH_LOGOUT_FAILED', '無法清除先前的 LINE 登入，請重新開啟管理端。'); }
          if (window.liff.isLoggedIn()) throw clientError('AUTH_LOGOUT_FAILED', '先前的 LINE 登入尚未清除，請重新開啟管理端。');
        }
        redirectToFreshLogin(surface);
        await withTimeout(new Promise(() => {}), 8000, '登入跳轉未完成，請重新開啟此頁面。');
      }
      if (!window.liff.isLoggedIn()) {
        throw clientError('AUTH_REQUIRED', 'LINE 登入尚未完成，請重新整理後再登入。');
      }
    }

    const idToken = window.liff.getIDToken() || '';
    if (!idToken) throw clientError('AUTH_REQUIRED', '無法取得 LINE ID token，請確認 LIFF 已啟用 openid scope。');
    return idToken;
  }

  function redirectToFreshLogin(surface) {
    const redirectUrl = new URL(window.location.href);
    // Correlate this tab's redirect only; this is not an authentication token.
    let nonce;
    try {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      nonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      window.sessionStorage.setItem(`${FRESH_LOGIN_QUERY}:${surface}`, JSON.stringify({
        nonce, createdAt: Date.now(), pathname: redirectUrl.pathname,
      }));
    } catch (_) {
      throw clientError('AUTH_STORAGE_UNAVAILABLE', '無法建立本次 LINE 登入流程，請允許此網站使用瀏覽器工作階段儲存後重試。');
    }
    redirectUrl.searchParams.set(FRESH_LOGIN_QUERY, `${surface}.${nonce}`);
    window.liff.login({ redirectUri: redirectUrl.toString() });
  }

  function consumeFreshLoginQuery(surface) {
    const current = new URL(window.location.href);
    const marker = current.searchParams.get(FRESH_LOGIN_QUERY);
    if (marker !== null) {
      current.searchParams.delete(FRESH_LOGIN_QUERY);
      window.history.replaceState({}, document.title, current.pathname + current.search + current.hash);
    }
    let pending;
    try {
      const key = `${FRESH_LOGIN_QUERY}:${surface}`;
      const raw = window.sessionStorage.getItem(key);
      // Consume before accepting, so reloading or replaying the URL requires login.
      window.sessionStorage.removeItem(key);
      pending = raw ? JSON.parse(raw) : null;
    } catch (_) { return false; }
    const age = Date.now() - Number(pending && pending.createdAt);
    return Boolean(pending && /^[a-f0-9]{32}$/.test(pending.nonce)
      && marker === `${surface}.${pending.nonce}` && pending.pathname === current.pathname
      && Number.isFinite(age) && age >= 0 && age <= FRESH_LOGIN_MAX_AGE_MS);
  }

  function createPresenceSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') {
      throw clientError('PRESENCE_ID_UNAVAILABLE', '瀏覽器無法建立上下線紀錄識別。');
    }
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function currentPresenceIdToken(context) {
    // LINE may rotate the LIFF ID token during an existing browser session.
    // Only the token fingerprint claimed at login is granted server-side;
    // silently substituting a rotated token would falsely revoke this device.
    return String(context && context.idToken || '');
  }

  function clearPresenceHeartbeat() {
    if (presenceHeartbeatTimer !== null) {
      window.clearTimeout(presenceHeartbeatTimer);
      presenceHeartbeatTimer = null;
    }
  }

  function schedulePresenceHeartbeat() {
    clearPresenceHeartbeat();
    if (!presenceContext || presenceContext.closed) return;
    presenceHeartbeatTimer = window.setTimeout(() => {
      presenceHeartbeatTimer = null;
      void heartbeatPresence();
    }, PRESENCE_HEARTBEAT_MS);
  }

  async function heartbeatPresence() {
    const context = presenceContext;
    if (!context || context.closed) return;
    try {
      if (!context.onlineRecorded) {
        await startPresence(context.config, context.surface, currentPresenceIdToken(context), 'relogin');
        return;
      }
      await withTimeout(sendRequest(context.config, context.clientType, currentPresenceIdToken(context), context.prefix + '.heartbeat', {
        sessionId: context.sessionId,
        reason: 'heartbeat'
      }), 1200, '上線狀態同步逾時。');
      context.lastSeenSignalAt = Date.now();
    } catch (error) {
      console.warn('presence heartbeat failed', error);
    } finally {
      schedulePresenceHeartbeat();
    }
  }

  function bindPresenceLifecycle() {
    if (presenceHooksBound) return;
    presenceHooksBound = true;
    window.addEventListener('pagehide', (event) => {
      clearPresenceHeartbeat();
      void stopPresence(event && event.persisted ? 'bfcache' : 'pagehide', true);
    });
    window.addEventListener('pageshow', (event) => {
      if (!event || !event.persisted || !presenceContext || !presenceContext.closed) return;
      const previous = presenceContext;
      presenceContext = null;
      void startPresence(previous.config, previous.surface, currentPresenceIdToken(previous), 'resume');
    });
    document.addEventListener('visibilitychange', () => {
      const context = presenceContext;
      if (!context) return;
      // LINE WebView may become hidden without firing pagehide when the LIFF page is closed.
      if (document.visibilityState !== 'visible') {
        void stopPresence('hidden', true);
        return;
      }
      // Use a fresh ID so a delayed offline beacon cannot close the resumed session.
      if (context.closed) {
        presenceContext = null;
        void startPresence(context.config, context.surface, currentPresenceIdToken(context), 'resume');
        return;
      }
      if (Date.now() - Number(context.lastSeenSignalAt || 0) >= PRESENCE_RESUME_SIGNAL_MS) {
        context.onlineRecorded = false;
        void startPresence(context.config, context.surface, currentPresenceIdToken(context), 'resume');
      } else {
        void heartbeatPresence();
      }
    });
  }

  async function startPresence(config, surface, idToken, reason = 'signin') {
    const definition = PRESENCE_BY_SURFACE[surface];
    if (!definition) return;
    if (presenceContext && !presenceContext.closed && presenceContext.surface === surface) {
      if (presenceContext.onlineRecorded) return;
      try {
        await withTimeout(sendRequest(config, definition.clientType, idToken, definition.prefix + '.online', {
          sessionId: presenceContext.sessionId,
          reason
        }), 1200, '上線紀錄逾時。');
        presenceContext.onlineRecorded = true;
        presenceContext.lastSeenSignalAt = Date.now();
        schedulePresenceHeartbeat();
      } catch (error) {
        console.warn('presence online record failed', error);
      }
      return;
    }

    const context = {
      config,
      surface,
      clientType: definition.clientType,
      prefix: definition.prefix,
      idToken: String(idToken || ''),
      sessionId: createPresenceSessionId(),
      onlineRecorded: false,
      lastSeenSignalAt: 0,
      closed: false
    };
    presenceContext = context;
    bindPresenceLifecycle();
    try {
      await withTimeout(sendRequest(config, context.clientType, context.idToken, context.prefix + '.online', {
        sessionId: context.sessionId,
        reason
      }), 1200, '上線紀錄逾時。');
      context.onlineRecorded = true;
      context.lastSeenSignalAt = Date.now();
    } catch (error) {
      console.warn('presence online record failed', error);
    } finally {
      schedulePresenceHeartbeat();
    }
  }

  function sendPresenceKeepalive(context, reason) {
    try {
      validateConfig(context.config, context.clientType);
      const endpoint = requestEndpoint(context.config, context.clientType, context.prefix + '.offline');
      if (!SUPABASE_FUNCTION_PATTERN.test(endpoint) || endpoint.includes('REPLACE_')) return Promise.resolve(null);
      const payload = {
        sessionId: context.sessionId,
        reason,
        action: context.prefix + '.offline',
        clientType: context.clientType,
        idToken: currentPresenceIdToken(context)
      };
      const body = window.TestModeClient && typeof window.TestModeClient.payload === 'function'
        ? window.TestModeClient.payload(payload)
        : payload;
      // Send a simple POST to avoid CORS preflight during WebView teardown.
      // The Edge Function has verify_jwt=false and authenticates the LINE/test token in the body.
      const jsonBody = JSON.stringify(body);
      if (navigator && typeof navigator.sendBeacon === 'function') {
        const beaconBody = new Blob([jsonBody], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(endpoint, beaconBody)) return Promise.resolve(true);
      }
      return fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        cache: 'no-store',
        keepalive: true,
        body: jsonBody
      }).catch(() => null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  async function stopPresence(reason = 'pagehide', keepalive = false) {
    const context = presenceContext;
    if (!context || context.closed) return;
    clearPresenceHeartbeat();
    context.closed = true;
    if (keepalive) {
      await sendPresenceKeepalive(context, reason);
      return;
    }
    try {
      await sendRequest(context.config, context.clientType, currentPresenceIdToken(context), context.prefix + '.offline', {
        sessionId: context.sessionId,
        reason
      });
    } catch (error) {
      console.warn('presence offline record failed', error);
    }
  }

  function request(config, clientType, idToken, action, payload = {}) {
    const isWrite = action === 'user.member.card.open' || action.endsWith('.session.claim') || action.endsWith('.session.logout') || WRITE_ACTIONS.includes(action) || ['admin.settings.copy','admin.ticket-visibility.save','member.friend.request','member.friend.accept','member.friend.remove','member.friend.block'].includes(action);
    if (isWrite) {
      pendingReads.clear();
      return sendRequest(config, clientType, idToken, action, payload).finally(() => pendingReads.clear());
    }
    const endpoint = requestEndpoint(config, clientType, action);
    const testSessionToken = window.TestModeClient && typeof window.TestModeClient.getSessionToken === 'function' ? window.TestModeClient.getSessionToken() : '';
    const key = JSON.stringify([endpoint, clientType, idToken, testSessionToken, action, payload]);
    if (pendingReads.has(key)) return pendingReads.get(key);
    const pending = sendRequest(config, clientType, idToken, action, payload).finally(() => {
      if (pendingReads.get(key) === pending) pendingReads.delete(key);
    });
    pendingReads.set(key, pending);
    return pending;
  }

  function requestEndpoint(config, clientType, action) {
    if (String(action || '').startsWith('member.friend.') || String(action || '').startsWith('member.invitation.') || ['event.today-usable','member.referral.bind','points.transfer.options','points.transfer.receiver','points.transfer.create'].includes(action)) {
      return String(config.memberGrowthFunctionUrl || '').trim()
        || String(config.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/member-growth-api';
    }
    if (clientType === 'admin' && String(action || '').startsWith('admin.booking.receipt.')) {
      return String(config.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/booking-receipt-api';
    }
    if (clientType === 'member' && (action === 'user.member.bootstrap' || action === 'user.member.profile.save' || action === 'user.member.terms.accept' || action === 'user.member.card.open' || action === 'user.member.invitation.claim' || action === 'user.member.oa.check')) {
      return String(config.memberProfileFunctionUrl || '').trim()
        || String(config.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/member-profile-api';
    }
    if (clientType === 'calendar' && (action === 'user.calendar.bootstrap' || action === 'user.calendar.date.details')) {
      return String(config.memberCalendarFunctionUrl || '').trim();
    }
    return String(config.previewApiFunctionUrl || config.supabaseFunctionUrl || '').trim();
  }

  async function sendRequest(config, clientType, idToken, action, payload) {
    assertLegacyTenantScope();
    if (isTerminatingAccess) throw clientError('SESSION_REVOKED', '連線已結束，請重新登入。');
    validateConfig(config, clientType);
    const endpoint = requestEndpoint(config, clientType, action);
    if (!SUPABASE_FUNCTION_PATTERN.test(endpoint) || endpoint.includes('REPLACE_')) {
      throw clientError('CONFIG_ERROR', '此功能的 Supabase Edge Function URL 尚未設定。');
    }
    // LINE ID token authenticates identity, but the first membership join also
    // needs a user access token for the server to check the linked member OA.
    // Never persist this token or attach it to unrelated member requests.
    const verifiedJoinPayload = (action === 'user.member.profile.save' && payload?.accepted === true) || action === 'user.member.oa.check'
      ? { ...payload, lineAccessToken: typeof window.liff?.getAccessToken === 'function' ? (window.liff.getAccessToken() || '') : '' }
      : payload;
    const isWrite = action.endsWith('.session.claim') || action.endsWith('.session.logout') || WRITE_ACTIONS.includes(action) || ['admin.settings.copy','admin.ticket-visibility.save','member.friend.request','member.friend.accept','member.friend.remove','member.friend.block'].includes(action);
    const timeoutMs = isWrite ? WRITE_TIMEOUT_MS : isFullBootstrap(clientType, action, payload) ? BOOTSTRAP_TIMEOUT_MS : READ_TIMEOUT_MS;
    const attempts = isWrite ? 1 : 2;
    const deadline = Date.now() + timeoutMs;
    let lastError;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const remaining = isWrite ? WRITE_TIMEOUT_MS : Math.max(1, deadline - Date.now());
      if (!isWrite && remaining <= 1 && attempt > 0) break;
      try {
        const fetched = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': String(config.supabasePublishableKey)
          },
          cache: 'no-store',
          body: JSON.stringify(window.TestModeClient && typeof window.TestModeClient.payload === 'function'
            ? window.TestModeClient.payload({ ...verifiedJoinPayload, action, clientType, idToken })
            : { ...verifiedJoinPayload, action, clientType, idToken })
        }, remaining, (response) => response.text());

        let data;
        try { data = JSON.parse(fetched.body); }
        catch {
          throw clientError(isWrite ? 'API_RESPONSE_UNCERTAIN' : 'API_RESPONSE_ERROR',
            isWrite ? '無法確認這次操作的回應；資料可能已更新，請先重新整理確認，請勿重複送出。' : '資料服務暫時未正常回應。');
        }

        if (!data || data.ok !== true) {
          const error = clientError(data && data.error && data.error.code || 'API_ERROR', data && data.error && data.error.message || '資料服務拒絕此請求。');
          error.status = Number(data && data.status || fetched.response.status || 0);
          error.details = data && data.error && data.error.details || null;
          if (['SESSION_REVOKED', 'SESSION_REPLACED', 'MEMBER_REMOVED', 'SYSTEM_MAINTENANCE'].includes(error.code)) {
            terminateAccessSession(error.code, error.message);
          }
          throw error;
        }
        if (isTerminatingAccess) throw clientError('SESSION_REVOKED', '連線已結束，請重新登入。');
        return data.data || {};
      } catch (error) {
        if (error && error.code && !['REQUEST_TIMEOUT', 'NETWORK_ERROR', 'API_RESPONSE_ERROR'].includes(error.code)) throw error;
        const timedOut = Boolean(error && error.code === 'REQUEST_TIMEOUT');
        lastError = clientError(
          isWrite ? 'API_RESPONSE_UNCERTAIN' : timedOut ? 'SERVICE_TIMEOUT' : 'NETWORK_ERROR',
          isWrite
            ? '無法確認這次操作是否已送達；資料可能已更新，請先重新整理確認，請勿重複送出。'
            : timedOut ? '資料服務回應時間較長，已停止等待；請重新整理後再試。' : '目前無法連線資料服務，請檢查網路後重試。'
        );
      }
      const retryDelay = READ_RETRY_DELAY_MS * (attempt + 1);
      if (attempt < attempts - 1 && (isWrite || Date.now() + retryDelay < deadline)) await wait(retryDelay);
      else break;
    }
    throw lastError || clientError('API_RESPONSE_ERROR', '資料服務暫時未正常回應。');
  }

  function isFullBootstrap(clientType, action, payload) {
    if (action === 'admin.bootstrap') return clientType === 'admin' && !Boolean(payload && payload.lazy);
    return ({ member: 'user.member.bootstrap', points: 'user.pointcard.bootstrap', event: 'user.event.bootstrap', calendar: 'user.calendar.bootstrap' })[clientType] === action;
  }

  function realtimeClientFor(config) {
    if (config.realtimeEnabled === false) return null;
    const key = String(config.supabaseUrl) + '|' + String(config.supabasePublishableKey);
    if (realtimeClient && realtimeClientKey === key) return realtimeClient;
    if (!window.supabase || typeof window.supabase.createClient !== 'function') return null;
    realtimeClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    });
    realtimeClientKey = key;
    return realtimeClient;
  }

  function emitRealtimeEvent(name, detail) {
    if (typeof window.CustomEvent !== 'function' || typeof window.dispatchEvent !== 'function') return;
    try { window.dispatchEvent(new window.CustomEvent(name, { detail: Object.freeze({ ...detail }) })); } catch (_) {}
  }

  function getRealtimeStatus(clientType) {
    return String(realtimeStatuses.get(String(clientType || '')) || '');
  }

  function subscribeRealtime(config, clientType, onUpdate) {
    validateConfig(config, clientType);
    if (config.realtimeEnabled === false || typeof onUpdate !== 'function') return () => {};
    const existing = realtimeSubscriptions.get(clientType);
    if (existing) return existing.unsubscribe;
    let disposed = false;
    // Broadcast is only an invalidation hint; authorization is checked by the
    // server for the current user, never inferred from an untrusted event.
    let sessionCheckPending = false;
    let sessionCheckQueued = false;
    let sessionCheckGeneration = 0;
    let pendingSessionGeneration = 0;
    const verifyCurrentLogin = (queueIfPending = true) => {
      if (disposed || clientType === 'admin' || isTerminatingAccess) return;
      if (sessionCheckPending) {
        if (queueIfPending || pendingSessionGeneration !== sessionCheckGeneration) sessionCheckQueued = true;
        return;
      }
      const active = sessions.get(clientType);
      if (!active || !active.idToken) return;
      sessionCheckPending = true;
      pendingSessionGeneration = sessionCheckGeneration;
      void sendRequest(active.config, clientType, active.idToken,
        'user.' + clientType + '.session.status', {}).catch(() => {}).finally(() => {
        sessionCheckPending = false;
        if (sessionCheckQueued && !disposed && !isTerminatingAccess) {
          sessionCheckQueued = false;
          verifyCurrentLogin();
        }
      });
    };
    // Private business schemas use authenticated reconciliation. No shared
    // broadcast channel or anonymous subscription can carry another shop's data.
    const client = config.business ? null : realtimeClientFor(config);
    if (config.business) {
      // Private schemas never subscribe to the shared anonymous event feed.
      // Read an authorized opaque revision; reload full data only on change.
      let timer, pending = false, queued = false, revision, lastFullAt = -Infinity;
      let failures = 0, probes = 0, refreshes = 0;
      const paused = () => document.visibilityState === 'hidden'
        || (typeof navigator !== 'undefined' && navigator.onLine === false);
      const status = value => {
        if (disposed || realtimeStatuses.get(clientType) === value) return;
        realtimeStatuses.set(clientType, value);
        emitRealtimeEvent('member-system:realtime-status', {clientType,status:value});
      };
      const schedule = delay => {
        if (disposed) return;
        if (timer !== undefined) window.clearTimeout(timer);
        timer = window.setTimeout(() => { timer = undefined; void probe(); }, delay);
      };
      const probe = async () => {
        if (disposed || paused()) return;
        if (pending) { queued = true; return; }
        const active = sessions.get(clientType);
        if (!active?.idToken) { schedule(10000); return; }
        pending = true;
        const started = Date.now();
        try {
          probes++;
          const action = clientType === 'admin' ? 'admin.sync.status' : 'user.' + clientType + '.sync.status';
          const current = await sendRequest(active.config, clientType, active.idToken, action, {business:config.business});
          if (disposed) return;
          if (typeof current.revision !== 'string' || current.revision.length > 120) throw Error('INVALID_SYNC_REVISION');
          const changed = revision !== current.revision || Date.now() - lastFullAt >= 120000;
          if (changed) {
            // Child booking/receipt modules consume the same invalidation feed.
            emitRealtimeEvent('member-system:realtime-invalidation', {clientType,scope:clientType,eventType:clientType === 'admin' ? 'booking.receipt.reconcile' : 'business.reconcile'});
            await onUpdate({clientType,eventTypes:[],reasons:['revision-changed']});
            if (disposed) return;
            revision = current.revision; lastFullAt = Date.now(); refreshes++;
          }
          failures = 0; status('SUBSCRIBED');
          emitRealtimeEvent('member-system:sync-metrics', {clientType,transport:'authenticated-revision',durationMs:Date.now()-started,changed,probes,refreshes});
        } catch (_) { failures++; status('CHANNEL_ERROR'); }
        finally {
          pending = false;
          if (!disposed) { const next = queued ? 0 : Math.min(60000,10000 * 2 ** Math.min(failures,3)); queued = false; schedule(next); }
        }
      };
      const resume = () => { if (!paused()) { if (pending) queued = true; else schedule(0); } };
      document.addEventListener('visibilitychange', resume);
      window.addEventListener('pageshow', resume);
      window.addEventListener('online', resume);
      const unsubscribe = () => {
        if (disposed) return; disposed = true;
        if (timer !== undefined) window.clearTimeout(timer);
        document.removeEventListener('visibilitychange', resume);
        window.removeEventListener('pageshow', resume);
        window.removeEventListener('online', resume);
        realtimeSubscriptions.delete(clientType); realtimeStatuses.delete(clientType);
        emitRealtimeEvent('member-system:realtime-status', {clientType,status:'CLOSED'});
      };
      realtimeSubscriptions.set(clientType,{unsubscribe}); status('SYNCING'); schedule(0);
      return unsubscribe;
    }
    if (!client) {
      // When the Realtime SDK/CDN is unavailable, keep member data synchronized
      // through the existing authenticated bootstrap instead of requiring reload.
      let pending = false;
      const refresh = () => {
        if (disposed || document.visibilityState === 'hidden' ||
          (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
        verifyCurrentLogin(false);
        if (pending) return;
        pending = true;
        Promise.resolve().then(() => {
          if (!disposed) return onUpdate({ clientType, eventTypes: [], reasons: ['periodic-reconcile'] });
        }).catch(() => {}).finally(() => { pending = false; });
      };
      const interval = typeof window.setInterval === 'function'
        ? window.setInterval(refresh, 30000) : undefined;
      const onResume = (event) => {
        if (document.visibilityState === 'hidden' || event?.persisted) sessionCheckGeneration += 1;
        refresh();
      };
      document.addEventListener('visibilitychange', onResume);
      window.addEventListener('pageshow', onResume);
      window.addEventListener('online', onResume);
      const unsubscribe = () => {
        if (disposed) return;
        disposed = true;
        if (interval !== undefined) window.clearInterval(interval);
        document.removeEventListener('visibilitychange', onResume);
        window.removeEventListener('pageshow', onResume);
        window.removeEventListener('online', onResume);
        realtimeSubscriptions.delete(clientType);
      };
      realtimeSubscriptions.set(clientType, { unsubscribe });
      return unsubscribe;
    }

    let timer;
    let pending = false;
    let queued = false;
    let lastRefreshAt = -Infinity;
    let subscribedOnce = false;
    let safetySyncTimer;
    const SAFETY_SYNC_MS = 30000;
    const queuedEventTypes = new Set();
    const queuedReasons = new Set();
    const hasActiveTestSession = () => {
      try {
        return Boolean(window.TestModeClient
          && typeof window.TestModeClient.getSessionToken === 'function'
          && window.TestModeClient.getSessionToken());
      } catch (_) {
        return false;
      }
    };
    // Production clients pause background refreshes to control traffic. Paired E2E
    // uses real background windows, so test sessions must keep consuming Realtime.
    const isPaused = () => (document.visibilityState === 'hidden' && !hasActiveTestSession())
      || (typeof navigator !== 'undefined' && navigator.onLine === false);

    // Realtime, reconnect and page-resume signals share one refresh queue.
    // Preserve one trailing refresh when data changes during an active request.
    const schedule = (delayMs = 650, context = {}) => {
      if (disposed) return;
      const eventType = String(context.eventType || '').trim();
      const reason = String(context.reason || '').trim();
      if (eventType) queuedEventTypes.add(eventType);
      if (reason) queuedReasons.add(reason);
      queued = true;
      if (pending || timer !== undefined || isPaused()) return;
      const waitMs = Math.max(delayMs, 1500 - (Date.now() - lastRefreshAt));
      timer = window.setTimeout(runRefresh, waitMs);
    };
    const runRefresh = () => {
      timer = undefined;
      if (disposed || isPaused() || pending) return;
      queued = false;
      pending = true;
      lastRefreshAt = Date.now();
      const context = Object.freeze({
        clientType,
        eventTypes: Object.freeze([...queuedEventTypes]),
        reasons: Object.freeze([...queuedReasons]),
      });
      queuedEventTypes.clear();
      queuedReasons.clear();
      Promise.resolve().then(() => {
        if (!disposed) return onUpdate(context);
      }).catch(() => {}).finally(() => {
        pending = false;
        if (queued && !disposed) schedule(0);
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        verifyCurrentLogin(false);
        schedule(0, { reason: 'visibility' });
      } else sessionCheckGeneration += 1;
    };
    const onPageShow = (event) => {
      if (event?.persisted) sessionCheckGeneration += 1;
      verifyCurrentLogin(false);
      schedule(0, { reason: event && event.persisted ? 'bfcache' : 'pageshow' });
    };
    const onOnline = () => {
      verifyCurrentLogin(false);
      schedule(0, { reason: 'online' });
    };
    // Safety net for lost Realtime messages or a disconnected mobile WebSocket.
    // It refreshes only while the application is visible; background LIFF tabs do
    // not poll. The normal Realtime path still invalidates immediately.
    // setInterval is native in the deployed browser; unit-test timer shims only
    // implement setTimeout and should not count the independent reconciliation clock.
    if (typeof window.setInterval === 'function') {
      safetySyncTimer = window.setInterval(() => {
        if (!disposed && !isPaused()) {
          verifyCurrentLogin(false);
          schedule(0, { reason: 'periodic-reconcile' });
        }
      }, SAFETY_SYNC_MS);
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);

    const channel = client
      .channel(`member-system-${clientType}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'realtime_events' }, (payload) => {
        const row = payload && payload.new && typeof payload.new === 'object' ? payload.new : {};
        const scope = String(row.scope || '');
        if (scope !== 'all' && scope !== clientType) return;
        const eventType = String(row.event_type || '');
        emitRealtimeEvent('member-system:realtime-invalidation', { clientType, scope, eventType });
        if (eventType === 'member.login.replaced') verifyCurrentLogin();
        else schedule(650, { reason: 'realtime', eventType });
      })
      .subscribe((status) => {
        const nextStatus = String(status || '');
        realtimeStatuses.set(clientType, nextStatus);
        emitRealtimeEvent('member-system:realtime-status', { clientType, status: nextStatus });
        if (status !== 'SUBSCRIBED') {
          // Do not rely on a full page reload when mobile Realtime disconnects.
          schedule(0, { reason: 'realtime-disconnected' });
          return;
        }
        if (subscribedOnce) {
          verifyCurrentLogin(false);
          schedule(0, { reason: 'reconnect' });
        } else subscribedOnce = true;
      });

    const unsubscribe = () => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (safetySyncTimer !== undefined) window.clearInterval(safetySyncTimer);
      queued = false;
      queuedEventTypes.clear();
      queuedReasons.clear();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
      realtimeSubscriptions.delete(clientType);
      realtimeStatuses.delete(clientType);
      emitRealtimeEvent('member-system:realtime-status', { clientType, status: 'CLOSED' });
      try { Promise.resolve(client.removeChannel(channel)).catch(() => {}); } catch (_) {}
    };
    realtimeSubscriptions.set(clientType, { unsubscribe });
    return unsubscribe;
  }

  async function fetchWithTimeout(url, options, timeoutMs, readBody) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const schedule = typeof window.setTimeout === 'function' ? window.setTimeout.bind(window) : typeof setTimeout === 'function' ? setTimeout : null;
    const cancel = typeof window.clearTimeout === 'function' ? window.clearTimeout.bind(window) : typeof clearTimeout === 'function' ? clearTimeout : null;
    let timer;
    const requestOptions = controller ? { ...options, signal: controller.signal } : options;
    if (!schedule) throw clientError('NETWORK_ERROR', '瀏覽器不支援計時器。');
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch(url, requestOptions);
          return { response, body: typeof readBody === 'function' ? await readBody(response) : undefined };
        })(),
        new Promise((_, reject) => {
          timer = schedule(() => {
            if (controller) controller.abort();
            reject(clientError('REQUEST_TIMEOUT', '資料服務回應逾時。'));
          }, timeoutMs);
        })
      ]);
    } catch (error) {
      if (error && error.code) throw error;
      throw clientError('NETWORK_ERROR', '目前無法連線資料服務。');
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }

  function withTimeout(promise, timeoutMs, message) {
    const schedule = typeof window.setTimeout === 'function' ? window.setTimeout.bind(window) : typeof setTimeout === 'function' ? setTimeout : null;
    const cancel = typeof window.clearTimeout === 'function' ? window.clearTimeout.bind(window) : typeof clearTimeout === 'function' ? clearTimeout : null;
    if (!schedule) return promise;
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = schedule(() => reject(clientError('REQUEST_TIMEOUT', message || '等待逾時。')), timeoutMs); })
    ]).finally(() => { if (timer !== undefined && cancel) cancel(timer); });
  }

  function wait(ms) {
    const schedule = typeof window.setTimeout === 'function' ? window.setTimeout.bind(window) : typeof setTimeout === 'function' ? setTimeout : null;
    return schedule ? new Promise((resolve) => schedule(resolve, ms)) : Promise.resolve();
  }

  function bindDialogKeyboard() {
    // 保留既有呼叫介面；焦點管理統一由共用 dialog-accessibility.js 初始化。
  }

  function terminateAccessSession(code, message) {
    if (isTerminatingAccess) return;
    isTerminatingAccess = true;
    if (typeof window.CustomEvent === 'function' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new window.CustomEvent('member:access-ended', { detail: { code } }));
    document.querySelectorAll?.('[role=dialog], #memberView, #pointsView, #eventView, #calendarView, #bookingView, #adminView').forEach(node => node.classList.add('hidden'));
    if (['SESSION_REPLACED', 'SESSION_REVOKED', 'MEMBER_REMOVED'].includes(code)) {
      try { window.localStorage.setItem(LOGIN_REGISTERED_KEY, 'replaced'); } catch (_) {}
    }
    for (const entry of realtimeSubscriptions.values()) {
      try { entry.unsubscribe(); } catch (_) {}
    }
    pendingReads.clear();
    sessions.clear();
    clearPresenceHeartbeat();
    if (presenceContext) presenceContext.closed = true;
    if (window.TestModeClient && typeof window.TestModeClient.clearSession === 'function') {
      try { window.TestModeClient.clearSession(); } catch (_) {}
    }

    const isRevoked = ['SESSION_REVOKED', 'SESSION_REPLACED', 'MEMBER_REMOVED'].includes(code);
    const notice = isRevoked
      ? (String(message || '').trim() || '您的登入工作階段已由管理員強制結束，請重新登入。')
      : (String(message || '').trim() || '系統目前維護中，將關閉此頁面。');

    try { window.alert(notice); } catch (_) {}

    if (window.liff && typeof window.liff.isLoggedIn === 'function' && window.liff.isLoggedIn()) {
      try { window.liff.logout(); } catch (_) {}
    }

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

  async function logout() {
    try {
      const active = [...sessions.entries()].find(([_, value]) => value && value.idToken);
      if (active && active[0] !== 'admin') {
        const [surface, value] = active;
        try {
          await sendRequest(value.config, surface, value.idToken,
            'user.' + surface + '.session.logout', {});
        } catch (_) {}
      }
      try { await withTimeout(stopPresence('logout', true), 1200, '上下線紀錄逾時。'); } catch (_) {}
      try { window.localStorage.removeItem(LOGIN_REGISTERED_KEY); window.localStorage.removeItem(LOGIN_BROWSER_KEY); } catch (_) {}
      sessions.clear();
      if (window.TestModeClient && typeof window.TestModeClient.clearSession === 'function') window.TestModeClient.clearSession();
      if (window.liff && window.liff.isLoggedIn()) window.liff.logout();
    } finally { window.location.reload(); }
  }

  function openMemberJoin(config) {
    const memberLiffId = String(config && config.memberLiffId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(memberLiffId)) return false;
    const url = `https://liff.line.me/${encodeURIComponent(memberLiffId)}` + (config.business ? `?business=${encodeURIComponent(config.business)}` : "");
    if (window.liff && typeof window.liff.openWindow === 'function') {
      window.liff.openWindow({ url, external: false });
      return true;
    }
    window.location.assign(url);
    return true;
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value ? String(value) : '—';
    return new Intl.DateTimeFormat('zh-Hant-TW', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value ? String(value) : '—';
    return new Intl.DateTimeFormat('zh-Hant-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function initials(name) {
    const text = String(name || '會員').trim();
    return Array.from(text).slice(0, 2).join('') || '會員';
  }


  function purgeLegacySyncCache() {
    const cleanupKey = 'lumen-legacy-sync-cache-cleaned-v1';
    try {
      if (window.localStorage?.getItem(cleanupKey) === '1') return;
      if (!window.indexedDB || typeof window.indexedDB.deleteDatabase !== 'function') {
        window.localStorage?.setItem(cleanupKey, '1');
        return;
      }
      const request = window.indexedDB.deleteDatabase('MembershipSystemSyncCache');
      if (request && typeof request === 'object') {
        request.onsuccess = () => { try { window.localStorage?.setItem(cleanupKey, '1'); } catch (_) {} };
      }
    } catch (_) {}
  }

  purgeLegacySyncCache();

  window.MemberSystem = Object.freeze({
    bindDialogKeyboard, clientError, loadConfig, validateConfig, signIn, getSession, request,
    subscribeRealtime, getRealtimeStatus, logout, terminateAccessSession, openMemberJoin, formatDate, formatDateTime, initials
  });
})();

