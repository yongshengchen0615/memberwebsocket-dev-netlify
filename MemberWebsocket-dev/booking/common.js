(() => {
  'use strict';

  const REQUEST_TIMEOUT_MS = 15000;
  const MIN_RESYNC_INTERVAL_MS = 1500;
  const WRITE_ACTIONS = new Set([
    'user.booking.create',
    'user.booking.update',
    'user.booking.cancel',
    'admin.booking.settings.save',
    'admin.booking.service.save',
    'admin.booking.status.update',
    'user.booking.receipt.prepare',
    'user.booking.receipt.finalize',
    'user.booking.receipt.cancel',
  ]);
  // Share only reads that are already safe to repeat. Never merge mutations or
  // login status checks: a takeover during a check needs a fresh server result.
  const SHARED_READ_ACTIONS = new Set([
    'user.booking.bootstrap', 'user.booking.slots', 'user.booking.benefits',
    'user.booking.receipt.list', 'user.booking.receipt.options', 'user.member.bootstrap',
  ]);
  const pendingReads = new Map();
  const realtimeSubscriptions = new Map();
  let realtimeClient = null;
  let realtimeClientKey = '';
  let publicNoticeClient = null;
  let publicNoticeSequence = 0;
  let presenceContext = null;
  let authenticatedSession = null;
  let presenceHooksBound = false;
  let presenceHeartbeatTimer = null;
  let isTerminatingAccess = false;
  const PRESENCE_HEARTBEAT_MS = 30_000;
  const PRESENCE_RESUME_SIGNAL_MS = 60_000;

  function clientError(code, message, details = null) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  async function loadConfig() {
    const depth = window.location.pathname.includes('/booking/admin/') ? '../../config.json' : '../config.json';
    const response = await fetch(`${depth}?v=booking-20260910-3`, { cache: 'no-store' });
    if (!response.ok) throw clientError('CONFIG_LOAD_FAILED', '無法載入系統設定。');
    const config = await response.json();
    if (!config.supabaseUrl || !config.supabasePublishableKey) throw clientError('CONFIG_INVALID', 'Supabase 設定不完整。');
    if(window.BusinessContext)await window.BusinessContext.configure(config);
    return config;
  }

  async function signIn(config, clientType) {
    const isAdmin = clientType === 'admin';
    const isBooking = clientType === 'booking';
    const liffId = isAdmin ? config.adminLiffId : isBooking ? config.bookingLiffId : config.memberLiffId;
    const label = isAdmin ? '管理端' : isBooking ? '預約' : '會員';
    if (!liffId) throw clientError('LIFF_CONFIG_MISSING', `尚未設定${label} LIFF ID。`);
    if (!window.liff) throw clientError('LIFF_SDK_MISSING', 'LINE LIFF SDK 尚未載入。');
    await window.liff.init({ liffId });
    if (!window.liff.isLoggedIn()) {
      window.liff.login({ redirectUri: window.location.href });
      return new Promise(() => {});
    }
    const idToken = window.liff.getIDToken();
    if (!idToken) throw clientError('LIFF_ID_TOKEN_MISSING', '無法取得 LINE 登入憑證，請重新登入。');
    return await completeSignIn(config, clientType, idToken);
  }

  // Shared completion for standard signIn() and booking/liff-fresh-login.js.
  // Claim first, then bind the exact granted token for booking receipts,
  // snapshot geofences, and resumed WebViews; never infer authentication
  // from Presence, which intentionally ends when LINE is backgrounded.
  async function completeSignIn(config, clientType, idToken) {
    if (clientType === 'admin') return idToken;
    if (clientType !== 'booking' && clientType !== 'member') {
      throw clientError('CLIENT_TYPE_MISMATCH', '登入頁面類型不正確。');
    }
    if (isTerminatingAccess) throw clientError('SESSION_REVOKED', '連線已結束，請重新登入。');
    const token = String(idToken || '');
    const isTestSession = Boolean(window.TestModeClient?.getSessionToken?.());
    if (!token && !isTestSession) throw clientError('AUTH_REQUIRED', '無法取得 LINE 登入憑證，請重新登入。');
    if (!isTestSession) await claimBrowserSession(config, clientType, token);
    authenticatedSession = { config, idToken: token };
    if (clientType === 'booking') await startPresence(config, clientType, token);
    return token;
  }

  const LOGIN_BROWSER_KEY = 'member-login-browser-v1' + (window.BusinessContext?.slug ? ':'+window.BusinessContext.slug : '');
  const LOGIN_REGISTERED_KEY = 'member-login-registered-v1' + (window.BusinessContext?.slug ? ':'+window.BusinessContext.slug : '');

  async function claimBrowserSession(config, clientType, idToken) {
    if (clientType === 'admin') return;
    let key;
    try {
      key = window.localStorage.getItem(LOGIN_BROWSER_KEY);
      if (!key) {
        key = window.crypto.randomUUID() + window.crypto.randomUUID();
        window.localStorage.setItem(LOGIN_BROWSER_KEY, key);
      }
      if (!/^[a-f0-9-]{72}$/.test(key)) throw new Error('invalid browser key');
    } catch (_) {
      throw clientError('AUTH_STORAGE_UNAVAILABLE', '無法安全保存登入連線，請允許本網站使用瀏覽器儲存空間。');
    }
    // New authenticated LIFF entry always claims a new login, silently.
    // An outdated LINE token cannot take over: the database rejects stale iat.
    await postJson(String(config.supabaseUrl).replace(/\/$/, '') + '/functions/v1/api', config,
      { action:'user.' + clientType + '.session.claim', clientType, idToken, browserKey:key, mode:'login' },
      '登入連線', { write:true });
    window.localStorage.setItem(LOGIN_REGISTERED_KEY, '1');
  }

  async function sendMemberChatMessage(message) {
    const text = String(message || '').trim().slice(0, 4800);
    if (!text) return { sent: false, reason: 'empty' };
    if (!window.liff || typeof window.liff.isInClient !== 'function' || !window.liff.isInClient()) {
      return { sent: false, reason: 'not_in_line_chat' };
    }
    if (typeof window.liff.sendMessages !== 'function') {
      return { sent: false, reason: 'send_messages_unavailable' };
    }
    try {
      await window.liff.sendMessages([{ type: 'text', text }]);
      return { sent: true, reason: '' };
    } catch (error) {
      console.warn('booking member chat message failed', error?.code || error?.message || error);
      return { sent: false, reason: 'send_failed' };
    }
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
    // Use the token that was granted at login, not an unclaimed LIFF refresh.
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
        await startPresence(context.config, 'booking', currentPresenceIdToken(context), 'relogin');
        return;
      }
      const response = await Promise.race([
        sendPresence(context, 'heartbeat', 'heartbeat'),
        new Promise((resolve) => window.setTimeout(() => resolve(null), 1200))
      ]);
      if (response && response.ok) context.lastSeenSignalAt = Date.now();
    } finally {
      schedulePresenceHeartbeat();
    }
  }

  async function handleRevokedPresenceResponse(response) {
    try {
      const payload = await response.json();
      const code = String(payload?.error?.code || '');
      if (['SESSION_REPLACED', 'SESSION_REVOKED', 'MEMBER_REMOVED'].includes(code)) terminateAccessSession(code, payload.error.message);
    } catch (_) {}
  }

  function bindPresenceLifecycle() {
    if (presenceHooksBound) return;
    presenceHooksBound = true;
    window.addEventListener('pagehide', (event) => {
      clearPresenceHeartbeat();
      void stopPresence(event && event.persisted ? 'bfcache' : 'pagehide');
    });
    window.addEventListener('pageshow', (event) => {
      if (!event || !event.persisted || !presenceContext || !presenceContext.closed) return;
      const previous = presenceContext;
      presenceContext = null;
      void startPresence(previous.config, 'booking', currentPresenceIdToken(previous), 'resume');
    });
    document.addEventListener('visibilitychange', () => {
      const context = presenceContext;
      if (!context) return;
      // LIFF close is not guaranteed to dispatch pagehide on every LINE WebView.
      if (document.visibilityState !== 'visible') {
        void stopPresence('hidden');
        return;
      }
      if (context.closed) {
        presenceContext = null;
        void startPresence(context.config, 'booking', currentPresenceIdToken(context), 'resume');
        return;
      }
      if (Date.now() - Number(context.lastSeenSignalAt || 0) >= PRESENCE_RESUME_SIGNAL_MS) {
        context.onlineRecorded = false;
        void startPresence(context.config, 'booking', currentPresenceIdToken(context), 'resume');
      } else {
        void heartbeatPresence();
      }
    });
  }

  function presenceBody(context, event, reason) {
    const payload = {
      sessionId: context.sessionId,
      reason,
      action: 'user.booking.presence.' + event,
      clientType: 'booking',
      idToken: currentPresenceIdToken(context)
    };
    return window.TestModeClient && typeof window.TestModeClient.payload === 'function'
      ? window.TestModeClient.payload(payload)
      : payload;
  }

  function sendPresence(context, event, reason) {
    const endpoint = String(context.config.supabaseFunctionUrl || '').trim();
    if (!endpoint) return Promise.resolve(null);
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': String(context.config.supabasePublishableKey)
      },
      cache: 'no-store',
      keepalive: true,
      body: JSON.stringify(presenceBody(context, event, reason))
    }).then(async response => {
      if (response?.status === 401) await handleRevokedPresenceResponse(response.clone());
      return response;
    }).catch(() => null);
  }

  async function startPresence(config, clientType, idToken, reason = 'signin') {
    if (clientType !== 'booking') return;
    if (presenceContext && !presenceContext.closed) {
      if (presenceContext.onlineRecorded) return;
      const response = await Promise.race([
        sendPresence(presenceContext, 'online', reason),
        new Promise((resolve) => window.setTimeout(() => resolve(null), 1200))
      ]);
      presenceContext.onlineRecorded = Boolean(response && response.ok);
      if (presenceContext.onlineRecorded) presenceContext.lastSeenSignalAt = Date.now();
      schedulePresenceHeartbeat();
      return;
    }
    const context = {
      config,
      idToken: String(idToken || ''),
      sessionId: createPresenceSessionId(),
      onlineRecorded: false,
      lastSeenSignalAt: 0,
      closed: false
    };
    presenceContext = context;
    bindPresenceLifecycle();
    const response = await Promise.race([
      sendPresence(context, 'online', reason),
      new Promise((resolve) => window.setTimeout(() => resolve(null), 1200))
    ]);
    context.onlineRecorded = Boolean(response && response.ok);
    if (context.onlineRecorded) context.lastSeenSignalAt = Date.now();
    schedulePresenceHeartbeat();
  }

  function sendPresenceExit(context, reason) {
    const endpoint = String(context.config.supabaseFunctionUrl || '').trim();
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/[A-Za-z0-9_-]+$/i.test(endpoint)) return Promise.resolve(null);
    const jsonBody = JSON.stringify(presenceBody(context, 'offline', reason));
    // Beacon/simple POST skips a preflight which may be cancelled on LINE WebView close.
    try {
      if (navigator && typeof navigator.sendBeacon === 'function') {
        const beacon = new Blob([jsonBody], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(endpoint, beacon)) return Promise.resolve(true);
      }
    } catch (_) {}
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      cache: 'no-store',
      keepalive: true,
      body: jsonBody
    }).catch(() => null);
  }

  async function stopPresence(reason = 'pagehide') {
    const context = presenceContext;
    if (!context || context.closed) return;
    clearPresenceHeartbeat();
    context.closed = true;
    await sendPresenceExit(context, reason);
  }

  function bookingNoticeElement() {
    const card = document.querySelector('.booking-card[aria-labelledby="bookingTitle"]');
    if (!card) return null;
    return [...card.children].find((node) => (
      node.classList?.contains('service-info')
      && node.getAttribute('role') === 'note'
    )) || null;
  }

  function renderBookingNotice(value) {
    const notice = bookingNoticeElement();
    if (!notice) return;
    const text = String(value ?? '').replace(/\r\n?/g, '\n');
    const visible = text.trim().length > 0;
    notice.classList.toggle('hidden', !visible);
    if (!visible) {
      notice.replaceChildren();
      return;
    }
    const label = document.createElement('strong');
    label.textContent = '預約說明：';
    const body = document.createElement('span');
    body.textContent = text;
    body.style.whiteSpace = 'pre-line';
    body.style.overflowWrap = 'anywhere';
    notice.replaceChildren(label, document.createTextNode(' '), body);
  }

  async function syncPublicBookingNotice(config, preferredValue) {
    const sequence = ++publicNoticeSequence;
    if (typeof preferredValue === 'string') {
      renderBookingNotice(preferredValue);
      return;
    }
    try {
      if (!window.supabase?.createClient) return;
      if (!publicNoticeClient) {
        publicNoticeClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
          auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
        });
      }
      const { data, error } = await publicNoticeClient.rpc('get_booking_public_notice');
      if (error) throw error;
      if (sequence !== publicNoticeSequence) return;
      renderBookingNotice(typeof data === 'string' ? data : '');
    } catch (error) {
      console.warn('booking notice load failed', error);
    }
  }

  async function request(config, clientType, idToken, action, payload = {}) {
    const receiptAction = String(action || '').startsWith('user.booking.receipt.');
    const endpoint = `${String(config.supabaseUrl).replace(/\/$/, '')}/functions/v1/${receiptAction ? 'booking-receipt-api' : 'booking-api'}`;
    const body = window.TestModeClient && typeof window.TestModeClient.payload === 'function'
      ? window.TestModeClient.payload({ ...payload, action, clientType, idToken })
      : { ...payload, action, clientType, idToken };
    const data = await postJson(endpoint, config, body, '預約服務', { write: WRITE_ACTIONS.has(action) });
    if (clientType === 'member' && action === 'user.booking.bootstrap') {
      const notice = data?.settings && Object.prototype.hasOwnProperty.call(data.settings, 'bookingNotice')
        ? data.settings.bookingNotice
        : undefined;
      void syncPublicBookingNotice(config, typeof notice === 'string' ? notice : undefined);
    }
    return data;
  }

  async function bookingBenefits(config, idToken, bookingId = '') {
    const body = {
      action: 'user.booking.benefits',
      clientType: 'booking',
      idToken,
      ...(bookingId ? { bookingId: String(bookingId) } : {}),
    };
    return postJson(String(config.supabaseFunctionUrl || '').trim(), config,
      window.TestModeClient?.payload ? window.TestModeClient.payload(body) : body, '可用活動與票券');
  }

  async function claimEventTicket(config, idToken, eventTicketId) {
    const endpoint = String(config.supabaseFunctionUrl || '').trim();
    if (!endpoint) throw clientError('CONFIG_INVALID', '活動票券服務設定不完整。');
    const body = {
      action: 'user.booking.event-ticket.claim',
      clientType: 'booking',
      idToken,
      eventTicketId: String(eventTicketId || '').trim(),
    };
    return postJson(endpoint, config,
      window.TestModeClient?.payload ? window.TestModeClient.payload(body) : body,
      '活動票券領取', { write: true });
  }

  async function memberProfile(config, idToken) {
    const endpoint = String(config.supabaseFunctionUrl || '').trim();
    if (!endpoint) throw clientError('CONFIG_INVALID', '會員資料服務設定不完整。');
    const requestBody = {
      action: 'user.member.bootstrap',
      clientType: 'member',
      idToken,
    };
    const data = await postJson(endpoint, config,
      window.TestModeClient && typeof window.TestModeClient.payload === 'function'
        ? window.TestModeClient.payload(requestBody)
        : requestBody,
      '會員資料服務');
    return data && data.profile && typeof data.profile === 'object' ? data.profile : {};
  }

  function postJson(endpoint, config, body, serviceLabel, options = {}) {
    if (isTerminatingAccess) return Promise.reject(clientError('SESSION_REVOKED', '連線已結束，請重新登入。'));
    if (options.write === true) {
      pendingReads.clear();
      return sendJson(endpoint, config, body, serviceLabel, options).finally(() => pendingReads.clear());
    }
    if (!SHARED_READ_ACTIONS.has(body.action)) return sendJson(endpoint, config, body, serviceLabel, options);
    // The serialized body includes the exact LINE/test identity and parameters.
    const key = JSON.stringify([endpoint, config.supabasePublishableKey, body]);
    if (pendingReads.has(key)) return pendingReads.get(key);
    const pending = sendJson(endpoint, config, body, serviceLabel, options).finally(() => {
      if (pendingReads.get(key) === pending) pendingReads.delete(key);
    });
    pendingReads.set(key, pending);
    return pending;
  }

  async function sendJson(endpoint, config, body, serviceLabel, options = {}) {
    if (isTerminatingAccess) throw clientError('SESSION_REVOKED', '連線已結束，請重新登入。');
    const isWrite = options.write === true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': String(config.supabasePublishableKey),
        },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      let data;
      try { data = await response.json(); }
      catch {
        if (isWrite) throw clientError('API_RESPONSE_UNCERTAIN', '無法確認這次預約操作的回應；系統不會自動重送，請重新整理確認。');
        throw clientError('API_INVALID_RESPONSE', `${serviceLabel}回傳格式不正確。`);
      }
      if (!response.ok || !data || data.ok !== true) {
        const apiError = data && data.error || {};
        const apiErrorCode = String(apiError.code || 'API_ERROR');
        const error = clientError(apiErrorCode, String(apiError.message || `${serviceLabel}暫時無法完成操作。`), apiError.details || null);
        if (['SESSION_REVOKED', 'SESSION_REPLACED', 'MEMBER_REMOVED', 'SYSTEM_MAINTENANCE'].includes(apiErrorCode)) {
          terminateAccessSession(apiErrorCode, error.message);
        }
        throw error;
      }
      if (isTerminatingAccess) throw clientError('SESSION_REVOKED', '連線已結束，請重新登入。');
      return data.data || {};
    } catch (error) {
      if (error?.code === 'API_RESPONSE_UNCERTAIN') throw error;
      if (isWrite && (error?.name === 'AbortError' || !error?.code)) {
        throw clientError('API_RESPONSE_UNCERTAIN', '無法確認這次預約操作是否已送達；系統不會自動重送，請重新整理確認。');
      }
      if (error?.name === 'AbortError') throw clientError('API_TIMEOUT', `${serviceLabel}回應逾時，請稍後再試。`);
      if (error?.code) throw error;
      throw clientError('NETWORK_ERROR', `${serviceLabel}目前無法連線，請檢查網路後再試。`);
    } finally {
      window.clearTimeout(timer);
    }
  }

  function subscribeRealtime(config, onUpdate, scope = 'member', onBenefitsUpdate = null) {
    if (typeof onUpdate !== 'function') return () => {};
    const targetScope = scope === 'admin' ? 'admin' : 'member';
    const subscriptionKey = JSON.stringify([config.supabaseUrl, config.supabasePublishableKey, targetScope]);
    const existing = realtimeSubscriptions.get(subscriptionKey);
    if (existing) return existing.unsubscribe;

    if (config.business && config.realtimeEnabled !== false) {
      let stopped=false,timer,pending=false,queued=false,revision,lastFull=-Infinity,failures=0;
      const paused=()=>!navigator.onLine||document.visibilityState==='hidden';
      const schedule=delay=>{if(stopped)return;if(timer!==undefined)window.clearTimeout(timer);timer=window.setTimeout(()=>{timer=undefined;void probe();},delay);};
      const probe=async()=>{
        if(stopped||paused())return;if(pending){queued=true;return;}pending=true;
        try{
          const session=getSession();if(!session?.idToken)throw Error('AUTH_REQUIRED');
          const current=await postJson(String(config.supabaseUrl).replace(/\/$/,'')+'/functions/v1/api',config,
            {action:targetScope==='admin'?'admin.sync.status':'user.booking.sync.status',clientType:targetScope==='admin'?'admin':'booking',idToken:session.idToken,business:config.business},'同步服務',{write:false});
          if(stopped)return;
          if(typeof current.revision!=='string'||current.revision.length>120)throw Error('INVALID_SYNC_REVISION');
          if(revision!==current.revision||Date.now()-lastFull>=120000){
            await onUpdate();if(stopped)return;
            if(typeof onBenefitsUpdate==='function')await onBenefitsUpdate({scope:'all',eventType:'business.reconcile'});
            revision=current.revision;lastFull=Date.now();
          }
          failures=0;
        }catch(_){failures++;}
        finally{pending=false;if(!stopped){const delay=queued?0:Math.min(60000,10000*2**Math.min(failures,3));queued=false;schedule(delay);}}
      };
      const resume=()=>{if(!paused()){if(pending)queued=true;else schedule(0);}};
      document.addEventListener('visibilitychange',resume);window.addEventListener('pageshow',resume);window.addEventListener('online',resume);
      const unsubscribe=()=>{if(stopped)return;stopped=true;if(timer!==undefined)window.clearTimeout(timer);document.removeEventListener('visibilitychange',resume);window.removeEventListener('pageshow',resume);window.removeEventListener('online',resume);realtimeSubscriptions.delete(subscriptionKey);};
      realtimeSubscriptions.set(subscriptionKey,{unsubscribe});schedule(0);return unsubscribe;
    }

    let disposed = false;
    let channel = null;
    let client = null;
    let resyncPending = false;
    let resyncQueued = false;
    let lastResyncAt = 0;
    let subscribedOnce = false;
    let realtimeTimer = null;
    let loginCheckTimer = null;
    let loginCheckPending = false;
    let loginCheckQueued = false;
    let loginCheckGeneration = 0;
    let pendingLoginGeneration = 0;
    const validateCurrentLogin = (queueIfPending = true) => {
      if (disposed || targetScope === 'admin' || isTerminatingAccess) return;
      // A takeover event may arrive while a status request is in flight.
      // Never drop that invalidation just because the previous read was pending.
      if (loginCheckPending) {
        if (queueIfPending || pendingLoginGeneration !== loginCheckGeneration) loginCheckQueued = true;
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      // Test accounts have an independent revocation lifecycle.
      if (window.TestModeClient?.getSessionToken?.()) return;
      const session = getSession();
      if (!session?.idToken) return;
      loginCheckPending = true;
      pendingLoginGeneration = loginCheckGeneration;
      void postJson(String(config.supabaseUrl).replace(/\/$/, '') + '/functions/v1/api',
        config, { action:'user.booking.session.status',clientType:'booking',idToken:session.idToken },
        '登入狀態', { write:false }).catch(() => {}).finally(() => {
        loginCheckPending = false;
        if (loginCheckQueued && !disposed && !isTerminatingAccess) {
          loginCheckQueued = false;
          validateCurrentLogin();
        }
      });
    };

    const backgroundResyncAllowed = () => {
      try {
        return Boolean(
          window.TestModeClient
          && typeof window.TestModeClient.getSessionToken === 'function'
          && window.TestModeClient.getSessionToken()
        );
      } catch (_) {
        return false;
      }
    };
    const shouldDeferResync = () => !navigator.onLine
      || (document.visibilityState === 'hidden' && !backgroundResyncAllowed());

    const clearScheduledResync = () => {
      if (realtimeTimer !== null) window.clearTimeout(realtimeTimer);
      realtimeTimer = null;
    };

    const schedule = (delayMs = 450) => {
      if (disposed) return;
      resyncQueued = true;
      if (shouldDeferResync()) return;
      if (resyncPending || realtimeTimer !== null) return;
      realtimeTimer = window.setTimeout(() => {
        realtimeTimer = null;
        runResync();
      }, Math.max(0, delayMs));
    };

    const runResync = () => {
      if (disposed) return;
      if (shouldDeferResync()) {
        resyncQueued = true;
        return;
      }
      if (resyncPending) {
        resyncQueued = true;
        return;
      }

      const now = Date.now();
      const waitMs = MIN_RESYNC_INTERVAL_MS - (now - lastResyncAt);
      if (waitMs > 0) {
        schedule(waitMs);
        return;
      }

      resyncQueued = false;
      lastResyncAt = now;
      resyncPending = true;
      Promise.resolve().then(() => { if (!disposed) return onUpdate(); }).catch(() => {}).finally(() => {
        resyncPending = false;
        if (resyncQueued) schedule(0);
      });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        validateCurrentLogin(false);
        schedule(0);
      } else loginCheckGeneration += 1;
    };
    const onPageShow = (event) => {
      if (event?.persisted) loginCheckGeneration += 1;
      validateCurrentLogin(false);
      schedule(0);
    };
    const onOnline = () => {
      validateCurrentLogin(false);
      schedule(0);
    };
    // Reconcile visible data even when the SDK is unavailable or a socket silently
    // misses an event. Use the same queue so periodic reads never overlap Realtime.
    if (typeof window.setInterval === 'function') {
      loginCheckTimer = window.setInterval(() => {
        if (disposed || shouldDeferResync()) return;
        validateCurrentLogin(false);
        if (config.realtimeEnabled !== false) schedule(0);
      }, 30000);
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);

    if (!config.business && config.realtimeEnabled !== false && window.supabase && typeof window.supabase.createClient === 'function') {
      const clientKey = JSON.stringify([config.supabaseUrl, config.supabasePublishableKey]);
      if (!realtimeClient || realtimeClientKey !== clientKey) {
        realtimeClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
          auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
        });
        realtimeClientKey = clientKey;
      }

      client = realtimeClient;
      channel = client
        .channel(`booking-${targetScope}-sync`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'realtime_events' }, (payload) => {
          const row = payload && payload.new && typeof payload.new === 'object' ? payload.new : {};
          const scope = String(row.scope || '');
          const eventType = String(row.event_type || '');
          if (disposed) return;
          if (targetScope !== 'admin' && (scope === 'all' || scope === targetScope) && eventType === 'member.login.replaced') {
            validateCurrentLogin();
          } else if (scope === 'all' || scope === targetScope) schedule();
          if (typeof onBenefitsUpdate === 'function' && ['all', 'member', 'points', 'event', 'calendar'].includes(scope)) {
            onBenefitsUpdate({ scope, eventType });
          }
        })
        .subscribe((status) => {
          if (disposed) return;
          if (status !== 'SUBSCRIBED') {
            schedule(0);
            return;
          }
          validateCurrentLogin(false);
          if (subscribedOnce) {
            schedule(0);
            if (typeof onBenefitsUpdate === 'function') onBenefitsUpdate({ scope: 'reconnect', eventType: 'realtime.reconnected' });
          } else {
            subscribedOnce = true;
          }
        });
    }

    const unsubscribe = () => {
      if (disposed) return;
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
      clearScheduledResync();
      if (loginCheckTimer !== null) window.clearInterval(loginCheckTimer);
      realtimeSubscriptions.delete(subscriptionKey);
      try { if (channel && client) Promise.resolve(client.removeChannel(channel)).catch(() => {}); } catch (_) {}
    };
    realtimeSubscriptions.set(subscriptionKey, { unsubscribe });
    return unsubscribe;
  }

  function openMemberJoin(config) {
    const memberLiffId = String(config && config.memberLiffId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(memberLiffId)) return false;
    const url = `https://liff.line.me/${encodeURIComponent(memberLiffId)}` + (config.business ? `?business=${encodeURIComponent(config.business)}` : "");
    if (window.liff && typeof window.liff.openWindow === 'function') {
      window.liff.openWindow({ url, external: false });
      return true;
    }
    window.location.href = url;
    return true;
  }

  function terminateAccessSession(code, message) {
    if (isTerminatingAccess) return;
    isTerminatingAccess = true;
    pendingReads.clear();
    authenticatedSession = null;
    if (typeof window.CustomEvent === 'function' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new window.CustomEvent('member:access-ended', { detail: { code } }));
    document.querySelectorAll?.('[role=dialog], #memberView, #pointsView, #eventView, #calendarView, #bookingView, #adminView').forEach(node => node.classList.add('hidden'));
    if (['SESSION_REPLACED', 'SESSION_REVOKED', 'MEMBER_REMOVED'].includes(code)) {
      try { window.localStorage.setItem(LOGIN_REGISTERED_KEY, 'replaced'); } catch (_) {}
    }
    for (const subscription of realtimeSubscriptions.values()) subscription.unsubscribe();
    clearPresenceHeartbeat();
    if (presenceContext) presenceContext.closed = true;
    presenceContext = null;
    if (window.TestModeClient && typeof window.TestModeClient.clearSession === 'function') {
      try { window.TestModeClient.clearSession(); } catch (_) {}
    }

    const notice = ['SESSION_REVOKED', 'SESSION_REPLACED', 'MEMBER_REMOVED'].includes(code)
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
      const session = getSession();
      authenticatedSession = null;
      if (session?.idToken) {
        try {
          await postJson(String(session.config.supabaseUrl).replace(/\/$/, '') + '/functions/v1/api',
            session.config, { action:'user.booking.session.logout',clientType:'booking',idToken:session.idToken },
            '登出', {write:true});
        } catch (_) {}
      }
      try { window.localStorage.removeItem(LOGIN_REGISTERED_KEY); window.localStorage.removeItem(LOGIN_BROWSER_KEY); } catch (_) {}
      await Promise.race([
        stopPresence('logout'),
        new Promise((resolve) => window.setTimeout(resolve, 1200))
      ]);
      if (window.TestModeClient && typeof window.TestModeClient.clearSession === 'function') window.TestModeClient.clearSession();
      if (window.liff && window.liff.isLoggedIn()) window.liff.logout();
    } catch (_) {}
    window.location.reload();
  }

  function showNotice(message, options = {}) {
    const modal = document.getElementById('bookingNoticeModal');
    const title = document.getElementById('bookingNoticeTitle');
    const text = document.getElementById('bookingNoticeMessage');
    const confirmButton = document.getElementById('confirmBookingNoticeButton');
    if (!modal || !title || !text || !confirmButton) {
      window.alert(String(message || ''));
      return false;
    }

    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    title.textContent = String(options.title || '提醒');
    text.textContent = String(message || '');
    modal.classList.remove('hidden');
    confirmButton.onclick = () => {
      modal.classList.add('hidden');
      confirmButton.onclick = null;
      if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
    };
    confirmButton.focus();
    return true;
  }

  function formatDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    return match ? `${Number(match[1])}/${Number(match[2])}/${Number(match[3])}` : String(value || '—');
  }

  function addDays(date, days) {
    const parsed = new Date(`${date}T00:00:00Z`);
    parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));
    return parsed.toISOString().slice(0, 10);
  }

  function getSession() {
    // Presence can be closed while LINE is backgrounded; auth remains bound to
    // the claimed token until server revocation, even without a presence row.
    if (!authenticatedSession || isTerminatingAccess) return null;
    return { config: authenticatedSession.config, idToken: authenticatedSession.idToken };
  }

  window.BookingSystem = { loadConfig, signIn, completeSignIn, startPresence, claimBrowserSession, getSession, request, memberProfile, bookingBenefits, claimEventTicket, sendMemberChatMessage, subscribeRealtime, openMemberJoin, logout, showNotice, formatDate, addDays, clientError };
})();

