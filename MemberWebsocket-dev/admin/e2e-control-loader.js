(() => {
  'use strict';

  const E2E_CONTROL_SRC = './e2e-control.js?v=qa-e2e-20261010-2-consent-scope-scope-complete-20261015-1-scope-execution-20261016-1&lazy=20261016-1';
  let loadPromise = null;
  let phase = 'idle';
  let errorCode = '';

  function showLoadError() {
    const message = document.getElementById('automationTestMessage');
    if (!message) return;
    message.textContent = 'E2E 控制器載入失敗，請重新整理後再試。';
    message.classList.remove('hidden');
    message.classList.add('error');
  }

  function load() {
    if (loadPromise) return loadPromise;
    if (typeof window.MemberAdminE2EControl?.runUnifiedBackground === 'function') {
      phase = 'ready';
      return Promise.resolve();
    }

    phase = 'loading';
    errorCode = '';
    loadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = E2E_CONTROL_SRC;
      script.dataset.adminE2eControl = 'true';
      const failed = () => {
        phase = 'failed';
        errorCode = 'E2E_BACKGROUND_RUNNER_CONTROL_LOAD_FAILED';
        loadPromise = null;
        script.remove();
        showLoadError();
        reject(Object.assign(new Error('E2E controller failed to load'), { code: errorCode }));
      };
      script.onload = () => {
        if (typeof window.MemberAdminE2EControl?.runUnifiedBackground !== 'function') return failed();
        phase = 'ready';
        resolve();
      };
      script.onerror = failed;
      document.head.appendChild(script);
    });
    return loadPromise;
  }

  function init() {
    const warm = () => { load().catch(() => {}); };
    const params = new URLSearchParams(window.location.search);
    // Isolated runners receive no hover/focus/click on the test tab.
    if (params.get('e2eBackgroundRunner') === '1' && params.get('e2eRunId')) warm();
    const tab = document.getElementById('testModeTab');
    if (!tab) return;
    tab.addEventListener('pointerenter', warm, { once: true, passive: true });
    tab.addEventListener('focus', warm, { once: true });
    tab.addEventListener('click', warm, { once: true });
  }

  window.AdminE2EControlLoader = Object.freeze({ load, getStatus: () => ({ phase, errorCode }) });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
