(() => {
  'use strict';

  let currentSession = null;
  const waiters = new Set();

  function sessionError(message) {
    const error = new Error(message);
    error.code = 'AUTH_REQUIRED';
    return error;
  }

  function establish(config, idToken) {
    const token = String(idToken || '');
    if (!config || typeof config !== 'object' || Array.isArray(config) || !token) {
      throw sessionError('無法建立管理端登入狀態。');
    }
    currentSession = Object.freeze({
      config: Object.freeze({ ...config }),
      idToken: token,
    });
    document.documentElement.dataset.memberAdminSession = 'ready';

    for (const waiter of waiters) {
      window.clearTimeout(waiter.timer);
      waiter.resolve(currentSession);
    }
    waiters.clear();
    window.dispatchEvent(new Event('member-admin-session-ready'));
    return currentSession;
  }

  function get() {
    return currentSession;
  }

  function isReady() {
    return Boolean(currentSession && currentSession.idToken);
  }

  function wait(timeoutMs = 20000) {
    if (currentSession) return Promise.resolve(currentSession);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: 0 };
      waiter.timer = window.setTimeout(() => {
        waiters.delete(waiter);
        reject(sessionError('管理端登入尚未完成，請重新整理後再試。'));
      }, Math.max(1000, Number(timeoutMs) || 20000));
      waiters.add(waiter);
      if (currentSession) {
        waiters.delete(waiter);
        window.clearTimeout(waiter.timer);
        resolve(currentSession);
      }
    });
  }

  function clear() {
    currentSession = null;
    delete document.documentElement.dataset.memberAdminSession;
  }

  Object.defineProperty(window, 'MemberAdminSession', {
    value: Object.freeze({ establish, get, isReady, wait, clear }),
    writable: false,
    configurable: false,
  });
})();
