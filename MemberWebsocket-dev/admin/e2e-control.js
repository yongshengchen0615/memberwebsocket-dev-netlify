(() => {
  'use strict';

  const VERSION = '2026-10-16.1';
  const COVERAGE_STORAGE_KEY = 'member-admin-e2e-coverage-v1';
  const COVERAGE_STORAGE_TTL_MS = 24 * 60 * 60 * 1000;
  const HTML2CANVAS_URL = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
  const FAILURE_SCREENSHOT_MAX_BYTES = 1900000;
  const FAILURE_SCREENSHOT_BUDGET = 2;
  const E2E_LEASE_HEARTBEAT_MS = 15000;
  const E2E_LEASE_HEARTBEAT_FAILURE_LIMIT = 2;
  const ADMIN_NODE_TIMEOUT_MS = 90000;
  const ADMIN_BOOKING_NODE_TIMEOUT_MS = 7 * 60 * 1000;
  const ADMIN_NODE_DRAIN_TIMEOUT_MS = 5000;
  let html2canvasLoader = null;
  const TEST_SESSION_STORAGE_KEY = 'member-test-session-v1';
  const REPLAY_STORAGE_KEY = 'member-e2e-replay-v1';
  const LEARNING_STORAGE_KEY = 'member-e2e-learning-v2';
  const LEARNING_STORAGE_TTL_MS = 2 * 60 * 60 * 1000;
  const BACKGROUND_RUNNER_PARAM = 'e2eBackgroundRunner';
  const BACKGROUND_RUNNER_READY_TIMEOUT_MS = 90 * 1000;
  const BACKGROUND_RUNNER_STALE_MS = 8 * 60 * 1000;
  const MAX_PAIRED_PARTICIPANTS = 10;
  const CLIENT_MOBILE_VIEWPORT = Object.freeze({ width: 430, height: 932 });
  const CLIENT_DESKTOP_POPUP = Object.freeze({ width: 1100, height: 820 });
  const PAIRED_BOOKING_LIVE_TIMEOUT_MS = 10 * 60 * 1000;
  const ADMIN_BOOKING_BOOTSTRAP_BASE_INTERVAL_MS = 3500;
  const ADMIN_BOOKING_BOOTSTRAP_MAX_INTERVAL_MS = 8000;
  let adminBookingBootstrapInFlight = null;
  let adminBookingBootstrapLastAt = 0;
  let adminBookingBootstrapLastData = null;
  let adminBookingBootstrapBackoffUntil = 0;
  let pairedAdminBookingChain = Promise.resolve();
  const PAIRED_SURFACES = Object.freeze([
    ['member', '會員卡'],
    ['points', '集點卡'],
    ['event', '活動票券'],
    ['calendar', '營運日曆'],
    ['booking', '預約']
  ]);
  const E2E_MODULES = Object.freeze([...PAIRED_SURFACES.slice(0, 4), ['integration', '整合中心'], PAIRED_SURFACES[4]]);
  const ADMIN_CASE_MODULES = Object.freeze({
    ADMIN_MEMBER_USAGE_LOGS: ['member'],
    ADMIN_BOOKING_NO_SHOW_CONTROLS: ['booking'],
    ADMIN_SERVICE_GRANT_JOURNEY: ['member'],
    ADMIN_SETTINGS_COPY_CONTROLS: ['points','event'],
    ADMIN_TIER_EDITOR_JOURNEY: ['member'],
    ADMIN_TERMS_EDITOR_JOURNEY: ['member'],
    ADMIN_CARD_EDITOR_OPTIONS: ['points'],
    ADMIN_CARD_SORT_JOURNEY: ['points'],
    ADMIN_EVENT_AUDIENCE_JOURNEY: ['event'],
    ADMIN_CALENDAR_NAVIGATION: ['calendar'],
    ADMIN_CALENDAR_EVENT_CRUD: ['calendar'],
    ADMIN_EVENT_CALENDAR_SYNC: ['event','calendar'],
    ADMIN_BOOKING_BATCH_EDITOR: ['booking'],
    ADMIN_FIXED_DRAFT_BIRTHDAY_MONTH: ['event'],
    ADMIN_FIXED_DRAFT_WEEKLY: ['event'],
    ADMIN_FIXED_DRAFT_MONTHLY: ['event'],
    ADMIN_FIXED_DRAFT_YEARLY: ['event'],

    ADMIN_TEST_MEMBER_ROSTER: ['member'], ADMIN_MEMBER_MODALS: ['member'],
    ADMIN_TEST_MEMBER_PROFILE_EDIT: ['member'], ADMIN_MEMBER_DIRECTORY_CONTROLS: ['member'],
    ADMIN_MEMBERSHIP_TERMS: ['member'],
    ADMIN_FORCE_LOGOUT_SECURITY: ['member'],
    ADMIN_MESSAGE_PRESET_EDITOR: ['member'],
    ADMIN_RESOURCE_EDITORS: ['points', 'event', 'calendar', 'booking'],
    ADMIN_TIER_SETTINGS: ['member'], ADMIN_GRANT_NOTIFICATION_CONTROLS: ['member'],
    ADMIN_POINT_LIMIT_SETTINGS: ['points'],
    ADMIN_AUTOMATION_HEALTH: ['member','event','booking'],
    ADMIN_BIRTHDAY_SETTINGS: ['event'], ADMIN_FIXED_TICKET_CONTROLS: ['event'],
    ADMIN_TICKET_LOCATION_CONTROLS: ['points','event'], ADMIN_TICKET_SERVICE_RULES: ['points','event','booking'],
    ADMIN_BOOKING_ACCESSIBLE_QUEUE: ['booking'], ADMIN_BOOKING_ACCESSIBLE_REVIEW: ['booking'],
    ADMIN_BOOKING_ACCESSIBLE_IDEMPOTENCY: ['booking'], ADMIN_BOOKING_HISTORY_TICKET_SOURCES: ['booking'],
    ADMIN_BOOKING_RESOURCE_CONTROLS: ['booking'],
    ADMIN_BOOKING_REJECT: ['booking'], ADMIN_BOOKING_CONFIRM: ['booking'],
    ADMIN_BOOKING_MODIFY_ITEMS: ['booking'], ADMIN_BOOKING_MODIFY_TECHNICIAN: ['booking'],
    ADMIN_BOOKING_COMPLETE: ['booking'], ADMIN_BOOKING_CANCELLATION_KEEP: ['booking'],
    ADMIN_BOOKING_CANCELLATION_APPROVE: ['booking'], ADMIN_BOOKING_TERMINAL_STATE: ['booking'],
    ADMIN_BOOKING_REALTIME_SYNC: ['booking'], ADMIN_BOOKING_RISK_SCAN: ['booking'],
    ADMIN_TICKET_CRUD: ['points'], ADMIN_LOTTERY_TICKET_CRUD: ['points', 'event'],
    ADMIN_POINT_CARD_CRUD: ['points'], ADMIN_EVENT_TICKET_CRUD: ['event'],
    ADMIN_EVENT_DAILY_LIMIT_SETTINGS: ['event'],
    ADMIN_CALENDAR_CRUD: ['calendar'], ADMIN_CALENDAR_BATCH_CONTROLS: ['calendar'],
    ADMIN_BOOKING_CRUD: ['booking'], ADMIN_BOOKING_CONTROLS: ['booking'],
    ADMIN_BOOKING_SHARED_SETTINGS: ['booking'], ADMIN_BOOKING_RECEIPT_VIEWER: ['booking'],
    ADMIN_INTEGRATION_CENTER: ['integration'], ADMIN_INTEGRATION_NAVIGATION: ['integration']
  });
  const MODULE_HUMAN_EVIDENCE = Object.freeze({
    member: 'ADMIN_TEST_MEMBER_PROFILE_EDIT',
    points: 'ADMIN_POINT_CARD_CRUD',
    event: 'ADMIN_EVENT_TICKET_CRUD',
    calendar: 'ADMIN_CALENDAR_CRUD',
    integration: 'ADMIN_INTEGRATION_CENTER',
    booking: 'ADMIN_BOOKING_CONTROLS'
  });
  const ADMIN_NODE_META = Object.freeze({
    ADMIN_MEMBER_USAGE_LOGS: {module:'member',phase:5,dependencies:['ADMIN_TEST_MEMBER_ROSTER']},
    ADMIN_BOOKING_NO_SHOW_CONTROLS: {module:'booking',phase:5,dependencies:['ADMIN_BOOKING_CONTROLS']},
    ADMIN_SERVICE_GRANT_JOURNEY: {module:'member',phase:4,risk:'mutation',dependencies:['ADMIN_TEST_MEMBER_ROSTER']},
    ADMIN_SETTINGS_COPY_CONTROLS: {module:'ticket',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS']},
    ADMIN_TIER_EDITOR_JOURNEY: {module:'member',phase:4,dependencies:['ADMIN_PRIMARY_NAVIGATION']},
    ADMIN_TERMS_EDITOR_JOURNEY: {module:'member',phase:4,dependencies:['ADMIN_PRIMARY_NAVIGATION']},
    ADMIN_CARD_EDITOR_OPTIONS: {module:'points',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS']},
    ADMIN_CARD_SORT_JOURNEY: {module:'points',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS']},
    ADMIN_EVENT_AUDIENCE_JOURNEY: {module:'event',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS']},
    ADMIN_CALENDAR_NAVIGATION: {module:'calendar',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS']},
    ADMIN_CALENDAR_EVENT_CRUD: {module:'calendar',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS'],risk:'mutation'},
    ADMIN_EVENT_CALENDAR_SYNC: {module:'event',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS'],risk:'mutation'},
    ADMIN_BOOKING_BATCH_EDITOR: {module:'booking',phase:4,dependencies:['ADMIN_BOOKING_CONTROLS']},
    ADMIN_FIXED_DRAFT_BIRTHDAY_MONTH: {module:'event',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS']},
    ADMIN_FIXED_DRAFT_WEEKLY: {module:'event',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS']},
    ADMIN_FIXED_DRAFT_MONTHLY: {module:'event',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS']},
    ADMIN_FIXED_DRAFT_YEARLY: {module:'event',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS']},
    ADMIN_TIER_SETTINGS: {module:'member',phase:3,dependencies:['ADMIN_PRIMARY_NAVIGATION']},
    ADMIN_GRANT_NOTIFICATION_CONTROLS: {module:'member',phase:4,dependencies:['ADMIN_TEST_MEMBER_ROSTER']},
    ADMIN_POINT_LIMIT_SETTINGS: {module:'points',phase:3,dependencies:['ADMIN_RESOURCE_EDITORS']},
    ADMIN_AUTOMATION_HEALTH: {module:'shared',phase:3,dependencies:['ADMIN_AUTH_READY']},
    ADMIN_BIRTHDAY_SETTINGS: {module:'event',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS']},
    ADMIN_FIXED_TICKET_CONTROLS: {module:'event',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS']},
    ADMIN_TICKET_LOCATION_CONTROLS: {module:'ticket',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS']},
    ADMIN_TICKET_SERVICE_RULES: {module:'ticket',phase:4,dependencies:['ADMIN_RESOURCE_EDITORS']},
    ADMIN_BOOKING_ACCESSIBLE_QUEUE: {module:'booking',phase:5,dependencies:['ADMIN_BOOKING_CONTROLS']},
    ADMIN_BOOKING_ACCESSIBLE_REVIEW: {module:'booking',phase:5,risk:'mutation',dependencies:['ADMIN_BOOKING_ACCESSIBLE_QUEUE']},
    ADMIN_BOOKING_ACCESSIBLE_IDEMPOTENCY: {module:'booking',phase:6,risk:'mutation',dependencies:['ADMIN_BOOKING_ACCESSIBLE_REVIEW']},
    ADMIN_BOOKING_HISTORY_TICKET_SOURCES: {module:'booking',phase:5,dependencies:['ADMIN_BOOKING_CONTROLS']},
    ADMIN_BOOKING_RESOURCE_CONTROLS: {module:'booking',phase:3,dependencies:['ADMIN_BOOKING_CONTROLS']},
    ADMIN_BOOKING_REJECT: {module:'booking',phase:5,dependencies:['ADMIN_BOOKING_CONTROLS']},
    ADMIN_BOOKING_CONFIRM: {module:'booking',phase:5,dependencies:['ADMIN_BOOKING_CONTROLS']},
    ADMIN_BOOKING_MODIFY_ITEMS: {module:'booking',phase:5,dependencies:['ADMIN_BOOKING_CONFIRM']},
    ADMIN_BOOKING_MODIFY_TECHNICIAN: {module:'booking',phase:5,dependencies:['ADMIN_BOOKING_CONFIRM']},
    ADMIN_BOOKING_COMPLETE: {module:'booking',phase:5,dependencies:['ADMIN_BOOKING_CONFIRM']},
    ADMIN_BOOKING_CANCELLATION_KEEP: {module:'booking',phase:5,dependencies:['ADMIN_BOOKING_CONTROLS']},
    ADMIN_BOOKING_CANCELLATION_APPROVE: {module:'booking',phase:5,dependencies:['ADMIN_BOOKING_CANCELLATION_KEEP']},
    ADMIN_BOOKING_TERMINAL_STATE: {module:'booking',phase:6,dependencies:['ADMIN_BOOKING_COMPLETE','ADMIN_BOOKING_CANCELLATION_APPROVE']},
    ADMIN_BOOKING_REALTIME_SYNC: {module:'booking',phase:6,dependencies:['ADMIN_BOOKING_COMPLETE','ADMIN_BOOKING_CANCELLATION_APPROVE']},
    ADMIN_BOOKING_RISK_SCAN: {module:'booking',phase:6,dependencies:['ADMIN_BOOKING_TERMINAL_STATE','ADMIN_BOOKING_REALTIME_SYNC']},
    ADMIN_AUTH_READY: { module: 'shared', phase: 0, required: true, risk: 'auth' },
    ADMIN_PRIMARY_NAVIGATION: { module: 'shared', phase: 1, required: true, dependencies: ['ADMIN_AUTH_READY'] },
    ADMIN_TEST_MEMBER_ROSTER: { module: 'member', phase: 2, dependencies: ['ADMIN_PRIMARY_NAVIGATION'] },
    ADMIN_MEMBER_MODALS: { module: 'member', phase: 3, dependencies: ['ADMIN_TEST_MEMBER_ROSTER'] },
    ADMIN_TEST_MEMBER_PROFILE_EDIT: { module: 'member', phase: 4, risk: 'mutation', dependencies: ['ADMIN_TEST_MEMBER_ROSTER'] },
    ADMIN_MEMBER_DIRECTORY_CONTROLS: { module: 'member', phase: 3, dependencies: ['ADMIN_TEST_MEMBER_ROSTER'] },
    ADMIN_MEMBERSHIP_TERMS: { module: 'member', phase: 3, dependencies: ['ADMIN_PRIMARY_NAVIGATION'] },
    ADMIN_FORCE_LOGOUT_SECURITY: { module: 'member', phase: 5, required: true, risk: 'security', dependencies: ['ADMIN_TEST_MEMBER_ROSTER'] },
    ADMIN_MESSAGE_PRESET_EDITOR: { module: 'member', phase: 3, dependencies: ['ADMIN_PRIMARY_NAVIGATION'] },
    ADMIN_THEME_TOGGLE: { module: 'member', phase: 2, dependencies: ['ADMIN_AUTH_READY'] },

    ADMIN_RESOURCE_EDITORS: { module: 'resource', phase: 2, dependencies: ['ADMIN_PRIMARY_NAVIGATION'] },
    ADMIN_TICKET_CRUD: { module: 'points', phase: 4, risk: 'mutation', dependencies: ['ADMIN_RESOURCE_EDITORS'] },
    ADMIN_LOTTERY_TICKET_CRUD: { module: 'ticket', phase: 4, risk: 'mutation', dependencies: ['ADMIN_RESOURCE_EDITORS'] },
    ADMIN_POINT_CARD_CRUD: { module: 'points', phase: 4, risk: 'mutation', dependencies: ['ADMIN_RESOURCE_EDITORS'] },
    ADMIN_EVENT_TICKET_CRUD: { module: 'event', phase: 4, risk: 'mutation', dependencies: ['ADMIN_RESOURCE_EDITORS'] },
    ADMIN_EVENT_DAILY_LIMIT_SETTINGS: { module: 'event', phase: 3, required: true, dependencies: ['ADMIN_RESOURCE_EDITORS'] },
    ADMIN_CALENDAR_CRUD: { module: 'calendar', phase: 4, risk: 'mutation', dependencies: ['ADMIN_RESOURCE_EDITORS'] },
    ADMIN_CALENDAR_BATCH_CONTROLS: { module: 'calendar', phase: 5, dependencies: ['ADMIN_CALENDAR_CRUD'] },

    ADMIN_BOOKING_CONTROLS: { module: 'booking', phase: 2, required: true, dependencies: ['ADMIN_PRIMARY_NAVIGATION'] },
    ADMIN_BOOKING_SHARED_SETTINGS: { module: 'booking', phase: 3, required: true, risk: 'mutation', dependencies: ['ADMIN_BOOKING_CONTROLS'] },
    ADMIN_BOOKING_RECEIPT_VIEWER: { module: 'booking', phase: 5, required: true, dependencies: ['ADMIN_BOOKING_CONTROLS'] },
    ADMIN_BOOKING_CRUD: { module: 'booking', phase: 4, risk: 'mutation', dependencies: ['ADMIN_BOOKING_CONTROLS'] },

    ADMIN_INTEGRATION_CENTER: { module: 'integration', phase: 2, required: true, dependencies: ['ADMIN_PRIMARY_NAVIGATION'] },
    ADMIN_INTEGRATION_NAVIGATION: { module: 'integration', phase: 3, dependencies: ['ADMIN_INTEGRATION_CENTER'] },

    ADMIN_TEST_MODE_CONTROLS: { module: 'shared', phase: 2, dependencies: ['ADMIN_PRIMARY_NAVIGATION'] },
    ADMIN_TEST_ACCOUNT_LIFECYCLE: { module: 'shared', phase: 4, risk: 'mutation', dependencies: ['ADMIN_TEST_MODE_CONTROLS'] },
    ADMIN_FEATURE_CONTRACT_COVERAGE: { module: 'shared', phase: 6 },
    ADMIN_BUTTON_COVERAGE: { module: 'shared', phase: 6 }
  });

  const state = {
    running: false,
    pendingTimedOutNode: null,
    cancelled: false,
    runSequence: 0,
    randomSeed: '',
    randomState: 0,
    complexityLevel: 1,
    clientConcurrency: 2,
    failureScreenshotsCaptured: 0,
    activeHumanCaptureCleanup: null,
    rootRunId: '',
    adminScenarioPlan: null,
    featureCoverage: null,
    clientCoverage: [],
    coverageRunCode: '',
    adminRandomStateAfterPlan: 0,
    replayContext: null,
    replayManifest: null,
    learningByCase: {},
    participantCount: 1,
    participantExecutionOrder: [],
    syncOrder: [],
    deepParticipantIndex: null,
    results: [],
    section: null,
    list: null,
    message: null,
    badge: null,
    summary: null,
    participantList: null,
    floating: null,
    clientWindows: [],
    clientMobileViewport: false,
    participants: [],
    selectedModules: E2E_MODULES.map(([key]) => key),
    adminTestAccount: null,
    runStartedAt: '',
    backgroundExecution: false,
    backgroundRunnerWindow: null,
    backgroundCompletion: null,
    backgroundRunId: '',
    backgroundLastStatusAt: 0,
    lastMessage: '',
    lastMessageError: false
  };

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', mount, { once: true });
  } else if (document.readyState === 'interactive' || document.readyState === 'complete') {
    mount();
  }
  window.addEventListener('member-admin-ready', mount);
  window.addEventListener('pagehide', closeClientWindows);

  function mount() {
    if (document.getElementById('adminBrowserE2ESection')) return;
    const host = document.querySelector('.test-control-center');
    const layout = host?.querySelector('.test-control-layout');
    if (!host || !layout) return;

    const section = document.createElement('section');
    section.id = 'adminBrowserE2ESection';
    section.className = 'admin-e2e-section';
    section.setAttribute('aria-labelledby', 'adminBrowserE2ETitle');
    section.innerHTML = `
      <div class="admin-e2e-heading">
        <div>
          <span class="test-mode-eyebrow">Unified Background E2E</span>
          <h4 id="adminBrowserE2ETitle">模組 E2E · 後端 QA + 管理端 ↔ 用戶端協同</h4>
          <p>先執行共用後端安全 QA，再由背景 Runner 針對勾選模組驗證管理端真人操作與對應用戶端流程。</p>
        </div>
        <div class="admin-e2e-actions">
          <span id="adminBrowserE2EBadge" class="test-mode-status-badge is-off">模組 E2E：待命</span>
          <button id="runPairedFullE2EButton" class="button button-dark" type="button" data-admin-e2e-control="true">▶ 開始所選模組 E2E（背景執行）</button>
          <button id="stopAdminE2EButton" class="button button-danger hidden" type="button" data-admin-e2e-stop="true">停止 E2E</button>
        </div>
      </div>
      <div class="admin-e2e-paired-config">
        <fieldset class="admin-e2e-module-picker" aria-describedby="adminE2EModuleHint">
          <legend>勾選本輪 E2E 範圍</legend>
          <div class="admin-e2e-module-grid">
            ${E2E_MODULES.map(([key, label]) => `<label><input type="checkbox" data-e2e-module="${key}" checked><span>${label}</span></label>`).join('')}
          </div>
          <small id="adminE2EModuleHint">至少勾選一項。每輪必跑全部勾選功能與每位用戶的所有勾選頁面；略過、漏跑或缺少證據均不通過。後端共用安全 QA 加上所選模組檢查；測試資料準備仍會建立跨模組共用資料。整合中心為管理端案例，不開啟額外用戶端。</small>
        </fieldset>
        <label for="pairedE2EAccountCount"><strong>協同測試人數</strong><input id="pairedE2EAccountCount" type="number" min="1" max="10" step="1" value="1" inputmode="numeric"></label>
        <label class="admin-e2e-mobile-option" for="pairedE2EMobileViewport">
          <span><strong>用戶端手機大小</strong><small>勾選後，每個測試帳號的單一背景視窗會以 430×932 開啟；只測 viewport，不偽造手機 User-Agent。</small></span>
          <input id="pairedE2EMobileViewport" type="checkbox">
        </label>
        <details class="admin-e2e-config-note">
          <summary>執行方式與視窗規則</summary>
          <p>1–10 人。勾選用戶端模組時，每位測試用戶只開啟 1 個獨立背景視窗，並在同一視窗依序執行所選模組；另開 1 個管理端 Runner。只選整合中心則不開用戶端視窗。正式用戶不會被選入；執行中請勿關閉背景 Runner 或測試視窗。</p>
        </details>
      </div>
      <div id="adminBrowserE2EMessage" class="form-message hidden" role="status" aria-live="polite"></div>
      <div id="adminBrowserE2ESummary" class="admin-e2e-summary">尚未執行瀏覽器 E2E。</div>
      <div id="adminE2EParticipantList" class="admin-e2e-participant-list hidden" aria-live="polite"></div>
      <div id="adminBrowserE2ECaseList" class="test-control-case-list admin-e2e-case-list"></div>
    `;
    host.insertBefore(section, layout);

    const floating = document.createElement('div');
    floating.id = 'adminE2EFloatingStatus';
    floating.className = 'admin-e2e-floating hidden';
    floating.setAttribute('role', 'status');
    floating.setAttribute('aria-live', 'polite');
    document.body.appendChild(floating);

    state.section = section;
    state.list = section.querySelector('#adminBrowserE2ECaseList');
    state.message = section.querySelector('#adminBrowserE2EMessage');
    state.badge = section.querySelector('#adminBrowserE2EBadge');
    state.summary = section.querySelector('#adminBrowserE2ESummary');
    state.participantList = section.querySelector('#adminE2EParticipantList');
    state.floating = floating;

    const runButton = section.querySelector('#runPairedFullE2EButton');
    const config = section.querySelector('.admin-e2e-paired-config');
    if (isBackgroundRunnerWindow()) {
      document.documentElement.dataset.e2eBackgroundRunner = 'true';
      document.title = 'Lumen Club · Background E2E Runner';
      runButton?.classList.add('hidden');
      config?.classList.add('hidden');
      setMessage('背景 E2E Runner 已就緒，等待主管理頁移交完整測試。');
    } else {
      runButton?.addEventListener('click', startUnifiedBackgroundE2E);
    }
    section.querySelector('#stopAdminE2EButton')?.addEventListener('click', requestStop);
    if (!isBackgroundRunnerWindow()) {
      restoreStoredCoverage();
      receiveRecordedCoverage(window.MemberAdminTestControl?.getStatus?.().detail);
    }
  }

  function compactFeatureReport(value) {
    const total = Number(value?.total);
    if (!value?.counts || !Number.isInteger(total) || total < 1 || total > 200) return null;
    const counts = {};
    for (const key of ['passed', 'failed', 'blocked', 'not-run', 'unplanned', 'unregistered']) {
      const count = Number(value.counts[key] || 0);
      if (!Number.isInteger(count) || count < 0 || count > total) return null;
      if (count) counts[key] = count;
    }
    if (Object.values(counts).reduce((sum, n) => sum + n, 0) !== total) return null;
    return { version: 1, total, counts, complete: counts.passed === total && value.execution?.complete !== false,
      ...(value.execution ? {execution:safe(value.execution)} : {}) };
  }

  function compactClientCoverage(items) {
    return (Array.isArray(items) ? items : []).slice(0, 50).map(item => ({
      participant: Math.max(1, Math.min(10, Number(item?.participant) || 1)),
      surface: PAIRED_SURFACES.some(([key]) => key === item?.surface) ? item.surface : 'member',
      coverage: compactFeatureReport(item?.coverage)
    }));
  }

  function persistCoverage() {
    if (isBackgroundRunnerWindow()) return;
    const coverage = compactFeatureReport(state.featureCoverage);
    try {
      if (!coverage) { window.sessionStorage.removeItem(COVERAGE_STORAGE_KEY); return; }
      window.sessionStorage.setItem(COVERAGE_STORAGE_KEY, JSON.stringify({
        version: 1, savedAt: Date.now(), runId: String(state.backgroundRunId || '').slice(0, 100),
        runCode: String(state.coverageRunCode || '').slice(0, 100), coverage,
        clientCoverage: compactClientCoverage(state.clientCoverage)
      }));
    } catch {} // Storage can be unavailable; live and server history still work.
  }

  function restoreStoredCoverage() {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(COVERAGE_STORAGE_KEY) || 'null');
      const age = Date.now() - Number(saved?.savedAt);
      const coverage = compactFeatureReport(saved?.coverage);
      if (saved?.version !== 1 || !Number.isFinite(age) || age < 0 || age > COVERAGE_STORAGE_TTL_MS || !coverage) {
        window.sessionStorage.removeItem(COVERAGE_STORAGE_KEY);
        return;
      }
      state.backgroundRunId = String(saved.runId || '').slice(0, 100);
      state.coverageRunCode = String(saved.runCode || '').slice(0, 100);
      state.featureCoverage = coverage;
      state.clientCoverage = compactClientCoverage(saved.clientCoverage);
      renderFeatureCoverage();
    } catch { try { window.sessionStorage.removeItem(COVERAGE_STORAGE_KEY); } catch {} }
  }

  function receiveRecordedCoverage(data) {
    if (isBackgroundRunnerWindow() || state.running) return false;
    const summary = data?.run?.summary;
    if (!['admin-browser', 'paired-browser'].includes(summary?.runnerKind)) return false;
    const coverage = compactFeatureReport(summary.featureCoverage);
    if (!coverage) return false;
    state.featureCoverage = coverage;
    state.clientCoverage = compactClientCoverage(summary.clientCoverage);
    state.coverageRunCode = String(data.run.runCode || '').slice(0, 100);
    persistCoverage();
    renderFeatureCoverage();
    return true;
  }

  function clearSavedCoverage() {
    if (state.running) return;
    state.featureCoverage = null;
    state.clientCoverage = [];
    state.coverageRunCode = '';
    state.backgroundRunId = '';
    persistCoverage();
    renderFeatureCoverage();
  }

  window.addEventListener('member-admin-test-detail', event => receiveRecordedCoverage(event.detail));
  window.addEventListener('member-admin-test-history-cleared', clearSavedCoverage);

  function isBackgroundRunnerWindow() {
    try { return new URLSearchParams(window.location.search).get(BACKGROUND_RUNNER_PARAM) === '1'; }
    catch (_) { return false; }
  }

  function backgroundAwareTimeout(timeoutMs, minimumMs = 0) {
    const base = Math.max(1, Number(timeoutMs) || 1);
    return state.backgroundExecution ? Math.max(base * 2, Number(minimumMs) || 0) : base;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  // Legacy E2E call sites use `wait(ms)`; keep one canonical delay implementation
  // so missing helper regressions fail neither CRUD nor deep Realtime cases.
  function wait(ms) {
    return sleep(ms);
  }

  function hashSeed(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0 || 0x9e3779b9;
  }

  function configureRandom(seed) {
    state.randomSeed = String(seed || ('E2E-' + Date.now().toString(36)));
    state.randomState = hashSeed(state.randomSeed);
  }

  function nextRandomUnit() {
    if (!state.randomState) configureRandom(state.randomSeed);
    let x = state.randomState >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    state.randomState = x >>> 0;
    return (state.randomState >>> 0) / 4294967296;
  }

  function historicalLearning(caseKey) {
    const key = String(caseKey || '');
    const value = state.learningByCase && typeof state.learningByCase === 'object'
      ? state.learningByCase[key]
      : null;
    return value && typeof value === 'object' ? value : {};
  }

  function historicalPriorityMap() {
    return Object.fromEntries(
      Object.entries(state.learningByCase || {}).map(([key, value]) => [
        key,
        Math.max(0, Math.min(1, Number(value?.riskScore || 0)))
      ])
    );
  }

  function randomInt(min, max) {
    const low = Math.ceil(Number(min) || 0);
    const high = Math.floor(Number(max) || low);
    if (high <= low) return low;
    if (state.randomSeed) return low + Math.floor(nextRandomUnit() * (high - low + 1));
    try {
      const value = new Uint32Array(1);
      crypto.getRandomValues(value);
      return low + (value[0] % (high - low + 1));
    } catch (_) {
      return low + Math.floor(Math.random() * (high - low + 1));
    }
  }

  async function loadE2EProfile(participantCount = 1, modules = state.selectedModules) {
    const session = await adminSession();
    const data = await postFunction('test-control-api', {
      action: 'admin.test-control.e2e-profile',
      clientType: 'admin',
      idToken: session.idToken
    });
    const completedRootRuns = Math.max(0, Number(data?.completedRootRuns || 0));
    const level = Math.max(1, Math.min(8, Number(data?.nextComplexityLevel || completedRootRuns + 1) || 1));
    const seed = 'E2E-L' + level + '-' + Date.now().toString(36).toUpperCase() + '-' + String(completedRootRuns + 1);
    state.complexityLevel = level;
    const hardwareConcurrency = Math.max(0, Number(window.navigator?.hardwareConcurrency || 0));
    const deviceMemory = Math.max(0, Number(window.navigator?.deviceMemory || 0));
    const constrainedDevice = (hardwareConcurrency > 0 && hardwareConcurrency <= 4) || (deviceMemory > 0 && deviceMemory <= 4);
    const selectedSurfaceCount = selectedClientSurfaces(modules).length;
    const normalizedParticipantCount = Math.max(1, Math.min(
      MAX_PAIRED_PARTICIPANTS,
      Math.trunc(Number(participantCount || 1)) || 1
    ));
    const participantFanout = normalizedParticipantCount * Math.max(1, selectedSurfaceCount);
    const adaptiveConcurrency = Math.max(1, Math.min(normalizedParticipantCount, 1 + Math.ceil(level / 2)));
    const resourceSuggestedConcurrency = constrainedDevice
      ? 1
      : Math.min(normalizedParticipantCount, 4);
    // "協同測試人數" is authoritative: every configured participant gets an
    // active client worker immediately. Resource signals only tune pauses and
    // diagnostics; they must never silently leave participant windows idle.
    const participantConcurrencyCap = normalizedParticipantCount;
    const localResourceCap = normalizedParticipantCount;
    state.clientConcurrency = normalizedParticipantCount;
    state.rootRunId = 'ROOT-' + Date.now().toString(36).toUpperCase();
    configureRandom(seed);
    const surfaceWeightsMs = data?.surfaceWeightsMs && typeof data.surfaceWeightsMs === 'object'
      ? { ...data.surfaceWeightsMs }
      : {};
    const surfaceSamples = data?.surfaceSamples && typeof data.surfaceSamples === 'object'
      ? { ...data.surfaceSamples }
      : {};
    state.learningByCase = data?.caseLearning && typeof data.caseLearning === 'object'
      ? { ...data.caseLearning }
      : {};
    try {
      localStorage.setItem(LEARNING_STORAGE_KEY, JSON.stringify({
        version: 2,
        storedAt: Date.now(),
        expiresAt: Date.now() + LEARNING_STORAGE_TTL_MS,
        caseLearning: state.learningByCase
      }));
    } catch (_) {}
    return {
      completedRootRuns,
      complexityLevel: level,
      seed,
      clientConcurrency: state.clientConcurrency,
      resourceProfile: {
        hardwareConcurrency,
        deviceMemory,
        constrainedDevice,
        participantCount: normalizedParticipantCount,
        selectedSurfaceCount,
        participantFanout,
        participantConcurrencyCap,
        activeClientConcurrencyCap: localResourceCap,
        adaptiveConcurrency,
        resourceSuggestedConcurrency,
        allParticipantsStartImmediately: true
      },
      rootRunId: state.rootRunId,
      surfaceWeightsMs,
      surfaceSamples,
      learningAvailable: data?.learningAvailable === true,
      learningCaseCount: Object.keys(state.learningByCase).length
    };
  }

  function normalizeSelectedModules(value) {
    const requested = Array.isArray(value) ? value : [];
    const allowed = E2E_MODULES.map(([key]) => key);
    if (!requested.length || requested.some((key) => !allowed.includes(key))) {
      const error = new Error('請至少勾選一個有效的 E2E 模組。');
      error.code = 'INVALID_E2E_MODULE_SELECTION';
      throw error;
    }
    return allowed.filter((key) => requested.includes(key));
  }

  function selectedModulesFromUi() {
    const checked = Array.from(state.section?.querySelectorAll('[data-e2e-module]:checked') || [])
      .map((input) => String(input.dataset.e2eModule || ''));
    return normalizeSelectedModules(checked);
  }

  function selectedClientSurfaces(modules = state.selectedModules) {
    return PAIRED_SURFACES.filter(([key]) => modules.includes(key));
  }

  function weightedSurfacePlan(profile, participantIndex, modules = state.selectedModules) {
    const weights = profile?.surfaceWeightsMs && typeof profile.surfaceWeightsMs === 'object'
      ? profile.surfaceWeightsMs
      : {};
    const ranked = shuffled(selectedClientSurfaces(modules)).sort((left, right) => {
      const leftWeight = Math.max(1, Number(weights[left[0]] || 1));
      const rightWeight = Math.max(1, Number(weights[right[0]] || 1));
      return rightWeight - leftWeight;
    });
    if (ranked.length < 2) return ranked;
    const offset = Math.abs(Number(participantIndex || 1) - 1) % ranked.length;
    const rotated = ranked.slice(offset).concat(ranked.slice(0, offset));
    return Number(participantIndex || 1) % 2 === 0
      ? [rotated[0]].concat(rotated.slice(1).reverse())
      : rotated;
  }

  async function runWithConcurrency(items, limit, worker) {
    const source = Array.isArray(items) ? items.slice() : [];
    const width = Math.max(1, Math.min(source.length || 1, Number(limit) || 1));
    let cursor = 0;
    let firstFailure = null;
    let failed = false;
    const workers = Array.from({ length: width }, async () => {
      while (cursor < source.length && !state.cancelled && !failed) {
        const index = cursor++;
        try {
          await worker(source[index], index);
        } catch (error) {
          if (!failed) firstFailure = error;
          failed = true;
        }
      }
    });
    // Do not close windows or reuse fixtures while another worker is active.
    await Promise.allSettled(workers);
    if (failed) throw firstFailure;
  }

  function shuffled(items) {
    const copy = Array.isArray(items) ? items.slice() : [];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = randomInt(0, index);
      [copy[index], copy[swap]] = [copy[swap], copy[index]];
    }
    return copy;
  }

  async function waitFor(predicate, timeoutMs = 7000, intervalMs = 60, independentClient = false) {
    const deadline = performance.now() + timeoutMs;
    let lastError = null;
    while (performance.now() < deadline) {
      if (state.pendingTimedOutNode && !independentClient) {
        throw Object.assign(new Error('逾時案例已停止等待。'), { code: 'E2E_NODE_CANCELLED' });
      }
      try {
        const value = predicate();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(intervalMs);
    }
    if (lastError) throw lastError;
    return null;
  }

  function safe(value) {
    try { return JSON.parse(JSON.stringify(value ?? {})); }
    catch { return {}; }
  }

  function plainError(error) {
    const api = error?.apiDiagnostic && typeof error.apiDiagnostic === 'object'
      ? safe(error.apiDiagnostic)
      : null;
    return {
      code: String(error?.code || error?.name || 'Error').slice(0, 120),
      message: String(error?.message || error || '未知錯誤').slice(0, 500),
      ...(api ? { api } : {})
    };
  }

  function outcome(status, message, expected, actual) {
    return { status, message, expected: safe(expected), actual: safe(actual) };
  }

  function pass(message, expected, actual) {
    return outcome('passed', message, expected, actual);
  }

  function fail(message, expected, actual) {
    return outcome('failed', message, expected, actual);
  }

  function skip(message, expected, actual) {
    return outcome('skipped', message, expected, actual);
  }

  function adminHumanRequired(key, name, domain) {
    const normalizedKey = String(key || '');
    const normalizedName = String(name || '');
    const normalizedDomain = String(domain || '');
    if (normalizedKey === 'PAIRED_HUMAN_INTERACTION_COVERAGE' || normalizedDomain === 'Coverage') return false;
    if (/真人/.test(normalizedName)) return true;
    if (normalizedDomain === 'Admin CRUD E2E') return true;
    if (normalizedDomain === 'Admin Settings E2E') return true;
    if (/^Booking Queue E2E \/ (?:Pending|Cancellation)$/.test(normalizedDomain)) return true;
    if (/^Booking \/ (?:Confirm|Modify Items|Modify Technician|Complete|Reject|Cancellation Keep|Cancellation Approve)$/.test(normalizedDomain)) return true;
    if (/^Paired E2E \/ (?:Membership|Points)$/.test(normalizedDomain)) return true;
    return /^PAIRED_\d+_ADMIN_BOOKING_(?:CONFIRM|MODIFY|MODIFY_TECHNICIAN|COMPLETE|REJECT|KEEP_CANCELLATION|CANCEL)$/.test(normalizedKey);
  }

  function caseDef(key, name, domain, run) {
    return { key, name, domain, run, humanRequired: adminHumanRequired(key, name, domain) };
  }

  function backgroundRunnerUrl(runId) {
    const url = new URL(window.location.href);
    url.searchParams.set(BACKGROUND_RUNNER_PARAM, '1');
    url.searchParams.set('e2eRunId', String(runId || Date.now()));
    return url.href;
  }

  function closeWindowList(windows) {
    for (const item of Array.isArray(windows) ? windows : []) {
      try { if (item && !item.closed) item.close(); } catch {}
    }
  }

  function openBackgroundRunnerWindow(runId) {
    const child = window.open(
      backgroundRunnerUrl(runId),
      'admin-e2e-background-' + String(runId || Date.now()),
      'popup=yes,width=1280,height=900,resizable=yes,scrollbars=yes'
    );
    if (!child) {
      const error = new Error('瀏覽器阻擋了背景管理端 E2E Runner。請允許此網站開啟彈出式視窗後重試。');
      error.code = 'E2E_BACKGROUND_POPUP_BLOCKED';
      throw error;
    }
    return child;
  }

  function backgroundStatusSnapshot() {
    const passed = state.results.filter((row) => row.status === 'passed').length;
    const failed = state.results.filter((row) => row.status === 'failed').length;
    const skipped = state.results.filter((row) => row.status === 'skipped').length;
    return {
      runId: state.backgroundRunId,
      running: state.running,
      cancelled: state.cancelled,
      selectedModules: state.selectedModules.slice(),
      currentExecution: (() => {
        const current = [...state.results].reverse().find((row) => row?.status === 'running') || null;
        return current ? {
          key: String(current.key || ''),
          name: String(current.name || ''),
          domain: String(current.domain || ''),
          status: 'running'
        } : null;
      })(),
      message: state.lastMessage,
      messageError: state.lastMessageError,
      testControl: isBackgroundRunnerWindow() ? safe(window.MemberAdminTestControl?.getStatus?.()) : null,
      summary: { total: state.results.length, passed, failed, skipped },
      coverage: state.featureCoverage ? safe(state.featureCoverage) : null,
      clientCoverage:safe(state.clientCoverage.map(item => ({participant:item.participant,surface:item.surface,coverage:item.coverage ? {total:item.coverage.total,counts:item.coverage.counts,complete:item.coverage.complete}:null}))),
      results: state.results.slice(-200).map((row) => ({
        key: String(row?.key || ''),
        name: String(row?.name || ''),
        domain: String(row?.domain || ''),
        status: String(row?.status || 'queued'),
        durationMs: row?.durationMs == null ? null : Number(row.durationMs || 0),
        message: String(row?.message || '')
      })),
      participants: state.participants.map((participant) => ({
        index: Number(participant?.index || 0),
        status: String(participant?.status || ''),
        surface: String(participant?.surface || ''),
        adminStatus: String(participant?.adminStatus || ''),
        mobileViewport: participant?.mobileViewport === true,
        runnerCount: participant?.window && !participant.window.closed ? 1 : 0
      }))
    };
  }

  function publishBackgroundStatus() {
    if (!state.backgroundExecution || !isBackgroundRunnerWindow()) return;
    const snapshot = backgroundStatusSnapshot();
    try {
      const opener = window.opener;
      if (opener && !opener.closed && typeof opener.MemberAdminE2EControl?.receiveBackgroundStatus === 'function') {
        opener.MemberAdminE2EControl.receiveBackgroundStatus(snapshot, window);
      }
    } catch {}
  }

  function receiveBackgroundStatus(snapshot, runnerWindow = null) {
    if (isBackgroundRunnerWindow() || !snapshot || typeof snapshot !== 'object') return false;
    if (!state.backgroundRunId || !snapshot.runId || String(snapshot.runId) !== String(state.backgroundRunId)) return false;
    state.backgroundLastStatusAt = Date.now();
    if (runnerWindow) {
      try {
        if (runnerWindow !== window && runnerWindow.location.origin === window.location.origin) state.backgroundRunnerWindow = runnerWindow;
      } catch {}
    }
    state.cancelled = Boolean(snapshot.cancelled);
    if (Array.isArray(snapshot.selectedModules) && snapshot.selectedModules.length) {
      try { state.selectedModules = normalizeSelectedModules(snapshot.selectedModules); } catch {}
    }
    state.lastMessage = String(snapshot.message || '');
    state.lastMessageError = Boolean(snapshot.messageError);
    state.featureCoverage = snapshot.coverage?.counts ? snapshot.coverage : null;
    state.clientCoverage = Array.isArray(snapshot.clientCoverage) ? snapshot.clientCoverage : [];
    state.coverageRunCode = '';
    persistCoverage();
    state.results = Array.isArray(snapshot.results) ? snapshot.results.map((row) => ({ ...row })) : state.results;
    state.participants = Array.isArray(snapshot.participants)
      ? snapshot.participants.map((participant) => ({ ...participant }))
      : state.participants;

    if (snapshot.running && !state.running) setBusy(true, '背景執行');
    if (!snapshot.running && state.running) setBusy(false);
    if (state.message && state.lastMessage) {
      state.message.textContent = state.lastMessage;
      state.message.classList.remove('hidden');
      state.message.classList.toggle('success', !state.lastMessageError);
    }
    render();
    renderParticipants();
    if (snapshot.testControl) window.MemberAdminTestControl?.receiveBackgroundStatus?.(snapshot.testControl, String(snapshot.runId));
    return true;
  }

  function resumeBackgroundStatus() {
    if (isBackgroundRunnerWindow() || document.hidden) return;
    const runner = state.backgroundRunnerWindow;
    try {
      if (runner && !runner.closed) receiveBackgroundStatus(runner.MemberAdminE2EControl?.getStatus?.());
    } catch {}
  }

  window.addEventListener('focus', resumeBackgroundStatus);
  window.addEventListener('pageshow', resumeBackgroundStatus);
  document.addEventListener?.('visibilitychange', resumeBackgroundStatus);

  async function waitForBackgroundRunnerControl(runnerWindow) {
    const deadline = Date.now() + BACKGROUND_RUNNER_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (state.cancelled) {
        const error = new Error('背景 Runner 啟動已取消，未開始後續 E2E 流程。');
        error.code = 'E2E_BACKGROUND_RUNNER_START_CANCELLED';
        throw error;
      }
      if (!runnerWindow || runnerWindow.closed) {
        const error = new Error('背景管理端 Runner 視窗已關閉。');
        error.code = 'E2E_BACKGROUND_RUNNER_CLOSED';
        throw error;
      }
      try {
        const doc = runnerWindow.document;
        if (runnerWindow.AdminE2EControlLoader?.getStatus?.().phase === 'failed') {
          const error = new Error('背景管理端 E2E 控制器載入失敗，請確認腳本資源與網路後重試。');
          error.code = 'E2E_BACKGROUND_RUNNER_CONTROL_LOAD_FAILED';
          throw error;
        }
        const errorView = doc?.getElementById?.('errorView');
        const errorVisible = Boolean(errorView && !errorView.classList.contains('hidden'));
        if (errorVisible) {
          const detail = String(
            doc.getElementById('errorMessage')?.textContent
            || doc.getElementById('errorTitle')?.textContent
            || '背景管理端 Runner 初始化失敗。'
          ).trim();
          const error = new Error(detail || '背景管理端 Runner 初始化失敗。');
          error.code = 'E2E_BACKGROUND_RUNNER_BOOT_FAILED';
          throw error;
        }
        if (doc?.documentElement?.dataset?.memberAdminReady === 'true') {
          const candidate = runnerWindow.MemberAdminE2EControl;
          if (typeof candidate?.runUnifiedBackground === 'function') {
            if (candidate.version !== VERSION) {
              const error = new Error('背景 Runner 與主管理頁版本不同，請重新整理管理端後重試。');
              error.code = 'E2E_BACKGROUND_RUNNER_VERSION_MISMATCH';
              throw error;
            }
            return candidate;
          }
        }
      } catch (error) {
        if (String(error?.code || '').startsWith('E2E_BACKGROUND_RUNNER_')) throw error;
      }
      await sleep(150);
    }
    const error = new Error('背景管理端 Runner 未能在允許時間內完成登入與初始化。');
    error.code = 'E2E_BACKGROUND_RUNNER_NOT_READY';
    throw error;
  }

  function backgroundRunnerSnapshot(runnerWindow) {
    const snapshot = { closed: Boolean(!runnerWindow || runnerWindow.closed), accessible: false };
    if (snapshot.closed) return snapshot;
    try {
      const doc = runnerWindow.document;
      snapshot.accessible = true;
      snapshot.page = {
        path: diagnosticPath(runnerWindow.location.href),
        readyState: String(doc.readyState || ''),
        visibilityState: String(doc.visibilityState || ''),
        online: runnerWindow.navigator?.onLine !== false
      };
      snapshot.adminReady = doc.documentElement?.dataset?.memberAdminReady === 'true';
      snapshot.loader = runnerWindow.AdminE2EControlLoader?.getStatus?.() || { phase: 'unavailable' };
      snapshot.controllerReady = typeof runnerWindow.MemberAdminE2EControl?.runUnifiedBackground === 'function';
      snapshot.controllerVersion = String(runnerWindow.MemberAdminE2EControl?.version || '');
      snapshot.errorVisible = Boolean(doc.getElementById('errorView') && !doc.getElementById('errorView').classList.contains('hidden'));
      snapshot.resources = runnerWindow.performance.getEntriesByType('resource').slice(-24).map((entry) => ({
        path: diagnosticPath(entry.name),
        initiatorType: String(entry.initiatorType || ''),
        responseStatus: Number(entry.responseStatus || 0) || null,
        durationMs: Math.max(0, Math.round(Number(entry.duration || 0)))
      }));
    } catch { /* An inaccessible window still has a useful lifecycle snapshot. */ }
    return snapshot;
  }

  function watchBackgroundCompletion(completion, runnerWindow) {
    let interval;
    const watchdog = new Promise((_, reject) => {
      interval = window.setInterval(() => {
        let code = '';
        if (!runnerWindow || runnerWindow.closed) code = 'E2E_BACKGROUND_RUNNER_CLOSED';
        else if (Date.now() - state.backgroundLastStatusAt > BACKGROUND_RUNNER_STALE_MS) code = 'E2E_BACKGROUND_RUNNER_STALLED';
        if (!code) return;
        const error = new Error(code === 'E2E_BACKGROUND_RUNNER_CLOSED'
          ? '背景 Runner 視窗已關閉；已停止等待並保留最後測試進度。'
          : '背景 Runner 長時間沒有回報進度；已停止等待並保留最後測試進度。');
        error.code = code;
        reject(error);
      }, 5000);
    });
    return Promise.race([completion, watchdog]).finally(() => window.clearInterval(interval));
  }



  function normalizeReplayContext(value) {
    if (!value) return null;
    const manifest = value.manifest;
    if (!manifest || Number(manifest.version) !== 1 || !Array.isArray(manifest.selectedModules)) throw new Error('Replay Manifest 格式不完整。');
    return { sourceRunId:String(value.sourceRunId||''), sourceRunCode:String(value.sourceRunCode||''), manifest:safe(manifest) };
  }
  function replaySurfacePlan(keys, modules) {
    const byKey = new Map(PAIRED_SURFACES);
    const result = (Array.isArray(keys)?keys:[]).map((key)=>[String(key||''),byKey.get(String(key||''))]).filter((item)=>item[1]&&modules.includes(item[0]));
    const expected = selectedClientSurfaces(modules);
    if (result.length!==expected.length || new Set(result.map(([key])=>key)).size!==result.length) throw new Error('Replay Manifest 的用戶端 Surface 路徑與目前所選模組不相容。');
    return result;
  }
  function orderedParticipants(participants, order) {
    const source=Array.isArray(participants)?participants:[];
    const byIndex=new Map(source.map((item)=>[Number(item.index),item]));
    const requested=Array.isArray(order)?order.map(Number):[];
    if(requested.length===source.length && new Set(requested).size===source.length && requested.every((index)=>byIndex.has(index))) return requested.map((index)=>byIndex.get(index));
    return shuffled(source);
  }
  function replayParticipant(index) {
    return state.replayContext?.manifest?.participants?.find((item)=>Number(item?.index)===Number(index)) || null;
  }
  function buildReplayManifest() {
    return {
      version:1, runnerVersion:VERSION, scenarioGraphVersion:Number(state.adminScenarioPlan?.version||1),
      rootSeed:String(state.randomSeed||''), complexityLevel:Number(state.complexityLevel||1),
      selectedModules:state.selectedModules.slice(), participantCount:Number(state.participantCount||1),
      clientConcurrency:Number(state.clientConcurrency||1), mobileViewport:state.clientMobileViewport===true,
      participantExecutionOrder:state.participantExecutionOrder.slice(), syncOrder:state.syncOrder.slice(),
      deepParticipantIndex:state.deepParticipantIndex==null?null:Number(state.deepParticipantIndex),
      adminScenario:{
        scenarioFingerprint:String(state.adminScenarioPlan?.fingerprint||''),
        scenarioPath:Array.isArray(state.adminScenarioPlan?.keys)?state.adminScenarioPlan.keys.slice():[],
        randomStateAfterPlan:state.adminRandomStateAfterPlan>>>0
      },
      participants:state.participants.map((participant)=>({
        index:Number(participant.index||0), preferredMemberId:String(participant.account?.memberId||''),
        seed:String(participant.seed||''), surfacePlan:Array.isArray(participant.surfacePlan)?participant.surfacePlan.map(([key])=>key):[],
        surfaces:safe(participant.surfaceReplayResults||{})
      }))
    };
  }
  async function fetchReplayManifest(runId) {
    const session=await adminSession();
    return postFunction('test-control-api',{action:'admin.test-control.replay-manifest',clientType:'admin',idToken:session.idToken,runId:String(runId||'')});
  }
  function applyReplayControls(manifest) {
    const selected=new Set(Array.isArray(manifest?.selectedModules)?manifest.selectedModules:[]);
    state.section?.querySelectorAll('[data-e2e-module]').forEach((input)=>{input.checked=selected.has(String(input.dataset.e2eModule||''));});
    const countInput=state.section?.querySelector('#pairedE2EAccountCount'); if(countInput) countInput.value=String(Math.max(1,Number(manifest?.participantCount||1)));
    const mobile=state.section?.querySelector('#pairedE2EMobileViewport'); if(mobile) mobile.checked=manifest?.mobileViewport===true;
  }
  async function replayFailedRun(runId) {
    if(isBackgroundRunnerWindow()) throw new Error('請從主管理頁啟動失敗重播。');
    if(state.running) return {started:false,reason:'already-running'};
    const data=await fetchReplayManifest(runId);
    const context=normalizeReplayContext({sourceRunId:data?.sourceRun?.id||runId,sourceRunCode:data?.sourceRun?.runCode||'',manifest:data?.manifest});
    applyReplayControls(context.manifest);
    setMessage('正在鎖定 '+(context.sourceRunCode||'失敗 E2E')+' 的原始路徑並建立全新測試 Session…');
    return startUnifiedBackgroundE2E({replay:context});
  }

  function startUnifiedBackgroundE2E(options = {}) {
    if (state.running) return { started: false, reason: 'already-running' };

    let participantCount = 1;
    let runnerWindow = null;
    let clientWindows = [];
    let mobileViewport = false;
    let selectedModules = [];
    const replay = normalizeReplayContext(options?.replay);
    const runId = 'BG-' + Date.now().toString(36).toUpperCase() + '-' + randomInt(1000, 9999);
    state.backgroundRunId = runId;
    state.backgroundLastStatusAt = Date.now();
    try {
      participantCount = replay ? Math.max(1, Number(replay.manifest.participantCount || 1)) : selectedParticipantCount();
      mobileViewport = replay ? replay.manifest.mobileViewport === true : selectedClientMobileViewport();
      selectedModules = replay ? normalizeSelectedModules(replay.manifest.selectedModules) : selectedModulesFromUi();
      runnerWindow = openBackgroundRunnerWindow(runId);
      clientWindows = openClientWindows(selectedClientSurfaces(selectedModules).length ? participantCount : 0, false, mobileViewport);
    } catch (error) {
      closeWindowList(clientWindows);
      try { if (runnerWindow && !runnerWindow.closed) runnerWindow.close(); } catch {}
      state.backgroundRunId = '';
      setMessage(error?.message || '無法啟動背景完整 E2E。', true);
      return { started: false, error: plainError(error) };
    }

    state.cancelled = false;
    state.failureScreenshotsCaptured = 0;
    state.results = [];
    state.featureCoverage = null;
    state.clientCoverage = [];
    state.coverageRunCode = '';
    persistCoverage();
    state.participants = [];
    state.runStartedAt = new Date().toISOString();
    state.adminScenarioPlan = null;
    state.backgroundRunnerWindow = runnerWindow;
    state.backgroundRunId = runId;
    state.clientMobileViewport = mobileViewport;
    state.selectedModules = selectedModules;
    state.replayContext = replay;
    state.lastMessage = (replay ? '失敗重播 Runner 啟動中；來源：' + (replay.sourceRunCode || replay.sourceRunId) + '；範圍：' : '背景 E2E Runner 啟動中；範圍：') + selectedModules.map((key) => E2E_MODULES.find(([item]) => item === key)?.[1]).join('、') + '。';
    state.lastMessageError = false;
    setBusy(true, '背景 Runner 啟動');
    setMessage(state.lastMessage);
    render();
    try { runnerWindow.blur?.(); window.focus?.(); } catch {}

    const marker = adminDiagnosticMarker();
    const completion = (async () => {
      const control = await waitForBackgroundRunnerControl(runnerWindow);
      setMessage('E2E 已移交背景 Runner；只執行勾選模組的 Browser 案例。測試視窗請保持開啟。');
      try { runnerWindow.blur?.(); window.focus?.(); } catch {}

      const result = await watchBackgroundCompletion(control.runUnifiedBackground({
        participantCount,
        clientWindows,
        mobileViewport,
        selectedModules,
        runId,
        replay
      }), runnerWindow);

      state.featureCoverage = result?.coverage || null;
      state.clientCoverage = result?.clientCoverage || [];
      state.coverageRunCode = String(result?.recorded?.run?.runCode || '');
      persistCoverage();
      if (Array.isArray(result?.results)) state.results = result.results.map((row) => ({ ...row }));
      render();
      try { await window.MemberAdminTestControl?.refresh?.(); } catch {}
      const failed = state.results.filter((row) => row.status === 'failed').length;
      setMessage(
        result?.cancelled
          ? '背景完整 E2E 已停止；已完成資料與測試紀錄保留。'
          : failed
            ? '背景完整 E2E 已完成，發現 ' + failed + ' 個異常。'
            : '所選模組 E2E 已完成；後端 QA、管理端與所選用戶端案例均已執行。',
        !result?.cancelled && failed > 0
      );
      return result;
    })().catch(async (error) => {
      const startCancelled = error?.code === 'E2E_BACKGROUND_RUNNER_START_CANCELLED';
      const runnerSnapshot = backgroundRunnerSnapshot(runnerWindow);
      try { runnerWindow?.MemberAdminE2EControl?.stop?.(); } catch {}
      for (const row of state.results.filter((item) => item.status === 'running')) {
        row.status = 'failed';
        row.message = '背景 Runner 中斷，節點未能完成驗證。';
        row.actual = { code: 'E2E_BACKGROUND_INTERRUPTED' };
        row.durationMs = Math.max(0, Date.now() - Date.parse(state.runStartedAt || new Date().toISOString()));
      }
      const failure = {
        key: 'E2E_BACKGROUND_RUNNER_FAILURE', name: '背景 Runner 存活與進度',
        domain: 'Paired E2E / Orchestration', status: startCancelled ? 'skipped' : 'failed',
        message: String(error?.message || '背景 Runner 中斷。'),
        expected: { runnerResponding: true },
        actual: {
          ...plainError(error),
          runnerVersion: VERSION,
          runId,
          runnerClosed: runnerSnapshot.closed,
          runnerSnapshot,
          lastStatusAgeMs: state.backgroundLastStatusAt
            ? Math.max(0, Date.now() - state.backgroundLastStatusAt)
            : null,
          lastCompletedCaseKey: String([...state.results].reverse().find((item) => item.status !== 'running')?.key || '')
        },
        durationMs: Math.max(0, Date.now() - marker.startedAtMs)
      };
      failure.trace = buildAdminFailureTrace(marker, failure, error, { runnerSnapshot, selectedModules });
      // Capture before closing the failing window; label a parent-page fallback explicitly.
      const captureWindow = runnerSnapshot.accessible ? runnerWindow : window;
      failure.trace.screenshotSurface = captureWindow === runnerWindow ? 'background-runner' : 'parent-admin';
      if (!startCancelled) await attachFailureScreenshot(failure, captureWindow);
      try { if (runnerWindow && !runnerWindow.closed) runnerWindow.close(); } catch {}
      closeWindowList(clientWindows);
      state.results.push(failure);
      render();
      try { await recordResultRows(state.results, 'paired-browser', 'full', '', state.runStartedAt, { rootRun: false }); } catch {}
      setMessage(error?.message || '背景完整 E2E 執行失敗。', !startCancelled);
      return { cancelled: startCancelled, error: plainError(error), results: state.results.slice() };
    }).finally(() => {
      setBusy(false);
      state.backgroundRunnerWindow = null;
      state.backgroundCompletion = null;
      if (!state.running) state.backgroundRunId = '';
    });

    state.backgroundCompletion = completion;
    return { started: true, runId, participantCount, mobileViewport, completion };
  }

  async function runUnifiedBackground(options = {}) {
    if (!isBackgroundRunnerWindow()) {
      const error = new Error('完整 E2E 的背景執行只能在隔離 Runner 視窗啟動。');
      error.code = 'E2E_BACKGROUND_RUNNER_REQUIRED';
      throw error;
    }
    state.backgroundExecution = true;
    state.backgroundRunId = String(options?.runId || new URLSearchParams(window.location.search).get('e2eRunId') || '');
    const heartbeat = window.setInterval(publishBackgroundStatus, 10000);
    try { return await runPaired({
      participantCount: Number(options?.participantCount || 0),
      clientWindows: Array.isArray(options?.clientWindows) ? options.clientWindows : [],
      mobileViewport: options?.mobileViewport === true,
      selectedModules: options?.selectedModules,
      replay: options?.replay,
      backgroundExecution: true
    }); }
    finally { window.clearInterval(heartbeat); }
  }
  function setBusy(running, label = '') {
    state.running = Boolean(running);
    state.section?.querySelectorAll('button[data-admin-e2e-control]').forEach((button) => {
      button.disabled = state.running || Boolean(state.pendingTimedOutNode);
    });
    const stopButton = state.section?.querySelector('#stopAdminE2EButton');
    if (stopButton) {
      stopButton.disabled = !state.running;
      stopButton.classList.toggle('hidden', !state.running);
    }
    const countInput = state.section?.querySelector('#pairedE2EAccountCount');
    if (countInput) countInput.disabled = state.running;
    const mobileViewportInput = state.section?.querySelector('#pairedE2EMobileViewport');
    if (mobileViewportInput) mobileViewportInput.disabled = state.running;
    state.section?.querySelectorAll('[data-e2e-module]').forEach((input) => { input.disabled = state.running; });
    if (state.badge) {
      state.badge.textContent = state.running
        ? (state.cancelled ? '模組 E2E：停止中' : (state.backgroundExecution || state.backgroundRunnerWindow ? '模組 E2E：背景執行中' : '模組 E2E：執行中'))
        : '模組 E2E：待命';
      state.badge.classList.toggle('is-on', state.running);
      state.badge.classList.toggle('is-off', !state.running);
    }
    if (state.floating) {
      state.floating.classList.toggle('hidden', !state.running);
      state.floating.textContent = state.running ? ((state.cancelled ? 'E2E 停止中' : 'E2E 背景執行中') + (label ? ' · ' + label : '')) : '';
    }
    publishBackgroundStatus();
  }

  function requestStop() {
    if (!state.running || state.cancelled) return false;

    if (!isBackgroundRunnerWindow() && state.backgroundRunnerWindow && !state.backgroundRunnerWindow.closed) {
      state.cancelled = true;
      try { state.backgroundRunnerWindow.MemberAdminE2EControl?.stop?.(); } catch {}
      if (state.badge) state.badge.textContent = '模組 E2E：停止中';
      if (state.floating) state.floating.textContent = 'E2E 停止中 · 已傳送到背景 Runner';
      setMessage('已要求背景 E2E 停止；背景 Runner 會在目前案例完成安全清理後停止。');
      return true;
    }

    state.cancelled = true;
    if (state.badge) state.badge.textContent = '模組 E2E：停止中';
    if (state.floating) state.floating.textContent = 'E2E 停止中 · 目前案例完成安全清理後停止';
    for (const participant of state.participants) {
      participant.status = '停止中';
      try {
        const child = participant.window;
        if (child && !child.closed && typeof child.MemberUserTestControl?.stop === 'function') child.MemberUserTestControl.stop();
      } catch {}
    }
    renderParticipants();
    setMessage('已要求停止 E2E；目前正在執行的案例會先完成安全清理，之後不再啟動下一個案例。');
    publishBackgroundStatus();
    return true;
  }

  

  function setMessage(message, error = false) {
    state.lastMessage = String(message || '');
    state.lastMessageError = Boolean(error);
    if (state.message) {
      state.message.textContent = state.lastMessage;
      state.message.classList.toggle('hidden', !state.lastMessage);
      state.message.classList.toggle('success', !error);
    }
    publishBackgroundStatus();
  }

  function finalizeFeatureCoverage() {
    const coverage = window.MemberE2EFeatureCoverage?.report?.({side:'admin',modules:state.selectedModules,
      registeredKeys:adminDefinitions('full').map(item => item.key),
      plannedKeys:state.adminScenarioPlan?.keys || [], results:state.results});
    state.featureCoverage = coverage || null;
    const gaps = coverage?.features.filter(item => item.status !== 'passed').map(item => ({id:item.id,level:item.level,status:item.status,keys:item.keys})) || [];
    state.results.push({key:'ADMIN_FEATURE_COVERAGE_SUMMARY',name:'管理端功能節點執行覆蓋摘要',domain:'Coverage',durationMs:0,
      ...(!coverage || coverage.counts.unregistered || coverage.counts.unplanned
        ? fail('功能節點缺少登記或本輪路徑不完整。', {complete:true}, {total:coverage?.total || 0,counts:coverage?.counts || {},gaps,execution:coverage?.execution || null})
        : coverage.complete ? pass('所選模組的管理端登記節點均通過。', {complete:true}, {total:coverage.total,counts:coverage.counts,gaps,execution:coverage.execution})
        : fail('管理端仍有失敗、略過或未執行功能，本輪覆蓋未完成。', {complete:true}, {total:coverage.total,counts:coverage.counts,gaps,execution:coverage.execution}))});
    render();
  }

  function renderFeatureCoverage() {
    if (!state.section) return;
    let host = state.section.querySelector('[data-e2e-feature-coverage]');
    if (!host) {
      host = document.createElement('div');
      host.dataset.e2eFeatureCoverage = 'true';
      host.className = 'e2e-feature-coverage';
      host.setAttribute('aria-live','polite');
      state.summary?.before(host);
    }
    host.replaceChildren();
    if (!state.featureCoverage?.counts) return;
    const source = document.createElement('p');
    source.textContent = state.coverageRunCode ? '功能覆蓋紀錄：' + state.coverageRunCode
      : state.running ? '本輪功能覆蓋' : '上次保存的功能覆蓋；未執行項目仍待驗證';
    host.append(source);
    const reports = [['管理端',state.featureCoverage],...state.clientCoverage.map(item => ['用戶 ' + item.participant + ' · ' + item.surface,item.coverage])];
    for (const [label,value] of reports) {
      const report = value?.counts ? value : null;
      const card = document.createElement('article');
      card.className = 'e2e-feature-coverage-card';
      const heading = document.createElement('strong'); heading.textContent = label;
      const count = document.createElement('p');
      count.textContent = report ? `${report.counts.passed || 0} / ${report.total} 功能群組通過` : '尚無覆蓋結果';
      card.append(heading,count);
      if (report) {
        const progress = document.createElement('progress');progress.max=report.total || 1;progress.value=report.counts.passed || 0;progress.setAttribute('aria-label',label + ' 功能群組通過數');card.append(progress);
        const status = document.createElement('small');
        status.textContent = report.complete ? '登記節點均通過；裝置／外部服務限制另列' : `失敗 ${report.counts.failed || 0} · 阻擋 ${report.counts.blocked || 0} · 未執行 ${report.counts['not-run'] || 0} · 未納入 ${(report.counts.unplanned || 0) + (report.counts.unregistered || 0)}`;
        if (report.execution) status.textContent += ` · ${report.execution.passed || 0} / ${report.execution.total || 0} 節點通過`;
        card.append(status);
      }
      host.append(card);
    }
  }

  function render() {
    const passed = state.results.filter((r) => r.status === 'passed').length;
    const failed = state.results.filter((r) => r.status === 'failed').length;
    const skipped = state.results.filter((r) => r.status === 'skipped').length;
    if (!state.list || !state.summary) {
      publishBackgroundStatus();
      return;
    }
    renderFeatureCoverage();
    state.summary.textContent = `共 ${state.results.length} 案例 · ${passed} 通過 · ${failed} 失敗 · ${skipped} 略過`;
    state.list.replaceChildren(...state.results.map((item, index) => {
      const details = document.createElement('details');
      details.className = 'test-control-case admin-e2e-case is-' + String(item.status || 'queued');
      if (item.status === 'failed') details.open = true;
      const summary = document.createElement('summary');
      summary.innerHTML = `<span class="test-control-case-index">${index + 1}</span><span class="test-control-case-title"><strong></strong><small></small></span><span class="test-control-case-status"></span>`;
      summary.querySelector('strong').textContent = item.name || item.key || 'E2E case';
      summary.querySelector('small').textContent = (item.domain || 'Browser E2E') + (item.durationMs != null ? ' · ' + Math.round(item.durationMs) + ' ms' : '');
      summary.querySelector('.test-control-case-status').textContent =
        item.status === 'passed' ? '通過' : item.status === 'failed' ? '失敗' : item.status === 'skipped' ? '略過' : '執行中';
      const body = document.createElement('div');
      body.className = 'admin-e2e-case-body';
      const message = document.createElement('p');
      message.textContent = item.message || '';
      const grid = document.createElement('div');
      grid.className = 'admin-e2e-data-grid';
      grid.append(dataBox('Expected', item.expected), dataBox('Actual', item.actual));
      if (item.status === 'failed' && item.trace) grid.append(dataBox('Diagnostics', item.trace));
      body.append(message, grid);
      details.append(summary, body);
      return details;
    }));
    publishBackgroundStatus();
  }

  function dataBox(label, value) {
    const box = document.createElement('div');
    box.className = 'admin-e2e-data-box';
    const title = document.createElement('strong');
    title.textContent = label;
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(safe(value), null, 2);
    box.append(title, pre);
    return box;
  }

  function adminHumanTargetLabel(node) {
    if (!node || node.nodeType !== 1) return 'unknown';
    const id = String(node.id || '').trim();
    if (id) return '#' + id;
    const action = String(node.getAttribute?.('data-action') || node.getAttribute?.('data-booking-admin-action') || '').trim();
    if (action) return '[action=' + action + ']';
    const cls = String(node.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    const tag = String(node.tagName || 'element').toLowerCase();
    return cls ? tag + '.' + cls : tag;
  }

  async function captureAdminHumanInteraction(run, def = null) {
    const professional = window.MemberE2EProfessionalTester;
    if (professional && typeof professional.capture === 'function') {
      const meta = ADMIN_NODE_META[String(def?.key || '')] || {};
      return professional.capture({
        document,
        caseKey: String(def?.key || ''),
        domain: String(def?.domain || ''),
        module: String(meta.module || 'shared'),
        risk: String(meta.risk || ''),
        side: 'admin',
        surface: 'admin',
        complexityLevel: state.complexityLevel,
        seed: state.randomSeed,
        learning: historicalLearning(def?.key),
        delay: sleep,
        maxEvents: 140,
        labelTarget: adminHumanTargetLabel,
        excludeTarget: (target) => Boolean(state.section?.contains?.(target)),
        registerCleanup: (cleanup) => { state.activeHumanCaptureCleanup = typeof cleanup === 'function' ? cleanup : null; }
      }, run);
    }
    const events = [];
    const types = ['click', 'input', 'change', 'submit'];
    const handler = (event) => {
      const target = event?.target;
      if (!target || state.section?.contains(target)) return;
      events.push({
        type: String(event.type || ''),
        target: adminHumanTargetLabel(target),
        trusted: event.isTrusted === true
      });
      if (events.length > 100) events.shift();
    };
    types.forEach((type) => document.addEventListener(type, handler, true));
    const cleanup = () => types.forEach((type) => document.removeEventListener(type, handler, true));
    state.activeHumanCaptureCleanup = cleanup;
    try {
      await sleep(randomInt(80, 260));
      const outcome = await run();
      await sleep(randomInt(70, 220));
      return {
        outcome,
        evidence: {
          eventCount: events.length,
          eventTypes: [...new Set(events.map((item) => item.type))],
          targets: [...new Set(events.map((item) => item.target))].slice(0, 24)
        }
      };
    } finally {
      cleanup();
      if (state.activeHumanCaptureCleanup === cleanup) state.activeHumanCaptureCleanup = null;
    }
  }

  function retainTimedOutNode(pending) {
    state.pendingTimedOutNode = pending;
    const settled = () => {
      if (state.pendingTimedOutNode !== pending) return;
      state.pendingTimedOutNode = null;
      setBusy(state.running);
    };
    pending.then(settled, settled);
  }

  async function drainTimedOutAdminNode() {
    const pending = state.pendingTimedOutNode;
    if (!pending) return;
    let timer;
    try {
      await Promise.race([
        pending.catch(() => {}),
        new Promise(resolve => { timer = window.setTimeout(resolve, ADMIN_NODE_DRAIN_TIMEOUT_MS); })
      ]);
    } finally { window.clearTimeout(timer); }
  }

  async function executeCases(defs, phaseLabel) {
    for (const def of defs) {
      if (state.cancelled) break;
      // An unrelated member window may continue, but never overlap management
      // mutations with an original admin action that has not finished cleanup.
      if (state.pendingTimedOutNode) {
        state.results.push({ key: def.key, name: def.name, domain: def.domain,
          humanRequired: def.humanRequired === true, durationMs: 0,
          ...fail('前一個管理端逾時操作尚未完成清理，本項未執行。',
            { executed: true }, { executed: false, code: 'E2E_ADMIN_NODE_DRAINING' }) });
        render();
        continue;
      }
      const row = {
        key: def.key,
        name: def.name,
        domain: def.domain,
        humanRequired: def.humanRequired === true,
        status: 'running',
        message: '執行中…',
        expected: {},
        actual: {},
        durationMs: null
      };
      state.results.push(row);
      if (state.floating) state.floating.textContent = 'E2E 執行中 · ' + phaseLabel + ' · ' + def.name;
      render();
      const started = performance.now();
      const traceMarker = adminDiagnosticMarker();
      let timedOut = false;
      try {
        const outcome = await window.MemberE2EScenarioGraph.runWithDeadline(async () => {
          let result;
          if (def.humanRequired === true) {
            const captured = await captureAdminHumanInteraction(def.run, def);
            result = captured.outcome;
            const mergedActual = result?.actual && typeof result.actual === 'object' && !Array.isArray(result.actual)
              ? { ...result.actual, humanInteraction: captured.evidence }
              : { value: result?.actual ?? null, humanInteraction: captured.evidence };
            if (result?.status === 'passed' && Number(captured.evidence.eventCount || 0) < 1) {
              result = fail(
                '案例邏輯完成，但沒有觀察到管理端真人 UI 互動事件；完整 E2E 不接受只走 API／內部函式。',
                { humanInteractionEventsAtLeast: 1 }, mergedActual
              );
            } else if (result?.status === 'passed' && captured.evidence.professionalTester?.ok === false) {
              result = fail(
                '專業 QA 行為檢查偵測到管理端操作引入 UI 結構回歸；完整 E2E 不接受新增重複 ID 或水平溢位。',
                { humanInteractionEventsAtLeast: 1, professionalTesterStructuralRegressionFree: true }, mergedActual
              );
            } else {
              result = { ...result, actual: safe(mergedActual) };
            }
          } else {
            result = await def.run();
          }
          return result;
        }, /^ADMIN_BOOKING_|^PAIRED_.*BOOKING/.test(def.key) ? ADMIN_BOOKING_NODE_TIMEOUT_MS : ADMIN_NODE_TIMEOUT_MS,
        def.key, (pending) => {
          retainTimedOutNode(pending);
          state.activeHumanCaptureCleanup?.();
          state.activeHumanCaptureCleanup = null;
        });
        Object.assign(row, outcome);
        if (row.status === 'failed') {
          row.trace = buildAdminFailureTrace(traceMarker, row);
          await attachFailureScreenshot(row);
        }
      } catch (error) {
        timedOut = error?.code === 'E2E_NODE_TIMEOUT';
        Object.assign(row, fail('案例執行發生未預期錯誤。', { noUnhandledError: true }, plainError(error)));
        row.trace = buildAdminFailureTrace(traceMarker, row, error);
        await attachFailureScreenshot(row);
      }
      row.durationMs = Math.max(0, Math.round(performance.now() - started));
      render();
      if (timedOut) {
        // Let cooperative waits reject and finally blocks restore their state.
        // A stuck admin action blocks later admin actions, not independent clients.
        await drainTimedOutAdminNode();
      }
      if (state.cancelled) break;
      await sleep(50);
    }
  }

  

  async function adminSession() {
    const session = await window.MemberE2EScenarioGraph.runWithDeadline(
      () => window.MemberAdminSession?.wait?.(), 30000, 'ADMIN_SESSION'
    );
    if (!session?.idToken || !session?.config?.supabaseUrl) throw new Error('管理端 Session 尚未準備完成。');
    return session;
  }

  function functionUrl(config, slug) {
    const base = String(config?.supabaseUrl || '').replace(/\/$/, '');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(base)) throw new Error('Supabase URL 設定不完整。');
    return base + '/functions/v1/' + slug;
  }

  async function postFunction(slug, body) {
    const session = await adminSession();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 120000);
    const startedAt = performance.now();
    const action = String(body?.action || '').slice(0, 120);
    const diagnostic = (phase, extra = {}) => ({
      functionSlug: String(slug || '').slice(0, 80),
      action,
      phase,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      ...extra
    });
    let response;
    let parsed;
    try {
      response = await fetch(functionUrl(session.config, slug), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: String(session.config.supabasePublishableKey || '')
        },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify(body)
      });
      parsed = await response.json().catch(() => null);
      if (controller.signal.aborted) throw new Error('request-aborted');
    } catch (error) {
      if (controller.signal.aborted) {
        const timeout = new Error('E2E 後端請求逾時：' + slug);
        timeout.code = 'E2E_API_TIMEOUT';
        timeout.apiDiagnostic = diagnostic('timeout', { aborted: true });
        throw timeout;
      }
      const transport = error instanceof Error ? error : new Error(String(error || 'E2E network error'));
      transport.apiDiagnostic = diagnostic('transport');
      throw transport;
    } finally {
      window.clearTimeout(timer);
    }
    if (!response.ok || !parsed || parsed.ok !== true) {
      const error = new Error(parsed?.error?.message || 'E2E 後端服務拒絕操作。');
      error.code = parsed?.error?.code || 'E2E_API_ERROR';
      const blocker = parsed?.error?.details;
      if (error.code === 'E2E_RECYCLE_BLOCKED' && blocker?.blockage === 'qa_artifacts_remain') {
        const count = Number(blocker.remainingQaArtifacts);
        if (Number.isSafeInteger(count) && count > 0 && count <= 1000000) {
          error.message += '（目前仍有 ' + count + ' 筆 QA 資源待清理）';
        }
      }
      error.apiDiagnostic = diagnostic('http', {
        httpStatus: Number(response.status || 0),
        responseParsed: Boolean(parsed),
        serverCode: String(parsed?.error?.code || '').slice(0, 120)
      });
      throw error;
    }
    return parsed.data || {};
  }

  async function ensureHtml2Canvas() {
    if (typeof window.html2canvas === 'function') return window.html2canvas;
    if (html2canvasLoader) return html2canvasLoader;
    html2canvasLoader = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-e2e-html2canvas="true"]');
      const script = existing || document.createElement('script');
      if (!existing) {
        script.src = HTML2CANVAS_URL;
        script.async = true;
        script.crossOrigin = 'anonymous';
        script.referrerPolicy = 'no-referrer';
        script.dataset.e2eHtml2canvas = 'true';
        document.head.appendChild(script);
      }
      const done = () => typeof window.html2canvas === 'function'
        ? resolve(window.html2canvas)
        : reject(new Error('html2canvas 載入後仍不可用。'));
      script.addEventListener('load', done, { once: true });
      script.addEventListener('error', () => reject(new Error('html2canvas 載入失敗。')), { once: true });
      if (existing && typeof window.html2canvas === 'function') done();
    }).catch((error) => {
      html2canvasLoader = null;
      throw error;
    });
    return html2canvasLoader;
  }

  function redactScreenshotClone(cloneDocument) {
    const sensitive = /(token|secret|password|phone|birthday|email|line.?user|surname|display.?name)/i;
    cloneDocument.querySelectorAll('input, textarea, [data-e2e-redact]').forEach((node) => {
      const signature = [
        node.id,
        node.getAttribute?.('name'),
        node.getAttribute?.('autocomplete'),
        node.getAttribute?.('placeholder'),
        node.className
      ].filter(Boolean).join(' ');
      if (node.hasAttribute?.('data-e2e-redact') || sensitive.test(signature)) {
        if ('value' in node) node.value = '[redacted]';
        node.setAttribute?.('value', '[redacted]');
        if (!('value' in node)) node.textContent = '[redacted]';
      }
    });
    cloneDocument.querySelectorAll('[data-line-user-id], [data-phone], [data-birthday], [data-email]').forEach((node) => {
      node.textContent = '[redacted]';
    });
    cloneDocument.querySelectorAll('#adminName, #memberIdentity, #memberRecordsIdentity').forEach((node) => {
      node.textContent = '[redacted member identity]';
    });
    if (cloneDocument.querySelector('#realMembersSubtab[aria-selected="true"]')) {
      const memberTable = cloneDocument.querySelector('#memberTableBody');
      if (memberTable) memberTable.textContent = '[redacted real member directory]';
    }
    cloneDocument.querySelectorAll('#bookingAdminQueue [data-member-id], #bookingAdminQueue [data-line-user-id]').forEach((node) => {
      node.textContent = '[redacted member]';
    });
    cloneDocument.querySelectorAll('img').forEach((image) => {
      try {
        const url = new URL(String(image.src || ''), window.location.href);
        if (url.origin !== window.location.origin) image.style.visibility = 'hidden';
      } catch {
        image.style.visibility = 'hidden';
      }
    });
  }

  function canvasToWebp(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('WebP 編碼失敗。')), 'image/webp', quality);
    });
  }

  async function captureFailureScreenshotBlob(captureWindow = window) {
    const renderScreenshot = await ensureHtml2Canvas();
    const captureDocument = captureWindow.document;
    const width = Math.max(320, Number(captureWindow.innerWidth || captureDocument.documentElement.clientWidth || 1280));
    const height = Math.max(320, Number(captureWindow.innerHeight || captureDocument.documentElement.clientHeight || 900));
    const canvas = await renderScreenshot(captureDocument.body, {
      backgroundColor: '#ffffff',
      logging: false,
      useCORS: true,
      allowTaint: false,
      scale: 0.8,
      width,
      height,
      windowWidth: width,
      windowHeight: height,
      x: captureWindow.scrollX || 0,
      y: captureWindow.scrollY || 0,
      onclone: redactScreenshotClone
    });
    let blob = await canvasToWebp(canvas, 0.72);
    if (blob.size > FAILURE_SCREENSHOT_MAX_BYTES) blob = await canvasToWebp(canvas, 0.5);
    if (blob.size > FAILURE_SCREENSHOT_MAX_BYTES) throw new Error('WebP 失敗快照超過 1.9 MB，已略過上傳。');
    return { blob, width: canvas.width, height: canvas.height };
  }

  async function uploadFailureScreenshot(row, captureWindow = window, signal) {
    const session = await adminSession();
    const captured = await captureFailureScreenshotBlob(captureWindow);
    if (signal?.aborted) throw new Error('失敗快照擷取逾時。');
    const form = new FormData();
    form.set('actorType', 'admin');
    form.set('idToken', session.idToken);
    form.set('surface', 'admin');
    form.set('caseKey', String(row?.key || row?.name || 'case'));
    form.set('rootRunId', String(state.rootRunId || state.backgroundRunId || ('ADMIN-' + Date.now().toString(36))));
    form.set('width', String(captured.width));
    form.set('height', String(captured.height));
    form.set('file', captured.blob, 'failure.webp');

    const response = await fetch(functionUrl(session.config, 'e2e-artifact-api'), {
      method: 'POST',
      headers: { apikey: String(session.config.supabasePublishableKey || '') },
      cache: 'no-store',
      signal,
      body: form
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok !== true || !payload.data?.screenshot?.path) {
      const error = new Error(payload?.error?.message || '失敗快照上傳失敗。');
      error.code = payload?.error?.code || 'E2E_SCREENSHOT_UPLOAD_FAILED';
      throw error;
    }
    return payload.data.screenshot;
  }

  async function attachFailureScreenshot(row, captureWindow = window) {
    if (!row || row.status !== 'failed') return;
    if (state.failureScreenshotsCaptured >= FAILURE_SCREENSHOT_BUDGET) {
      row.trace = safe({
        ...(row.trace || {}),
        artifactVersion: Math.max(2, Number(row?.trace?.artifactVersion || 0)),
        screenshotCapture: { status: 'skipped', reason: 'run-budget', budget: FAILURE_SCREENSHOT_BUDGET }
      });
      return;
    }
    state.failureScreenshotsCaptured += 1;
    let timer;
    try {
      const controller = new AbortController();
      const timeout = new Promise((_, reject) => {
        timer = window.setTimeout(() => {
          controller.abort();
          reject(new Error('失敗快照擷取逾時。'));
        }, 12000);
      });
      const screenshot = await Promise.race([uploadFailureScreenshot(row, captureWindow, controller.signal), timeout]);
      row.trace = safe({ ...(row.trace || {}), artifactVersion: 3, screenshot });
    } catch (error) {
      row.trace = safe({
        ...(row.trace || {}),
        artifactVersion: Math.max(2, Number(row?.trace?.artifactVersion || 0)),
        screenshotCapture: { status: 'failed', error: plainError(error) }
      });
    } finally { window.clearTimeout(timer); }
  }

  function compactRecordSnapshot(value, maxChars = 1600) {
    const normalized = safe(value);
    let serialized = '';
    try { serialized = JSON.stringify(normalized); } catch { return { serializationFailed: true }; }
    if (serialized.length <= maxChars) return normalized;
    const screenshot = normalized?.screenshot && typeof normalized.screenshot === 'object'
      ? safe(normalized.screenshot)
      : null;
    return {
      truncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, Math.max(200, maxChars - 120)),
      ...(screenshot ? { screenshot } : {})
    };
  }

  function diagnosticPath(value) {
    try {
      const parsed = new URL(String(value || ''), window.location.href);
      return parsed.pathname || '/';
    } catch {
      return String(value || '').split('?')[0].slice(0, 240);
    }
  }

  function adminDiagnosticMarker() {
    return {
      resourceIndex: performance.getEntriesByType('resource').length,
      startedAtMs: Date.now()
    };
  }

  function adminResourceTimingsSince(index) {
    return performance.getEntriesByType('resource')
      .slice(Math.max(0, Number(index || 0)))
      .filter((entry) => ['fetch', 'xmlhttprequest'].includes(String(entry.initiatorType || '').toLowerCase()))
      .slice(-24)
      .map((entry) => ({
        path: diagnosticPath(entry.name),
        initiatorType: String(entry.initiatorType || ''),
        responseStatus: Number(entry.responseStatus || 0) || null,
        durationMs: Math.max(0, Math.round(Number(entry.duration || 0))),
        transferSize: Math.max(0, Number(entry.transferSize || 0))
      }));
  }

  function buildAdminFailureTrace(marker, row, error = null, extra = {}) {
    return safe({
      artifactVersion: 1,
      seed: state.randomSeed,
      complexityLevel: state.complexityLevel,
      rootRunId: state.rootRunId,
      clientConcurrency: state.clientConcurrency,
      backgroundExecution: state.backgroundExecution,
      caseKey: row?.key || '',
      domain: row?.domain || '',
      page: {
        path: diagnosticPath(window.location?.href || ''),
        readyState: String(document?.readyState || ''),
        visibilityState: String(document?.visibilityState || ''),
        online: window.navigator?.onLine !== false
      },
      elapsedMs: Math.max(0, Date.now() - Number(marker?.startedAtMs || Date.now())),
      apiTimings: adminResourceTimingsSince(marker?.resourceIndex),
      realtimeSummary: row?.actual?.realtime || row?.actual?.realtimeSync || null,
      participants: state.participants.slice(0, 10).map((participant) => ({
        index: participant.index,
        status: participant.status,
        surface: participant.surface,
        adminStatus: participant.adminStatus,
        lastSurfaceKey: participant.lastSurfaceKey
      })),
      error: error ? plainError(error) : null,
      ...safe(extra)
    });
  }

  async function recordResultRows(rows, runnerKind, suite, memberId = '', startedAt = '', recordMeta = {}) {
    const sourceRows = Array.isArray(rows) ? rows : [];
    if (!sourceRows.length) return null;
    // Keep a complete root in one record; only oversized non-root reports may batch.
    if (sourceRows.length > 500 && recordMeta?.rootRun === true) {
      throw Object.assign(new Error('Root E2E 超過 500 個案例，拒絕只保存部分 Root 結果。'), {code:'E2E_ROOT_CASE_LIMIT'});
    }
    if (sourceRows.length > 500) {
      const chunks = [];
      for (let offset = 0; offset < sourceRows.length; offset += 500) chunks.push(sourceRows.slice(offset, offset + 500));
      let rootBatchIndex = chunks.length - 1;
      if (recordMeta?.rootRun === true) {
        const failedIndex = chunks.map((chunk) => chunk.some((row) => row?.status === 'failed')).lastIndexOf(true);
        if (failedIndex >= 0) rootBatchIndex = failedIndex;
      }
      const batches = [];
      for (let index = 0; index < chunks.length; index += 1) {
        batches.push(await recordResultRows(
          chunks[index], runnerKind, suite, memberId, startedAt,
          index === rootBatchIndex ? recordMeta : { ...recordMeta, rootRun: false, replayManifest: undefined, replayOfRunId: undefined }
        ));
      }
      const rootBatch = batches[rootBatchIndex] || batches[batches.length - 1];
      return { ...rootBatch, runs: batches.map((batch) => batch?.run).filter(Boolean) };
    }
    const session = await adminSession();
    const cases = sourceRows.map((item) => {
      const detailLimit = item.status === 'failed' ? 3600 : 1400;
      return {
        key: item.key,
        name: item.name,
        domain: item.domain,
        status: item.status,
        message: String(item.message || '').slice(0, 1000),
        expected: compactRecordSnapshot(item.expected, detailLimit),
        actual: compactRecordSnapshot(item.actual, detailLimit),
        trace: item.status === 'failed' ? compactRecordSnapshot(item.trace || {}, 9000) : undefined,
        durationMs: Number(item.durationMs || 0)
      };
    });
    const payload = {
      action: 'admin.test-control.record-browser-run',
      clientType: 'admin',
      idToken: session.idToken,
      runnerKind,
      runnerVersion: VERSION,
      suite,
      memberId: memberId || undefined,
      startedAt: startedAt || state.runStartedAt || new Date(Date.now() - 1000).toISOString(),
      completedAt: new Date().toISOString(),
      cases,
      rootRun: recordMeta?.rootRun === true,
      e2eSeed: String(recordMeta?.e2eSeed || state.randomSeed || ''),
      complexityLevel: Number(recordMeta?.complexityLevel || state.complexityLevel || 1),
      rootRunId: String(recordMeta?.rootRunId || state.rootRunId || ''),
      clientConcurrency: Number(recordMeta?.clientConcurrency || state.clientConcurrency || 1),
      replayManifest: recordMeta?.replayManifest || undefined,
      replayOfRunId: String(recordMeta?.replayOfRunId || '') || undefined,
      featureCoverage: recordMeta?.rootRun === true || runnerKind === 'paired-browser' ? compactFeatureReport(state.featureCoverage) : undefined,
      clientCoverage: runnerKind === 'paired-browser' ? compactClientCoverage(state.clientCoverage) : undefined,
      selectedModules: runnerKind === 'paired-browser' ? state.selectedModules.slice() : undefined,
      participantCount: runnerKind === 'paired-browser' ? state.participantCount : undefined,
      expectedAdminKeys: runnerKind === 'paired-browser' ? adminDefinitions('full').map(item => item.key) : undefined
    };
    const fitted = window.MemberE2EFeatureCoverage?.compactRecordPayload?.(payload) || payload;
    if (new TextEncoder().encode(JSON.stringify(fitted)).byteLength > 320000) {
      throw Object.assign(new Error('E2E 紀錄容量超過限制。'),{code:'E2E_RECORD_TOO_LARGE'});
    }
    const recorded = await postFunction('test-control-api', fitted);
    window.MemberAdminTestControl?.acceptRecordedRun?.(recorded);
    return recorded;
  }

  async function recordRun(runnerKind, suite, memberId = '', extraMeta = {}) {
    return recordResultRows(
      state.results, runnerKind, suite, memberId, state.runStartedAt || '',
      {
        rootRun: true, e2eSeed: state.randomSeed, complexityLevel: state.complexityLevel,
        rootRunId: state.rootRunId, clientConcurrency: state.clientConcurrency,
        replayManifest: extraMeta?.replayManifest || undefined,
        replayOfRunId: String(extraMeta?.replayOfRunId || '') || undefined
      }
    );
  }

  function adminDefinitions(suite, modules = state.selectedModules) {
    const common = [
      caseDef('ADMIN_AUTH_READY', '管理端授權與頁面就緒', 'Authentication', adminReadyCase),
      caseDef('ADMIN_PRIMARY_NAVIGATION', '管理端主要分頁真人切換', 'UI', adminNavigationCase),
      caseDef('ADMIN_TEST_MEMBER_ROSTER', '測試會員名冊真人切換與載入', 'Member', adminTestRosterCase),
      caseDef('ADMIN_MEMBER_MODALS', '會員狀態／紀錄／發放視窗真人操作', 'UI', adminMemberModalCase)
    ];
    if (suite !== 'full') return common;
    const allSelected = modules.length === E2E_MODULES.length;
    return common.concat([
      caseDef('ADMIN_MEMBER_USAGE_LOGS', '使用紀錄：測試會員選取與七類歷程', 'Human E2E', adminMemberUsageLogsCase),
      caseDef('ADMIN_BOOKING_NO_SHOW_CONTROLS', '無故未到：分類與未到期按鈕邊界', 'Human E2E', adminBookingNoShowControlsCase),
      caseDef('ADMIN_SERVICE_GRANT_JOURNEY', '依服務項目發放：預覽／雙擊／會員回讀／清理', 'Human E2E', adminServiceGrantJourneyCase),
      caseDef('ADMIN_SETTINGS_COPY_CONTROLS', '設定複製：未儲存拒絕與取消', 'Human E2E', adminSettingsCopyControlsCase),
      caseDef('ADMIN_TIER_EDITOR_JOURNEY', '會員卡：全部樣式與預覽', 'Human E2E', adminTierEditorJourneyCase),
      caseDef('ADMIN_TERMS_EDITOR_JOURNEY', '會員條款：版本／唯讀／草稿互動', 'Human E2E', adminTermsEditorJourneyCase),
      caseDef('ADMIN_CARD_EDITOR_OPTIONS', '集點卡：樣式／到期／節點／清除', 'Human E2E', adminCardEditorOptionsCase),
      caseDef('ADMIN_CARD_SORT_JOURNEY', '集點卡：排序與草稿還原', 'Human E2E', adminCardSortJourneyCase),
      caseDef('ADMIN_EVENT_AUDIENCE_JOURNEY', '活動票券：對象與類型完整切換', 'Human E2E', adminEventAudienceJourneyCase),
      caseDef('ADMIN_CALENDAR_EVENT_CRUD', '營運日曆：活動連結／對象／加贈草稿 CRUD', 'Human E2E', () => adminCalendarCrudCase('event')),
      caseDef('ADMIN_EVENT_CALENDAR_SYNC', '活動票券：草稿同步日曆／唯讀／移除', 'Human E2E', adminEventCalendarSyncCase),
      caseDef('ADMIN_CALENDAR_NAVIGATION', '營運日曆：月份／今日／點日期新增', 'Human E2E', adminCalendarNavigationCase),
      caseDef('ADMIN_BOOKING_BATCH_EDITOR', '預約項目：批次新增／移除／取消', 'Human E2E', adminBookingBatchEditorCase),
      caseDef('ADMIN_FIXED_DRAFT_BIRTHDAY_MONTH', '固定票券草稿 CRUD：birthday_month', 'Human E2E', () => adminFixedTicketDraftLifecycleCase('birthday_month')),
      caseDef('ADMIN_FIXED_DRAFT_WEEKLY', '固定票券草稿 CRUD：weekly', 'Human E2E', () => adminFixedTicketDraftLifecycleCase('weekly')),
      caseDef('ADMIN_FIXED_DRAFT_MONTHLY', '固定票券草稿 CRUD：monthly', 'Human E2E', () => adminFixedTicketDraftLifecycleCase('monthly')),
      caseDef('ADMIN_FIXED_DRAFT_YEARLY', '固定票券草稿 CRUD：yearly', 'Human E2E', () => adminFixedTicketDraftLifecycleCase('yearly')),
      caseDef('ADMIN_TIER_SETTINGS', '會員等級門檻與樣式設定契約', 'Configuration', adminTierSettingsCase),
      caseDef('ADMIN_GRANT_NOTIFICATION_CONTROLS', '發放通知：立即／排程／不傳送切換', 'Human E2E', adminGrantNotificationControlsCase),
      caseDef('ADMIN_POINT_LIMIT_SETTINGS', '集點卡上限：Server/UI 與 0 不限', 'Admin Settings E2E', adminPointLimitSettingsCase),
      caseDef('ADMIN_BIRTHDAY_SETTINGS', '生日固定票券：目前 API 與空值驗證', 'Human E2E', adminBirthdaySettingsCase),
      caseDef('ADMIN_AUTOMATION_HEALTH', '排程工作：啟用、最近結果與執行時效', 'Automation Health', adminAutomationHealthCase),
      caseDef('ADMIN_FIXED_TICKET_CONTROLS', '固定票券：週期與效期草稿切換', 'Human E2E', adminFixedTicketControlsCase),
      caseDef('ADMIN_TICKET_LOCATION_CONTROLS', '票券 GPS 地點編輯器契約', 'Configuration', adminTicketLocationControlsCase),
      caseDef('ADMIN_TICKET_SERVICE_RULES', '票券服務項目與 any／all 編輯器', 'Human E2E', adminTicketServiceRulesCase),
      caseDef('ADMIN_BOOKING_ACCESSIBLE_QUEUE', '快照：待確認／已完成／全部篩選', 'Human E2E', adminBookingAccessibleQueueCase),
      caseDef('ADMIN_BOOKING_ACCESSIBLE_REVIEW', '快照：真人審核服務／票券／點數並完成結算', 'Booking / Accessible Review', adminBookingAccessibleReviewCase),
      caseDef('ADMIN_BOOKING_ACCESSIBLE_IDEMPOTENCY', '快照：重送審核不得重複集點或核銷', 'Booking / Accessible Idempotency', adminBookingAccessibleIdempotencyCase),
      caseDef('ADMIN_BOOKING_HISTORY_TICKET_SOURCES', '管理端預約：票券來源卡片', 'Booking / History', adminBookingHistoryTicketSourcesCase),
      caseDef('ADMIN_BOOKING_REJECT', '預約：管理端不通過固定節點', 'Booking / Paired Evidence', () => adminBookingPairedOperationEvidenceCase('REJECT', '不通過')),
      caseDef('ADMIN_BOOKING_CONFIRM', '預約：管理端確認預約固定節點', 'Booking / Paired Evidence', () => adminBookingPairedOperationEvidenceCase('CONFIRM', '確認預約')),
      caseDef('ADMIN_BOOKING_MODIFY_ITEMS', '預約：管理端修改項目固定節點', 'Booking / Paired Evidence', () => adminBookingPairedOperationEvidenceCase('MODIFY', '修改此位項目')),
      caseDef('ADMIN_BOOKING_MODIFY_TECHNICIAN', '預約：管理端修改技師固定節點', 'Booking / Paired Evidence', () => adminBookingPairedOperationEvidenceCase('MODIFY_TECHNICIAN', '修改此位技師')),
      caseDef('ADMIN_BOOKING_COMPLETE', '預約：管理端完成預約固定節點', 'Booking / Paired Evidence', () => adminBookingPairedOperationEvidenceCase('COMPLETE', '完成預約')),
      caseDef('ADMIN_BOOKING_CANCELLATION_KEEP', '預約：管理端保留取消申請固定節點', 'Booking / Paired Evidence', () => adminBookingPairedOperationEvidenceCase('KEEP_CANCELLATION', '保留預約')),
      caseDef('ADMIN_BOOKING_CANCELLATION_APPROVE', '預約：管理端確認取消固定節點', 'Booking / Paired Evidence', () => adminBookingPairedOperationEvidenceCase('CANCEL', '確認取消')),
      caseDef('ADMIN_BOOKING_TERMINAL_STATE', '預約：管理端／會員端終態一致', 'Booking / Paired Evidence', () => adminBookingPairedOperationEvidenceCase('TERMINAL', '兩端終態')),
      caseDef('ADMIN_BOOKING_REALTIME_SYNC', '預約：管理端動作 Realtime 同步固定節點', 'Booking / Realtime Evidence', adminBookingRealtimeEvidenceCase),
      caseDef('ADMIN_BOOKING_RISK_SCAN', '預約：同步／競態／越權風險掃描固定節點', 'Booking / Risk Evidence', adminBookingRiskEvidenceCase),
      caseDef('ADMIN_BOOKING_RESOURCE_CONTROLS', '技師：啟用／停用列表與新增取消', 'Human E2E', adminBookingResourceControlsCase),
      caseDef('ADMIN_TEST_MEMBER_PROFILE_EDIT', '真人操作：修改並還原測試會員資料', 'Human E2E', adminProfileMutationCase),
      caseDef('ADMIN_MEMBERSHIP_TERMS', '會員條款：管理端版本清單與啟用版本契約', 'Legal E2E', adminMembershipTermsCase),
      caseDef('ADMIN_FORCE_LOGOUT_SECURITY', '強制下線：測試會員 Session 撤銷與維護邊界', 'Security E2E', adminForceLogoutSecurityCase),
      caseDef('ADMIN_RESOURCE_EDITORS', '集點卡／票券／活動票券／日曆編輯視窗', 'Human E2E', adminResourceEditorsCase),
      caseDef('ADMIN_INTEGRATION_CENTER', '真人操作：整合中心總覽／權益／通知／Audit', 'Human E2E', adminIntegrationCenterCase),
      caseDef('ADMIN_INTEGRATION_NAVIGATION', '真人操作：整合中心跨模組快速導向', 'Human E2E', adminIntegrationNavigationCase),
      caseDef('ADMIN_TICKET_CRUD', '票券：新增／修改／封存／清理', 'Admin CRUD E2E', adminTicketCrudCase),
      caseDef('ADMIN_LOTTERY_TICKET_CRUD', '抽獎券：一般票券＋活動票券建立／機率／回讀／清理', 'Admin CRUD E2E', adminLotteryTicketCrudCase),
      caseDef('ADMIN_POINT_CARD_CRUD', '集點卡：新增／修改／刪除', 'Admin CRUD E2E', adminPointCardCrudCase),
      caseDef('ADMIN_EVENT_TICKET_CRUD', '活動票券：新增／修改／刪除', 'Admin CRUD E2E', adminEventTicketCrudCase),
      caseDef('ADMIN_EVENT_DAILY_LIMIT_SETTINGS', '活動票券：每日可使用張數設定與 Server/UI 一致性', 'Admin Settings E2E', adminEventDailyLimitSettingsCase),
      caseDef('ADMIN_CALENDAR_CRUD', '日曆：新增／修改／刪除', 'Admin CRUD E2E', adminCalendarCrudCase),
      caseDef('ADMIN_BOOKING_CRUD', '預約：類型與項目新增／修改／刪除', 'Admin CRUD E2E', adminBookingCrudCase),
      caseDef('ADMIN_BOOKING_CONTROLS', '預約管理分頁與新增視窗', 'Human E2E', adminBookingControlsCase),
      caseDef('ADMIN_BOOKING_SHARED_SETTINGS', '預約：共用設定複雜修改／跨端同步／衝突／保留修改', 'Admin Settings E2E', adminBookingSharedSettingsCase),
      caseDef('ADMIN_BOOKING_RECEIPT_VIEWER', '預約收據：管理端唯讀快照與安全 URL 契約', 'Booking / Receipt E2E', adminBookingReceiptViewerCase),
      caseDef('ADMIN_THEME_TOGGLE', '亮／暗主題切換與偏好還原', 'UI', adminThemeToggleCase),
      caseDef('ADMIN_MEMBER_DIRECTORY_CONTROLS', '會員搜尋／分頁／紀錄篩選', 'UI', adminMemberDirectoryControlsCase),
      caseDef('ADMIN_MESSAGE_PRESET_EDITOR', '預設訊息管理視窗與驗證', 'UI', adminMessagePresetEditorCase),
      caseDef('ADMIN_CALENDAR_BATCH_CONTROLS', '日曆批次新增／驗證／清除', 'UI', adminCalendarBatchControlsCase),
      caseDef('ADMIN_TEST_MODE_CONTROLS', '測試環境控制元件', 'UI', adminTestModeControlsCase),
      caseDef('ADMIN_TEST_ACCOUNT_LIFECYCLE', '測試帳號新增／選取／移除', 'Test Account E2E', adminTestAccountLifecycleCase),
      caseDef('ADMIN_FEATURE_CONTRACT_COVERAGE', '主要功能區塊 E2E 契約清單', 'Coverage', adminFeatureContractCoverageCase),
      caseDef('ADMIN_BUTTON_COVERAGE', '所有按鈕／動態控制覆蓋清單', 'Coverage', adminButtonCoverageCase)
    ]).filter((definition) => {
      if (definition.key === 'ADMIN_AUTH_READY' || definition.key === 'ADMIN_PRIMARY_NAVIGATION') return true;
      const owners = ADMIN_CASE_MODULES[definition.key];
      if (['ADMIN_THEME_TOGGLE','ADMIN_TEST_MODE_CONTROLS','ADMIN_TEST_ACCOUNT_LIFECYCLE'].includes(definition.key)) return true;
      return owners ? owners.some((key) => modules.includes(key)) : allSelected;
    });
  }

  function planAdminDefinitions(suite, modules = state.selectedModules) {
    const catalog = adminDefinitions(suite, modules);
    if (suite !== 'full') { state.adminScenarioPlan = null; return catalog; }
    const planner = window.MemberE2EScenarioGraph;
    const requiredKeys = ['ADMIN_AUTH_READY','ADMIN_PRIMARY_NAVIGATION', ...modules.map((module) => MODULE_HUMAN_EVIDENCE[module]).filter(Boolean)];
    if (modules.includes('booking')) requiredKeys.push('ADMIN_BOOKING_SHARED_SETTINGS');
    const replayAdmin = state.replayContext?.manifest?.adminScenario;
    if (replayAdmin) {
      if (!planner || typeof planner.replayScenario !== 'function') throw new Error('目前版本缺少管理端 locked-path replay planner，已停止重播。');
      const plan = planner.replayScenario({
        nodes: catalog, metaByKey: ADMIN_NODE_META, seed: state.randomSeed + '-ADMIN',
        complexityLevel: state.complexityLevel, requiredKeys,
        keys: replayAdmin.scenarioPath, expectedFingerprint: replayAdmin.scenarioFingerprint
      });
      const byKey = new Map(catalog.map((item) => [item.key, item]));
      state.adminScenarioPlan = plan;
      if (Number.isInteger(Number(replayAdmin.randomStateAfterPlan))) state.randomState = Number(replayAdmin.randomStateAfterPlan) >>> 0;
      state.adminRandomStateAfterPlan = state.randomState >>> 0;
      return plan.keys.map((key) => byKey.get(key)).filter(Boolean);
    }
    if (!planner || typeof planner.planScenario !== 'function') {
      state.adminScenarioPlan = {
        version: 1, seed: state.randomSeed, complexityLevel: state.complexityLevel, fingerprint: 'SG1-admin-fallback',
        keys: catalog.map((item) => item.key),
        path: catalog.map((item, index) => ({ order:index+1,key:item.key,name:item.name,domain:item.domain,module:'fallback',phase:0 }))
      };
      state.adminRandomStateAfterPlan = state.randomState >>> 0;
      return catalog;
    }
    const plan = planner.planScenario({
      nodes: catalog, metaByKey: ADMIN_NODE_META, randomUnit: nextRandomUnit,
      seed: state.randomSeed + '-ADMIN', complexityLevel: state.complexityLevel,
      coverageMode: 'full', minNodes: catalog.length, maxNodes: catalog.length, requiredKeys,
      priorityByKey: historicalPriorityMap()
    });
    const byKey = new Map(catalog.map((item) => [item.key,item]));
    state.adminScenarioPlan = plan;
    state.adminRandomStateAfterPlan = state.randomState >>> 0;
    return plan.keys.map((key)=>byKey.get(key)).filter(Boolean);
  }

  async function runPairedAdminBookingLive(participant) {
    const wrapperKey = 'PAIRED_' + participant.index + '_ADMIN_BOOKING_FOLLOWUP';
    const rowPrefix = 'PAIRED_' + participant.index + '_ADMIN_BOOKING_';
    participant.adminStatus = '完整接手清單已就緒，管理端開始處理';
    renderParticipants();
    await executeCases([
      caseDef(
        wrapperKey,
        '測試用戶 ' + participant.index + '：完整 handoff 後管理端接手預約',
        'Paired E2E / Booking Admin',
        () => pairedAdminBookingFollowupCase(participant)
      )
    ], '管理端即時監看 · 測試用戶 ' + participant.index);

    const wrapperRow = state.results.find((row) => row.key === wrapperKey);
    participant.adminStatus = wrapperRow?.status === 'passed' ? '預約接手完成' : state.cancelled ? '已停止' : '預約接手有異常';
    renderParticipants();

    const followupRows = state.results.filter((row) =>
      row.key === wrapperKey || String(row.key || '').startsWith(rowPrefix)
    );
    if (!state.cancelled && followupRows.length) {
      try {
        const recordedFollowup = await recordResultRows(
          followupRows,
          'paired-browser',
          'full',
          String(participant.account?.memberId || ''),
          participant.startedAt ? new Date(participant.startedAt).toISOString() : state.runStartedAt
        );
        const followupRunCode = String(recordedFollowup?.run?.runCode || '');
        if (followupRunCode) participant.runCodes.push(followupRunCode);
      } catch (error) {
        state.results.push({
          key: 'PAIRED_' + participant.index + '_ADMIN_BOOKING_RECORD',
          name: '測試用戶 ' + participant.index + '：管理端預約 E2E 紀錄寫入',
          domain: 'Paired E2E / Audit',
          status: 'failed',
          message: '管理端預約接手流程已執行，但無法綁定回該測試會員的 Test Automation 紀錄。',
          expected: { recordedToMember: true },
          actual: plainError(error),
          durationMs: 0
        });
        render();
      }
    }
    return wrapperRow || null;
  }


  async function runUnifiedServerFullPhase(selectedModules = state.selectedModules) {
    const started = performance.now();
    const traceMarker = adminDiagnosticMarker();
    const row = {
      key: 'UNIFIED_SERVER_FULL_E2E',
      name: '後端共用安全與所選模組 QA：Test Control Center',
      domain: 'Unified E2E / Backend',
      status: 'running',
      message: '正在執行共用安全檢查與所選模組的資料一致性 QA。',
      expected: { suite: 'full', failedCases: 0 },
      actual: {},
      durationMs: null
    };
    state.results.push(row);
    render();

    try {
      const control = window.MemberAdminTestControl;
      if (!control || typeof control.runFull !== 'function') {
        const error = new Error('Test Control Center 完整測試控制器未載入。');
        error.code = 'UNIFIED_BACKEND_CONTROL_NOT_READY';
        throw error;
      }
      const data = await control.runFull(selectedModules);
      const run = data?.run || {};
      const failedCases = Number(run.failedCases || 0);
      row.actual = {
        runId: String(run.id || ''),
        runCode: String(run.runCode || ''),
        suite: String(run.suite || 'full'),
        status: String(run.status || ''),
        totalCases: Number(run.totalCases || 0),
        passedCases: Number(run.passedCases || 0),
        failedCases,
        skippedCases: Number(run.skippedCases || 0)
      };
      row.durationMs = Math.max(0, Math.round(performance.now() - started));
      const skippedCases = Number(run.skippedCases || 0);
      const completedCases = Number(run.passedCases || 0);
      const completeBackendRun = Number(run.totalCases || 0) > 0 &&
        completedCases === Number(run.totalCases || 0) &&
        failedCases === 0 && skippedCases === 0 &&
        run.summary?.coverageComplete !== false &&
        String(run.status || '') === 'passed';
      Object.assign(row, completeBackendRun
        ? pass(
            '後端共用安全與所選模組 QA 已完成；繼續執行 Browser 協同 E2E。',
            row.expected,
            row.actual
          )
        : fail('後端共用安全或所選模組 QA 有失敗／未完成案例；Browser 協同 E2E 仍會繼續收集結果。', row.expected, row.actual));
      if (row.status === 'failed') row.trace = buildAdminFailureTrace(traceMarker, row);
      row.durationMs = Math.max(0, Math.round(performance.now() - started));
      render();
      return data;
    } catch (error) {
      row.durationMs = Math.max(0, Math.round(performance.now() - started));
      Object.assign(row, fail(
        '後端完整 QA 無法完成；Browser 協同 E2E 仍會繼續，以避免只取得單一路徑結果。',
        row.expected,
        plainError(error)
      ));
      row.trace = buildAdminFailureTrace(traceMarker, row, error);
      row.durationMs = Math.max(0, Math.round(performance.now() - started));
      render();
      return { error: plainError(error) };
    }
  }

  async function runPaired(options = {}) {
    if (state.pendingTimedOutNode) return { error: { code: 'E2E_NODE_DRAINING', message: '前一個逾時案例尚未結束，暫時無法開始新一輪。' }, results: safe(state.results) };
    if (state.running) return { error: { code: 'E2E_ALREADY_RUNNING', message: '完整 E2E 已在執行中。' }, results: safe(state.results) };
    state.cancelled = false;
    state.stopReason = null;
    state.failureScreenshotsCaptured = 0;
    state.backgroundExecution = options?.backgroundExecution === true || isBackgroundRunnerWindow();
    state.runSequence += 1;
    state.replayContext = normalizeReplayContext(options?.replay);
    state.replayManifest = null;
    state.participantExecutionOrder = [];
    state.syncOrder = [];
    state.deepParticipantIndex = null;
    let participantCount = 1;
    let openedWindows = [];
    let backendRun = null;
    let selectedModules = [];
    let cleanupLeaseId = '';
    let cleanupLeaseHeartbeatTimer = 0;
    let cleanupLeaseHeartbeatBusy = false;
    let cleanupLeaseHeartbeatFailures = 0;
    const mobileViewport = options?.mobileViewport === true || (!isBackgroundRunnerWindow() && selectedClientMobileViewport());
    state.clientMobileViewport = mobileViewport;
    try {
      const requestedCount = Number(options?.participantCount || 0);
      participantCount = Number.isInteger(requestedCount) && requestedCount > 0 ? requestedCount : selectedParticipantCount();
      selectedModules = normalizeSelectedModules(options?.selectedModules ||
        (state.section ? selectedModulesFromUi() : E2E_MODULES.map(([key]) => key)));
      state.selectedModules = selectedModules;
      if (participantCount < 1 || participantCount > MAX_PAIRED_PARTICIPANTS) {
        const error = new Error(`協同測試人數必須是 1–${MAX_PAIRED_PARTICIPANTS} 的整數。`);
        error.code = 'INVALID_PAIRED_PARTICIPANT_COUNT';
        throw error;
      }
      state.participantCount = participantCount;

      const needsClientWindows = selectedClientSurfaces(selectedModules).length > 0;
      const providedWindows = Array.isArray(options?.clientWindows)
        ? options.clientWindows.filter((item) => item && !item.closed).slice(0, participantCount)
        : [];
      closeClientWindows();
      if (!needsClientWindows) {
        closeWindowList(providedWindows);
        openedWindows = [];
        state.clientWindows = [];
      } else if (providedWindows.length) {
        if (providedWindows.length < participantCount) {
          const error = new Error('背景 Runner 收到的測試用戶端視窗數量不足。');
          error.code = 'E2E_BACKGROUND_CLIENT_WINDOWS_INCOMPLETE';
          throw error;
        }
        openedWindows = providedWindows;
        state.clientWindows = openedWindows;
      } else {
        openedWindows = openClientWindows(participantCount, true, mobileViewport);
      }
    } catch (error) {
      setMessage(error?.message || '無法開啟用戶端背景測試視窗。請允許此網站開啟彈出式視窗後重試。', true);
      return { error: plainError(error), results: [] };
    }

    state.results = [];
    state.adminScenarioPlan = null;
    state.featureCoverage = null;
    state.clientCoverage = [];
    state.participants = [];
    state.runStartedAt = new Date().toISOString();
    const runTraceMarker = adminDiagnosticMarker();
    setBusy(true, state.backgroundExecution ? '背景完整 E2E' : '完整 E2E');
    setMessage('所選模組 E2E 已開始：先驗證維護模式與共用後端 QA，再執行所選 Browser 案例。');
    try {
      const session = await adminSession();
      const mode = await postPublicTestMode(session, { action: 'public.status', clientType: 'booking' });
      if (!mode.maintenanceEnabled) {
        const error = new Error('請先啟用系統維護，再執行包含預約操作的完整 E2E。');
        error.code = 'TEST_MAINTENANCE_REQUIRED';
        throw error;
      }

      cleanupLeaseId = await acquireE2ECleanupLease();
      setMessage('正在安全回收前一輪 E2E 集點卡、活動票券與預約測試資料，保留歷史 QA 紀錄。');
      const previousCleanup = await recyclePreviousE2ERuntime(cleanupLeaseId);
      state.results.push({
        key: 'E2E_RUNTIME_RECYCLE',
        name: '測試前資料回收與殘留驗證',
        domain: 'Paired E2E / Orchestration',
        status: 'passed',
        message: previousCleanup.alreadyRecycled ? '本次執行鎖已完成資料重置，不重複刪除。' : '已回收上輪暫存資料並確認沒有 QA 資源殘留。',
        expected: { cleanupComplete: true, remainingQaArtifacts: 0 },
        actual: safe(previousCleanup),
        durationMs: 0
      });
      render();
      const renewCleanupLease = async () => {
        if (!cleanupLeaseId || cleanupLeaseHeartbeatBusy || state.cancelled) return;
        cleanupLeaseHeartbeatBusy = true;
        try {
          const renewed = await heartbeatE2ECleanupLease(cleanupLeaseId);
          if (!renewed) throw new Error('E2E execution lease is no longer active.');
          cleanupLeaseHeartbeatFailures = 0;
        } catch (error) {
          cleanupLeaseHeartbeatFailures += 1;
          if (cleanupLeaseHeartbeatFailures >= E2E_LEASE_HEARTBEAT_FAILURE_LIMIT && !state.cancelled) {
            state.stopReason = { code: 'E2E_LEASE_LOST', message: '完整 E2E 執行鎖續租失敗。' };
            requestStop();
            setMessage('完整 E2E 執行鎖續租失敗，已自動停止以避免測試資料與清除流程互相干擾。', true);
          }
        } finally {
          cleanupLeaseHeartbeatBusy = false;
        }
      };
      cleanupLeaseHeartbeatTimer = window.setInterval(() => { renewCleanupLease().catch(() => {}); }, E2E_LEASE_HEARTBEAT_MS);
      backendRun = await runUnifiedServerFullPhase(selectedModules);
      if (state.cancelled) throw Object.assign(new Error('本輪 E2E 已停止。'), { code: 'E2E_STOPPED' });

      const profile = state.replayContext
        ? (() => {
            const manifest=state.replayContext.manifest;
            state.complexityLevel=Math.max(1,Math.min(8,Number(manifest.complexityLevel||1)||1));
            state.clientConcurrency=Math.max(1,Math.min(MAX_PAIRED_PARTICIPANTS,Number(manifest.participantCount||participantCount||1)||1));
            state.rootRunId='REPLAY-'+Date.now().toString(36).toUpperCase();
            configureRandom(String(manifest.rootSeed||''));
            return {completedRootRuns:0,complexityLevel:state.complexityLevel,seed:state.randomSeed,clientConcurrency:state.clientConcurrency,rootRunId:state.rootRunId,surfaceWeightsMs:{},surfaceSamples:{},replayOfRunId:state.replayContext.sourceRunId};
          })()
        : await loadE2EProfile(participantCount, selectedModules);
      state.results.push({
        key: 'PAIRED_ADAPTIVE_PROFILE',
        name: 'E2E 自適應複雜度與可重現 Seed',
        domain: 'Paired E2E / Orchestration',
        status: 'passed',
        message: state.replayContext
          ? '本輪為 locked-path failure replay：沿用原始 seed、難度、Surface 順序與節點路徑，不推進演化難度。'
          : '本輪已依歷史完整 E2E 次數提升難度，並以歷史 surface 耗時做 weighted staggering，建立可重播 seed 與受控併發。',
        expected: { deterministicSeed: true, boundedConcurrency: true, iterativeComplexity: true, weightedSurfaceScheduling: true },
        actual: safe({ ...profile, selectedModules }),
        durationMs: 0
      });
      render();

      setMessage('後端完整 QA 階段已完成；正在建立 Browser 協同 E2E 的高複雜度測試資料。');
      const fixture = await prepareComplexE2EFixtures(profile, cleanupLeaseId);
      if (state.cancelled) throw Object.assign(new Error('本輪 E2E 已停止。'), { code: 'E2E_STOPPED' });

      const preferredMemberIds = state.replayContext ? state.replayContext.manifest.participants.map((item)=>String(item.preferredMemberId||'')).filter(Boolean) : [];
      const accounts = await prepareTestAccounts(participantCount, preferredMemberIds);
      state.participantCount = participantCount;
      state.adminTestAccount = accounts[0];
      state.participants = (selectedClientSurfaces(selectedModules).length ? accounts : []).map((account,index)=>{
        const replaySource=replayParticipant(index+1);
        return {
          index:index+1, account, window:openedWindows[index], mobileViewport, status:'等待隨機啟動', surface:'前置資料完成',
          surfacePlan:replaySource?replaySurfacePlan(replaySource.surfacePlan,selectedModules):weightedSurfacePlan(profile,index+1),
          runCodes:[], startedAt:Date.now(), login:null, lastSurfaceKey:'',
          adminStatus:selectedModules.includes('booking')?'監看預約資料':'依所選模組測試',
          liveBookingIds:[], adminBookingTask:null,
          seed:String(replaySource?.seed||(state.randomSeed+'-P'+(index+1))), complexityLevel:state.complexityLevel,
          replaySurfaceConfig:safe(replaySource?.surfaces||{}), surfaceReplayResults:{}
        };
      });
      renderParticipants();

      setMessage('管理端前置資料已建立；正在執行 ' + selectedModules.map((key) => E2E_MODULES.find(([item]) => item === key)?.[1]).join('、') + ' 的真人 Browser E2E。');
      if (!state.cancelled) {
        // A human administrator has one management UI. Keep admin DOM actions single-threaded
        // while member clients may generate data concurrently.
        const allAdminDefinitions = planAdminDefinitions('full', selectedModules);
        state.results.push({
          key: 'PAIRED_ADMIN_SCENARIO_PATH',
          name: '本輪管理端 E2E 節點路徑',
          domain: 'Paired E2E / Orchestration',
          status: 'passed',
          message: '管理端已依 dependency graph、seed 與 complexity 產生本輪合法節點路徑。',
          expected: { dependencyAware: true, replayable: true, fixedFlow: false },
          actual: safe(state.adminScenarioPlan || {}),
          durationMs: 0
        });
        render();
        const preflightKeys = new Set(['ADMIN_AUTH_READY']);
        if (selectedModules.includes('booking')) {
          preflightKeys.add('ADMIN_BOOKING_CONTROLS');
          preflightKeys.add('ADMIN_BOOKING_SHARED_SETTINGS');
        }
        const preflightDefinitions = allAdminDefinitions.filter((def) => preflightKeys.has(def.key));
        await executeCases(preflightDefinitions, selectedModules.includes('booking') ? '管理端 · 預約接手前置' : '管理端 · 授權前置');
        if (state.cancelled) throw Object.assign(new Error('本輪 E2E 已停止。'), { code: 'E2E_STOPPED' });
        // Only a missing authenticated administrator is a global admission
        // failure. Booking assertions must not suppress the other checked modules.
        const incompletePreflight = preflightDefinitions.filter((def) => def.key === 'ADMIN_AUTH_READY' &&
          !state.results.some((row) => row.key === def.key && row.status === 'passed')
        );
        if (incompletePreflight.length) {
          const error = new Error('管理端前置案例未全部通過，已停止用戶端協同測試：' +
            incompletePreflight.map((def) => def.name).join('、'));
          error.code = 'E2E_ADMIN_PREFLIGHT_FAILED';
          throw error;
        }

        // Booking admin mutations start only after the member-side full run has produced
        // its authoritative handoff manifest. Realtime creation/badge behavior is covered by
        // dedicated tests; mixing it into the mutation handoff caused long polling races and
        // could let an inner wait outlive the booking node deadline.
        pairedAdminBookingChain = Promise.resolve();
        const executionParticipants = state.replayContext
          ? orderedParticipants(state.participants, state.replayContext.manifest.participantExecutionOrder)
          : shuffled(state.participants);
        state.participantExecutionOrder = executionParticipants.map((participant)=>Number(participant.index));
        const clientExecution = runWithConcurrency(
          executionParticipants,
          state.clientConcurrency,
          async (participant) => {
            await sleep(randomInt(60, 420 + state.complexityLevel * 80));
            return runParticipantSurfaces(participant);
          }
        );
        await clientExecution;

        if (!state.cancelled && selectedModules.includes('member')) {
          await executeCases([
            caseDef('PAIRED_MEMBER_REFERRAL_REWARD', '邀請優惠：輸入者獲券、重送與再次邀請', 'Paired E2E / Member Growth', pairedMemberReferralRewardCase)
          ], '協同會員成長與安全');
        }

        if (!state.cancelled && selectedModules.includes('points')) {
          await executeCases([
            caseDef('PAIRED_POINT_TRANSFER_ATOMIC', '點數轉贈：雙方餘額守恆／冪等／衝突拒絕', 'Paired E2E / Points Transfer', pairedPointTransferAtomicCase)
          ], '協同點數轉贈');
        }

        if (!state.cancelled && selectedModules.includes('event')) {
          await executeCases([
            caseDef('PAIRED_EVENT_LAST_TICKET_RACE', '活動優惠券：兩測試會員競爭最後一張', 'Paired E2E / Event Concurrency', pairedEventLastTicketRaceCase)
          ], '協同活動優惠券併發');
        }

        if (!state.cancelled && selectedModules.includes('booking')) {
          await executeCases([
            caseDef('PAIRED_SECURITY_BOOKING_IDOR', '跨測試帳號取消預約必須拒絕且資料不變', 'Paired E2E / Security', bookingOwnershipBoundaryCase)
          ], '協同安全邊界');
        }

        if (!state.cancelled) {
          const remainingAdminDefinitions = allAdminDefinitions.filter((def) => !preflightKeys.has(def.key));
          await executeCases(remainingAdminDefinitions, '管理端 · 其餘完整 E2E');
        }
      }

      if (!state.cancelled) {
        const syncParticipants = state.replayContext
          ? orderedParticipants(state.participants, state.replayContext.manifest.syncOrder)
          : shuffled(state.participants);
        state.syncOrder = syncParticipants.map((participant)=>Number(participant.index));
        for (const participant of syncParticipants) {
          participant.status = '同步驗證';
          participant.surface = '管理端紀錄';
          renderParticipants();
          await executeCases([
            caseDef(
              'PAIRED_' + participant.index + '_ADMIN_RECORD_SYNC',
              '測試用戶 ' + participant.index + '：用戶端測試紀錄同步回管理端',
              'Paired E2E / Audit',
              () => verifyUserRunsVisibleInAdmin(participant.account, participant.runCodes)
            )
          ], '同步驗證 · 測試用戶 ' + participant.index);
          participant.status = state.results[state.results.length - 1]?.status === 'passed' ? '完成' : '有異常';
          participant.surface = '完成';
          renderParticipants();
          if (state.cancelled) break;
          await sleep(randomInt(60, 360));
        }
      }

      if (!state.cancelled && state.participants[0] && (selectedModules.includes('member') || selectedModules.includes('points'))) {
        const requestedDeepIndex=Number(state.replayContext?.manifest?.deepParticipantIndex||0);
        const deepParticipant=requestedDeepIndex?state.participants.find((item)=>Number(item.index)===requestedDeepIndex):state.participants[randomInt(0,state.participants.length-1)];
        if (deepParticipant) {
          state.deepParticipantIndex = Number(deepParticipant.index);
          if (state.pendingTimedOutNode) state.results.push({
            key: 'PAIRED_DEEP_ADMIN_BLOCKED', name: '深度協同管理操作', domain: 'Paired E2E', durationMs: 0,
            ...fail('管理端逾時操作尚未完成清理，深度管理操作未執行。',
              { executed: true }, { executed: false, code: 'E2E_ADMIN_NODE_DRAINING' })
          });
          else await runDeepPairedSuite(deepParticipant);
        }
      }

      if (!state.cancelled) {
        await executeCases([
          caseDef(
            'PAIRED_HUMAN_INTERACTION_COVERAGE',
            '管理端 ↔ 用戶端真人互動完整覆蓋',
            'Coverage',
            pairedHumanInteractionCoverageCase
          )
        ], '真人互動覆蓋驗證');
      }

      const cancelled = state.cancelled;
      if (cancelled) appendUnexecutedScopeResults(state.stopReason);
      finalizeFeatureCoverage();
      state.replayManifest = !cancelled ? buildReplayManifest() : null;
      const recorded = state.results.length
        ? cancelled
          ? await recordResultRows(state.results, 'paired-browser', 'full', '', state.runStartedAt, { rootRun: false })
          : await recordRun('paired-browser','full','',{replayManifest:state.replayManifest,replayOfRunId:state.replayContext?.sourceRunId||''})
        : null;
      const failed = state.results.filter((item) => item.status === 'failed').length;
      if (cancelled) {
        for (const participant of state.participants) {
          if (participant.status !== '完成') {
            participant.status = '已停止';
            participant.surface = '停止';
          }
        }
        renderParticipants();
      }
      setMessage(
        cancelled
          ? '協同 E2E 已停止；已完成案例與管理端建立的測試資料均保留，用戶端視窗保留供檢查。'
          : state.results.some(item => item.status === 'skipped') && !failed
            ? '測試已結束，仍有環境阻擋或未驗證功能；請查看功能覆蓋摘要。'
          : failed
            ? participantCount + ' 位測試用戶隨機協同 E2E 完成，發現 ' + failed + ' 個異常；高複雜度測試資料保留供檢查。'
            : participantCount + ' 位測試用戶已完成隨機多路徑管理端 ↔ 用戶端協同 E2E；高複雜度測試資料保留，需由「移除測試資料」統一清理。',
        !cancelled && failed > 0
      );
      return {
        cancelled,
        recorded,
        backendRun: safe(backendRun?.run || {}),
        selectedModules: safe(selectedModules),
        adminScenario: safe(state.adminScenarioPlan),
        coverage:safe(state.featureCoverage),
        clientCoverage:safe(state.clientCoverage),
        replayManifest: safe(state.replayManifest),
        replayOfRunId: String(state.replayContext?.sourceRunId || ''),
        replayComparison: safe(recorded?.run?.summary?.replayComparison || {}),
        fixture: safe(fixture),
        participants: safe(state.participants.map((item) => ({
          account: item.account,
          surfacePlan: item.surfacePlan?.map(([key]) => key) || [],
          mobileViewport: item.mobileViewport === true,
          clientRunnerOpen: Boolean(item.window && !item.window.closed)
        }))),
        results: safe(state.results)
      };
    } catch (error) {
      const stoppedByUser = state.cancelled && !state.stopReason && error?.code !== 'E2E_NODE_TIMEOUT';
      state.cancelled = true; // Ask any concurrent client or booking waiter to stop.
      if (!stoppedByUser) {
        for (const row of state.results.filter((item) => item.status === 'running')) {
          row.status = 'failed';
          row.message = '其他節點失敗後中止，原操作未能安全完成。';
          row.actual = { code: 'E2E_INTERRUPTED', cause: plainError(error) };
          row.durationMs = Math.max(0, Date.now() - Number(runTraceMarker.startedAtMs || Date.now()));
          row.trace = buildAdminFailureTrace(runTraceMarker, row, error);
        }
        const fatalFailure = {
          key: 'PAIRED_RUNNER_FATAL',
          name: '協同 Runner 啟動',
          domain: 'Paired E2E',
          status: 'failed',
          message: error?.message || '協同 Runner 無法啟動。',
          expected: { runnable: true, testAccountsOnly: true, complexFixtureReadyBeforeClients: true },
          actual: { ...plainError(error), fixture: safe(error?.fixture || {}) },
          durationMs: 0,
          trace: buildAdminFailureTrace(runTraceMarker, { key: 'PAIRED_RUNNER_FATAL', domain: 'Paired E2E', actual: {} }, error)
        };
        await attachFailureScreenshot(fatalFailure, window);
        state.results.push(fatalFailure);
      }
      setMessage(stoppedByUser ? '協同 E2E 已停止。' : (error?.message || '協同 E2E 無法啟動。請確認系統維護、目前裝置測試登入與彈出式視窗權限。'), !stoppedByUser);
      render();
      // Persist partial and cancelled paths too. Missing checked modules must be
      // reviewable even when the execution lease or browser run was interrupted.
      appendUnexecutedScopeResults(state.stopReason || plainError(error));
      finalizeFeatureCoverage();
      let recorded = null;
      try { recorded = await recordResultRows(state.results, 'paired-browser', 'full', '', state.runStartedAt, { rootRun: false }); } catch {}
      if (!stoppedByUser) closeClientWindows();
      return { cancelled: stoppedByUser, error: stoppedByUser ? null : plainError(error),
        recorded, coverage: safe(state.featureCoverage), clientCoverage: safe(state.clientCoverage),
        results: safe(state.results) };
    } finally {
      if (cleanupLeaseHeartbeatTimer) {
        window.clearInterval(cleanupLeaseHeartbeatTimer);
        cleanupLeaseHeartbeatTimer = 0;
      }
      if (cleanupLeaseId) {
        const leaseToRelease = cleanupLeaseId;
        const pendingAdmin = state.pendingTimedOutNode;
        if (pendingAdmin) {
          // Preserve the purge boundary until the original action finishes.
          const release = () => releaseE2ECleanupLease(leaseToRelease);
          pendingAdmin.then(release, release).catch(() => {});
        } else await releaseE2ECleanupLease(leaseToRelease);
        cleanupLeaseId = '';
      }
      state.adminTestAccount = null;
      setBusy(false);
      render();
      renderParticipants();
    }
  }

  function appendUnexecutedScopeResults(reason = null) {
    const cause = reason || { code: 'E2E_STOPPED', message: '本輪 E2E 已停止。' };
    if (!state.results.some(row => row.key === 'E2E_EXECUTION_STOPPED')) state.results.push({
      key: 'E2E_EXECUTION_STOPPED', name: '本輪 E2E 中止原因', domain: 'Paired E2E / Orchestration', durationMs: 0,
      ...fail(cause.message, { scopeCompleted: true }, safe(cause))
    });
    const expected = adminDefinitions('full').map(def => ({ key: def.key, name: def.name, domain: def.domain }));
    for (let index = 1; index <= state.participantCount; index++) {
      for (const [surface, label] of selectedClientSurfaces()) expected.push({
        key: 'PAIRED_' + index + '_' + surface.toUpperCase(),
        name: '測試用戶 ' + index + '：' + label,
        domain: 'Paired E2E / ' + surface
      });
    }
    const recordedKeys = new Set(state.results.map(row => row.key));
    for (const item of expected) {
      if (recordedKeys.has(item.key)) continue;
      state.results.push({ ...item, durationMs: 0,
        ...fail('本輪中斷，此勾選項目尚未執行。', { executed: true },
          { executed: false, code: 'E2E_SCOPE_NOT_EXECUTED', cause: safe(cause) }) });
    }
  }

  async function runParticipantSurfaces(participant) {
    participant.startedAt = Number(participant.startedAt || 0) || Date.now();
    participant.status = '執行中';
    participant.surfacePlan = Array.isArray(participant.surfacePlan) && participant.surfacePlan.length
      ? participant.surfacePlan
      : shuffled(selectedClientSurfaces());
    renderParticipants();

    for (const [surface, label] of participant.surfacePlan) {
      if (state.cancelled) break;
      await sleep(randomInt(120, 950));
      const started = performance.now();
      const traceMarker = adminDiagnosticMarker();
      const row = {
        key: 'PAIRED_' + participant.index + '_' + surface.toUpperCase(),
        name: '測試用戶 ' + participant.index + '：' + label + '隨機真人 E2E',
        domain: 'Paired E2E / ' + surface,
        status: 'running',
        message: '正在建立此用戶端專屬 Session，並於獨立視窗執行隨機化真人操作…',
        expected: { memberCode: participant.account?.memberCode || null, failedCases: 0, sessionSurface: surface, humanInteractionVerified: true },
        actual: {},
        durationMs: null
      };
      state.results.push(row);
      participant.status = '執行中';
      participant.surface = label;
      renderParticipants();
      render();
      if (state.floating) state.floating.textContent = 'E2E 執行中 · 多用戶隨機並行 · 測試用戶 ' + participant.index + ' · ' + label;
      try {
        const login = reusablePairedSession(participant, surface) ||
          await createPairedSession(participant.account, surface);
        participant.login = login;
        participant.surfaceLogins = participant.surfaceLogins || {};
        participant.surfaceLogins[surface] = login;
        participant.lastSurfaceKey = surface;
        seedParticipantSession(participant, login, surface);
        await sleep(randomInt(80, 520));
        const child = await runUserSurface(participant, surface, label);
        if (surface === 'booking') {
          participant.bookingResult = child;
          participant.adminStatus = '已取得完整接手清單，等待管理端接手';
          renderParticipants();
          if (!participant.adminBookingTask) {
            const queued = pairedAdminBookingChain.then(() => runPairedAdminBookingLive(participant));
            pairedAdminBookingChain = queued.catch(() => null);
            participant.adminBookingTask = queued;
          }
          await participant.adminBookingTask;
        }
        const summary = child?.summary || {};
        state.clientCoverage.push({ participant:participant.index, surface, coverage:child.coverage || null });
        participant.surfaceReplayResults = participant.surfaceReplayResults || {};
        participant.surfaceReplayResults[surface] = {
          scenarioFingerprint: String(summary.scenarioFingerprint || ''),
          scenarioPath: Array.isArray(summary.scenarioPath) ? summary.scenarioPath.slice() : [],
          adaptiveReplaySourceKeys: Array.isArray(summary.adaptiveReplaySourceKeys) ? summary.adaptiveReplaySourceKeys.slice(0, 3) : [],
          randomStateAfterBuild: Number(summary.randomStateAfterBuild || 0) >>> 0,
          runnerVersion: String(summary.runnerVersion || '')
        };
        const childMemberId = child?.account?.memberId || '';
        const runCode = String(child?.browserRun?.runCode || '');
        if (runCode) participant.runCodes.push(runCode);
        const humanInteraction = child?.humanInteraction || {};
        const humanInteractionVerified = Number(humanInteraction.requiredCases || 0) > 0
          && Number(humanInteraction.passedCases || 0) === Number(humanInteraction.requiredCases || 0)
          && Array.isArray(humanInteraction.missingEvidenceKeys)
          && humanInteraction.missingEvidenceKeys.length === 0;
        row.actual = {
          memberCode: participant.account?.memberCode || null,
          sessionSurface: surface,
          sameTestMember: childMemberId === participant.account?.memberId,
          coverageComplete:child.coverage?.complete === true,
          coverageCounts:safe(child.coverage?.counts || {}),
          humanInteractionVerified,
          humanInteraction: safe(humanInteraction),
          passed: Number(summary.passed || 0),
          failed: Number(summary.failed || 0),
          skipped: Number(summary.skipped || 0),
          total: Number(summary.total || 0),
          runCode: runCode || null,
          cancelled: Boolean(child?.cancelled),
          surfacePlan: participant.surfacePlan.map(([key]) => key)
        };
        if (state.cancelled || child?.cancelled) {
          Object.assign(row, skip(label + ' E2E 已依停止要求中止。', { stoppedSafely: true }, row.actual));
        } else {
          const sameMember = childMemberId === participant.account?.memberId;
          const ok = child?.ok === true && Number(summary.failed || 0) === 0 && Number(summary.skipped || 0) === 0
            && child.coverage?.complete === true && sameMember && humanInteractionVerified;
          Object.assign(row, ok
            ? pass(label + '隨機真人 E2E 通過，且使用的是該用戶端專屬測試 Session。', row.expected, row.actual)
            : fail(label + '真人 E2E、Session surface 或測試用戶一致性驗證失敗。', row.expected, row.actual));
          if (!ok) {
            const childFailures = Array.isArray(child?.results)
              ? child.results.filter((item) => item?.status === 'failed').slice(0, 8).map((item) => ({
                  key: item.key,
                  domain: item.domain,
                  message: item.message,
                  trace: item.trace || null
                }))
              : [];
            row.trace = buildAdminFailureTrace(traceMarker, row, null, {
              participantIndex: participant.index,
              surface,
              childFailures
            });
          }
        }
      } catch (error) {
        Object.assign(row, state.cancelled
          ? skip(label + ' E2E 已停止。', { stoppedSafely: true }, { stoppedSafely: true })
          : fail(label + '獨立用戶端 E2E 發生錯誤。', row.expected, plainError(error)));
        if (!state.cancelled) {
          row.trace = buildAdminFailureTrace(traceMarker, row, error, {
            participantIndex: participant.index,
            surface
          });
        }
      }
      row.durationMs = Math.max(0, Math.round(performance.now() - started));
      render();
    }

    participant.status = state.cancelled ? '已停止' : '用戶端完成';
    participant.surface = state.cancelled ? '停止' : '等待同步驗證';
    renderParticipants();
  }

  async function pairedHumanInteractionCoverageCase() {
    const expectedSurfaces = selectedClientSurfaces().map(([key]) => key);
    const clientCoverage = [];
    for (const participant of state.participants) {
      for (const surfaceKey of expectedSurfaces) {
        const row = state.results.find((item) => item.key === 'PAIRED_' + participant.index + '_' + surfaceKey.toUpperCase());
        clientCoverage.push({
          participant: participant.index,
          surface: surfaceKey,
          passed: row?.status === 'passed',
          humanInteractionVerified: row?.actual?.humanInteractionVerified === true
        });
      }
    }

    const adminRows = state.results.filter((item) => item.humanRequired === true && !/^PAIRED_\d+_(?:MEMBER|POINTS|EVENT|CALENDAR|BOOKING)$/.test(String(item.key || '')));
    const adminCoverage = adminRows.map((item) => ({
      key: item.key,
      status: item.status,
      eventCount: Number(item?.actual?.humanInteraction?.eventCount || 0)
    }));
    const missingClients = clientCoverage.filter((item) => !item.passed || !item.humanInteractionVerified);
    const missingAdmin = adminCoverage.filter((item) => item.status !== 'passed' || item.eventCount < 1);
    const moduleEvidence = state.selectedModules.map((module) => {
      const key = MODULE_HUMAN_EVIDENCE[module];
      const row = adminCoverage.find((item) => item.key === key);
      return { module, key, passed: row?.status === 'passed' && row.eventCount > 0 };
    });
    const missingModules = moduleEvidence.filter((item) => !item.passed);
    const ok = clientCoverage.length === state.participants.length * expectedSurfaces.length
      && missingClients.length === 0
      && adminCoverage.length > 0
      && missingAdmin.length === 0
      && missingModules.length === 0;
    const actual = {
      selectedModules: state.selectedModules,
      expectedSurfaceCountPerParticipant: expectedSurfaces.length,
      clientCoverage,
      adminHumanCaseCount: adminCoverage.length,
      adminCoverage,
      moduleEvidence,
      missingClients,
      missingAdmin,
      missingModules
    };
    return ok
      ? pass('所選用戶端與管理端模組皆有實際 UI 互動證據。', {
          allClientSurfacesHumanDriven: true,
          allAdminHumanCasesObserved: true,
          selectedModulesCovered: true
        }, actual)
      : fail('所選模組仍有用戶端或管理端案例缺少真人 UI 互動證據。', {
          allClientSurfacesHumanDriven: true,
          allAdminHumanCasesObserved: true,
          selectedModulesCovered: true
        }, actual);
  }

  async function adminReadyCase() {
    const session = await adminSession();
    const ready = document.documentElement.dataset.memberAdminReady === 'true';
    const visible = !document.getElementById('adminView')?.classList.contains('hidden');
    return ready && visible
      ? pass('管理員已通過身分與權限驗證，管理畫面已就緒。', { ready: true, visible: true }, { ready, visible, hasIdToken: Boolean(session.idToken) })
      : fail('管理端尚未完成登入或畫面未就緒。', { ready: true, visible: true }, { ready, visible, hasIdToken: Boolean(session.idToken) });
  }

  async function adminNavigationCase() {
    const pairs = [
      ['member', 'membersTab', 'membersPanel'],
      ['points', 'cardsTab', 'cardsPanel'],
      ['event', 'eventsTab', 'eventsPanel'],
      ['calendar', 'calendarTab', 'calendarPanel'],
      ['booking', 'bookingTab', 'bookingPanel'],
      ['integration', 'operationsHubTab', 'operationsHubPanel']
    ].filter(([key]) => state.selectedModules.includes(key));
    pairs.push(['runner', 'testModeTab', 'testModePanel']);
    const actual = {};
    for (const [, tabId, panelId] of pairs) {
      const tab = await waitFor(() => document.getElementById(tabId), 6000);
      if (!tab) { actual[tabId] = false; continue; }
      tab.click();
      actual[tabId] = Boolean(await waitFor(() => {
        const panel = document.getElementById(panelId);
        return panel && !panel.classList.contains('hidden');
      }, 3000));
    }
    const ok = Object.values(actual).every(Boolean);
    return ok
      ? pass('所選管理模組與測試中心皆以真人點擊方式成功切換。', { selectedTabsOpen: true }, actual)
      : fail('至少一個所選管理分頁無法正常切換。', { selectedTabsOpen: true }, actual);
  }

  async function ensureTestRoster(account = state.adminTestAccount) {
    document.getElementById('membersTab')?.click();
    await waitFor(() => !document.getElementById('membersPanel')?.classList.contains('hidden'), 3000);
    document.getElementById('testMembersSubtab')?.click();
    const selected = await waitFor(
      () => document.getElementById('testMembersSubtab')?.getAttribute('aria-selected') === 'true',
      3000
    );
    if (!selected) {
      const error = new Error('E2E 安全邊界：無法切換到測試用戶名冊，已停止會員操作。');
      error.code = 'E2E_TEST_ROSTER_REQUIRED';
      throw error;
    }
    const memberCode = String(account?.memberCode || '');
    const findEdit = () => {
      const rows = Array.from(document.querySelectorAll('#memberTableBody tr'));
      const targetLineUserId = String(account?.lineUserId || '');
      const row = rows.find(item => targetLineUserId
        ? item.querySelector('button[data-action="view-records"]')?.dataset.value === targetLineUserId
        : !memberCode || item.querySelector('.member-cell small')?.textContent.trim() === memberCode);
      return row?.querySelector('button[data-action="view-records"]') || null;
    };

    let edit = await waitFor(findEdit, 1200, 100);
    if (!edit && memberCode) {
      // 新增測試帳號後，test subtab 可能已處於 selected 狀態而不會觸發重新載入。
      // 強制變更搜尋條件，讓管理端從後端重新取得指定 memberCode，而不是信任舊 DOM。
      const search = document.getElementById('memberSearch');
      if (search) {
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(380);
        search.value = memberCode;
        search.dispatchEvent(new Event('input', { bubbles: true }));
      }
      edit = await waitFor(findEdit, 10000, 100);
    }
    if (!edit) throw new Error(memberCode ? '找不到本次指定的測試用戶：' + memberCode : '測試會員名冊未載入可操作帳號。');
    return edit;
  }

  async function adminTestRosterCase() {
    const edit = await ensureTestRoster();
    const rows = document.querySelectorAll('#memberTableBody tr').length;
    const testRosterSelected = document.getElementById('testMembersSubtab')?.getAttribute('aria-selected') === 'true';
    const targetCode = String(state.adminTestAccount?.memberCode || '');
    return rows > 0 && testRosterSelected
      ? pass('已真人切換到測試用戶名冊，且本次 E2E 指定測試用戶可操作。', { rowsAtLeast: 1, testRosterSelected: true, targetTestAccount: true }, { rows, testRosterSelected, targetCode, firstAction: edit.dataset.action })
      : fail('測試用戶名冊或指定測試用戶載入異常。', { rowsAtLeast: 1, testRosterSelected: true, targetTestAccount: true }, { rows, testRosterSelected, targetCode });
  }

  async function clickRowAction(action, lineUserId) {
    const buttons = Array.from(document.querySelectorAll('#memberTableBody button[data-action]'));
    const button = buttons.find((item) => item.dataset.action === action && (!lineUserId || item.dataset.value === lineUserId));
    if (button) {
      if (!await waitFor(() => !button.disabled, 8000)) throw new Error('會員操作仍在載入：' + action);
      button.click();
      return button;
    }
    // 狀態與發放入口已移至會員 360；先開啟指定會員再操作其子視窗。
    if (action === 'edit-member' || action === 'add-grant') {
      const records = buttons.find(item => item.dataset.action === 'view-records' && item.dataset.value === lineUserId);
      if (!records) throw new Error('找不到指定測試會員的 360 入口。');
      if (!await waitFor(() => !records.disabled, 8000)) throw new Error('會員 360 前次載入尚未完成。');
      records.click();
      const label = action === 'edit-member' ? '狀態' : '＋ 發放';
      const child = await waitFor(() => {
        const modal = document.getElementById('memberRecordsModal');
        if (!modal || modal.classList.contains('hidden')) return null;
        return Array.from(modal.querySelectorAll('.member-records-overview-actions button')).find(item => item.textContent.trim() === label && !item.disabled);
      }, 7000);
      if (!child) throw new Error('會員 360 尚未載入操作：' + label);
      child.click();
      return child;
    }
    throw new Error('找不到會員操作按鈕：' + action);
  }

  async function closeMemberWorkflowDialogs() {
    for (const [modalId, cancelId] of [['memberModal', 'cancelMemberButton'], ['grantModal', 'cancelGrantButton'], ['memberRecordsModal', 'closeMemberRecordsModal']]) {
      const modal = document.getElementById(modalId);
      if (!modal || modal.classList.contains('hidden')) continue;
      const button = await waitFor(() => {
        const cancel = document.getElementById(cancelId);
        return cancel && !cancel.disabled ? cancel : null;
      }, 8000);
      button?.click();
      if (!await waitFor(() => modal.classList.contains('hidden'), 3000)) {
        throw Object.assign(new Error('會員 E2E 視窗未能正常關閉：' + modalId), { code: 'E2E_DIALOG_CLEANUP_FAILED' });
      }
    }
  }

  async function adminMemberModalCase() {
    try {
      const edit = await ensureTestRoster();
      const lineUserId = String(edit.dataset.value || '');
      const actual = { edit: false, records: false, grant: false };

      await clickRowAction('edit-member', lineUserId);
      actual.edit = Boolean(await waitFor(() => !document.getElementById('memberModal')?.classList.contains('hidden'), 3000));
      if (document.getElementById('memberIsTestAccount')?.value !== 'true') {
        document.getElementById('cancelMemberButton')?.click();
        const error = new Error('E2E 安全邊界：管理端會員測試只能操作測試用戶，已阻擋正式用戶。');
        error.code = 'E2E_REAL_MEMBER_BLOCKED';
        throw error;
      }
      document.getElementById('cancelMemberButton')?.click();
      await waitFor(() => document.getElementById('memberModal')?.classList.contains('hidden'), 3000);

      await clickRowAction('view-records', lineUserId);
      actual.records = Boolean(await waitFor(() => !document.getElementById('memberRecordsModal')?.classList.contains('hidden'), 7000));
      document.getElementById('closeMemberRecordsModal')?.click();
      await waitFor(() => document.getElementById('memberRecordsModal')?.classList.contains('hidden'), 3000);

      await clickRowAction('add-grant', lineUserId);
      actual.grant = Boolean(await waitFor(() => !document.getElementById('grantModal')?.classList.contains('hidden'), 7000));
      document.getElementById('cancelGrantButton')?.click();
      await waitFor(() => document.getElementById('grantModal')?.classList.contains('hidden'), 3000);

      const ok = Object.values(actual).every(Boolean);
      return ok
        ? pass('會員狀態、紀錄、發放三個管理視窗皆可真人開啟與關閉。', { allDialogs: true }, actual)
        : fail('至少一個會員管理視窗互動異常。', { allDialogs: true }, actual);
    } finally {
      await closeMemberWorkflowDialogs();
    }
  }

  function setField(id, value) {
    const element = document.getElementById(id);
    if (!element) return false;
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async function openTestMember(lineUserId) {
    await ensureTestRoster();
    await clickRowAction('edit-member', lineUserId);
    const opened = Boolean(await waitFor(() => !document.getElementById('memberModal')?.classList.contains('hidden'), 4000));
    if (!opened) return false;
    if (document.getElementById('memberIsTestAccount')?.value !== 'true') {
      document.getElementById('cancelMemberButton')?.click();
      const error = new Error('E2E 安全邊界：偵測到正式用戶，已禁止修改並停止測試。');
      error.code = 'E2E_REAL_MEMBER_BLOCKED';
      throw error;
    }
    return true;
  }

  async function submitMemberAndWait() {
    const button = document.getElementById('saveMemberButton');
    if (!await waitFor(() => button && !button.disabled ? button : null, 10000)) return false;
    button.click();
    const closed = Boolean(await waitFor(() => document.getElementById('memberModal')?.classList.contains('hidden'), 10000));
    if (closed) {
      // saveMember 會先關閉 modal，再完成 refreshAfterSuccessfulWrite / finally。
      // 等按鈕解除 busy 後才允許下一次修改，避免連續還原時 click 被靜默忽略。
      await waitFor(() => !button.disabled, 10000);
    }
    return closed;
  }

  async function adminProfileMutationCase() {
    try {
      const edit = await ensureTestRoster();
      const lineUserId = String(edit.dataset.value || '');
      await openTestMember(lineUserId);
      const original = {
        displayName: String(document.getElementById('memberDisplayName')?.value || ''),
        surname: String(document.getElementById('memberSurname')?.value || ''),
        salutation: String(document.getElementById('memberSalutation')?.value || 'mr'),
        birthday: String(document.getElementById('memberBirthday')?.value || ''),
        phone: String(document.getElementById('memberPhone')?.value || ''),
        status: String(document.getElementById('memberStatus')?.value || 'active')
      };
      const suffix = Date.now().toString(36).slice(-5).toUpperCase();
      const next = {
        displayName: ('QA E2E ' + suffix).slice(0, 70),
        surname: original.surname === '測' ? '驗' : '測',
        salutation: original.salutation === 'mr' ? 'ms' : 'mr',
        birthday: original.birthday === '1990-01-15' ? '1991-02-16' : '1990-01-15',
        phone: original.phone.replace(/\D/g, '') === '0900000001' ? '0900000002' : '0900000001',
        status: original.status
      };
      let changedVerified = false;
      let restoredVerified = false;

      async function fill(profile) {
        setField('memberDisplayName', profile.displayName);
        setField('memberSurname', profile.surname);
        setField('memberSalutation', profile.salutation);
        setField('memberBirthday', profile.birthday);
        setField('memberPhone', profile.phone);
        setField('memberStatus', profile.status);
      }

      try {
        await fill(next);
        if (!await submitMemberAndWait()) throw new Error('測試會員修改後視窗未正常關閉。');
        await openTestMember(lineUserId);
        changedVerified = [
          ['memberDisplayName', next.displayName],
          ['memberSurname', next.surname],
          ['memberSalutation', next.salutation],
          ['memberBirthday', next.birthday],
          ['memberPhone', next.phone]
        ].every(([id, value]) => String(document.getElementById(id)?.value || '') === value);
        await fill(original);
        if (!await submitMemberAndWait()) throw new Error('測試會員還原後視窗未正常關閉。');
        await openTestMember(lineUserId);
        restoredVerified = [
          ['memberDisplayName', original.displayName],
          ['memberSurname', original.surname],
          ['memberSalutation', original.salutation],
          ['memberBirthday', original.birthday],
          ['memberPhone', original.phone]
        ].every(([id, value]) => String(document.getElementById(id)?.value || '') === value);
        document.getElementById('cancelMemberButton')?.click();
      } finally {
        if (!restoredVerified) {
          try {
            if (document.getElementById('memberModal')?.classList.contains('hidden')) await openTestMember(lineUserId);
            await fill(original);
            await submitMemberAndWait();
          } catch {}
        }
      }

      const actual = { changedVerified, restoredVerified, lineUserId: lineUserId ? '[present]' : '[missing]' };
      return changedVerified && restoredVerified
        ? pass('已透過管理端 UI 修改測試會員全部可編輯個資欄位，驗證後完整還原。', { changedVerified: true, restoredVerified: true }, actual)
        : fail('測試會員修改或還原驗證失敗。', { changedVerified: true, restoredVerified: true }, actual);
    } finally {
      await closeMemberWorkflowDialogs();
    }
  }

  async function openEditor(buttonId, modalId, preClick) {
    if (typeof preClick === 'function') await preClick();
    const button = document.getElementById(buttonId);
    if (!button) return false;
    button.click();
    const modal = await waitFor(() => {
      const node = document.getElementById(modalId);
      return node && !node.classList.contains('hidden') ? node : null;
    }, 3500);
    if (!modal) return false;
    modal.querySelector('.editor-modal-close')?.click();
    await waitFor(() => modal.classList.contains('hidden'), 3000);
    return true;
  }

  async function adminResourceEditorsCase() {
    const actual = {};
    if (state.selectedModules.includes('points')) {
      await adminHumanClick(document.getElementById('cardsTab'), '集點卡');
      actual.card = await openEditor('newCardButton', 'cardEditorModal', async () => document.getElementById('cardSettingsTab')?.click());
      actual.ticket = await openEditor('newTicketButton', 'ticketEditorModal', async () => document.getElementById('ticketSettingsTab')?.click());
    }
    if (state.selectedModules.includes('event')) {
      await adminHumanClick(document.getElementById('eventsTab'), '活動票券');
      actual.eventTicket = await openEditor('newEventTicketButton', 'eventTicketEditorModal');
    }
    if (state.selectedModules.includes('calendar')) {
      await adminHumanClick(document.getElementById('calendarTab'), '營運日曆');
      actual.calendar = await openEditor('newCalendarItemButton', 'calendarEditorModal');
      const prev = document.getElementById('adminCalendarMonthTitle')?.textContent || '';
      document.getElementById('adminCalendarNextMonthButton')?.click();
      await sleep(80);
      const moved = document.getElementById('adminCalendarMonthTitle')?.textContent || '';
      document.getElementById('adminCalendarTodayButton')?.click();
      actual.calendarNavigation = Boolean(prev && moved && prev !== moved);
    }

    const ok = Object.values(actual).every(Boolean);
    return ok
      ? pass('所選資源的管理端編輯視窗與日曆操作皆已通過真人點擊。', { selectedEditors: true }, actual)
      : fail('至少一個所選資源編輯視窗或日曆切換異常。', { selectedEditors: true }, actual);
  }

  async function openIntegrationCenter(timeoutMs = 15000) {
    const tab = await waitFor(() => document.getElementById('operationsHubTab'), 6000, 80);
    if (!tab) throw new Error('整合中心分頁未載入。');
    await adminHumanClick(tab, '整合中心');
    const panel = await waitFor(() => {
      const node = document.getElementById('operationsHubPanel');
      return node && !node.classList.contains('hidden') ? node : null;
    }, 5000, 80);
    if (!panel) throw new Error('整合中心無法開啟。');

    const loaded = Boolean(await waitFor(() => {
      const freshness = String(document.getElementById('integrationHubFreshness')?.textContent || '');
      const message = document.getElementById('integrationHubMessage');
      if (message && !message.classList.contains('hidden') && String(message.textContent || '').trim()) return null;
      return freshness && !/尚未同步/.test(freshness)
        && document.querySelectorAll('#integrationMetricGrid .integration-metric').length >= 6
        ? true
        : null;
    }, timeoutMs, 120));
    if (!loaded) throw new Error('整合中心讀模型在允許時間內沒有完成載入。');
    return panel;
  }

  function integrationViewVisible(view) {
    const section = document.querySelector('[data-integration-view="' + CSS.escape(String(view || '')) + '"]');
    return Boolean(section && !section.classList.contains('hidden'));
  }

  async function switchIntegrationView(view) {
    const button = document.querySelector('[data-integration-view-tab="' + CSS.escape(String(view || '')) + '"]');
    if (!button) return false;
    await adminHumanClick(button, '整合中心 ' + view);
    return Boolean(await waitFor(() => integrationViewVisible(view) ? true : null, 2500, 80));
  }

  async function adminIntegrationCenterCase() {
    const actual = {
      opened: false,
      metrics: 0,
      overview: false,
      benefits: false,
      notifications: false,
      audit: false,
      pointSourcesRendered: false,
      campaignContainerReady: false,
      settlementContainerReady: false,
      benefitSummaryReady: false,
      notificationFilterWorked: false,
      auditFilterWorked: false,
      noReadModelError: false
    };

    try {
      await openIntegrationCenter();
      actual.opened = true;
      actual.metrics = document.querySelectorAll('#integrationMetricGrid .integration-metric').length;
      actual.overview = integrationViewVisible('overview');
      actual.pointSourcesRendered = Boolean(document.getElementById('integrationPointSources')?.children.length);
      actual.campaignContainerReady = Boolean(document.getElementById('integrationCampaigns'));
      actual.settlementContainerReady = Boolean(document.getElementById('integrationSettlements'));

      actual.benefits = await switchIntegrationView('benefits');
      actual.benefitSummaryReady = Boolean(document.getElementById('integrationBenefitSummary')?.children.length);

      actual.notifications = await switchIntegrationView('notifications');
      const notificationFilter = document.getElementById('integrationNotificationFilter');
      if (notificationFilter) {
        notificationFilter.value = 'pending';
        notificationFilter.dispatchEvent(new Event('change', { bubbles: true }));
        await adminHumanPause(50, 130);
        notificationFilter.value = 'all';
        notificationFilter.dispatchEvent(new Event('change', { bubbles: true }));
        actual.notificationFilterWorked = String(notificationFilter.value) === 'all'
          && Boolean(document.getElementById('integrationNotifications'));
      }

      actual.audit = await switchIntegrationView('audit');
      const auditFilter = document.getElementById('integrationAuditFilter');
      const auditSearch = document.getElementById('integrationAuditSearch');
      if (auditFilter && auditSearch) {
        auditFilter.value = 'booking';
        auditFilter.dispatchEvent(new Event('change', { bubbles: true }));
        await adminHumanTextInput(auditSearch, 'BOOKING', 'Audit 搜尋');
        await adminHumanPause(50, 130);
        await adminHumanTextInput(auditSearch, '', 'Audit 搜尋清除');
        auditFilter.value = 'all';
        auditFilter.dispatchEvent(new Event('change', { bubbles: true }));
        actual.auditFilterWorked = auditFilter.value === 'all' && auditSearch.value === ''
          && Boolean(document.getElementById('integrationAuditTimeline'));
      }

      const message = document.getElementById('integrationHubMessage');
      actual.noReadModelError = !message || message.classList.contains('hidden') || !String(message.textContent || '').trim();

      await switchIntegrationView('overview');
    } catch (error) {
      return fail('整合中心 E2E 無法完成。', {
        opened: true,
        metricsAtLeast: 6,
        allViews: true,
        filtersInteractive: true,
        noReadModelError: true
      }, { ...actual, error: plainError(error) });
    }

    const ok = actual.opened
      && actual.metrics >= 6
      && actual.overview
      && actual.benefits
      && actual.notifications
      && actual.audit
      && actual.pointSourcesRendered
      && actual.campaignContainerReady
      && actual.settlementContainerReady
      && actual.benefitSummaryReady
      && actual.notificationFilterWorked
      && actual.auditFilterWorked
      && actual.noReadModelError;

    return ok
      ? pass('整合中心總覽、權益自動化、通知中心與 Audit Timeline 已以真人 UI 操作完成，讀模型與篩選互動正常。', {
          opened: true,
          metricsAtLeast: 6,
          allViews: true,
          filtersInteractive: true,
          noReadModelError: true
        }, actual)
      : fail('整合中心至少一個視圖或篩選互動異常。', {
          opened: true,
          metricsAtLeast: 6,
          allViews: true,
          filtersInteractive: true,
          noReadModelError: true
        }, actual);
  }

  async function adminIntegrationNavigationCase() {
    const actual = {
      bookingServices: false,
      events: false,
      calendarBatch: false,
      members: false,
      returnedToHub: 0
    };

    const reopen = async () => {
      await openIntegrationCenter();
      actual.returnedToHub += 1;
    };

    try {
      await reopen();

      const bookingServices = document.querySelector('[data-integration-target="booking-services"]');
      if (bookingServices) {
        await adminHumanClick(bookingServices, '點數來源設定');
        actual.bookingServices = Boolean(await waitFor(() => {
          const panel = document.getElementById('bookingPanel');
          const tab = document.getElementById('bookingAdminServicesSubtab');
          return panel && !panel.classList.contains('hidden') && tab?.getAttribute('aria-selected') === 'true' ? true : null;
        }, 5000, 80));
      }

      await reopen();
      const events = document.querySelector('[data-integration-target="events"]');
      if (events) {
        await adminHumanClick(events, '自動權益');
        actual.events = Boolean(await waitFor(() => {
          const panel = document.getElementById('eventsPanel');
          return panel && !panel.classList.contains('hidden') ? true : null;
        }, 3500, 80));
      }

      await reopen();
      const calendar = document.querySelector('[data-integration-target="calendar-batch"]');
      if (calendar) {
        await adminHumanClick(calendar, '日曆批次');
        actual.calendarBatch = Boolean(await waitFor(() => {
          const panel = document.getElementById('calendarPanel');
          return panel && !panel.classList.contains('hidden') && document.getElementById('calendarBatchRows') ? true : null;
        }, 3500, 80));
      }

      await reopen();
      const members = document.querySelector('[data-integration-target="member-grant"]');
      if (members) {
        await adminHumanClick(members, '會員發放');
        actual.members = Boolean(await waitFor(() => {
          const panel = document.getElementById('membersPanel');
          return panel && !panel.classList.contains('hidden') && document.getElementById('memberSearch') ? true : null;
        }, 3500, 80));
      }

      await reopen();
    } catch (error) {
      return fail('整合中心跨模組導向無法完成。', {
        bookingServices: true,
        events: true,
        calendarBatch: true,
        members: true
      }, { ...actual, error: plainError(error) });
    }

    const ok = actual.bookingServices && actual.events && actual.calendarBatch && actual.members && actual.returnedToHub >= 5;
    return ok
      ? pass('整合中心可真人導向預約點數來源、活動權益、日曆批次與會員發放，且可回到整合中心繼續操作。', {
          bookingServices: true,
          events: true,
          calendarBatch: true,
          members: true
        }, actual)
      : fail('整合中心至少一個跨模組快速導向異常。', {
          bookingServices: true,
          events: true,
          calendarBatch: true,
          members: true
        }, actual);
  }


  function qaCrudStamp() {
    return Date.now().toString(36).slice(-7) + Math.random().toString(36).slice(2, 6);
  }

  function textIncludes(selector, value) {
    return String(document.querySelector(selector)?.textContent || '').includes(String(value || ''));
  }

  async function withAutoConfirm(task) {
    const original = window.confirm;
    window.confirm = () => true;
    try { return await task(); }
    finally { window.confirm = original; }
  }

  function closeEditorModalById(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal || modal.classList.contains('hidden')) return;
    modal.querySelector('.editor-modal-close')?.click();
  }

  async function waitEditorOpen(modalId, timeoutMs = 4000) {
    return waitFor(() => {
      const modal = document.getElementById(modalId);
      return modal && !modal.classList.contains('hidden') ? modal : null;
    }, timeoutMs);
  }

  async function waitAdminWriteSettled(buttonId, timeoutMs = 22000) {
    return Boolean(await waitFor(() => {
      const button = document.getElementById(buttonId);
      if (!button) return null;
      return !button.disabled ? button : null;
    }, timeoutMs, 80));
  }

  async function clickResourceRow(selector, dataKey, value, timeoutMs = 6000) {
    const row = await waitFor(() => {
      return Array.from(document.querySelectorAll(selector)).find((item) =>
        String(item.dataset?.[dataKey] || '') === String(value || '')
      ) || null;
    }, timeoutMs, 80);
    if (!row) return false;
    row.click();
    return true;
  }

  function findBookingRow(containerId, title) {
    return Array.from(document.querySelectorAll('#' + containerId + ' .booking-admin-service-row')).find((row) => {
      return String(row.querySelector('strong')?.textContent || '').trim() === String(title || '').trim();
    }) || null;
  }

  async function waitBookingAdminReady(timeoutMs = 15000) {
    return Boolean(await waitFor(() => {
      const status = document.getElementById('bookingAdminSyncStatus');
      const text = String(status?.textContent || '');
      if (!status || /同步預約資料中/.test(text) || status.classList.contains('error')) return null;
      return document.getElementById('bookingAdminNewTypeButton')
        && document.getElementById('bookingAdminNewServiceButton')
        && document.getElementById('bookingAdminTypeList')
        && document.getElementById('bookingAdminServiceList');
    }, timeoutMs, 100));
  }

  function clickBookingRowAction(containerId, title, actionLabel) {
    const row = findBookingRow(containerId, title);
    if (!row) return false;
    const button = Array.from(row.querySelectorAll('button')).find((item) => String(item.textContent || '').trim() === actionLabel);
    if (!button) return false;
    button.click();
    return true;
  }


  async function cleanupQaTicketTemplate(ticketTemplateId) {
    if (!ticketTemplateId) return { deleted: true, alreadyMissing: true };
    const session = await adminSession();
    return postFunction('test-control-api', {
      action: 'admin.test-control.cleanup-ticket-template',
      clientType: 'admin',
      idToken: session.idToken,
      ticketTemplateId
    });
  }

  async function createQaTicketTemplate(title, options = {}) {
    document.getElementById('cardsTab')?.click();
    document.getElementById('ticketSettingsTab')?.click();
    document.getElementById('newTicketButton')?.click();
    const modal = await waitEditorOpen('ticketEditorModal', 5000);
    if (!modal) throw new Error('票券新增編輯器未開啟。');

    const ticketType = String(options.ticketType || 'coupon');
    setField('ticketTitle', title);
    setField('ticketType', ticketType);
    setField('ticketDescription', options.description || 'E2E QA 深度測試票券，完成後由 Test Control 清理。');
    setField('ticketUsageMethod', options.usageMethod || '僅供自動化 E2E');
    setField('ticketUsageInstructions', options.usageInstructions || '不可供正式會員使用；測試完成後自動清理。');
    setField('ticketStatus', options.status || 'active');
    if (ticketType === 'lottery') {
      const lottery = await configureLotteryPrizeEditor('ticket', Array.isArray(options.prizes) && options.prizes.length
        ? options.prizes
        : [
            { title: 'E2E 頭獎', rate: 50, description: '管理端 E2E 抽獎券頭獎' },
            { title: 'E2E 二獎', rate: 35, description: '管理端 E2E 抽獎券二獎' },
            { title: 'E2E 參加獎', rate: 15, description: '管理端 E2E 抽獎券參加獎' }
          ]);
      if (!lottery.editorVisible || !lottery.totalIs100) {
        closeEditorModalById('ticketEditorModal');
        throw new Error('抽獎券獎項機率未完成 100% 設定。');
      }
    }
    document.getElementById('saveTicketButton')?.click();

    const ticketTemplateId = String(await waitFor(() => document.getElementById('ticketTemplateId')?.value || null, 15000) || '');
    await waitAdminWriteSettled('saveTicketButton');
    if (!ticketTemplateId) {
      closeEditorModalById('ticketEditorModal');
      throw new Error('票券儲存後沒有取得 Ticket Template ID。');
    }
    const listed = Boolean(await waitFor(() => textIncludes('#ticketListItems', title), 10000));
    if (!listed) {
      closeEditorModalById('ticketEditorModal');
      throw new Error('票券儲存後沒有出現在管理端票券清單。');
    }
    return { ticketTemplateId, title, modal };
  }

  async function adminTicketCrudCase() {
    const stamp = qaCrudStamp();
    const createdTitle = 'E2E QA 深度票券 ' + stamp;
    const updatedTitle = createdTitle + ' 修改';
    const actual = { created: false, updated: false, archived: false, cleaned: false };
    let ticketTemplateId = '';

    try {
      const fixture = await createQaTicketTemplate(createdTitle, { status: 'active' });
      ticketTemplateId = fixture.ticketTemplateId;
      actual.created = Boolean(ticketTemplateId);

      setField('ticketTitle', updatedTitle);
      setField('ticketDescription', 'E2E QA 深度票券已完成修改驗證。');
      document.getElementById('saveTicketButton')?.click();
      await waitAdminWriteSettled('saveTicketButton');
      await clickResourceRow('#ticketListItems [data-ticket-template-id]', 'ticketTemplateId', ticketTemplateId);
      actual.updated = Boolean(await waitFor(() =>
        String(document.getElementById('ticketTemplateId')?.value || '') === ticketTemplateId &&
        String(document.getElementById('ticketTitle')?.value || '') === updatedTitle &&
        textIncludes('#ticketListItems', updatedTitle)
      , 8000));

      setField('ticketStatus', 'archived');
      document.getElementById('saveTicketButton')?.click();
      await waitAdminWriteSettled('saveTicketButton');
      await clickResourceRow('#ticketListItems [data-ticket-template-id]', 'ticketTemplateId', ticketTemplateId);
      actual.archived = Boolean(await waitFor(() =>
        String(document.getElementById('ticketTemplateId')?.value || '') === ticketTemplateId &&
        String(document.getElementById('ticketStatus')?.value || '') === 'archived'
      , 8000));
    } finally {
      closeEditorModalById('ticketEditorModal');
      if (ticketTemplateId) {
        try {
          const result = await cleanupQaTicketTemplate(ticketTemplateId);
          actual.cleaned = Boolean(result?.deleted);
        } catch {}
      }
    }

    const ok = actual.created && actual.updated && actual.archived && actual.cleaned;
    return ok
      ? pass('已透過管理端 UI 完成票券新增、修改與封存，並由受管理員授權的 QA 清理路徑移除測試範本。', { created: true, updated: true, archived: true, cleaned: true }, actual)
      : fail('票券 CRUD E2E 至少一個階段失敗。', { created: true, updated: true, archived: true, cleaned: true }, actual);
  }


  async function configureLotteryPrizeEditor(kind, prizes) {
    const isEvent = kind === 'event';
    const typeId = isEvent ? 'eventTicketType' : 'ticketType';
    const editorId = isEvent ? 'eventTicketPrizeEditor' : 'ticketPrizeEditor';
    const rowsId = isEvent ? 'eventTicketPrizeRows' : 'ticketPrizeRows';
    const addId = isEvent ? 'addEventTicketPrizeButton' : 'addTicketPrizeButton';
    const totalId = isEvent ? 'eventTicketPrizeTotal' : 'ticketPrizeTotal';
    const rowSelector = isEvent ? '[data-event-ticket-prize-row]' : '[data-ticket-prize-row]';
    const titleField = isEvent ? 'eventTicketPrizeTitle' : 'ticketPrizeTitle';
    const rateField = isEvent ? 'eventTicketPrizeRate' : 'ticketPrizeRate';
    const descriptionField = isEvent ? 'eventTicketPrizeDescription' : 'ticketPrizeDescription';

    setField(typeId, 'lottery');
    if (!await waitFor(() => !document.getElementById(editorId)?.classList.contains('hidden'), 2500)) {
      throw new Error('抽獎券獎項編輯器未開啟。');
    }
    while (document.querySelectorAll('#' + rowsId + ' ' + rowSelector).length < prizes.length) {
      document.getElementById(addId)?.click();
      await sleep(20);
    }
    const rows = Array.from(document.querySelectorAll('#' + rowsId + ' ' + rowSelector));
    if (rows.length < prizes.length) throw new Error('抽獎券獎項列建立不完整。');

    prizes.forEach((prize, index) => {
      const row = rows[index];
      const title = row?.querySelector('[data-field="' + titleField + '"]');
      const rate = row?.querySelector('[data-field="' + rateField + '"]');
      const description = row?.querySelector('[data-field="' + descriptionField + '"]');
      if (!title || !rate || !description) throw new Error('抽獎券獎項欄位不完整。');
      title.value = String(prize.title || '');
      rate.value = String(prize.rate);
      description.value = String(prize.description || '');
      [title, rate, description].forEach((input) => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
    const totalText = String(document.getElementById(totalId)?.textContent || '');
    return {
      editorVisible: !document.getElementById(editorId)?.classList.contains('hidden'),
      rowCount: document.querySelectorAll('#' + rowsId + ' ' + rowSelector).length,
      totalText,
      totalIs100: /機率合計\s*100(?:\.0+)?%\s*✓/.test(totalText)
    };
  }

  async function adminLotteryTicketCrudCase() {
    const testTicket = state.selectedModules.includes('points');
    const testEvent = state.selectedModules.includes('event');
    const stamp = qaCrudStamp();
    const ticketTitle = 'E2E QA 抽獎券 ' + stamp;
    const eventTitle = 'E2E QA 活動抽獎券 ' + stamp;
    const actual = {
      ticket: { editorVisible: false, probability100: false, created: false, reloaded: false, cleaned: false },
      event: { editorVisible: false, probability100: false, created: false, reloaded: false, deleted: false, cleaned: false }
    };
    let ticketTemplateId = '';
    let eventTicketId = '';

    try {
      if (testTicket) {
        document.getElementById('cardsTab')?.click();
        document.getElementById('ticketSettingsTab')?.click();
        document.getElementById('newTicketButton')?.click();
        if (!await waitEditorOpen('ticketEditorModal', 5000)) throw new Error('抽獎券新增編輯器未開啟。');
        setField('ticketTitle', ticketTitle);
        setField('ticketDescription', '管理端 E2E 多獎項抽獎券');
        setField('ticketUsageMethod', '開啟後執行抽獎');
        setField('ticketUsageInstructions', '僅供測試帳號與自動化測試使用。');
        setField('ticketStatus', 'active');
        const ticketEditor = await configureLotteryPrizeEditor('ticket', [
          { title: '頭獎', rate: 55, description: 'E2E 頭獎' },
          { title: '二獎', rate: 30, description: 'E2E 二獎' },
          { title: '參加獎', rate: 15, description: 'E2E 參加獎' }
        ]);
        actual.ticket.editorVisible = ticketEditor.editorVisible;
        actual.ticket.probability100 = ticketEditor.totalIs100 && ticketEditor.rowCount >= 3;
        document.getElementById('saveTicketButton')?.click();
        ticketTemplateId = String(await waitFor(() => document.getElementById('ticketTemplateId')?.value || null, 15000) || '');
        await waitAdminWriteSettled('saveTicketButton');
        actual.ticket.created = Boolean(ticketTemplateId && textIncludes('#ticketListItems', ticketTitle));
        if (ticketTemplateId) {
          await clickResourceRow('#ticketListItems [data-ticket-template-id]', 'ticketTemplateId', ticketTemplateId);
          actual.ticket.reloaded = Boolean(await waitFor(() =>
            String(document.getElementById('ticketTemplateId')?.value || '') === ticketTemplateId
            && String(document.getElementById('ticketType')?.value || '') === 'lottery'
            && document.querySelectorAll('#ticketPrizeRows [data-ticket-prize-row]').length >= 3
            && /100(?:\.0+)?%\s*✓/.test(String(document.getElementById('ticketPrizeTotal')?.textContent || ''))
          , 8000));
        }
        closeEditorModalById('ticketEditorModal');
      }

      if (testEvent) {
        document.getElementById('eventsTab')?.click();
        document.getElementById('newEventTicketButton')?.click();
        if (!await waitEditorOpen('eventTicketEditorModal', 5000)) throw new Error('活動抽獎券新增編輯器未開啟。');
        setField('eventTicketTitle', eventTitle);
        setField('eventTicketDescription', '管理端 E2E 活動抽獎券');
        setField('eventTicketUsageMethod', '領取後執行抽獎');
        setField('eventTicketUsageInstructions', '測試完成後由 E2E 自動清理。');
        setField('eventTicketStatus', 'draft');
        setField('eventTicketStartsOn', '');
        setField('eventTicketEndsOn', '');
        setField('eventTicketQuota', '12');
        const eventEditor = await configureLotteryPrizeEditor('event', [
          { title: 'VIP A', rate: 61, description: 'E2E VIP A' },
          { title: 'VIP B', rate: 29, description: 'E2E VIP B' },
          { title: 'VIP C', rate: 10, description: 'E2E VIP C' }
        ]);
        actual.event.editorVisible = eventEditor.editorVisible;
        actual.event.probability100 = eventEditor.totalIs100 && eventEditor.rowCount >= 3;
        document.getElementById('saveEventTicketButton')?.click();
        eventTicketId = String(await waitFor(() => document.getElementById('eventTicketId')?.value || null, 15000) || '');
        await waitAdminWriteSettled('saveEventTicketButton');
        actual.event.created = Boolean(eventTicketId && textIncludes('#eventTicketListItems', eventTitle));
        if (eventTicketId) {
          await clickResourceRow('#eventTicketListItems [data-event-ticket-id]', 'eventTicketId', eventTicketId);
          actual.event.reloaded = Boolean(await waitFor(() =>
            String(document.getElementById('eventTicketId')?.value || '') === eventTicketId
            && String(document.getElementById('eventTicketType')?.value || '') === 'lottery'
            && document.querySelectorAll('#eventTicketPrizeRows [data-event-ticket-prize-row]').length >= 3
            && /100(?:\.0+)?%\s*✓/.test(String(document.getElementById('eventTicketPrizeTotal')?.textContent || ''))
          , 8000));
          await withAutoConfirm(async () => {
            document.getElementById('deleteEventTicketButton')?.click();
            actual.event.deleted = Boolean(await waitFor(() => {
              const currentId = String(document.getElementById('eventTicketId')?.value || '');
              const row = document.querySelector('#eventTicketListItems [data-event-ticket-id="' + CSS.escape(eventTicketId) + '"]');
              return !currentId && !row;
            }, 15000));
            if (!actual.event.deleted) {
              const row = document.querySelector('#eventTicketListItems [data-event-ticket-id="' + CSS.escape(eventTicketId) + '"]');
              row?.click();
              await waitFor(() => String(document.getElementById('eventTicketId')?.value || '') === eventTicketId, 2500);
              document.getElementById('deleteEventTicketButton')?.click();
              actual.event.deleted = Boolean(await waitFor(() => {
                const currentId = String(document.getElementById('eventTicketId')?.value || '');
                const remaining = document.querySelector('#eventTicketListItems [data-event-ticket-id="' + CSS.escape(eventTicketId) + '"]');
                return !currentId && !remaining;
              }, 12000));
            }
          });
          actual.event.cleaned = actual.event.deleted;
        }
      }
    } finally {
      closeEditorModalById('eventTicketEditorModal');
      closeEditorModalById('ticketEditorModal');
      if (eventTicketId && !actual.event.cleaned) {
        try {
          document.getElementById('eventsTab')?.click();
          const row = document.querySelector('#eventTicketListItems [data-event-ticket-id="' + CSS.escape(eventTicketId) + '"]');
          row?.click();
          await waitFor(() => String(document.getElementById('eventTicketId')?.value || '') === eventTicketId, 3000);
          await withAutoConfirm(async () => {
            document.getElementById('deleteEventTicketButton')?.click();
            actual.event.cleaned = Boolean(await waitFor(() => !String(document.getElementById('eventTicketId')?.value || ''), 12000));
          });
        } catch {}
      }
      if (ticketTemplateId) {
        try {
          const result = await cleanupQaTicketTemplate(ticketTemplateId);
          actual.ticket.cleaned = Boolean(result?.deleted);
        } catch {
          actual.ticket.cleaned = false;
        }
      }
    }

    const ok = (!testTicket || Object.values(actual.ticket).every(Boolean)) &&
      (!testEvent || Object.values(actual.event).every(Boolean));
    const expected = {
      ticketLottery: testTicket,
      eventLottery: testEvent,
      prizeProbabilityTotal: 100,
      persistedAndReloaded: true,
      cleaned: true
    };
    return ok
      ? pass('所選抽獎券模組已完成機率 100%、儲存、回讀與清理驗證。', expected, actual)
      : fail('所選抽獎券 E2E 至少一個階段失敗。', expected, actual);
  }

  async function adminPointCardCrudCase() {
    const stamp = qaCrudStamp();
    const createdTitle = 'E2E 集點卡 ' + stamp;
    const updatedTitle = createdTitle + ' 修改';
    const actual = {
      lotteryTicketCreated: false,
      lotteryTicketLinked: false,
      lotteryRewardReloaded: false,
      created: false,
      updated: false,
      deleted: false,
      cleaned: false,
      ticketCleaned: true
    };
    let createdId = '';
    let qaTicketTemplateId = '';

    try {
      const lotteryFixture = await createQaTicketTemplate('E2E QA 集點卡抽獎券 ' + stamp, {
        status: 'active',
        ticketType: 'lottery',
        description: '管理端 E2E：集點卡兌換節點專用抽獎券',
        usageMethod: '集滿指定點數後使用並抽獎',
        usageInstructions: '僅供自動化 E2E；測試完成後清理。',
        prizes: [
          { title: '集點頭獎', rate: 55, description: '集點卡抽獎券頭獎' },
          { title: '集點二獎', rate: 30, description: '集點卡抽獎券二獎' },
          { title: '集點參加獎', rate: 15, description: '集點卡抽獎券參加獎' }
        ]
      });
      qaTicketTemplateId = lotteryFixture.ticketTemplateId;
      actual.lotteryTicketCreated = Boolean(qaTicketTemplateId);
      closeEditorModalById('ticketEditorModal');

      document.getElementById('cardsTab')?.click();
      document.getElementById('cardSettingsTab')?.click();
      document.getElementById('newCardButton')?.click();
      if (!await waitEditorOpen('cardEditorModal')) throw new Error('集點卡新增編輯器未開啟。');

      setField('cardTitle', createdTitle);
      setField('cardUsageMethod', 'E2E 測試用集點方式');
      setField('cardUsageInstructions', '此資料由管理端 E2E 建立，測試完成後自動刪除。');
      setField('cardBenefitDescription', '97 點兌換管理端 E2E 抽獎券');
      setField('cardStatus', 'draft');
      setField('cardExpiryMode', 'unlimited');

      const rewardSelect = await waitFor(() => document.querySelector('#rewardRows [data-field="ticketTemplateId"]'), 5000);
      const threshold = document.querySelector('#rewardRows [data-field="thresholdStamps"]');
      const lotteryOption = rewardSelect
        ? Array.from(rewardSelect.options).find((option) => String(option.value || '') === qaTicketTemplateId && !option.disabled)
        : null;
      if (!rewardSelect || !threshold || !lotteryOption) {
        throw new Error('集點卡無法選取剛建立的抽獎券兌換節點。');
      }
      threshold.value = '97';
      threshold.dispatchEvent(new Event('input', { bubbles: true }));
      rewardSelect.value = qaTicketTemplateId;
      rewardSelect.dispatchEvent(new Event('change', { bubbles: true }));
      actual.lotteryTicketLinked = String(rewardSelect.value || '') === qaTicketTemplateId;

      document.getElementById('saveCardButton')?.click();
      createdId = String(await waitFor(() => document.getElementById('cardId')?.value || null, 15000) || '');
      await waitAdminWriteSettled('saveCardButton');
      actual.created = Boolean(createdId && await waitFor(() => textIncludes('#cardListItems', createdTitle), 10000));

      if (actual.created) {
        setField('cardTitle', updatedTitle);
        setField('cardBenefitDescription', '管理端 CRUD E2E 已完成抽獎券節點修改驗證');
        document.getElementById('saveCardButton')?.click();
        await waitAdminWriteSettled('saveCardButton');
        await clickResourceRow('#cardListItems [data-card-id]', 'cardId', createdId);
        actual.updated = Boolean(await waitFor(() => {
          return String(document.getElementById('cardId')?.value || '') === createdId &&
            String(document.getElementById('cardTitle')?.value || '') === updatedTitle &&
            textIncludes('#cardListItems', updatedTitle);
        }, 8000));
        actual.lotteryRewardReloaded = Boolean(await waitFor(() => {
          const persisted = document.querySelector('#rewardRows [data-field="ticketTemplateId"]');
          return persisted && String(persisted.value || '') === qaTicketTemplateId;
        }, 5000));
      }

      if (actual.created) {
        await withAutoConfirm(async () => {
          document.getElementById('deleteCardButton')?.click();
          actual.deleted = Boolean(await waitFor(() => {
            return !String(document.getElementById('cardId')?.value || '') && !textIncludes('#cardListItems', updatedTitle);
          }, 15000));
        });
      }
      actual.cleaned = actual.deleted;
    } finally {
      if (!actual.deleted && createdId) {
        try {
          const row = document.querySelector('#cardListItems [data-card-id="' + CSS.escape(createdId) + '"]');
          row?.click();
          await waitFor(() => String(document.getElementById('cardId')?.value || '') === createdId, 3000);
          await withAutoConfirm(async () => {
            document.getElementById('deleteCardButton')?.click();
            actual.cleaned = Boolean(await waitFor(() => !String(document.getElementById('cardId')?.value || ''), 12000));
          });
        } catch {}
      }
      closeEditorModalById('cardEditorModal');
      if (qaTicketTemplateId) {
        try {
          const result = await cleanupQaTicketTemplate(qaTicketTemplateId);
          actual.ticketCleaned = Boolean(result?.deleted);
        } catch {
          actual.ticketCleaned = false;
        }
      }
    }

    const ok = actual.lotteryTicketCreated && actual.lotteryTicketLinked && actual.lotteryRewardReloaded &&
      actual.created && actual.updated && actual.deleted && actual.cleaned && actual.ticketCleaned;
    return ok
      ? pass('已透過管理端 UI 建立抽獎券並綁定集點卡兌換節點，完成儲存回讀、修改、永久刪除與 QA 清理。', {
          lotteryTicketCreated: true,
          lotteryTicketLinked: true,
          lotteryRewardReloaded: true,
          created: true,
          updated: true,
          deleted: true,
          cleaned: true
        }, actual)
      : fail('集點卡抽獎券 CRUD E2E 至少一個階段失敗。', {
          lotteryTicketCreated: true,
          lotteryTicketLinked: true,
          lotteryRewardReloaded: true,
          created: true,
          updated: true,
          deleted: true,
          cleaned: true
        }, actual);
  }

  async function adminEventTicketCrudCase() {
    const stamp = qaCrudStamp();
    const createdTitle = 'E2E 活動票券 ' + stamp;
    const updatedTitle = createdTitle + ' 修改';
    const actual = { created: false, updated: false, locationSaved: false, deleted: false, cleaned: false };
    let createdId = '';

    document.getElementById('eventsTab')?.click();
    document.getElementById('newEventTicketButton')?.click();
    const modal = await waitEditorOpen('eventTicketEditorModal');
    if (!modal) return fail('活動票券新增編輯器未開啟。', { editorOpen: true }, { editorOpen: false });

    try {
      setField('eventTicketTitle', createdTitle);
      setField('eventTicketType', 'coupon');
      setField('eventTicketDescription', '管理端 CRUD E2E 測試票券');
      setField('eventTicketUsageMethod', '僅供自動化 E2E');
      setField('eventTicketUsageInstructions', '測試完成後自動刪除，不提供正式會員使用。');
      setField('eventTicketStatus', 'draft');
      setField('eventTicketStartsOn', '');
      setField('eventTicketEndsOn', '');
      setField('eventTicketQuota', '0');
      document.getElementById('eventTicketRequiresLocation').checked = true;
      window.CouponLocationEditor.set([
        { name: 'E2E 台北', latitude: 25.033964, longitude: 121.564468, radiusMeters: 150 },
        { name: 'E2E 台中', latitude: 24.147736, longitude: 120.673648, radiusMeters: 150 },
      ]);

      document.getElementById('saveEventTicketButton')?.click();
      createdId = String(await waitFor(() => document.getElementById('eventTicketId')?.value || null, 15000) || '');
      await waitAdminWriteSettled('saveEventTicketButton');
      actual.created = Boolean(createdId && await waitFor(() => textIncludes('#eventTicketListItems', createdTitle), 10000));

      if (actual.created) {
        setField('eventTicketTitle', updatedTitle);
        setField('eventTicketDescription', '管理端 CRUD E2E 已完成修改');
        document.getElementById('saveEventTicketButton')?.click();
        await waitAdminWriteSettled('saveEventTicketButton');
        await clickResourceRow('#eventTicketListItems [data-event-ticket-id]', 'eventTicketId', createdId);
        actual.updated = Boolean(await waitFor(() => {
          return String(document.getElementById('eventTicketId')?.value || '') === createdId &&
            String(document.getElementById('eventTicketTitle')?.value || '') === updatedTitle &&
            textIncludes('#eventTicketListItems', updatedTitle);
        }, 8000));
        actual.locationSaved = document.getElementById('eventTicketRequiresLocation')?.checked === true
          && window.CouponLocationEditor.get().length === 2
          && window.CouponLocationEditor.get()[1].name === 'E2E 台中';
      }

      if (actual.created) {
        await withAutoConfirm(async () => {
          document.getElementById('deleteEventTicketButton')?.click();
          actual.deleted = Boolean(await waitFor(() => {
            return !String(document.getElementById('eventTicketId')?.value || '') && !textIncludes('#eventTicketListItems', updatedTitle);
          }, 15000));
        });
      }
      actual.cleaned = actual.deleted;
    } finally {
      if (!actual.deleted && createdId) {
        try {
          const row = document.querySelector('#eventTicketListItems [data-event-ticket-id="' + CSS.escape(createdId) + '"]');
          row?.click();
          await waitFor(() => String(document.getElementById('eventTicketId')?.value || '') === createdId, 3000);
          await withAutoConfirm(async () => {
            document.getElementById('deleteEventTicketButton')?.click();
            actual.cleaned = Boolean(await waitFor(() => !String(document.getElementById('eventTicketId')?.value || ''), 12000));
          });
        } catch {}
      }
      closeEditorModalById('eventTicketEditorModal');
    }

    const ok = actual.created && actual.updated && actual.locationSaved && actual.deleted && actual.cleaned;
    return ok
      ? pass('已透過管理端 UI 完成活動票券與定位規則新增、回讀、刪除，QA 資料已清理。', { created: true, updated: true, locationSaved: true, deleted: true, cleaned: true }, actual)
      : fail('活動票券 CRUD E2E 至少一個階段失敗。', { created: true, updated: true, locationSaved: true, deleted: true, cleaned: true }, actual);
  }

  async function adminCalendarCrudCase(itemType = 'holiday') {
    const stamp = qaCrudStamp();
    const createdTitle = 'E2E 日曆 ' + stamp;
    const updatedTitle = createdTitle + ' 修改';
    const actual = { created: false, updated: false, deleted: false, cleaned: false };
    let createdId = '';

    document.getElementById('calendarTab')?.click();
    document.getElementById('newCalendarItemButton')?.click();
    const modal = await waitEditorOpen('calendarEditorModal');
    if (!modal) return fail('日曆新增編輯器未開啟。', { editorOpen: true }, { editorOpen: false });

    try {
      setField('calendarItemTitle', createdTitle);
      setField('calendarItemType', itemType);
      if (itemType === 'event') {
        setField('calendarItemLinkLabel', 'E2E 活動連結');
        setField('calendarItemLinkUrl', 'https://example.com/e2e-qa');
        setField('calendarBonusPoints', '4');
        toggleCheckbox('calendarBonusPointsEnabled', true);
        const audience = document.querySelector('#calendarItemAllowedTiers input[value="general"]');
        if (audience?.checked) audience.click();
      }
      setField('calendarItemDescription', '管理端 CRUD E2E 測試日期');
      setField('calendarItemStatus', 'draft');
      const startInput = document.getElementById('calendarItemStartsOn');
      if (!startInput?.value) {
        const today = new Date();
        const local = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        setField('calendarItemStartsOn', local);
      }
      setField('calendarItemEndsOn', '');

      document.getElementById('saveCalendarItemButton')?.click();
      createdId = String(await waitFor(() => document.getElementById('calendarItemId')?.value || null, 15000) || '');
      await waitAdminWriteSettled('saveCalendarItemButton');
      const session = await adminSession();
      const stored = await window.MemberSystem.request(session.config, 'admin', session.idToken, 'admin.calendar-items.list', {});
      const own = (stored.calendarItems || []).find(item => item.calendarItemId === createdId);
      actual.created = Boolean(own && own.title === createdTitle && own.status === 'draft' &&
        (itemType !== 'event' || (own.bonusPointsEnabled && own.bonusPoints === 4 && own.linkUrl === 'https://example.com/e2e-qa' && !own.allowedTierKeys.includes('general'))));

      if (actual.created) {
        setField('calendarItemTitle', updatedTitle);
        setField('calendarItemDescription', '管理端 CRUD E2E 已完成修改');
        document.getElementById('saveCalendarItemButton')?.click();
        actual.updated = Boolean(await waitFor(() => {
          return String(document.getElementById('calendarItemId')?.value || '') === createdId &&
            String(document.getElementById('calendarItemTitle')?.value || '') === updatedTitle &&
            document.getElementById('saveCalendarItemButton')?.disabled === false &&
            Array.from(document.querySelectorAll('#adminCalendarGrid [data-admin-calendar-item-id]')).some(button => button.dataset.adminCalendarItemId === createdId && button.textContent.includes(updatedTitle));
        }, 15000));
      }

      if (actual.created) {
        await withAutoConfirm(async () => {
          document.getElementById('deleteCalendarItemButton')?.click();
          actual.deleted = Boolean(await waitFor(() => !String(document.getElementById('calendarItemId')?.value || ''), 15000));
        });
      }
      actual.cleaned = actual.deleted;
    } finally {
      if (!actual.deleted && createdId) {
        try {
          const itemButton = document.querySelector('#adminCalendarGrid [data-admin-calendar-item-id="' + CSS.escape(createdId) + '"]');
          itemButton?.click();
          await waitFor(() => String(document.getElementById('calendarItemId')?.value || '') === createdId, 3000);
          await withAutoConfirm(async () => {
            document.getElementById('deleteCalendarItemButton')?.click();
            actual.cleaned = Boolean(await waitFor(() => !String(document.getElementById('calendarItemId')?.value || ''), 12000));
          });
        } catch {}
      }
      closeEditorModalById('calendarEditorModal');
    }

    const ok = actual.created && actual.updated && actual.deleted && actual.cleaned;
    return ok
      ? pass('已透過管理端 UI 完成日曆項目新增、修改、刪除，QA 資料已清理。', { created: true, updated: true, deleted: true, cleaned: true }, actual)
      : fail('日曆 CRUD E2E 至少一個階段失敗。', { created: true, updated: true, deleted: true, cleaned: true }, actual);
  }

  async function adminBookingCrudCase() {
    const stamp = qaCrudStamp();
    const typeCreated = 'E2E類型' + stamp;
    const typeUpdated = typeCreated + '改';
    const serviceCreated = 'E2E預約' + stamp;
    const serviceUpdated = serviceCreated + '改';
    const actual = {
      typeCreated: false, typeUpdated: false, serviceCreated: false,
      serviceUpdated: false, serviceDeleted: false, typeDeleted: false, cleaned: false
    };

    const tab = await waitFor(() => document.getElementById('bookingTab'), 6000);
    if (!tab) return fail('預約管理分頁未載入。', { bookingTab: true }, { bookingTab: false });
    tab.click();
    document.getElementById('bookingAdminServicesSubtab')?.click();
    await waitFor(() => !document.getElementById('bookingAdminServicesPanel')?.classList.contains('hidden'), 4000);
    if (!await waitBookingAdminReady()) {
      return fail('預約管理資料尚未同步完成。', { bookingAdminReady: true }, { bookingAdminReady: false });
    }

    try {
      document.getElementById('bookingAdminNewTypeButton')?.click();
      let modal = await waitFor(() => {
        const node = document.getElementById('bookingAdminCrudModal');
        return node && !node.classList.contains('hidden') ? node : null;
      }, 4000);
      if (!modal) throw new Error('新增預約類型視窗未開啟。');
      const typeInput = modal.querySelector('[data-type-name]');
      if (!typeInput) throw new Error('預約類型名稱欄位不存在。');
      typeInput.value = typeCreated;
      typeInput.dispatchEvent(new Event('input', { bubbles: true }));
      modal.querySelector('form button[type="submit"]')?.click();
      actual.typeCreated = Boolean(await waitFor(() => findBookingRow('bookingAdminTypeList', typeCreated), 15000));
      if (actual.typeCreated) { await waitBookingAdminReady(15000); await wait(120); }

      if (actual.typeCreated && clickBookingRowAction('bookingAdminTypeList', typeCreated, '修改')) {
        modal = await waitFor(() => {
          const node = document.getElementById('bookingAdminCrudModal');
          return node && !node.classList.contains('hidden') ? node : null;
        }, 4000);
        const editInput = modal?.querySelector('[data-type-name]');
        if (editInput) {
          editInput.value = typeUpdated;
          editInput.dispatchEvent(new Event('input', { bubbles: true }));
          modal.querySelector('form button[type="submit"]')?.click();
          actual.typeUpdated = Boolean(await waitFor(() => findBookingRow('bookingAdminTypeList', typeUpdated), 15000));
          if (actual.typeUpdated) { await waitBookingAdminReady(15000); await wait(120); }
        }
      }

      if (actual.typeUpdated) {
        document.getElementById('bookingAdminNewServiceButton')?.click();
        modal = await waitFor(() => {
          const node = document.getElementById('bookingAdminCrudModal');
          return node && !node.classList.contains('hidden') ? node : null;
        }, 4000);
        const form = modal?.querySelector('form');
        if (!form) throw new Error('新增預約項目表單未開啟。');
        const title = form.querySelector('[data-field="title"]');
        const type = form.querySelector('[data-field="serviceType"]');
        const duration = form.querySelector('[data-field="durationMinutes"]');
        const price = form.querySelector('[data-field="priceAmount"]');
        if (!title || !type || !duration || !price) throw new Error('預約項目表單欄位不完整。');
        title.value = serviceCreated;
        type.value = typeUpdated;
        duration.value = '35';
        price.value = '123';
        [title, type, duration, price].forEach((input) => input.dispatchEvent(new Event('change', { bubbles: true })));
        form.querySelector('button[type="submit"]')?.click();
        actual.serviceCreated = Boolean(await waitFor(() => findBookingRow('bookingAdminServiceList', serviceCreated), 15000));
        if (actual.serviceCreated) { await waitBookingAdminReady(15000); await wait(120); }
      }

      if (actual.serviceCreated && clickBookingRowAction('bookingAdminServiceList', serviceCreated, '修改')) {
        modal = await waitFor(() => {
          const node = document.getElementById('bookingAdminCrudModal');
          return node && !node.classList.contains('hidden') ? node : null;
        }, 4000);
        const form = modal?.querySelector('form');
        const title = form?.querySelector('[data-field="title"]');
        const duration = form?.querySelector('[data-field="durationMinutes"]');
        if (title && duration) {
          title.value = serviceUpdated;
          duration.value = '40';
          title.dispatchEvent(new Event('input', { bubbles: true }));
          duration.dispatchEvent(new Event('change', { bubbles: true }));
          form.querySelector('button[type="submit"]')?.click();
          actual.serviceUpdated = Boolean(await waitFor(() => findBookingRow('bookingAdminServiceList', serviceUpdated), 15000));
          if (actual.serviceUpdated) { await waitBookingAdminReady(15000); await wait(120); }
        }
      }

      if (actual.serviceUpdated) {
        await withAutoConfirm(async () => {
          clickBookingRowAction('bookingAdminServiceList', serviceUpdated, '刪除');
          actual.serviceDeleted = Boolean(await waitFor(() => !findBookingRow('bookingAdminServiceList', serviceUpdated), 15000));
        });
        if (actual.serviceDeleted) { await waitBookingAdminReady(15000); await wait(120); }
      }

      if (actual.typeUpdated) {
        await withAutoConfirm(async () => {
          clickBookingRowAction('bookingAdminTypeList', typeUpdated, '刪除');
          actual.typeDeleted = Boolean(await waitFor(() => !findBookingRow('bookingAdminTypeList', typeUpdated), 15000));
        });
      }
      actual.cleaned = actual.serviceDeleted && actual.typeDeleted;
    } finally {
      document.getElementById('bookingAdminCrudModalClose')?.click();
      if (!actual.serviceDeleted) {
        for (const title of [serviceUpdated, serviceCreated]) {
          if (!findBookingRow('bookingAdminServiceList', title)) continue;
          try {
            await withAutoConfirm(async () => {
              clickBookingRowAction('bookingAdminServiceList', title, '刪除');
              await waitFor(() => !findBookingRow('bookingAdminServiceList', title), 12000);
            });
          } catch {}
        }
      }
      if (!actual.typeDeleted) {
        for (const title of [typeUpdated, typeCreated]) {
          if (!findBookingRow('bookingAdminTypeList', title)) continue;
          try {
            await withAutoConfirm(async () => {
              clickBookingRowAction('bookingAdminTypeList', title, '刪除');
              await waitFor(() => !findBookingRow('bookingAdminTypeList', title), 12000);
            });
          } catch {}
        }
      }
      actual.cleaned = !findBookingRow('bookingAdminServiceList', serviceUpdated) &&
        !findBookingRow('bookingAdminServiceList', serviceCreated) &&
        !findBookingRow('bookingAdminTypeList', typeUpdated) &&
        !findBookingRow('bookingAdminTypeList', typeCreated);
    }

    const ok = actual.typeCreated && actual.typeUpdated && actual.serviceCreated && actual.serviceUpdated &&
      actual.serviceDeleted && actual.typeDeleted && actual.cleaned;
    return ok
      ? pass('已透過管理端 UI 完成預約類型與預約項目的新增、修改、刪除，QA 資料已清理。', {
          typeCreated: true, typeUpdated: true, serviceCreated: true, serviceUpdated: true,
          serviceDeleted: true, typeDeleted: true, cleaned: true
        }, actual)
      : fail('預約 CRUD E2E 至少一個階段失敗。', {
          typeCreated: true, typeUpdated: true, serviceCreated: true, serviceUpdated: true,
          serviceDeleted: true, typeDeleted: true, cleaned: true
        }, actual);
  }


  async function adminBookingControlsCase() {
    const tab = await waitFor(() => document.getElementById('bookingTab'), 6000);
    if (!tab) return fail('預約管理分頁未載入。', { bookingTab: true }, { bookingTab: false });
    tab.click();
    const subtabs = [
      ['bookingAdminTechniciansSubtab', 'bookingAdminTechniciansPanel'],
      ['bookingAdminServicesSubtab', 'bookingAdminServicesPanel'],
      ['bookingAdminSettingsSubtab', 'bookingAdminSettingsPanel'],
      ['bookingAdminQueueSubtab', 'bookingAdminQueuePanel']
    ];
    const actual = {};
    for (const [id, panelId] of subtabs) {
      document.getElementById(id)?.click();
      actual[id] = Boolean(await waitFor(() => !document.getElementById(panelId)?.classList.contains('hidden'), 2500));
    }

    document.getElementById('bookingAdminServicesSubtab')?.click();
    actual.servicesReady = Boolean(await waitBookingAdminReady(15000));
    if (actual.servicesReady) {
      // Fixture 會建立服務類型；等實際列表完成 render，避免 state.catalog 尚未載入時
      // 「新增預約項目」因 serviceTypes 為空而只跳 alert。
      await waitFor(() => document.getElementById('bookingAdminTypeList')?.children.length > 0, 10000);
    }
    for (const [key, buttonId] of [['newType', 'bookingAdminNewTypeButton'], ['newService', 'bookingAdminNewServiceButton']]) {
      document.getElementById(buttonId)?.click();
      const opened = Boolean(await waitFor(() => !document.getElementById('bookingAdminCrudModal')?.classList.contains('hidden'), 3000));
      actual[key] = opened;
      document.getElementById('bookingAdminCrudModalClose')?.click();
      await waitFor(() => document.getElementById('bookingAdminCrudModal')?.classList.contains('hidden'), 2500);
    }

    document.getElementById('bookingAdminQueueSubtab')?.click();
    actual.bookingQueueReady = Boolean(await waitFor(() => !document.getElementById('bookingAdminQueuePanel')?.classList.contains('hidden'), 4000));
    const statusTabs = [
      ['pending', () => document.querySelector('[data-booking-filter="pending"]'), false],
      ['confirmed', () => document.querySelector('[data-booking-filter="confirmed"]'), false],
      ['cancellationRequest', () => document.getElementById('bookingCancellationRequestFilter'), true],
      ['cancelled', () => document.getElementById('bookingCancelledFilter'), true],
      ['completed', () => document.querySelector('[data-booking-filter="completed"]'), false],
      ['no_show', () => document.querySelector('[data-booking-filter="no_show"]'), false],
      ['all', () => document.querySelector('[data-booking-filter="all"]'), false]
    ];
    for (const [key, getButton, cancellationMode] of statusTabs) {
      const button = await waitFor(getButton, 6000);
      if (!button) {
        actual['status_' + key] = false;
        continue;
      }
      button.click();
      actual['status_' + key] = Boolean(await waitFor(() => {
        const coreQueue = document.getElementById('bookingAdminQueue');
        const review = document.getElementById('bookingCancellationReview');
        if (!button.classList.contains('active')) return false;
        if (cancellationMode) {
          return Boolean(review && !review.classList.contains('hidden') && coreQueue?.classList.contains('hidden'));
        }
        return Boolean(coreQueue && !coreQueue.classList.contains('hidden') && (!review || review.classList.contains('hidden')));
      }, 5000));
    }

    const ok = Object.values(actual).every(Boolean);
    return ok
      ? pass('預約管理四個子分頁、新增視窗與待確認／已確認／取消申請／已取消／已完成／無故未到／全部七個狀態分頁皆可真人操作。', {
          allBookingControls: true,
          allBookingStatusTabs: true
        }, actual)
      : fail('至少一個預約管理控制或狀態分頁異常。', {
          allBookingControls: true,
          allBookingStatusTabs: true
        }, actual);
  }

  async function adminBookingSharedSettingsCase() {
    document.getElementById('bookingTab')?.click();
    const ready = await waitBookingAdminReady(15000);
    document.getElementById('bookingAdminSettingsSubtab')?.click();
    const panelVisible = Boolean(await waitFor(() => {
      const panel = document.getElementById('bookingAdminSettingsPanel');
      return panel && !panel.classList.contains('hidden') ? panel : null;
    }, 4000));

    const ids = [
      'bookingAdminSettingsForm',
      'bookingAdminStartTime',
      'bookingAdminEndTime',
      'bookingAdminSlotInterval',
      'bookingAdminAdvanceDays',
      'bookingAdminMaxAdvanceDays',
      'bookingAdminStoreServiceMinutes',
      'bookingAdminReminderEnabled',
      'bookingAdminReminderTime',
      'bookingAdminNotice',
      'bookingAdminSettingsMessage',
      'bookingAdminSaveSettingsButton'
    ];
    const controls = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    const missing = ids.filter((id) => !controls[id]);
    const actual = {
      ready,
      panelVisible,
      missing,
      bootstrapMatched: false,
      invalidWorkHoursRejected: false,
      invalidSlotIntervalRejected: false,
      invalidAdvanceRejected: false,
      invalidStoreMinutesRejected: false,
      invalidReminderRejected: false,
      invalidNoticeRejected: false,
      userWatcherPrepared: false,
      userBaselineMatched: false,
      validMutationSaved: false,
      overnightSettingsSaved: false,
      reminderSettingsSaved: false,
      mutatedReadback: false,
      updatedAtChanged: false,
      staleVersionRejected: false,
      userRealtimeSettingsSynced: false,
      userRealtimeNoticeSynced: false,
      userBootstrapMatched: false,
      userStoreMinutesMatched: false,
      userDateWindowEnforced: false,
      userDateWindowProbe: null,
      finalMutationReadback: false,
      mutationRetainedForInspection: false,
      retainedSettings: null,
      clientSessionRestored: false
    };
    if (!ready || !panelVisible || missing.length) {
      return fail('預約共用設定控制項未完整載入。', {
        ready: true, panelVisible: true, missing: []
      }, actual);
    }

    const STORE_SERVICE_ID = '00000000-0000-4000-8000-000000000010';
    const session = await adminSession();
    const before = await postFunction('booking-admin-api', {
      action: 'admin.booking.manage.bootstrap',
      clientType: 'admin',
      idToken: session.idToken
    });
    const snapshot = {
      workStartTime: String(controls.bookingAdminStartTime.value || ''),
      workEndTime: String(controls.bookingAdminEndTime.value || ''),
      slotIntervalMinutes: Number(controls.bookingAdminSlotInterval.value),
      minAdvanceDays: Number(controls.bookingAdminAdvanceDays.value),
      maxAdvanceDays: Number(controls.bookingAdminMaxAdvanceDays.value),
      storeServiceMinutes: Number(controls.bookingAdminStoreServiceMinutes.value),
      reminderEnabled: controls.bookingAdminReminderEnabled.checked === true,
      reminderTime: String(controls.bookingAdminReminderTime.value || ''),
      bookingNotice: String(controls.bookingAdminNotice.value || ''),
      updatedAt: String(before?.settings?.updatedAt || '')
    };
    const semanticSettings = (settings) => ({
      workStartTime: String(settings?.workStartTime || ''),
      workEndTime: String(settings?.workEndTime || ''),
      slotIntervalMinutes: Number(settings?.slotIntervalMinutes),
      minAdvanceDays: Number(settings?.minAdvanceDays),
      maxAdvanceDays: Number(settings?.maxAdvanceDays),
      storeServiceMinutes: Number(settings?.storeServiceMinutes),
      reminderEnabled: settings?.reminderEnabled === true,
      reminderTime: String(settings?.reminderTime || ''),
      bookingNotice: String(settings?.bookingNotice || '')
    });
    const sameSettings = (settings, expected) => {
      const normalized = semanticSettings(settings);
      return normalized.workStartTime === expected.workStartTime &&
        normalized.workEndTime === expected.workEndTime &&
        normalized.slotIntervalMinutes === expected.slotIntervalMinutes &&
        normalized.minAdvanceDays === expected.minAdvanceDays &&
        normalized.maxAdvanceDays === expected.maxAdvanceDays &&
        normalized.storeServiceMinutes === expected.storeServiceMinutes &&
        normalized.reminderEnabled === expected.reminderEnabled &&
        normalized.reminderTime === expected.reminderTime &&
        normalized.bookingNotice === expected.bookingNotice;
    };
    const setSettingsFields = (settings) => {
      setField('bookingAdminStartTime', settings.workStartTime);
      setField('bookingAdminEndTime', settings.workEndTime);
      setField('bookingAdminSlotInterval', String(settings.slotIntervalMinutes));
      setField('bookingAdminAdvanceDays', String(settings.minAdvanceDays));
      setField('bookingAdminMaxAdvanceDays', String(settings.maxAdvanceDays));
      setField('bookingAdminStoreServiceMinutes', String(settings.storeServiceMinutes));
      controls.bookingAdminReminderEnabled.checked = settings.reminderEnabled === true;
      setField('bookingAdminReminderTime', settings.reminderTime);
      setField('bookingAdminNotice', settings.bookingNotice);
    };
    const addIsoDays = (dateText, days) => {
      const date = new Date(String(dateText || '') + 'T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + Number(days || 0));
      return date.toISOString().slice(0, 10);
    };
    const childNoticeText = (child) => {
      try {
        const card = child?.document?.querySelector('.booking-card[aria-labelledby="bookingTitle"]');
        if (!card) return '';
        const notice = Array.from(card.children || []).find((node) =>
          node.classList?.contains('service-info') && node.getAttribute('role') === 'note'
        );
        return String(notice?.textContent || '').trim();
      } catch {
        return '';
      }
    };
    actual.bootstrapMatched = sameSettings(before?.settings, snapshot);

    const workCandidates = [
      ['14:00', '02:00'],
      ['15:30', '03:00'],
      ['18:00', '01:30']
    ];
    const selectedHours = workCandidates.find(([startTime, endTime]) =>
      startTime !== snapshot.workStartTime || endTime !== snapshot.workEndTime
    ) || ['08:00', '20:00'];
    const mutatedMin = snapshot.minAdvanceDays >= 365
      ? 364
      : Math.max(1, snapshot.minAdvanceDays + 1);
    let mutatedMax;
    if (snapshot.maxAdvanceDays <= 0) {
      mutatedMax = Math.min(365, Math.max(mutatedMin + 7, 30));
    } else if (snapshot.maxAdvanceDays >= 365) {
      mutatedMax = Math.max(mutatedMin, 364);
    } else {
      mutatedMax = Math.max(mutatedMin, snapshot.maxAdvanceDays + 1);
    }
    if (mutatedMax === snapshot.maxAdvanceDays) {
      mutatedMax = mutatedMax < 365 ? mutatedMax + 1 : Math.max(mutatedMin, mutatedMax - 1);
    }
    const mutatedStoreMinutes = snapshot.storeServiceMinutes <= 705
      ? snapshot.storeServiceMinutes + 15
      : Math.max(1, snapshot.storeServiceMinutes - 15);
    const reminderCandidates = ['17:30', '19:15', '08:45'];
    const mutatedReminderTime = reminderCandidates.find((value) => value !== snapshot.reminderTime) || '18:30';
    const qaMarker = '[QA E2E SHARED ' + qaCrudStamp() + ']';
    const retainedBaseNotice = String(snapshot.bookingNotice || '')
      .replace(/^(?:\[QA E2E SHARED [^\]]+\]\s*)+/g, '')
      .trim();
    const noticeSuffix = retainedBaseNotice ? '\n' + retainedBaseNotice : '';
    const mutation = {
      workStartTime: selectedHours[0],
      workEndTime: selectedHours[1],
      slotIntervalMinutes: snapshot.slotIntervalMinutes === 30 ? 15 : 30,
      minAdvanceDays: mutatedMin,
      maxAdvanceDays: mutatedMax,
      storeServiceMinutes: mutatedStoreMinutes,
      reminderEnabled: !snapshot.reminderEnabled,
      reminderTime: mutatedReminderTime,
      bookingNotice: (qaMarker + noticeSuffix).slice(0, 2000)
    };
    actual.retainedSettings = safe(mutation);

    let participant = null;
    let child = null;
    let previousLogin = null;
    let previousSurface = '';
    let userToday = '';

    try {
      setField('bookingAdminStartTime', '10:00');
      setField('bookingAdminEndTime', '10:00');
      controls.bookingAdminSaveSettingsButton.click();
      actual.invalidWorkHoursRejected = Boolean(await waitFor(() =>
        /工作時間格式錯誤或時段長度為零/.test(String(controls.bookingAdminSettingsMessage.textContent || '')),
        8000,
        100
      ));

      setField('bookingAdminStartTime', snapshot.workStartTime);
      setField('bookingAdminEndTime', snapshot.workEndTime);
      setField('bookingAdminSlotInterval', String(snapshot.slotIntervalMinutes));
      setField('bookingAdminSlotInterval', '0');
      controls.bookingAdminSaveSettingsButton.click();
      actual.invalidSlotIntervalRejected = Boolean(await waitFor(() =>
        /切分間隔須為 5–120 分鐘/.test(String(controls.bookingAdminSettingsMessage.textContent || '')),
        2000,
        80
      ));
      setField('bookingAdminSlotInterval', String(snapshot.slotIntervalMinutes));
      setField('bookingAdminAdvanceDays', '5');
      setField('bookingAdminMaxAdvanceDays', '4');
      controls.bookingAdminSaveSettingsButton.click();
      actual.invalidAdvanceRejected = Boolean(await waitFor(() =>
        /最遠可預約天數不可小於需要提前的天數/.test(String(controls.bookingAdminSettingsMessage.textContent || '')),
        2000,
        80
      ));

      setField('bookingAdminAdvanceDays', String(snapshot.minAdvanceDays));
      setField('bookingAdminMaxAdvanceDays', String(snapshot.maxAdvanceDays));
      setField('bookingAdminStoreServiceMinutes', '0');
      controls.bookingAdminSaveSettingsButton.click();
      actual.invalidStoreMinutesRejected = Boolean(await waitFor(() =>
        /店內服務分鐘必須介於 1–720 分鐘/.test(String(controls.bookingAdminSettingsMessage.textContent || '')),
        2000,
        80
      ));

      setField('bookingAdminStoreServiceMinutes', String(snapshot.storeServiceMinutes));
      setField('bookingAdminReminderTime', '');
      controls.bookingAdminSaveSettingsButton.click();
      actual.invalidReminderRejected = Boolean(await waitFor(() =>
        /有效的前一天提醒時間/.test(String(controls.bookingAdminSettingsMessage.textContent || '')),
        2000,
        80
      ));

      setField('bookingAdminReminderTime', snapshot.reminderTime);
      setField('bookingAdminNotice', 'X'.repeat(2001));
      controls.bookingAdminSaveSettingsButton.click();
      actual.invalidNoticeRejected = Boolean(await waitFor(() =>
        /預約說明不可超過 2,000 字/.test(String(controls.bookingAdminSettingsMessage.textContent || '')),
        2000,
        80
      ));

      setSettingsFields(snapshot);

      participant = state.participants.find((item) =>
        item?.account?.memberId && item?.window && !item.window.closed
      ) || null;
      if (participant) {
        previousLogin = participant.login || null;
        previousSurface = participant.lastSurfaceKey || 'member';
        const bookingLogin = reusablePairedSession(participant, 'booking') ||
          await createPairedSession(participant.account, 'booking');
        participant.surfaceLogins = participant.surfaceLogins || {};
        participant.surfaceLogins.booking = bookingLogin;
        participant.login = bookingLogin;
        participant.lastSurfaceKey = 'booking';
        seedParticipantSession(participant, bookingLogin, 'booking');
        child = await waitParticipantSurface(participant, 'booking', 'bookingView');
        actual.userWatcherPrepared = Boolean(child && child.BookingSystem && child.MemberClientQaHooks);
        if (actual.userWatcherPrepared) {
          const config = await child.BookingSystem.loadConfig();
          const baseline = await child.BookingSystem.request(config, 'member', '', 'user.booking.bootstrap', {});
          userToday = String(baseline?.today || '');
          const baselineStore = (baseline?.services || []).find((service) => String(service?.serviceId || '') === STORE_SERVICE_ID);
          actual.userBaselineMatched =
            String(baseline?.settings?.workStartTime || '') === snapshot.workStartTime &&
            String(baseline?.settings?.workEndTime || '') === snapshot.workEndTime &&
            Number(baseline?.settings?.slotIntervalMinutes) === snapshot.slotIntervalMinutes &&
            Number(baseline?.settings?.minAdvanceDays) === snapshot.minAdvanceDays &&
            Number(baseline?.settings?.maxAdvanceDays) === snapshot.maxAdvanceDays &&
            Number(baselineStore?.durationMinutes) === snapshot.storeServiceMinutes;
        }
      }

      setSettingsFields(mutation);
      controls.bookingAdminSaveSettingsButton.click();
      actual.validMutationSaved = Boolean(await waitFor(() =>
        /預約(?:與票券)?共用設定已儲存/.test(String(controls.bookingAdminSettingsMessage.textContent || '')),
        15000,
        100
      ));

      const mutated = await postFunction('booking-admin-api', {
        action: 'admin.booking.manage.bootstrap',
        clientType: 'admin',
        idToken: session.idToken
      });
      actual.mutatedReadback = sameSettings(mutated?.settings, mutation);
      actual.overnightSettingsSaved = mutation.workEndTime < mutation.workStartTime &&
        String(mutated?.settings?.workStartTime || '') === mutation.workStartTime &&
        String(mutated?.settings?.workEndTime || '') === mutation.workEndTime;
      actual.reminderSettingsSaved = mutated?.settings?.reminderEnabled === mutation.reminderEnabled &&
        String(mutated?.settings?.reminderTime || '') === mutation.reminderTime;
      actual.updatedAtChanged = Boolean(
        snapshot.updatedAt &&
        mutated?.settings?.updatedAt &&
        String(mutated.settings.updatedAt) !== snapshot.updatedAt
      );

      if (actual.mutatedReadback && actual.updatedAtChanged) {
        try {
          await postFunction('booking-admin-api', {
            action: 'admin.booking.settings.save',
            clientType: 'admin',
            idToken: session.idToken,
            workStartTime: mutation.workStartTime,
            workEndTime: mutation.workEndTime,
            slotIntervalMinutes: mutation.slotIntervalMinutes,
            minAdvanceDays: mutation.minAdvanceDays,
            maxAdvanceDays: mutation.maxAdvanceDays,
            storeServiceMinutes: mutation.storeServiceMinutes,
            reminderEnabled: mutation.reminderEnabled,
            reminderTime: mutation.reminderTime,
            bookingNotice: mutation.bookingNotice,
            snapshotLocations: before?.settings?.snapshotLocations || [],
            snapshotLocationRequired: before?.settings?.snapshotLocationRequired === true,
            expectedUpdatedAt: snapshot.updatedAt
          });
        } catch (error) {
          actual.staleVersionRejected = String(error?.code || '') === 'BOOKING_SETTINGS_CONFLICT';
        }
      }

      if (child && actual.userWatcherPrepared) {
        const userBaseDate = userToday || new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date());
        const expectedMinDate = addIsoDays(userBaseDate, mutation.minAdvanceDays);
        const expectedMaxDate = addIsoDays(userBaseDate, mutation.maxAdvanceDays);
        actual.userRealtimeSettingsSynced = Boolean(await waitFor(() => {
          try {
            const badge = String(child.document.getElementById('workHoursBadge')?.textContent || '');
            const dateInput = child.document.getElementById('bookingDate');
            return badge.includes(mutation.workStartTime + '–' + mutation.workEndTime) &&
              badge.includes('提前 ' + mutation.minAdvanceDays + ' 天') &&
              badge.includes('可預約 ' + mutation.maxAdvanceDays + ' 天內') &&
              String(dateInput?.min || '') === expectedMinDate &&
              String(dateInput?.max || '') === expectedMaxDate;
          } catch {
            return false;
          }
        }, backgroundAwareTimeout(15000, 45000), 150));
        actual.userRealtimeNoticeSynced = Boolean(await waitFor(() =>
          childNoticeText(child).includes(qaMarker),
          backgroundAwareTimeout(15000, 45000),
          150
        ));

        const config = await child.BookingSystem.loadConfig();
        const userData = await child.BookingSystem.request(config, 'member', '', 'user.booking.bootstrap', {});
        const userStore = (userData?.services || []).find((service) => String(service?.serviceId || '') === STORE_SERVICE_ID);
        actual.userBootstrapMatched =
          String(userData?.settings?.workStartTime || '') === mutation.workStartTime &&
          String(userData?.settings?.workEndTime || '') === mutation.workEndTime &&
          Number(userData?.settings?.minAdvanceDays) === mutation.minAdvanceDays &&
          Number(userData?.settings?.maxAdvanceDays) === mutation.maxAdvanceDays;
        actual.userBootstrapMatched = actual.userBootstrapMatched && Number(userData?.settings?.slotIntervalMinutes) === mutation.slotIntervalMinutes;
        actual.userStoreMinutesMatched = Number(userStore?.durationMinutes) === mutation.storeServiceMinutes;

        const normalService = (userData?.services || []).find((service) =>
          String(service?.serviceId || '') !== STORE_SERVICE_ID &&
          service?.isActive !== false &&
          service?.requiresCompanionService !== true
        );
        const primaryTechnicianId = String(userData?.settings?.primaryTechnicianId || '');
        const bookingToken = String(participant?.surfaceLogins?.booking?.testSessionToken || '');
        if (normalService?.serviceId && userData?.today && primaryTechnicianId && bookingToken) {
          const tooEarlyDate = addIsoDays(userData.today, mutation.minAdvanceDays - 1);
          const tooFarDate = addIsoDays(userData.today, mutation.maxAdvanceDays + 1);
          const probe = (bookingDate) => postFunction('booking-group-slots-api', {
            action: 'user.booking.group.slots', clientType: 'member', idToken: '',
            testSessionToken: bookingToken, bookingDate,
            participants: [{
              technicianId: primaryTechnicianId,
              items: [{ serviceId: normalService.serviceId, quantity: 1 }]
            }]
          });
          const [tooEarly, tooFar] = await Promise.all([
            probe(tooEarlyDate), probe(tooFarDate)
          ]);
          const earliestExpected = addIsoDays(userData.today, mutation.minAdvanceDays);
          const latestExpected = addIsoDays(userData.today, mutation.maxAdvanceDays);
          actual.userDateWindowProbe = {
            endpoint: 'booking-group-slots-api',
            tooEarly: { date: tooEarlyDate, slots: Array.isArray(tooEarly?.slots) ? tooEarly.slots.length : null,
              earliestBookingDate: String(tooEarly?.earliestBookingDate || ''), latestBookingDate: String(tooEarly?.latestBookingDate || '') },
            tooFar: { date: tooFarDate, slots: Array.isArray(tooFar?.slots) ? tooFar.slots.length : null,
              earliestBookingDate: String(tooFar?.earliestBookingDate || ''), latestBookingDate: String(tooFar?.latestBookingDate || '') },
            expected: { earliestBookingDate: earliestExpected, latestBookingDate: latestExpected }
          };
          actual.userDateWindowEnforced =
            Array.isArray(tooEarly?.slots) && tooEarly.slots.length === 0 &&
            String(tooEarly?.earliestBookingDate || '') === earliestExpected &&
            String(tooEarly?.latestBookingDate || '') === latestExpected &&
            Array.isArray(tooFar?.slots) && tooFar.slots.length === 0 &&
            String(tooFar?.earliestBookingDate || '') === earliestExpected &&
            String(tooFar?.latestBookingDate || '') === latestExpected;
        } else {
          actual.userDateWindowProbe = {
            endpoint: 'booking-group-slots-api',
            missingService: !normalService?.serviceId,
            missingToday: !userData?.today,
            missingPrimaryTechnician: !primaryTechnicianId,
            missingBookingSession: !bookingToken
          };
        }
      }

      const finalSettings = await postFunction('booking-admin-api', {
        action: 'admin.booking.manage.bootstrap',
        clientType: 'admin',
        idToken: session.idToken
      });
      actual.finalMutationReadback = sameSettings(finalSettings?.settings, mutation);
      actual.mutationRetainedForInspection = actual.finalMutationReadback;
      if (actual.validMutationSaved) setSettingsFields(mutation);

      if (participant) {
        try {
          if (previousLogin) {
            participant.login = previousLogin;
            participant.lastSurfaceKey = previousSurface || 'member';
            seedParticipantSession(participant, previousLogin, previousSurface || 'member');
            navigateParticipant(participant, previousSurface || 'member');
          }
          actual.clientSessionRestored = true;
        } catch {
          actual.clientSessionRestored = false;
        }
      }
    } finally {
      // 預約共用設定是測試觀察資料：成功寫入後保留 E2E 修改值，不做 UI 或 API 還原。
      if (actual.validMutationSaved) setSettingsFields(mutation);
      if (participant && !actual.clientSessionRestored) {
        try {
          if (previousLogin) {
            participant.login = previousLogin;
            participant.lastSurfaceKey = previousSurface || 'member';
            seedParticipantSession(participant, previousLogin, previousSurface || 'member');
            navigateParticipant(participant, previousSurface || 'member');
          }
          actual.clientSessionRestored = true;
        } catch {}
      }
    }

    const ok = actual.ready && actual.panelVisible && actual.missing.length === 0 &&
      actual.bootstrapMatched &&
      actual.invalidWorkHoursRejected &&
      actual.invalidSlotIntervalRejected &&
      actual.invalidAdvanceRejected &&
      actual.invalidStoreMinutesRejected &&
      actual.invalidReminderRejected &&
      actual.invalidNoticeRejected &&
      actual.userWatcherPrepared &&
      actual.userBaselineMatched &&
      actual.validMutationSaved &&
      actual.overnightSettingsSaved &&
      actual.reminderSettingsSaved &&
      actual.mutatedReadback &&
      actual.updatedAtChanged &&
      actual.staleVersionRejected &&
      actual.userRealtimeSettingsSynced &&
      actual.userRealtimeNoticeSynced &&
      actual.userBootstrapMatched &&
      actual.userStoreMinutesMatched &&
      actual.userDateWindowEnforced &&
      actual.finalMutationReadback &&
      actual.mutationRetainedForInspection &&
      actual.clientSessionRestored;

    return ok
      ? pass('預約共用設定已完成非法邊界、合法變更、版本衝突、管理端回讀、用戶端 Realtime／日期範圍同步，並保留本輪修改值供測試人員檢視。', {
          invalidWorkHoursRejected: true,
          invalidAdvanceRejected: true,
          invalidStoreMinutesRejected: true,
          invalidNoticeRejected: true,
          validMutationSaved: true,
          mutatedReadback: true,
          staleVersionRejected: true,
          userRealtimeSettingsSynced: true,
          userRealtimeNoticeSynced: true,
          userDateWindowEnforced: true,
          finalMutationReadback: true,
          mutationRetainedForInspection: true
        }, actual)
      : fail('預約共用設定複雜 E2E 至少一個驗證、跨端同步、競態或保留修改驗證失敗；已成功寫入的修改值不會自動還原。', {
          invalidWorkHoursRejected: true,
          invalidAdvanceRejected: true,
          invalidStoreMinutesRejected: true,
          invalidNoticeRejected: true,
          validMutationSaved: true,
          mutatedReadback: true,
          staleVersionRejected: true,
          userRealtimeSettingsSynced: true,
          userRealtimeNoticeSynced: true,
          userDateWindowEnforced: true,
          finalMutationReadback: true,
          mutationRetainedForInspection: true
        }, actual);
  }

  function adminBookingBootstrapIntervalMs() {
    const participantCount = Math.max(1, Number(state.participants?.length || 1));
    return Math.max(
      ADMIN_BOOKING_BOOTSTRAP_BASE_INTERVAL_MS,
      Math.min(
        ADMIN_BOOKING_BOOTSTRAP_MAX_INTERVAL_MS,
        ADMIN_BOOKING_BOOTSTRAP_BASE_INTERVAL_MS + (participantCount - 1) * 500
      )
    );
  }

  async function adminBookingBootstrapSnapshot() {
    const now = Date.now();
    const minIntervalMs = adminBookingBootstrapIntervalMs();
    if (adminBookingBootstrapLastData
        && now - adminBookingBootstrapLastAt < minIntervalMs
        && now >= adminBookingBootstrapBackoffUntil) {
      return adminBookingBootstrapLastData;
    }
    if (adminBookingBootstrapInFlight) return adminBookingBootstrapInFlight;

    const waitMs = Math.max(
      0,
      minIntervalMs - (now - adminBookingBootstrapLastAt),
      adminBookingBootstrapBackoffUntil - now
    );
    adminBookingBootstrapInFlight = (async () => {
      if (waitMs > 0) await sleep(waitMs);
      const request = async () => {
        const session = await adminSession();
        return postFunction('booking-api', {
          action: 'admin.booking.bootstrap',
          clientType: 'admin',
          idToken: session.idToken
        });
      };
      let data;
      try {
        data = await request();
      } catch (error) {
        if (String(error?.code || '') !== 'RATE_LIMITED') throw error;
        const nextBucketAt = (Math.floor(Date.now() / 60000) + 1) * 60000 + randomInt(700, 1700);
        adminBookingBootstrapBackoffUntil = nextBucketAt;
        await sleep(Math.max(0, nextBucketAt - Date.now()));
        data = await request();
      }
      adminBookingBootstrapBackoffUntil = 0;
      adminBookingBootstrapLastData = data;
      adminBookingBootstrapLastAt = Date.now();
      return data;
    })().finally(() => {
      adminBookingBootstrapInFlight = null;
    });

    return adminBookingBootstrapInFlight;
  }

  function bookingCreatedMs(booking) {
    const created = Date.parse(String(booking?.createdAt || ''));
    if (Number.isFinite(created)) return created;
    const updated = Date.parse(String(booking?.updatedAt || ''));
    return Number.isFinite(updated) ? updated : 0;
  }

  function pairedBookingCandidates(data, participant, options = {}) {
    const live = options?.live === true;
    const account = participant?.account || {};
    const memberCode = String(account.memberCode || '');
    const runStartedMs = Date.parse(String(state.runStartedAt || ''));
    const result = participant?.bookingResult;
    const handoff = result?.bookingHandoff;
    if (!account.memberId || !memberCode || !Number.isFinite(runStartedMs)) return [];

    let bookingIds = null;
    if (!live) {
      if (result?.account?.memberId !== account.memberId || handoff?.ready !== true
          || handoff.memberId !== account.memberId || !Array.isArray(handoff.bookingIds)) return [];
      bookingIds = new Set(handoff.bookingIds.map(String).filter(Boolean));
    } else if (handoff?.ready === true && handoff.memberId === account.memberId && Array.isArray(handoff.bookingIds)) {
      bookingIds = new Set(handoff.bookingIds.map(String).filter(Boolean));
    }

    return (Array.isArray(data?.bookings) ? data.bookings : [])
      .filter((booking) => !bookingIds || bookingIds.has(String(booking?.bookingId || '')))
      .filter((booking) => String(booking?.memberCode || '') === memberCode)
      .filter((booking) => String(booking?.memberId || '') === String(account.memberId))
      .filter((booking) => /^(?:QA HUMAN E2E(?: GROUP| BENEFIT)? |QA STATE PACK |QA automated (?:group )?(?:create|update)$)/i.test(String(booking?.memberNote || '')))
      .filter((booking) => bookingCreatedMs(booking) >= runStartedMs - 2 * 60 * 1000)
      .slice()
      .sort((a, b) => bookingCreatedMs(b) - bookingCreatedMs(a));
  }

  function livePairedBookingSet(candidates) {
    const rows = Array.isArray(candidates) ? candidates : [];
    const mutable = rows.find((booking) =>
      /^QA HUMAN E2E GROUP /i.test(String(booking.memberNote || ''))
      && String(booking.status || '') === 'pending'
      && !(booking.cancellationRequestedAt && !booking.cancellationReviewedAt)
    ) || null;
    const rejectTarget = rows.find((booking) =>
      /^QA STATE PACK pending /i.test(String(booking.memberNote || ''))
      && String(booking.status || '') === 'pending'
      && !(booking.cancellationRequestedAt && !booking.cancellationReviewedAt)
      && String(booking.bookingId || '') !== String(mutable?.bookingId || '')
    ) || null;
    const cancellationTarget = rows.find((booking) =>
      /^QA STATE PACK cancel_requested /i.test(String(booking.memberNote || ''))
      && booking.cancellationRequestedAt && !booking.cancellationReviewedAt
      && ['pending', 'confirmed'].includes(String(booking.status || ''))
      && String(booking.bookingId || '') !== String(mutable?.bookingId || '')
      && String(booking.bookingId || '') !== String(rejectTarget?.bookingId || '')
    ) || null;
    return {
      mutable,
      rejectTarget,
      cancellationTarget,
      ready: Boolean(mutable && rejectTarget && cancellationTarget)
    };
  }

  async function waitForLivePairedBookingTarget(participant, targetKey = 'any', timeoutMs = PAIRED_BOOKING_LIVE_TIMEOUT_MS) {
    const deadline = Date.now() + backgroundAwareTimeout(Math.max(5000, Number(timeoutMs) || PAIRED_BOOKING_LIVE_TIMEOUT_MS), 20 * 60 * 1000);
    let candidates = [];
    let detected = livePairedBookingSet(candidates);
    while (Date.now() < deadline) {
      if (state.cancelled) return { booking: null, ...detected, candidates, stopped: true };
      const data = await adminBookingBootstrapSnapshot();
      candidates = pairedBookingCandidates(data, participant, { live: true });
      participant.liveBookingIds = [...new Set([
        ...(Array.isArray(participant.liveBookingIds) ? participant.liveBookingIds : []),
        ...candidates.map((booking) => String(booking?.bookingId || '')).filter(Boolean)
      ])];
      detected = livePairedBookingSet(candidates);
      const booking = targetKey === 'any' ? (candidates[0] || null) : (detected?.[targetKey] || null);
      if (booking) {
        participant.adminStatus = targetKey === 'any'
          ? '管理端已偵測本輪預約'
          : '依資料狀態執行管理員操作';
        renderParticipants();
        return { booking, ...detected, candidates, handoffReady: false };
      }
      const handoff = participant?.bookingResult?.bookingHandoff;
      if (handoff?.ready === true && handoff.memberId === participant?.account?.memberId) {
        return { booking: null, ...detected, candidates, handoffReady: true };
      }
      participant.adminStatus = candidates.length
        ? '已看到預約，等待對應管理動作資料'
        : '等待管理端出現本輪預約';
      renderParticipants();
      await sleep(300);
    }
    return { booking: null, ...detected, candidates, timedOut: true };
  }

  async function waitForLivePairedBookingSet(participant, timeoutMs = PAIRED_BOOKING_LIVE_TIMEOUT_MS) {
    const deadline = Date.now() + backgroundAwareTimeout(Math.max(5000, Number(timeoutMs) || PAIRED_BOOKING_LIVE_TIMEOUT_MS), 20 * 60 * 1000);
    let candidates = [];
    let detected = livePairedBookingSet(candidates);
    while (Date.now() < deadline) {
      if (state.cancelled) return { ...detected, candidates, stopped: true };
      const data = await adminBookingBootstrapSnapshot();
      candidates = pairedBookingCandidates(data, participant, { live: true });
      participant.liveBookingIds = [...new Set([
        ...(Array.isArray(participant.liveBookingIds) ? participant.liveBookingIds : []),
        ...candidates.map((booking) => String(booking?.bookingId || '')).filter(Boolean)
      ])];
      detected = livePairedBookingSet(candidates);
      if (detected.ready) return { ...detected, candidates, handoffReady: false };
      const handoff = participant?.bookingResult?.bookingHandoff;
      if (handoff?.ready === true && handoff.memberId === participant?.account?.memberId) {
        return { ...detected, candidates, handoffReady: true };
      }
      participant.adminStatus = candidates.length
        ? '已看到預約，等待可安全接手狀態'
        : '等待管理端出現本輪預約';
      renderParticipants();
      await sleep(350);
    }
    return { ...detected, candidates, timedOut: true };
  }

  async function waitForPairedBookingHandoff(participant, timeoutMs = PAIRED_BOOKING_LIVE_TIMEOUT_MS) {
    const deadline = Date.now() + backgroundAwareTimeout(Math.max(5000, Number(timeoutMs) || PAIRED_BOOKING_LIVE_TIMEOUT_MS), 20 * 60 * 1000);
    while (Date.now() < deadline) {
      if (state.cancelled) return null;
      const handoff = participant?.bookingResult?.bookingHandoff;
      if (handoff?.ready === true
          && handoff.memberId === participant?.account?.memberId
          && Array.isArray(handoff.bookingIds)) return handoff;
      await sleep(250);
    }
    return null;
  }

  async function waitAdminBookingSnapshot(bookingId, predicate, timeoutMs = 15000) {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 15000);
    let last = null;
    while (Date.now() < deadline) {
      if (state.cancelled) return null;
      const data = await adminBookingBootstrapSnapshot();
      last = (Array.isArray(data?.bookings) ? data.bookings : []).find((booking) => String(booking?.bookingId || '') === String(bookingId || '')) || null;
      if (last && (!predicate || predicate(last))) return last;
      await sleep(750);
    }
    return last;
  }

  async function adminHumanPause(minMs = 90, maxMs = 260) {
    if (state.cancelled) throw new Error('E2E 已停止。');
    await sleep(randomInt(minMs, maxMs));
  }

  async function adminHumanClick(node, label = '控制項') {
    if (!node) throw new Error('找不到可操作的' + label + '。');
    if (node.disabled) throw new Error(label + '目前不可操作。');
    try { node.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch {}
    try { node.focus?.({ preventScroll: true }); } catch { try { node.focus?.(); } catch {} }
    await adminHumanPause(70, 220);
    node.click();
    await adminHumanPause(80, 260);
    return true;
  }

  async function adminHumanSelect(select, value, label = '下拉選單') {
    if (!select) throw new Error('找不到' + label + '。');
    try { select.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch {}
    try { select.focus?.({ preventScroll: true }); } catch { try { select.focus?.(); } catch {} }
    await adminHumanPause(60, 180);
    select.value = String(value ?? '');
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await adminHumanPause(80, 240);
    return true;
  }

  async function adminHumanTextInput(input, value, label = '文字欄位') {
    if (!input) return false;
    try { input.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch {}
    try { input.focus?.({ preventScroll: true }); } catch { try { input.focus?.(); } catch {} }
    await adminHumanPause(50, 150);
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const text = String(value || '');
    const chunks = text.match(/.{1,8}/g) || [''];
    for (const chunk of chunks) {
      input.value += chunk;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await adminHumanPause(18, 55);
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await adminHumanPause(60, 180);
    return true;
  }

  async function openAdminBookingQueue(filter = 'pending') {
    const tab = await waitFor(() => document.getElementById('bookingTab'), 6000);
    if (!tab) throw new Error('預約管理分頁未載入。');
    await adminHumanClick(tab, '預約管理分頁');
    const queueSubtab = await waitFor(() => document.getElementById('bookingAdminQueueSubtab'), 6000);
    await adminHumanClick(queueSubtab, '用戶預約分頁');
    if (!await waitFor(() => !document.getElementById('bookingAdminQueuePanel')?.classList.contains('hidden'), 5000)) {
      throw new Error('用戶預約管理分頁未開啟。');
    }
    if (!await waitBookingAdminReady()) throw new Error('預約管理資料尚未同步完成。');
    const filterButton = await waitFor(() => document.querySelector('[data-booking-filter="' + filter + '"]'), 3000);
    await adminHumanClick(filterButton, '預約狀態篩選');
    await sleep(100);
    return true;
  }

  function bookingActionButton(card, label) {
    return Array.from(card?.querySelectorAll('button') || []).find((button) => String(button.textContent || '').trim() === label) || null;
  }


  async function verifyDetectedBookingInCoreFilter(bookingId, filter) {
    await openAdminBookingQueue(filter);
    const button = document.querySelector('[data-booking-filter="' + filter + '"]');
    const card = await waitFor(() => document.querySelector(
      '#bookingAdminQueue .booking-admin-booking[data-booking-id="' + CSS.escape(String(bookingId || '')) + '"]'
    ), 10000, 100);
    const review = document.getElementById('bookingCancellationReview');
    const actual = {
      bookingId: String(bookingId || ''),
      filter,
      buttonActive: Boolean(button?.classList.contains('active')),
      coreQueueVisible: Boolean(document.getElementById('bookingAdminQueue') && !document.getElementById('bookingAdminQueue').classList.contains('hidden')),
      cancellationReviewHidden: Boolean(!review || review.classList.contains('hidden')),
      bookingVisible: Boolean(card)
    };
    actual.ok = actual.buttonActive && actual.coreQueueVisible && actual.cancellationReviewHidden && actual.bookingVisible;
    return actual;
  }

  async function verifyDetectedBookingInCancellationFilter(bookingId, mode) {
    await openAdminBookingQueue('pending');
    const isCancelled = mode === 'cancelled';
    const buttonId = isCancelled ? 'bookingCancelledFilter' : 'bookingCancellationRequestFilter';
    const button = await waitFor(() => document.getElementById(buttonId), 8000, 100);
    if (!button) {
      return { bookingId: String(bookingId || ''), mode, buttonFound: false, ok: false };
    }
    await adminHumanClick(button, isCancelled ? '已取消分頁' : '取消申請分頁');
    const reviewVisible = Boolean(await waitFor(() => {
      const review = document.getElementById('bookingCancellationReview');
      const coreQueue = document.getElementById('bookingAdminQueue');
      return button.classList.contains('active')
        && review
        && !review.classList.contains('hidden')
        && coreQueue?.classList.contains('hidden');
    }, 6000, 100));
    const card = await waitFor(() => document.querySelector(
      '#bookingCancellationReviewList .booking-admin-booking[data-booking-id="' + CSS.escape(String(bookingId || '')) + '"]'
    ), 12000, 120);
    const actual = {
      bookingId: String(bookingId || ''),
      mode,
      buttonFound: true,
      buttonActive: Boolean(button.classList.contains('active')),
      reviewVisible,
      bookingVisible: Boolean(card)
    };
    actual.ok = actual.buttonActive && actual.reviewVisible && actual.bookingVisible;
    return actual;
  }

  async function mutateDetectedBooking(booking) {
    await openAdminBookingQueue(String(booking?.status || 'pending'));
    const bookingId = String(booking?.bookingId || '');
    const beforeDetails = await detectedBookingGroupDetails(bookingId).catch(() => ({ group: null, primaryTechnicianId: '' }));
    const participants = Array.isArray(beforeDetails.group?.participants) ? beforeDetails.group.participants : [];

    let targetIndex = 0;
    let targetPosition = null;
    let preferredServiceId = '';
    let mutationMode = 'quantity';
    if (participants.length) {
      // Prefer mutations that can only shorten an occupied schedule. If no quantity
      // can be decreased, an unassigned participant may safely grow. As a final
      // safe fallback, remove one of multiple items from an already-assigned
      // participant instead of extending that technician's occupied time.
      targetIndex = participants.findIndex((participant) =>
        (Array.isArray(participant?.items) ? participant.items : [])
          .some((item) => Number(item?.quantity || 0) >= 2)
      );
      if (targetIndex < 0) {
        targetIndex = participants.findIndex((participant) =>
          !participant?.technicianId
          && (Array.isArray(participant?.items) ? participant.items : []).length > 0
        );
      }
      if (targetIndex < 0) {
        targetIndex = participants.findIndex((participant) =>
          (Array.isArray(participant?.items) ? participant.items : []).length >= 2
        );
        if (targetIndex >= 0) mutationMode = 'remove-item';
      }
      if (targetIndex < 0) {
        throw new Error('目前多人預約沒有可安全調整的項目：避免擴張已指定技師的預約時段，且沒有可安全移除的次要項目。');
      }
      const target = participants[targetIndex];
      targetPosition = Number(target?.position || targetIndex + 1);
      const targetItems = Array.isArray(target?.items) ? target.items : [];
      const preferred = targetItems.find((item) => Number(item?.quantity || 0) >= 2)
        || (mutationMode === 'remove-item' ? targetItems[targetItems.length - 1] : targetItems[0])
        || null;
      preferredServiceId = String(preferred?.serviceId || '');
    }

    const card = await waitFor(() => document.querySelector(
      '#bookingAdminQueue .booking-admin-booking[data-booking-id="' + CSS.escape(bookingId) + '"]'
    ), 8000, 100);
    if (!card) throw new Error('管理端找不到要修改的用戶端 E2E 預約。');

    const blocks = typeof card.querySelectorAll === 'function'
      ? Array.from(card.querySelectorAll('.booking-group-admin-participant'))
      : [];
    const candidateBlock = participants.length ? (blocks[targetIndex] || null) : null;
    const targetContainer = participants.length
      ? (candidateBlock && typeof candidateBlock.querySelectorAll === 'function' ? candidateBlock : card)
      : card;
    if (!targetContainer) throw new Error('管理端找不到可安全修改的預約人項目區塊。');
    const editButton = bookingActionButton(targetContainer, '修改此位項目')
      || bookingActionButton(targetContainer, '修改服務項目');
    if (!editButton) throw new Error('這筆預約沒有可供管理端 E2E 操作的修改項目按鈕。');
    await adminHumanClick(editButton, '修改此位項目');

    const modal = await waitFor(() => {
      const node = document.getElementById('bookingAdminCrudModal');
      return node && !node.classList.contains('hidden') ? node : null;
    }, 5000);
    if (!modal) throw new Error('管理端修改預約視窗未開啟。');
    const form = modal.querySelector('form');
    if (!form) throw new Error('管理端修改預約表單不存在。');

    const checkedInputs = typeof form.querySelectorAll === 'function'
      ? Array.from(form.querySelectorAll('input[type="checkbox"]:checked'))
      : [form.querySelector('input[type="checkbox"]:checked')].filter(Boolean);
    const checked = checkedInputs.find((input) =>
      preferredServiceId
      && String(input.dataset?.bookingService || input.value || '') === preferredServiceId
    ) || checkedInputs[0] || null;
    const quantity = checked?.closest('label')?.querySelector('select');
    if (!checked) throw new Error('管理端修改預約沒有可調整的已選服務項目。');
    const beforeQuantity = Number(quantity?.value || 1);
    const removingItem = mutationMode === 'remove-item';
    if (!removingItem && !quantity) throw new Error('管理端修改預約沒有可調整的服務數量。');
    const afterQuantity = removingItem ? 0 : (beforeQuantity >= 2 ? beforeQuantity - 1 : beforeQuantity + 1);
    const serviceId = String(checked.dataset?.bookingService || checked.value || '');
    const participantEditor = Boolean(form.querySelector('[data-participant-item-rows]'));
    if (removingItem) {
      checked.checked = false;
      checked.dispatchEvent(new Event('input', { bubbles: true }));
      checked.dispatchEvent(new Event('change', { bubbles: true }));
      await adminHumanPause(80, 220);
    } else {
      await adminHumanSelect(quantity, String(afterQuantity), '服務數量');
    }
    const beforeUpdatedAt = String(booking?.updatedAt || '');

    if (state.cancelled) throw new Error('E2E 已停止，未送出修改。');
    const submit = form.querySelector('button[type="submit"]');
    if (!submit || submit.disabled) throw new Error('修改預約送出按鈕尚未就緒。');
    await adminHumanClick(submit, '儲存預約項目');
    const closed = Boolean(await waitFor(() => document.getElementById('bookingAdminCrudModal')?.classList.contains('hidden'), 18000, 100));
    if (!closed) {
      const message = form.querySelector('[data-modal-message]')?.textContent || '';
      document.getElementById('bookingAdminCrudModalClose')?.click();
      throw new Error(message || '管理端修改預約送出後視窗未關閉。');
    }

    const updated = await waitAdminBookingSnapshot(bookingId, (row) => String(row.updatedAt || '') !== beforeUpdatedAt, 16000);
    let items = updated?.items || [];
    if (participantEditor && updated) {
      const afterDetails = await detectedBookingGroupDetails(bookingId);
      const afterParticipants = Array.isArray(afterDetails.group?.participants) ? afterDetails.group.participants : [];
      const targetAfter = afterParticipants.find((participant) => Number(participant?.position || 0) === targetPosition)
        || afterParticipants[targetIndex]
        || null;
      items = Array.isArray(targetAfter?.items) ? targetAfter.items : [];
    }
    const persistedQuantity = Number(items.find((item) => String(item.serviceId || '') === serviceId)?.quantity || 0);
    const updatedAtChanged = Boolean(updated && String(updated.updatedAt || '') !== beforeUpdatedAt);
    return {
      bookingId,
      serviceId,
      beforeQuantity,
      afterQuantity,
      persistedQuantity,
      updatedAtChanged,
      updatedAt: updated?.updatedAt || null,
      participantPosition: participantEditor ? targetPosition : null,
      safeMutation: removingItem
        ? 'remove-existing-item'
        : (beforeQuantity >= 2 ? 'decrease-existing-quantity' : 'increase-unassigned-participant'),
      ok: updatedAtChanged && persistedQuantity === afterQuantity
    };
  }

  async function detectedBookingGroupDetails(bookingId) {
    const id = String(bookingId || '');
    const session = await adminSession();
    const details = await postFunction('booking-group-details-api', {
      action: 'admin.booking.group.details',
      clientType: 'admin',
      idToken: session.idToken,
      bookingIds: [id]
    });
    return {
      group: details?.bookingGroups?.[id] || null,
      primaryTechnicianId: String(details?.primaryTechnicianId || '')
    };
  }

  async function mutateDetectedBookingTechnician(booking) {
    await openAdminBookingQueue(String(booking?.status || 'pending'));
    const bookingId = String(booking?.bookingId || '');
    const beforeDetails = await detectedBookingGroupDetails(bookingId);
    const participants = Array.isArray(beforeDetails.group?.participants) ? beforeDetails.group.participants : [];
    if (participants.length < 2) throw new Error('修改技師 E2E 需要至少兩位預約人，避免移除唯一主要技師。');

    const targetIndex = participants.findIndex((participant) => participant?.isPrimaryTechnician !== true);
    if (targetIndex < 0) throw new Error('找不到可安全修改的非主要技師預約人。');
    const targetBefore = participants[targetIndex];
    const targetPosition = Number(targetBefore?.position || targetIndex + 1);
    const currentTechnicianId = String(targetBefore?.technicianId || '');
    const otherTechnicianIds = new Set(participants
      .filter((_, index) => index !== targetIndex)
      .map((participant) => String(participant?.technicianId || ''))
      .filter(Boolean));

    const card = await waitFor(() => document.querySelector(
      '#bookingAdminQueue .booking-admin-booking[data-booking-id="' + CSS.escape(bookingId) + '"]'
    ), 8000, 100);
    if (!card) throw new Error('管理端找不到要修改技師的用戶端 E2E 預約。');
    const blocks = Array.from(card.querySelectorAll('.booking-group-admin-participant'));
    const targetBlock = blocks[targetIndex];
    const editButton = bookingActionButton(targetBlock, '修改此位技師');
    if (!editButton) throw new Error('這筆多人預約缺少「修改此位技師」操作。');
    await adminHumanClick(editButton, '修改此位技師');

    const modal = await waitFor(() => {
      const node = document.getElementById('bookingAdminCrudModal');
      return node && !node.classList.contains('hidden') ? node : null;
    }, 5000);
    if (!modal) throw new Error('管理端修改技師視窗未開啟。');
    const form = modal.querySelector('form');
    const select = form?.querySelector('[data-participant-technician]');
    if (!form || !select) throw new Error('管理端修改技師表單不完整。');

    const options = Array.from(select.options || []).filter((option) => {
      const value = String(option.value || '');
      return option.disabled !== true
        && value !== currentTechnicianId
        && (!value || !otherTechnicianIds.has(value));
    });
    const replacement = currentTechnicianId
      ? (options.find((option) => String(option.value || '') === '') || options[0])
      : options.find((option) => String(option.value || '') !== '');
    if (!replacement) {
      document.getElementById('bookingAdminCrudModalClose')?.click();
      throw new Error('目前沒有可安全切換且不重複的替代技師。');
    }

    const nextTechnicianId = String(replacement.value || '');
    await adminHumanSelect(select, nextTechnicianId, '預約技師');
    const beforeUpdatedAt = String(booking?.updatedAt || '');
    if (state.cancelled) throw new Error('E2E 已停止，未送出技師修改。');
    const submit = form.querySelector('button[type="submit"]');
    if (!submit || submit.disabled) throw new Error('修改技師送出按鈕尚未就緒。');
    await adminHumanClick(submit, '儲存預約技師');

    const closed = Boolean(await waitFor(
      () => document.getElementById('bookingAdminCrudModal')?.classList.contains('hidden'),
      18000,
      100
    ));
    if (!closed) {
      const message = form.querySelector('[data-modal-message]')?.textContent || '';
      document.getElementById('bookingAdminCrudModalClose')?.click();
      throw new Error(message || '管理端修改技師送出後視窗未關閉。');
    }

    const updated = await waitAdminBookingSnapshot(
      bookingId,
      (row) => String(row.updatedAt || '') !== beforeUpdatedAt,
      16000
    );
    const afterDetails = await detectedBookingGroupDetails(bookingId);
    const afterParticipants = Array.isArray(afterDetails.group?.participants) ? afterDetails.group.participants : [];
    const targetAfter = afterParticipants.find((participant) => Number(participant?.position || 0) === targetPosition)
      || afterParticipants[targetIndex]
      || null;
    const persistedTechnicianId = String(targetAfter?.technicianId || '');
    const updatedAtChanged = Boolean(updated && String(updated.updatedAt || '') !== beforeUpdatedAt);
    return {
      bookingId,
      participantPosition: targetPosition,
      beforeTechnicianId: currentTechnicianId,
      afterTechnicianId: nextTechnicianId,
      persistedTechnicianId,
      primaryTechnicianId: beforeDetails.primaryTechnicianId,
      updatedAtChanged,
      updatedAt: updated?.updatedAt || null,
      ok: updatedAtChanged && persistedTechnicianId === nextTechnicianId
    };
  }

  async function setDetectedBookingStatus(bookingId, label, adminNote, expectedStatus, sourceFilter = 'pending') {
    await openAdminBookingQueue(sourceFilter);
    const card = await waitFor(() => document.querySelector('#bookingAdminQueue .booking-admin-booking[data-booking-id="' + CSS.escape(String(bookingId || '')) + '"]'), 9000, 100);
    if (!card) throw new Error('管理端找不到待審核的用戶端 E2E 預約。');
    const textarea = card.querySelector('.booking-admin-note-field textarea');
    if (textarea) await adminHumanTextInput(textarea, String(adminNote || ''), '管理端說明');
    const action = bookingActionButton(card, label);
    if (!action) throw new Error('管理端預約缺少「' + label + '」操作。');
    if (!await waitFor(() => !action.disabled, 5000)) throw new Error('管理端預約操作尚未就緒。');
    if (state.cancelled) throw new Error('E2E 已停止，未送出狀態變更。');

    let settlementPreview = null;
    let benefitBefore = { pendingCount: 0, titles: [], cardPendingVisible: true };
    if (expectedStatus === 'completed') {
      const beforeAction = await waitAdminBookingSnapshot(bookingId);
      const pendingBenefits = (Array.isArray(beforeAction?.benefits) ? beforeAction.benefits : [])
        .filter((benefit) => String(benefit?.status || '') === 'pending');
      benefitBefore = {
        pendingCount: pendingBenefits.length,
        titles: pendingBenefits.map((benefit) => String(benefit?.title || '可用權益')),
        cardPendingVisible: pendingBenefits.length === 0 || pendingBenefits.every(benefit =>
          Array.from(card.querySelectorAll('.booking-ticket-card .booking-ticket-status.status-pending')).some(status =>
            /待核銷/.test(status.textContent || '') && status.closest('.booking-ticket-card')?.textContent.includes(String(benefit.title || '').split('｜').pop().trim())))
      };
      if (!benefitBefore.cardPendingVisible) {
        throw new Error('預約有待核銷優惠，但管理端預約卡片沒有顯示待核銷資訊。');
      }

      await adminHumanClick(action, label);
      const previewModal = await waitFor(() => {
        const modal = document.getElementById('bookingAdminCrudModal');
        const title = String(document.getElementById('bookingAdminCrudModalTitle')?.textContent || '');
        return modal && !modal.classList.contains('hidden') && /完成結算預覽/.test(title) ? modal : null;
      }, 5000, 80);
      if (!previewModal) throw new Error('確認服務完成後沒有開啟完成結算預覽。');

      const beforeSubmit = await waitAdminBookingSnapshot(bookingId);
      const bodyText = String(document.getElementById('bookingAdminCrudModalBody')?.textContent || '');
      const confirmButton = Array.from(previewModal.querySelectorAll('button')).find((button) =>
        String(button.textContent || '').trim() === '確認完成並結算'
      );
      settlementPreview = {
        opened: true,
        serverAuthoritativeNotice: /Server-side/.test(bodyText),
        serviceMinutesVisible: /將計入服務時間/.test(bodyText),
        rewardPreviewVisible: /預估自動集點/.test(bodyText),
        benefitPreviewVisible: benefitBefore.pendingCount === 0 || /待核銷優惠|Benefit redemption/.test(bodyText),
        stayedConfirmedBeforeSubmit: String(beforeSubmit?.status || '') === 'confirmed',
        confirmButtonReady: Boolean(confirmButton && !confirmButton.disabled)
      };
      if (!Object.values(settlementPreview).every(Boolean)) {
        throw new Error('完成結算預覽缺少必要資訊或在送出前已提前改變預約狀態。');
      }
      await adminHumanClick(confirmButton, '確認完成並結算');
      await waitFor(() => previewModal.classList.contains('hidden') ? true : null, 10000, 80);
    } else {
      await adminHumanClick(action, label);
    }

    const updated = await waitAdminBookingSnapshot(bookingId, (row) => String(row.status || '') === expectedStatus, 18000);
    const afterBenefits = Array.isArray(updated?.benefits) ? updated.benefits : [];
    const pendingAfter = afterBenefits.filter((benefit) => String(benefit?.status || '') === 'pending');
    const terminalAfter = afterBenefits.filter((benefit) => ['redeemed', 'applied', 'cancelled'].includes(String(benefit?.status || '')));
    const benefitRedemption = expectedStatus === 'completed'
      ? {
          pendingBefore: benefitBefore.pendingCount,
          pendingAfter: pendingAfter.length,
          terminalAfter: terminalAfter.length,
          titles: benefitBefore.titles,
          ok: benefitBefore.pendingCount === 0 || (
            pendingAfter.length === 0 && terminalAfter.length >= benefitBefore.pendingCount
          )
        }
      : { pendingBefore: 0, pendingAfter: 0, terminalAfter: 0, titles: [], ok: true };

    return {
      bookingId: String(bookingId || ''),
      expectedStatus,
      actualStatus: String(updated?.status || ''),
      adminNote: String(updated?.adminNote || ''),
      updatedAt: updated?.updatedAt || null,
      settlementPreview,
      benefitRedemption,
      ok: Boolean(updated && String(updated.status || '') === expectedStatus && benefitRedemption.ok)
    };
  }

  async function reviewDetectedCancellation(bookingId, decision) {
    await openAdminBookingQueue('pending');
    const id = String(bookingId || '');
    const requestFilter = await waitFor(() => document.getElementById('bookingCancellationRequestFilter'), 8000, 100);
    if (!requestFilter) throw new Error('取消申請審核分頁未載入。');
    requestFilter.click();
    const card = await waitFor(() => document.querySelector(
      '#bookingCancellationReviewList .booking-admin-booking[data-booking-id="' + CSS.escape(id) + '"]'
    ), 10000, 100);
    if (!card) throw new Error('管理端取消申請分頁找不到用戶端 E2E 預約。');

    const keeping = decision === 'rejected';
    const actionKey = keeping ? 'reject-cancellation' : 'approve-cancellation';
    const label = keeping ? '保留預約' : '確認取消';
    const action = card.querySelector('[data-booking-admin-action="' + actionKey + '"]') || bookingActionButton(card, label);
    if (!action) throw new Error('取消申請缺少「' + label + '」審核操作。');
    const before = await waitAdminBookingSnapshot(id);
    const sourceStatus = String(before?.status || '');
    if (!['pending', 'confirmed'].includes(sourceStatus)) {
      throw new Error('取消申請來源狀態不是可審核的 pending / confirmed。');
    }
    if (state.cancelled) throw new Error('E2E 已停止，未送出取消審核。');

    await withAutoConfirm(async () => { await adminHumanClick(action, label); });
    const reviewed = await waitAdminBookingSnapshot(id, (row) => {
      if (!row?.cancellationReviewedAt || String(row.cancellationDecision || '') !== decision) return false;
      if (keeping) {
        return !row.cancellationRequestedAt && String(row.status || '') === sourceStatus;
      }
      return String(row.status || '') === 'cancelled';
    }, 18000);

    return {
      bookingId: id,
      decision,
      sourceStatus,
      status: String(reviewed?.status || ''),
      cancellationRequestedAt: reviewed?.cancellationRequestedAt || null,
      cancellationReviewedAt: reviewed?.cancellationReviewedAt || null,
      cancellationDecision: reviewed?.cancellationDecision || null,
      cancelledAt: reviewed?.cancelledAt || null,
      ok: Boolean(reviewed
        && String(reviewed.cancellationDecision || '') === decision
        && (keeping
          ? !reviewed.cancellationRequestedAt && String(reviewed.status || '') === sourceStatus
          : String(reviewed.status || '') === 'cancelled'))
    };
  }

  async function approveDetectedCancellation(bookingId) {
    return reviewDetectedCancellation(bookingId, 'approved');
  }

  async function rejectDetectedCancellation(bookingId) {
    return reviewDetectedCancellation(bookingId, 'rejected');
  }


  async function requestDetectedCancellationFromClient(participant, bookingId) {
    const id = String(bookingId || '');
    let child = participant?.window;
    if (!child || child.closed) throw new Error('預約用戶端視窗已關閉，無法再次提出取消申請。');
    if (participant.lastSurfaceKey !== 'booking' || child.MemberUserTestControl?.surface !== 'booking') {
      const login = await createPairedSession(participant.account, 'booking');
      participant.login = login;
      participant.lastSurfaceKey = 'booking';
      seedParticipantSession(participant, login, 'booking');
      child = await waitParticipantSurface(participant, 'booking', 'bookingView');
    }
    const card = await waitFor(() => child.document.querySelector(
      '#bookingList .booking-item[data-booking-id="' + CSS.escape(id) + '"]'
    ), 8000, 100);
    if (!card) throw new Error('預約用戶端找不到要再次取消的預約卡片。');
    const cancelButton = Array.from(card.querySelectorAll('button'))
      .find((button) => String(button.textContent || '').trim() === '申請取消');
    if (!cancelButton) throw new Error('預約用戶端沒有可操作的「申請取消」按鈕。');

    try { cancelButton.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch {}
    try { cancelButton.focus?.({ preventScroll: true }); } catch { try { cancelButton.focus?.(); } catch {} }
    await adminHumanPause(80, 240);
    const originalConfirm = child.confirm;
    try {
      child.confirm = () => true;
      cancelButton.click();
    } finally {
      child.confirm = originalConfirm;
    }

    const clientPending = Boolean(await waitFor(() => {
      const snapshot = child.MemberClientQaHooks?.getBookingSnapshot?.(id);
      const badge = child.document.querySelector(
        '#bookingList .booking-item[data-booking-id="' + CSS.escape(id) + '"] .status-badge'
      );
      return snapshot?.cancellationRequestedAt
        && !snapshot?.cancellationReviewedAt
        && badge?.classList.contains('status-cancel_requested');
    }, 12000, 120));
    const requested = await waitAdminBookingSnapshot(
      id,
      (row) => Boolean(row?.cancellationRequestedAt) && !row?.cancellationReviewedAt,
      18000
    );
    return {
      bookingId: id,
      status: String(requested?.status || ''),
      cancellationRequestedAt: requested?.cancellationRequestedAt || null,
      cancellationReviewedAt: requested?.cancellationReviewedAt || null,
      clientPending,
      humanUiAction: true,
      ok: Boolean(clientPending && requested?.cancellationRequestedAt && !requested?.cancellationReviewedAt)
    };
  }
  async function cancelDetectedBooking(booking) {
    const bookingId = String(booking?.bookingId || '');
    if (booking?.cancellationRequestedAt && !booking?.cancellationReviewedAt) {
      return approveDetectedCancellation(bookingId);
    }

    let confirmed = null;
    const startingStatus = String(booking?.status || '');
    if (startingStatus === 'pending') {
      confirmed = await setDetectedBookingStatus(
        bookingId,
        '確認預約',
        'QA ADMIN E2E PREPARE CANCEL ' + qaCrudStamp(),
        'confirmed',
        'pending'
      );
      if (!confirmed.ok) return { bookingId, mode: 'direct', confirmed, cancelled: null, ok: false };
    } else if (startingStatus !== 'confirmed') {
      return { bookingId, mode: 'direct', startingStatus, confirmed: null, cancelled: null, ok: false };
    }

    const cancelled = await setDetectedBookingStatus(
      bookingId,
      '取消預約',
      'QA ADMIN E2E CANCEL ' + qaCrudStamp(),
      'cancelled',
      'confirmed'
    );
    return {
      bookingId,
      mode: 'direct',
      confirmed,
      cancelled,
      ok: Boolean(cancelled?.ok)
    };
  }




  async function ensureBookingRealtimeClient(participant, timeoutMs = 20000) {
    const child = participant?.window;
    if (!child || child.closed) throw new Error('預約用戶端視窗已關閉，無法驗證 Realtime。');

    const ready = await waitFor(() => {
      if (state.cancelled) return null;
      if (participant.lastSurfaceKey !== 'booking') return null;
      if (child.MemberUserTestControl?.surface !== 'booking') return null;
      const hooks = child.MemberClientQaHooks;
      if (hooks?.surface !== 'booking'
        || typeof hooks.getRenderCount !== 'function'
        || typeof hooks.getBookingSnapshot !== 'function') return null;
      return { child, hooks };
    }, backgroundAwareTimeout(timeoutMs, 90000), 100);

    if (ready) return ready;
    const error = new Error('預約用戶端尚未停在預約頁；管理端不會強制切換該測試帳號視窗，以免中斷正在進行的真人 E2E。');
    error.code = 'E2E_BOOKING_CLIENT_NOT_READY';
    throw error;
  }
  async function beginBookingRealtimeProbe(participant, bookingId) {
    const { child, hooks } = await ensureBookingRealtimeClient(participant);
    const id = String(bookingId || '');
    return {
      bookingId: id,
      beforeRenderCount: Number(hooks.getRenderCount() || 0),
      beforeSnapshot: safe(hooks.getBookingSnapshot(id)),
      clientUrl: String(child.location?.href || '')
    };
  }

  function memberBookingItems(snapshot, participantPosition = null) {
    if (participantPosition && Array.isArray(snapshot?.participants)) {
      const participant = snapshot.participants.find((item, index) =>
        Number(item?.position || index + 1) === Number(participantPosition)
      );
      if (participant) return Array.isArray(participant.items) ? participant.items : [];
    }
    return Array.isArray(snapshot?.items) ? snapshot.items : [];
  }

  function memberBookingQuantity(snapshot, serviceId, participantPosition = null) {
    const item = memberBookingItems(snapshot, participantPosition)
      .find((row) => String(row?.serviceId || '') === String(serviceId || ''));
    return Number(item?.quantity || 0);
  }

  function memberBookingTechnician(snapshot, participantPosition) {
    const participants = Array.isArray(snapshot?.participants) ? snapshot.participants : [];
    const participant = participants.find((item, index) =>
      Number(item?.position || index + 1) === Number(participantPosition)
    );
    return String(participant?.technicianId || '');
  }

  function memberDisplayStatus(snapshot) {
    return snapshot?.cancellationRequestedAt && !snapshot?.cancellationReviewedAt
      ? 'cancel_requested'
      : String(snapshot?.status || '');
  }

  async function verifyBookingRealtimeSync(participant, probe, validator, expectedDisplayStatus = '', timeoutMs = 15000) {
    const { child, hooks } = await ensureBookingRealtimeClient(participant);
    const started = performance.now();
    let latest = null;
    const synchronized = Boolean(await waitFor(() => {
      const renderCount = Number(hooks.getRenderCount() || 0);
      const snapshot = hooks.getBookingSnapshot(probe.bookingId);
      const card = child.document.querySelector(
        '#bookingList .booking-item[data-booking-id="' + CSS.escape(probe.bookingId) + '"]'
      );
      const displayStatus = memberDisplayStatus(snapshot);
      const badgeMatches = !expectedDisplayStatus
        || Boolean(card?.querySelector('.status-badge')?.classList.contains('status-' + expectedDisplayStatus));
      let dataMatches = false;
      try { dataMatches = Boolean(snapshot && validator(snapshot)); } catch { dataMatches = false; }
      latest = {
        renderCount,
        renderAdvanced: renderCount > Number(probe.beforeRenderCount || 0),
        displayStatus,
        badgeMatches,
        dataMatches,
        snapshot: safe(snapshot)
      };
      return latest.renderAdvanced && latest.badgeMatches && latest.dataMatches ? true : null;
    }, timeoutMs, 120));
    return {
      bookingId: probe.bookingId,
      beforeRenderCount: probe.beforeRenderCount,
      afterRenderCount: Number(latest?.renderCount || 0),
      renderAdvanced: Boolean(latest?.renderAdvanced),
      expectedDisplayStatus: expectedDisplayStatus || null,
      actualDisplayStatus: latest?.displayStatus || null,
      badgeMatches: Boolean(latest?.badgeMatches),
      dataMatches: Boolean(latest?.dataMatches),
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      manualRefreshUsed: false,
      ok: synchronized
    };
  }

  function bookingTerminalSnapshot(bookings, bookingIds, memberId) {
    const ids = [...new Set((bookingIds || []).map(String).filter(Boolean))];
    const byId = new Map((Array.isArray(bookings) ? bookings : [])
      .filter((row) => String(row.memberId || '') === String(memberId || ''))
      .map((row) => [String(row.bookingId || ''), row]));
    const missingIds = ids.filter((id) => !byId.has(id));
    const unresolved = ids.map((id) => byId.get(id)).filter(Boolean)
      .filter((row) => !['completed', 'cancelled', 'rejected'].includes(row.status)
        || (row.cancellationRequestedAt && !row.cancellationReviewedAt))
      .map((row) => ({ bookingId: row.bookingId, status: row.status, cancellationPending: Boolean(row.cancellationRequestedAt && !row.cancellationReviewedAt) }));
    return { total: ids.length, missingIds, unresolved, ok: ids.length > 0 && !missingIds.length && !unresolved.length };
  }

  async function finishRemainingBooking(booking) {
    const bookingId = String(booking.bookingId || '');
    const current = await waitAdminBookingSnapshot(bookingId);
    if (!current || current.memberId !== booking.memberId) return { bookingId, ok: false, reason: 'booking-missing-or-owner-changed' };
    if (state.cancelled) return { bookingId, ok: false, reason: 'stopped' };
    if (current.cancellationRequestedAt && !current.cancellationReviewedAt) return cancelDetectedBooking(current);
    if (['completed', 'cancelled', 'rejected'].includes(current.status)) return { bookingId, status: current.status, alreadyTerminal: true, ok: true };
    let confirmed = null;
    if (current.status === 'pending') {
      confirmed = await setDetectedBookingStatus(bookingId, '確認預約', 'QA ADMIN E2E CONFIRM ' + qaCrudStamp(), 'confirmed', 'pending');
      if (!confirmed.ok) return { bookingId, confirmed, ok: false };
    } else if (current.status !== 'confirmed') return { bookingId, status: current.status, ok: false };
    if (state.cancelled) return { bookingId, confirmed, ok: false, reason: 'stopped' };
    const completed = await setDetectedBookingStatus(bookingId, '確認服務完成', 'QA ADMIN E2E COMPLETE ' + qaCrudStamp(), 'completed', 'confirmed');
    return { bookingId, confirmed, completed, ok: completed.ok };
  }


  async function verifyBookingClientTerminal(participant, bookingIds) {
    if (state.cancelled) return { ok: false, stopped: true };
    let child = participant?.window;
    if (!child || child.closed) throw new Error('預約用戶端視窗已關閉，無法驗證終態。');
    if (participant.lastSurfaceKey !== 'booking' || child.MemberUserTestControl?.surface !== 'booking') {
      const login = await createPairedSession(participant.account, 'booking');
      participant.login = login;
      participant.lastSurfaceKey = 'booking';
      seedParticipantSession(participant, login, 'booking');
      child = await waitParticipantSurface(participant, 'booking', 'bookingView');
    }
    if (typeof child.MemberClientQaHooks?.refresh !== 'function') throw new Error('預約用戶端同步入口尚未就緒。');
    await child.MemberClientQaHooks.refresh();
    const config = await child.BookingSystem.loadConfig();
    const data = await child.BookingSystem.request(config, 'member', '', 'user.booking.bootstrap', {});
    const snapshot = bookingTerminalSnapshot(data?.bookings, bookingIds, participant.account.memberId);
    const uiSynchronized = snapshot.ok && Boolean(await waitFor(() => bookingIds.every((id) => {
      const row = data.bookings.find((item) => String(item.bookingId) === id);
      const card = child.document.querySelector('#bookingList .booking-item[data-booking-id="' + CSS.escape(id) + '"]');
      return card?.querySelector('.status-badge')?.classList.contains('status-' + row.status);
    }), 10000, 150));
    return { ...snapshot, refreshed: true, uiSynchronized, ok: snapshot.ok && uiSynchronized };
  }
  async function verifyPairedBookingTerminalState(participant) {
    const handoff = participant.bookingResult?.bookingHandoff;
    if (handoff?.ready !== true || handoff.memberId !== participant.account?.memberId || !Array.isArray(handoff.bookingIds)) {
      return { ok: false, reason: 'complete-handoff-required' };
    }
    const data = await adminBookingBootstrapSnapshot();
    const admin = bookingTerminalSnapshot(data?.bookings, handoff.bookingIds, participant.account.memberId);
    const client = admin.ok ? await verifyBookingClientTerminal(participant, handoff.bookingIds) : { ok: false, checked: false };
    return { admin, client, ok: admin.ok && client.ok };
  }

  async function pairedAdminBookingFollowupCase(participant) {
    const account = participant?.account || {};
    const liveSet = await waitForLivePairedBookingTarget(participant, 'any');
    let candidates = Array.isArray(liveSet?.candidates) ? liveSet.candidates : [];
    let mutable = liveSet?.mutable || null;
    let cancellationTarget = liveSet?.cancellationTarget || null;
    let rejectTarget = liveSet?.rejectTarget || null;

    // Backward-compatible fallback is allowed only after the user's complete handoff exists.
    // Before handoff, live processing is restricted to explicit QA state markers to avoid
    // racing the member's still-running single-booking edit/cancel flow.
    if (liveSet?.handoffReady) {
      mutable = mutable || candidates.find((booking) =>
        /^QA HUMAN E2E GROUP /i.test(String(booking.memberNote || ''))
        && String(booking.status || '') === 'pending'
        && !(booking.cancellationRequestedAt && !booking.cancellationReviewedAt)
      ) || candidates.find((booking) =>
        String(booking.status || '') === 'pending'
        && !(booking.cancellationRequestedAt && !booking.cancellationReviewedAt)
      );
      cancellationTarget = cancellationTarget || candidates.find((booking) =>
        String(booking.bookingId || '') !== String(mutable?.bookingId || '')
        && booking.cancellationRequestedAt && !booking.cancellationReviewedAt
        && ['pending', 'confirmed'].includes(String(booking.status || ''))
      );
      rejectTarget = rejectTarget || candidates.find((booking) =>
        String(booking.bookingId || '') !== String(mutable?.bookingId || '')
        && String(booking.bookingId || '') !== String(cancellationTarget?.bookingId || '')
        && String(booking.status || '') === 'pending'
        && !(booking.cancellationRequestedAt && !booking.cancellationReviewedAt)
      );
    }

    participant.adminStatus = liveSet?.booking
      ? '管理端已看到資料，開始模擬管理員'
      : liveSet?.handoffReady
        ? '用戶端完成，接手現有預約'
        : '預約監看逾時';
    renderParticipants();

    const actual = {
      memberCode: account.memberCode || null,
      detectedCount: candidates.length,
      detectedBookings: candidates.map((booking) => ({
        bookingId: booking.bookingId,
        status: booking.status,
        memberNote: booking.memberNote || '',
        cancellationPending: Boolean(booking.cancellationRequestedAt && !booking.cancellationReviewedAt)
      })),
      statusTabs: {},
      confirmed: null,
      modified: null,
      modifiedTechnician: null,
      completed: null,
      rejected: null,
      keptCancellation: null,
      cancellationRerequest: null,
      cancelled: null,
      realtime: {},
      remainingProcessed: [],
      terminal: null,
      riskScan: null,
      liveWatcher: {
        startedBeforeClientCompletion: !liveSet?.handoffReady,
        readyFromAdminData: Boolean(liveSet?.booking),
        timedOut: Boolean(liveSet?.timedOut),
        liveBookingIds: Array.isArray(participant.liveBookingIds) ? participant.liveBookingIds.slice() : []
      },
      handoffReady: false
    };
    const expected = {
      detectedFromUserE2E: true,
      confirmed: true,
      modifiedItems: true,
      modifiedTechnician: true,
      completed: true,
      rejected: true,
      cancellationKept: true,
      cancellationApproved: true,
      allStatusTabs: true,
      realtimeEveryAdminAction: true,
      riskScanPassed: true,
      recordsPreserved: true
    };
    const prefix = 'PAIRED_' + participant.index + '_ADMIN_BOOKING_';

    const updateDetectedSnapshot = () => {
      actual.detectedCount = candidates.length;
      actual.detectedBookings = candidates.map((booking) => ({
        bookingId: booking.bookingId,
        status: booking.status,
        memberNote: booking.memberNote || '',
        cancellationPending: Boolean(booking.cancellationRequestedAt && !booking.cancellationReviewedAt)
      }));
      actual.liveWatcher.liveBookingIds = Array.isArray(participant.liveBookingIds)
        ? participant.liveBookingIds.slice()
        : [];
    };

    const acquireLiveTarget = async (targetKey) => {
      const found = await waitForLivePairedBookingTarget(participant, targetKey);
      if (Array.isArray(found?.candidates) && found.candidates.length) {
        candidates = found.candidates;
        updateDetectedSnapshot();
      }
      if (found?.booking) return found.booking;
      if (found?.handoffReady) {
        const strictData = await adminBookingBootstrapSnapshot();
        const strictCandidates = pairedBookingCandidates(strictData, participant);
        if (strictCandidates.length) {
          candidates = strictCandidates;
          updateDetectedSnapshot();
        }
        const set = livePairedBookingSet(candidates);
        if (set?.[targetKey]) return set[targetKey];
        if (targetKey === 'mutable') {
          return candidates.find((booking) =>
            String(booking.bookingId || '') !== String(cancellationTarget?.bookingId || '')
            && String(booking.bookingId || '') !== String(rejectTarget?.bookingId || '')
            && String(booking.status || '') === 'pending'
            && !(booking.cancellationRequestedAt && !booking.cancellationReviewedAt)
          ) || null;
        }
        if (targetKey === 'cancellationTarget') {
          return candidates.find((booking) =>
            String(booking.bookingId || '') !== String(mutable?.bookingId || '')
            && booking.cancellationRequestedAt && !booking.cancellationReviewedAt
            && ['pending', 'confirmed'].includes(String(booking.status || ''))
          ) || null;
        }
        if (targetKey === 'rejectTarget') {
          return candidates.find((booking) =>
            String(booking.bookingId || '') !== String(mutable?.bookingId || '')
            && String(booking.bookingId || '') !== String(cancellationTarget?.bookingId || '')
            && String(booking.status || '') === 'pending'
            && !(booking.cancellationRequestedAt && !booking.cancellationReviewedAt)
          ) || null;
        }
      }
      return null;
    };

    await executeCases([
      caseDef(prefix + 'REJECT', '預約：不通過', 'Booking / Reject', async () => {
        rejectTarget = rejectTarget || await acquireLiveTarget('rejectTarget');
        if (!rejectTarget) {
          return fail('本輪缺少可供「不通過」的獨立待確認預約；不可重用完成流程的同一筆資料。', {
            separatePendingBooking: true
          }, actual.detectedBookings);
        }
        actual.statusTabs.rejectPending = await verifyDetectedBookingInCoreFilter(rejectTarget.bookingId, 'pending');
        const realtimeProbe = await beginBookingRealtimeProbe(participant, rejectTarget.bookingId);
        actual.rejected = await setDetectedBookingStatus(
          rejectTarget.bookingId,
          '不通過',
          'QA ADMIN E2E REJECT ' + qaCrudStamp(),
          'rejected',
          'pending'
        );
        if (actual.rejected.ok) {
          actual.realtime.rejected = await verifyBookingRealtimeSync(
            participant,
            realtimeProbe,
            (snapshot) => String(snapshot.status || '') === 'rejected',
            'rejected'
          );
          actual.statusTabs.allRejected = await verifyDetectedBookingInCoreFilter(rejectTarget.bookingId, 'all');
        }
        const detail = {
          ...actual.rejected,
          pendingTab: actual.statusTabs.rejectPending,
          allTab: actual.statusTabs.allRejected,
          realtimeSync: actual.realtime.rejected
        };
        return actual.rejected.ok && detail.pendingTab?.ok && detail.allTab?.ok && detail.realtimeSync?.ok
          ? pass('已像真人點擊「不通過」，且用戶端 Realtime 自動更新為未通過。', { status: 'rejected', realtime: true }, detail)
          : fail('不通過操作、全部分頁或用戶端 Realtime 同步失敗。', { status: 'rejected', realtime: true }, detail);
      }),

      caseDef(prefix + 'KEEP_CANCELLATION', '預約：保留預約', 'Booking / Cancellation Keep', async () => {
        cancellationTarget = cancellationTarget || await acquireLiveTarget('cancellationTarget');
        if (!cancellationTarget) {
          return fail('本輪沒有可供審核的取消申請。', { cancellationRequestDetected: true }, actual.detectedBookings);
        }
        actual.statusTabs.cancellationRequestKeep = await verifyDetectedBookingInCancellationFilter(cancellationTarget.bookingId, 'request');
        const realtimeProbe = await beginBookingRealtimeProbe(participant, cancellationTarget.bookingId);
        actual.keptCancellation = await rejectDetectedCancellation(cancellationTarget.bookingId);
        if (actual.keptCancellation.ok) {
          actual.realtime.keptCancellation = await verifyBookingRealtimeSync(
            participant,
            realtimeProbe,
            (snapshot) => String(snapshot.status || '') === String(actual.keptCancellation.sourceStatus || '')
              && !snapshot.cancellationRequestedAt,
            String(actual.keptCancellation.sourceStatus || '')
          );
          actual.statusTabs.keptSource = await verifyDetectedBookingInCoreFilter(
            cancellationTarget.bookingId,
            actual.keptCancellation.sourceStatus
          );
        }
        const detail = {
          ...actual.keptCancellation,
          requestTab: actual.statusTabs.cancellationRequestKeep,
          sourceTab: actual.statusTabs.keptSource,
          realtimeSync: actual.realtime.keptCancellation
        };
        return actual.keptCancellation.ok && detail.requestTab?.ok && detail.sourceTab?.ok && detail.realtimeSync?.ok
          ? pass('已像真人點擊「保留預約」，且用戶端 Realtime 自動移除取消待確認狀態。', {
              decision: 'rejected', cancellationPending: false, realtime: true
            }, detail)
          : fail('保留預約、狀態回讀或用戶端 Realtime 同步失敗。', {
              decision: 'rejected', cancellationPending: false, realtime: true
            }, detail);
      }),

      caseDef(prefix + 'CONFIRM', '預約：確認預約', 'Booking / Confirm', async () => {
        mutable = mutable || await acquireLiveTarget('mutable');
        if (!mutable) return fail('本輪用戶端未留下可確認的預約。', { mutablePendingBooking: true }, actual.detectedBookings);
        actual.statusTabs.pending = await verifyDetectedBookingInCoreFilter(mutable.bookingId, 'pending');
        const realtimeProbe = await beginBookingRealtimeProbe(participant, mutable.bookingId);
        actual.confirmed = await setDetectedBookingStatus(
          mutable.bookingId,
          '確認預約',
          'QA ADMIN E2E CONFIRM ' + qaCrudStamp(),
          'confirmed',
          'pending'
        );
        if (actual.confirmed.ok) {
          actual.realtime.confirmed = await verifyBookingRealtimeSync(
            participant,
            realtimeProbe,
            (snapshot) => String(snapshot.status || '') === 'confirmed',
            'confirmed'
          );
          actual.statusTabs.confirmed = await verifyDetectedBookingInCoreFilter(mutable.bookingId, 'confirmed');
        }
        const detail = {
          ...actual.confirmed,
          pendingTab: actual.statusTabs.pending,
          confirmedTab: actual.statusTabs.confirmed,
          realtimeSync: actual.realtime.confirmed
        };
        return actual.confirmed.ok && detail.pendingTab?.ok && detail.confirmedTab?.ok && detail.realtimeSync?.ok
          ? pass('已像真人點擊「確認預約」，且用戶端未手動重新整理就由 Realtime 更新為已確認。', { status: 'confirmed', realtime: true }, detail)
          : fail('確認預約、狀態分頁或用戶端 Realtime 同步失敗。', { status: 'confirmed', realtime: true }, detail);
      }),

      caseDef(prefix + 'MODIFY', '預約：修改此位項目', 'Booking / Modify Items', async () => {
        if (!actual.confirmed?.ok) return skip('確認步驟未成功，本案例因前置條件未成立而不執行項目修改。', { confirmed: true }, { dependencyBlocked: 'CONFIRM' });
        const current = await waitAdminBookingSnapshot(mutable.bookingId, (row) => row.status === 'confirmed');
        if (!current || current.status !== 'confirmed') return fail('修改項目前預約狀態已改變。', { status: 'confirmed' }, { status: current?.status });
        const realtimeProbe = await beginBookingRealtimeProbe(participant, mutable.bookingId);
        actual.modified = await mutateDetectedBooking(current);
        if (actual.modified.ok) {
          actual.realtime.modifiedItems = await verifyBookingRealtimeSync(
            participant,
            realtimeProbe,
            (snapshot) => memberBookingQuantity(
              snapshot,
              actual.modified.serviceId,
              actual.modified.participantPosition
            ) === Number(actual.modified.afterQuantity),
            'confirmed'
          );
        }
        const detail = { ...actual.modified, realtimeSync: actual.realtime.modifiedItems };
        return actual.modified.ok && detail.realtimeSync?.ok
          ? pass('已像真人修改預約項目，且用戶端 Realtime 同步顯示新的項目數量。', { quantityPersisted: true, realtime: true }, detail)
          : fail('修改此位項目持久化或用戶端 Realtime 同步失敗。', { quantityPersisted: true, realtime: true }, detail);
      }),

      caseDef(prefix + 'MODIFY_TECHNICIAN', '預約：修改此位技師', 'Booking / Modify Technician', async () => {
        if (!actual.confirmed?.ok) {
          return skip('確認步驟未成功，本案例因前置條件未成立而不執行技師修改。', { confirmed: true }, { dependencyBlocked: 'CONFIRM' });
        }
        const current = await waitAdminBookingSnapshot(mutable.bookingId, (row) => row.status === 'confirmed');
        const realtimeProbe = await beginBookingRealtimeProbe(participant, mutable.bookingId);
        actual.modifiedTechnician = await mutateDetectedBookingTechnician(current || mutable);
        if (actual.modifiedTechnician.ok) {
          actual.realtime.modifiedTechnician = await verifyBookingRealtimeSync(
            participant,
            realtimeProbe,
            (snapshot) => memberBookingTechnician(
              snapshot,
              actual.modifiedTechnician.participantPosition
            ) === String(actual.modifiedTechnician.afterTechnicianId || ''),
            'confirmed'
          );
        }
        const detail = { ...actual.modifiedTechnician, realtimeSync: actual.realtime.modifiedTechnician };
        return actual.modifiedTechnician.ok && detail.realtimeSync?.ok
          ? pass('已像真人修改預約技師，且用戶端 Realtime 同步顯示新的技師資料。', { technicianPersisted: true, realtime: true }, detail)
          : fail('修改此位技師持久化或用戶端 Realtime 同步失敗。', { technicianPersisted: true, realtime: true }, detail);
      }),

      caseDef(prefix + 'COMPLETE', '預約：完成預約', 'Booking / Complete', async () => {
        if (!actual.confirmed?.ok) {
          return skip('確認步驟未成功，本案例因前置條件未成立而不執行完成預約。', {
            confirmed: true
          }, { dependencyBlocked: 'CONFIRM' });
        }
        const realtimeProbe = await beginBookingRealtimeProbe(participant, mutable.bookingId);
        actual.completed = await setDetectedBookingStatus(
          mutable.bookingId,
          '確認服務完成',
          'QA ADMIN E2E COMPLETE ' + qaCrudStamp(),
          'completed',
          'confirmed'
        );
        if (actual.completed.ok) {
          actual.realtime.completed = await verifyBookingRealtimeSync(
            participant,
            realtimeProbe,
            (snapshot) => String(snapshot.status || '') === 'completed',
            'completed'
          );
          actual.statusTabs.completed = await verifyDetectedBookingInCoreFilter(mutable.bookingId, 'completed');
          actual.statusTabs.allCompleted = await verifyDetectedBookingInCoreFilter(mutable.bookingId, 'all');
        }
        const detail = {
          ...actual.completed,
          completedTab: actual.statusTabs.completed,
          allTab: actual.statusTabs.allCompleted,
          realtimeSync: actual.realtime.completed
        };
        return actual.completed.ok && detail.completedTab?.ok && detail.allTab?.ok && detail.realtimeSync?.ok
          ? pass('已像真人完成預約，且用戶端 Realtime 自動更新為服務已完成。', { status: 'completed', realtime: true }, detail)
          : fail('完成預約、狀態分頁或用戶端 Realtime 同步失敗。', { status: 'completed', realtime: true }, detail);
      }),

      caseDef(prefix + 'CANCEL', '預約：確認取消', 'Booking / Cancellation Approve', async () => {
        cancellationTarget = cancellationTarget || await acquireLiveTarget('cancellationTarget');
        if (!cancellationTarget) {
          return fail('本輪沒有可供再次申請取消的預約。', { cancellationRequestDetected: true }, actual.detectedBookings);
        }
        if (!actual.keptCancellation?.ok) {
          return fail('保留預約步驟未成功，不能以同一筆資料建立第二次獨立取消申請。', {
            cancellationKept: true
          }, { dependencyFailed: 'KEEP_CANCELLATION' });
        }
        if (!actual.handoffReady) {
          const handoff = await waitForPairedBookingHandoff(participant);
          actual.handoffReady = Boolean(handoff);
        }
        if (!actual.handoffReady) {
          return fail('用戶端完整預約案例尚未交接完成，為避免與真人操作競態，不執行第二次取消申請。', {
            completeHandoffBeforeMemberUiReuse: true
          }, { handoffReady: false });
        }
        actual.cancellationRerequest = await requestDetectedCancellationFromClient(participant, cancellationTarget.bookingId);
        if (!actual.cancellationRerequest.ok) {
          return fail('會員端未能再次提出取消申請。', { cancellationRequestedAgain: true }, actual.cancellationRerequest);
        }
        actual.statusTabs.cancellationRequestApprove = await verifyDetectedBookingInCancellationFilter(cancellationTarget.bookingId, 'request');
        const realtimeProbe = await beginBookingRealtimeProbe(participant, cancellationTarget.bookingId);
        actual.cancelled = await approveDetectedCancellation(cancellationTarget.bookingId);
        if (actual.cancelled.ok) {
          actual.realtime.cancelled = await verifyBookingRealtimeSync(
            participant,
            realtimeProbe,
            (snapshot) => String(snapshot.status || '') === 'cancelled',
            'cancelled'
          );
          actual.statusTabs.cancelled = await verifyDetectedBookingInCancellationFilter(cancellationTarget.bookingId, 'cancelled');
          actual.statusTabs.allCancelled = await verifyDetectedBookingInCoreFilter(cancellationTarget.bookingId, 'all');
        }
        const detail = {
          ...actual.cancelled,
          rerequest: actual.cancellationRerequest,
          requestTab: actual.statusTabs.cancellationRequestApprove,
          cancelledTab: actual.statusTabs.cancelled,
          allTab: actual.statusTabs.allCancelled,
          realtimeSync: actual.realtime.cancelled
        };
        return actual.cancelled.ok && detail.requestTab?.ok && detail.cancelledTab?.ok && detail.allTab?.ok && detail.realtimeSync?.ok
          ? pass('會員再次申請取消後，管理端像真人確認取消，用戶端 Realtime 自動更新為已取消。', {
              decision: 'approved', status: 'cancelled', realtime: true
            }, detail)
          : fail('確認取消、狀態分頁或用戶端 Realtime 同步失敗。', {
              decision: 'approved', status: 'cancelled', realtime: true
            }, detail);
      })
    ], '預約完整自動處理 · 測試用戶 ' + participant.index);

    const finalHandoff = await waitForPairedBookingHandoff(participant);
    actual.handoffReady = Boolean(finalHandoff);
    if (finalHandoff) {
      const fresh = await adminBookingBootstrapSnapshot();
      const finalCandidates = pairedBookingCandidates(fresh, participant);
      if (finalCandidates.length) candidates = finalCandidates;
      actual.detectedCount = candidates.length;
      actual.detectedBookings = candidates.map((booking) => ({
        bookingId: booking.bookingId,
        status: booking.status,
        memberNote: booking.memberNote || '',
        cancellationPending: Boolean(booking.cancellationRequestedAt && !booking.cancellationReviewedAt)
      }));
    }
    participant.adminStatus = finalHandoff ? '完整接手清單已同步' : '接手清單未完成';
    renderParticipants();

    const primaryIds = new Set([
      mutable?.bookingId,
      rejectTarget?.bookingId,
      cancellationTarget?.bookingId
    ].filter(Boolean));
    const remaining = candidates.filter((booking) => !primaryIds.has(booking.bookingId));
    await executeCases(remaining.map((booking, index) => caseDef(
      prefix + 'REMAINING_' + (index + 1),
      '預約：接手其餘本輪 QA 資料 ' + (index + 1),
      'Booking / Remaining',
      async () => {
        const realtimeProbe = await beginBookingRealtimeProbe(participant, booking.bookingId);
        const detail = await finishRemainingBooking(booking);
        if (detail.ok && !detail.alreadyTerminal) {
          const finalRow = await waitAdminBookingSnapshot(
            booking.bookingId,
            (row) => ['completed', 'cancelled', 'rejected'].includes(String(row?.status || ''))
              && !(row?.cancellationRequestedAt && !row?.cancellationReviewedAt),
            12000
          );
          detail.realtimeSync = finalRow
            ? await verifyBookingRealtimeSync(
                participant,
                realtimeProbe,
                (snapshot) => String(snapshot.status || '') === String(finalRow.status || '')
                  && !(snapshot.cancellationRequestedAt && !snapshot.cancellationReviewedAt),
                String(finalRow.status || '')
              )
            : { ok: false, reason: 'admin-terminal-state-not-found' };
        } else if (detail.ok) {
          detail.realtimeSync = { ok: true, notRequired: true, reason: 'already-terminal' };
        }
        actual.remainingProcessed.push(detail);
        return detail.ok && detail.realtimeSync?.ok
          ? pass('本輪額外 QA 預約已由管理端處理至終態，且用戶端同步完成。', {
              terminal: true, clientSynchronized: true
            }, detail)
          : fail('本輪額外 QA 預約未處理完成或用戶端同步失敗。', {
              terminal: true, clientSynchronized: true
            }, detail);
      }
    )), '預約剩餘資料 · 測試用戶 ' + participant.index);

    await executeCases([caseDef(prefix + 'TERMINAL', '預約：兩端皆無本輪未完成資料', 'Booking / Terminal', async () => {
      actual.terminal = await verifyPairedBookingTerminalState(participant);
      return actual.terminal.ok
        ? pass('管理端與用戶端均已回讀本輪預約終態，沒有待確認或待審核取消。', {
            unresolved: 0, clientSynchronized: true
          }, actual.terminal)
        : fail('本輪仍有預約未完成、未拒絕、未審核取消、資料遺失或用戶端未同步。', {
            unresolved: 0, clientSynchronized: true
          }, actual.terminal);
    })], '預約終態驗證 · 測試用戶 ' + participant.index);

    await executeCases([caseDef(prefix + 'RISK_SCAN', '預約：同步／競態／越權風險掃描', 'Booking / Risk Scan', async () => {
      const handoffIds = Array.isArray(participant.bookingResult?.bookingHandoff?.bookingIds)
        ? participant.bookingResult.bookingHandoff.bookingIds.map(String).filter(Boolean)
        : [];
      const uniqueHandoffIds = [...new Set(handoffIds)];
      const fresh = await adminBookingBootstrapSnapshot();
      const allRows = Array.isArray(fresh?.bookings) ? fresh.bookings : [];
      const handoffRows = allRows.filter((row) => uniqueHandoffIds.includes(String(row?.bookingId || '')));
      const foreignOwnerRows = handoffRows.filter((row) => String(row?.memberId || '') !== String(account.memberId || ''));
      const candidateOutsideHandoff = candidates
        .filter((row) => !uniqueHandoffIds.includes(String(row?.bookingId || '')))
        .map((row) => String(row?.bookingId || ''));
      const realtimeRows = Object.entries(actual.realtime).map(([name, value]) => ({ name, ...(value || {}) }));
      const realtimeFailures = realtimeRows.filter((row) => row.ok !== true);
      const manualRefreshViolations = realtimeRows.filter((row) => row.manualRefreshUsed === true);
      const remainingSyncFailures = actual.remainingProcessed.filter((row) => row?.realtimeSync?.ok !== true);
      const unresolved = Array.isArray(actual.terminal?.admin?.unresolved) ? actual.terminal.admin.unresolved : [];
      const missingIds = Array.isArray(actual.terminal?.admin?.missingIds) ? actual.terminal.admin.missingIds : [];
      const cancellationPending = unresolved.filter((row) => row.cancellationPending);
      actual.riskScan = {
        handoffCount: handoffIds.length,
        duplicateHandoffIds: handoffIds.length - uniqueHandoffIds.length,
        foreignOwnerBookingIds: foreignOwnerRows.map((row) => String(row?.bookingId || '')),
        candidateOutsideHandoff,
        realtimeChecks: realtimeRows.length,
        realtimeFailures,
        manualRefreshViolations,
        remainingSyncFailures: remainingSyncFailures.map((row) => row.bookingId),
        unresolved,
        missingIds,
        cancellationPending,
        terminalClientSynchronized: Boolean(actual.terminal?.client?.uiSynchronized),
        risksDetected: []
      };
      if (actual.riskScan.duplicateHandoffIds) actual.riskScan.risksDetected.push('duplicate-handoff');
      if (foreignOwnerRows.length || candidateOutsideHandoff.length) actual.riskScan.risksDetected.push('cross-account-or-out-of-scope');
      if (realtimeFailures.length || manualRefreshViolations.length || remainingSyncFailures.length) actual.riskScan.risksDetected.push('realtime-or-stale-client');
      if (unresolved.length || missingIds.length || cancellationPending.length) actual.riskScan.risksDetected.push('unfinished-or-cancellation-race');
      if (!actual.terminal?.client?.uiSynchronized) actual.riskScan.risksDetected.push('backend-ui-divergence');
      const expectedRealtimeChecks = [
        actual.rejected,
        actual.keptCancellation,
        actual.confirmed,
        actual.modified,
        actual.modifiedTechnician,
        actual.completed,
        actual.cancelled
      ].filter((operation) => operation?.ok === true).length;
      actual.riskScan.expectedRealtimeChecks = expectedRealtimeChecks;
      const ok = actual.riskScan.risksDetected.length === 0
        && realtimeRows.length >= expectedRealtimeChecks
        && uniqueHandoffIds.length > 0;
      actual.riskScan.ok = ok;
      return ok
        ? pass('完整預約 E2E 未發現跨會員誤操作、Realtime 靜默失效、UI 落後、取消競態或未處理預約。', {
            risksDetected: 0, realtimeChecksAtLeast: expectedRealtimeChecks, unresolved: 0
          }, actual.riskScan)
        : fail('完整預約 E2E 偵測到同步、競態、資料範圍或終態風險。', {
            risksDetected: 0, realtimeChecksAtLeast: expectedRealtimeChecks, unresolved: 0
          }, actual.riskScan);
    })], '預約風險掃描 · 測試用戶 ' + participant.index);

    if (state.cancelled) return skip('預約 E2E 已停止，已完成的動作與資料保留。', expected, actual);
    const steps = ['REJECT', 'KEEP_CANCELLATION', 'CONFIRM', 'MODIFY', 'MODIFY_TECHNICIAN', 'COMPLETE', 'CANCEL', 'TERMINAL', 'RISK_SCAN']
      .map((key) => state.results.find((row) => row.key === prefix + key));
    return steps.every((row) => row?.status === 'passed')
      && actual.remainingProcessed.length === remaining.length
      && actual.remainingProcessed.every((row) => row.ok && row.realtimeSync?.ok)
      && actual.terminal?.ok
      && actual.riskScan?.ok
      ? pass('管理端已像真人接手所有本輪預約，逐步驗證用戶端 Realtime，同時完成終態與風險掃描。', expected, actual)
      : fail('預約 E2E 有未通過步驟，請查看各動作的獨立結果。', expected, actual);
  }


  async function adminTestModeControlsCase() {
    document.getElementById('testModeTab')?.click();
    const ids = [
      'systemMaintenanceEnabled', 'testModePcLoginEnabled', 'testModeMobileLoginEnabled', 'testModeMaintenanceMessage',
      'testModeAddAccountCount', 'testModeSelectAllAccounts', 'deleteSelectedTestAccountsButton', 'saveTestModeButton', 'purgeTestDataButton',
      'runPairedFullE2EButton', 'pairedE2EAccountCount'
    ];
    const actual = Object.fromEntries(ids.map((id) => [id, Boolean(document.getElementById(id))]));
    const ok = Object.values(actual).every(Boolean);
    return ok
      ? pass('管理端測試環境、測試資料清理與唯一背景完整 E2E Runner 控制元件皆存在。', { allControls: true }, actual)
      : fail('測試環境控制元件不完整。', { allControls: true }, actual);
  }

  async function adminMembershipTermsCase() {
    document.getElementById('membersTab')?.click();
    const ids = [
      'termsReload','termsVersionList','termsNewDraft','termsDraftForm','termsVersion','termsTitle',
      'termsSummary','termsBody','termsEffectiveAt','termsRequired','termsReconsent','termsSave','termsActivate'
    ];
    const missing = ids.filter((id) => !document.getElementById(id));
    const session = await adminSession();
    const data = await window.MemberSystem.request(session.config, 'admin', session.idToken, 'admin.terms.list', {});
    const terms = Array.isArray(data?.terms) ? data.terms : [];
    const active = terms.find((row) => String(row?.status || '') === 'active') || null;
    const listReady = Boolean(await waitFor(() => {
      const node = document.getElementById('termsVersionList');
      if (!node) return null;
      return terms.length ? node.querySelector('button') : String(node.textContent || '').includes('尚無條款');
    }, 5000, 100));
    const actual = {
      missing,
      backendList: Array.isArray(data?.terms),
      versionCount: terms.length,
      activeVersion: active?.version || null,
      activeRequired: active?.required === true,
      listReady
    };
    const ok = missing.length === 0 && actual.backendList && Boolean(active?.id && active?.version) && active?.required === true && listReady;
    return ok
      ? pass('管理端會員條款控制、版本清單與目前強制同意版本均可由 Browser E2E 回讀。', {
          missing: [], activeVersion: true, activeRequired: true, listReady: true
        }, actual)
      : fail('會員條款管理 UI、後端版本清單或目前啟用的強制同意版本不完整。', {
          missing: [], activeVersion: true, activeRequired: true, listReady: true
        }, actual);
  }

  async function adminThemeToggleCase() {
    const button = await waitFor(() => document.getElementById('themeToggleButton'), 2500);
    const root = document.documentElement;
    const storageKey = 'lumen-color-theme-v1';
    const original = String(root.dataset.theme || window.LumenTheme?.get?.() || '');
    if (!button || !/^(light|dark)$/.test(original)) {
      return fail('管理端主題控制器未完整初始化。', { togglePresent: true, initialTheme: 'light|dark' }, {
        togglePresent: Boolean(button), initialTheme: original || null
      });
    }
    button.click();
    const changedTheme = original === 'dark' ? 'light' : 'dark';
    const changed = Boolean(await waitFor(() => root.dataset.theme === changedTheme, 1200));
    const persisted = (() => {
      try { return localStorage.getItem(storageKey) === changedTheme; } catch { return false; }
    })();
    button.click();
    const restored = Boolean(await waitFor(() => root.dataset.theme === original, 1200));
    const restoredPersisted = (() => {
      try { return localStorage.getItem(storageKey) === original; } catch { return false; }
    })();
    const actual = { original, changedTheme, changed, persisted, restored, restoredPersisted };
    return changed && persisted && restored && restoredPersisted
      ? pass('管理端亮／暗主題可切換、儲存並還原。', {
          changed: true, persisted: true, restored: true, restoredPersisted: true
        }, actual)
      : fail('管理端主題切換或還原異常。', {
          changed: true, persisted: true, restored: true, restoredPersisted: true
        }, actual);
  }

  async function adminMemberDirectoryControlsCase() {
    const edit = await ensureTestRoster();
    const targetCode = String(state.adminTestAccount?.memberCode || '');
    const search = document.getElementById('memberSearch');
    const prev = document.getElementById('memberPrevPageButton');
    const next = document.getElementById('memberNextPageButton');
    const actual = {
      searchPresent: Boolean(search),
      searchMatched: false,
      paginationControls: Boolean(prev && next),
      recordFilters: {},
      recordModalOpened: false,
      restoredSearch: false
    };
    if (!search || !targetCode) {
      return fail('會員搜尋或指定測試會員資料不存在。', { searchPresent: true, targetCode: true }, {
        searchPresent: Boolean(search), targetCode: Boolean(targetCode)
      });
    }

    search.value = targetCode;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    actual.searchMatched = Boolean(await waitFor(() =>
      Array.from(document.querySelectorAll('#memberTableBody tr')).some((row) => String(row.textContent || '').includes(targetCode)),
      8000,
      100
    ));

    const lineUserId = String(edit.dataset.value || '');
    await clickRowAction('view-records', lineUserId);
    const modal = await waitFor(() => {
      const node = document.getElementById('memberRecordsModal');
      return node && !node.classList.contains('hidden') ? node : null;
    }, 7000);
    actual.recordModalOpened = Boolean(modal);
    if (modal) {
      document.getElementById('memberRecordsOpenUsage')?.click();
      const usage = await waitFor(() => {
        const panel = document.getElementById('memberUsagePanel');
        return panel && !panel.classList.contains('hidden') ? panel : null;
      }, 7000);
      await waitFor(() => !document.querySelector('#memberRecordsList .member-records-loading')
        && document.getElementById('memberRecordsSummary')?.children.length > 0, 8000);
      for (const filter of ['all','presence','pointCards','eventTickets','calendar','bookings','testAutomation']) {
        const tab = usage?.querySelector('[data-record-filter="' + filter + '"]');
        tab?.click();
        actual.recordFilters[filter] = Boolean(tab && tab.getAttribute('aria-selected') === 'true');
      }
      document.getElementById('memberDirectoryTab')?.click();
    }

    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    actual.restoredSearch = Boolean(await waitFor(() => document.getElementById('memberTableBody')?.children.length > 0, 8000, 100));
    const filtersOk = Object.values(actual.recordFilters).length === 7 && Object.values(actual.recordFilters).every(Boolean);
    const ok = actual.searchPresent && actual.searchMatched && actual.paginationControls && actual.recordModalOpened && filtersOk && actual.restoredSearch;
    return ok
      ? pass('會員搜尋、分頁控制與七種會員紀錄篩選皆已納入 E2E。', {
          searchMatched: true, paginationControls: true, allRecordFilters: true, restoredSearch: true
        }, actual)
      : fail('會員名冊搜尋、分頁或紀錄篩選至少一項異常。', {
          searchMatched: true, paginationControls: true, allRecordFilters: true, restoredSearch: true
        }, actual);
  }

  async function adminMemberUsageLogsCase() {
    await ensureTestRoster();
    const account = state.adminTestAccount;
    const code = String(account?.memberCode || '');
    if (!code) return fail('沒有本輪測試會員，禁止查詢正式會員歷程。', {testMember:true}, {testMember:false});
    document.getElementById('memberUsageTab')?.click();
    setField('memberUsageKind', 'test');
    setField('memberUsageSearch', code);
    const select = await waitFor(() => {
      const node = document.getElementById('memberUsageSelect');
      return node && !node.disabled && Array.from(node.options).some(option =>
        option.value && String(option.textContent).includes(code)) ? node : null;
    }, 10000);
    const option = Array.from(select?.options || []).find(option => option.value && String(option.textContent).includes(code));
    if (option) setField('memberUsageSelect', option.value);
    const selected = Boolean(option && await waitFor(() =>
      String(document.getElementById('memberUsageSelectedLabel')?.textContent || '').includes(code), 8000));
    await waitFor(() => !document.querySelector('#memberRecordsList .member-records-loading')
      && document.getElementById('memberRecordsSummary')?.children.length > 0, 8000);
    const filters = {};
    for (const key of ['all','presence','pointCards','eventTickets','calendar','bookings','testAutomation']) {
      const tab = document.querySelector('#memberUsagePanel [data-record-filter="' + key + '"]');
      tab?.click();
      filters[key] = tab?.getAttribute('aria-selected') === 'true';
    }
    const message = document.getElementById('memberRecordsMessage');
    const loaded = selected && Boolean(await waitFor(() => !/正在載入/.test(message?.textContent || ''), 8000))
      && (message?.classList.contains('hidden') || !String(message?.textContent || '').trim());
    document.querySelector('#memberUsagePanel [data-record-filter="all"]')?.click();
    document.getElementById('memberDirectoryTab')?.click();
    const actual = {selected,loaded,filters,testOnly:document.getElementById('memberUsageKind')?.value === 'test'};
    return selected && loaded && actual.testOnly && Object.values(filters).every(Boolean)
      ? pass('已選取本輪測試會員並操作使用紀錄七類歷程。', {allFilters:true,testOnly:true}, actual)
      : fail('使用紀錄選取、載入或分類失敗。', {allFilters:true,testOnly:true}, actual);
  }

  async function adminBookingNoShowControlsCase() {
    document.getElementById('bookingTab')?.click();
    await waitBookingAdminReady(15000);
    document.getElementById('bookingAdminQueueSubtab')?.click();
    const tab = document.querySelector('[data-booking-filter="no_show"]');
    tab?.click();
    const selected = Boolean(tab && await waitFor(() => tab.classList.contains('active'), 3000));
    const wrongStatuses = Array.from(document.querySelectorAll('#bookingAdminQueue .booking-admin-booking'))
      .filter(card => !String(card.textContent || '').includes('無故未到')).length;
    document.querySelector('[data-booking-filter="pending"]')?.click();
    const invalid = Array.from(document.querySelectorAll('[data-no-show-id]')).filter(button =>
      button.disabled && (button.title === '服務結束後才能標記無故未到。'
        || button.getAttribute('aria-label')?.includes('服務結束後才能'))).length;
    const actual = {selected,wrongStatuses,invalidEarlyLabels:invalid};
    return selected && wrongStatuses === 0 && invalid === 0
      ? pass('無故未到分類可切換，未到期按鈕不顯示過期提示。', {selected:true,wrongStatuses:0,invalidEarlyLabels:0}, actual)
      : fail('無故未到分類或按鈕狀態異常。', {selected:true,wrongStatuses:0,invalidEarlyLabels:0}, actual);
  }

  async function adminTestAccountLifecycleCase() {
    document.getElementById('testModeTab')?.click();
    const before = await postAdminTestMode('admin.test-mode.bootstrap');
    const beforeIds = new Set(activeTestAccounts(before).map((account) => String(account.memberId || '')));
    let created = null;
    const actual = { created: false, rendered: false, checkboxSelectable: false, deleted: false, cleanupFallback: false };
    try {
      const count = await waitFor(() => document.getElementById('testModeAddAccountCount'), 3000);
      const save = await waitFor(() => {
        const button = document.getElementById('saveTestModeButton');
        return button && !button.disabled ? button : null;
      }, 6000);
      if (!count || !save) throw new Error('測試帳號新增控制不存在或尚未可操作。');
      count.value = '1';
      count.dispatchEvent(new Event('input', { bubbles: true }));
      save.click();

      {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline && !created) {
          const data = await postAdminTestMode('admin.test-mode.bootstrap').catch(() => null);
          created = activeTestAccounts(data).find((account) => !beforeIds.has(String(account.memberId || ''))) || null;
          if (!created) await sleep(250);
        }
      }
      actual.created = Boolean(created?.memberId);
      if (!created?.memberId) throw new Error('透過測試環境表單新增帳號後沒有取得新測試會員。');

      const row = await waitFor(() => {
        const button = document.querySelector('[data-test-account-delete="' + CSS.escape(String(created.memberId)) + '"]');
        return button?.closest('.test-account-row') || null;
      }, 8000, 100);
      actual.rendered = Boolean(row);
      const checkbox = row?.querySelector('.test-account-checkbox');
      if (checkbox) {
        checkbox.click();
        actual.checkboxSelectable = checkbox.checked === true;
        if (checkbox.checked) checkbox.click();
      }

      const remove = row?.querySelector('[data-test-account-delete]');
      if (!remove) throw new Error('新增測試會員沒有移除控制。');
      const originalConfirm = window.confirm;
      try {
        window.confirm = () => true;
        remove.click();
      } finally {
        window.confirm = originalConfirm;
      }
      {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline && !actual.deleted) {
          const data = await postAdminTestMode('admin.test-mode.bootstrap').catch(() => null);
          actual.deleted = Boolean(data && !activeTestAccounts(data).some((account) => String(account.memberId || '') === String(created.memberId)));
          if (!actual.deleted) await sleep(250);
        }
      }
    } finally {
      if (created?.memberId && !actual.deleted) {
        actual.cleanupFallback = await removeEphemeralTestAccount(created).catch(() => false);
      } else {
        actual.cleanupFallback = true;
      }
      const count = document.getElementById('testModeAddAccountCount');
      if (count) count.value = '0';
    }
    const ok = actual.created && actual.rendered && actual.checkboxSelectable && actual.deleted && actual.cleanupFallback;
    return ok
      ? pass('測試帳號已透過管理 UI 新增、選取、移除並確認後端清理。', {
          created: true, rendered: true, checkboxSelectable: true, deleted: true
        }, actual)
      : fail('測試帳號新增／選取／移除生命週期至少一項異常。', {
          created: true, rendered: true, checkboxSelectable: true, deleted: true
        }, actual);
  }

  async function adminMessagePresetEditorCase() {
    document.getElementById('membersTab')?.click();
    const open = document.getElementById('manageGrantMessagesButton');
    open?.click();
    const modal = await waitFor(() => {
      const node = document.getElementById('messagePresetModal');
      return node && !node.classList.contains('hidden') ? node : null;
    }, 2500);
    const actual = {
      opened: Boolean(modal),
      newReset: false,
      titleValidation: false,
      bodyValidation: false,
      closed: false
    };
    if (!modal) return fail('預設訊息管理視窗無法開啟。', { opened: true }, actual);

    document.getElementById('newMessagePresetButton')?.click();
    actual.newReset =
      String(document.getElementById('messagePresetId')?.value || '') === '' &&
      String(document.getElementById('messagePresetTitle')?.value || '') === '' &&
      String(document.getElementById('messagePresetBody')?.value || '') === '';

    document.getElementById('saveMessagePresetButton')?.click();
    actual.titleValidation = Boolean(await waitFor(() =>
      /預設訊息名稱/.test(String(document.getElementById('messagePresetFormMessage')?.textContent || '')),
      1000
    ));
    setField('messagePresetTitle', 'E2E 驗證用名稱');
    document.getElementById('saveMessagePresetButton')?.click();
    actual.bodyValidation = Boolean(await waitFor(() =>
      /預設訊息內容/.test(String(document.getElementById('messagePresetFormMessage')?.textContent || '')),
      1000
    ));
    document.getElementById('closeMessagePresetModal')?.click();
    actual.closed = Boolean(await waitFor(() => modal.classList.contains('hidden'), 1000));

    return Object.values(actual).every(Boolean)
      ? pass('預設訊息管理的開啟、新增重置、名稱／內容驗證與關閉皆正常；未修改正式預設訊息。', {
          opened: true, newReset: true, titleValidation: true, bodyValidation: true, closed: true
        }, actual)
      : fail('預設訊息管理至少一項互動或驗證異常。', {
          opened: true, newReset: true, titleValidation: true, bodyValidation: true, closed: true
        }, actual);
  }

  async function adminCalendarBatchControlsCase() {
    document.getElementById('calendarTab')?.click();
    const add = await waitFor(() => document.getElementById('addCalendarBatchItemButton'), 3000);
    const rows = document.getElementById('calendarBatchRows');
    const message = document.getElementById('calendarBatchMessage');
    const actual = { added: false, invalidSaveRejected: false, cleared: false };
    if (!add || !rows) return fail('日曆批次編輯控制不存在。', { controls: true }, { controls: false });

    if (rows.children.length || document.querySelector('[data-admin-calendar-date-select]:checked')) {
      return skip('保留尚未儲存的日曆批次與日期選取，請清空後重跑。', {emptyDraft:true}, {blockerCode:'E2E_CALENDAR_DRAFT_PRESENT'});
    }
    const date = document.querySelector('[data-admin-calendar-date-select]');
    if (!date) return fail('日曆沒有可選日期。', {date:true}, {date:false});
    date.click();
    add.click();
    actual.added = Boolean(await waitFor(() => rows.children.length >= 1, 1200));
    document.getElementById('saveCalendarBatchButton')?.click();
    actual.invalidSaveRejected = Boolean(await waitFor(() => {
      const text = String(message?.textContent || '').trim();
      return text && !message?.classList.contains('hidden') ? true : null;
    }, 1200));
    document.getElementById('clearCalendarBatchButton')?.click();
    actual.cleared = Boolean(await waitFor(() => rows.children.length === 0, 1200));

    return Object.values(actual).every(Boolean)
      ? pass('日曆批次新增列、送出驗證與清除批次皆可真人操作。', {
          added: true, invalidSaveRejected: true, cleared: true
        }, actual)
      : fail('日曆批次操作至少一項異常。', {
          added: true, invalidSaveRejected: true, cleared: true
        }, actual);
  }


  // Human journeys supplement (not replace) server contracts. Global publication
  // and destructive real-data workflows are exercised by Chromium isolation tests.
  async function adminTierEditorJourneyCase() {
    document.getElementById('membersTab').click();
    document.getElementById('memberTierSettingsTab').click();
    const checks = [];
    const controls = ['General','Silver','Gold','Platinum'].map(tier => document.getElementById('tier'+tier+'Style'));
    const original = controls.map(input => input.value);
    try {
      for (const input of controls) {
        const preview = input.closest('label').querySelector('[data-tier-style-preview]');
        for (const option of Array.from(input.options)) {
          await adminHumanSelect(input, option.value, '會員卡樣式');
          checks.push({tier:input.id,style:option.value,matched:preview?.dataset.style===option.value});
        }
      }
    } finally { controls.forEach((input,index) => setField(input.id,original[index])); }
    return checks.length >= 40 && checks.every(row=>row.matched)
      ? pass('四級會員全部卡面皆經下拉選取與預覽確認，草稿已還原。',{allStyles:true},{checks})
      : fail('會員卡面選取與預覽不同步。',{allStyles:true},{checks});
  }

  async function adminTermsEditorJourneyCase() {
    document.getElementById('membersTab').click();
    document.getElementById('memberTermsTab').click();
    const checks = {versionOpened:false,activeReadonly:false,draftReset:false,counters:false,reconsent:false,reloaded:false};
    await waitFor(()=>document.querySelector('#termsVersionList button:not(:disabled)') && !document.getElementById('termsNewDraft').disabled,5000);
    const active = Array.from(document.querySelectorAll('#termsVersionList button')).find(button=>/使用中|啟用中/.test(button.textContent));
    const first = active || document.querySelector('#termsVersionList button');
    try {
      if (first) { await adminHumanClick(first); checks.versionOpened=Boolean(document.getElementById('termsId').value); }
      checks.activeReadonly = !active || document.getElementById('termsBody').disabled;
      await adminHumanClick(document.getElementById('termsNewDraft'));
      checks.draftReset = !document.getElementById('termsId').value && !document.getElementById('termsBody').disabled;
      await adminHumanTextInput(document.getElementById('termsSummary'),'E2E 草稿摘要');
      await adminHumanTextInput(document.getElementById('termsBody'),'E2E 草稿內容');
      checks.counters = document.getElementById('termsSummaryCount').textContent.includes('8') && document.getElementById('termsBodyCount').textContent.includes('8');
      const toggle=document.getElementById('termsReconsent');
      if(!toggle.checked) await adminHumanClick(toggle);
      checks.reconsent=!document.getElementById('termsReconsentNote').classList.contains('hidden');
    } finally {
      document.getElementById('termsReload').click();
      checks.reloaded=Boolean(await waitFor(()=>document.querySelector('#termsVersionList button:not(:disabled)') && !document.getElementById('termsReload').disabled,5000));
      // Discard an unsaved draft explicitly; reload alone may retain it.
      document.querySelector('#termsVersionList button')?.click();
    }
    return Object.values(checks).every(Boolean)
      ? pass('條款版本、唯讀、草稿、計數及重新同意提示可操作；啟用流程由隔離 Chromium 驗證。',{allChecks:true},checks)
      : fail('條款編輯流程異常。',{allChecks:true},checks);
  }

  async function adminCardEditorOptionsCase() {
    document.getElementById('cardsTab').click();document.getElementById('cardSettingsTab').click();
    document.getElementById('newCardButton').click();await waitEditorOpen('cardEditorModal');
    const checks={styles:[],expiry:false,rewardAdded:false,rewardRemoved:false,reset:false};
    try {
      const style=document.getElementById('cardStyle');
      for(const option of Array.from(style.options)){
        await adminHumanSelect(style,option.value,'集點卡樣式');
        checks.styles.push(document.querySelector('[data-point-card-style-preview]')?.dataset.style===option.value);
      }
      setField('cardExpiryMode','date');
      checks.expiry=document.getElementById('cardExpiresOn').required && !document.getElementById('cardExpiresOnField').classList.contains('hidden');
      setField('cardExpiryMode','unlimited');checks.expiry=checks.expiry&&!document.getElementById('cardExpiresOn').required;
      const count=document.querySelectorAll('#rewardRows [data-reward-row]').length;
      document.getElementById('addRewardButton').click();checks.rewardAdded=document.querySelectorAll('#rewardRows [data-reward-row]').length===count+1;
      document.querySelector('#rewardRows [data-reward-row]:last-child [data-remove-reward]').click();
      checks.rewardRemoved=document.querySelectorAll('#rewardRows [data-reward-row]').length===count;
      setField('cardTitle','E2E 尚未儲存');document.getElementById('resetCardButton').click();
      checks.reset=!document.getElementById('cardId').value&&!document.getElementById('cardTitle').value;
    } finally {closeEditorModalById('cardEditorModal');}
    return checks.styles.length===10&&checks.styles.every(Boolean)&&checks.expiry&&checks.rewardAdded&&checks.rewardRemoved&&checks.reset
      ? pass('集點卡十款樣式、到期切換、增刪節點與清除已實際操作。',{allChecks:true},checks)
      : fail('集點卡完整編輯流程異常。',{allChecks:true},checks);
  }

  async function adminCardSortJourneyCase() {
    document.getElementById('cardsTab').click();document.getElementById('cardSettingsTab').click();
    const rows=()=>Array.from(document.querySelectorAll('#cardListItems [data-card-sort-move="up"]'));
    const original=rows().map(button=>button.dataset.cardId);
    if(original.length<2)return skip('排序至少需要兩張集點卡。',{cards:2},{blockerCode:'E2E_SORT_FIXTURE_REQUIRED'});
    const target=original[1];let moved=false,restored=false;
    try {
      await adminHumanClick(rows()[1],'上移集點卡');
      moved=rows()[0]?.dataset.cardId===target&&!document.getElementById('saveCardSortButton').disabled;
    } finally {
      const down=Array.from(document.querySelectorAll('#cardListItems [data-card-sort-move="down"]')).find(button=>button.dataset.cardId===target);
      if(rows()[0]?.dataset.cardId===target)down?.click();
      restored=JSON.stringify(rows().map(button=>button.dataset.cardId))===JSON.stringify(original);
    }
    return moved&&restored?pass('集點卡上／下移與未儲存草稿還原正常；持久化由隔離 Chromium 驗證。',{moved:true,restored:true},{moved,restored})
      :fail('集點卡排序或草稿還原異常。',{moved:true,restored:true},{moved,restored});
  }

  async function adminFixedTicketDraftLifecycleCase(scheduleType) {
    const title='E2E QA fixed '+scheduleType+' '+qaCrudStamp();
    const session=await adminSession();let created=null;const checks={created:false,reopened:false,updated:false,deleted:false};
    const list=async()=>{const data=await postFunction('fixed-ticket-automation',{action:'admin.fixed-tickets.list',idToken:session.idToken});return data.templates||[];};
    const readOwn=async()=> (await list()).find(row=>row.title===title||row.fixedTicketId===created?.fixedTicketId);
    try {
      document.getElementById('eventsTab').click();document.getElementById('newEventTicketButton').click();await waitEditorOpen('eventTicketEditorModal');
      setField('eventTicketType','fixed');setField('eventTicketTitle',title);setField('eventTicketDescription','E2E QA isolated draft');setField('eventTicketUsageMethod','E2E QA only');setField('eventTicketUsageInstructions','E2E QA cleanup');
      setField('eventTicketStatus','draft');setField('fixedTicketScheduleType',scheduleType);
      if(scheduleType==='yearly')setField('fixedTicketScheduleMonth','12');
      if(['monthly','yearly'].includes(scheduleType))setField('fixedTicketScheduleDay','15');
      if(scheduleType==='weekly')setField('fixedTicketScheduleWeekday','3');
      setField('fixedTicketExpiryMode','days_after_issue');setField('fixedTicketExpiryDays','14');
      for(const id of ['fixedTicketNotifyLine','fixedTicketCalendarEnabled']){const input=document.getElementById(id);if(input?.checked)input.click();}
      document.getElementById('saveEventTicketButton').click();await waitAdminWriteSettled('saveEventTicketButton');
      created=await readOwn();
      checks.created=Boolean(created?.fixedTicketId&&created.status==='draft'&&created.scheduleType===scheduleType&&created.expiryDays===14&&!created.notifyLine&&!created.calendarEnabled);
      if(!checks.created)throw new Error('固定票券草稿未正確儲存，拒絕操作其他規則。');
      const row=document.querySelector('[data-fixed-ticket-id="'+CSS.escape(created.fixedTicketId)+'"]');
      await adminHumanClick(row,'重新開啟本次固定票券');
      checks.reopened=document.getElementById('eventTicketTitle').value===title&&document.getElementById('fixedTicketScheduleType').value===scheduleType;
      setField('fixedTicketExpiryDays','21');document.getElementById('saveEventTicketButton').click();await waitAdminWriteSettled('saveEventTicketButton');
      checks.updated=(await readOwn())?.expiryDays===21;
      await withAutoConfirm(async()=>{document.getElementById('deleteEventTicketButton').click();await waitAdminWriteSettled('saveEventTicketButton');});
      checks.deleted=!(await readOwn());
    } finally {
      // Only the unique draft owned by this node may be cleaned up. No global run.
      const own=await readOwn();
      if(own&&own.title===title&&own.status==='draft'){
        await postFunction('fixed-ticket-automation',{action:'admin.fixed-tickets.delete',idToken:session.idToken,fixedTicketId:own.fixedTicketId,expectedUpdatedAt:own.updatedAt});
      }
      closeEditorModalById('eventTicketEditorModal');
    }
    return Object.values(checks).every(Boolean)?pass('固定票券草稿經 UI 新增、回讀、修改及刪除；未發布或發通知。',{allChecks:true},checks):fail('固定票券草稿 CRUD 未完整通過。',{allChecks:true},checks);
  }

  async function adminEventCalendarSyncCase() {
    const title = 'E2E QA calendar sync ' + qaCrudStamp();
    const session = await adminSession();
    const request = (action, payload = {}) => window.MemberSystem.request(session.config, 'admin', session.idToken, action, payload);
    const list = async () => (await request('admin.calendar-items.list')).calendarItems || [];
    let ticketId = '';
    const checks = {created:false,linked:false,readonly:false,unlinked:false,deleted:false};
    try {
      document.getElementById('eventsTab').click();
      document.getElementById('newEventTicketButton').click();
      await waitEditorOpen('eventTicketEditorModal');
      setField('eventTicketType','coupon');setField('eventTicketTitle',title);
      setField('eventTicketDescription','E2E QA calendar linkage');setField('eventTicketUsageMethod','QA draft only');setField('eventTicketUsageInstructions','QA cleanup');
      setField('eventTicketStatus','draft');setField('eventTicketStartsOn',new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Taipei'}));
      await adminHumanClick(document.getElementById('eventTicketAddToCalendar'),'加入日曆');
      document.getElementById('saveEventTicketButton').click();
      ticketId = String(await waitFor(()=>document.getElementById('eventTicketId').value || null,15000) || '');
      await waitAdminWriteSettled('saveEventTicketButton');
      const data = await request('admin.event-tickets.list');
      const own = (data.eventTickets || []).find(item=>item.eventTicketId===ticketId);
      checks.created = Boolean(own && own.title===title && own.status==='draft');
      if (!checks.created) throw new Error('未確認本輪專用草稿，停止日曆同步操作。');
      const linked = (await list()).find(item=>item.title===title && item.linkUrl?.includes(ticketId));
      checks.linked = Boolean(linked?.calendarItemId && linked.status==='draft');
      if (!checks.linked) throw new Error('活動票券未同步至日曆。');
      closeEditorModalById('eventTicketEditorModal');
      document.getElementById('calendarTab').click();document.getElementById('adminCalendarTodayButton').click();
      // Workspace loading can replace the calendar grid; select the current row
      // after the human pause so a detached element cannot produce false evidence.
      await adminHumanPause(200,400);
      const row = await waitFor(()=>document.querySelector('[data-admin-calendar-item-id="'+CSS.escape(linked.calendarItemId)+'"][data-event-ticket-calendar-readonly="true"]'),5000);
      if (!row) throw new Error('同步日曆項目沒有唯讀標記。');
      row.scrollIntoView?.({block:'center'});row.focus();row.click();
      const info = await waitEditorOpen('eventTicketCalendarInfoModal');
      checks.readonly = Boolean(info && document.getElementById('calendarEditorModal').classList.contains('hidden') && info.textContent.includes('活動票券同步'));
      document.getElementById('closeEventTicketCalendarInfoButton')?.click();
      document.getElementById('eventsTab').click();
      await clickResourceRow('#eventTicketListItems [data-event-ticket-id]','eventTicketId',ticketId);
      await waitEditorOpen('eventTicketEditorModal');
      await waitFor(()=>!document.getElementById('eventTicketAddToCalendar').disabled,5000);
      if (document.getElementById('eventTicketAddToCalendar').checked) await adminHumanClick(document.getElementById('eventTicketAddToCalendar'),'移除日曆連結');
      document.getElementById('saveEventTicketButton').click();await waitAdminWriteSettled('saveEventTicketButton');
      checks.unlinked = !(await list()).some(item=>item.calendarItemId===linked.calendarItemId);
      await withAutoConfirm(async()=>{document.getElementById('deleteEventTicketButton').click();await waitFor(()=>!document.getElementById('eventTicketId').value,15000);});
      checks.deleted = !(await request('admin.event-tickets.list')).eventTickets?.some(item=>item.eventTicketId===ticketId);
    } finally {
      // Read ownership before cleanup; never delete another administrator's data.
      const own = (await request('admin.event-tickets.list')).eventTickets?.find(item=>item.eventTicketId===ticketId);
      if (own?.title===title && own.status==='draft') await request('admin.event-tickets.delete',{eventTicketId:ticketId,expectedUpdatedAt:own.updatedAt});
      closeEditorModalById('eventTicketEditorModal');document.getElementById('closeEventTicketCalendarInfoButton')?.click();
    }
    return Object.values(checks).every(Boolean)
      ? pass('專用活動草稿同步日曆、唯讀資訊、移除連結及刪除完成。',{allChecks:true},checks)
      : fail('活動草稿與日曆同步未完整通過。',{allChecks:true},checks);
  }

  async function adminCalendarNavigationCase() {
    document.getElementById('calendarTab').click();document.getElementById('adminCalendarTodayButton').click();
    const title=()=>document.getElementById('adminCalendarMonthTitle').textContent;
    const current=title();const checks={next:false,previous:false,today:false,dateEditor:false};
    try {
      await adminHumanClick(document.getElementById('adminCalendarNextMonthButton'));checks.next=title()!==current;
      await adminHumanClick(document.getElementById('adminCalendarPreviousMonthButton'));checks.previous=title()===current;
      document.getElementById('adminCalendarPreviousMonthButton').click();document.getElementById('adminCalendarTodayButton').click();checks.today=title()===current;
      const date=document.querySelector('#adminCalendarGrid [data-admin-calendar-date]');
      await adminHumanClick(date);await waitEditorOpen('calendarEditorModal');checks.dateEditor=document.getElementById('calendarItemStartsOn').value===date.dataset.adminCalendarDate;
    }finally{closeEditorModalById('calendarEditorModal');document.getElementById('adminCalendarTodayButton').click();}
    return Object.values(checks).every(Boolean)?pass('日曆前後月、今日及點日期新增已操作。',{allChecks:true},checks):fail('日曆導覽或日期帶入錯誤。',{allChecks:true},checks);
  }

  async function adminEventAudienceJourneyCase() {
    document.getElementById('eventsTab').click();document.getElementById('newEventTicketButton').click();await waitEditorOpen('eventTicketEditorModal');
    const presets={all:['general','silver','gold','platinum'],general:['general'],'silver-plus':['silver','gold','platinum'],'gold-plus':['gold','platinum'],platinum:['platinum']};
    const checks=[];
    try {
      for(const [preset,expected] of Object.entries(presets)){
        await adminHumanClick(document.querySelector('#eventTicketAllowedTiers [data-audience-preset="'+preset+'"]'));
        const actual=Array.from(document.querySelectorAll('#eventTicketAllowedTiers input:checked')).map(input=>input.value);
        checks.push({preset,matched:JSON.stringify(actual)===JSON.stringify(expected)});
      }
      for(const type of ['coupon','lottery','referral','membership_join','fixed']){
        await adminHumanSelect(document.getElementById('eventTicketType'),type);
        checks.push({type,matched:document.getElementById('eventTicketType').value===type});
      }
    }finally{document.getElementById('resetEventTicketButton').click();closeEditorModalById('eventTicketEditorModal');}
    return checks.every(row=>row.matched)?pass('五種適用對象快捷設定與五種票券類型已逐一選取。',{allChecks:true},{checks}):fail('活動票券對象或類型切換異常。',{allChecks:true},{checks});
  }

  async function adminBookingBatchEditorCase() {
    document.getElementById('bookingTab').click();document.getElementById('bookingAdminServicesSubtab').click();await waitBookingAdminReady();
    const checks={opened:false,added:false,removed:false,cancelled:false};
    try {
      await adminHumanClick(document.getElementById('bookingAdminBatchAddButton'));
      const modal=await waitEditorOpen('bookingAdminCrudModal');
      if(!modal)return skip('批次服務編輯需要至少一個服務類型。',{editor:true},{blockerCode:'E2E_SERVICE_TYPE_REQUIRED'});
      checks.opened=modal.querySelectorAll('[data-batch-row]').length===2;
      modal.querySelector('[data-add-row]').click();checks.added=modal.querySelectorAll('[data-batch-row]').length===3;
      const last=modal.querySelector('[data-batch-row]:last-child');
      Array.from(last.querySelectorAll('button')).find(button=>button.textContent==='移除此列')?.click();checks.removed=modal.querySelectorAll('[data-batch-row]').length===2;
      modal.querySelector('[data-cancel]').click();checks.cancelled=modal.classList.contains('hidden');
    }finally{document.getElementById('bookingAdminCrudModalClose')?.click();}
    return Object.values(checks).every(Boolean)?pass('批次預約項目新增列、移除列與取消可操作；批次寫入由隔離 Chromium 驗證。',{allChecks:true},checks):fail('批次預約項目編輯異常。',{allChecks:true},checks);
  }

  async function adminTierSettingsCase() {
    const values = ['General','Silver','Gold','Platinum'].map(tier => ({
      tier, minutes:Number(document.getElementById('tier' + tier + 'Minutes')?.value ?? NaN),
      style:String(document.getElementById('tier' + tier + 'Style')?.value || '')
    }));
    const valid = values.every((item,index) => Number.isInteger(item.minutes) && item.style &&
      (index === 0 ? item.minutes === 0 : item.minutes > values[index - 1].minutes));
    return valid
      ? pass('四級會員門檻依序遞增且具有卡面設定。', { orderedThresholds:true, styles:true }, {values})
      : fail('會員門檻或卡面設定契約不完整。', { orderedThresholds:true, styles:true }, {values});
  }

  async function adminSettingsCopyControlsCase() {
    const checks = [];
    try {
      for (const kind of ['card','ticket','event']) {
        document.getElementById(kind === 'event' ? 'eventsTab' : 'cardsTab')?.click();
        if (kind === 'ticket') document.getElementById('ticketSettingsTab')?.click();
        document.getElementById({card:'newCardButton',ticket:'newTicketButton',event:'newEventTicketButton'}[kind])?.click();
        const button = await waitFor(() => document.getElementById('copySettings-' + kind), 3000);
        button?.click();
        const message = document.getElementById({card:'cardFormMessage',ticket:'ticketFormMessage',event:'eventTicketFormMessage'}[kind]);
        checks.push({kind,button:Boolean(button),unsavedRejected:/先選擇已儲存/.test(message?.textContent || ''),copyDialogClosed:!document.getElementById('settingsCopyModal') || document.getElementById('settingsCopyModal').classList.contains('hidden')});
        document.getElementById({card:'cardEditorModal',ticket:'ticketEditorModal',event:'eventTicketEditorModal'}[kind])?.querySelector('.editor-modal-close')?.click();
      }
    } finally {
      document.getElementById('settingsCopyCancel')?.click();
      document.querySelectorAll('.editor-modal:not(.hidden) .editor-modal-close').forEach(button => button.click());
    }
    return checks.length === 3 && checks.every(row => row.button && row.unsavedRejected && row.copyDialogClosed)
      ? pass('三類未儲存設定均拒絕複製；此節點未建立複本，草稿生命週期另由 Chromium／SQL 驗證。',{unsavedRejected:3},{checks})
      : fail('設定複製入口或未儲存拒絕不完整。',{unsavedRejected:3},{checks});
  }

  async function adminServiceGrantJourneyCase() {
    let account = null;
    const previousSearch = document.getElementById('memberSearch')?.value || '';
    try {
      account = await createEphemeralTestAccount();
      const before = await adminMemberSnapshot(account);
      if (before?.isTestAccount !== true) throw new Error('E2E_SERVICE_GRANT_TEST_ACCOUNT_REQUIRED');
      await openGrantForAccount(account);
      setField('grantMode','services');
      const loaded = await waitFor(() => document.querySelector('#grantServiceList [data-service-grant-id]') || !/正在載入/.test(document.getElementById('grantServiceStatus')?.textContent || ''), 8000);
      const session = await adminSession();
      const catalog = await window.MemberSystem.request(session.config,'admin',session.idToken,'admin.service-grants.catalog',{});
      const service = (catalog.services || []).find(item => !item.requiresCompanionService && item.countsTowardMembership && Number(item.durationMinutes) > 0);
      if (!loaded || !service) return skip('沒有可供本輪服務發放的有效主服務；未發放。',{mainService:true},{mainService:false});
      const checkbox = Array.from(document.querySelectorAll('#grantServiceList [data-service-grant-id]')).find(input => input.dataset.serviceGrantId === service.serviceId);
      if (!checkbox) return fail('服務項目 catalog 與 UI 不一致。',{serviceVisible:true},{serviceVisible:false});
      document.getElementById('previewServiceGrantButton')?.click();
      const emptyRejected = /請選擇服務項目/.test(document.getElementById('grantFormMessage')?.textContent || '');
      checkbox.click();
      document.getElementById('previewServiceGrantButton')?.click();
      const previewReady = Boolean(await waitFor(() => !document.getElementById('saveGrantButton')?.disabled, 8000));
      const items = [{serviceId:service.serviceId,quantity:1}];
      const previewData = await window.MemberSystem.request(session.config,'admin',session.idToken,'admin.service-grants.preview',{lineUserId:account.lineUserId,items});
      const minutes = Number(previewData.preview?.serviceMinutes);
      const previewMatches = Number.isInteger(minutes) && minutes > 0 && document.getElementById('grantServicePreview')?.textContent.includes('+' + minutes + ' 分鐘');
      if (!emptyRejected || !previewReady || !previewMatches) return fail('空項目驗證或服務預覽不一致。',{emptyRejected:true,previewReady:true,previewMatches:true},{emptyRejected,previewReady,previewMatches});
      document.getElementById('saveGrantButton')?.click();
      document.getElementById('saveGrantButton')?.click();
      const closed = Boolean(await waitFor(() => document.getElementById('grantModal')?.classList.contains('hidden'), 15000));
      const after = await adminMemberSnapshot(account);
      const delta = Number(after?.serviceMinutesTotal || 0) - Number(before.serviceMinutesTotal || 0);
      return closed && delta === minutes
        ? pass('專用測試會員完成服務預覽與雙擊發放，回讀服務時間只增加一次；不發正式 LINE。',{closed:true,serviceMinutesDelta:minutes},{closed,serviceMinutesDelta:delta,points:previewData.preview.points,evidence:'ui-and-server-readback'})
        : fail('服務發放終態或會員服務時間不一致。',{closed:true,serviceMinutesDelta:minutes},{closed,serviceMinutesDelta:delta});
    } finally {
      document.getElementById('cancelGrantButton')?.click();
      document.getElementById('closeMemberRecordsModal')?.click();
      if (account && !(await removeEphemeralTestAccount(account))) throw Object.assign(new Error('本輪服務發放測試會員清理失敗。'),{code:'E2E_FIXTURE_CLEANUP_FAILED'});
      const search = document.getElementById('memberSearch');
      if (search) { search.value = previousSearch; search.dispatchEvent(new Event('input',{bubbles:true})); }
    }
  }

  async function adminGrantNotificationControlsCase() {
    try {
      const edit = await ensureTestRoster();
      await clickRowAction('add-grant', edit.dataset.value);
      const modal = await waitFor(() => !document.getElementById('grantModal')?.classList.contains('hidden') && document.getElementById('grantModal'), 4000);
      if (!modal) return fail('發放視窗未開啟。', { opened:true }, { opened:false });
      const original = modal.querySelector('input[name="grantNotificationMode"]:checked')?.value || 'immediate';
      const checks = [];
      try {
        for (const mode of ['scheduled','none','immediate']) {
          const radio = modal.querySelector('input[name="grantNotificationMode"][value="' + mode + '"]');
          radio?.click();
          const input = document.getElementById('grantNotificationScheduledAt');
          checks.push({mode, selected:radio?.checked === true,
            correctRequired:input?.required === (mode === 'scheduled'), correctDisabled:input?.disabled === (mode !== 'scheduled')});
        }
      } finally {
        modal.querySelector('input[name="grantNotificationMode"][value="' + original + '"]')?.click();
        document.getElementById('cancelGrantButton')?.click();
      }
      return checks.every(item => item.selected && item.correctRequired && item.correctDisabled)
        ? pass('通知三種模式可切換，排程日期只在排程模式必填；未送出發放。', { modes:3 }, {checks})
        : fail('通知模式與日期狀態不一致。', { modes:3 }, {checks});
    } finally {
      await closeMemberWorkflowDialogs();
    }
  }

  async function adminPointLimitSettingsCase() {
    document.getElementById('cardsTab')?.click();
    const input = await waitFor(() => document.getElementById('globalMaxTicketsPerRedemption'), 3000);
    const session = await adminSession();
    const data = await postFunction('pointcard-extension-api', { operation:'admin.settings.get', idToken:session.idToken });
    const limit = Number(data.maxTicketsPerRedemption);
    const actual = { limit, uiLimit:Number(input?.value ?? NaN), min:input?.min,
      saveButton:Boolean(document.getElementById('saveGlobalTicketSettingButton')) };
    const ok = Number.isInteger(limit) && limit >= 0 && limit <= 50 && actual.uiLimit === limit && actual.min === '0' && actual.saveButton;
    return ok ? pass('集點卡使用上限與 Server 一致，0 是合法不限張數。', { range:[0,50], matched:true }, actual)
      : fail('集點卡使用上限或不限張數契約不一致。', { range:[0,50], matched:true }, actual);
  }

  async function adminAutomationHealthCase() {
    const session = await adminSession();
    const data = await postFunction('test-control-api',{action:'admin.test-control.automation-health',idToken:session.idToken});
    const expectedNames = ['issue-fixed-tickets','dispatch-scheduled-grant-messages','dispatch-booking-line-notifications','sync-booking-day-before-reminders','prune-e2e-failure-artifacts'];
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    const issues = expectedNames.filter(name => {
      const job = jobs.find(item => item.name === name);
      return !job || job.active !== true || job.fresh !== true || !['succeeded','running'].includes(job.lastStatus);
    });
    const actual = {checkedAt:data.checkedAt,jobs,issues,deliveryScope:'scheduler-only'};
    return issues.length === 0
      ? pass('五個排程工作已啟用且最近執行正常；此結果只驗證排程，LINE 收件另行驗收。',{healthyJobs:5},actual)
      : fail('排程工作缺失、停用、逾期或最近執行失敗。',{healthyJobs:5},actual);
  }

  async function adminBirthdaySettingsCase() {
    document.getElementById('eventsTab')?.click();
    const session = await adminSession();
    const data = await postFunction('fixed-ticket-automation', {action:'admin.fixed-tickets.list',idToken:session.idToken});
    document.getElementById('newEventTicketButton')?.click();
    const modal = await waitFor(() => {
      const node = document.getElementById('eventTicketEditorModal');
      return node && !node.classList.contains('hidden') ? node : null;
    }, 3000);
    const form = document.getElementById('eventTicketForm');
    if (!modal || !form) return fail('生日固定票券編輯器未載入。', { form:true }, { form:false });
    let rejected = false;
    let birthdayMode = false;
    try {
      setField('eventTicketType','fixed');
      setField('fixedTicketScheduleType','birthday_month');
      setField('fixedTicketExpiryMode','month_end');
      birthdayMode = document.getElementById('fixedTicketScheduleType')?.value === 'birthday_month'
        && document.getElementById('fixedTicketYearlyMonthField')?.classList.contains('hidden')
        && document.getElementById('fixedTicketScheduleDayField')?.classList.contains('hidden');
      setField('eventTicketTitle','');
      form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      rejected = /請填寫固定票券名稱/.test(document.getElementById('eventTicketFormMessage')?.textContent || '');
    } finally {
      modal.querySelector('.editor-modal-close, .close-button')?.click();
    }
    const actual = { templates:Array.isArray(data.templates), birthdayMode:Boolean(birthdayMode), rejected,
      tiers:document.querySelectorAll('#eventTicketAllowedTiers input[name="eventTicketAllowedTierKey"]').length };
    return actual.templates && actual.birthdayMode && rejected && actual.tiers === 4
      ? pass('現行生日固定票券 API 可讀取，月份規則與空名稱驗證正常。', { templates:true,birthdayMode:true,rejected:true,tiers:4 }, actual)
      : fail('生日固定票券讀取、生日月份或空值驗證異常。', { templates:true,birthdayMode:true,rejected:true,tiers:4 }, actual);
  }

  async function adminFixedTicketControlsCase() {
    document.getElementById('eventsTab')?.click();
    document.getElementById('newEventTicketButton')?.click();
    const modal = await waitFor(() => document.getElementById('eventTicketEditorModal'), 3000);
    const checks = [];
    try {
      setField('eventTicketType','fixed');
      for (const mode of ['birthday_month','yearly','monthly','weekly']) {
        setField('fixedTicketScheduleType',mode);
        checks.push({mode,monthVisible:!document.getElementById('fixedTicketYearlyMonthField')?.classList.contains('hidden'),
          dayVisible:!document.getElementById('fixedTicketScheduleDayField')?.classList.contains('hidden'),
          weekdayVisible:!document.getElementById('fixedTicketWeekdayField')?.classList.contains('hidden')});
      }
      for (const mode of ['month_end','week_end','days_after_issue','fixed_date']) {
        setField('fixedTicketExpiryMode',mode);
        const id = mode === 'days_after_issue' ? 'fixedTicketExpiryDays' : mode === 'fixed_date' ? 'fixedTicketExpiryDate' : '';
        checks.push({mode,expiryControl:!id || Boolean(document.getElementById(id) && !document.getElementById(id).disabled)});
      }
      const notify = document.getElementById('fixedTicketNotifyLine');
      const time = document.getElementById('fixedTicketNotifyTime');
      const savedNotify = notify?.checked, savedTime = time?.value;
      if (notify && time) {
        notify.click(); setField('fixedTicketNotifyTime','09:30');
        checks.push({notificationControls:notify.checked !== savedNotify && time.value === '09:30'});
        notify.click(); setField('fixedTicketNotifyTime',savedTime || '');
      } else checks.push({notificationControls:false});
    } finally { modal?.querySelector('.editor-modal-close, .close-button')?.click(); }
    const scheduleOk = checks.slice(0,4).every(item => item.monthVisible === (item.mode === 'yearly') &&
      item.dayVisible === ['yearly','monthly'].includes(item.mode) && item.weekdayVisible === (item.mode === 'weekly'));
    return scheduleOk && checks.slice(4,8).every(item => item.expiryControl) && checks[8]?.notificationControls
      ? pass('固定票券四種週期與四種效期控制可操作；未儲存或發放。', { scheduleModes:4,expiryModes:4 }, {checks})
      : fail('固定票券週期或效期控制異常。', { scheduleModes:4,expiryModes:4 }, {checks});
  }

  async function adminTicketLocationControlsCase() {
    const editors = window.TicketLocationEditors;
    const actual = { event:Boolean(editors?.event?.get && editors?.event?.setDraft && editors?.event?.commitDraft),
      template:Boolean(editors?.template?.get && editors?.template?.setDraft && editors?.template?.commitDraft),
      eventToggle:Boolean(document.getElementById('eventTicketRequiresLocation')),
      templateToggle:Boolean(document.getElementById('ticketRequiresLocation')) };
    return Object.values(actual).every(Boolean)
      ? pass('兩種票券皆掛載 GPS 地點編輯及驗證契約；實機定位另外驗收。', { editors:2 }, actual)
      : fail('票券 GPS 編輯器契約未完整掛載。', { editors:2 }, actual);
  }

  async function adminTicketServiceRulesCase() {
    const actual = {event:false,reward:false};
    try {
      document.getElementById('eventsTab')?.click();
      document.getElementById('newEventTicketButton')?.click();
      const mode = await waitFor(() => document.getElementById('eventTicketRequiredServiceMatchMode'), 3000);
      actual.event = Boolean(document.getElementById('eventTicketRequiredServiceIds')) && ['any','all'].every(value => mode?.querySelector('option[value="' + value + '"]'));
      if (mode) { setField(mode.id,'all'); actual.event = actual.event && mode.value === 'all'; setField(mode.id,'any'); }
    } finally { document.getElementById('eventTicketEditorModal')?.querySelector('.editor-modal-close, .close-button')?.click(); }
    try {
      document.getElementById('cardsTab')?.click();
      document.getElementById('newCardButton')?.click();
      const row = await waitFor(() => document.querySelector('[data-reward-required-service-ids]'), 3000);
      const mode = document.querySelector('[data-reward-row] [data-field="requiredServiceMatchMode"]');
      actual.reward = Boolean(row && mode && ['any','all'].every(value => mode.querySelector('option[value="' + value + '"]')));
      if (mode) { mode.value='all';mode.dispatchEvent(new Event('change',{bubbles:true}));actual.reward = actual.reward && mode.value === 'all'; }
    } finally { document.getElementById('cardEditorModal')?.querySelector('.editor-modal-close, .close-button')?.click(); }
    return actual.event && actual.reward
      ? pass('活動券及集點卡節點均可設定具體服務項目與 any／all。', {event:true,reward:true}, actual)
      : fail('票券服務項目或 any／all 編輯器未完整掛載。', {event:true,reward:true}, actual);
  }


  function pairedBookingEvidenceRows(suffix) {
    const normalized = String(suffix || '').replace(/[^A-Z0-9_]/g, '');
    if (!normalized) return [];
    const pattern = new RegExp('^PAIRED_(\\d+)_ADMIN_BOOKING_' + normalized + '$');
    return state.results.map((row) => {
      const match = String(row?.key || '').match(pattern);
      return match ? { participantIndex:Number(match[1]), row } : null;
    }).filter(Boolean);
  }

  function expectedBookingParticipantIndexes() {
    return state.participants.map((participant) => Number(participant?.index || 0)).filter((value) => value > 0);
  }

  async function adminBookingPairedOperationEvidenceCase(suffix, label) {
    const expectedParticipants = expectedBookingParticipantIndexes();
    const evidence = pairedBookingEvidenceRows(suffix);
    const byParticipant = new Map(evidence.map((item) => [item.participantIndex, item.row]));
    const missingParticipants = expectedParticipants.filter((index) => !byParticipant.has(index));
    const failed = evidence.filter((item) => item.row?.status !== 'passed').map((item) => ({
      participantIndex:item.participantIndex,
      status:String(item.row?.status || 'missing'),
      failureCode:String(item.row?.failureCode || item.row?.trace?.diagnosis?.code || '')
    }));
    const actual = {
      operation:String(suffix || ''),
      expectedParticipants,
      observedParticipants:evidence.map((item) => item.participantIndex),
      missingParticipants,
      failed
    };
    const ok = expectedParticipants.length > 0 && missingParticipants.length === 0 && failed.length === 0;
    return ok
      ? pass('既有 paired 真人管理端「' + label + '」動作已提升為固定功能節點，所有測試會員皆有通過證據。', {
          participantEvidenceComplete:true
        }, actual)
      : fail('「' + label + '」缺少 paired 管理端真人操作證據或至少一位測試會員失敗。', {
          participantEvidenceComplete:true
        }, actual);
  }

  async function adminBookingRealtimeEvidenceCase() {
    const suffixes = ['REJECT','KEEP_CANCELLATION','CONFIRM','MODIFY','MODIFY_TECHNICIAN','COMPLETE','CANCEL'];
    const expectedParticipants = expectedBookingParticipantIndexes();
    const checks = [];
    for (const suffix of suffixes) {
      const rows = pairedBookingEvidenceRows(suffix);
      const byParticipant = new Map(rows.map((item) => [item.participantIndex, item.row]));
      for (const participantIndex of expectedParticipants) {
        const row = byParticipant.get(participantIndex);
        checks.push({
          participantIndex,
          operation:suffix,
          status:String(row?.status || 'missing'),
          realtime:Boolean(row?.actual?.realtimeSync?.ok)
        });
      }
    }
    const failed = checks.filter((item) => item.status !== 'passed' || item.realtime !== true);
    return expectedParticipants.length > 0 && failed.length === 0
      ? pass('一般預約所有管理端狀態變更均保留會員端 Realtime 成功證據。', {
          everyAdminMutationRealtime:true
        }, { checks:checks.length, failed })
      : fail('至少一個一般預約管理端動作缺少 Realtime 成功證據。', {
          everyAdminMutationRealtime:true
        }, { checks, failed });
  }

  async function adminBookingRiskEvidenceCase() {
    const expectedParticipants = expectedBookingParticipantIndexes();
    const rows = pairedBookingEvidenceRows('RISK_SCAN');
    const byParticipant = new Map(rows.map((item) => [item.participantIndex, item.row]));
    const checks = expectedParticipants.map((participantIndex) => {
      const row = byParticipant.get(participantIndex);
      return {
        participantIndex,
        status:String(row?.status || 'missing'),
        risksDetected:Array.isArray(row?.actual?.risksDetected) ? row.actual.risksDetected : ['missing-risk-scan']
      };
    });
    const failed = checks.filter((item) => item.status !== 'passed' || item.risksDetected.length > 0);
    return expectedParticipants.length > 0 && failed.length === 0
      ? pass('一般預約 paired 風險掃描沒有發現跨會員、Realtime、取消競態或終態殘留。', {
          risksDetected:0
        }, { checks })
      : fail('一般預約 paired 風險掃描存在失敗或缺少證據。', {
          risksDetected:0
        }, { checks, failed });
  }

  function participantForAccessibleRecord(record) {
    const memberCode = String(record?.memberCode || '');
    return state.participants.find((participant) =>
      memberCode && String(participant?.account?.memberCode || '') === memberCode
    ) || null;
  }

  async function bookingUserQaFixtureRequest(participant, action, payload = {}) {
    let login = reusablePairedSession(participant, 'booking');
    if (!login?.testSessionToken) {
      login = await createPairedSession(participant?.account, 'booking');
      participant.surfaceLogins = participant.surfaceLogins || {};
      participant.surfaceLogins.booking = login;
    }
    const data = await postFunction('user-test-api', {
      ...payload,
      action,
      surface:'booking',
      idToken:'',
      testSessionToken:String(login.testSessionToken || '')
    });
    return { data, login };
  }

  async function adminBookingReceiptRequest(action, payload = {}) {
    const session = await adminSession();
    return postFunction('booking-receipt-api', {
      ...payload,
      action,
      clientType:'admin',
      idToken:session.idToken
    });
  }

  async function waitAccessibleReceiptRecord(receiptId, predicate, timeoutMs = 18000) {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 18000);
    let last = null;
    while (Date.now() < deadline) {
      const data = await adminBookingReceiptRequest('admin.booking.receipt.list');
      last = (Array.isArray(data?.accessibleRecords) ? data.accessibleRecords : [])
        .find((record) => String(record?.receiptId || '') === String(receiptId || '')) || null;
      if (last && (!predicate || predicate(last))) return last;
      await sleep(650);
    }
    return last;
  }

  function accessibleSettlementSnapshot(record) {
    return {
      receiptId:String(record?.receiptId || ''),
      bookingId:String(record?.bookingId || ''),
      reviewStatus:String(record?.reviewStatus || ''),
      serviceMinutes:Math.max(0, Number(record?.serviceMinutes || 0)),
      points:Math.max(0, Number(record?.points || 0)),
      services:(Array.isArray(record?.services) ? record.services : []).map((item) => ({
        serviceId:String(item?.serviceId || ''),
        title:String(item?.title || ''),
        minutes:Math.max(0, Number(item?.minutes || 0)),
        quantity:Math.max(0, Number(item?.quantity || 0))
      })),
      benefits:(Array.isArray(record?.benefits) ? record.benefits : []).map((item) => ({
        kind:String(item?.kind || ''),
        title:String(item?.title || ''),
        status:String(item?.status || '')
      }))
    };
  }

  async function adminBookingAccessibleReviewCase() {
    await openAdminBookingQueue('pending');
    const mode = await waitFor(() => document.getElementById('bookingAdminAccessibleMode'), 5000);
    await adminHumanClick(mode, '快照審核模式');

    const initial = await adminBookingReceiptRequest('admin.booking.receipt.list');
    const runStartedMs = new Date(state.runStartedAt || 0).getTime();
    const currentRunFloor = Number.isFinite(runStartedMs) ? runStartedMs - 5 * 60 * 1000 : 0;
    const pending = (Array.isArray(initial?.accessibleRecords) ? initial.accessibleRecords : []).find((record) => {
      const createdAt = new Date(record?.createdAt || 0).getTime();
      return record?.reviewStatus === 'pending'
        && participantForAccessibleRecord(record)
        && (!currentRunFloor || (Number.isFinite(createdAt) && createdAt >= currentRunFloor));
    });
    if (!pending) {
      return fail('本輪測試會員沒有留下可供管理端審核的快照收據。', {
        currentRunPendingAccessibleReceipt:true
      }, {
        pendingCount:(initial?.accessibleRecords || []).filter((record) => record?.reviewStatus === 'pending').length
      });
    }

    const participant = participantForAccessibleRecord(pending);
    if (!participant) {
      return fail('快照收據無法對應本輪測試會員。', {
        ownedByCurrentTestParticipant:true
      }, { memberCode:String(pending.memberCode || '') });
    }

    const fixtureResult = await bookingUserQaFixtureRequest(participant, 'user.qa.fixture.prepare');
    const fixture = fixtureResult.data || {};
    if (!fixture.ticketId || !fixture.fixtureTag) {
      return fail('無法建立快照審核專用集點卡票券 Fixture。', {
        pointTicketFixture:true
      }, { fixtureReady:false });
    }
    state.accessibleReviewEvidence = {
      receiptId:String(pending.receiptId || ''),
      participantIndex:Number(participant.index || 0),
      registerPayload:null,
      fixtureTag:String(fixture.fixtureTag || ''),
      testSessionToken:String(fixtureResult.login?.testSessionToken || ''),
      beforeReplay:null
    };

    const refreshed = await adminBookingReceiptRequest('admin.booking.receipt.list');
    window.dispatchEvent(new CustomEvent('admin:accessible-receipts-updated', {
      detail:{
        submissions:Array.isArray(refreshed?.submissions) ? refreshed.submissions : [],
        records:Array.isArray(refreshed?.accessibleRecords) ? refreshed.accessibleRecords : []
      }
    }));
    document.querySelector('[data-accessible-filter="pending"]')?.click();

    const selector = '#accessibleAdminQueueList [data-receipt-id="' + CSS.escape(String(pending.receiptId || '')) + '"]';
    const card = await waitFor(() => document.querySelector(selector), 5000);
    if (!card) throw new Error('管理端快照待確認清單找不到本輪收據。');
    await adminHumanClick(card.querySelector('.accessible-admin-review-button'), '開始審核');

    const modal = await waitFor(() => {
      const node = document.getElementById('accessibleAdminModal');
      return node && !node.classList.contains('hidden') && node.dataset.receiptId === String(pending.receiptId || '') ? node : null;
    }, 7000);
    if (!modal) throw new Error('快照審核視窗未開啟。');
    if (!await waitFor(() => {
      const submit = document.getElementById('accessibleAdminSubmit');
      return submit && !submit.disabled && document.querySelectorAll('#accessibleAdminItems [data-service-check]').length ? submit : null;
    }, 10000)) {
      throw new Error('快照審核服務選項尚未載入完成。');
    }

    const serviceRows = Array.from(document.querySelectorAll('#accessibleAdminItems .accessible-admin-item'));
    const rewardRow = serviceRows.find((row) => /每\s+\d+\s+分鐘集\s+1\s+點/.test(String(row.textContent || '')));
    if (!rewardRow) {
      return fail('目前服務資料沒有可驗證自動集點的服務類型，無法宣告快照點數結算 E2E 完整。', {
        rewardServiceAvailable:true
      }, { serviceRows:serviceRows.length });
    }
    const rewardMatch = String(rewardRow.textContent || '').match(/每\s+(\d+)\s+分鐘集\s+1\s+點/);
    const rewardMinutes = Math.max(1, Number(rewardMatch?.[1] || 0));
    if (!Number.isInteger(rewardMinutes) || rewardMinutes > 720) {
      throw new Error('快照審核的自動集點分鐘規則超出可測試範圍。');
    }
    const serviceCheck = rewardRow.querySelector('[data-service-check]');
    await adminHumanClick(serviceCheck, '實際完成服務');
    await adminHumanTextInput(rewardRow.querySelector('[data-minutes]'), String(rewardMinutes), '實際服務分鐘');
    await adminHumanTextInput(rewardRow.querySelector('[data-quantity]'), '1', '服務次數');

    const yesterday = new Intl.DateTimeFormat('en-CA', {
      timeZone:'Asia/Taipei', year:'numeric', month:'2-digit', day:'2-digit'
    }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));
    if (!setField('accessibleAdminDate', yesterday) || !setField('accessibleAdminTime', '09:00')) {
      throw new Error('快照審核日期或時間欄位未載入。');
    }
    await adminHumanPause(80, 180);

    const ticketSelector = '#accessibleAdminBenefits [data-benefit-check][data-kind="points"][data-selection-id="' +
      CSS.escape(String(fixture.ticketId || '')) + '"]';
    const ticket = await waitFor(() => {
      const node = document.querySelector(ticketSelector);
      return node && !node.disabled ? node : null;
    }, 7000);
    if (!ticket) {
      return fail('快照審核專用集點卡票券沒有出現在可審核清單，或被錯誤禁用。', {
        pointTicketSelectable:true
      }, { ticketId:String(fixture.ticketId || '') });
    }
    await adminHumanClick(ticket, '集點卡票券');
    if (!ticket.checked) throw new Error('集點卡票券真人勾選後未保持選取。');

    const note = 'QA ACCESSIBLE REVIEW ' + qaCrudStamp();
    await adminHumanTextInput(document.getElementById('accessibleAdminNote'), note, '快照審核備註');

    const registerPayload = {
      receiptId:String(pending.receiptId || ''),
      expectedUpdatedAt:String(pending.updatedAt || ''),
      bookingId:'',
      bookingDate:String(document.getElementById('accessibleAdminDate')?.value || ''),
      startTime:String(document.getElementById('accessibleAdminTime')?.value || ''),
      items:[{
        serviceId:String(rewardRow.dataset.serviceId || ''),
        minutes:Number(rewardRow.querySelector('[data-minutes]')?.value || 0),
        quantity:Number(rewardRow.querySelector('[data-quantity]')?.value || 0)
      }],
      benefits:[{kind:'points',id:String(fixture.ticketId || '')}],
      adminNote:note
    };

    const pointSummaryBefore = String(document.getElementById('accessibleAdminPointSummary')?.textContent || '').trim();
    await adminHumanClick(document.getElementById('accessibleAdminSubmit'), '確認並完成審核');
    const completed = await waitAccessibleReceiptRecord(
      pending.receiptId,
      (record) => record?.reviewStatus === 'completed' && Boolean(record?.bookingId),
      22000
    );
    const modalClosed = Boolean(await waitFor(() => document.getElementById('accessibleAdminModal')?.classList.contains('hidden'), 5000));
    const completedTicket = (Array.isArray(completed?.benefits) ? completed.benefits : []).find((benefit) =>
      benefit?.kind === 'points'
      && String(benefit?.title || '').includes(String(fixture.ticketTitle || 'QA 預約自動核銷票券'))
      && ['redeemed','applied'].includes(String(benefit?.status || ''))
    );
    const completedService = (Array.isArray(completed?.services) ? completed.services : []).find((service) =>
      String(service?.serviceId || '') === String(rewardRow.dataset.serviceId || '')
    );
    const actual = {
      receiptId:String(pending.receiptId || ''),
      participantIndex:Number(participant.index || 0),
      modalClosed,
      reviewStatus:String(completed?.reviewStatus || ''),
      bookingId:String(completed?.bookingId || ''),
      serviceMinutes:Number(completed?.serviceMinutes || 0),
      rewardPoints:Number(completed?.points || 0),
      serviceRecorded:Boolean(completedService),
      ticketRedeemed:Boolean(completedTicket),
      pointBudgetRendered:/本次扣除|審核後剩餘/.test(pointSummaryBefore),
      completedFilterSelected:document.querySelector('[data-accessible-filter="completed"]')?.getAttribute('aria-selected') === 'true'
    };
    const ok = actual.modalClosed
      && actual.reviewStatus === 'completed'
      && Boolean(actual.bookingId)
      && actual.serviceMinutes >= rewardMinutes
      && actual.rewardPoints >= 1
      && actual.serviceRecorded
      && actual.ticketRedeemed
      && actual.pointBudgetRendered
      && actual.completedFilterSelected;

    state.accessibleReviewEvidence = {
      ...(state.accessibleReviewEvidence || {}),
      receiptId:String(pending.receiptId || ''),
      participantIndex:Number(participant.index || 0),
      registerPayload,
      fixtureTag:String(fixture.fixtureTag || ''),
      testSessionToken:String(fixtureResult.login?.testSessionToken || ''),
      beforeReplay:accessibleSettlementSnapshot(completed)
    };

    return ok
      ? pass('已像真人完成快照審核：收據、實際服務、集點卡票券、點數與完成狀態均由正式流程結算。', {
          reviewStatus:'completed',
          rewardPointsAtLeast:1,
          ticketRedeemed:true,
          completedUi:true
        }, actual)
      : fail('快照真人審核完成後，服務、票券、點數或 UI 終態至少一項不一致。', {
          reviewStatus:'completed',
          rewardPointsAtLeast:1,
          ticketRedeemed:true,
          completedUi:true
        }, actual);
  }

  async function adminBookingAccessibleIdempotencyCase() {
    const evidence = state.accessibleReviewEvidence;
    if (!evidence?.receiptId || !evidence?.registerPayload) {
      let fixtureCleanup = false;
      let cleanupError = '';
      if (evidence?.fixtureTag && evidence?.testSessionToken) {
        try {
          const cleanup = await postFunction('user-test-api', {
            action:'user.qa.fixture.cleanup',
            surface:'booking',
            idToken:'',
            testSessionToken:evidence.testSessionToken,
            fixtureTag:evidence.fixtureTag
          });
          fixtureCleanup = cleanup?.cleaned === true;
        } catch (error) {
          cleanupError = String(error?.code || error?.message || 'cleanup-failed').slice(0, 160);
        }
      }
      state.accessibleReviewEvidence = null;
      return fail('缺少前一個快照審核案例的完成證據，已嘗試清理其 QA Fixture，無法驗證重送冪等。', {
        completedAccessibleReviewEvidence:true,
        fixtureCleanup:true
      }, { evidenceReady:false, fixtureCleanup, cleanupError });
    }

    const before = await waitAccessibleReceiptRecord(evidence.receiptId, (record) => record?.reviewStatus === 'completed', 5000);
    const replay = await adminBookingReceiptRequest('admin.booking.receipt.register', evidence.registerPayload);
    const after = await waitAccessibleReceiptRecord(evidence.receiptId, (record) => record?.reviewStatus === 'completed', 5000);
    const beforeSnapshot = accessibleSettlementSnapshot(before);
    const afterSnapshot = accessibleSettlementSnapshot(after);
    const settlementUnchanged = JSON.stringify(beforeSnapshot) === JSON.stringify(afterSnapshot);
    let fixtureCleanup = false;
    let cleanupError = '';
    if (evidence.fixtureTag && evidence.testSessionToken) {
      try {
        const cleanup = await postFunction('user-test-api', {
          action:'user.qa.fixture.cleanup',
          surface:'booking',
          idToken:'',
          testSessionToken:evidence.testSessionToken,
          fixtureTag:evidence.fixtureTag
        });
        fixtureCleanup = cleanup?.cleaned === true;
      } catch (error) {
        cleanupError = String(error?.code || error?.message || 'cleanup-failed').slice(0, 160);
      }
    }
    const actual = {
      alreadyApplied:replay?.alreadyApplied === true,
      sameBookingId:String(replay?.bookingId || '') === String(beforeSnapshot.bookingId || ''),
      settlementUnchanged,
      before:beforeSnapshot,
      after:afterSnapshot,
      fixtureCleanup,
      cleanupError
    };
    const ok = actual.alreadyApplied && actual.sameBookingId && actual.settlementUnchanged && actual.fixtureCleanup;
    state.accessibleReviewEvidence = null;
    return ok
      ? pass('同一張快照收據重送正式 register API 只回傳既有結算，不會重複服務時間、集點或票券核銷。', {
          alreadyApplied:true,
          settlementUnchanged:true,
          fixtureCleanup:true
        }, actual)
      : fail('快照審核重送後發現重複結算風險，或測試 Fixture 未清理完成。', {
          alreadyApplied:true,
          settlementUnchanged:true,
          fixtureCleanup:true
        }, actual);
  }

  async function adminBookingAccessibleQueueCase() {
    document.getElementById('bookingTab')?.click();
    const mode = await waitFor(() => document.getElementById('bookingAdminAccessibleMode'), 4000);
    const originalMode = document.getElementById('bookingAdminQueuePanel')?.getAttribute('data-queue-mode') || 'normal';
    const originalFilter = document.querySelector('[data-accessible-filter][aria-selected="true"]')?.dataset.accessibleFilter || 'pending';
    const session = await adminSession();
    const data = await postFunction('booking-receipt-api',{action:'admin.booking.receipt.list',clientType:'admin',idToken:session.idToken});
    const checks = [];
    try {
      mode?.click();
      for (const filter of ['pending','completed','all']) {
        const tab = document.querySelector('[data-accessible-filter="' + filter + '"]');
        tab?.click();
        checks.push({filter,selected:tab?.getAttribute('aria-selected') === 'true',queueVisible:!document.getElementById('accessibleAdminQueue')?.classList.contains('hidden')});
      }
    } finally {
      document.querySelector('[data-accessible-filter="' + originalFilter + '"]')?.click();
      if (originalMode !== 'accessible') document.getElementById('bookingAdminStandardMode')?.click();
    }
    const actual = { recordsArray:Array.isArray(data.accessibleRecords), checks };
    return actual.recordsArray && checks.every(item => item.selected && item.queueVisible)
      ? pass('快照紀錄可讀取，三個狀態篩選可操作並還原。', {recordsArray:true,filters:3}, actual)
      : fail('快照列表或狀態篩選異常。', {recordsArray:true,filters:3}, actual);
  }

  async function adminBookingHistoryTicketSourcesCase() {
    document.getElementById('bookingTab')?.click();
    const cards = Array.from(document.querySelectorAll('#bookingPanel .booking-ticket-card'));
    if (!cards.length) return skip('管理端目前沒有帶票券的預約卡片。', { ticketCards:true }, {blockerCode:'E2E_BOOKING_BENEFITS_HISTORY_MISSING'});
    const malformed = cards.filter(card => !card.querySelector('.booking-ticket-kind') ||
      !card.querySelector('.booking-ticket-status') || !card.querySelector('.booking-ticket-field strong') ||
      (card.classList.contains('kind-points') && !card.querySelector('.booking-ticket-source strong')));
    return !malformed.length
      ? pass('管理端票券卡片具有種類、狀態、票券名稱與來源集點卡。', {malformed:0}, {cards:cards.length,malformed:malformed.length})
      : fail('管理端票券來源卡片缺少必要欄位。', {malformed:0}, {cards:cards.length,malformed:malformed.length});
  }

  async function adminBookingResourceControlsCase() {
    document.getElementById('bookingTab')?.click();
    const active = await waitFor(() => document.getElementById('bookingAdminTechnicianActiveTab'),4000);
    const disabled = document.getElementById('bookingAdminTechnicianDisabledTab');
    const original = active?.getAttribute('aria-selected') !== 'false';
    const checks = [];
    try {
      for (const button of [disabled,active]) { button?.click();checks.push(Boolean(button?.classList.contains('active') || button?.getAttribute('aria-selected') === 'true')); }
      document.getElementById('bookingAdminNewTechnicianButton')?.click();
      const modal = document.getElementById('bookingAdminTechnicianModal');
      checks.push(Boolean(modal && !modal.classList.contains('hidden')));
      document.getElementById('bookingAdminTechnicianModalCancel')?.click();
      checks.push(Boolean(modal?.classList.contains('hidden')));
      const required = document.getElementById('bookingAdminRequirePrimaryTechnician');
      const previous = required?.checked;
      required?.click();checks.push(Boolean(required && required.checked !== previous));
      required?.click();checks.push(Boolean(required && required.checked === previous));
    } finally { (original ? active : disabled)?.click(); }
    return checks.every(Boolean)
      ? pass('技師列表可切換，新增視窗可以取消而不建立資料。', {allChecks:true}, {checks})
      : fail('技師狀態列表或新增取消流程異常。', {allChecks:true}, {checks});
  }

  async function adminForceLogoutSecurityCase() {
    return pairedForceLogoutRevocationCase();
  }

  async function adminEventDailyLimitSettingsCase() {
    document.getElementById('eventsTab')?.click();
    const input = await waitFor(() => document.getElementById('eventMaxTicketsPerDay'), 4000);
    const save = document.getElementById('saveEventTicketSettingButton');
    const session = await adminSession();
    const server = await postFunction('event-ticket-extension-api', {
      operation: 'admin.settings.get',
      idToken: session.idToken
    });
    const serverLimit = Number(server?.maxTicketsPerDay ?? server?.maxTicketsPerRedemption ?? 0);
    const uiLimit = Number(input?.value || 0);
    const actual = {
      input: Boolean(input),
      saveButton: Boolean(save),
      serverLimit,
      uiLimit,
      matched: serverLimit === uiLimit,
      validRange: Number.isInteger(serverLimit) && serverLimit >= 0 && serverLimit <= 50,
      labelUsesDailySemantics: /每日最多使用活動票券數/.test(String(input?.labels?.[0]?.textContent || input?.closest('label')?.textContent || ''))
    };
    return actual.input && actual.saveButton && actual.matched && actual.validRange && actual.labelUsesDailySemantics
      ? pass('管理端活動票券每日使用上限與 Server 設定一致，且 UI 使用「每日」語意而非單次勾選。', {
          input: true, saveButton: true, matched: true, validRange: true, labelUsesDailySemantics: true
        }, actual)
      : fail('活動票券每日使用上限的管理端 UI／Server 契約不一致。', {
          input: true, saveButton: true, matched: true, validRange: true, labelUsesDailySemantics: true
        }, actual);
  }

  async function adminBookingReceiptViewerCase() {
    const tab = await waitFor(() => document.getElementById('bookingTab'), 6000);
    tab?.click();
    const modal = await waitFor(() => document.getElementById('adminBookingReceiptModal'), 5000);
    const session = await adminSession();
    const data = await postFunction('booking-receipt-api', {
      action: 'admin.booking.receipt.list',
      clientType: 'admin',
      idToken: session.idToken
    });
    const receipts = Array.isArray(data?.receipts) ? data.receipts : [];
    window.dispatchEvent(new CustomEvent('member-admin-data-refreshed'));
    await sleep(150);
    const viewerButtons = Array.from(document.querySelectorAll('[data-admin-booking-receipt-control]'));
    const forbidden = modal ? Array.from(modal.querySelectorAll('button')).filter((button) =>
      /確認收據並完成預約|確認服務完成|完成並結算/.test(String(button.textContent || ''))
    ) : [];
    const actual = {
      bookingTab: Boolean(tab),
      modal: Boolean(modal),
      receiptsArray: Array.isArray(data?.receipts),
      receiptCount: receipts.length,
      awaitingOrBound: receipts.filter((row) => ['awaiting_review', 'bound'].includes(String(row?.status || ''))).length,
      viewerButtons: viewerButtons.length,
      forbiddenCompletionButtons: forbidden.length,
      imageElement: Boolean(document.getElementById('adminBookingReceiptImage')),
      summaryElement: Boolean(document.getElementById('adminBookingReceiptSummary'))
    };
    const ok = actual.bookingTab && actual.modal && actual.receiptsArray &&
      actual.forbiddenCompletionButtons === 0 && actual.imageElement && actual.summaryElement;
    return ok
      ? pass('管理端預約收據節點已驗證安全清單與唯讀快照 Viewer；完成預約仍由 canonical 預約流程負責。', {
          bookingTab: true, modal: true, receiptsArray: true,
          forbiddenCompletionButtons: 0, imageElement: true, summaryElement: true
        }, actual)
      : fail('管理端收據 Viewer 或完成責任邊界不符合目前規格。', {
          bookingTab: true, modal: true, receiptsArray: true,
          forbiddenCompletionButtons: 0, imageElement: true, summaryElement: true
        }, actual);
  }

  async function adminFeatureContractCoverageCase() {
    await waitFor(() => document.getElementById('bookingPanel'), 6000);
    const contracts = [
      ['themeToggle', '#themeToggleButton'],
      ['opsOverview', '#opsOverviewTitle'],
      ['tierSettings', '#tierSettingsForm'],
      ['memberSearch', '#memberSearch'],
      ['memberPagination', '#memberPagination'],
      ['messagePresetDialog', '#messagePresetModal'],
      ['grantDialog', '#grantModal'],
      ['calendarBatch', '#calendarBatchRows'],
      ['testEnvironment', '#testModeForm'],
      ['testAccounts', '#testModeAccountList'],
      ['testControlCenter', '.test-control-center'],
      ['bookingWorkspace', '#bookingPanel'],
      ['bookingSharedSettings', '#bookingAdminSettingsForm'],
      ['bookingWorkingHours', '#bookingAdminStartTime'],
      ['bookingAdvanceMinimum', '#bookingAdminAdvanceDays'],
      ['bookingAdvanceMaximum', '#bookingAdminMaxAdvanceDays'],
      ['bookingStoreServiceMinutes', '#bookingAdminStoreServiceMinutes'],
      ['bookingNotice', '#bookingAdminNotice'],
      ['integrationCenter', '#operationsHubPanel'],
      ['integrationMetrics', '#integrationMetricGrid'],
      ['integrationPointSources', '#integrationPointSources'],
      ['integrationBenefits', '#integrationBenefitSummary'],
      ['integrationNotifications', '#integrationNotifications'],
      ['integrationAuditTimeline', '#integrationAuditTimeline'],
      ['eventDailyLimit', '#eventMaxTicketsPerDay'],
      ['bookingReceiptViewer', '#adminBookingReceiptModal']
    ];
    const missing = contracts.filter(([, selector]) => !document.querySelector(selector)).map(([key, selector]) => ({ key, selector }));
    const actual = { contractCount: contracts.length, missing };
    return missing.length === 0
      ? pass('主要非按鈕 DOM 契約存在；操作結果由各功能節點與覆蓋摘要判定。', { missing: [] }, actual)
      : fail('管理端發現未掛入 E2E 的功能區塊。', { missing: [] }, actual);
  }

  async function adminButtonCoverageCase() {
    const buttons = Array.from(document.querySelectorAll('#adminView button, body > .modal button, #bookingPanel button'));
    const explicitCaseByButtonId = new Map([
      ['bookingAdminSaveSettingsButton', 'ADMIN_BOOKING_SHARED_SETTINGS'],
      ['saveEventTicketSettingButton', 'ADMIN_EVENT_DAILY_LIMIT_SETTINGS'],
      ['adminBookingReceiptClose', 'ADMIN_BOOKING_RECEIPT_VIEWER']
    ]);
    const registeredCaseKeys = new Set(adminDefinitions('full', E2E_MODULES.map(([key]) => key)).map((item) => item.key));
    const unmapped = [];
    const mapped = [];
    for (const button of buttons) {
      const id = String(button.id || '');
      const datasets = Object.keys(button.dataset || {});
      const explicitCase = explicitCaseByButtonId.get(id) || '';
      const accepted = explicitCase
        ? registeredCaseKeys.has(explicitCase)
        : Boolean(id && /^(previewServiceGrant|copySettings|retry|logout|members|cards|events|calendar|testMode|refresh|tier|manageGrant|saveTier|realMembers|testMembers|member|card|ticket|event|adminCalendar|saveTestMode|deleteSelectedTestAccounts|purgeTestData|close|cancel|save|grant|messagePreset|booking|runPaired|add|queue|delete|clear|new|reset|archive|balance|fixedTicket)/i.test(id)) ||
          datasets.length > 0 ||
          button.classList.contains('editor-modal-close') ||
          button.classList.contains('close-button');
      const key = id || datasets.map((key) => 'data-' + key).join(',') || button.textContent?.trim().slice(0, 60) || '[button]';
      (accepted ? mapped : unmapped).push(key);
    }
    const actual = { totalButtons: buttons.length, mapped: mapped.length, unmapped };
    return unmapped.length === 0
      ? pass('管理端按鈕已分類；按鈕名稱與 data 屬性不作為行為通過證據。', { unmapped: [] }, actual)
      : fail('發現尚未納入管理端 E2E 覆蓋分類的新控制。', { unmapped: [] }, actual);
  }

  function selectedParticipantCount() {
    const input = state.section?.querySelector('#pairedE2EAccountCount');
    const count = Number(input?.value || 1);
    if (!Number.isInteger(count) || count < 1 || count > MAX_PAIRED_PARTICIPANTS) {
      const error = new Error(`協同測試人數必須是 1–${MAX_PAIRED_PARTICIPANTS} 的整數。`);
      error.code = 'INVALID_PAIRED_PARTICIPANT_COUNT';
      throw error;
    }
    return count;
  }

  function selectedClientMobileViewport() {
    return Boolean(state.section?.querySelector('#pairedE2EMobileViewport')?.checked);
  }

  function clientWindowFeatureString(mobileViewport, participantIndex) {
    const size = mobileViewport ? CLIENT_MOBILE_VIEWPORT : CLIENT_DESKTOP_POPUP;
    const left = 36 + (((Math.max(1, Number(participantIndex || 1)) - 1) * 38) % 260);
    const top = 42 + (((Math.max(1, Number(participantIndex || 1)) - 1) * 28) % 220);
    return [
      'popup=yes',
      'width=' + size.width,
      'height=' + size.height,
      'left=' + left,
      'top=' + top,
      'resizable=yes',
      'scrollbars=yes'
    ].join(',');
  }

  function applyClientWindowSize(child, mobileViewport) {
    if (!mobileViewport || !child || child.closed) return;
    try { child.resizeTo(CLIENT_MOBILE_VIEWPORT.width, CLIENT_MOBILE_VIEWPORT.height); } catch {}
  }

  function participantWindowList(participant) {
    return participant?.window && !participant.window.closed ? [participant.window] : [];
  }

  function participantWindow(participant) {
    return participant?.window || null;
  }

  function closeClientWindows() {
    closeWindowList(state.clientWindows);
    state.clientWindows = [];
  }

  function openClientWindows(count, track = true, mobileViewport = false) {
    const opened = [];
    const stamp = Date.now();
    for (let index = 0; index < count; index += 1) {
      const child = window.open(
        'about:blank',
        `member-e2e-${stamp}-${index + 1}`,
        clientWindowFeatureString(mobileViewport, index + 1)
      );
      if (!child) {
        closeWindowList(opened);
        const error = new Error(`瀏覽器阻擋了第 ${index + 1} 個測試帳號背景視窗。請允許此網站開啟彈出式視窗後重試。`);
        error.code = 'E2E_POPUP_BLOCKED';
        throw error;
      }
      try {
        child.document.title = `Lumen Club E2E · 測試用戶 ${index + 1}`;
        child.document.body.innerHTML =
          '<main style="font-family:system-ui,sans-serif;padding:28px;line-height:1.7">' +
          '<h1>測試用戶 ' + (index + 1) + ' / ' + count + ' · E2E 準備中</h1>' +
          '<p>此測試帳號使用專屬背景視窗；協同 Runner 啟動後會立即進入本輪勾選的用戶端流程。</p>' +
          (mobileViewport ? '<p>Viewport 目標：430×932。</p>' : '') +
          '</main>';
      } catch {}
      applyClientWindowSize(child, mobileViewport);
      opened.push(child);
    }
    if (track) {
      state.clientWindows = opened;
      state.clientMobileViewport = Boolean(mobileViewport);
    }
    return opened;
  }

  function renderParticipants() {
    if (!state.participantList) return;
    const participants = Array.isArray(state.participants) ? state.participants : [];
    state.participantList.classList.toggle('hidden', participants.length === 0);
    state.participantList.replaceChildren(...participants.map((participant) => {
      const card = document.createElement('div');
      card.className = 'admin-e2e-participant';
      const identity = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `測試用戶 ${participant.index}`;
      const code = document.createElement('small');
      code.textContent = String(participant.account?.memberCode || '準備中');
      identity.append(title, code);
      const status = document.createElement('span');
      const viewport = participant.mobileViewport ? '手機 430×932' : '桌面';
      status.textContent = `${participant.status || '準備中'} · ${participant.surface || '—'} · 1 Runner · ${viewport}` +
        (participant.adminStatus ? ` · 管理端：${participant.adminStatus}` : '');
      card.append(identity, status);
      return card;
    }));
  }

  async function postAdminTestMode(action, payload = {}) {
    const session = await adminSession();
    return postFunction('test-mode-api', {
      ...payload,
      action,
      clientType: 'admin',
      idToken: session.idToken
    });
  }

  function activeTestAccounts(data) {
    return (Array.isArray(data?.accounts) ? data.accounts : []).filter((account) =>
      account?.status === 'active' && account?.membershipStatus === 'active' && account?.memberId
    );
  }

  async function prepareTestAccounts(count, preferredMemberIds = []) {
    let data = await postAdminTestMode('admin.test-mode.bootstrap');
    let accounts = activeTestAccounts(data).filter((account) => !Array.isArray(account.activeSurfaces) || account.activeSurfaces.length === 0);
    if (accounts.length < count) {
      const shortage = count - accounts.length;
      const settings = data?.settings || {};
      await postAdminTestMode('admin.test-mode.save', {
        maintenanceEnabled: Boolean(settings.maintenanceEnabled),
        allowPcTestLogin: Boolean(settings.allowPcTestLogin),
        allowMobileTestLogin: Boolean(settings.allowMobileTestLogin),
        maintenanceMessage: String(settings.maintenanceMessage || ''),
        addAccountCount: shortage
      });
      data = await postAdminTestMode('admin.test-mode.bootstrap');
      accounts = activeTestAccounts(data).filter((account) => !Array.isArray(account.activeSurfaces) || account.activeSurfaces.length === 0);
    }
    if (accounts.length < count) throw new Error(`可供協同測試且尚未登入任何用戶端的測試用戶不足：需要 ${count} 位，目前只有 ${accounts.length} 位。`);
    const byId = new Map(accounts.map((account) => [String(account.memberId || ''), account]));
    const preferred = [];
    for (const memberId of Array.isArray(preferredMemberIds) ? preferredMemberIds : []) {
      const account = byId.get(String(memberId || ''));
      if (account && !preferred.includes(account)) preferred.push(account);
    }
    const preferredSet = new Set(preferred.map((account) => String(account.memberId || '')));
    const selected = preferred.concat(shuffled(accounts.filter((account) => !preferredSet.has(String(account.memberId || ''))))).slice(0, count);
    const session = await adminSession();
    const consent = await postFunction('test-control-api', {
      action: 'admin.test-control.prepare-test-account-consents',
      clientType: 'admin',
      idToken: session.idToken,
      memberIds: selected.map((account) => String(account.memberId || '')).filter(Boolean)
    });
    const currentConsentCount = Number(consent?.currentConsentCount || 0);
    if (currentConsentCount !== selected.length) {
      const error = new Error('測試會員條款前置未完成：需要 ' + selected.length + ' 位，目前 ' + currentConsentCount + ' 位。');
      error.code = 'E2E_TEST_MEMBER_CONSENT_NOT_READY';
      throw error;
    }
    return selected;
  }

  async function acquireE2ECleanupLease() {
    const session = await adminSession();
    const data = await postFunction('test-control-api', {
      action: 'admin.test-control.acquire-e2e-lease',
      clientType: 'admin',
      idToken: session.idToken
    });
    const leaseId = String(data?.leaseId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(leaseId)) {
      const error = new Error('完整 E2E 執行鎖建立失敗，已停止以避免測試資料與清除流程互相干擾。');
      error.code = 'E2E_LEASE_INVALID';
      throw error;
    }
    return leaseId;
  }

  async function recyclePreviousE2ERuntime(leaseId) {
    const session = await adminSession();
    const data = await postFunction('test-control-api', {
      action: 'admin.test-control.recycle-e2e-runtime',
      clientType: 'admin',
      idToken: session.idToken,
      leaseId: String(leaseId || '')
    });
    if (data?.recycle?.cleanupComplete !== true) {
      const error = new Error('前一輪 E2E 測試資料未清理完成，已停止本輪測試。');
      error.code = 'E2E_RECYCLE_INCOMPLETE';
      throw error;
    }
    return data.recycle;
  }

  async function releaseE2ECleanupLease(leaseId) {
    const normalized = String(leaseId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(normalized)) return false;
    try {
      const session = await adminSession();
      const data = await postFunction('test-control-api', {
        action: 'admin.test-control.release-e2e-lease',
        clientType: 'admin',
        idToken: session.idToken,
        leaseId: normalized
      });
      return data?.released === true;
    } catch {
      return false;
    }
  }

  async function heartbeatE2ECleanupLease(leaseId) {
    const normalized = String(leaseId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(normalized)) return false;
    const session = await adminSession();
    const data = await postFunction('test-control-api', {
      action: 'admin.test-control.heartbeat-e2e-lease',
      clientType: 'admin',
      idToken: session.idToken,
      leaseId: normalized
    });
    return data?.renewed === true;
  }

  async function prepareComplexE2EFixtures(profile = {}, leaseId = '') {
    const session = await adminSession();
    const runTag = 'PAIR-' + Date.now().toString(36).toUpperCase() + '-' + randomInt(1000, 9999);
    const data = await postFunction('test-control-api', {
      action: 'admin.test-control.prepare-e2e-fixtures',
      clientType: 'admin',
      idToken: session.idToken,
      runTag,
      leaseId: String(leaseId || ''),
      complexityLevel: Number(profile.complexityLevel || state.complexityLevel || 1),
      seed: String(profile.seed || state.randomSeed || '')
    });
    const fixture = data?.fixture || {};
    const primaryTechnicianId = String(fixture.primaryTechnicianId || '').trim();
    const maxPartySize = Number(fixture.maxPartySize || 0);
    const ready = Number(fixture.ticketTemplates || 0) >= 4 &&
      Number(fixture.pointCards || 0) >= 3 &&
      Number(fixture.pointRewardNodes || 0) >= 6 &&
      Number(fixture.eventTickets || 0) >= 6 &&
      Number(fixture.calendarItems || 0) >= 5 &&
      Number(fixture.fixedTickets || 0) >= 4 &&
      Number(fixture.bookingServices || 0) >= 4 &&
      Number(fixture.bookingTechnicians || 0) >= 3 &&
      Boolean(primaryTechnicianId) &&
      maxPartySize >= 2;
    if (!ready) {
      const error = new Error('管理端高複雜度 E2E 前置資料建立不完整（包含主要技師／多人預約設定），已禁止用戶端開始測試。');
      error.code = 'E2E_FIXTURE_INCOMPLETE';
      error.fixture = fixture;
      throw error;
    }
    state.results.push({
      key: 'PAIRED_COMPLEX_FIXTURE_PREPARE',
      name: '管理端：建立完整高複雜度測試資料',
      domain: 'Paired E2E / Fixture',
      status: 'passed',
      message: '已完成票券種類、固定票券週期與效期、集點節點、活動日期、會員階級、日曆與預約資源前置資料；現在才允許用戶端開始。',
      expected: {
        ticketTypes: ['coupon', 'lottery', 'fixed'],
        fixedSchedules: ['birthday_month', 'yearly', 'monthly', 'weekly'],
        eventDateStates: ['past', 'today', 'active-window', 'future'],
        membershipTiers: ['general', 'silver', 'gold', 'platinum'],
        minimumPointNodes: 6,
        primaryTechnicianConfigured: true,
        maxPartySizeAtLeast: 2
      },
      actual: safe(fixture),
      durationMs: 0
    });
    render();
    return fixture;
  }

  function reusablePairedSession(participant, surface) {
    const cached = participant?.surfaceLogins?.[surface] || (
      participant?.lastSurfaceKey === surface ? participant?.login : null
    );
    if (!cached?.testSessionToken) return null;
    if (cached?.account?.memberId &&
        String(cached.account.memberId) !== String(participant?.account?.memberId || '')) return null;
    if (String(cached.surface || surface) !== String(surface || '')) return null;
    const expiresAt = new Date(cached.expiresAt || 0).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30000) return null;
    return cached;
  }

  async function createPairedSession(account, surface = 'member') {
    const session = await adminSession();
    if (!account?.memberId) throw new Error('測試用戶識別不完整。');
    if (!PAIRED_SURFACES.some(([key]) => key === surface)) throw new Error('協同 E2E 用戶端類型不正確。');
    const common = { clientType: surface };
    const status = await postPublicTestMode(session, { action: 'public.status', ...common });
    if (!status.maintenanceEnabled) {
      const error = new Error('協同 E2E 需要先啟用「系統維護」，以確保正式用戶不會進入測試流程。');
      error.code = 'TEST_MAINTENANCE_REQUIRED';
      throw error;
    }
    // A previous member E2E surface can activate a newer, member-targeted
    // terms fixture after the initial account preflight. Re-evaluate the
    // effective terms before each non-member surface starts.
    if (surface !== 'member') {
      const consent = await prepareEphemeralConsents([account]);
      if (Number(consent?.currentConsentCount ?? 0) !== 1) {
        const error = new Error('測試會員條款已變更，無法完成本用戶端前置檢查。');
        error.code = 'E2E_TEST_MEMBER_CONSENT_NOT_READY';
        throw error;
      }
    }
    const login = await postPublicTestMode(session, {
      action: 'test-mode.login',
      ...common,
      memberId: account.memberId
    });
    if (!login.testSessionToken || login.account?.memberId !== account.memberId || String(login.surface || surface) !== surface) {
      throw new Error('指定測試用戶 Session 建立不完整、帳號不一致或用戶端類型不一致。');
    }
    return login;
  }



  function seedParticipantSession(participant, login, surface = '') {
    const surfaceKey = String(surface || login?.surface || participant?.lastSurfaceKey || 'member');
    const child = participant?.window;
    if (!child || child.closed) throw new Error(`測試用戶 ${participant?.index || '?'} 的背景視窗已關閉，無法建立 ${surfaceKey} Session。`);
    try {
      child.sessionStorage.setItem(TEST_SESSION_STORAGE_KEY, JSON.stringify({
        token: String(login.testSessionToken),
        expiresAt: new Date(login.expiresAt).getTime()
      }));
    } catch {
      throw new Error('無法把測試 Session 寫入測試帳號背景視窗。');
    }
  }

  function navigateParticipant(participant, surface) {
    const child = participant?.window;
    if (!child || child.closed) throw new Error(`測試用戶 ${participant?.index || '?'} 的背景視窗已關閉。`);
    const url = new URL('../' + surface + '/', window.location.href);
    const navigationKey = `${Date.now()}-${participant.index}-${surface}-${randomInt(1000, 9999)}`;
    participant.lastNavigationKey = navigationKey;
    url.searchParams.set('qaPair', navigationKey);
    url.searchParams.set('e2eSeed', String(participant.seed || state.randomSeed || ''));
    url.searchParams.set('e2eComplexity', String(participant.complexityLevel || state.complexityLevel || 1));
    url.searchParams.set('e2eParticipant', String(participant.index || 1));
    url.searchParams.set('e2eViewport', participant?.mobileViewport ? 'mobile' : 'desktop');
    const replaySurface = participant?.replaySurfaceConfig && participant.replaySurfaceConfig[surface];
    try {
      if (replaySurface && state.replayContext) {
        child.sessionStorage.setItem(REPLAY_STORAGE_KEY, JSON.stringify({
          version: 1, surface, participantIndex: Number(participant.index || 1),
          seed: String(participant.seed || ''), complexityLevel: Number(participant.complexityLevel || 1),
          scenarioFingerprint: String(replaySurface.scenarioFingerprint || ''),
          scenarioPath: Array.isArray(replaySurface.scenarioPath) ? replaySurface.scenarioPath : [],
          adaptiveReplaySourceKeys: Array.isArray(replaySurface.adaptiveReplaySourceKeys) ? replaySurface.adaptiveReplaySourceKeys : [],
          randomStateAfterBuild: Number(replaySurface.randomStateAfterBuild || 0) >>> 0
        }));
      } else child.sessionStorage.removeItem(REPLAY_STORAGE_KEY);
    } catch {
      if (state.replayContext) throw new Error('無法把 locked replay descriptor 寫入測試用戶視窗。');
    }
    child.location.href = url.href;
    if (participant?.mobileViewport) window.setTimeout(() => applyClientWindowSize(child, true), 0);
    return child;
  }
  async function postPublicTestMode(session, body) {
    const response = await fetch(functionUrl(session.config, 'test-mode-api'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: String(session.config.supabasePublishableKey || '')
      },
      cache: 'no-store',
      body: JSON.stringify(body)
    });
    let parsed = null;
    try { parsed = await response.json(); } catch {}
    if (!response.ok || !parsed || parsed.ok !== true) {
      const error = new Error(parsed?.error?.message || '測試登入服務拒絕協同 E2E。');
      error.code = parsed?.error?.code || 'TEST_MODE_ERROR';
      throw error;
    }
    return parsed.data || {};
  }



  async function runUserSurface(participant, surface, label) {
    const child = participant?.window;
    if (!child || child.closed) throw new Error('測試用戶 ' + (participant?.index || '?') + ' 的背景視窗已被關閉。');
    participant.surface = label;
    renderParticipants();
    navigateParticipant(participant, surface);
    const expectedNavigationKey = String(participant.lastNavigationKey || '');

    const control = await waitFor(() => {
      if (state.cancelled) return { cancelled: true };
      try {
        if (child.closed) return null;
        const currentUrl = new URL(child.location.href);
        if (String(currentUrl.searchParams.get('qaPair') || '') !== expectedNavigationKey) return null;
        if (child.document?.readyState !== 'complete') return null;
        return child.MemberUserTestControl?.surface === surface ? child.MemberUserTestControl : null;
      } catch { return null; }
    }, backgroundAwareTimeout(25000, 90000), 120, true);
    if (control?.cancelled || state.cancelled) {
      return { ok: false, cancelled: true, surface, account: participant.account, results: [], summary: { passed: 0, failed: 0, skipped: 0, total: 0 } };
    }
    if (!control) throw new Error(label + ' E2E 控制器未在測試帳號背景視窗就緒。');

    const surfaceTimeoutMs = backgroundAwareTimeout(surface === 'booking' ? 180000 : 150000, 12 * 60 * 1000);
    let result;
    let timeoutId = 0;
    try {
      result = await Promise.race([
        control.runFull(),
        new Promise((_, reject) => {
          timeoutId = window.setTimeout(() => {
            const error = new Error(label + ' E2E 超過允許執行時間，已自動停止以避免協同測試卡住。');
            error.code = 'E2E_SURFACE_TIMEOUT';
            reject(error);
          }, surfaceTimeoutMs);
        })
      ]);
    } catch (error) {
      if (error?.code === 'E2E_SURFACE_TIMEOUT') {
        try { control.stop?.(); } catch {}
      }
      throw error;
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
    }
    if (!result || typeof result !== 'object') throw new Error(label + ' E2E 未回傳結構化結果。');
    if (!result.cancelled && result?.account?.memberId !== participant.account?.memberId) {
      const error = new Error(label + ' E2E 使用者與指定測試用戶不一致。');
      error.code = 'E2E_TEST_ACCOUNT_MISMATCH';
      throw error;
    }
    return safe(result);
  }
  async function verifyUserRunsVisibleInAdmin(account, runCodes) {
    const latestRunCode = String(runCodes.filter(Boolean).slice(-1)[0] || '');
    if (!account?.memberCode || !latestRunCode) {
      return fail('沒有足夠資料驗證用戶端測試紀錄同步。', { memberCode: true, runCode: true }, { memberCode: account?.memberCode || null, runCode: latestRunCode || null });
    }
    await ensureTestRoster(account);
    const rows = Array.from(document.querySelectorAll('#memberTableBody tr'));
    const row = rows.find((item) => item.textContent?.includes(String(account.memberCode)));
    if (!row) return fail('管理端名冊找不到協同測試會員。', { memberCode: account.memberCode }, { found: false });
    const button = row.querySelector('button[data-action="view-records"]');
    if (!button) return fail('協同測試會員缺少紀錄按鈕。', { recordsButton: true }, { recordsButton: false });
    button.click();
    const modal = await waitFor(() => {
      const node = document.getElementById('memberRecordsModal');
      return node && !node.classList.contains('hidden') ? node : null;
    }, 8000);
    if (!modal) return fail('會員紀錄視窗未開啟。', { modalOpen: true }, { modalOpen: false });
    const tab = modal.querySelector('[data-record-filter="testAutomation"]');
    tab?.click();
    const visible = Boolean(await waitFor(() => modal.querySelector('#memberRecordsList')?.textContent?.includes(latestRunCode), 10000, 120));
    document.getElementById('closeMemberRecordsModal')?.click();
    return visible
      ? pass('用戶端真人 E2E 的 run code 已同步出現在同一位測試會員的管理端紀錄。', { runCodeVisible: true }, { runCodeVisible: true, runCode: latestRunCode })
      : fail('用戶端 E2E 已完成，但管理端會員紀錄尚未看見該 run code。', { runCodeVisible: true }, { runCodeVisible: false, runCode: latestRunCode });
  }


  async function createEphemeralTestAccount() {
    const before = await postAdminTestMode('admin.test-mode.bootstrap');
    const beforeIds = new Set(activeTestAccounts(before).map((account) => String(account.memberId || '')));
    const settings = before?.settings || {};
    const after = await postAdminTestMode('admin.test-mode.save', {
      maintenanceEnabled: Boolean(settings.maintenanceEnabled),
      allowPcTestLogin: Boolean(settings.allowPcTestLogin),
      allowMobileTestLogin: Boolean(settings.allowMobileTestLogin),
      allowDuplicateTestLogin: Boolean(settings.allowDuplicateTestLogin),
      maintenanceMessage: String(settings.maintenanceMessage || ''),
      addAccountCount: 1
    });
    const created = activeTestAccounts(after).find((account) => !beforeIds.has(String(account.memberId || '')));
    if (!created?.memberId || !created?.memberCode) throw new Error('無法建立深度 E2E 專用臨時測試會員。');
    try {
      const member = await adminMemberSnapshot(created);
      if (!member?.lineUserId) throw new Error('深度 E2E 臨時測試會員缺少管理端身分對應。');
      return { ...created, lineUserId: member.lineUserId };
    } catch (error) {
      await postAdminTestMode('admin.test-mode.delete-accounts', { memberIds: [created.memberId] }).catch(() => {});
      throw error;
    }
  }


  async function prepareEphemeralConsents(accounts) {
    const memberIds = (Array.isArray(accounts) ? accounts : []).map((account) => String(account?.memberId || '')).filter(Boolean);
    if (!memberIds.length) return { currentConsentCount: 0 };
    const session = await adminSession();
    return postFunction('test-control-api', {
      action: 'admin.test-control.prepare-test-account-consents',
      clientType: 'admin',
      idToken: session.idToken,
      memberIds
    });
  }

  async function memberGrowthRequest(login, clientType, action, payload = {}) {
    return postFunction('member-growth-api', {
      ...payload,
      action,
      clientType,
      idToken: '',
      testSessionToken: String(login?.testSessionToken || '')
    });
  }

  async function userEventBootstrap(login) {
    return postFunction('api', {
      action: 'user.event.bootstrap',
      clientType: 'event',
      idToken: '',
      testSessionToken: String(login?.testSessionToken || '')
    });
  }

  async function pairedMemberReferralRewardCase() {
    let inviter = null;
    let invitee = null;
    let anotherInvitee = null;
    let qaRewardEventTicketId = '';
    try {
      const session = await adminSession();
      const stamp = qaCrudStamp();
      const existing = await window.MemberSystem.request(session.config,'admin',session.idToken,'admin.event-tickets.list',{});
      if ((existing.eventTickets || []).some(ticket => ticket.ticketType === 'referral' && ticket.status === 'active')) return skip('已有啟用邀請票券；本輪不改動既有設定或消耗既有額度。完整獎勵規則由隔離 SQL 驗證。',{isolatedReferralSource:true},{isolatedReferralSource:false});
      const rewardFixture = await postFunction('api', {
        action: 'admin.event-tickets.save',
        clientType: 'admin',
        idToken: session.idToken,
        eventTicket: {
          title: 'E2E 好友邀請獎勵 ' + stamp,
          ticketType: 'referral',
          description: '僅供本輪好友邀請 E2E 使用。',
          usageMethod: 'QA',
          usageInstructions: '測試完成後自動清理。',
          prizes: [],
          status: 'active',
          startsOn: '',
          endsOn: '',
          quota: 4,
          requiresLocation: false,
          redemptionLocations: [],
          accent: '#6D4AA0',
          allowedTierKeys: ['general','silver','gold','platinum']
        }
      });
      qaRewardEventTicketId = String(rewardFixture?.eventTicket?.eventTicketId || '');
      if (!qaRewardEventTicketId) {
        return fail('好友邀請 E2E 無法建立本輪專用 referral 獎勵票券。', {
          qaReferralRewardReady: true
        }, { qaReferralRewardReady: false });
      }

      inviter = await createEphemeralTestAccount();
      invitee = await createEphemeralTestAccount();
      anotherInvitee = await createEphemeralTestAccount();
      const consent = await prepareEphemeralConsents([inviter, invitee, anotherInvitee]);
      if (Number(consent?.currentConsentCount || 0) !== 3) {
        return fail('好友邀請 E2E 無法建立三位已同意條款的臨時測試會員。', {
          consentCount: 3
        }, { consentCount: Number(consent?.currentConsentCount || 0) });
      }

      const inviterMemberLogin = await createPairedSession(inviter, 'member');
      const inviteeMemberLogin = await createPairedSession(invitee, 'member');
      const inviterProfile = await postFunction('member-profile-api', {
        action: 'user.member.bootstrap',
        clientType: 'member',
        idToken: '',
        testSessionToken: inviterMemberLogin.testSessionToken
      });
      const inviteCode = String(inviterProfile?.profile?.inviteCode || '').trim().toUpperCase();
      if (!/^[A-F0-9]{10}$/.test(inviteCode)) {
        return fail('邀請人沒有取得有效邀請碼。', { inviteCodeReady: true }, { inviteCodeReady: false });
      }

      const caller = inviteeMemberLogin;
      const requestId = 'ref-e2e-' + qaCrudStamp();
      const first = await memberGrowthRequest(inviteeMemberLogin, 'member', 'member.referral.bind', { inviteCode, requestId });
      const replay = await memberGrowthRequest(inviteeMemberLogin, 'member', 'member.referral.bind', { inviteCode, requestId });
      const second = await memberGrowthRequest(caller,'member','member.referral.bind',{memberCode:anotherInvitee.memberCode,requestId:requestId+'-next'});
      const rewardEventTicketId = String(first?.rewardEventTicketId || '');
      const inviterEventLogin = await createPairedSession(inviter, 'event');
      const inviteeEventLogin = await createPairedSession(invitee, 'event');
      const [inviterEvent, inviteeEvent] = await Promise.all([
        userEventBootstrap(inviterEventLogin),
        userEventBootstrap(inviteeEventLogin)
      ]);
      const ownsReward = (snapshot) => (Array.isArray(snapshot?.offers) ? snapshot.offers : []).some((offer) =>
        String(offer?.ticket?.eventTicketId || '') === rewardEventTicketId &&
        String(offer?.claim?.status || '') === 'available'
      );
      const actual = {
        inviteCodeReady: true,
        referralId: String(first?.referralId || ''),
        qaRewardEventTicketId,
        rewardEventTicketId,
        rewardFixtureMatched: Boolean(rewardEventTicketId) && (inviteeEvent.offers || []).some(offer => offer.ticket?.eventTicketId === rewardEventTicketId && offer.ticket?.title === 'E2E 好友邀請獎勵 ' + stamp),
        repeatableDistinctRecipient: Boolean(second?.referralId) && second.referralId !== first.referralId && second?.rewardEventTicketId !== rewardEventTicketId && (inviteeEvent.offers || []).some(offer => offer.ticket?.eventTicketId === second.rewardEventTicketId && offer.ticket?.title === 'E2E 好友邀請獎勵 ' + stamp),
        firstAlreadyApplied: first?.alreadyApplied === true,
        replayAlreadyApplied: replay?.alreadyApplied === true,
        replaySameReferral: String(first?.referralId || '') === String(replay?.referralId || ''),
        inviterRewardVisible: ownsReward(inviterEvent),
        inviteeRewardVisible: ownsReward(inviteeEvent)
      };
      const ok = Boolean(actual.referralId && rewardEventTicketId) && actual.rewardFixtureMatched &&
        !actual.firstAlreadyApplied && actual.replayAlreadyApplied && actual.replaySameReferral &&
        !actual.inviterRewardVisible && actual.inviteeRewardVisible && actual.repeatableDistinctRecipient;
      return ok
        ? pass('輸入者完成兩個不同會員邀請；本輪 QA referral 票券被正確使用，同 requestId 重播不重複發券。', {
            rewardFixtureMatched: true, firstAlreadyApplied: false, replayAlreadyApplied: true,
            replaySameReferral: true, inviterRewardVisible: false, inviteeRewardVisible: true, repeatableDistinctRecipient:true
          }, actual)
        : fail('好友邀請綁定、QA 獎勵票券、冪等或輸入者單方獎勵或再次邀請驗證失敗。', {
            rewardFixtureMatched: true, firstAlreadyApplied: false, replayAlreadyApplied: true,
            replaySameReferral: true, inviterRewardVisible: false, inviteeRewardVisible: true, repeatableDistinctRecipient:true
          }, actual);
    } finally {
      const cleanupFailures = [];
      for (const account of [anotherInvitee,invitee,inviter].filter(Boolean)) {
        try { if (!(await removeEphemeralTestAccount(account))) cleanupFailures.push(account.memberCode); } catch (_) { cleanupFailures.push(account.memberCode); }
      }
      if (qaRewardEventTicketId) {
        try {
          const session = await adminSession();
          await window.MemberSystem.request(session.config, 'admin', session.idToken, 'admin.event-tickets.delete', {
            eventTicketId: qaRewardEventTicketId
          });
        } catch (_) { cleanupFailures.push('referral-template'); }
      }
      if (cleanupFailures.length) throw Object.assign(new Error('本輪邀請 E2E 清理失敗：'+cleanupFailures.join('、')),{code:'E2E_FIXTURE_CLEANUP_FAILED'});
    }
  }

  async function pairedPointTransferAtomicCase() {
    let sender = null;
    let receiver = null;
    try {
      sender = await createEphemeralTestAccount();
      receiver = await createEphemeralTestAccount();
      const consent = await prepareEphemeralConsents([sender, receiver]);
      if (Number(consent?.currentConsentCount || 0) !== 2) {
        return fail('點數轉贈 E2E 無法建立兩位已同意條款的臨時測試會員。', {
          consentCount: 2
        }, { consentCount: Number(consent?.currentConsentCount || 0) });
      }

      const session = await adminSession();
      const cardsData = await window.MemberSystem.request(session.config, 'admin', session.idToken, 'admin.pointcards.list', {});
      const card = (Array.isArray(cardsData?.cards) ? cardsData.cards : []).find((item) =>
        item?.status === 'active' && item?.expired !== true && item?.cardId
      );
      if (!card) return skip('目前沒有可供點數轉贈 E2E 使用的啟用中集點卡。', { activePointCard: true }, { activePointCard: false });

      const grantRequestId = 'E2E-XFER-GRANT-' + qaCrudStamp();
      await window.MemberSystem.request(session.config, 'admin', session.idToken, 'admin.member-grants.add', {
        lineUserId: sender.lineUserId,
        requestId: grantRequestId,
        messagePresetId: '',
        points: [{ cardId: card.cardId, amount: 3 }]
      });

      const senderLogin = await createPairedSession(sender, 'points');
      const receiverLogin = await createPairedSession(receiver, 'points');
      const senderBeforeData = await memberGrowthRequest(senderLogin, 'points', 'points.transfer.options');
      const receiverBeforeData = await memberGrowthRequest(receiverLogin, 'points', 'points.transfer.options');
      const balanceFor = (data) => Number((Array.isArray(data?.cards) ? data.cards : []).find((item) =>
        String(item?.cardId || '') === String(card.cardId)
      )?.balance || 0);
      const senderBefore = balanceFor(senderBeforeData);
      const receiverBefore = balanceFor(receiverBeforeData);
      const lookup = await memberGrowthRequest(senderLogin, 'points', 'points.transfer.receiver', { memberCode: receiver.memberCode });

      const requestId = 'pt-e2e-' + qaCrudStamp();
      const first = await memberGrowthRequest(senderLogin, 'points', 'points.transfer.create', {
        cardId: card.cardId, memberCode: receiver.memberCode, amount: 1, requestId
      });
      const replay = await memberGrowthRequest(senderLogin, 'points', 'points.transfer.create', {
        cardId: card.cardId, memberCode: receiver.memberCode, amount: 1, requestId
      });
      let conflictCode = '';
      try {
        await memberGrowthRequest(senderLogin, 'points', 'points.transfer.create', {
          cardId: card.cardId, memberCode: receiver.memberCode, amount: 2, requestId
        });
      } catch (error) {
        conflictCode = String(error?.code || '');
      }
      const [senderAfterData, receiverAfterData] = await Promise.all([
        memberGrowthRequest(senderLogin, 'points', 'points.transfer.options'),
        memberGrowthRequest(receiverLogin, 'points', 'points.transfer.options')
      ]);
      const senderAfter = balanceFor(senderAfterData);
      const receiverAfter = balanceFor(receiverAfterData);
      const actual = {
        cardId: card.cardId,
        lookupMatched: String(lookup?.memberCode || '').toUpperCase() === String(receiver.memberCode || '').toUpperCase(),
        senderBefore, senderAfter, receiverBefore, receiverAfter,
        firstTransferId: String(first?.transferId || ''),
        replayTransferId: String(replay?.transferId || ''),
        firstAlreadyApplied: first?.alreadyApplied === true,
        replayAlreadyApplied: replay?.alreadyApplied === true,
        conflictCode,
        totalBefore: senderBefore + receiverBefore,
        totalAfter: senderAfter + receiverAfter
      };
      const ok = actual.lookupMatched && senderBefore >= 3 && senderAfter === senderBefore - 1 &&
        receiverAfter === receiverBefore + 1 && actual.totalBefore === actual.totalAfter &&
        Boolean(actual.firstTransferId) && actual.firstTransferId === actual.replayTransferId &&
        !actual.firstAlreadyApplied && actual.replayAlreadyApplied && conflictCode === 'REQUEST_ID_CONFLICT';
      return ok
        ? pass('點數轉贈完成雙方餘額守恆、同 requestId 冪等重播及不同內容衝突拒絕；測試後清理臨時會員。', {
            senderDelta: -1, receiverDelta: 1, totalConserved: true,
            replayAlreadyApplied: true, conflictCode: 'REQUEST_ID_CONFLICT'
          }, actual)
        : fail('點數轉贈原子性、冪等或衝突保護至少一項不符合預期。', {
            senderDelta: -1, receiverDelta: 1, totalConserved: true,
            replayAlreadyApplied: true, conflictCode: 'REQUEST_ID_CONFLICT'
          }, actual);
    } finally {
      if (receiver) await removeEphemeralTestAccount(receiver).catch(() => false);
      if (sender) await removeEphemeralTestAccount(sender).catch(() => false);
    }
  }

  async function pairedForceLogoutRevocationCase() {
    let account = null;
    try {
      account = await createEphemeralTestAccount();
      const session = await adminSession();
      const publicStatus = await postPublicTestMode(session, { action: 'public.status', clientType: 'member' });
      const login = await createPairedSession(account, 'member');
      const before = await postPublicTestMode(session, {
        action: 'session.status',
        clientType: 'member',
        testSessionToken: login.testSessionToken
      });
      await window.MemberSystem.request(session.config, 'admin', session.idToken, 'admin.member.force-logout', {
        lineUserId: account.lineUserId
      });

      const response = await fetch(functionUrl(session.config, 'test-mode-api'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: String(session.config.supabasePublishableKey || '') },
        cache: 'no-store',
        body: JSON.stringify({
          action: 'session.status',
          clientType: 'member',
          testSessionToken: login.testSessionToken
        })
      });
      const payload = await response.json().catch(() => ({}));
      const actual = {
        maintenanceEnabled: publicStatus?.maintenanceEnabled === true,
        sessionActiveBefore: before?.active === true,
        revokedHttpStatus: response.status,
        revokedErrorCode: String(payload?.error?.code || '')
      };
      const ok = actual.maintenanceEnabled && actual.sessionActiveBefore &&
        response.status === 401 && actual.revokedErrorCode === 'SESSION_REVOKED';
      return ok
        ? pass('維護模式下建立的測試會員 Session 經管理端強制下線後立即撤銷；舊 token 重播被 Server 拒絕。', {
            maintenanceEnabled: true, sessionActiveBefore: true,
            revokedHttpStatus: 401, revokedErrorCode: 'SESSION_REVOKED'
          }, actual)
        : fail('強制下線後舊測試 Session 仍可使用，或維護模式前置不一致。', {
            maintenanceEnabled: true, sessionActiveBefore: true,
            revokedHttpStatus: 401, revokedErrorCode: 'SESSION_REVOKED'
          }, actual);
    } finally {
      if (account) await removeEphemeralTestAccount(account).catch(() => false);
    }
  }

  async function pairedEventLastTicketRaceCase() {
    const candidates = state.participants.filter((participant) =>
      participant?.account?.memberId && participant?.window && !participant.window.closed
    ).slice(0, 2);
    if (candidates.length < 2) {
      return skip('最後一張併發 E2E 需要至少 2 位協同測試用戶；本輪只有 1 位時不額外開啟重型瀏覽器視窗。', {
        participantsAtLeast: 2
      }, { participants: candidates.length, resourceProtection: true });
    }

    const session = await adminSession();
    const stamp = qaCrudStamp();
    const created = await postFunction('api', {
      action: 'admin.event-tickets.save',
      clientType: 'admin',
      idToken: session.idToken,
      eventTicket: {
        title: 'E2E 最後一張競爭 ' + stamp,
        ticketType: 'coupon',
        description: '兩個獨立測試會員同時競爭 quota=1',
        usageMethod: 'QA',
        usageInstructions: '只用於併發 E2E',
        prizes: [],
        status: 'active',
        startsOn: '',
        endsOn: '',
        quota: 1,
        requiresLocation: false,
        redemptionLocations: [],
        accent: '#5f7769',
        allowedTierKeys: ['general','silver','gold','platinum']
      }
    });
    const eventTicketId = String(created?.eventTicket?.eventTicketId || '');
    if (!eventTicketId) return fail('無法建立 quota=1 的活動優惠券測試資料。', { created: true }, { created: false });

    const previous = candidates.map((participant) => ({
      participant,
      login: participant.login || null,
      surface: participant.lastSurfaceKey || 'member'
    }));
    let race = [];
    let ui = [];
    try {
      const logins = [];
      for (const participant of candidates) {
        const cached = participant.surfaceLogins?.event;
        const login = cached?.testSessionToken ? cached : await createPairedSession(participant.account, 'event');
        participant.surfaceLogins = participant.surfaceLogins || {};
        participant.surfaceLogins.event = login;
        logins.push(login);
      }
      const settled = await Promise.allSettled(logins.map((login) => postFunction('api', {
        action: 'user.event.ticket.claim',
        clientType: 'event',
        idToken: '',
        testSessionToken: login.testSessionToken,
        eventTicketId
      })));
      race = settled.map((result, index) => ({
        participantIndex: Number(candidates[index].index),
        status: result.status,
        errorCode: result.status === 'rejected' ? String(result.reason?.code || '') : '',
        claimId: result.status === 'fulfilled' ? String(result.value?.ticket?.claimId || '') : ''
      }));
      const winner = race.find((row) => row.status === 'fulfilled');
      const loser = race.find((row) => row.status === 'rejected');

      ui = await Promise.all(candidates.map(async (participant, index) => {
        const login = logins[index];
        participant.login = login;
        participant.lastSurfaceKey = 'event';
        seedParticipantSession(participant, login, 'event');
        try {
          const child = await waitParticipantSurface(participant, 'event', 'eventView', 12000);
          await child.MemberClientQaHooks?.refresh?.();
          const card = await waitFor(() => {
            try {
              return child.document.querySelector('[data-event-ticket-id="' + CSS.escape(eventTicketId) + '"]')?.closest('.event-ticket') || null;
            } catch { return null; }
          }, backgroundAwareTimeout(6000, 12000), 120);
          const text = String(card?.textContent || '');
          return {
            participantIndex: Number(participant.index),
            found: Boolean(card),
            winnerState: Number(participant.index) === Number(winner?.participantIndex) && /已領取/.test(text),
            loserState: Number(participant.index) === Number(loser?.participantIndex) && /額滿|限量張數已領完/.test(text),
            uiError: ''
          };
        } catch (error) {
          return {
            participantIndex: Number(participant.index),
            found: false,
            winnerState: false,
            loserState: false,
            uiError: String(error?.message || 'event UI verification failed').slice(0, 300)
          };
        }
      }));

      const successCount = race.filter((row) => row.status === 'fulfilled').length;
      const quotaRejectedCount = race.filter((row) => row.errorCode === 'EVENT_QUOTA_REACHED').length;
      const winnerUi = ui.some((row) => row.winnerState);
      const loserUi = ui.some((row) => row.loserState);
      const actual = { eventTicketId, race, ui, successCount, quotaRejectedCount, winnerUi, loserUi };
      return successCount === 1 && quotaRejectedCount === 1 && winnerUi && loserUi
        ? pass('兩個獨立測試會員同時競爭最後一張時只有一人成功，另一人收到額滿，兩個瀏覽器 UI 亦同步成已領取／額滿。', {
            successCount: 1, quotaRejectedCount: 1, winnerUi: true, loserUi: true
          }, actual)
        : fail('最後一張併發領券沒有維持 quota 原子性，或其中一個瀏覽器 UI 未同步。', {
            successCount: 1, quotaRejectedCount: 1, winnerUi: true, loserUi: true
          }, actual);
    } finally {
      await postFunction('api', {
        action: 'admin.event-tickets.delete',
        clientType: 'admin',
        idToken: session.idToken,
        eventTicketId
      }).catch(() => {});
      for (const snapshot of previous) {
        try {
          if (!snapshot.login) continue;
          snapshot.participant.login = snapshot.login;
          snapshot.participant.lastSurfaceKey = snapshot.surface;
          seedParticipantSession(snapshot.participant, snapshot.login, snapshot.surface);
          navigateParticipant(snapshot.participant, snapshot.surface);
        } catch {}
      }
    }
  }

  async function bookingOwnershipBoundaryCase() {
    const victim = state.participants.find((participant) =>
      participant.bookingResult?.bookingHandoff?.ready === true
      && participant.bookingResult.bookingHandoff.memberId === participant.account?.memberId
      && participant.bookingResult.bookingHandoff.bookingIds?.length
    );
    const expected = { foreignBookingHidden: true, httpStatus: 404, errorCode: 'BOOKING_NOT_FOUND', victimUnchanged: true };
    if (!victim) return fail('本輪沒有可驗證的測試帳號預約，無法檢查跨帳號存取。', expected, { victimBookingFound: false });

    const session = await adminSession();
    adminBookingBootstrapLastData = null;
    const before = await adminBookingBootstrapSnapshot();
    const target = pairedBookingCandidates(before, victim)[0];
    if (!target?.bookingId) return fail('管理端回讀找不到本輪測試帳號的預約。', expected, { victimBookingFound: false });

    // A separate test-only member is retained for later inspection. Never pass
    // its session token to the result, error trace, or screenshot metadata.
    const attacker = await createEphemeralTestAccount();
    if (attacker.memberId === victim.account.memberId) throw new Error('安全測試的兩個會員不可相同。');
    const login = await createPairedSession(attacker, 'booking');
    const attackRequest = async (action, payload = {}) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(functionUrl(session.config, 'booking-api'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: String(session.config.supabasePublishableKey || '')
          },
          cache: 'no-store', signal: controller.signal,
          body: JSON.stringify({
            action, clientType: 'member', idToken: '',
            testSessionToken: login.testSessionToken, ...payload
          })
        });
        return { status: response.status, body: await response.json().catch(() => ({})) };
      } finally {
        window.clearTimeout(timer);
      }
    };
    const read = await attackRequest('user.booking.bootstrap');
    const attackerBookings = read.body?.data?.bookings;
    const foreignBookingHidden = read.status === 200 && Array.isArray(attackerBookings)
      && attackerBookings.every((booking) =>
        String(booking.memberId) === String(attacker.memberId)
        && String(booking.bookingId) !== String(target.bookingId)
      );
    const cancellation = await attackRequest('user.booking.cancel', { bookingId: target.bookingId });
    adminBookingBootstrapLastData = null;
    const after = await adminBookingBootstrapSnapshot();
    const readback = (after.bookings || []).find((booking) => String(booking.bookingId) === String(target.bookingId));
    const protectedFields = (booking) => JSON.stringify({
      memberId: booking?.memberId, status: booking?.status, updatedAt: booking?.updatedAt,
      cancellationRequestedAt: booking?.cancellationRequestedAt,
      cancellationReviewedAt: booking?.cancellationReviewedAt
    });
    const actual = {
      foreignBookingHidden,
      readHttpStatus: read.status,
      httpStatus: cancellation.status,
      errorCode: String(cancellation.body?.error?.code || '').slice(0, 80),
      victimUnchanged: Boolean(readback) && protectedFields(readback) === protectedFields(target),
      separateTestAccounts: attacker.memberId !== victim.account.memberId,
      attackerMemberCode: attacker.memberCode,
      victimBookingId: target.bookingId
    };
    return actual.foreignBookingHidden && actual.httpStatus === expected.httpStatus
      && actual.errorCode === expected.errorCode && actual.victimUnchanged
      ? pass('另一測試會員無法讀取或取消此預約，管理端回讀確認狀態不變。', expected, actual)
      : fail('跨帳號預約讀取、取消拒絕或資料不變驗證失敗。', expected, actual);
  }

  async function removeEphemeralTestAccount(account) {
    if (!account?.memberId) return false;
    const result = await postAdminTestMode('admin.test-mode.delete-accounts', { memberIds: [account.memberId] });
    return Number(result?.deletedAccountCount || 0) >= 1;
  }


  async function waitParticipantSurface(participant, surface, rootId, timeoutMs = 25000) {
    const child = navigateParticipant(participant, surface);
    const ready = await waitFor(() => {
      try {
        if (!child || child.closed) return null;
        if (child.MemberUserTestControl?.surface !== surface) return null;
        const root = child.document.getElementById(rootId);
        const error = child.document.getElementById('errorView');
        if (error && !error.classList.contains('hidden')) return { error: String(error.textContent || '').trim() };
        return root && !root.classList.contains('hidden') ? root : null;
      } catch { return null; }
    }, backgroundAwareTimeout(timeoutMs, 90000), 120);
    if (!ready || ready.error) throw new Error(ready?.error || surface + ' 用戶端沒有進入可操作狀態。');
    return child;
  }
  function childMembership(child) {
    const root = child?.document?.getElementById('membershipProgress');
    return {
      currentTier: String(root?.querySelector('[data-membership-current-tier]')?.textContent || '').trim(),
      summary: String(root?.querySelector('[data-membership-summary]')?.textContent || '').trim(),
      remaining: String(root?.querySelector('[data-membership-remaining]')?.textContent || '').trim(),
      styleKey: String(root?.getAttribute('data-membership-tier-style') || '')
    };
  }

  async function adminMemberSnapshot(account) {
    const session = await adminSession();
    const result = await window.MemberSystem.request(session.config, 'admin', session.idToken, 'admin.members.list', {
      memberPage: 1,
      memberPageSize: 100,
      memberQuery: String(account?.memberCode || ''),
      memberKind: 'test'
    });
    const members = Array.isArray(result?.members) ? result.members : [];
    const lineUserId = String(account?.lineUserId || '');
    const memberCode = String(account?.memberCode || '');
    return members.find((member) =>
      (lineUserId && String(member.lineUserId || '') === lineUserId) ||
      (memberCode && String(member.memberCode || '') === memberCode)
    ) || null;
  }

  async function waitAdminMember(account, predicate, timeoutMs = 12000) {
    const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 12000);
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const member = await adminMemberSnapshot(account);
        if (member && predicate(member)) return member;
      } catch (error) {
        lastError = error;
      }
      await sleep(180);
    }
    if (lastError) throw lastError;
    return null;
  }

  async function openGrantForAccount(account) {
    await ensureTestRoster(account);
    await clickRowAction('add-grant', String(account.lineUserId || ''));
    const modal = await waitFor(() => {
      const node = document.getElementById('grantModal');
      return node && !node.classList.contains('hidden') ? node : null;
    }, 6000);
    if (!modal) throw new Error('發放視窗沒有開啟。');
    if (String(document.getElementById('grantMemberId')?.value || '') !== String(account.lineUserId || '')) {
      throw new Error('發放視窗綁定的測試會員不一致。');
    }
    return modal;
  }

  function toggleCheckbox(id, checked) {
    const input = document.getElementById(id);
    if (!input) throw new Error('找不到控制欄位：' + id);
    input.checked = Boolean(checked);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input;
  }

  async function submitServiceGrant(account, minutes, doubleClick = false) {
    await openGrantForAccount(account);
    toggleCheckbox('grantStampsEnabled', false);
    toggleCheckbox('grantServiceTimeEnabled', true);
    setField('grantServiceTimeMinutes', String(minutes));
    const button = document.getElementById('saveGrantButton');
    button?.click();
    if (doubleClick) button?.click();
    const closed = Boolean(await waitFor(() => document.getElementById('grantModal')?.classList.contains('hidden'), 15000));
    if (!closed) throw new Error('服務時數發放後視窗沒有關閉。');
    return true;
  }

  async function submitPointGrant(account, cardId, amount, doubleClick = false) {
    await openGrantForAccount(account);
    toggleCheckbox('grantStampsEnabled', true);
    toggleCheckbox('grantServiceTimeEnabled', false);
    const row = await waitFor(() => document.querySelector('#grantPointRows [data-grant-point-row]'), 3000);
    const select = row?.querySelector('[data-grant-point-field="cardId"]');
    const input = row?.querySelector('[data-grant-point-field="amount"]');
    if (!select || !input) throw new Error('發放集點欄位沒有建立。');
    select.value = String(cardId);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    input.value = String(amount);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const button = document.getElementById('saveGrantButton');
    button?.click();
    if (doubleClick) button?.click();
    const closed = Boolean(await waitFor(() => document.getElementById('grantModal')?.classList.contains('hidden'), 15000));
    if (!closed) throw new Error('點數發放後視窗沒有關閉。');
    return true;
  }

  async function invalidGrantBoundaryCase(account) {
    const before = await adminMemberSnapshot(account);
    await openGrantForAccount(account);
    toggleCheckbox('grantStampsEnabled', false);
    toggleCheckbox('grantServiceTimeEnabled', true);
    setField('grantServiceTimeMinutes', '0');
    document.getElementById('saveGrantButton')?.click();
    const zeroRejected = Boolean(await waitFor(() => /1–1440/.test(String(document.getElementById('grantFormMessage')?.textContent || '')), 1500));
    setField('grantServiceTimeMinutes', '1441');
    document.getElementById('saveGrantButton')?.click();
    const tooLargeRejected = Boolean(await waitFor(() => /1–1440/.test(String(document.getElementById('grantFormMessage')?.textContent || '')), 1500));
    toggleCheckbox('grantServiceTimeEnabled', false);
    document.getElementById('saveGrantButton')?.click();
    const emptyRejected = Boolean(await waitFor(() => /至少勾選/.test(String(document.getElementById('grantFormMessage')?.textContent || '')), 1500));
    document.getElementById('cancelGrantButton')?.click();
    const after = await adminMemberSnapshot(account);
    const unchanged = Number(after?.serviceMinutesTotal || 0) === Number(before?.serviceMinutesTotal || 0);
    return { zeroRejected, tooLargeRejected, emptyRejected, unchanged };
  }

  function currentTierSettingsFromDom() {
    return [
      ['general', 'tierGeneralMinutes', 'tierGeneralStyle'],
      ['silver', 'tierSilverMinutes', 'tierSilverStyle'],
      ['gold', 'tierGoldMinutes', 'tierGoldStyle'],
      ['platinum', 'tierPlatinumMinutes', 'tierPlatinumStyle']
    ].map(([tierKey, minutesId, styleId]) => ({
      tierKey,
      requiredServiceMinutes: Number(document.getElementById(minutesId)?.value || 0),
      styleKey: String(document.getElementById(styleId)?.value || 'forest')
    }));
  }

  async function saveTierSettingsViaUi(settings) {
    const map = Object.fromEntries(settings.map((item) => [item.tierKey, item]));
    setField('tierSilverMinutes', String(map.silver.requiredServiceMinutes));
    setField('tierGoldMinutes', String(map.gold.requiredServiceMinutes));
    setField('tierPlatinumMinutes', String(map.platinum.requiredServiceMinutes));
    setField('tierGeneralStyle', map.general.styleKey);
    setField('tierSilverStyle', map.silver.styleKey);
    setField('tierGoldStyle', map.gold.styleKey);
    setField('tierPlatinumStyle', map.platinum.styleKey);
    document.getElementById('saveTierSettingsButton')?.click();
    const saved = Boolean(await waitFor(() => /已儲存/.test(String(document.getElementById('tierSettingsFormMessage')?.textContent || '')), 15000));
    if (!saved) throw new Error('會員階級門檻沒有完成儲存。');
  }

  async function deepServiceTierRealtimeCase(ctx) {
    const account = ctx.account;
    const participant = ctx.participant;
    await ensureTestRoster(account);
    ctx.originalTierSettings = currentTierSettingsFromDom();

    const invalid = ctx.originalTierSettings.map((item) => ({ ...item }));
    invalid.find((item) => item.tierKey === 'silver').requiredServiceMinutes = 2;
    invalid.find((item) => item.tierKey === 'gold').requiredServiceMinutes = 2;
    invalid.find((item) => item.tierKey === 'platinum').requiredServiceMinutes = 4;
    setField('tierSilverMinutes', '2');
    setField('tierGoldMinutes', '2');
    setField('tierPlatinumMinutes', '4');
    document.getElementById('saveTierSettingsButton')?.click();
    const invalidTierRejected = Boolean(await waitFor(() => /依序遞增/.test(String(document.getElementById('tierSettingsFormMessage')?.textContent || '')), 1600));

    const testSettings = ctx.originalTierSettings.map((item) => ({ ...item }));
    testSettings.find((item) => item.tierKey === 'silver').requiredServiceMinutes = 2;
    testSettings.find((item) => item.tierKey === 'gold').requiredServiceMinutes = 3;
    testSettings.find((item) => item.tierKey === 'platinum').requiredServiceMinutes = 4;
    await saveTierSettingsViaUi(testSettings);
    ctx.tierSettingsChanged = true;

    const child = await waitParticipantSurface(participant, 'member', 'memberView');
    const before = await adminMemberSnapshot(account);
    const beforeMinutes = Number(before?.serviceMinutesTotal || 0);
    if (beforeMinutes !== 0) throw new Error('深度 E2E 臨時會員初始服務時數不是 0。');

    const invalidGrant = await invalidGrantBoundaryCase(account);

    const session = await adminSession();
    const requestId = 'E2E-SVC-' + qaCrudStamp();
    const payload = {
      lineUserId: account.lineUserId,
      requestId,
      messagePresetId: '',
      serviceTime: { minutes: 1 }
    };
    const replayResults = await Promise.allSettled([
      window.MemberSystem.request(session.config, 'admin', session.idToken, 'admin.member-grants.add', payload),
      window.MemberSystem.request(session.config, 'admin', session.idToken, 'admin.member-grants.add', payload)
    ]);
    const afterReplay = await waitAdminMember(account, (member) => Number(member.serviceMinutesTotal || 0) >= 1, 15000);
    const replayDeltaOne = Number(afterReplay?.serviceMinutesTotal || 0) === 1;
    const replayRealtime = Boolean(await waitFor(() => childMembership(child).summary.includes('累積 1 分鐘'), 12000, 120));

    await submitServiceGrant(account, 1, true);
    const silverMember = await waitAdminMember(account, (member) => Number(member.serviceMinutesTotal || 0) === 2, 15000);
    const doubleSubmitDeltaOne = Number(silverMember?.serviceMinutesTotal || 0) === 2;
    const silverRealtime = Boolean(await waitFor(() => /銀級/.test(childMembership(child).currentTier) && childMembership(child).summary.includes('累積 2 分鐘'), 12000, 120));

    await submitServiceGrant(account, 1, false);
    const goldRealtime = Boolean(await waitFor(() => /金級/.test(childMembership(child).currentTier) && childMembership(child).summary.includes('累積 3 分鐘'), 12000, 120));

    await submitServiceGrant(account, 1, false);
    const platinumRealtime = Boolean(await waitFor(() => /白金/.test(childMembership(child).currentTier) && childMembership(child).summary.includes('累積 4 分鐘'), 12000, 120));
    const finalMember = await adminMemberSnapshot(account);

    const actual = {
      invalidTierRejected,
      invalidGrant,
      replayRequests: replayResults.map((item) => item.status),
      replayDeltaOne,
      replayRealtime,
      doubleSubmitDeltaOne,
      silverRealtime,
      goldRealtime,
      platinumRealtime,
      finalServiceMinutes: Number(finalMember?.serviceMinutesTotal || 0),
      finalTier: finalMember?.tier || null
    };
    const ok = invalidTierRejected && Object.values(invalidGrant).every(Boolean) && replayDeltaOne && replayRealtime &&
      doubleSubmitDeltaOne && silverRealtime && goldRealtime && platinumRealtime && actual.finalServiceMinutes === 4;
    return ok
      ? pass('會員階級與服務時數已完成非法輸入、同 requestId 併發重送、UI 連點及跨級 Realtime 驗證；管理端與用戶端最終狀態一致。', {
          invalidRejected: true, idempotentReplayDelta: 1, doubleSubmitDelta: 1, finalServiceMinutes: 4,
          realtimeTiers: ['銀級', '金級', '白金']
        }, actual)
      : fail('會員階級／服務時數深度協同 E2E 發現狀態不一致。', {
          invalidRejected: true, idempotentReplayDelta: 1, doubleSubmitDelta: 1, finalServiceMinutes: 4,
          realtimeTiers: ['銀級', '金級', '白金']
        }, actual);
  }

  async function createDeepPointCard(ctx) {
    const stamp = qaCrudStamp();
    ctx.ticketTitle = 'E2E QA 深度集點抽獎券 ' + stamp;
    const ticket = await createQaTicketTemplate(ctx.ticketTitle, {
      status: 'active',
      ticketType: 'lottery',
      description: '深度協同 E2E：集點卡兌換後執行抽獎並驗證結果。',
      usageMethod: '集滿 2 點後使用並抽獎',
      usageInstructions: '僅供深度協同 E2E。',
      prizes: [
        { title: '深度頭獎', rate: 50, description: '深度協同 E2E 頭獎' },
        { title: '深度二獎', rate: 35, description: '深度協同 E2E 二獎' },
        { title: '深度參加獎', rate: 15, description: '深度協同 E2E 參加獎' }
      ]
    });
    ctx.ticketTemplateId = ticket.ticketTemplateId;
    closeEditorModalById('ticketEditorModal');

    document.getElementById('cardSettingsTab')?.click();
    document.getElementById('newCardButton')?.click();
    if (!await waitEditorOpen('cardEditorModal', 5000)) throw new Error('深度 E2E 集點卡編輯器未開啟。');
    ctx.cardTitle = 'E2E QA 深度集點卡 ' + stamp;
    setField('cardTitle', ctx.cardTitle);
    setField('cardUsageMethod', '深度 E2E 自動集點');
    setField('cardUsageInstructions', '測試管理端發點、票券產生與用戶端即時更新。');
    setField('cardBenefitDescription', '2 點取得深度 E2E 測試票券');
    setField('cardStatus', 'active');
    setField('cardExpiryMode', 'unlimited');

    const threshold = await waitFor(() => document.querySelector('#rewardRows [data-field="thresholdStamps"]'), 3000);
    const select = document.querySelector('#rewardRows [data-field="ticketTemplateId"]');
    if (!threshold || !select) throw new Error('集點卡兌換節點欄位未建立。');
    threshold.value = '2';
    threshold.dispatchEvent(new Event('input', { bubbles: true }));
    select.value = String(ctx.ticketTemplateId);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('saveCardButton')?.click();
    await waitAdminWriteSettled('saveCardButton');
    const savedCard = await waitFor(() => Array.from(document.querySelectorAll('#cardListItems [data-card-id]'))
      .find((node) => String(node.textContent || '').includes(ctx.cardTitle)) || null, 15000);
    ctx.cardId = String(document.getElementById('cardId')?.value || savedCard?.dataset.cardId || '');
    if (!ctx.cardId) throw new Error('深度 E2E 集點卡沒有取得 Card ID。');
    if (!savedCard && !await waitFor(() => textIncludes('#cardListItems', ctx.cardTitle), 10000)) throw new Error('深度 E2E 集點卡沒有出現在管理端。');
    closeEditorModalById('cardEditorModal');
    return ctx.cardId;
  }

  async function invalidPointGrantCase(account, cardId) {
    await openGrantForAccount(account);
    toggleCheckbox('grantStampsEnabled', true);
    toggleCheckbox('grantServiceTimeEnabled', false);
    const row = await waitFor(() => document.querySelector('#grantPointRows [data-grant-point-row]'), 3000);
    const select = row?.querySelector('[data-grant-point-field="cardId"]');
    const input = row?.querySelector('[data-grant-point-field="amount"]');
    select.value = String(cardId);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('saveGrantButton')?.click();
    const zeroRejected = Boolean(await waitFor(() => /1–100/.test(String(document.getElementById('grantFormMessage')?.textContent || '')), 1500));
    input.value = '101';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('saveGrantButton')?.click();
    const tooLargeRejected = Boolean(await waitFor(() => /1–100/.test(String(document.getElementById('grantFormMessage')?.textContent || '')), 1500));
    document.getElementById('cancelGrantButton')?.click();
    return { zeroRejected, tooLargeRejected };
  }

  function childPointState(child, cardId, cardTitle, ticketTitle) {
    const tabs = Array.from(child?.document?.querySelectorAll('#cardTabs [data-card-id]') || []);
    const tab = tabs.find((node) => String(node.dataset.cardId || '') === String(cardId || '')) || null;
    return {
      cardVisible: Boolean(tab && String(tab.textContent || '').includes(cardTitle)),
      activeTitle: String(child?.document?.getElementById('activeCardTitle')?.textContent || '').trim(),
      points: Number(String(child?.document?.getElementById('progressCount')?.textContent || '0').replace(/[^0-9-]/g, '') || 0),
      ticketVisible: String(child?.document?.getElementById('ticketList')?.textContent || '').includes(ticketTitle),
      ticketHistoryVisible: String(child?.document?.getElementById('ticketHistoryList')?.textContent || '').includes(ticketTitle)
    };
  }

  async function selectChildCard(child, cardId) {
    const tab = await waitFor(() => {
      try { return Array.from(child.document.querySelectorAll('#cardTabs [data-card-id]')).find((node) => String(node.dataset.cardId || '') === String(cardId || '')) || null; }
      catch { return null; }
    }, 12000, 120);
    if (!tab) return false;
    tab.click();
    return Boolean(await waitFor(() => String(child.document.getElementById('activeCardTitle')?.textContent || '').trim() !== '', 3000));
  }

  async function redeemDeepTicketInChild(child, ticketTitle, expectLottery = false) {
    const checkbox = await waitFor(() => {
      try {
        return Array.from(child.document.querySelectorAll('#ticketList [data-ticket-select]')).find((node) => {
          const host = node.closest('article,li,section,div');
          return String(host?.textContent || '').includes(ticketTitle);
        }) || null;
      } catch { return null; }
    }, 10000, 120);
    if (!checkbox) return { selected: false, cancelledOnce: false, redeemed: false, lotteryResultVisible: false, history: false };
    checkbox.checked = true;
    checkbox.dispatchEvent(new child.Event('change', { bubbles: true }));
    const useButton = await waitFor(() => {
      try {
        const button = child.document.querySelector('.ticket-overview-use');
        return button && !button.disabled ? button : null;
      } catch { return null; }
    }, 3000);
    if (!useButton) return { selected: true, cancelledOnce: false, redeemed: false, lotteryResultVisible: false, history: false };
    useButton.click();
    const modal = await waitFor(() => {
      try {
        const node = child.document.getElementById('ticketBatchModal');
        return node && !node.classList.contains('hidden') ? node : null;
      } catch { return null; }
    }, 3000);
    if (!modal) return { selected: true, cancelledOnce: false, redeemed: false, lotteryResultVisible: false, history: false };
    modal.querySelector('.ticket-batch-cancel')?.click();
    const cancelledOnce = Boolean(await waitFor(() => modal.classList.contains('hidden'), 1800));
    useButton.click();
    await waitFor(() => !modal.classList.contains('hidden'), 1800);
    modal.querySelector('.ticket-batch-confirm')?.click();
    const completed = await waitFor(() => {
      const confirm = modal.querySelector('.ticket-batch-confirm');
      return confirm && confirm.dataset.mode === 'close' && !confirm.disabled ? confirm : null;
    }, 12000, 120);
    const redeemed = Boolean(completed);
    const resultText = String(modal.querySelector('[data-batch-list]')?.textContent || '');
    const lotteryResultVisible = expectLottery ? /抽中：/.test(resultText) : true;
    completed?.click();
    const history = Boolean(await waitFor(() => String(child.document.getElementById('ticketHistoryList')?.textContent || '').includes(ticketTitle), 12000, 120));
    return { selected: true, cancelledOnce, redeemed, lotteryResultVisible, resultText, history };
  }

  async function verifyPointRecordInAdmin(account, expectedText) {
    await ensureTestRoster(account);
    const row = Array.from(document.querySelectorAll('#memberTableBody tr')).find((item) => item.textContent?.includes(String(account.memberCode || '')));
    const button = row?.querySelector('button[data-action="view-records"]');
    if (!button) return false;
    button.click();
    const modal = await waitFor(() => {
      const node = document.getElementById('memberRecordsModal');
      return node && !node.classList.contains('hidden') ? node : null;
    }, 7000);
    if (!modal) return false;
    modal.querySelector('[data-record-filter="pointCards"]')?.click();
    const visible = Boolean(await waitFor(() => String(modal.querySelector('#memberRecordsList')?.textContent || '').includes(expectedText), 10000, 120));
    document.getElementById('closeMemberRecordsModal')?.click();
    return visible;
  }

  async function deleteDeepPointCard(ctx) {
    if (!ctx.cardId) return true;
    document.getElementById('cardsTab')?.click();
    document.getElementById('cardSettingsTab')?.click();
    const row = document.querySelector('#cardListItems [data-card-id="' + CSS.escape(ctx.cardId) + '"]');
    row?.click();
    if (!await waitFor(() => String(document.getElementById('cardId')?.value || '') === String(ctx.cardId), 5000)) return false;
    return withAutoConfirm(async () => {
      document.getElementById('deleteCardButton')?.click();
      const deleted = Boolean(await waitFor(() => !String(document.getElementById('cardId')?.value || ''), 15000));
      closeEditorModalById('cardEditorModal');
      return deleted;
    });
  }

  async function deepPointTicketRealtimeCase(ctx) {
    const account = ctx.account;
    const participant = ctx.participant;
    const pointsLogin = await createPairedSession(account, 'points');
    seedParticipantSession(participant, pointsLogin);
    const child = await waitParticipantSurface(participant, 'points', 'pointsView');
    const baselineTabs = String(child.document.getElementById('cardTabs')?.textContent || '');

    await createDeepPointCard(ctx);
    const cardRealtime = Boolean(await waitFor(() => {
      try { return Array.from(child.document.querySelectorAll('#cardTabs [data-card-id]')).some((node) => String(node.dataset.cardId || '') === String(ctx.cardId)); }
      catch { return false; }
    }, 12000, 120));
    await selectChildCard(child, ctx.cardId);
    const invalid = await invalidPointGrantCase(account, ctx.cardId);

    const session = await adminSession();
    const requestId = 'E2E-PTS-' + qaCrudStamp();
    const payload = {
      lineUserId: account.lineUserId,
      requestId,
      messagePresetId: '',
      points: [{ cardId: ctx.cardId, amount: 1 }]
    };
    const replay = await Promise.allSettled([
      window.MemberSystem.request(session.config, 'admin', session.idToken, 'admin.member-grants.add', payload),
      window.MemberSystem.request(session.config, 'admin', session.idToken, 'admin.member-grants.add', payload)
    ]);
    const replayRealtime = Boolean(await waitFor(() => childPointState(child, ctx.cardId, ctx.cardTitle, ctx.ticketTitle).points === 1, 12000, 120));

    await submitPointGrant(account, ctx.cardId, 1, true);
    const awarded = Boolean(await waitFor(() => {
      const snapshot = childPointState(child, ctx.cardId, ctx.cardTitle, ctx.ticketTitle);
      return snapshot.points === 2 && snapshot.ticketVisible;
    }, 15000, 120));
    const beforeRedeem = childPointState(child, ctx.cardId, ctx.cardTitle, ctx.ticketTitle);
    const userRedeem = await redeemDeepTicketInChild(child, ctx.ticketTitle, true);
    const adminRecordVisible = await verifyPointRecordInAdmin(account, ctx.cardTitle);

    const deleted = await deleteDeepPointCard(ctx);
    ctx.cardDeleted = deleted;
    const cardRemovedRealtime = Boolean(await waitFor(() => {
      try { return !Array.from(child.document.querySelectorAll('#cardTabs [data-card-id]')).some((node) => String(node.dataset.cardId || '') === String(ctx.cardId)); }
      catch { return false; }
    }, 12000, 120));

    const actual = {
      baselineHadQaCard: baselineTabs.includes(ctx.cardTitle || '---'),
      sessionSurface: 'points',
      cardRealtime,
      invalid,
      replayRequests: replay.map((item) => item.status),
      replayRealtime,
      doubleSubmitResult: beforeRedeem,
      awarded,
      userRedeem,
      adminRecordVisible,
      cardDeleted: deleted,
      cardRemovedRealtime
    };
    const ok = cardRealtime && Object.values(invalid).every(Boolean) && replayRealtime && awarded &&
      beforeRedeem.points === 2 && userRedeem.selected && userRedeem.cancelledOnce && userRedeem.redeemed &&
      userRedeem.lotteryResultVisible && userRedeem.history && adminRecordVisible && deleted && cardRemovedRealtime;
    return ok
      ? pass('票券／點數已完成 points 專屬 Session、管理端建立、非法輸入、同 requestId 併發重送、UI 連點發放、用戶端即時出票與真人核銷，再反向同步到管理端紀錄並清理。', {
          sessionSurface: 'points', cardRealtime: true, invalidRejected: true, replayPoints: 1, finalPointsBeforeRedeem: 2,
          ticketRealtime: true, lotteryResultVisible: true, userRedeemed: true, adminRecordVisible: true, cleanupRealtime: true
        }, actual)
      : fail('票券／點數深度協同 E2E 發現狀態不一致。', {
          sessionSurface: 'points', cardRealtime: true, invalidRejected: true, replayPoints: 1, finalPointsBeforeRedeem: 2,
          ticketRealtime: true, lotteryResultVisible: true, userRedeemed: true, adminRecordVisible: true, cleanupRealtime: true
        }, actual);
  }

  async function cleanupDeepContext(ctx) {
    const result = {
      tierRestored: !ctx.tierSettingsChanged,
      postTestAutoCleanupSkipped: true,
      accountPreserved: Boolean(ctx.account),
      originalSessionRestored: false
    };
    if (ctx.tierSettingsChanged && Array.isArray(ctx.originalTierSettings)) {
      try {
        await ensureTestRoster(ctx.account);
        await saveTierSettingsViaUi(ctx.originalTierSettings);
        result.tierRestored = true;
      } catch {}
    }
    const originalWindow = participantWindow(ctx.participant, ctx.originalSurface || 'member');
    if (ctx.originalLogin && originalWindow && !originalWindow.closed) {
      try {
        seedParticipantSession(ctx.participant, ctx.originalLogin, ctx.originalSurface || 'member');
        navigateParticipant(ctx.participant, ctx.originalSurface || 'member');
        result.originalSessionRestored = true;
      } catch {}
    } else {
      result.originalSessionRestored = true;
    }
    return result;
  }

  async function runDeepPairedSuite(participant) {
    const previousAdminAccount = state.adminTestAccount;
    const ctx = {
      participant,
      originalLogin: participant.login || null,
      originalSurface: participant.lastSurfaceKey || 'member',
      account: null,
      originalTierSettings: null,
      tierSettingsChanged: false,
      cardId: '',
      ticketTemplateId: '',
      cardDeleted: false
    };
    participant.status = '深度互動';
    participant.surface = state.selectedModules.includes('points') ? '票券／點數' : '會員階級／時數';
    renderParticipants();
    try {
      ctx.account = await createEphemeralTestAccount();
      state.adminTestAccount = ctx.account;
      if (state.selectedModules.includes('member')) {
        const login = await createPairedSession(ctx.account, 'member');
        seedParticipantSession(participant, login);
      }
      const definitions = [];
      if (state.selectedModules.includes('member')) {
        definitions.push(caseDef('PAIRED_DEEP_SERVICE_TIER_REALTIME', '深度：會員階級／服務時數跨端 Realtime + 冪等 + 連點', 'Paired E2E / Membership', () => deepServiceTierRealtimeCase(ctx)));
      }
      if (state.selectedModules.includes('points')) {
        definitions.push(caseDef('PAIRED_DEEP_POINT_TICKET_REALTIME', '深度：票券／發放點數跨端 Realtime + 核銷回寫', 'Paired E2E / Points', () => deepPointTicketRealtimeCase(ctx)));
      }
      await executeCases(definitions, '深度協同 · 臨時測試會員');
    } finally {
      const retention = ctx.account ? await cleanupDeepContext(ctx) : {
        tierRestored: true,
        postTestAutoCleanupSkipped: true,
        accountPreserved: true,
        originalSessionRestored: true
      };
      state.results.push({
        key: 'PAIRED_DEEP_RETENTION',
        name: '深度 E2E：保留測試資料並還原共用設定',
        domain: 'Paired E2E / Retention',
        status: Object.values(retention).every(Boolean) ? 'passed' : 'failed',
        message: Object.values(retention).every(Boolean)
          ? '臨時測試會員與未被測試流程主動刪除的 QA 資料已保留；共用會員階級設定與原始測試視窗 Session 已還原。'
          : '深度 E2E 的資料保留或共用設定還原有未完成項目，請依 Actual 檢查。',
        expected: { tierRestored: true, postTestAutoCleanupSkipped: true, accountPreserved: true, originalSessionRestored: true },
        actual: retention,
        durationMs: 0
      });
      state.adminTestAccount = previousAdminAccount;
      participant.status = '完成';
      participant.surface = '完成';
      renderParticipants();
      render();
    }
  }


  function provideBackgroundSession(requestedRunId) {
    if (isBackgroundRunnerWindow()) return null;
    const runId = String(requestedRunId || '');
    if (!runId || runId !== String(state.backgroundRunId || '')) return null;
    const session = window.MemberAdminSession?.get?.();
    if (!session?.idToken || !session?.config) return null;
    return {
      idToken: String(session.idToken),
      config: safe(session.config),
      runId
    };
  }


  window.MemberAdminE2EControl = Object.freeze({
    version: VERSION,
    runPairedFull: () => isBackgroundRunnerWindow()
      ? runPaired({ backgroundExecution: true })
      : startUnifiedBackgroundE2E(),
    runUnifiedBackground: (options) => runUnifiedBackground(options),
    replayFailedRun: (runId) => replayFailedRun(runId),
    isRunning: () => state.running,
    receiveBackgroundStatus: (snapshot, runnerWindow) => receiveBackgroundStatus(snapshot, runnerWindow),
    provideBackgroundSession: (runId) => provideBackgroundSession(runId),
    getStatus: () => backgroundStatusSnapshot(),
    publishStatus: () => publishBackgroundStatus(),
    stop: () => requestStop(),
    maxPairedParticipants: MAX_PAIRED_PARTICIPANTS
  });
})();
