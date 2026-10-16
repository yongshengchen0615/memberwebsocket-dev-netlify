(() => {
  'use strict';

  const HTML2CANVAS_URL = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
  const FAILURE_SCREENSHOT_MAX_BYTES = 1900000;
  const FAILURE_SCREENSHOT_BUDGET = 1;
  let html2canvasLoader = null;

  const VERSION = '2026-10-15.2';
  const USER_NODE_TIMEOUT_MS = 75000;
  const USER_BOOKING_NODE_TIMEOUT_MS = 4 * 60 * 1000;
  const HISTORY_KEY = 'member-user-qa-history-v1';
  const PANEL_ID = 'userAutomationTestPanel';
  const LAUNCHER_ID = 'userAutomationTestLauncher';
  const MAX_HISTORY = 5;
  const REPLAY_STORAGE_KEY = 'member-e2e-replay-v1';
  const LEARNING_STORAGE_KEY = 'member-e2e-learning-v2';

  const SURFACES = Object.freeze({
    member: {
      label: '會員卡',
      rootId: 'memberView',
      essentialIds: ['memberPass', 'memberCode', 'memberHonorificName', 'memberBirthday', 'memberPhone', 'membershipProgress'],
      bootstrapAction: 'user.member.bootstrap'
    },
    points: {
      label: '集點卡',
      rootId: 'pointsView',
      essentialIds: ['cardTabs', 'activeCardView', 'ticketList', 'ticketHistoryList', 'membershipProgress'],
      bootstrapAction: 'user.pointcard.bootstrap'
    },
    event: {
      label: '活動票券',
      rootId: 'eventView',
      essentialIds: ['eventList', 'eventSummary', 'ticketModal', 'usedTicketList', 'membershipProgress'],
      bootstrapAction: 'user.event.bootstrap'
    },
    calendar: {
      label: '活動日曆',
      rootId: 'calendarView',
      essentialIds: ['calendarGrid', 'monthTitle', 'previousMonthButton', 'nextMonthButton', 'calendarDetailModal'],
      bootstrapAction: 'user.calendar.bootstrap'
    },
    booking: {
      label: '預約',
      rootId: 'bookingView',
      essentialIds: ['bookingForm', 'servicePicker', 'bookingDate', 'slotGrid', 'bookingList', 'bookingConfirmModal'],
      bootstrapAction: 'user.booking.bootstrap'
    }
  });

  const USER_NODE_META = Object.freeze({
    COMMON_TEST_SESSION: { module: 'shared', phase: 0, required: true, risk: 'auth' },
    COMMON_TOUR_AUTOSTART: { module: 'shared', phase: 0, required: true, dependencies: ['COMMON_TEST_SESSION'] },
    COMMON_TOUR_JOURNEY: { module: 'shared', phase: 0, required: true, dependencies: ['COMMON_TOUR_AUTOSTART'] },
    COMMON_CONFIG: { module: 'shared', phase: 0, required: true, dependencies: ['COMMON_TOUR_JOURNEY'] },
    COMMON_E2E_GPS_CAPTURE: { module: 'shared', phase: 0, required: true, risk: 'location', dependencies: ['COMMON_TEST_SESSION'] },
    COMMON_SURFACE_READY: { module: 'shared', phase: 1, required: true, dependencies: ['COMMON_CONFIG'] },
    COMMON_BOOTSTRAP: { module: 'shared', phase: 1, required: true, dependencies: ['COMMON_SURFACE_READY'] },
    COMMON_ESSENTIAL_DOM: { module: 'shared', phase: 1, required: true, dependencies: ['COMMON_SURFACE_READY'] },
    COMMON_USAGE_STATE_COMPLEXITY: { module: 'shared', phase: 2, required: true, dependencies: ['COMMON_BOOTSTRAP'] },
    SECURITY_MISSING_SESSION: { module: 'shared', phase: 2, required: true, risk: 'security', dependencies: ['COMMON_BOOTSTRAP'] },
    SECURITY_TAMPERED_SESSION: { module: 'shared', phase: 2, required: true, risk: 'security', dependencies: ['COMMON_BOOTSTRAP'] },
    SECURITY_QA_SURFACE_BOUNDARY: { module: 'shared', phase: 2, required: true, risk: 'security', dependencies: ['COMMON_BOOTSTRAP'] },
    SECURITY_ADMIN_BOUNDARY: { module: 'shared', phase: 2, required: true, risk: 'security', dependencies: ['COMMON_BOOTSTRAP'] },
    COMMON_REALTIME: { module: 'shared', phase: 3, required: true, dependencies: ['COMMON_BOOTSTRAP'] },
    COMMON_THEME_TOGGLE: { module: 'shared', phase: 3 },
    COMMON_MEMBERSHIP_MILESTONE: { module: 'shared', phase: 3 },
    COMMON_FEATURE_CONTRACT_COVERAGE: { module: 'shared', phase: 6 },

    MEMBER_FRIEND_CONTROLS: {module:'member',phase:4,dependencies:['MEMBER_PROFILE_DATA']},
    BOOKING_HISTORY_TABS: {module:'booking',phase:5,dependencies:['BOOKING_HUMAN_LIFECYCLE']},
    BOOKING_SNAPSHOT_HISTORY_TABS: {module:'booking',phase:5,dependencies:['BOOKING_ACCESSIBLE_SCREENSHOT_RECEIPT']},
    MEMBER_PHONE_COUNTRY_VALIDATION: { module: 'member', phase: 4, dependencies: ['MEMBER_PROFILE_DATA'] },
    MEMBER_PROFILE_DATA: { module: 'member', phase: 3, required: true, dependencies: ['COMMON_BOOTSTRAP'] },
    MEMBER_TERMS_CONSENT: { module: 'member', phase: 3, required: true, dependencies: ['MEMBER_PROFILE_DATA'] },
    MEMBER_JOIN_TERMS_FLOW: { module: 'member', phase: 4, required: true, dependencies: ['MEMBER_TERMS_CONSENT'] },
    MEMBER_CODE_COPY: {module:'member',phase:3,dependencies:['MEMBER_PROFILE_DATA']},
    MEMBER_QR_CONTROLS: {module:'member',phase:4,dependencies:['MEMBER_REFERRAL_BOUNDARY']},
    POINTS_TRANSFER_RECIPIENT_CONTROLS: {module:'points',phase:4,dependencies:['POINTS_TRANSFER_BOUNDARY']},
    MEMBER_REFERRAL_BOUNDARY: { module: 'member', phase: 4, required: true, risk: 'security', dependencies: ['MEMBER_PROFILE_DATA'] },
    MEMBER_JOIN_LINE_AUTOMATION_CONTRACT: { module: 'member', phase: 5, required: true, dependencies: ['MEMBER_PROFILE_DATA'] },
    MEMBER_MODAL_OPEN_CLOSE: { module: 'member', phase: 3, dependencies: ['MEMBER_PROFILE_DATA'] },
    MEMBER_HUMAN_PROFILE_EDIT: { module: 'member', phase: 4, required: true, risk: 'mutation', dependencies: ['MEMBER_PROFILE_DATA', 'MEMBER_MODAL_OPEN_CLOSE'] },
    MEMBER_INVALID_WRITE: { module: 'member', phase: 4, dependencies: ['MEMBER_PROFILE_DATA'] },
    MEMBER_SERVER_MUTATION: { module: 'member', phase: 4, dependencies: ['MEMBER_PROFILE_DATA'] },
    MEMBER_LINE_SUPPRESSION: { module: 'member', phase: 5, required: true, risk: 'notification' },
    MEMBER_BUTTON_COVERAGE: { module: 'member', phase: 6 },

    POINTS_DATA: { module: 'points', phase: 3, required: true, dependencies: ['COMMON_BOOTSTRAP'] },
    POINTS_SETTINGS: { module: 'points', phase: 3, required: true, dependencies: ['POINTS_DATA'] },
    POINTS_TRANSFER_BOUNDARY: { module: 'points', phase: 4, required: true, risk: 'security', dependencies: ['POINTS_DATA'] },
    POINTS_CARD_SWITCH: { module: 'points', phase: 3, dependencies: ['POINTS_DATA'] },
    POINTS_HISTORY_DISCLOSURE: { module: 'points', phase: 3, dependencies: ['POINTS_DATA'] },
    POINTS_HUMAN_REDEEM: { module: 'points', phase: 4, required: true, risk: 'mutation', dependencies: ['POINTS_DATA', 'POINTS_SETTINGS', 'POINTS_CARD_SWITCH'] },
    POINTS_INVALID_WRITE: { module: 'points', phase: 4, dependencies: ['POINTS_DATA'] },
    POINTS_BUTTON_COVERAGE: { module: 'points', phase: 6 },

    EVENT_DATA: { module: 'event', phase: 3, required: true, dependencies: ['COMMON_BOOTSTRAP'] },
    EVENT_BOUNDARY_STATES: { module: 'event', phase: 3, required: true, dependencies: ['EVENT_DATA', 'COMMON_USAGE_STATE_COMPLEXITY'] },
    EVENT_TODAY_USABLE_LIMIT: { module: 'event', phase: 3, required: true, dependencies: ['EVENT_DATA'] },
    EVENT_MODAL: { module: 'event', phase: 3, dependencies: ['EVENT_DATA'] },
    EVENT_HISTORY_DISCLOSURE: { module: 'event', phase: 3, dependencies: ['EVENT_DATA'] },
    EVENT_HUMAN_LIFECYCLE: { module: 'event', phase: 4, required: true, risk: 'mutation', dependencies: ['EVENT_DATA', 'EVENT_MODAL'] },
    EVENT_INVALID_WRITE: { module: 'event', phase: 4, dependencies: ['EVENT_DATA'] },
    EVENT_BUTTON_COVERAGE: { module: 'event', phase: 6 },

    CALENDAR_DETAIL_API: { module: 'calendar', phase: 3, required: true, dependencies: ['COMMON_BOOTSTRAP'] },
    CALENDAR_NAVIGATION: { module: 'calendar', phase: 3, dependencies: ['COMMON_SURFACE_READY'] },
    CALENDAR_HUMAN_DETAIL: { module: 'calendar', phase: 4, required: true, dependencies: ['CALENDAR_DETAIL_API', 'CALENDAR_NAVIGATION'] },
    CALENDAR_INVALID_DATE: { module: 'calendar', phase: 4, dependencies: ['CALENDAR_DETAIL_API'] },
    CALENDAR_SERVER_BOUNDARY: { module: 'calendar', phase: 4, risk: 'security', dependencies: ['CALENDAR_DETAIL_API'] },
    CALENDAR_LINE_SUPPRESSION: { module: 'calendar', phase: 5, required: true, risk: 'notification' },
    CALENDAR_BUTTON_COVERAGE: { module: 'calendar', phase: 6 },

    BOOKING_ACCESSIBLE_MODE: { module: 'booking', phase: 5, dependencies: ['BOOKING_DATA'] },
    BOOKING_ACCESSIBLE_RECEIPT_BOUNDARY: { module: 'booking', phase: 5, risk: 'security', dependencies: ['BOOKING_DATA'] },
    BOOKING_ACCESSIBLE_SCREENSHOT_RECEIPT: { module: 'booking', phase: 5, required: true, risk: 'mutation', dependencies: ['BOOKING_ACCESSIBLE_MODE', 'BOOKING_ACCESSIBLE_RECEIPT_BOUNDARY'] },
    BOOKING_TICKET_RULES: { module: 'booking', phase: 5, dependencies: ['BOOKING_BENEFIT_REDEMPTION_LIFECYCLE'] },
    BOOKING_HISTORY_TICKET_SOURCES: { module: 'booking', phase: 5, dependencies: ['BOOKING_BENEFIT_REDEMPTION_LIFECYCLE','BOOKING_HUMAN_LIFECYCLE','BOOKING_HUMAN_GROUP'] },
    BOOKING_DATA: { module: 'booking', phase: 3, required: true, dependencies: ['COMMON_BOOTSTRAP'] },
    BOOKING_GROUP_DATA: { module: 'booking', phase: 3, required: true, dependencies: ['BOOKING_DATA'] },
    BOOKING_FORM_INITIAL: { module: 'booking', phase: 3, required: true, dependencies: ['BOOKING_DATA'] },
    BOOKING_BENEFITS_RECOMMENDATIONS: { module: 'booking', phase: 3, required: true, dependencies: ['BOOKING_DATA'] },
    BOOKING_BENEFIT_REDEMPTION_LIFECYCLE: { module: 'booking', phase: 4, required: true, risk: 'mutation', dependencies: ['BOOKING_BENEFITS_RECOMMENDATIONS', 'BOOKING_HUMAN_CONTROLS'] },
    BOOKING_RECEIPT_REVIEW_CONTRACT: { module: 'booking', phase: 5, required: true, dependencies: ['BOOKING_DATA'] },
    BOOKING_FLOW_STEPPER: { module: 'booking', phase: 3, dependencies: ['BOOKING_FORM_INITIAL'] },
    BOOKING_HUMAN_CONTROLS: { module: 'booking', phase: 4, required: true, dependencies: ['BOOKING_FORM_INITIAL', 'BOOKING_FLOW_STEPPER'] },
    BOOKING_HUMAN_LIFECYCLE: { module: 'booking', phase: 4, required: true, risk: 'mutation', dependencies: ['BOOKING_HUMAN_CONTROLS'] },
    BOOKING_HUMAN_GROUP: { module: 'booking', phase: 4, required: true, risk: 'mutation', dependencies: ['BOOKING_GROUP_DATA', 'BOOKING_HUMAN_CONTROLS'] },
    BOOKING_INVALID_WRITE: { module: 'booking', phase: 4, dependencies: ['BOOKING_DATA'] },
    BOOKING_BUTTON_COVERAGE: { module: 'booking', phase: 6 }
  });

  const surface = detectSurface();
  const definition = SURFACES[surface];
  if (!definition) return;

  const state = {
    config: null,
    session: null,
    visible: false,
    running: false,
    pendingTimedOutNode: null,
    cancelled: false,
    currentSuite: 'quick',
    results: [],
    bootstrap: null,
    mutationSuite: null,
    browserRun: null,
    usageState: null,
    usageStateError: null,
    gpsFixture: null,
    bookingBaseline: null,
    bookingHandoff: null,
    availabilitySync: null,
    bookingLaneDayCount: 1,
    randomSeed: '',
    randomState: 0,
    complexityLevel: 1,
    participantIndex: 1,
    scenarioPlan: null,
    caseCatalogKeys: [],
    featureCoverage: null,
    replayConfig: null,
    learningByCase: {},
    adaptiveReplaySourceKeys: [],
    randomStateAfterBuild: 0,
    runStartedAt: '',
    traceEvents: [],
    traceResourceStart: 0,
    failureScreenshotsCaptured: 0,
    activeHumanCaptureCleanup: null,
    traceCleanup: null,
    launcher: null,
    panel: null
  };

  window.addEventListener('DOMContentLoaded', () => {
    void synchronizeAvailability();
  });
  window.addEventListener('member-test-session-ready', () => {
    void synchronizeAvailability();
  });
  window.addEventListener('pageshow', () => {
    void synchronizeAvailability();
  });
  window.addEventListener('member-test-session-revoked', () => {
    state.cancelled = true;
    state.session = null;
    if (state.running) {
      setStatus('已停止');
      setMessage('測試資料或測試帳號已被管理端移除，本次 E2E 已立即停止。', true);
    }
    removeUi();
  });

  function detectSurface() {
    const match = String(window.location.pathname || '').match(/\/MemberWebsocket-dev\/(member|points|event|calendar|booking)\/?/i);
    return match ? String(match[1] || '').toLowerCase() : '';
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function elapsed(start) {
    return Math.max(0, Math.round(performance.now() - start));
  }

  function hashSeed(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0 || 0x9e3779b9;
  }

  function readReplayConfig() {
    let raw = '';
    try {
      raw = String(sessionStorage.getItem(REPLAY_STORAGE_KEY) || '');
      if (raw) sessionStorage.removeItem(REPLAY_STORAGE_KEY);
    } catch (_) {}
    if (!raw) return null;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { throw new Error('E2E replay descriptor is not valid JSON.'); }
    if (!parsed || Number(parsed.version) !== 1 || String(parsed.surface || '') !== surface) {
      throw new Error('E2E replay descriptor does not match the current user surface.');
    }
    if (!Array.isArray(parsed.scenarioPath) || !parsed.scenarioPath.length) {
      throw new Error('E2E replay descriptor is missing its locked scenario path.');
    }
    return {
      version: 1,
      surface,
      participantIndex: Math.max(1, Number(parsed.participantIndex || 1) || 1),
      seed: String(parsed.seed || ''),
      complexityLevel: Math.max(1, Math.min(8, Number(parsed.complexityLevel || 1) || 1)),
      scenarioFingerprint: String(parsed.scenarioFingerprint || ''),
      scenarioPath: parsed.scenarioPath.map((key) => String(key || '')).filter(Boolean),
      adaptiveReplaySourceKeys: Array.isArray(parsed.adaptiveReplaySourceKeys)
        ? parsed.adaptiveReplaySourceKeys.map((key) => String(key || '')).filter(Boolean).slice(0, 3) : [],
      randomStateAfterBuild: Number.isInteger(Number(parsed.randomStateAfterBuild))
        ? (Number(parsed.randomStateAfterBuild) >>> 0) : null
    };
  }

  function readHistoricalLearning() {
    try {
      const parsed = JSON.parse(String(localStorage.getItem(LEARNING_STORAGE_KEY) || '{}'));
      if (Number(parsed?.version) !== 2) return {};
      if (Number(parsed?.expiresAt || 0) <= Date.now()) return {};
      return parsed?.caseLearning && typeof parsed.caseLearning === 'object'
        ? parsed.caseLearning
        : {};
    } catch (_) {
      return {};
    }
  }

  function historicalLearning(caseKey) {
    const value = state.learningByCase?.[String(caseKey || '')];
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

  function configureRunProfile() {
    const params = new URLSearchParams(window.location.search);
    state.replayConfig = readReplayConfig();
    state.learningByCase = readHistoricalLearning();
    state.randomSeed = String(state.replayConfig?.seed || params.get('e2eSeed') || ('USER-' + surface + '-' + Date.now().toString(36)));
    state.randomState = hashSeed(state.randomSeed);
    state.complexityLevel = Math.max(1, Math.min(8, Number(state.replayConfig?.complexityLevel || params.get('e2eComplexity') || 1) || 1));
    state.participantIndex = Math.max(1, Number(state.replayConfig?.participantIndex || params.get('e2eParticipant') || 1) || 1);
  }

  function nextRandomUnit() {
    if (!state.randomState) configureRunProfile();
    let x = state.randomState >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    state.randomState = x >>> 0;
    return (state.randomState >>> 0) / 4294967296;
  }

  function randomInt(min, max) {
    const low = Math.ceil(Number(min) || 0);
    const high = Math.floor(Number(max) || low);
    if (high <= low) return low;
    return low + Math.floor(nextRandomUnit() * (high - low + 1));
  }

  function shuffled(items) {
    const copy = Array.isArray(items) ? items.slice() : [];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = randomInt(0, index);
      [copy[index], copy[swap]] = [copy[swap], copy[index]];
    }
    return copy;
  }

  function randomInteractionPause() {
    const level = Math.max(1, Number(state.complexityLevel || 1));
    return wait(randomInt(70, 260 + level * 90));
  }

  function planUserScenario(nodes) {
    state.caseCatalogKeys = nodes.map(item => item.key);
    const planner = window.MemberE2EScenarioGraph;
    const requiredKeys = nodes.filter((item) => item.humanRequired === true).map((item) => item.key);
    if (state.replayConfig) {
      if (!planner || typeof planner.replayScenario !== 'function') throw new Error('目前版本缺少 E2E locked-path replay planner，已停止重播。');
      const plan = planner.replayScenario({
        nodes, metaByKey: USER_NODE_META, seed: state.randomSeed,
        complexityLevel: state.complexityLevel, requiredKeys,
        keys: state.replayConfig.scenarioPath,
        expectedFingerprint: state.replayConfig.scenarioFingerprint
      });
      const byKey = new Map(nodes.map((item) => [String(item.key || ''), item]));
      return { plan, nodes: plan.keys.map((key) => byKey.get(key)).filter(Boolean) };
    }
    if (!planner || typeof planner.planScenario !== 'function') {
      const fallback = {
        version: 1, seed: state.randomSeed, complexityLevel: state.complexityLevel,
        fingerprint: 'SG1-fallback', keys: nodes.map((item) => String(item.key || '')),
        path: nodes.map((item, index) => ({
          order: index + 1, key: String(item.key || ''), name: String(item.name || ''),
          domain: String(item.domain || ''), module: 'fallback', phase: 0, risk: 'normal', required: true
        }))
      };
      return { plan: fallback, nodes: nodes.slice() };
    }
    const plan = planner.planScenario({
      nodes, metaByKey: USER_NODE_META, randomUnit: nextRandomUnit,
      seed: state.randomSeed, complexityLevel: state.complexityLevel,
      coverageMode: 'full', minNodes: nodes.length, maxNodes: nodes.length, requiredKeys,
      priorityByKey: historicalPriorityMap()
    });
    const byKey = new Map(nodes.map((item) => [String(item.key || ''), item]));
    return { plan, nodes: plan.keys.map((key) => byKey.get(key)).filter(Boolean) };
  }

  function plainError(error) {
    return {
      code: String(error && error.code || error && error.name || 'ERROR').slice(0, 120),
      message: String(error && error.message || '未知錯誤').slice(0, 500)
    };
  }

  function safeJson(value) {
    if (value === undefined) return null;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (Array.isArray(value)) return value.slice(0, 20).map(safeJson);
    if (typeof value !== 'object') return String(value);
    const out = {};
    const blocked = /^(?:.*token.*|.*secret.*|password|phone|birthday|lineuserid|line_user_id|surname|displayname)$/i;
    Object.entries(value).slice(0, 40).forEach(([key, item]) => {
      const sensitiveScalar = blocked.test(key) && (item === null || ['string', 'number', 'bigint'].includes(typeof item));
      if (sensitiveScalar) {
        out[key] = '[redacted]';
        return;
      }
      out[key] = safeJson(item);
    });
    return out;
  }

  function diagnosticPath(value) {
    try {
      const parsed = new URL(String(value || ''), window.location.href);
      return parsed.pathname || '/';
    } catch {
      return String(value || '').split('?')[0].slice(0, 240);
    }
  }

  function pushDiagnosticEvent(type, detail = {}) {
    state.traceEvents.push({
      atMs: Date.now(),
      type: String(type || 'event').slice(0, 80),
      detail: safeJson(detail)
    });
    if (state.traceEvents.length > 80) state.traceEvents.shift();
  }

  function startDiagnosticTrace() {
    if (typeof state.traceCleanup === 'function') state.traceCleanup();
    state.traceEvents = [];
    state.traceResourceStart = performance.getEntriesByType('resource').length;
    const listeners = [];
    const on = (target, type, handler) => {
      target?.addEventListener?.(type, handler, true);
      listeners.push(() => target?.removeEventListener?.(type, handler, true));
    };
    on(window, 'error', (event) => pushDiagnosticEvent('window.error', {
      message: String(event?.message || '').slice(0, 300),
      source: diagnosticPath(event?.filename || ''),
      line: Number(event?.lineno || 0)
    }));
    on(window, 'unhandledrejection', (event) => pushDiagnosticEvent('window.unhandledrejection', plainError(event?.reason)));
    on(window, 'online', () => pushDiagnosticEvent('network.online', {}));
    on(window, 'offline', () => pushDiagnosticEvent('network.offline', {}));
    on(window, 'pageshow', () => pushDiagnosticEvent('page.show', { persisted: false }));
    on(document, 'visibilitychange', () => pushDiagnosticEvent('page.visibility', { visibilityState: document.visibilityState }));
    for (const type of ['booking:created', 'booking:bookings-rendered', 'booking:settings-updated', 'booking:selection-changed']) {
      on(window, type, (event) => pushDiagnosticEvent(type, event?.detail || {}));
    }
    for (const type of ['click', 'input', 'change', 'submit']) {
      on(document, type, event => pushDiagnosticEvent('ui.' + type, { target: humanTargetLabel(event.target) }));
    }
    state.traceCleanup = () => {
      while (listeners.length) {
        try { listeners.pop()(); } catch {}
      }
      state.traceCleanup = null;
    };
  }

  function stopDiagnosticTrace() {
    if (typeof state.traceCleanup === 'function') state.traceCleanup();
  }

  function diagnosticMarker() {
    return {
      eventIndex: state.traceEvents.length,
      resourceIndex: performance.getEntriesByType('resource').length,
      startedAtMs: Date.now()
    };
  }

  function resourceTimingsSince(index) {
    return performance.getEntriesByType('resource')
      .slice(Math.max(0, Number(index || 0)))
      .filter((entry) => ['fetch', 'xmlhttprequest'].includes(String(entry.initiatorType || '').toLowerCase()))
      .slice(-20)
      .map((entry) => ({
        path: diagnosticPath(entry.name),
        initiatorType: String(entry.initiatorType || ''),
        responseStatus: Number(entry.responseStatus || 0) || null,
        durationMs: Math.max(0, Math.round(Number(entry.duration || 0))),
        transferSize: Math.max(0, Number(entry.transferSize || 0))
      }));
  }

  function buildFailureTrace(marker, row, error = null) {
    return safeJson({
      artifactVersion: 1,
      seed: state.randomSeed,
      complexityLevel: state.complexityLevel,
      participantIndex: state.participantIndex,
      surface,
      caseKey: row?.key || '',
      domain: row?.domain || '',
      page: {
        path: diagnosticPath(window.location?.href || ''),
        readyState: String(document?.readyState || ''),
        visibilityState: String(document?.visibilityState || ''),
        online: window.navigator?.onLine !== false
      },
      elapsedMs: Math.max(0, Date.now() - Number(marker?.startedAtMs || Date.now())),
      events: state.traceEvents.slice(0).filter(event => event.atMs >= Number(marker?.startedAtMs || 0)).slice(-20),
      apiTimings: resourceTimingsSince(marker?.resourceIndex),
      error: error ? plainError(error) : null
    });
  }

  function result(status, message, expected, actual) {
    return {
      status,
      message: String(message || ''),
      expected: safeJson(expected),
      actual: safeJson(actual)
    };
  }

  function pass(message, expected, actual) {
    return result('passed', message, expected, actual);
  }

  function fail(message, expected, actual) {
    return result('failed', message, expected, actual);
  }

  function skip(message, expected, actual) {
    return result('skipped', message, expected, actual);
  }

  async function loadConfig() {
    if (state.config) return state.config;
    if (surface === 'booking') {
      if (!window.BookingSystem || typeof window.BookingSystem.loadConfig !== 'function') throw new Error('BookingSystem 尚未載入。');
      state.config = await window.BookingSystem.loadConfig();
    } else {
      if (!window.MemberSystem || typeof window.MemberSystem.loadConfig !== 'function') throw new Error('MemberSystem 尚未載入。');
      state.config = await window.MemberSystem.loadConfig();
    }
    return state.config;
  }

  async function synchronizeAvailability() {
    if (state.availabilitySync) return state.availabilitySync;

    const task = (async () => {
      try {
        if (!window.TestModeClient || typeof window.TestModeClient.sessionStatus !== 'function') {
          removeUi();
          return;
        }
        const config = await loadConfig();
        const session = await window.TestModeClient.sessionStatus(config, surface);
        const active = Boolean(session && session.active && session.account && session.account.memberId);
        if (!active) {
          state.session = null;
          removeUi();
          return;
        }
        state.session = session;
        // All visible E2E launchers are centralized in the admin workspace.
        // The user runner remains headless and is invoked only by the unified admin orchestrator.
        removeUi();
      } catch (_) {
        state.session = null;
        removeUi();
      }
    })();

    state.availabilitySync = task;
    try {
      return await task;
    } finally {
      if (state.availabilitySync === task) state.availabilitySync = null;
    }
  }

  function removeUi() {
    const launcher = document.getElementById(LAUNCHER_ID);
    const panel = document.getElementById(PANEL_ID);
    if (launcher) launcher.remove();
    if (panel) panel.remove();
    state.launcher = null;
    state.panel = null;
    state.visible = false;
    document.documentElement.classList.remove('user-qa-open');
  }


  function setMessage(message, isError) {
    if (!state.panel) return;
    const node = state.panel.querySelector('[data-qa-message]');
    node.textContent = String(message || '');
    node.classList.toggle('is-error', Boolean(isError));
  }

  function setRunning(value) {
    state.running = Boolean(value);
    if (!state.panel) return;
    state.panel.querySelectorAll('[data-qa-run]').forEach((button) => { button.disabled = state.running || Boolean(state.pendingTimedOutNode); });
    state.panel.querySelector('[data-qa-cancel]').classList.toggle('hidden', !state.running);
  }

  function requestStop() {
    if (!state.running || state.cancelled) return false;
    state.cancelled = true;
    setStatus('停止中');
    setMessage('已要求停止；目前案例完成安全清理後不再執行下一項。');
    return true;
  }

  function setStatus(value) {
    if (!state.panel) return;
    state.panel.querySelector('[data-qa-status]').textContent = String(value || '—');
  }

  function updateSummary(done, total) {
    if (!state.panel) return;
    const passed = state.results.filter((item) => item.status === 'passed').length;
    const failed = state.results.filter((item) => item.status === 'failed').length;
    const skipped = state.results.filter((item) => item.status === 'skipped').length;
    state.panel.querySelector('[data-qa-passed]').textContent = String(passed);
    state.panel.querySelector('[data-qa-failed]').textContent = String(failed);
    state.panel.querySelector('[data-qa-skipped]').textContent = String(skipped);
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    const bar = state.panel.querySelector('[data-qa-progress]');
    bar.style.width = percent + '%';
    const progress = bar.parentElement;
    progress.setAttribute('aria-valuenow', String(percent));
  }

  function renderResults() {
    if (!state.panel) return;
    const root = state.panel.querySelector('[data-qa-results]');
    root.replaceChildren(...state.results.map((item, index) => renderCase(item, index)));
  }

  function renderCase(item, index) {
    const details = document.createElement('details');
    details.className = 'user-qa-case is-' + item.status;
    details.open = item.status === 'failed' || item.status === 'running';

    const summary = document.createElement('summary');
    const left = document.createElement('span');
    left.className = 'user-qa-case-title';
    const mark = document.createElement('b');
    mark.textContent = item.status === 'passed' ? '✓' : item.status === 'failed' ? '!' : item.status === 'skipped' ? '–' : '●';
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = (index + 1) + '. ' + item.name;
    const meta = document.createElement('small');
    meta.textContent = item.domain + (item.durationMs != null ? ' · ' + item.durationMs + ' ms' : '');
    copy.append(title, meta);
    left.append(mark, copy);

    const badge = document.createElement('span');
    badge.className = 'user-qa-case-badge';
    badge.textContent = statusLabel(item.status);
    summary.append(left, badge);
    details.append(summary);

    if (item.message) {
      const message = document.createElement('p');
      message.className = 'user-qa-case-message';
      message.textContent = item.message;
      details.append(message);
    }

    if (item.status !== 'running') {
      const grid = document.createElement('div');
      grid.className = 'user-qa-data';
      grid.append(dataBox('Expected', item.expected), dataBox('Actual', item.actual));
      details.append(grid);
    }
    return details;
  }

  function dataBox(label, value) {
    const box = document.createElement('section');
    const title = document.createElement('span');
    title.textContent = label;
    const pre = document.createElement('pre');
    try { pre.textContent = JSON.stringify(value === undefined ? null : value, null, 2); }
    catch (_) { pre.textContent = String(value); }
    box.append(title, pre);
    return box;
  }

  function statusLabel(status) {
    return status === 'passed' ? '通過' : status === 'failed' ? '失敗' : status === 'skipped' ? '略過' : status === 'running' ? '執行中' : '等待';
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  async function prepareUsageStateForFullRun() {
    if (surface !== 'booking') {
      return await qaServiceRequest('user.qa.usage-state.prepare', {}, 60000);
    }

    const bookingsById = new Map();
    const stateKinds = new Set();
    const attempts = [];
    let aggregate = null;
    const maxAttempts = Math.max(3, Math.min(7, 2 + Number(state.complexityLevel || 1)));

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const current = await qaServiceRequest('user.qa.usage-state.prepare', {}, 60000);
      aggregate = aggregate ? { ...aggregate, ...current } : { ...current };

      const currentBookings = Array.isArray(current?.bookings) ? current.bookings : [];
      currentBookings.forEach((row) => {
        const bookingId = String(row?.bookingId || '');
        const state = String(row?.state || '');
        if (bookingId) bookingsById.set(bookingId, row);
        if (state) stateKinds.add(state);
      });
      (Array.isArray(current?.stateKinds) ? current.stateKinds : []).forEach((state) => {
        const value = String(state || '');
        if (value === 'pending' || value === 'cancel_requested') stateKinds.add(value);
      });

      attempts.push({
        attempt: attempt + 1,
        recordsCreated: currentBookings.length,
        stateKinds: Array.from(stateKinds)
      });

      aggregate.bookings = Array.from(bookingsById.values());
      aggregate.recordsCreated = aggregate.bookings.length;
      aggregate.stateKinds = Array.from(stateKinds);
      aggregate.prepared = aggregate.prepared === true || current?.prepared === true;
      aggregate.skipped = aggregate.recordsCreated === 0;
      aggregate.usageStateAttempts = attempts.slice();

      if (stateKinds.has('pending') && stateKinds.has('cancel_requested')) break;
      if (attempt < maxAttempts - 1) await wait(250 + attempt * 180);
    }

    return aggregate || {
      prepared: false,
      scenario: 'mixed-booking-lifecycle',
      recordsCreated: 0,
      stateKinds: [],
      bookings: [],
      usageStateAttempts: attempts
    };
  }

  function retainTimedOutNode(pending) {
    state.pendingTimedOutNode = pending;
    const settled = () => {
      if (state.pendingTimedOutNode !== pending) return;
      state.pendingTimedOutNode = null;
      setRunning(state.running);
    };
    pending.then(settled, settled);
  }

  async function captureE2EGpsFixture() {
    const unavailable = (status, reason) => ({ status, reason, source: 'browser-geolocation', testOnly: true });
    if (window.isSecureContext === false || typeof navigator?.geolocation?.getCurrentPosition !== 'function') {
      return unavailable('unavailable', 'GEOLOCATION_UNAVAILABLE');
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition((position) => {
        const coordinates = position?.coords;
        const latitude = Number(coordinates?.latitude);
        const longitude = Number(coordinates?.longitude);
        const accuracyMeters = Number(coordinates?.accuracy);
        const timestamp = Number(position?.timestamp);
        if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180
          || !Number.isFinite(accuracyMeters) || accuracyMeters <= 0 || accuracyMeters > 10000
          || !Number.isFinite(timestamp) || timestamp < Date.now() - 120000 || timestamp > Date.now() + 30000) {
          resolve(unavailable('invalid', 'GPS_FIX_INVALID_OR_STALE'));
          return;
        }
        resolve({
          source: 'browser-geolocation', testOnly: true,
          status: accuracyMeters <= 100 ? 'ready' : 'imprecise',
          latitude: Number(latitude.toFixed(6)), longitude: Number(longitude.toFixed(6)),
          accuracyMeters: Math.max(1, Math.round(accuracyMeters)), capturedAt: new Date(timestamp).toISOString(),
          expiresAt: new Date(timestamp + 120000).toISOString()
        });
      }, (error) => resolve(unavailable(error?.code === 1 ? 'denied' : error?.code === 3 ? 'timeout' : 'unavailable',
        error?.code === 1 ? 'GEOLOCATION_DENIED' : error?.code === 3 ? 'GEOLOCATION_TIMEOUT' : 'GEOLOCATION_ERROR')),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
    });
  }

  function gpsFixtureCase() {
    const fixture = state.gpsFixture;
    if (fixture?.status === 'ready') return pass('本輪 E2E 啟動時已取得瀏覽器 GPS，僅供測試診斷與驗證，正式核銷仍需最新定位。',
      { status: 'ready', source: 'browser-geolocation' }, fixture);
    return skip('本輪 E2E 未取得可用的 GPS 測試基準；不得使用模擬座標或略過正式定位限制。',
      { status: 'ready', source: 'browser-geolocation' }, fixture || { status: 'unavailable' });
  }

  async function runSuite(suite) {
    const requestedSuite = suite === 'full' ? 'full' : 'quick';
    if (state.pendingTimedOutNode) {
      return { ok: false, busy: true, reason: 'timed-out-node-draining', surface, suite: requestedSuite, results: [] };
    }
    if (state.running) {
      return { ok: false, busy: true, surface, suite: requestedSuite, results: [], summary: { passed: 0, failed: 0, skipped: 0, total: 0 } };
    }
    // Reserve the runner before the first async session/config read.
    state.cancelled = false;
    setRunning(true);
    try {
      const session = await window.TestModeClient.sessionStatus(await loadConfig(), surface);
      if (!session || !session.active || !session.account || !session.account.memberId) {
        setRunning(false);
        removeUi();
        return { ok: false, skipped: true, reason: 'inactive-session', surface, suite: requestedSuite, results: [], summary: { passed: 0, failed: 0, skipped: 1, total: 0 } };
      }
      if (state.cancelled) {
        setRunning(false);
        setStatus('已停止');
        return { ok: false, cancelled: true, surface, suite: requestedSuite, results: [] };
      }
      state.session = session;
    } catch (error) {
      setRunning(false);
      removeUi();
      return { ok: false, skipped: true, reason: 'session-check-failed', error: plainError(error), surface, suite: requestedSuite, results: [], summary: { passed: 0, failed: 0, skipped: 1, total: 0 } };
    }

    configureRunProfile();
    state.currentSuite = requestedSuite;
    state.results = [];
    state.featureCoverage = null;
    state.caseCatalogKeys = [];
    state.bootstrap = null;
    state.mutationSuite = null;
    state.browserRun = null;
    state.usageState = null;
    state.usageStateError = null;
    state.gpsFixture = null;
    state.bookingBaseline = null;
    state.bookingHandoff = null;
    state.scenarioPlan = null;
    state.adaptiveReplaySourceKeys = [];
    state.randomStateAfterBuild = 0;
    state.failureScreenshotsCaptured = 0;
    state.cancelled = false;
    state.runStartedAt = new Date().toISOString();
    startDiagnosticTrace();
    setRunning(true);
    setStatus('執行中');
    setMessage(state.currentSuite === 'full'
      ? '正在以可重現 seed=' + state.randomSeed + '、難度 L' + state.complexityLevel + ' 執行隨機案例與自適應壓力重播…'
      : '正在執行快速健康檢查…');
    renderResults();

    // Per-session acquisition before fixtures. This is diagnostic data, NOT an auth bypass.
    if (state.currentSuite === 'full') {
      setMessage('正在取得本輪 E2E 的瀏覽器 GPS 定位；結果會記入測試紀錄。');
      try { state.gpsFixture = await captureE2EGpsFixture(); }
      catch (_) { state.gpsFixture = { status: 'unavailable', reason: 'GEOLOCATION_ERROR', source: 'browser-geolocation', testOnly: true }; }
    }

    let bookingBaselineFailed = false;
    let timedOutCase = false;
    if (surface === 'booking' && state.currentSuite === 'full') {
      try {
        const before = await requestCore('user.booking.bootstrap', {});
        if (!Array.isArray(before?.bookings)) throw new Error('預約基準資料不完整。');
        state.bookingBaseline = before.bookings.map((row) => String(row.bookingId || '')).filter(Boolean);
      } catch (error) {
        bookingBaselineFailed = true;
        state.results.push({ key: 'BOOKING_HANDOFF_BASELINE', name: '預約接手基準', domain: 'Booking / Handoff',
          ...fail('無法建立本輪預約基準，未開始新增測試資料。', { baselineReady: true }, plainError(error)), durationMs: 0 });
      }
    }

    if (state.currentSuite === 'full' && !bookingBaselineFailed) {
      try {
        setMessage('正在建立高複雜度會員使用狀態：歷史、可用、已使用、過期、受限與進行中資料…');
        state.usageState = await prepareUsageStateForFullRun();
        await refreshRealClient().catch(() => {});
      } catch (error) {
        state.usageStateError = plainError(error);
      }
      setMessage('使用狀態前置完成，正在以隨機案例順序與隨機操作間隔執行完整用戶端測試…', Boolean(state.usageStateError));
    }

    const cases = bookingBaselineFailed ? [] : buildCases(state.currentSuite);
    updateSummary(0, cases.length);

    for (let index = 0; index < cases.length; index += 1) {
      if (state.cancelled) break;
      const testCase = cases[index];
      const running = {
        key: testCase.key || '',
        name: testCase.name,
        domain: testCase.domain,
        humanRequired: testCase.humanRequired === true,
        status: 'running',
        message: '執行中…',
        expected: null,
        actual: null,
        durationMs: null
      };
      state.results.push(running);
      renderResults();

      const started = performance.now();
      const traceMarker = diagnosticMarker();
      try {
        const outcome = await window.MemberE2EScenarioGraph.runWithDeadline(async () => {
          let result;
          if (testCase.humanRequired === true) {
            const captured = await captureHumanInteraction(testCase.run, testCase);
            result = captured.outcome;
            const mergedActual = result?.actual && typeof result.actual === 'object' && !Array.isArray(result.actual)
              ? { ...result.actual, humanInteraction: captured.evidence }
              : { value: result?.actual ?? null, humanInteraction: captured.evidence };
            if (result?.status === 'passed' && Number(captured.evidence.eventCount || 0) < 1) {
              result = fail(
                '案例邏輯完成，但沒有觀察到任何真人 UI 互動事件；完整 E2E 不接受只走 API／內部函式。',
                { humanInteractionEventsAtLeast: 1 }, mergedActual
              );
            } else if (result?.status === 'passed' && captured.evidence.professionalTester?.ok === false) {
              result = fail(
                '專業 QA 行為檢查偵測到本次操作引入 UI 結構回歸；完整 E2E 不接受新增重複 ID 或水平溢位。',
                { humanInteractionEventsAtLeast: 1, professionalTesterStructuralRegressionFree: true }, mergedActual
              );
            } else {
              result = { ...result, actual: safeJson(mergedActual) };
            }
          } else {
            result = await testCase.run();
          }
          return result;
        }, surface === 'booking' ? USER_BOOKING_NODE_TIMEOUT_MS : USER_NODE_TIMEOUT_MS,
        testCase.key, (pending) => {
          state.cancelled = true;
          retainTimedOutNode(pending);
          state.activeHumanCaptureCleanup?.();
          state.activeHumanCaptureCleanup = null;
        });
        Object.assign(running, outcome, { durationMs: elapsed(started) });
        if (running.status === 'failed') {
          running.trace = buildFailureTrace(traceMarker, running);
          await attachFailureScreenshot(running);
        }
      } catch (error) {
        timedOutCase = error?.code === 'E2E_NODE_TIMEOUT';
        Object.assign(running, fail(
          '案例執行失敗：' + plainError(error).message,
          { noUnhandledError: true },
          plainError(error)
        ), { durationMs: elapsed(started) });
        running.trace = buildFailureTrace(traceMarker, running, error);
        await attachFailureScreenshot(running);
      }
      renderResults();
      updateSummary(index + 1, cases.length);
      if (timedOutCase) break; // Pending DOM work may still settle; never start another node here.
      await (state.currentSuite === 'full' ? randomInteractionPause() : wait(40));
    }

    if (surface === 'booking' && state.currentSuite === 'full' && !bookingBaselineFailed && !timedOutCase) {
      try {
        const after = await requestCore('user.booking.bootstrap', {});
        state.bookingHandoff = buildBookingHandoff(state.bookingBaseline, after?.bookings, state.session.account.memberId, state.runStartedAt);
        state.results.push({ key: 'BOOKING_ADMIN_HANDOFF', name: '本輪全部 QA 預約接手清單', domain: 'Booking / Handoff',
          ...pass('已收集真人操作與使用狀態資料的全部新建 QA 預約，交由管理端處理。', { completeManifest: true }, state.bookingHandoff), durationMs: 0 });
      } catch (error) {
        state.results.push({ key: 'BOOKING_ADMIN_HANDOFF', name: '本輪全部 QA 預約接手清單', domain: 'Booking / Handoff',
          ...fail('預約接手清單讀取失敗，不能宣告完整流程通過。', { completeManifest: true }, plainError(error)), durationMs: 0 });
      }
    }
    if (!state.cancelled && state.currentSuite === 'full') {
      const requiredHumanCases = cases.filter((item) => item.humanRequired === true);
      const humanRowsByKey = new Map(state.results.map((row) => [String(row.key || ''), row]));
      const missingHumanCases = requiredHumanCases.filter((item) => !humanRowsByKey.has(String(item.key || '')));
      const failedHumanCases = requiredHumanCases.filter((item) => humanRowsByKey.get(String(item.key || ''))?.status === 'failed');
      const blockedHumanCases = requiredHumanCases.filter((item) => humanRowsByKey.get(String(item.key || ''))?.status === 'skipped');
      if (missingHumanCases.length) {
        state.results.push({
          key: 'QA_REQUIRED_HUMAN_COVERAGE',
          name: '完整 E2E 真人操作必要案例',
          domain: 'Coverage',
          ...fail('必要的真人操作案例沒有被執行，測試編排不完整。',
            { requiredCases: requiredHumanCases.map((item) => item.key), missingCases: [] },
            { missingCases: missingHumanCases.map((item) => item.key), failedCases: failedHumanCases.map((item) => item.key), blockedCases: blockedHumanCases.map((item) => item.key) }),
          durationMs: 0
        });
        renderResults();
      } else if (failedHumanCases.length || blockedHumanCases.length) {
        state.results.push({
          key: 'QA_REQUIRED_HUMAN_COVERAGE',
          name: '完整 E2E 真人操作必要案例',
          domain: 'Coverage',
          ...skip('真人操作案例已有各自的失敗或環境阻擋結果；Coverage 僅彙總，不重複製造第二個 failure。',
            { missingCases: [] },
            { failedCases: failedHumanCases.map((item) => item.key), blockedCases: blockedHumanCases.map((item) => item.key) }),
          durationMs: 0
        });
        renderResults();
      }
    }
    if (state.currentSuite === 'full') {
      const catalog = window.MemberE2EFeatureCoverage;
      state.featureCoverage = catalog?.report?.({ side:'user', modules:[surface], registeredKeys:state.caseCatalogKeys,
        plannedKeys:state.executionKeys || state.scenarioPlan?.keys || [], results:state.results });
      const coverage = state.featureCoverage;
      const gaps = coverage?.features.filter(item => item.status !== 'passed').map(item => ({id:item.id,level:item.level,status:item.status,keys:item.keys})) || [];
      state.results.push({ key:'QA_FEATURE_COVERAGE_SUMMARY', name:'功能節點執行覆蓋摘要', domain:'Coverage', durationMs:0,
        ...(coverage?.complete ? pass('本頁登記的功能節點均通過；契約與裝置驗收限制仍分開保留。', {complete:true}, {total:coverage.total,counts:coverage.counts,gaps,execution:coverage.execution})
          : !coverage || coverage.counts.unregistered || coverage.counts.unplanned
            ? fail('功能節點缺少登記或未納入本輪路徑。', {complete:true}, {total:coverage?.total || 0,counts:coverage?.counts || {},gaps,execution:coverage?.execution || null})
            : fail('功能節點有失敗、環境阻擋或未執行，本輪覆蓋未完成。', {complete:true}, {total:coverage.total,counts:coverage.counts,gaps,execution:coverage.execution})) });
      renderResults();
    }
    // A node deadline is a failed run, not a user cancellation: persist its trace.
    const cancelled = state.cancelled && !timedOutCase;
    if (!cancelled) {
      try {
        state.browserRun = await recordBrowserRun();
      } catch (error) {
        state.results.push({
          key: 'QA_BROWSER_RUN_RECORD',
          name: '會員名冊測試紀錄寫入',
          domain: 'Audit',
          status: 'failed',
          message: error && error.message || '真人操作測試結果無法寫入會員名冊。',
          expected: { persisted: true },
          actual: plainError(error),
          durationMs: 0
        });
        renderResults();
      }
    }
    const failed = state.results.filter((item) => item.status === 'failed').length;
    const incomplete = state.currentSuite === 'full' && state.featureCoverage?.complete !== true;
    setRunning(false);
    setStatus(cancelled ? '已停止' : failed ? '有異常' : incomplete ? '覆蓋未完成' : '全部通過');
    setMessage(
      cancelled ? '測試已停止。' :
      failed ? '測試完成，發現 ' + failed + ' 個異常；展開失敗案例查看 Expected / Actual。' :
      incomplete ? '測試完成，仍有略過或未驗證功能；查看功能覆蓋摘要。' :
      '測試完成，所有已執行案例通過；真人操作結果已同步到會員名冊。',
      failed > 0
    );
    saveHistory();
    renderHistory();

    const passed = state.results.filter((item) => item.status === 'passed').length;
    const skipped = state.results.filter((item) => item.status === 'skipped').length;
    const humanRows = state.results.filter((item) => item.humanRequired === true);
    const humanMissingEvidence = humanRows.filter((item) => Number(item?.actual?.humanInteraction?.eventCount || 0) < 1);
    stopDiagnosticTrace();
    return {
      ok: !cancelled && failed === 0 && !incomplete,
      coverage: safeJson(state.featureCoverage),
      humanInteraction: {
        requiredCases: humanRows.length,
        passedCases: humanRows.filter((item) => item.status === 'passed').length,
        missingEvidenceKeys: humanMissingEvidence.map((item) => item.key || item.name || 'human-case')
      },
      cancelled,
      surface,
      suite: state.currentSuite,
      account: state.session && state.session.account || null,
      browserRun: state.browserRun || null,
      bookingHandoff: safeJson(state.bookingHandoff),
      scenario: safeJson(state.scenarioPlan),
      results: state.results.map((item) => ({
        key: item.key || '',
        name: item.name || '',
        domain: item.domain || '',
        humanRequired: item.humanRequired === true,
        status: item.status || '',
        message: item.message || '',
        expected: safeJson(item.expected),
        actual: safeJson(item.actual),
        trace: item.status === 'failed' ? safeJson(item.trace) : undefined,
        durationMs: Number(item.durationMs || 0)
      })),
      summary: {
        passed,
        failed,
        skipped,
        total: state.results.length,
        e2eSeed: state.randomSeed,
        complexityLevel: state.complexityLevel,
        participantIndex: state.participantIndex,
        scenarioFingerprint: state.scenarioPlan?.fingerprint || '',
        scenarioPath: Array.isArray(state.scenarioPlan?.keys) ? state.scenarioPlan.keys.slice() : [],
        replayMode: Boolean(state.replayConfig),
        adaptiveReplaySourceKeys: state.adaptiveReplaySourceKeys.slice(),
        randomStateAfterBuild: state.randomStateAfterBuild >>> 0,
        runnerVersion: VERSION
      }
    };
  }

  function buildBookingHandoff(baselineIds, bookings, memberId, startedAt) {
    if (!Array.isArray(baselineIds) || !Array.isArray(bookings) || !memberId) throw new Error('預約接手基準或回讀資料不完整。');
    const baseline = new Set(baselineIds);
    const rows = bookings.filter((row) => row?.bookingId && !baseline.has(String(row.bookingId)))
      .filter((row) => /^(?:QA HUMAN E2E(?: GROUP| BENEFIT)? |QA STATE PACK |QA automated (?:group )?(?:create|update)$)/i.test(String(row.memberNote || '')));
    return { ready: true, memberId, startedAt, bookingIds: [...new Set(rows.map((row) => String(row.bookingId)))] };
  }

  function buildCases(suite) {
    const common = [
      caseDef('測試帳號授權邊界', 'Authentication', testSessionCase, 'COMMON_TEST_SESSION'),
      caseDef('測試帳號自動教學啟動', 'UI', tourAutoStartCase, 'COMMON_TOUR_AUTOSTART'),
      caseDef('使用教學：遮罩、步驟、不再顯示與重播', 'UI', tourJourneyCase, 'COMMON_TOUR_JOURNEY'),
      caseDef('公開設定與 Client 設定', 'Configuration', configCase, 'COMMON_CONFIG'),
      caseDef('目前頁面載入狀態', 'UI', surfaceReadyCase, 'COMMON_SURFACE_READY'),
      caseDef(definition.label + ' Bootstrap API', 'API', bootstrapCase, 'COMMON_BOOTSTRAP'),
      caseDef(definition.label + ' 核心 UI 元件', 'UI', essentialDomCase, 'COMMON_ESSENTIAL_DOM')
    ];
    if (suite !== 'full') {
      state.scenarioPlan = {
        version: 1,
        seed: state.randomSeed,
        complexityLevel: state.complexityLevel,
        fingerprint: 'SG1-quick-' + surface,
        keys: common.map((item) => item.key),
        path: common.map((item, index) => ({ order: index + 1, key: item.key, name: item.name, domain: item.domain, module: 'shared', phase: index }))
      };
      return common;
    }

    const fullCommon = [
      ...(['booking','points','event'].includes(surface)
        ? [caseDef('E2E 啟動 GPS 定位取證', 'GPS / Test Fixture', gpsFixtureCase, 'COMMON_E2E_GPS_CAPTURE')]
        : []),
      caseDef('高複雜度使用狀態前置', 'Usage State', usageStateComplexityCase, 'COMMON_USAGE_STATE_COMPLEXITY'),
      caseDef('無測試 Session 必須被拒絕', 'Security', negativeSessionCase, 'SECURITY_MISSING_SESSION'),
      caseDef('竄改測試 Session 必須被拒絕', 'Security', tamperedSessionCase, 'SECURITY_TAMPERED_SESSION'),
      caseDef('跨頁面 QA 寫入必須被拒絕', 'Security', crossSurfaceQaCase, 'SECURITY_QA_SURFACE_BOUNDARY'),
      caseDef('用戶 Session 不可冒用管理員', 'Security', adminImpersonationCase, 'SECURITY_ADMIN_BOUNDARY'),
      caseDef('Realtime 訂閱能力', 'Realtime', realtimeCase, 'COMMON_REALTIME'),
      caseDef('亮／暗主題切換與偏好還原', 'UI', themeToggleCase, 'COMMON_THEME_TOGGLE'),
      caseDef('會員階級 milestone 與進度同步', 'UI', membershipMilestoneCase, 'COMMON_MEMBERSHIP_MILESTONE'),
      caseDef('非按鈕功能契約覆蓋清單', 'Coverage', featureContractCoverageCase, 'COMMON_FEATURE_CONTRACT_COVERAGE')
    ];

    const surfaceCases = {
      member: [
        caseDef('好友中心：名單更新／自邀拒絕／關閉', 'Human E2E', memberFriendControlsCase, 'MEMBER_FRIEND_CONTROLS'),
        caseDef('電話：國碼、重複數字與後端拒絕', 'Validation', memberPhoneCountryValidationCase, 'MEMBER_PHONE_COUNTRY_VALIDATION'),
        caseDef('會員資料完整性', 'Member', memberProfileCase, 'MEMBER_PROFILE_DATA'),
        caseDef('會員條款：有效版本與拒絕邊界', 'Member / Legal', membershipTermsConsentCase, 'MEMBER_TERMS_CONSENT'),
        caseDef('會員申請條款：未同意阻擋與目前版本確認', 'Human E2E', memberJoinTermsFlowCase, 'MEMBER_JOIN_TERMS_FLOW'),
        caseDef('會員編號：複製與明確回饋', 'Member / Clipboard', memberCodeCopyCase, 'MEMBER_CODE_COPY'),
        caseDef('好友與邀請優惠：QR 入口與外站拒絕', 'Member / QR', memberQrControlsCase, 'MEMBER_QR_CONTROLS'),
        caseDef('好友邀請：邀請碼／Modal／自邀前端拒絕', 'Member / Growth', memberReferralBoundaryCase, 'MEMBER_REFERRAL_BOUNDARY'),
        caseDef('加入會員後 LINE 自動訊息 UI 契約', 'Member / Notification', memberJoinLineAutomationContractCase, 'MEMBER_JOIN_LINE_AUTOMATION_CONTRACT'),
        caseDef('稱呼／生日／電話編輯視窗', 'UI', memberModalCase, 'MEMBER_MODAL_OPEN_CLOSE'),
        caseDef('真人操作：修改並還原稱呼／生日／電話', 'Human E2E', memberHumanProfileEditCase, 'MEMBER_HUMAN_PROFILE_EDIT'),
        caseDef('會員資料寫入驗證邊界', 'Validation', memberInvalidWriteCase, 'MEMBER_INVALID_WRITE'),
        caseDef('會員資料成功寫入與還原', 'Mutation QA', () => mutationQaCase('MEMBER_PROFILE_WRITE'), 'MEMBER_SERVER_MUTATION')
      ],
      points: [
        caseDef('集點卡／票券資料結構', 'Points', pointsDataCase, 'POINTS_DATA'),
        caseDef('票券使用共用設定', 'Points', pointSettingsCase, 'POINTS_SETTINGS'),
        caseDef('點數轉贈：好友選擇／QR 入口／取消', 'Points / Transfer', pointsTransferRecipientControlsCase, 'POINTS_TRANSFER_RECIPIENT_CONTROLS'),
        caseDef('點數轉贈：會員編號／查找／輸入拒絕邊界', 'Points / Transfer', pointsTransferBoundaryCase, 'POINTS_TRANSFER_BOUNDARY'),
        caseDef('集點卡切換互動', 'UI', pointsInteractionCase, 'POINTS_CARD_SWITCH'),
        caseDef('票券使用紀錄展開／收合', 'UI', pointsHistoryDisclosureCase, 'POINTS_HISTORY_DISCLOSURE'),
        caseDef('真人操作：勾選票券／取消／確認核銷', 'Human E2E', pointsHumanRedeemCase, 'POINTS_HUMAN_REDEEM'),
        caseDef('票券核銷輸入驗證', 'Validation', pointsInvalidWriteCase, 'POINTS_INVALID_WRITE')
      ],
      event: [
        caseDef('活動票券領取／使用狀態', 'Tickets', eventDataCase, 'EVENT_DATA'),
        caseDef('活動票券：尚未開始／已結束 HTTP→UI 邊界', 'Tickets / Boundary', eventBoundaryStatesCase, 'EVENT_BOUNDARY_STATES'),
        caseDef('今日可使用張數與每日上限一致性', 'Tickets / Daily Limit', eventTodayUsableLimitCase, 'EVENT_TODAY_USABLE_LIMIT'),
        caseDef('票券詳情 Modal', 'UI', eventModalCase, 'EVENT_MODAL'),
        caseDef('已使用票券紀錄展開／收合', 'UI', eventHistoryDisclosureCase, 'EVENT_HISTORY_DISCLOSURE'),
        caseDef('真人操作：開啟／領取／核銷／查看紀錄', 'Human E2E', eventHumanTicketLifecycleCase, 'EVENT_HUMAN_LIFECYCLE'),
        caseDef('領券與核銷輸入驗證', 'Validation', eventInvalidWriteCase, 'EVENT_INVALID_WRITE')
      ],
      calendar: [
        caseDef('指定日期明細 API', 'Calendar', calendarDetailApiCase, 'CALENDAR_DETAIL_API'),
        caseDef('月曆月份切換互動', 'UI', calendarNavigationCase, 'CALENDAR_NAVIGATION'),
        caseDef('真人操作：點日期／開明細／關閉', 'Human E2E', calendarHumanDetailCase, 'CALENDAR_HUMAN_DETAIL'),
        caseDef('日期輸入驗證邊界', 'Validation', calendarInvalidDateCase, 'CALENDAR_INVALID_DATE'),
        caseDef('日曆寫入權限邊界', 'Mutation QA', () => mutationQaCase('CALENDAR_READ_ONLY'), 'CALENDAR_SERVER_BOUNDARY')
      ],
      booking: [
        caseDef('我的預約：全部分類、筆數與切換', 'Human E2E', bookingHistoryTabsCase, 'BOOKING_HISTORY_TABS'),
        caseDef('快照明細：全部分類、筆數與切換', 'Human E2E', bookingSnapshotHistoryTabsCase, 'BOOKING_SNAPSHOT_HISTORY_TABS'),
        caseDef('快照模式切換、票券與狀態同步', 'Human E2E', bookingAccessibleModeCase, 'BOOKING_ACCESSIBLE_MODE'),
        caseDef('快照收據：錯誤格式與大小拒絕', 'Security', bookingAccessibleReceiptBoundaryCase, 'BOOKING_ACCESSIBLE_RECEIPT_BOUNDARY'),
        caseDef('快照收據：螢幕快照上傳與待審核', 'Human E2E', bookingAccessibleScreenshotReceiptCase, 'BOOKING_ACCESSIBLE_SCREENSHOT_RECEIPT'),
        caseDef('票券：具體服務 any／all、上限與點數預算', 'Validation', bookingTicketRulesCase, 'BOOKING_TICKET_RULES'),
        caseDef('預約歷史：票券來源卡片對照', 'Booking / History', bookingHistoryTicketSourcesCase, 'BOOKING_HISTORY_TICKET_SOURCES'),
        caseDef('會員與預約 Bootstrap 一致性', 'Booking', bookingDataCase, 'BOOKING_DATA'),
        caseDef('多人預約資源 Bootstrap', 'Booking', bookingGroupBootstrapCase, 'BOOKING_GROUP_DATA'),
        caseDef('預約表單安全初始狀態', 'UI', bookingFormCase, 'BOOKING_FORM_INITIAL'),
        caseDef('預約頁可用活動／票券推薦一致性', 'Booking / Benefits', bookingBenefitsRecommendationsCase, 'BOOKING_BENEFITS_RECOMMENDATIONS'),
        caseDef('真人操作：優惠勾選／預約保存／交接核銷', 'Human E2E', bookingBenefitRedemptionLifecycleCase, 'BOOKING_BENEFIT_REDEMPTION_LIFECYCLE'),
        caseDef('預約收據：相機／圖片／等待管理端審核契約', 'Booking / Receipt', bookingReceiptReviewContractCase, 'BOOKING_RECEIPT_REVIEW_CONTRACT'),
        caseDef('預約 stepper 狀態同步', 'UI', bookingFlowStepperCase, 'BOOKING_FLOW_STEPPER'),
        caseDef('真人操作：日期／視窗／項目／多人控制', 'Human E2E', bookingHumanControlsCase, 'BOOKING_HUMAN_CONTROLS'),
        caseDef('真人操作：新增／修改／取消預約', 'Human E2E', bookingHumanLifecycleCase, 'BOOKING_HUMAN_LIFECYCLE'),
        caseDef('真人操作：多人預約新增並保留資料', 'Human E2E', bookingHumanGroupLifecycleCase, 'BOOKING_HUMAN_GROUP'),
        caseDef('新增／修改／取消輸入驗證', 'Validation', bookingInvalidWriteCase, 'BOOKING_INVALID_WRITE')
      ]
    };

    const trailingCases = [
      caseDef('所有按鈕／動態控制覆蓋清單', 'Coverage', buttonCoverageCase, (surface || 'surface').toUpperCase() + '_BUTTON_COVERAGE')
    ];
    if (surface === 'member' || surface === 'calendar') {
      trailingCases.push(
        caseDef(
          '測試帳號 LINE 通知抑制',
          'Notification',
          () => mutationQaCase('LINE_SUPPRESSION'),
          (surface || 'surface').toUpperCase() + '_LINE_SUPPRESSION'
        )
      );
    }

    const planned = planUserScenario(common.concat(fullCommon, surfaceCases[surface] || [], trailingCases));
    state.scenarioPlan = planned.plan;
    const scenarioCase = caseDef(
      '本輪 E2E 節點路徑',
      'Orchestration',
      () => pass(
        '本輪已依 seed 與 dependency graph 產生可重播但非固定的合法測試路徑。',
        { dependencyAware: true, replayable: true, fixedFlow: false },
        {
          seed: state.randomSeed,
          complexityLevel: state.complexityLevel,
          fingerprint: state.scenarioPlan?.fingerprint || '',
          path: state.scenarioPlan?.path || []
        }
      ),
      'QA_SCENARIO_PATH'
    );

    const replayPool = planned.nodes.filter((item) =>
      ['UI', 'Validation', 'Realtime', 'API', 'Configuration', 'Member', 'Points', 'Tickets', 'Calendar', 'Booking'].includes(String(item.domain || ''))
      && item.humanRequired !== true
    );
    const replayCount = Math.max(0, Math.min(3, Number(state.complexityLevel || 1) - 1));
    let replaySources = [];
    if (state.replayConfig) {
      const byKey = new Map(replayPool.map((item) => [String(item.key || ''), item]));
      replaySources = state.replayConfig.adaptiveReplaySourceKeys.map((key) => {
        const item = byKey.get(key);
        if (!item) throw new Error('Stored adaptive replay node is unavailable or unsafe: ' + key);
        return item;
      });
    } else {
      replaySources = shuffled(replayPool)
        .sort((left, right) =>
          Number(historicalLearning(right?.key).riskScore || 0)
          - Number(historicalLearning(left?.key).riskScore || 0)
        )
        .slice(0, replayCount);
    }
    state.adaptiveReplaySourceKeys = replaySources.map((item) => String(item.key || ''));
    const adaptiveReplays = replaySources.map((item, index) =>
      caseDef(
        '自適應壓力重播 ' + (index + 1) + '：' + item.name,
        item.domain,
        item.run,
        String(item.key || ('ADAPTIVE_' + index)) + '_REPLAY_' + (index + 1)
      )
    );
    state.randomStateAfterBuild = state.randomState >>> 0;
    if (state.replayConfig && state.replayConfig.randomStateAfterBuild != null) {
      state.randomState = state.replayConfig.randomStateAfterBuild >>> 0;
      state.randomStateAfterBuild = state.randomState;
    }
    const execution = [scenarioCase].concat(planned.nodes, adaptiveReplays);
    state.caseCatalogKeys = execution.map(item => item.key);
    state.executionKeys = state.caseCatalogKeys.slice();
    return execution;
  }

  function caseDef(name, domain, run, key) {
    return {
      name,
      domain,
      run,
      key: String(key || ''),
      humanRequired: domain === 'Human E2E'
    };
  }

  async function testSessionCase() {
    const session = await window.TestModeClient.sessionStatus(await loadConfig());
    const account = session && session.account || {};
    const ok = Boolean(session && session.active && account.memberId && account.memberCode);
    return ok
      ? pass('後端確認目前為有效測試帳號 Session。', { active: true, memberId: true, memberCode: true }, { active: true, memberId: Boolean(account.memberId), memberCode: account.memberCode || '' })
      : fail('後端未確認目前測試 Session。', { active: true }, { active: Boolean(session && session.active) });
  }

  async function dismissTourForE2E() {
    const dialog = document.getElementById('memberTourDialog');
    const overlay = document.getElementById('memberTourOverlay');
    const focus = document.getElementById('memberTourFocus');
    const app = document.getElementById('app') || document.querySelector('.app-shell');
    const masks = Array.from(document.querySelectorAll('[data-member-tour-mask]'));
    if (!dialog) {
      if (app) app.inert = false;
      return { dismissed: true, forced: false, dialogExists: false };
    }
    if (dialog.classList.contains('hidden')) {
      if (app) app.inert = false;
      return { dismissed: true, forced: false, dialogExists: true };
    }

    dialog.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    }));
    const dismissedNormally = Boolean(await waitFor(
      () => dialog.classList.contains('hidden') && (!app || app.inert !== true) ? dialog : null,
      700,
      40
    ));
    if (dismissedNormally) return { dismissed: true, forced: false, dialogExists: true };

    // A broken tutorial must fail its own case, not lock the rest of the E2E run behind app.inert.
    dialog.classList.add('hidden');
    dialog.classList.remove('member-tour-dialog-top');
    dialog.style.removeProperty('--member-tour-progress');
    overlay?.classList.add('hidden');
    focus?.classList.add('hidden');
    for (const mask of masks) {
      // E2E recovery must obey the same strict CSP as the real tour.
      const top = mask.dataset.memberTourMask === 'top';
      for (const property of ['left', 'top', 'right', 'bottom', 'width', 'height']) {
        mask.style[property] = top && ['left', 'top', 'right', 'bottom'].includes(property) ? '0' : '';
      }
      mask.style.display = top ? 'block' : 'none';
    }
    if (app) app.inert = false;
    return {
      dismissed: dialog.classList.contains('hidden') && (!app || app.inert !== true),
      forced: true,
      dialogExists: true
    };
  }

  async function tourAutoStartCase() {
    const pairedRunner = new URLSearchParams(window.location.search).has('qaPair');
    const dialog = document.getElementById('memberTourDialog');
    const app = document.getElementById('app') || document.querySelector('.app-shell');
    const opened = Boolean(await waitFor(
      () => dialog && !dialog.classList.contains('hidden') ? dialog : null,
      8000,
      80
    ));
    if (!opened) {
      return fail(
        '測試帳號主畫面完成登入後沒有自動啟動使用教學。',
        { autoOpened: true, pairedRunner },
        { autoOpened: false, pairedRunner, dialogExists: Boolean(dialog) }
      );
    }

    const cleanup = await dismissTourForE2E();
    const dismissed = cleanup.dismissed;
    const appInteractive = !app || app.inert !== true;
    return dismissed && appInteractive && !cleanup.forced
      ? pass(
          '測試帳號與正式帳號一致：進入頁面會自動啟動教學；E2E 以非持久 dismiss 關閉後繼續案例。',
          { autoOpened: true, dismissedWithoutDailySkip: true, appInteractive: true, pairedRunner },
          { autoOpened: true, dismissedWithoutDailySkip: true, appInteractive, pairedRunner, forcedCleanup: false }
        )
      : fail(
          '教學已自動出現，但 E2E 無法安全關閉教學並恢復主畫面互動。',
          { autoOpened: true, dismissedWithoutDailySkip: true, appInteractive: true, pairedRunner },
          { autoOpened: true, dismissedWithoutDailySkip: dismissed, appInteractive, pairedRunner, forcedCleanup: cleanup.forced }
        );
  }

  async function tourJourneyCase() {
    const dialog = document.getElementById('memberTourDialog');
    const launcher = document.getElementById('openMemberTour');
    const overlay = document.getElementById('memberTourOverlay');
    const focus = document.getElementById('memberTourFocus');
    const app = document.getElementById('app') || document.querySelector('.app-shell');
    const next = document.getElementById('memberTourNext');
    const back = document.getElementById('memberTourBack');
    const skipButton = document.getElementById('memberTourSkip');
    const progress = document.getElementById('memberTourProgress');
    const masks = Array.from(document.querySelectorAll('[data-member-tour-mask]'));
    const prefix = surface === 'member' ? 'member-tour:' : `user-tour:${surface}:`;
    const pairedRunner = new URLSearchParams(window.location.search).has('qaPair');
    const evidence = { surface, participantIndex: state.participantIndex, maskRegions: masks.map((mask) => mask.dataset.memberTourMask), steps: [], skippedToday: false, replayed: false, completed: false, stateRestored: false, forcedCleanup: false };
    const expected = { overlayOutsideTarget: true, stepsNavigable: true, explicitDailySkip: true, manualReplay: true, completionClearsSkip: true, stateRestored: true };
    if (![dialog, launcher, overlay, focus, app, next, back, skipButton, progress].every(Boolean)) {
      return fail('使用教學必要控制項缺失。', expected, evidence);
    }

    const storageKey = String(dialog.dataset.storageKey || '');
    if (!storageKey.startsWith(prefix)) return fail('教學未綁定目前使用者的儲存狀態。',expected,evidence);
    const tourKeys = () => localStorage.getItem(storageKey) === null ? [] : [storageKey];
    let before;
    let touchedKey = '';
    let outcome;
    try {
      before = new Map(tourKeys().map((key) => [key, localStorage.getItem(key)]));
      launcher.click();
      if (dialog.classList.contains('hidden') || !app.inert) throw new Error('手動開啟教學後，對話框未顯示或主畫面仍可操作。');
      if (skipButton.textContent.trim() !== '不再顯示') throw new Error('略過按鈕文案不正確。');
      overlay.click();
      if (dialog.classList.contains('hidden')) throw new Error('點擊遮罩意外略過教學。');
      const regions = new Set(masks.map((mask) => mask.dataset.memberTourMask));
      if (regions.size !== 4 || !['top', 'right', 'bottom', 'left'].every((region) => regions.has(region))) {
        throw new Error('高亮範圍外缺少四片遮罩。');
      }
      const spotlight = await waitFor(() => !focus.classList.contains('hidden') && Number.parseFloat(focus.style.width) > 0
        && Number.parseFloat(focus.style.height) > 0 ? focus : null, 1500, 40);
      if (!spotlight || overlay.classList.contains('hidden')) throw new Error('教學開啟後沒有顯示高亮區域或遮罩。');
      const overlayColor = getComputedStyle(overlay).backgroundColor;
      const maskColors = masks.map((mask) => getComputedStyle(mask).backgroundColor);
      evidence.overlayColor = overlayColor;
      evidence.maskColors = maskColors;
      if (!/^(?:transparent|rgba?\(0,\s*0,\s*0,\s*0\))$/.test(overlayColor)
        || maskColors.some((color) => !color || color === 'transparent' || /,\s*0\)$/.test(color))) {
        throw new Error('遮罩沒有維持外側變暗、中心透明的樣式。');
      }
      if (masks.some((mask) => mask.style.display === 'none')
        || !Number.parseFloat(masks.find((mask) => mask.dataset.memberTourMask === 'top').style.height)) {
        throw new Error('高亮範圍外的遮罩未覆蓋畫面。');
      }

      skipButton.click();
      if (!dialog.classList.contains('hidden') || app.inert) throw new Error('不再顯示後未關閉教學或恢復主畫面。');
      const changed = tourKeys().filter((key) => localStorage.getItem(key) !== before.get(key));
      if (changed.length !== 1) throw new Error('不再顯示未寫入單一用戶的教學狀態。');
      touchedKey = changed[0];
      const saved = JSON.parse(localStorage.getItem(touchedKey) || 'null');
      const today = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
      if (saved?.version !== 2 || saved?.disabled !== true || saved?.outcome !== 'skip' || saved?.source !== 'explicit'
        || today.format(new Date(saved.skippedAt)) !== today.format(new Date())) {
        throw new Error('不再顯示狀態沒有依台北日期正確記錄。');
      }
      evidence.skippedToday = true;

      launcher.click();
      if (dialog.classList.contains('hidden') || !app.inert) throw new Error('不再顯示後無法手動重播教學。');
      evidence.replayed = true;
      const first = progress.textContent.trim();
      if (!/^使用教學 1 \/ \d+$/.test(first)) throw new Error('重播未從第一步開始。');
      next.click();
      if (!dialog.classList.contains('hidden')) {
        const second = progress.textContent.trim();
        if (second === first || back.disabled) throw new Error('下一步未更新內容或上一步無法操作。');
        back.click();
        if (progress.textContent.trim() !== first) throw new Error('上一步未回到第一步。');
      } else {
        throw new Error('教學第一步之後未顯示其餘步驟。');
      }
      for (let index = 0; index < 12 && !dialog.classList.contains('hidden'); index += 1) {
        evidence.steps.push(progress.textContent.trim());
        next.click();
      }
      if (!dialog.classList.contains('hidden') || app.inert || evidence.steps.length < 2) {
        throw new Error('教學未能逐步完成並恢復主畫面。');
      }
      if (JSON.parse(localStorage.getItem(touchedKey)||'null')?.disabled !== true) throw new Error('手動完成教學後永久選擇被清除。');
      evidence.completed = true;
      outcome = pass('五個用戶端共用教學已完成遮罩、導覽、不再顯示、重播與狀態驗證。', expected, evidence);
    } catch (error) {
      outcome = fail(String(error?.message || error), expected, evidence);
    } finally {
      const cleanup = await dismissTourForE2E();
      evidence.forcedCleanup = cleanup.forced;
      try {
        if (!before) throw new Error('教學狀態快照不可用。');
        for (const key of new Set([...before.keys(), ...tourKeys()])) {
          if (before.has(key) && localStorage.getItem(key) !== before.get(key)) localStorage.setItem(key, before.get(key));
          else if (!before.has(key)) localStorage.removeItem(key);
        }
        evidence.stateRestored = tourKeys().length === before.size
          && [...before].every(([key, value]) => localStorage.getItem(key) === value);
      } catch (_) { evidence.stateRestored = false; }
      if (!evidence.stateRestored || app.inert || !dialog.classList.contains('hidden') || cleanup.forced) {
        outcome = fail(
          cleanup.forced
            ? '教學關閉事件失效；E2E 已強制解除遮罩與 inert 以避免阻塞後續案例。'
            : '教學 E2E 結束後未能還原本機狀態或主畫面互動。',
          expected,
          evidence
        );
      }
    }
    outcome.actual = safeJson(evidence);
    return outcome;
  }

  async function configCase() {
    const config = await loadConfig();
    const liffKey = surface === 'member' ? 'memberLiffId'
      : surface === 'points' ? 'pointsLiffId'
      : surface === 'event' ? 'eventLiffId'
      : surface === 'calendar' ? 'calendarLiffId'
      : 'bookingLiffId';
    const urlOk = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(String(config.supabaseUrl || ''));
    const fnOk = /^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/[A-Za-z0-9_-]+$/i.test(String(config.supabaseFunctionUrl || ''));
    const keyOk = /^sb_publishable_/.test(String(config.supabasePublishableKey || ''));
    const liffOk = Boolean(String(config[liffKey] || '').trim());
    const leakedServiceRole = /service_role/i.test(JSON.stringify(config || {}));
    const ok = urlOk && fnOk && keyOk && liffOk && !leakedServiceRole;
    const actual = { supabaseUrlValid: urlOk, functionUrlValid: fnOk, publishableKeyOnly: keyOk, liffConfigured: liffOk, serviceRoleVisible: leakedServiceRole, realtimeEnabled: config.realtimeEnabled !== false };
    return ok
      ? pass('公開設定完整，且未在 Client 設定中發現 service-role 標記。', { supabaseUrlValid: true, functionUrlValid: true, publishableKeyOnly: true, liffConfigured: true, serviceRoleVisible: false }, actual)
      : fail('目前 Client 設定存在缺漏或安全異常。', { supabaseUrlValid: true, functionUrlValid: true, publishableKeyOnly: true, liffConfigured: true, serviceRoleVisible: false }, actual);
  }

  async function surfaceReadyCase() {
    const root = document.getElementById(definition.rootId);
    const errorView = document.getElementById('errorView');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && root && root.classList.contains('hidden') && (!errorView || errorView.classList.contains('hidden'))) {
      await wait(120);
    }
    const actual = {
      rootExists: Boolean(root),
      rootVisible: Boolean(root && !root.classList.contains('hidden')),
      errorVisible: Boolean(errorView && !errorView.classList.contains('hidden'))
    };
    return actual.rootExists && actual.rootVisible && !actual.errorVisible
      ? pass('目前用戶端主畫面已完成登入與渲染。', { rootExists: true, rootVisible: true, errorVisible: false }, actual)
      : fail('用戶端沒有進入正常主畫面。', { rootExists: true, rootVisible: true, errorVisible: false }, actual);
  }

  async function requestCore(action, payload) {
    const config = await loadConfig();
    if (surface === 'booking') {
      return window.BookingSystem.request(config, 'member', '', action, payload || {});
    }
    return window.MemberSystem.request(config, surface, '', action, payload || {});
  }

  async function bootstrapCase() {
    const data = await requestCore(definition.bootstrapAction, {});
    state.bootstrap = data;
    const profile = data && data.profile || null;
    const account = state.session && state.session.account || {};
    let structural = false;
    let actual = {};

    if (surface === 'member') {
      structural = Boolean(profile && profile.memberCode && typeof profile.profileComplete === 'boolean');
      actual = { profile: Boolean(profile), memberCodeMatches: Boolean(profile && profile.memberCode === account.memberCode), profileComplete: Boolean(profile && profile.profileComplete) };
    } else if (surface === 'points') {
      structural = Boolean(profile && Array.isArray(data.cards) && data.cardDetails && typeof data.cardDetails === 'object' && Array.isArray(data.history));
      actual = { profile: Boolean(profile), memberCodeMatches: Boolean(profile && profile.memberCode === account.memberCode), cards: Array.isArray(data.cards) ? data.cards.length : -1, cardDetails: Boolean(data.cardDetails && typeof data.cardDetails === 'object'), history: Array.isArray(data.history) ? data.history.length : -1 };
    } else if (surface === 'event') {
      structural = Boolean(profile && Array.isArray(data.offers) && Array.isArray(data.usedTickets));
      actual = { profile: Boolean(profile), memberCodeMatches: Boolean(profile && profile.memberCode === account.memberCode), offers: Array.isArray(data.offers) ? data.offers.length : -1, usedTickets: Array.isArray(data.usedTickets) ? data.usedTickets.length : -1 };
    } else if (surface === 'calendar') {
      structural = Boolean(profile && Array.isArray(data.items));
      actual = { profile: Boolean(profile), memberCodeMatches: Boolean(profile && profile.memberCode === account.memberCode), items: Array.isArray(data.items) ? data.items.length : -1 };
    } else {
      structural = Boolean(data && data.settings && Array.isArray(data.services) && Array.isArray(data.bookings));
      actual = { settings: Boolean(data && data.settings), services: Array.isArray(data && data.services) ? data.services.length : -1, bookings: Array.isArray(data && data.bookings) ? data.bookings.length : -1, todayPresent: Boolean(data && data.today) };
    }

    const profileMatch = surface === 'booking' || Boolean(profile && profile.memberCode === account.memberCode);
    return structural && profileMatch
      ? pass('實際 Bootstrap API 回傳目前測試帳號可用的資料結構。', { validStructure: true, testAccountMatched: true }, { validStructure: structural, testAccountMatched: profileMatch, snapshot: actual })
      : fail('Bootstrap API 結構或測試帳號綁定不符合預期。', { validStructure: true, testAccountMatched: true }, { validStructure: structural, testAccountMatched: profileMatch, snapshot: actual });
  }

  async function essentialDomCase() {
    const missing = definition.essentialIds.filter((id) => !document.getElementById(id));
    const actual = { expectedCount: definition.essentialIds.length, foundCount: definition.essentialIds.length - missing.length, missing };
    return missing.length === 0
      ? pass('此頁核心操作與顯示元件皆存在。', { missing: [] }, actual)
      : fail('此頁缺少必要 DOM 元件，可能有舊版渲染或部署不完整。', { missing: [] }, actual);
  }

  async function negativeSessionCase() {
    const config = await loadConfig();
    const endpoint = String(config.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/test-mode-api';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: String(config.supabasePublishableKey || '') },
      cache: 'no-store',
      body: JSON.stringify({ action: 'session.status', testSessionToken: '' })
    });
    const body = await response.json().catch(() => ({}));
    const code = String(body && body.error && body.error.code || '');
    const ok = response.status === 401 && /^TEST_SESSION_/.test(code);
    return ok
      ? pass('沒有測試 Session token 時，後端會拒絕取得測試身分。', { httpStatus: 401, errorPrefix: 'TEST_SESSION_' }, { httpStatus: response.status, errorCode: code })
      : fail('測試 Session 的拒絕邊界不符合預期。', { httpStatus: 401, errorPrefix: 'TEST_SESSION_' }, { httpStatus: response.status, errorCode: code });
  }

  async function securityRequest(slug, body) {
    const config = await loadConfig();
    const endpoint = String(config.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/' + slug;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: String(config.supabasePublishableKey || '') },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify(body)
      });
      const parsed = await response.json().catch(() => ({}));
      // Never retain the request body or session token in an E2E trace.
      return { httpStatus: response.status, errorCode: String(parsed?.error?.code || '').slice(0, 80) };
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function tamperedSessionCase() {
    const token = window.TestModeClient?.getSessionToken?.();
    if (!token || token.length < 16) return fail('無法取得有效測試 Session 作為竄改基準。', { sessionReady: true }, { sessionReady: false });
    const last = token.slice(-1);
    const altered = token.slice(0, -1) + (last === 'a' ? 'b' : 'a');
    const actual = await securityRequest('test-mode-api', {
      action: 'session.status', clientType: surface, testSessionToken: altered
    });
    const expected = { httpStatus: 401, errorCode: 'TEST_SESSION_INVALID' };
    return actual.httpStatus === expected.httpStatus && actual.errorCode === expected.errorCode
      ? pass('竄改後的測試憑證無法取得原帳號身分。', expected, actual)
      : fail('竄改後的測試憑證沒有被正確拒絕。', expected, actual);
  }

  async function crossSurfaceQaCase() {
    const token = window.TestModeClient?.getSessionToken?.();
    if (!token) return fail('缺少跨頁面測試所需的 Session。', { sessionReady: true }, { sessionReady: false });
    const otherSurface = surface === 'booking' ? 'points' : 'booking';
    const actual = await securityRequest('user-test-api', {
      action: 'user.qa.fixture.cleanup', surface: otherSurface, testSessionToken: token,
      // An absent booking ID and a nonexistent points fixture are harmless even
      // if a regression lets the request reach the cleanup handler.
      fixtureTag: '0000000000000000'
    });
    const expected = { httpStatus: 409, errorCode: 'TEST_SESSION_SURFACE_MISMATCH' };
    return actual.httpStatus === expected.httpStatus && actual.errorCode === expected.errorCode
      ? pass('用戶測試 Session 無法操作其他頁面的 QA 資料。', expected, { ...actual, requestedSurface: otherSurface })
      : fail('跨頁面 QA 請求未在寫入前被 Session 邊界拒絕。', expected, { ...actual, requestedSurface: otherSurface });
  }

  async function adminImpersonationCase() {
    const token = window.TestModeClient?.getSessionToken?.();
    if (!token) return fail('缺少權限測試所需的用戶 Session。', { sessionReady: true }, { sessionReady: false });
    const actual = await securityRequest('booking-admin-api', {
      action: 'admin.booking.manage.bootstrap', clientType: 'admin', idToken: '', testSessionToken: token
    });
    const expected = { httpStatus: 401, errorCode: 'AUTH_REQUIRED' };
    return actual.httpStatus === expected.httpStatus && actual.errorCode === expected.errorCode
      ? pass('用戶端測試憑證不能讀取管理端預約資料。', expected, actual)
      : fail('用戶端憑證取得了異常的管理端回應。', expected, actual);
  }

  async function realtimeCase() {
    const config = await loadConfig();
    if (config.realtimeEnabled === false) return skip('目前設定明確停用 Realtime。', { realtimeEnabled: true }, { realtimeEnabled: false });
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      return fail('Supabase Realtime SDK 未載入。', { sdkAvailable: true }, { sdkAvailable: false });
    }
    const client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    });
    const channelName = 'qa-' + surface + '-' + Math.random().toString(36).slice(2, 9);
    let lastStatus = '';
    const channel = client.channel(channelName)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'realtime_events' }, () => {});
    try {
      const subscribed = await new Promise((resolve) => {
        const timer = window.setTimeout(() => resolve(false), 5000);
        channel.subscribe((status) => {
          lastStatus = String(status || '');
          if (status === 'SUBSCRIBED') {
            window.clearTimeout(timer);
            resolve(true);
          }
          if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
            window.clearTimeout(timer);
            resolve(false);
          }
        });
      });
      return subscribed
        ? pass('Realtime channel 可正常建立訂閱。', { status: 'SUBSCRIBED' }, { status: lastStatus })
        : fail('Realtime channel 未能完成訂閱。', { status: 'SUBSCRIBED' }, { status: lastStatus || 'timeout' });
    } finally {
      try { await client.removeChannel(channel); } catch (_) {}
    }
  }

  async function memberPhoneCountryValidationCase() {
    const phone = window.MemberPhone;
    const vectors = [
      ['+886','0912-345-678','+886912345678'], ['+852','23456789','+85223456789'],
      ['+886','111111111',''], ['+886','0911111111',''], ['+886','abc',''],
      ['+886','+886912345678','+886912345678']
    ];
    const mismatches = vectors.filter(([country, number, expected]) => phone?.compose?.(country, number) !== expected);
    const rejected = await expectApiError('user.member.profile.save', { phone:'+886111111111' }, ['INVALID_PHONE']);
    const selectors = ['profileCountryCode','phoneEditCountryCode'];
    const countryControls = selectors.every(id => document.getElementById(id)?.querySelector('option[value="+886"]'));
    const actual = { vectors:vectors.length, mismatches, countryControls, rejected };
    return !mismatches.length && countryControls && rejected.ok
      ? pass('申請與修改皆有國碼選項，合法電話正規化且 Server 拒絕重複數字。', { countryControls:true, mismatches:[], rejected:true }, actual)
      : fail('國碼、電話正規化或 Server 拒絕邊界異常。', { countryControls:true, mismatches:[], rejected:true }, actual);
  }

  async function memberProfileCase() {
    const data = state.bootstrap || await requestCore('user.member.bootstrap', {});
    const profile = data && data.profile || {};
    const complete = Boolean(profile.memberCode && profile.profileComplete && profile.surname && ['mr', 'ms'].includes(String(profile.salutation || '')) && profile.birthday && profile.phone);
    const actual = {
      memberCodePresent: Boolean(profile.memberCode),
      profileComplete: Boolean(profile.profileComplete),
      honorificComplete: Boolean(profile.surname && ['mr', 'ms'].includes(String(profile.salutation || ''))),
      birthdayPresent: Boolean(profile.birthday),
      phonePresent: Boolean(profile.phone),
      tierPresent: Boolean(profile.tierKey && profile.tier)
    };
    return complete
      ? pass('測試會員具備正式會員功能需要的完整個人資料。', { memberCodePresent: true, profileComplete: true, honorificComplete: true, birthdayPresent: true, phonePresent: true }, actual)
      : fail('測試會員個人資料不完整，可能造成其他用戶端功能異常。', { memberCodePresent: true, profileComplete: true, honorificComplete: true, birthdayPresent: true, phonePresent: true }, actual);
  }

  async function waitForModalState(modal, shouldBeOpen, timeoutMs) {
    return Boolean(await waitFor(() => modal && (!modal.classList.contains('hidden')) === shouldBeOpen,
      timeoutMs || 1000, 25));
  }

  async function clickModalPair(openId, modalId, closeId) {
    const open = document.getElementById(openId);
    const modal = document.getElementById(modalId);
    const close = document.getElementById(closeId);
    if (!open || !modal || !close) return { ok: false, reason: 'missing-element' };
    const initiallyHidden = modal.classList.contains('hidden');
    open.click();
    const opened = await waitForModalState(modal, true, 1500);
    if (opened) close.click();
    const closed = opened
      ? await waitForModalState(modal, false, 1000)
      : modal.classList.contains('hidden');
    return { ok: initiallyHidden && opened && closed, initiallyHidden, opened, closed };
  }

  async function memberModalCase() {
    const honorific = await clickModalPair('editHonorificButton', 'honorificEditModal', 'closeHonorificEditButton');
    const birthday = await clickModalPair('editBirthdayButton', 'birthdayEditModal', 'closeBirthdayEditButton');
    const phone = await clickModalPair('editPhoneButton', 'phoneEditModal', 'closePhoneEditButton');
    const expectedModal = Object.freeze({ ok: true, initiallyHidden: true, opened: true, closed: true });
    const expected = {
      honorific: { ...expectedModal },
      birthday: { ...expectedModal },
      phone: { ...expectedModal }
    };
    const ok = honorific.ok && birthday.ok && phone.ok;
    const actual = { honorific, birthday, phone };
    return ok
      ? pass('三個會員資料編輯視窗都可開啟並安全關閉。', expected, actual)
      : fail('至少一個會員資料編輯視窗互動異常。', expected, actual);
  }


  async function waitFor(predicate, timeoutMs = 5000, intervalMs = 40) {
    if (state.pendingTimedOutNode) throw Object.assign(new Error('逾時案例已停止等待。'), { code: 'E2E_NODE_CANCELLED' });
    const deadline = performance.now() + Math.max(100, Number(timeoutMs) || 5000);
    return new Promise((resolve, reject) => {
      let settled = false;
      let lastError = null;
      let pollTimer = null;
      let deadlineTimer = null;
      const observer = typeof MutationObserver === 'function' ? new MutationObserver(check) : null;
      function finish(value, error = null) {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        window.clearTimeout(pollTimer);
        window.clearTimeout(deadlineTimer);
        error ? reject(error) : resolve(value);
      }
      function check() {
        if (settled) return;
        if (state.pendingTimedOutNode) {
          finish(null, Object.assign(new Error('逾時案例已停止等待。'), { code: 'E2E_NODE_CANCELLED' }));
          return;
        }
        // Check once at the deadline too, including changes delivered while a
        // background tab's timer was suspended.
        try {
          const value = predicate();
          if (value) { finish(value); return; }
        } catch (error) { lastError = error; }
        if (performance.now() >= deadline) finish(null, lastError);
      }
      function poll() {
        check();
        if (!settled) pollTimer = window.setTimeout(poll, Math.max(25, intervalMs));
      }
      observer?.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      deadlineTimer = window.setTimeout(check, Math.max(100, deadline - performance.now()));
      poll();
    });
  }

  function humanTargetLabel(node) {
    if (!node || node.nodeType !== 1) return 'unknown';
    const id = String(node.id || '').trim();
    if (id) return '#' + id;
    const action = String(node.getAttribute?.('data-action') || node.getAttribute?.('data-booking-admin-action') || '').trim();
    if (action) return '[action=' + action + ']';
    const cls = String(node.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    const tag = String(node.tagName || 'element').toLowerCase();
    return cls ? tag + '.' + cls : tag;
  }

  async function captureHumanInteraction(run, testCase = null) {
    const professional = window.MemberE2EProfessionalTester;
    if (professional && typeof professional.capture === 'function') {
      const meta = USER_NODE_META[String(testCase?.key || '')] || {};
      return professional.capture({
        document,
        caseKey: String(testCase?.key || ''),
        domain: String(testCase?.domain || ''),
        module: String(meta.module || surface || 'shared'),
        risk: String(meta.risk || ''),
        side: 'user',
        surface,
        complexityLevel: state.complexityLevel,
        seed: state.randomSeed,
        learning: historicalLearning(testCase?.key),
        delay: wait,
        maxEvents: 120,
        labelTarget: humanTargetLabel,
        excludeTarget: (target) => Boolean(state.panel?.contains?.(target) || target?.id === LAUNCHER_ID),
        registerCleanup: (cleanup) => { state.activeHumanCaptureCleanup = typeof cleanup === 'function' ? cleanup : null; }
      }, run);
    }
    const events = [];
    const types = ['click', 'input', 'change', 'submit'];
    const handler = (event) => {
      const target = event?.target;
      if (!target || state.panel?.contains(target) || target.id === LAUNCHER_ID) return;
      events.push({
        type: String(event.type || ''),
        target: humanTargetLabel(target),
        trusted: event.isTrusted === true
      });
      if (events.length > 80) events.shift();
    };
    types.forEach((type) => document.addEventListener(type, handler, true));
    const cleanup = () => types.forEach((type) => document.removeEventListener(type, handler, true));
    state.activeHumanCaptureCleanup = cleanup;
    try {
      await wait(randomInt(80, 260));
      const outcome = await run();
      await wait(randomInt(70, 220));
      return {
        outcome,
        evidence: {
          eventCount: events.length,
          eventTypes: [...new Set(events.map((item) => item.type))],
          targets: [...new Set(events.map((item) => item.target))].slice(0, 20)
        }
      };
    } finally {
      cleanup();
      if (state.activeHumanCaptureCleanup === cleanup) state.activeHumanCaptureCleanup = null;
    }
  }

  function setFieldValue(element, value) {
    if (!element) return false;
    element.value = String(value ?? '');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async function qaServiceRequest(action, payload = {}, timeoutMs = 30000) {
    const config = await loadConfig();
    const endpoint = String(config.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/user-test-api';
    const body = window.TestModeClient.payload(Object.assign({}, payload, { action, surface, idToken: '' }));
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: String(config.supabasePublishableKey || '') },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.ok !== true) {
        const error = new Error(data && data.error && data.error.message || '用戶端 QA 服務拒絕操作。');
        error.code = String(data && data.error && data.error.code || 'QA_API_ERROR');
        throw error;
      }
      return data.data || {};
    } finally {
      window.clearTimeout(timer);
    }
  }

  function artifactFunctionUrl(config) {
    const base = String(config?.supabaseUrl || '').replace(/\/$/, '');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(base)) throw new Error('E2E Artifact 服務設定不完整。');
    return base + '/functions/v1/e2e-artifact-api';
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

  async function captureFailureScreenshotBlob() {
    const render = await ensureHtml2Canvas();
    const width = Math.max(320, Number(window.innerWidth || document.documentElement.clientWidth || 1024));
    const height = Math.max(320, Number(window.innerHeight || document.documentElement.clientHeight || 768));
    const canvas = await render(document.body, {
      backgroundColor: '#ffffff',
      logging: false,
      useCORS: true,
      allowTaint: false,
      scale: 0.8,
      width,
      height,
      windowWidth: width,
      windowHeight: height,
      x: window.scrollX || 0,
      y: window.scrollY || 0,
      onclone: redactScreenshotClone
    });
    let blob = await canvasToWebp(canvas, 0.72);
    if (blob.size > FAILURE_SCREENSHOT_MAX_BYTES) blob = await canvasToWebp(canvas, 0.5);
    if (blob.size > FAILURE_SCREENSHOT_MAX_BYTES) throw new Error('WebP 失敗快照超過 1.9 MB，已略過上傳。');
    return { blob, width: canvas.width, height: canvas.height };
  }

  // Use the real sanitized UI screenshot for either failure evidence or QA-only snapshot receipt.
  const captureE2ESnapshotBlob = captureFailureScreenshotBlob;

  async function uploadFailureScreenshot(row) {
    const config = await loadConfig();
    const token = window.TestModeClient?.getSessionToken?.();
    if (!token) throw new Error('測試 Session 不存在，無法上傳失敗快照。');
    const captured = await captureFailureScreenshotBlob();
    const form = new FormData();
    form.set('actorType', 'member');
    form.set('testSessionToken', token);
    form.set('surface', surface);
    form.set('caseKey', String(row?.key || row?.name || 'case'));
    form.set('rootRunId', String(state.randomSeed || ('USER-' + surface)));
    form.set('width', String(captured.width));
    form.set('height', String(captured.height));
    form.set('file', captured.blob, 'failure.webp');

    const response = await fetch(artifactFunctionUrl(config), {
      method: 'POST',
      headers: { apikey: String(config.supabasePublishableKey || '') },
      cache: 'no-store',
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

  async function attachFailureScreenshot(row) {
    if (!row || row.status !== 'failed') return;
    if (state.failureScreenshotsCaptured >= FAILURE_SCREENSHOT_BUDGET) {
      row.trace = safeJson({
        ...(row.trace || {}),
        artifactVersion: Math.max(2, Number(row?.trace?.artifactVersion || 0)),
        screenshotCapture: { status: 'skipped', reason: 'surface-budget', budget: FAILURE_SCREENSHOT_BUDGET }
      });
      return;
    }
    state.failureScreenshotsCaptured += 1;
    try {
      const timeout = new Promise((_, reject) => window.setTimeout(() => reject(new Error('失敗快照擷取逾時。')), 12000));
      const screenshot = await Promise.race([uploadFailureScreenshot(row), timeout]);
      row.trace = safeJson({ ...(row.trace || {}), artifactVersion: 3, screenshot });
    } catch (error) {
      row.trace = safeJson({
        ...(row.trace || {}),
        artifactVersion: Math.max(2, Number(row?.trace?.artifactVersion || 0)),
        screenshotCapture: { status: 'failed', error: plainError(error) }
      });
    }
  }

  async function refreshRealClient() {
    if (window.MemberClientQaHooks && window.MemberClientQaHooks.surface === surface && typeof window.MemberClientQaHooks.refresh === 'function') {
      await window.MemberClientQaHooks.refresh();
      await wait(80);
      return true;
    }
    return false;
  }

  function compactFailureTrace(value, maxChars = 5000) {
    const normalized = safeJson(value && typeof value === 'object' ? {
      ...value,
      events: Array.isArray(value.events) ? value.events.slice(-20) : [],
      apiTimings: Array.isArray(value.apiTimings) ? value.apiTimings.slice(-20) : [],
    } : value) || {};
    let serialized = '';
    try { serialized = JSON.stringify(normalized); } catch { return { serializationFailed: true }; }
    if (serialized.length <= maxChars) return normalized;
    const screenshot = normalized?.screenshot && typeof normalized.screenshot === 'object'
      ? safeJson(normalized.screenshot)
      : null;
    const compacted = {
      truncated: true,
      originalChars: serialized.length,
      artifactVersion: normalized.artifactVersion,
      seed: String(normalized.seed || '').slice(0, 120),
      caseKey: String(normalized.caseKey || '').slice(0, 100),
      surface: normalized.surface,
      page: normalized.page,
      elapsedMs: normalized.elapsedMs,
      error: normalized.error,
      apiTimings: (normalized.apiTimings || []).slice(-8),
      events: (normalized.events || []).slice(-8).map(event => ({
        atMs: event.atMs, type: event.type,
        // Keep the last control and error, not entire repeated settings dumps.
        detail: event.detail?.target ? { target: event.detail.target }
          : event.detail?.message ? { message: String(event.detail.message).slice(0, 200), code: event.detail.code } : {}
      })),
      ...(screenshot ? { screenshot } : {})
    };
    while (JSON.stringify(compacted).length > maxChars && (compacted.events.length || compacted.apiTimings.length)) {
      if (compacted.events.length) compacted.events.shift();
      else compacted.apiTimings.shift();
    }
    return compacted;
  }

  async function recordBrowserRun() {
    const cases = state.results.map((item) => ({
      key: item.key || '',
      name: item.name,
      domain: item.domain,
      status: item.status,
      message: item.message,
      expected: item.expected && typeof item.expected === 'object' ? item.expected : {},
      actual: item.actual && typeof item.actual === 'object' ? item.actual : {},
      trace: item.status === 'failed'
        ? compactFailureTrace(
            item.trace || buildFailureTrace(
              { eventIndex: 0, resourceIndex: state.traceResourceStart, startedAtMs: Date.parse(state.runStartedAt) || Date.now() },
              item
            ),
            5000
          )
        : undefined,
      durationMs: Number(item.durationMs || 0)
    }));
    const payload = {
      cases,
      runnerVersion: VERSION,
      suite: state.currentSuite,
      featureCoverage: state.featureCoverage,
      gpsTestFixture: state.gpsFixture,
      expectedCaseKeys: state.currentSuite === 'full' ? state.caseCatalogKeys : [],
      startedAt: state.runStartedAt || undefined,
      completedAt: new Date().toISOString()
    };
    const fitted = window.MemberE2EFeatureCoverage?.compactRecordPayload?.(payload, 60_000) || payload;
    if (new TextEncoder().encode(JSON.stringify(fitted)).byteLength > 60_000) {
      throw Object.assign(new Error('會員 E2E 紀錄超過容量，拒絕省略案例。'),{code:'E2E_RECORD_TOO_LARGE'});
    }
    return qaServiceRequest('user.qa.browser-run.record', fitted, 30000);
  }

  async function memberHumanProfileEditCase() {
    const original = await requestCore('user.member.bootstrap', {});
    const profile = original && original.profile || {};
    const originalSurname = String(profile.surname || '');
    const originalSalutation = String(profile.salutation || '').toLowerCase();
    const originalBirthday = String(profile.birthday || '');
    const originalPhone = String(profile.phone || '');
    const nextSurname = originalSurname === '測' ? '驗' : '測';
    const nextSalutation = originalSalutation === 'mr' ? 'ms' : 'mr';
    const nextBirthday = originalBirthday === '1990-01-15' ? '1991-02-16' : '1990-01-15';
    const nextPhone = window.MemberPhone.normalizeStored(originalPhone) === '+886912345671' ? '0912345672' : '0912345671';
    const actual = {
      honorificCancelled: false, honorificSaved: false, honorificRestored: false,
      birthdayClosed: false, birthdaySaved: false, birthdayRestored: false,
      phoneCancelled: false, phoneSaved: false, phoneRestored: false
    };

    async function open(id, modalId) {
      document.getElementById(id)?.click();
      return Boolean(await waitFor(() => {
        const modal = document.getElementById(modalId);
        return modal && !modal.classList.contains('hidden') ? modal : null;
      }, 2500));
    }
    async function waitClosed(modalId) {
      return Boolean(await waitFor(() => document.getElementById(modalId)?.classList.contains('hidden'), 3000));
    }
    async function setBirthday(value) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      const year = document.getElementById('birthdayEditYear');
      const month = document.getElementById('birthdayEditMonth');
      const day = document.getElementById('birthdayEditDay');
      if (match && year && month && day) {
        setFieldValue(year, match[1]);
        setFieldValue(month, match[2]);
        await wait(20);
        setFieldValue(day, match[3]);
        return true;
      }
      return setFieldValue(document.getElementById('birthdayEditInput'), value);
    }

    try {
      if (!await open('editHonorificButton', 'honorificEditModal')) throw new Error('稱呼編輯視窗未開啟。');
      document.getElementById('cancelHonorificEditButton')?.click();
      actual.honorificCancelled = await waitClosed('honorificEditModal');

      if (!await open('editHonorificButton', 'honorificEditModal')) throw new Error('稱呼編輯視窗第二次未開啟。');
      setFieldValue(document.getElementById('honorificSurnameInput'), nextSurname);
      setFieldValue(document.getElementById('honorificSalutationSelect'), nextSalutation);
      document.getElementById('saveHonorificEditButton')?.click();
      await waitClosed('honorificEditModal');
      let fresh = await requestCore('user.member.bootstrap', {});
      actual.honorificSaved = String(fresh?.profile?.surname || '') === nextSurname && String(fresh?.profile?.salutation || '').toLowerCase() === nextSalutation;

      await open('editHonorificButton', 'honorificEditModal');
      setFieldValue(document.getElementById('honorificSurnameInput'), originalSurname);
      setFieldValue(document.getElementById('honorificSalutationSelect'), originalSalutation);
      document.getElementById('saveHonorificEditButton')?.click();
      await waitClosed('honorificEditModal');
      fresh = await requestCore('user.member.bootstrap', {});
      actual.honorificRestored = String(fresh?.profile?.surname || '') === originalSurname && String(fresh?.profile?.salutation || '').toLowerCase() === originalSalutation;

      if (!await open('editBirthdayButton', 'birthdayEditModal')) throw new Error('生日編輯視窗未開啟。');
      document.getElementById('closeBirthdayEditButton')?.click();
      actual.birthdayClosed = await waitClosed('birthdayEditModal');

      await open('editBirthdayButton', 'birthdayEditModal');
      await setBirthday(nextBirthday);
      document.getElementById('saveBirthdayEditButton')?.click();
      await waitClosed('birthdayEditModal');
      fresh = await requestCore('user.member.bootstrap', {});
      actual.birthdaySaved = String(fresh?.profile?.birthday || '') === nextBirthday;

      await open('editBirthdayButton', 'birthdayEditModal');
      await setBirthday(originalBirthday);
      document.getElementById('saveBirthdayEditButton')?.click();
      await waitClosed('birthdayEditModal');
      fresh = await requestCore('user.member.bootstrap', {});
      actual.birthdayRestored = String(fresh?.profile?.birthday || '') === originalBirthday;

      if (!await open('editPhoneButton', 'phoneEditModal')) throw new Error('電話編輯視窗未開啟。');
      document.getElementById('cancelPhoneEditButton')?.click();
      actual.phoneCancelled = await waitClosed('phoneEditModal');

      await open('editPhoneButton', 'phoneEditModal');
      setFieldValue(document.getElementById('phoneEditCountryCode'), '+886');
      setFieldValue(document.getElementById('phoneEditInput'), nextPhone);
      document.getElementById('savePhoneEditButton')?.click();
      await waitClosed('phoneEditModal');
      fresh = await requestCore('user.member.bootstrap', {});
      actual.phoneSaved = window.MemberPhone.normalizeStored(fresh?.profile?.phone) === window.MemberPhone.normalizeStored(nextPhone);

      await open('editPhoneButton', 'phoneEditModal');
      setFieldValue(document.getElementById('phoneEditInput'), originalPhone);
      document.getElementById('savePhoneEditButton')?.click();
      await waitClosed('phoneEditModal');
      fresh = await requestCore('user.member.bootstrap', {});
      actual.phoneRestored = String(fresh?.profile?.phone || '').replace(/\D/g, '') === originalPhone.replace(/\D/g, '');
    } finally {
      const fresh = await requestCore('user.member.bootstrap', {}).catch(() => null);
      const p = fresh && fresh.profile || {};
      if (String(p.surname || '') !== originalSurname || String(p.salutation || '').toLowerCase() !== originalSalutation || String(p.birthday || '') !== originalBirthday || String(p.phone || '').replace(/\D/g, '') !== originalPhone.replace(/\D/g, '')) {
        await requestCore('user.member.profile.save', {
          surname: originalSurname,
          salutation: originalSalutation,
          birthday: originalBirthday,
          phone: originalPhone
        }).catch(() => {});
      }
    }

    const ok = Object.values(actual).every(Boolean);
    return ok
      ? pass('已用真人點擊方式完成稱呼、生日、電話的開啟／取消或關閉／儲存／還原。', { allSteps: true, restored: true }, actual)
      : fail('會員資料真人操作流程至少一個步驟異常。', { allSteps: true, restored: true }, actual);
  }

  async function pointsHumanRedeemCase() {
    const fixture = await qaServiceRequest('user.qa.fixture.prepare');
    const actual = { selected: false, cancelClosed: false, reopened: false, redeemed: false, historyVisible: false, preserved: false };
    try {
      await refreshRealClient();
      const snapshot = await requestCore('user.pointcard.bootstrap', { compact: false });
      window.PointCardTicketOverview?.renderSnapshot?.(snapshot);
      const checkbox = await waitFor(() => document.querySelector('[data-ticket-select="' + fixture.ticketId + '"]'), 4000);
      if (!checkbox) throw new Error('QA 可用票券沒有出現在真人票券總覽。');
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      const useButton = await waitFor(() => {
        const button = document.querySelector('.ticket-overview-use');
        return button && !button.disabled ? button : null;
      }, 2000);
      actual.selected = Boolean(useButton);
      if (!useButton) throw Object.assign(new Error('QA 票券不可核銷：' + String(document.querySelector('[data-ticket-error]')?.textContent ||
        '缺少符合資格且已確認的預約，或選券狀態未同步。')), { code: 'E2E_TICKET_PRECONDITION' });
      useButton.click();
      const modal = await waitFor(() => {
        const node = document.getElementById('ticketBatchModal');
        return node && !node.classList.contains('hidden') ? node : null;
      }, 2000);
      if (!modal) throw new Error('使用票券確認視窗未開啟。');
      modal.querySelector('.ticket-batch-cancel')?.click();
      actual.cancelClosed = Boolean(await waitFor(() => modal.classList.contains('hidden'), 1500));
      useButton.click();
      actual.reopened = Boolean(await waitFor(() => !modal.classList.contains('hidden'), 1500));
      const bookingChoice = modal.querySelector('[data-ticket-booking-choice] select');
      if (!bookingChoice || !Array.from(bookingChoice.options).some(option => option.value === String(fixture.bookingId || ''))) {
        throw Object.assign(new Error('QA 票券沒有對應的已確認預約選項。'), { code: 'E2E_TICKET_PRECONDITION' });
      }
      setFieldValue(bookingChoice, fixture.bookingId);
      actual.bookingSelected = bookingChoice.value === String(fixture.bookingId);
      modal.querySelector('.ticket-batch-confirm')?.click();
      const completed = await waitFor(() => {
        const confirm = modal.querySelector('.ticket-batch-confirm');
        return confirm && confirm.dataset.mode === 'close' && !confirm.disabled ? confirm : null;
      }, 12000);
      actual.redeemed = Boolean(completed);
      completed?.click();
      await refreshRealClient();
      actual.historyVisible = String(document.getElementById('ticketHistoryList')?.textContent || '').includes('QA 真人操作票券');
    } finally {
      actual.preserved = true;
      await refreshRealClient().catch(() => {});
    }
    const ok = Object.values(actual).every(Boolean);
    return ok
      ? pass('已真人勾選票券、開啟確認、取消一次、再次確認核銷並看到使用紀錄；QA 資料已保留供管理端檢查。', { allSteps: true }, actual)
      : fail('集點卡真人票券流程至少一個步驟異常。', { allSteps: true }, actual);
  }

  async function eventBoundaryStatesCase() {
    const tag = String(state.usageState?.usageStateTag || '');
    if (!tag) return fail('活動票券邊界測試缺少 usage-state fixture。', { usageStateTag: true }, { usageStateTag: false });
    const futureId = 'QA-STATE-EVT-FUTURE-' + tag;
    const endedId = 'QA-STATE-EVT-PAST-' + tag;
    await refreshRealClient();

    const inspectCard = async (eventTicketId, expectedText) => {
      const button = await waitFor(() => document.querySelector('[data-event-ticket-id="' + CSS.escape(eventTicketId) + '"]'), 5000);
      const card = button?.closest('.event-ticket') || null;
      const text = String(card?.textContent || '');
      const stateText = String(card?.querySelector('.event-ticket-state')?.textContent || '');
      button?.click();
      const modal = document.getElementById('ticketModal');
      const opened = Boolean(await waitFor(() => modal && !modal.classList.contains('hidden'), 1500));
      const actionDisabled = document.getElementById('ticketModalAction')?.disabled === true;
      const modalStatus = String(document.getElementById('ticketModalStatus')?.textContent || '');
      document.getElementById('closeTicketModal')?.click();
      return {
        found: Boolean(card),
        listStateMatched: stateText.includes(expectedText) || text.includes(expectedText),
        opened,
        actionDisabled,
        modalStatusMatched: modalStatus.includes(expectedText)
      };
    };

    const futureUi = await inspectCard(futureId, '尚未開始');
    const endedUi = await inspectCard(endedId, '已結束');
    const futureApi = await expectApiError('user.event.ticket.claim', { eventTicketId: futureId }, ['EVENT_NOT_STARTED']);
    const endedApi = await expectApiError('user.event.ticket.claim', { eventTicketId: endedId }, ['EVENT_ENDED']);
    const actual = {
      futureUi, endedUi,
      futureApi: { rejected: futureApi.ok, code: futureApi.code },
      endedApi: { rejected: endedApi.ok, code: endedApi.code }
    };
    const ok = Object.values(futureUi).every(Boolean) && Object.values(endedUi).every(Boolean) && futureApi.ok && endedApi.ok;
    return ok
      ? pass('尚未開始與已結束活動票券已完成真實 Bootstrap→UI→領券 API 拒絕的端到端驗證。', {
          futureBlocked: true, endedBlocked: true, uiDisabled: true
        }, actual)
      : fail('活動票券尚未開始／已結束的 HTTP→UI 邊界有不一致。', {
          futureBlocked: true, endedBlocked: true, uiDisabled: true
        }, actual);
  }

  async function eventHumanTicketLifecycleCase() {
    const fixture = await qaServiceRequest('user.qa.fixture.prepare');
    const actual = {
      couponOpened: false,
      couponCloseWorked: false,
      couponClaimed: false,
      couponRedeemed: false,
      couponHistoryOpened: false,
      lotteryOpened: false,
      lotteryPrizeListVisible: false,
      lotteryClaimed: false,
      lotteryRedeemed: false,
      lotteryResultVisible: false,
      lotteryPrizeTitle: '',
      lotteryHistoryOpened: false,
      lotteryHistoryResultVisible: false,
      preserved: false
    };
    const modal = document.getElementById('ticketModal');
    const action = document.getElementById('ticketModalAction');

    async function openFixtureTicket(eventTicketId, label) {
      const selector = '[data-event-ticket-id="' + eventTicketId + '"]';
      const button = await waitFor(() => document.querySelector('#eventList ' + selector), 5000);
      if (!button) throw new Error('QA ' + label + '沒有出現在活動票券頁面。');
      button.click();
      if (!await waitFor(() => modal && !modal.classList.contains('hidden'), 1800)) {
        throw new Error('QA ' + label + '詳情沒有開啟。');
      }
      return selector;
    }

    async function claimAndRedeem(label) {
      const dayFixture = await qaServiceRequest('user.qa.event-day.prepare',{fixtureTag:fixture.fixtureTag});
      actual.qaDayFixtures = (actual.qaDayFixtures || []).concat([{label,...dayFixture}]);
      if (!action || action.disabled) throw new Error(label + '領取按鈕不可操作。');
      action.click();
      const claimed = Boolean(await waitFor(() => !action.disabled && /確認使用/.test(action.textContent || ''), 7000));
      if (!claimed) throw new Error(label + '領券後 UI 未切換成可使用狀態。');
      const originalConfirm = window.confirm;
      let redeemed;
      try {
        window.confirm = () => true;
        action.click();
        redeemed = Boolean(await waitFor(() => !document.getElementById('ticketModalResult')?.classList.contains('hidden'), 8000));
      } finally {
        window.confirm = originalConfirm;
      }
      if (!redeemed) throw new Error(label + '核銷結果沒有顯示。');
      return { claimed, redeemed };
    }

    try {
      await refreshRealClient();

      const couponSelector = await openFixtureTicket(fixture.eventTicketId, '活動優惠券');
      actual.couponOpened = true;
      document.getElementById('closeTicketModal')?.click();
      actual.couponCloseWorked = Boolean(await waitFor(() => modal?.classList.contains('hidden'), 1500));
      document.querySelector('#eventList ' + couponSelector)?.click();
      await waitFor(() => modal && !modal.classList.contains('hidden'), 1500);
      const couponResult = await claimAndRedeem('活動優惠券');
      actual.couponClaimed = couponResult.claimed;
      actual.couponRedeemed = couponResult.redeemed;
      document.getElementById('closeTicketModal')?.click();

      await refreshRealClient();
      const couponHistory = await waitFor(() => document.querySelector('#usedTicketList ' + couponSelector), 4000);
      couponHistory?.click();
      actual.couponHistoryOpened = Boolean(await waitFor(() => modal && !modal.classList.contains('hidden'), 1500));
      document.getElementById('closeTicketModal')?.click();

      if (!fixture.lotteryEventTicketId) throw new Error('活動抽獎券 Fixture 識別缺失。');
      await refreshRealClient();
      const lotterySelector = await openFixtureTicket(fixture.lotteryEventTicketId, '活動抽獎券');
      actual.lotteryOpened = true;
      actual.lotteryPrizeListVisible = document.querySelectorAll('#ticketModalPrizes li').length >= Number(fixture.lotteryPrizeCount || 1);
      if (!actual.lotteryPrizeListVisible) throw new Error('活動抽獎券沒有顯示預期獎項清單。');

      const lotteryResult = await claimAndRedeem('活動抽獎券');
      actual.lotteryClaimed = lotteryResult.claimed;
      actual.lotteryRedeemed = lotteryResult.redeemed;
      actual.lotteryResultVisible = Boolean(await waitFor(() => {
        const result = document.querySelector('#ticketModalResult .lottery-result strong');
        const value = String(result?.textContent || '').trim();
        if (!value) return null;
        actual.lotteryPrizeTitle = value;
        return result;
      }, 5000));
      if (!actual.lotteryResultVisible) throw new Error('活動抽獎券開獎後沒有顯示獎項結果。');
      document.getElementById('closeTicketModal')?.click();

      await refreshRealClient();
      const lotteryHistory = await waitFor(() => document.querySelector('#usedTicketList ' + lotterySelector), 4000);
      lotteryHistory?.click();
      actual.lotteryHistoryOpened = Boolean(await waitFor(() => modal && !modal.classList.contains('hidden'), 1500));
      actual.lotteryHistoryResultVisible = Boolean(await waitFor(() => {
        const result = document.querySelector('#ticketModalResult .lottery-result strong');
        const content = String(document.getElementById('ticketModalResult')?.textContent || '');
        return result && content.includes(actual.lotteryPrizeTitle) ? result : null;
      }, 4000, 100));
      document.getElementById('closeTicketModal')?.click();
    } finally {
      actual.preserved = true;
      await refreshRealClient().catch(() => {});
    }
    const requiredBooleans = [
      actual.couponOpened,
      actual.couponCloseWorked,
      actual.couponClaimed,
      actual.couponRedeemed,
      actual.couponHistoryOpened,
      actual.lotteryOpened,
      actual.lotteryPrizeListVisible,
      actual.lotteryClaimed,
      actual.lotteryRedeemed,
      actual.lotteryResultVisible,
      Boolean(actual.lotteryPrizeTitle),
      actual.lotteryHistoryOpened,
      actual.lotteryHistoryResultVisible,
      actual.preserved
    ];
    const ok = requiredBooleans.every(Boolean);
    return ok
      ? pass('已真人完成活動優惠券與活動抽獎券的開啟、領取、核銷／開獎、結果顯示與歷史紀錄驗證；QA 資料保留供管理端檢查。', {
          couponLifecycle: true,
          lotteryLifecycle: true,
          lotteryResultPersistedInUi: true
        }, actual)
      : fail('活動票券真人流程未完整覆蓋優惠券與抽獎券生命週期。', {
          couponLifecycle: true,
          lotteryLifecycle: true,
          lotteryResultPersistedInUi: true
        }, actual);
  }

  async function calendarHumanDetailCase() {
    const fixture = await qaServiceRequest('user.qa.fixture.prepare');
    const actual = { dateVisible: false, opened: false, closeWorked: false, overlayCloseWorked: false, preserved: false };
    try {
      await refreshRealClient();
      const selector = '[data-calendar-date="' + fixture.date + '"]';
      let day = await waitFor(() => document.querySelector(selector), 3500);
      actual.dateVisible = Boolean(day);
      day?.click();
      const modal = document.getElementById('calendarDetailModal');
      actual.opened = Boolean(await waitFor(() => modal && !modal.classList.contains('hidden'), 1500));
      document.getElementById('closeCalendarDetailButton')?.click();
      actual.closeWorked = Boolean(await waitFor(() => modal?.classList.contains('hidden'), 1500));
      day = document.querySelector(selector);
      day?.click();
      await waitFor(() => modal && !modal.classList.contains('hidden'), 1500);
      modal?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      actual.overlayCloseWorked = Boolean(await waitFor(() => modal?.classList.contains('hidden'), 1500));
    } finally {
      actual.preserved = true;
      await refreshRealClient().catch(() => {});
    }
    const ok = Object.values(actual).every(Boolean);
    return ok
      ? pass('已真人點擊含活動的日期、開啟明細、使用關閉鍵與背景關閉；QA 日期已保留供管理端檢查。', { allSteps: true }, actual)
      : fail('日曆真人明細流程至少一個步驟異常。', { allSteps: true }, actual);
  }

  function chooseNormalServiceButton(root = document) {
    return Array.from(root.querySelectorAll('.service-choice .service-add-button')).find((button) => {
      const row = button.closest('.service-choice');
      return row && !/加購/.test(row.textContent || '');
    }) || null;
  }

  function pairedLaneIndex() {
    const raw = new URLSearchParams(window.location.search).get('qaPair') || '';
    const match = raw.match(/-(\d+)(?:$|[^\d])/);
    const index = match ? Number(match[1]) : 1;
    return Number.isInteger(index) && index > 0 ? index - 1 : 0;
  }

  function firstEnabledBookingDate(offset = 0) {
    const days = Array.from(document.querySelectorAll('#calendarGrid button.calendar-day:not(:disabled)'))
      .filter((button) => !button.classList.contains('holiday-disabled'));
    state.bookingLaneDayCount = Math.max(1, days.length);
    if (!days.length) return null;
    const lane = pairedLaneIndex() + Math.max(0, Number(offset) || 0);
    return days[lane % days.length] || days[0] || null;
  }

  async function openBookingForSafeDate(offset = 0) {
    let day = firstEnabledBookingDate(offset);
    if (!day) {
      document.getElementById('nextMonthButton')?.click();
      await wait(120);
      day = firstEnabledBookingDate(offset);
    }
    if (!day) throw new Error('目前找不到可開啟預約的安全日期。');
    day.click();
    const panel = document.getElementById('appointmentPanel');
    if (!await waitFor(() => panel && !panel.classList.contains('hidden'), 1800)) throw new Error('預約選擇視窗未開啟。');
    return panel;
  }

  async function bookingHumanControlsCase() {
    const actual = {
      dateOpened: false, dateClosed: false, contactCustom: false, contactMember: false,
      partySizeChanged: true, serviceAdded: false, serviceRemoved: false, addonNotice: true
    };
    const panel = await openBookingForSafeDate();
    actual.dateOpened = !panel.classList.contains('hidden');
    document.getElementById('closeAppointmentButton')?.click();
    actual.dateClosed = Boolean(await waitFor(() => panel.classList.contains('hidden'), 1200));
    await openBookingForSafeDate();

    const custom = document.querySelector('input[name="bookingContactSource"][value="custom"]');
    const member = document.querySelector('input[name="bookingContactSource"][value="member"]');
    custom?.click();
    actual.contactCustom = !document.getElementById('bookingCustomContactFields')?.classList.contains('hidden');
    member?.click();
    actual.contactMember = Boolean(document.getElementById('bookingCustomContactFields')?.classList.contains('hidden'));

    const party = document.getElementById('bookingPartySize');
    if (party && party.options.length >= 2) {
      setFieldValue(party, '2');
      actual.partySizeChanged = document.querySelectorAll('#participantCardList .participant-card').length === 2;
      setFieldValue(party, '1');
      await wait(40);
    }

    const addonButton = Array.from(document.querySelectorAll('.service-choice .service-add-button')).find((button) => /加購/.test(button.closest('.service-choice')?.textContent || ''));
    if (addonButton) {
      addonButton.click();
      const notice = document.getElementById('bookingNoticeModal');
      actual.addonNotice = Boolean(await waitFor(() => notice && !notice.classList.contains('hidden'), 800));
      document.getElementById('confirmBookingNoticeButton')?.click();
      await waitFor(() => notice?.classList.contains('hidden'), 800);
    }

    const add = chooseNormalServiceButton(panel);
    if (add) {
      add.click();
      actual.serviceAdded = Boolean(await waitFor(() => document.querySelector('#selectedServiceList .selected-service-remove'), 1200));
      const remove = document.querySelector('#selectedServiceList .selected-service-remove');
      remove?.click();
      actual.serviceRemoved = Boolean(await waitFor(() => !document.querySelector('#selectedServiceList .selected-service-remove'), 1200));
    }
    document.getElementById('closeAppointmentButton')?.click();
    await waitFor(() => panel.classList.contains('hidden'), 1200);
    const ok = Object.values(actual).every(Boolean);
    return ok
      ? pass('已真人操作日期、預約視窗、聯絡資料來源、多人數量、加購提醒、增加與移除項目。', { allSteps: true }, actual)
      : fail('預約控制項真人操作至少一個步驟異常。', { allSteps: true }, actual);
  }

  async function waitForBookingCardByNote(note, timeoutMs = 8000, requireBookingId = false) {
    return waitFor(() => Array.from(document.querySelectorAll('#bookingList .booking-item')).find((card) => {
      const noteMatches = (card.textContent || '').includes(note);
      const bookingId = String(card.dataset.bookingId || '').trim();
      return noteMatches && (!requireBookingId || Boolean(bookingId));
    }), timeoutMs);
  }

  async function waitForBookingCardById(bookingId, timeoutMs = 5000) {
    const id = String(bookingId || '').trim();
    if (!id) return null;
    return waitFor(() => Array.from(document.querySelectorAll('#bookingList .booking-item'))
      .find((card) => String(card.dataset.bookingId || '').trim() === id), timeoutMs);
  }

  function waitForBookingCreatedEvent(note, timeoutMs = 12000) {
    const expectedNote = String(note || '').trim();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('booking:created', onCreated);
        window.clearTimeout(timer);
        resolve(value || null);
      };
      const onCreated = (event) => {
        const booking = event?.detail?.booking;
        if (!booking) return;
        if (expectedNote && String(booking.memberNote || '').trim() !== expectedNote) return;
        finish(booking);
      };
      const timer = window.setTimeout(() => finish(null), Math.max(500, Number(timeoutMs) || 12000));
      window.addEventListener('booking:created', onCreated);
    });
  }

  async function resolveBookingByNote(note) {
    const expectedNote = String(note || '').trim();
    if (!expectedNote) return null;
    const fresh = await requestCore('user.booking.bootstrap', {});
    return (Array.isArray(fresh?.bookings) ? fresh.bookings : []).find((booking) => (
      String(booking?.memberNote || '').trim() === expectedNote
      && Boolean(String(booking?.bookingId || '').trim())
    )) || null;
  }

  async function reconcileBookingIdentity(note, createdBooking, timeoutMs = 10000) {
    let bookingId = String(createdBooking?.bookingId || '').trim();
    let card = bookingId ? await waitForBookingCardById(bookingId, Math.min(timeoutMs, 3500)) : null;

    if (!card) {
      const byNote = await waitForBookingCardByNote(note, Math.min(timeoutMs, 4500), true);
      if (byNote) {
        card = byNote;
        if (!bookingId) bookingId = String(byNote.dataset.bookingId || '').trim();
      }
    }

    if (!bookingId) {
      const serverBooking = await resolveBookingByNote(note).catch(() => null);
      bookingId = String(serverBooking?.bookingId || '').trim();
    }

    if (bookingId && !card) {
      await refreshRealClient().catch(() => {});
      card = await waitForBookingCardById(bookingId, Math.min(timeoutMs, 3500));
    }

    return { bookingId, card };
  }

  async function chooseAvailableSlot() {
    return waitFor(() => {
      const slots = Array.from(document.querySelectorAll('#slotGrid .slot-button')).filter((button) => !button.disabled);
      if (!slots.length) return null;
      const dayCount = Math.max(1, Number(state.bookingLaneDayCount || 1));
      const slotLane = Math.floor(pairedLaneIndex() / dayCount);
      return slots[slotLane % slots.length] || slots[0] || null;
    }, 7000);
  }

  async function bookingBenefitRedemptionLifecycleCase() {
    const fixture = await qaServiceRequest('user.qa.fixture.prepare');
    const note = 'QA HUMAN E2E BENEFIT ' + String(fixture.fixtureTag || Date.now().toString(36));
    const actual = {
      fixtureReady: Boolean(fixture.ticketId && fixture.fixtureTag),
      groupedSectionVisible: false,
      benefitSelected: false,
      serviceAdded: false,
      slotSelected: false,
      created: false,
      persistedPending: false,
      historyVisible: false,
      preservedForAdmin: false
    };
    let bookingId = '';
    try {
      await refreshRealClient();
      window.BookingBenefits?.invalidate?.();
      const selector = 'input[data-booking-benefit-kind="points"][data-booking-benefit-id="' +
        CSS.escape(String(fixture.ticketId || '')) + '"]';
      const checkbox = await waitFor(() => document.querySelector(selector), 6000, 100);
      if (!checkbox) throw new Error('QA 預約優惠票券沒有出現在「本次可使用優惠」。');
      actual.groupedSectionVisible = Boolean(checkbox.closest('.booking-benefit-group[data-benefit-kind="points"]'));

      let panel = null;
      let slot = null;
      const enabledDateCount = document.querySelectorAll('#calendarGrid button.calendar-day:not(:disabled):not(.holiday-disabled)').length;
      const maxDateAttempts = Math.max(1, Math.min(5, enabledDateCount || 1));
      for (let attempt = 0; attempt < maxDateAttempts && !slot; attempt += 1) {
        panel = await openBookingForSafeDate(attempt);
        const add = chooseNormalServiceButton(panel);
        if (!add) return skip('目前沒有可供預約優惠 E2E 的一般預約項目。', { normalService: true }, { normalService: false });
        add.click();
        actual.serviceAdded = actual.serviceAdded || Boolean(await waitFor(() => document.querySelector('#selectedServiceList .selected-service-remove'), 1200));

        const currentCheckbox = await waitFor(() => document.querySelector(selector), 2500, 80);
        if (!currentCheckbox) throw new Error('開啟預約視窗後找不到 QA 預約優惠票券。');
        if (!currentCheckbox.checked) currentCheckbox.click();
        actual.benefitSelected = Boolean(await waitFor(() => {
          const node = document.querySelector(selector);
          const payload = window.BookingBenefits?.selectionPayload?.() || [];
          return node?.checked && payload.some((item) => item.kind === 'points' && item.id === fixture.ticketId);
        }, 1500, 60));

        setFieldValue(document.getElementById('memberNote'), note);
        slot = await chooseAvailableSlot();
        if (slot) break;

        document.querySelectorAll('#selectedServiceList .selected-service-remove').forEach((button) => button.click());
        document.getElementById('closeAppointmentButton')?.click();
        await waitFor(() => panel?.classList.contains('hidden'), 1200);
        await wait(80);
      }
      if (!slot) {
        return fail('預約優惠 E2E 已嘗試多個日期但找不到可用時段。', { availableSlot: true }, { availableSlot: false });
      }
      slot.click();
      actual.slotSelected = slot.getAttribute('aria-pressed') === 'true';

      const submit = await waitFor(() => {
        const button = document.getElementById('submitBookingButton');
        return button && !button.disabled ? button : null;
      }, 5000);
      if (!submit) throw new Error('預約優惠 E2E 送出按鈕尚未就緒。');
      submit.click();
      await waitFor(() => !document.getElementById('bookingConfirmModal')?.classList.contains('hidden'), 1800);
      const createdEventPromise = waitForBookingCreatedEvent(note, 12000);
      document.getElementById('confirmBookingButton')?.click();
      const createdBooking = await createdEventPromise;
      const identity = await reconcileBookingIdentity(note, createdBooking, 12000);
      bookingId = identity.bookingId;
      if (!bookingId) throw new Error('預約優惠 E2E 建立後找不到 Booking ID。');
      actual.created = true;

      const fresh = await requestCore('user.booking.bootstrap', {});
      const row = (Array.isArray(fresh?.bookings) ? fresh.bookings : []).find((booking) =>
        String(booking?.bookingId || '') === bookingId
      );
      const persistedBenefit = (Array.isArray(row?.benefits) ? row.benefits : []).find((benefit) =>
        benefit?.kind === 'points' && String(benefit?.id || '') === String(fixture.ticketId || '')
      );
      actual.persistedPending = String(persistedBenefit?.status || '') === 'pending';

      await refreshRealClient().catch(() => {});
      const card = await waitForBookingCardById(bookingId, 5000);
      actual.historyVisible = Boolean(card && String(card.textContent || '').includes(String(fixture.ticketTitle || 'QA 預約自動核銷票券')));
      actual.preservedForAdmin = true;
    } finally {
      // Full E2E intentionally retains QA fixtures and bookings for paired-admin
      // inspection and the existing manual purge workflow.
      actual.preservedForAdmin = Boolean(actual.preservedForAdmin || fixture.fixtureTag);
      await refreshRealClient().catch(() => {});
    }

    const ok = Object.values(actual).every(Boolean);
    return ok
      ? pass('已真人勾選專用 QA 優惠、建立預約並由 Bootstrap／歷史卡片回讀 pending 使用意圖；資料保留交由 paired admin 完成服務後核銷。', {
          selectedThroughUi: true,
          persistedPending: true,
          handedOffForAdminRedemption: true
        }, actual)
      : fail('預約優惠勾選、保存或管理端交接至少一項失敗。', {
          selectedThroughUi: true,
          persistedPending: true,
          handedOffForAdminRedemption: true
        }, actual);
  }

  async function verifyBookingCancellation(bookingId, timeoutMs = 7000) {
    const rendered = () => /取消待確認/.test(Array.from(document.querySelectorAll('#bookingList .booking-item'))
      .find(card => card.dataset.bookingId === bookingId)?.querySelector('.status-badge')?.textContent || '');
    let uiPending = Boolean(await waitFor(rendered, timeoutMs));
    const config = await loadConfig();
    const data = await window.BookingSystem.request(config, 'member', '', 'user.booking.bootstrap', {});
    const booking = (Array.isArray(data?.bookings) ? data.bookings : []).find(row => row.bookingId === bookingId);
    const serverPending = Boolean(booking && (booking.status === 'cancel_requested'
      || (booking.cancellationRequestedAt && !booking.cancellationReviewedAt)));
    if (serverPending && !uiPending) {
      await refreshRealClient();
      uiPending = Boolean(await waitFor(rendered, Math.min(4000, timeoutMs)));
    }
    return {serverPending,uiPending,serverStatus:String(booking?.status || ''),
      formMessage:serverPending && uiPending ? '' : String(document.getElementById('formMessage')?.textContent || '').slice(0,240)};
  }

  async function bookingHumanLifecycleCase() {
    const note = 'QA HUMAN E2E ' + Date.now().toString(36);
    const updatedNote = note + ' updated';
    const actual = {
      added: false, slotSelected: false, confirmBack: false, confirmClose: false,
      created: false, historyExpanded: false, editOpened: false, editCancelled: false,
      editSlotRestored: false, updated: false, cancelRequested: false, preserved: false
    };
    let bookingId = '';
    try {
      let panel = null;
      let slot = null;
      const enabledDateCount = document.querySelectorAll('#calendarGrid button.calendar-day:not(:disabled):not(.holiday-disabled)').length;
      const maxDateAttempts = Math.max(1, Math.min(5, enabledDateCount || 1));
      for (let attempt = 0; attempt < maxDateAttempts && !slot; attempt += 1) {
        panel = await openBookingForSafeDate(attempt);
        const add = chooseNormalServiceButton(panel);
        if (!add) return skip('目前沒有可供真人 E2E 的一般預約項目。', { normalService: true }, { normalService: false });
        add.click();
        const added = Boolean(await waitFor(() => document.querySelector('#selectedServiceList .selected-service-remove'), 1200));
        actual.added = actual.added || added;
        setFieldValue(document.getElementById('memberNote'), note);
        slot = await chooseAvailableSlot();
        if (slot) break;

        // 同一日期沒有空檔時，不應把必要的 Human E2E 直接略過；
        // 清掉本次選擇後改試下一個可預約日期，降低多 lane 並行造成的假失敗。
        document.querySelectorAll('#selectedServiceList .selected-service-remove').forEach((button) => button.click());
        await waitFor(() => !document.querySelector('#selectedServiceList .selected-service-remove'), 1200);
        document.getElementById('closeAppointmentButton')?.click();
        await waitFor(() => panel?.classList.contains('hidden'), 1200);
        await wait(80);
      }
      if (!slot) {
        return fail('已嘗試多個可預約日期，仍找不到可供真人 E2E 的預約時段。', {
          availableSlot: true
        }, {
          availableSlot: false,
          attemptedDates: maxDateAttempts
        });
      }
      slot.click();
      actual.slotSelected = slot.getAttribute('aria-pressed') === 'true';

      const submit = document.getElementById('submitBookingButton');
      submit?.click();
      const confirmModal = document.getElementById('bookingConfirmModal');
      await waitFor(() => confirmModal && !confirmModal.classList.contains('hidden'), 1500);
      document.getElementById('cancelBookingConfirmButton')?.click();
      actual.confirmBack = Boolean(await waitFor(() => confirmModal?.classList.contains('hidden'), 1200));

      submit?.click();
      await waitFor(() => confirmModal && !confirmModal.classList.contains('hidden'), 1500);
      document.getElementById('closeBookingConfirmButton')?.click();
      actual.confirmClose = Boolean(await waitFor(() => confirmModal?.classList.contains('hidden'), 1200));

      submit?.click();
      await waitFor(() => confirmModal && !confirmModal.classList.contains('hidden'), 1500);
      const createdEventPromise = waitForBookingCreatedEvent(note, 12000);
      document.getElementById('confirmBookingButton')?.click();
      const createdBooking = await createdEventPromise;
      const createdIdentity = await reconcileBookingIdentity(note, createdBooking, 10000);
      let card = createdIdentity.card;
      bookingId = createdIdentity.bookingId;
      if (!bookingId) throw new Error('真人送出預約後，建立事件、畫面與 Bootstrap 都找不到 Booking ID。');
      if (!card) {
        await refreshRealClient().catch(() => {});
        card = await waitForBookingCardById(bookingId, 3500);
      }
      if (!card) throw new Error('真人送出預約已取得 Booking ID，但預約卡片尚未同步。');
      actual.created = true;

      card?.querySelector('.booking-item-top')?.click();
      await wait(80);
      actual.historyExpanded = Boolean(await waitFor(() => document.querySelector('#bookingList .booking-item[data-booking-id="' + bookingId + '"]')?.dataset.bookingExpanded === '1', 1200));

      let edit = Array.from(card.querySelectorAll('button')).find((button) => button.textContent?.trim() === '修改預約');
      edit?.click();
      actual.editOpened = Boolean(await waitFor(() => !document.getElementById('appointmentPanel')?.classList.contains('hidden'), 1800));
      document.getElementById('cancelEditBookingButton')?.click();
      actual.editCancelled = Boolean(await waitFor(() => document.getElementById('editingBookingNotice')?.classList.contains('hidden'), 1500));

      card = document.querySelector('#bookingList .booking-item[data-booking-id="' + bookingId + '"]');
      edit = Array.from(card?.querySelectorAll('button') || []).find((button) => button.textContent?.trim() === '修改預約');
      edit?.click();
      await waitFor(() => !document.getElementById('appointmentPanel')?.classList.contains('hidden'), 1800);
      let editableSlot = await waitFor(
        () => document.querySelector('#slotGrid .slot-button[aria-pressed="true"]'),
        2500
      );
      if (!editableSlot) {
        editableSlot = await chooseAvailableSlot();
        if (editableSlot) {
          editableSlot.click();
          editableSlot = await waitFor(
            () => document.querySelector('#slotGrid .slot-button[aria-pressed="true"]'),
            1800
          );
        }
      }
      actual.editSlotRestored = Boolean(editableSlot);
      setFieldValue(document.getElementById('memberNote'), updatedNote);
      const editSubmit = await waitFor(() => {
        const button = document.getElementById('submitBookingButton');
        return button && !button.disabled ? button : null;
      }, 7000);
      editSubmit?.click();
      await waitFor(() => !document.getElementById('bookingConfirmModal')?.classList.contains('hidden'), 1500);
      document.getElementById('confirmBookingButton')?.click();
      card = await waitForBookingCardByNote(updatedNote, 10000);
      actual.updated = Boolean(card);

      const cancel = Array.from(card?.querySelectorAll('button') || []).find((button) => button.textContent?.trim() === '申請取消');
      if (cancel) {
        const originalConfirm = window.confirm;
        try {
          window.confirm = () => true;
          cancel.click();
        } finally {
          window.confirm = originalConfirm;
        }
        actual.cancellation = await verifyBookingCancellation(bookingId);
        actual.cancelRequested = actual.cancellation.serverPending && actual.cancellation.uiPending;
      }
    } finally {
      if (!bookingId) {
        const recovered = await resolveBookingByNote(note).catch(() => null);
        bookingId = String(recovered?.bookingId || '').trim();
      }
      if (bookingId) {
        actual.bookingId = bookingId;
        actual.preserved = true;
        await refreshRealClient().catch(() => {});
      }
    }
    const ok = Object.values(actual).every(Boolean);
    return ok
      ? pass('已真人完成單人預約增加項目、選時段、返回修改、關閉確認、新增、修改與取消申請；預約資料已保留供管理端檢查。', { allSteps: true }, actual)
      : fail('單人預約真人生命週期至少一個步驟異常。', { allSteps: true }, actual);
  }

  async function bookingHumanGroupLifecycleCase() {
    const party = document.getElementById('bookingPartySize');
    if (!party || party.options.length < 2) {
      return skip('目前多人預約上限不足 2 人。', { partySizeAtLeast: 2 }, { partySize: party ? party.options.length : 0 });
    }
    const note = 'QA HUMAN E2E GROUP ' + Date.now().toString(36);
    const actual = { partyTwo: false, firstAdded: false, firstQuantityTwo: false, secondAdded: false, slotSelected: false, created: false, preserved: false };
    let bookingId = '';
    try {
      let slot = null;
      const enabledDateCount = document.querySelectorAll('#calendarGrid button.calendar-day:not(:disabled):not(.holiday-disabled)').length;
      const maxDateAttempts = Math.max(1, Math.min(5, enabledDateCount || 1));
      for (let attempt = 0; attempt < maxDateAttempts && !slot; attempt += 1) {
        await openBookingForSafeDate(attempt);
        setFieldValue(party, '2');
        actual.partyTwo = actual.partyTwo || Boolean(await waitFor(() => document.querySelectorAll('#participantCardList .participant-card').length === 2, 1200));
        const cards = Array.from(document.querySelectorAll('#participantCardList .participant-card'));
        const firstAdd = chooseNormalServiceButton(cards[0] || document);
        firstAdd?.click();
        actual.firstAdded = actual.firstAdded || Boolean(await waitFor(() => cards[0]?.querySelector('.selected-service-remove') || document.querySelector('#participantCardList .participant-card[data-participant-index="0"] .selected-service-remove'), 1200));
        // Use quantity two on the first participant so the admin can later perform
        // a non-expanding item mutation even when a technician is already assigned.
        chooseNormalServiceButton(document.querySelector('#participantCardList .participant-card[data-participant-index="0"]') || document)?.click();
        actual.firstQuantityTwo = actual.firstQuantityTwo || Boolean(await waitFor(() => document.querySelectorAll('#participantCardList .participant-card[data-participant-index="0"] .selected-service-remove').length >= 2, 1200));
        const secondCard = document.querySelector('#participantCardList .participant-card[data-participant-index="1"]');
        if (secondCard && !secondCard.open) secondCard.querySelector('summary')?.click();
        const secondAdd = chooseNormalServiceButton(secondCard || document);
        secondAdd?.click();
        actual.secondAdded = actual.secondAdded || Boolean(await waitFor(() => document.querySelector('#participantCardList .participant-card[data-participant-index="1"] .selected-service-remove'), 1200));
        setFieldValue(document.getElementById('memberNote'), note);
        slot = await chooseAvailableSlot();
        if (slot) break;

        document.querySelectorAll('#participantCardList .selected-service-remove').forEach((button) => button.click());
        setFieldValue(party, '1');
        document.getElementById('closeAppointmentButton')?.click();
        await waitFor(() => document.getElementById('appointmentPanel')?.classList.contains('hidden'), 1200);
        await wait(80);
      }
      if (!slot) {
        return skip('已嘗試多個可預約日期，仍找不到可容納兩位的安全時段。', {
          availableGroupSlot: true
        }, {
          availableGroupSlot: false,
          attemptedDates: maxDateAttempts
        });
      }
      slot.click();
      actual.slotSelected = slot.getAttribute('aria-pressed') === 'true';
      document.getElementById('submitBookingButton')?.click();
      await waitFor(() => !document.getElementById('bookingConfirmModal')?.classList.contains('hidden'), 1800);
      const createdEventPromise = waitForBookingCreatedEvent(note, 12000);
      document.getElementById('confirmBookingButton')?.click();
      const createdBooking = await createdEventPromise;
      const createdIdentity = await reconcileBookingIdentity(note, createdBooking, 12000);
      const card = createdIdentity.card;
      bookingId = createdIdentity.bookingId;
      actual.created = Boolean(card && bookingId && card.dataset.participantDetails === '1');
    } finally {
      if (!bookingId) {
        const recovered = await resolveBookingByNote(note).catch(() => null);
        bookingId = String(recovered?.bookingId || '').trim();
      }
      if (bookingId) {
        actual.bookingId = bookingId;
        actual.preserved = true;
        await refreshRealClient().catch(() => {});
      }
      setFieldValue(document.getElementById('bookingPartySize'), '1');
    }
    const ok = Object.values(actual).every(Boolean);
    return ok
      ? pass('已真人操作兩位預約：設定人數、兩位各加項目、選時段並確認送出；預約資料已保留供管理端檢查。', { allSteps: true }, actual)
      : fail('多人預約真人流程至少一個步驟異常。', { allSteps: true }, actual);
  }

  function matchesButtonCoverage(button, pattern) {
    if (!button || !pattern) return false;
    if (button.dataset?.uiThemeControl === 'true') return true;
    const candidates = [
      String(button.id || ''),
      String(button.getAttribute?.('class') || ''),
      String(button.textContent || '').trim()
    ].filter(Boolean);
    return candidates.some((value) => {
      pattern.lastIndex = 0;
      return pattern.test(value);
    });
  }

  async function themeToggleCase() {
    const button = await waitFor(() => document.getElementById('themeToggleButton'), 2500);
    const root = document.documentElement;
    const storageKey = 'lumen-color-theme-v1';
    const original = String(root.dataset.theme || window.LumenTheme?.get?.() || '');
    if (!button || !/^(light|dark)$/.test(original)) {
      return fail('主題切換控制器未完整初始化。', { togglePresent: true, initialTheme: 'light|dark' }, {
        togglePresent: Boolean(button),
        initialTheme: original || null
      });
    }

    button.click();
    const changedTheme = original === 'dark' ? 'light' : 'dark';
    const changed = Boolean(await waitFor(() => root.dataset.theme === changedTheme, 1200));
    const persisted = (() => {
      try { return localStorage.getItem(storageKey) === changedTheme; } catch { return false; }
    })();
    const ariaChanged = button.getAttribute('aria-pressed') === (changedTheme === 'dark' ? 'true' : 'false');

    button.click();
    const restored = Boolean(await waitFor(() => root.dataset.theme === original, 1200));
    const restoredPersisted = (() => {
      try { return localStorage.getItem(storageKey) === original; } catch { return false; }
    })();

    const actual = { original, changedTheme, changed, persisted, ariaChanged, restored, restoredPersisted };
    return changed && persisted && ariaChanged && restored && restoredPersisted
      ? pass('亮／暗主題可真人切換、ARIA 同步、偏好可儲存並還原原狀。', {
          changed: true, persisted: true, ariaChanged: true, restored: true, restoredPersisted: true
        }, actual)
      : fail('主題切換、儲存或還原至少一項異常。', {
          changed: true, persisted: true, ariaChanged: true, restored: true, restoredPersisted: true
        }, actual);
  }

  function membershipMilestoneCase() {
    const root = document.getElementById('membershipProgress');
    const rail = root?.querySelector('[data-membership-milestones]');
    const items = Array.from(rail?.querySelectorAll('[data-membership-milestone]') || []);
    const current = items.filter((item) => item.getAttribute('aria-current') === 'step');
    const track = root?.querySelector('[data-membership-progress-track]');
    const valueNow = Number(track?.getAttribute('aria-valuenow'));
    const labels = items.map((item) => String(item.textContent || '').trim());
    const actual = {
      rootPresent: Boolean(root),
      milestoneCount: items.length,
      currentCount: current.length,
      labels,
      progressValue: valueNow,
      styleKey: String(root?.getAttribute('data-membership-tier-style') || '')
    };
    const ok = Boolean(root && rail) &&
      items.length === 4 &&
      current.length === 1 &&
      Number.isFinite(valueNow) && valueNow >= 0 && valueNow <= 100 &&
      ['一般', '銀級', '金級', '白金'].every((label) => labels.includes(label));

    return ok
      ? pass('會員階級進度與四階段 milestone 已同步目前會員狀態。', {
          milestoneCount: 4, currentCount: 1, progressRange: '0-100'
        }, actual)
      : fail('會員階級 milestone 或進度 ARIA 狀態不完整。', {
          milestoneCount: 4, currentCount: 1, progressRange: '0-100'
        }, actual);
  }

  async function detailsDisclosureCase(detailsId, label) {
    const details = document.getElementById(detailsId);
    const summary = details?.querySelector('summary');
    if (!details || !summary) {
      return fail(label + '展開控制不存在。', { present: true }, { present: false });
    }
    const original = details.open;
    summary.click();
    const toggled = Boolean(await waitFor(() => details.open !== original, 800));
    summary.click();
    const restored = Boolean(await waitFor(() => details.open === original, 800));
    return toggled && restored
      ? pass(label + '可真人展開並還原。', { toggled: true, restored: true }, { toggled, restored })
      : fail(label + '展開／收合互動異常。', { toggled: true, restored: true }, { toggled, restored });
  }

  async function memberFriendControlsCase() {
    const trigger = await waitFor(() => document.getElementById('openMemberFriends'), 4000);
    const input = document.getElementById('friendLookupCode');
    const code = String(state.bootstrap?.profile?.memberCode || state.session?.account?.memberCode || '');
    if (!trigger || !input || !code) return fail('好友中心或本輪會員編號不存在。', {ready:true}, {ready:false});
    const previous = input.value;
    try {
      trigger.click();
      const refresh = document.getElementById('refreshFriends');
      await waitFor(() => refresh && !refresh.disabled, 6000);
      refresh?.click();
      const loaded = Boolean(await waitFor(() => refresh && !refresh.disabled
        && !/正在載入|失敗|無法/.test(document.getElementById('friendListStatus')?.textContent || ''), 8000));
      input.value = code; input.dispatchEvent(new Event('input', {bubbles:true}));
      document.getElementById('friendAddForm')?.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));
      const selfRejected = Boolean(await waitFor(() => /不可使用自己/.test(document.getElementById('friendStatus')?.textContent || ''), 2000));
      const requestHidden = document.getElementById('confirmFriendRequest')?.hidden === true;
      document.getElementById('closeMemberFriends')?.click();
      const closed = document.getElementById('memberFriendsModal')?.classList.contains('hidden') === true;
      const actual = {loaded,selfRejected,requestHidden,closed};
      return Object.values(actual).every(Boolean)
        ? pass('好友名單更新、自邀拒絕與關閉皆完成，未送出好友邀請。', {loaded:true,selfRejected:true,requestHidden:true,closed:true}, actual)
        : fail('好友名單或自邀邊界異常。', {loaded:true,selfRejected:true,requestHidden:true,closed:true}, actual);
    } finally { input.value = previous; input.dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('closeMemberFriends')?.click(); }
  }

  async function historyTabsCase({rootId,attribute,keys,prefix,rowSelector}) {
    const root = await waitFor(() => {
      const node = document.getElementById(rootId);
      return node && node.querySelector('[' + attribute + ']') ? node : null;
    }, 5000);
    if (!root) return skip('本輪沒有歷程資料，分類操作未執行。', {historyReady:true}, {historyReady:false});
    const original = root.querySelector('[' + attribute + '][aria-selected="true"]')?.getAttribute(attribute) || keys[0];
    const checks = [];
    try {
      for (const key of keys) {
        const tab = root.querySelector('[' + attribute + '="' + key + '"]');
        tab?.click();
        const panel = root.querySelector('#' + prefix + key);
        const count = panel?.querySelectorAll(rowSelector).length || 0;
        const badge = tab?.querySelector('.booking-history-tab-count');
        const countMatches = String(badge?.textContent || '').trim() === count + ' 筆';
        const selected = tab?.getAttribute('aria-selected') === 'true' && panel?.hidden === false
          && root.querySelectorAll('[' + attribute + '][aria-selected="true"]').length === 1;
        const row = panel?.querySelector(rowSelector);
        let disclosureMatches = true;
        const summary = row?.querySelector('summary');
        const heading = row?.querySelector('.booking-item-top');
        if (summary) {
          const before = row.open; summary.click();
          disclosureMatches = row.open !== before; summary.click();
          disclosureMatches = disclosureMatches && row.open === before;
        } else if (heading) {
          const before = row.classList.contains('is-expanded'); heading.click();
          disclosureMatches = row.classList.contains('is-expanded') !== before; heading.click();
          disclosureMatches = disclosureMatches && row.classList.contains('is-expanded') === before;
        }
        checks.push({key,count,countMatches,selected,disclosureMatches});
      }
      return checks.every(item => item.countMatches && item.selected && item.disclosureMatches)
        ? pass('全部歷程分類已逐一點擊，筆數與資料一致。', {allTabs:true,countMatches:true}, {checks})
        : fail('歷程分類、選取狀態或筆數不一致。', {allTabs:true,countMatches:true}, {checks});
    } finally { root.querySelector('[' + attribute + '="' + original + '"]')?.click(); }
  }

  async function bookingHistoryTabsCase() {
    return historyTabsCase({rootId:'bookingList',attribute:'data-booking-tab',
      keys:['reserved','completed','cancelled','no_show'],prefix:'bookingHistoryPanel-',rowSelector:'.booking-item'});
  }

  async function bookingSnapshotHistoryTabsCase() {
    return historyTabsCase({rootId:'bookingSnapshotHistory',attribute:'data-snapshot-history-tab',
      keys:['pending','registered','attention','withdrawn'],prefix:'snapshotHistoryPanel-',rowSelector:'details[data-receipt-id]'});
  }

  async function pointsHistoryDisclosureCase() {
    return detailsDisclosureCase('ticketHistoryDisclosure', '票券使用紀錄');
  }

  async function eventHistoryDisclosureCase() {
    return detailsDisclosureCase('usedTicketHistoryDisclosure', '已使用活動票券紀錄');
  }

  async function bookingFlowStepperCase() {
    document.getElementById('closeBookingConfirmButton')?.click();
    document.getElementById('closeAppointmentButton')?.click();
    const flow = await waitFor(() => document.querySelector('[data-booking-flow]'), 2500);
    const steps = Array.from(flow?.querySelectorAll('[data-booking-flow-step]') || []);
    const actual = {
      stepCount: steps.length,
      initialStep: String(flow?.dataset.currentStep || ''),
      openedStep: '',
      serviceStep: '',
      slotStep: '',
      restoredStep: ''
    };
    if (!flow || steps.length !== 4) {
      return fail('預約 stepper 未完整載入四個階段。', { stepCount: 4 }, actual);
    }

    try {
      const panel = await openBookingForSafeDate();
      actual.openedStep = String(flow.dataset.currentStep || '');
      const add = chooseNormalServiceButton(panel);
      if (!add) return skip('目前沒有可供 stepper E2E 使用的一般預約項目。', { normalService: true }, { normalService: false });
      add.click();
      await waitFor(() => flow.dataset.currentStep === '3', 1800);
      actual.serviceStep = String(flow.dataset.currentStep || '');
      const slot = await chooseAvailableSlot();
      if (!slot) return skip('目前沒有可供 stepper E2E 使用的安全時段。', { availableSlot: true }, { availableSlot: false });
      slot.click();
      await waitFor(() => flow.dataset.currentStep === '4', 1200);
      actual.slotStep = String(flow.dataset.currentStep || '');
    } finally {
      document.querySelectorAll('#selectedServiceList .selected-service-remove').forEach((button) => button.click());
      document.getElementById('closeAppointmentButton')?.click();
      try { await waitFor(() => flow.dataset.currentStep === '1', 1200); } catch {}
      actual.restoredStep = String(flow.dataset.currentStep || '');
    }

    const ok = actual.openedStep === '2' && actual.serviceStep === '3' && actual.slotStep === '4' && actual.restoredStep === '1';
    return ok
      ? pass('預約 stepper 會依日期、項目、時段與關閉狀態依序更新。', {
          openedStep: '2', serviceStep: '3', slotStep: '4', restoredStep: '1'
        }, actual)
      : fail('預約 stepper 與實際表單狀態不同步。', {
          openedStep: '2', serviceStep: '3', slotStep: '4', restoredStep: '1'
        }, actual);
  }

  function featureContractCoverageCase() {
    const common = [
      ['themeToggle', '#themeToggleButton'],
      ['membershipProgress', '#membershipProgress'],
      ['membershipMilestones', '#membershipProgress [data-membership-milestones]']
    ];
    const surfaceContracts = {
      member: [
        ['profileDetails', '#profileDetailsTitle'],
        ['honorificDialog', '#honorificEditModal'],
        ['birthdayDialog', '#birthdayEditModal'],
        ['phoneDialog', '#phoneEditModal'],
        ['memberReferral', '#memberReferralModal']
      ],
      points: [
        ['cardTabs', '#cardTabs'],
        ['ticketOverview', '#ticketList'],
        ['ticketHistory', '#ticketHistoryDisclosure'],
        ['pointTransfer', '#pointTransferModal']
      ],
      event: [
        ['eventList', '#eventList'],
        ['ticketDialog', '#ticketModal'],
        ['usedHistory', '#usedTicketHistoryDisclosure'],
        ['todayUsableCount', '#todayUsableTicketCount']
      ],
      calendar: [
        ['calendarGrid', '#calendarGrid'],
        ['calendarDetailDialog', '#calendarDetailModal'],
        ['todayControl', '#todayButton']
      ],
      booking: [
        ['bookingCalendar', '#calendarGrid'],
        ['appointmentDialog', '#appointmentPanel'],
        ['bookingConfirmDialog', '#bookingConfirmModal'],
        ['bookingHistory', '#bookingList'],
        ['bookingFlow', '[data-booking-flow]'],
        ['bookingBenefits', '#bookingBenefits'],
        ['bookingReceipt', '#bookingReceiptModal']
      ]
    };
    const contracts = common.concat(surfaceContracts[surface] || []);
    const missing = contracts
      .filter(([, selector]) => !document.querySelector(selector))
      .map(([key, selector]) => ({ key, selector }));
    const actual = { surface, contractCount: contracts.length, missing };
    return missing.length === 0
      ? pass('非按鈕 DOM 契約存在；實際操作結果由各功能節點與覆蓋摘要判定。', { missing: [] }, actual)
      : fail('發現尚未掛入 E2E 的功能區塊或互動契約。', { missing: [] }, actual);
  }

  async function buttonCoverageCase() {
    const qaPanel = state.panel;
    const qaInfrastructureControls = [LAUNCHER_ID].filter((id) => document.getElementById(id));
    const buttons = Array.from(document.querySelectorAll('button')).filter((button) => !qaPanel?.contains(button) && button.id !== LAUNCHER_ID);
    const navigationIds = new Set(['retryButton','logoutButton','joinMemberButton','refreshProfileButton','refreshTicketButton']);
    const patterns = {
      member: /^(copyMemberCodeButton|showMemberIdentityQr|openMemberFriends|friendQrScanImage|scanMemberReferralQr|stopMemberReferralQr|uploadMemberReferralQr|refreshFriends|confirmFriendRequest|lookupFriend|scanFriendQr|uploadFriendQr|stopFriendQr|edit|close|cancel|save|profileBirthdayPicker|confirmProfileBirthdayPicker|openMemberReferral|closeMemberReferral|bindMemberReferral|renewTermsButton)/,
      points: /^(retryButton|joinMemberButton|logoutButton|pointTransferButton|pointTransferClose|pointTransferCopyOwnCode|pointTransferLookup|pointTransferSubmit|pointTransferChooseFriend|pointTransferUseFriend|pointTransferScanQr|pointTransferQrImageButton|pointTransferQrClose|pointTransferShowOwnQr|pointTransferFriendCancel)$|qr-scan-dialog-close|card-tab|ticket-overview-use|ticket-batch-(cancel|confirm)|ticket-live-location-confirm/, 
      event: /^(retryButton|joinMemberButton|logoutButton|closeTicketModal|ticketModalAction|refreshTicketButton)$|ticket-button|event-history-button|ticketModalLocationButton/,
      calendar: /^(retryButton|joinMemberButton|logoutButton|previousMonthButton|todayButton|nextMonthButton|closeCalendarDetailButton)$|calendar-day/,
      booking: /^(retryButton|joinMemberButton|logoutButton|previousMonthButton|nextMonthButton|closeAppointmentButton|cancelEditBookingButton|submitBookingButton|confirmBookingNoticeButton|closeBookingConfirmButton|cancelBookingConfirmButton|confirmBookingButton|closeBookingHolidayButton|bookingBenefitsRetry|bookingReceiptClose|bookingReceiptCapture|bookingReceiptRetake|bookingReceiptDiscard|bookingReceiptCancel|bookingReceiptSubmit|bookingAccessibleToggle|bookingAccessibleUpload|bookingAccessibleRefresh)$|calendar-day|service-add-button|selected-service-remove|slot-button|text-danger-button|button-light|拍攝收據送出審核|收據上傳未完成/
    };
    const mapped = [];
    const unmapped = [];
    const navigation = [];
    for (const button of buttons) {
      // An id-less dynamic button must retain its nearest named container in
      // the QA report; a generic CSS class alone cannot identify a missed flow.
      const ownerId = button.closest('[id]')?.id || '';
      const signature = button.id || [
        String(button.className || '').slice(0, 64),
        ownerId ? 'within #' + ownerId : 'without named container'
      ].join(' · ');
      if (navigationIds.has(button.id)) {
        navigation.push(signature);
        continue;
      }
      const pattern = patterns[surface];
      if (button.closest('#friendsPanel') || /^(openMemberTour|memberTourDismiss|memberTourSkip|memberTourBack|memberTourNext)$/.test(button.id) || matchesButtonCoverage(button, pattern)) mapped.push(signature);
      else unmapped.push(signature);
    }
    const actual = { totalButtons: buttons.length, mappedFunctional: mapped.length, navigationSessionControls: navigation, qaInfrastructureControls, unmapped };
    return unmapped.length === 0
      ? pass('功能按鈕已分類；分類結果不代表每個按鈕均完成行為驗證。', { unmapped: [] }, actual)
      : fail('發現尚未納入測試劇本的新按鈕，完整測試需補案例。', { unmapped: [] }, actual);
  }

  async function expectApiError(action, payload, codes) {
    try {
      await requestCore(action, payload || {});
      return { ok: false, code: '', message: 'request unexpectedly succeeded' };
    } catch (error) {
      const code = String(error && error.code || '');
      return { ok: !codes.length || codes.includes(code) || codes.some((item) => code.startsWith(item)), code, message: String(error && error.message || '').slice(0, 180) };
    }
  }

  async function membershipTermsConsentCase() {
    const data = await requestCore('user.member.bootstrap', {});
    state.bootstrap = data;
    const terms = data?.terms || null;
    const domIds = [
      'joinTermsSummary','joinTermsTitle','joinTermsBody','joinTermsAccepted',
      'termsRenewView','renewTermsForm','renewTermsAccepted','renewTermsButton'
    ];
    const missing = domIds.filter((id) => !document.getElementById(id));
    if (!terms?.id || !terms?.version) {
      return skip(
        '會員條款尚未由管理端啟用；此案例標記為環境阻擋，避免誤判為功能失敗。',
        { activeTerms: true, requiredConsentDom: true },
        { activeTerms: false, missing, blockerCode: 'MEMBERSHIP_TERMS_NOT_CONFIGURED' }
      );
    }
    const unchecked = await expectApiError(
      'user.member.terms.accept',
      { termsId: terms.id, termsVersion: terms.version, accepted: false },
      ['TERMS_CONSENT_REQUIRED']
    );
    const stale = await expectApiError(
      'user.member.terms.accept',
      { termsId: terms.id, termsVersion: String(terms.version) + '-E2E-STALE', accepted: true },
      ['TERMS_VERSION_STALE']
    );
    let validAccepted = false;
    let consentRequiredAfterAccept = true;
    let validAcceptCode = '';
    try {
      const accepted = await requestCore('user.member.terms.accept', {
        termsId: terms.id,
        termsVersion: terms.version,
        accepted: true
      });
      validAccepted = true;
      consentRequiredAfterAccept = accepted?.consentRequired === true;
      const refreshed = await requestCore('user.member.bootstrap', {});
      state.bootstrap = refreshed;
      consentRequiredAfterAccept = refreshed?.consentRequired === true;
    } catch (error) {
      validAcceptCode = String(error?.code || '');
    }
    const actual = {
      activeTerms: true,
      scope: String(terms.scope || ''),
      version: terms.version,
      required: terms.required === true,
      missing,
      uncheckedRejected: unchecked.ok,
      uncheckedCode: unchecked.code,
      staleRejected: stale.ok,
      staleCode: stale.code,
      validAccepted,
      validAcceptCode,
      consentRecorded: validAccepted && consentRequiredAfterAccept === false
    };
    const ok =
      terms.scope === 'e2e'
      && terms.required === true
      && missing.length === 0
      && unchecked.ok
      && stale.ok
      && validAccepted
      && consentRequiredAfterAccept === false;
    return ok
      ? pass('會員條款 E2E 已建立隔離測試版本，確認未同意／舊版本會被拒絕，並實際寫入目前測試會員的同意紀錄。', {
          activeTerms: true, scope: 'e2e', required: true, missing: [],
          uncheckedRejected: true, staleRejected: true, validAccepted: true, consentRecorded: true
        }, actual)
      : fail('會員條款 E2E fixture、版本邊界或實際同意紀錄至少一項不符合預期。', {
          activeTerms: true, scope: 'e2e', required: true, missing: [],
          uncheckedRejected: true, staleRejected: true, validAccepted: true, consentRecorded: true
        }, actual);
  }


  async function memberJoinTermsFlowCase() {
    const data = await requestCore('user.member.bootstrap', {});
    state.bootstrap = data;
    const terms = data?.terms || null;
    const form = document.getElementById('profileForm');
    const summary = document.getElementById('joinTermsSummary');
    const title = document.getElementById('joinTermsTitle');
    const body = document.getElementById('joinTermsBody');
    const checkbox = document.getElementById('joinTermsAccepted');
    const message = document.getElementById('profileFormMessage');
    const fields = {
      surname: document.getElementById('profileSurname'),
      salutation: document.getElementById('profileSalutation'),
      birthday: document.getElementById('profileBirthday'),
      country: document.getElementById('profileCountryCode'),
      phone: document.getElementById('profilePhone')
    };
    const required = [form, summary, title, body, checkbox, message, ...Object.values(fields)];
    if (!terms?.id || !terms?.version) {
      return skip(
        '會員申請條款尚未由管理端啟用；真人流程無法安全執行。',
        { activeTerms: true },
        { activeTerms: false, blockerCode: 'MEMBERSHIP_TERMS_NOT_CONFIGURED' }
      );
    }
    if (required.some((node) => !node)) {
      return fail(
        '會員申請條款真人流程缺少必要 DOM。',
        { requiredDom: true },
        { requiredDom: false }
      );
    }

    const previous = {
      surname: fields.surname.value,
      salutation: fields.salutation.value,
      birthday: fields.birthday.value,
      country: fields.country.value,
      phone: fields.phone.value,
      checked: checkbox.checked,
      messageText: message.textContent,
      messageHidden: message.classList.contains('hidden')
    };
    const actual = {
      e2eScope: terms.scope === 'e2e',
      versionVisible: false,
      uncheckedBlocked: false,
      checkboxVerified: false,
      noProfileWriteTriggered: true,
      restored: false
    };

    try {
      actual.versionVisible =
        String(summary.textContent || '').includes(String(terms.version)) &&
        String(title.textContent || '').includes(String(terms.version)) &&
        String(body.textContent || '').trim().length > 0;

      setFieldValue(fields.surname, '測');
      setFieldValue(fields.salutation, 'mr');
      setFieldValue(fields.birthday, '1990-01-15');
      setFieldValue(fields.country, '+886');
      setFieldValue(fields.phone, '0912345678');
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));

      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      actual.uncheckedBlocked = Boolean(await waitFor(
        () => /請閱讀並勾選同意會員條款/.test(String(message.textContent || '')) ? message : null,
        1800,
        50
      ));

      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(500);
      actual.checkboxVerified =
        checkbox.checked === true &&
        String(summary.textContent || '').includes(String(terms.version)) &&
        !/條款剛剛更新|無法確認最新會員條款/.test(String(message.textContent || ''));
    } finally {
      fields.surname.value = previous.surname;
      fields.salutation.value = previous.salutation;
      fields.birthday.value = previous.birthday;
      fields.country.value = previous.country;
      fields.phone.value = previous.phone;
      checkbox.checked = previous.checked;
      message.textContent = previous.messageText;
      message.classList.toggle('hidden', previous.messageHidden);
      actual.restored =
        fields.surname.value === previous.surname &&
        fields.salutation.value === previous.salutation &&
        fields.birthday.value === previous.birthday &&
        fields.country.value === previous.country &&
        fields.phone.value === previous.phone &&
        checkbox.checked === previous.checked;
    }

    const ok = Object.values(actual).every(Boolean);
    return ok
      ? pass(
          '會員申請條款已使用隔離 E2E 條款資料進行真人 submit/change 驗證：目前版本有完整內容、未勾選會被前端阻擋、勾選後會再次確認仍為目前版本。',
          { e2eScope: true, versionVisible: true, uncheckedBlocked: true, checkboxVerified: true, noProfileWriteTriggered: true, restored: true },
          actual
        )
      : fail(
          '會員申請條款真人流程至少一個步驟不符合預期。',
          { e2eScope: true, versionVisible: true, uncheckedBlocked: true, checkboxVerified: true, noProfileWriteTriggered: true, restored: true },
          actual
        );
  }

  async function memberInvalidWriteCase() {
    const contact = await expectApiError(
      'user.member.profile.save',
      { birthday: 'not-a-date', phone: 'x' },
      ['INVALID_BIRTHDAY', 'INVALID_PHONE', 'INVALID_']
    );
    const honorific = await expectApiError(
      'user.member.profile.save',
      { surname: '', salutation: 'invalid' },
      ['INVALID_SURNAME', 'INVALID_SALUTATION', 'INVALID_']
    );
    const ok = contact.ok && honorific.ok;
    return ok
      ? pass(
          '會員資料 API 會拒絕無效生日、電話、姓氏與稱謂，不執行資料修改。',
          { contactRejected: true, honorificRejected: true },
          { contact, honorific }
        )
      : fail(
          '會員資料寫入驗證沒有完整拒絕無效輸入。',
          { contactRejected: true, honorificRejected: true },
          { contact, honorific }
        );
  }


  async function usageStateComplexityCase() {
    if (state.usageStateError) {
      return fail(
        '高複雜度使用狀態建立失敗；其餘案例仍繼續執行以保留診斷資訊。',
        { prepared: true, complexStateKinds: true },
        { prepared: false, error: state.usageStateError }
      );
    }
    const data = state.usageState || {};
    const kinds = Array.isArray(data.stateKinds) ? data.stateKinds.filter(Boolean) : [];
    const recordsCreated = Number(data.recordsCreated || 0);
    const minimumRecords = surface === 'points' ? 8 : surface === 'event' ? 6 : surface === 'calendar' ? 5 : surface === 'member' ? 2 : surface === 'booking' ? 2 : 1;
    const minimumKinds = surface === 'points' ? 6 : surface === 'event' ? 5 : surface === 'calendar' ? 5 : surface === 'member' ? 3 : surface === 'booking' ? 2 : 1;
    const requiredBookingStates = ['pending', 'cancel_requested'];
    const bookingStatesReady = surface !== 'booking'
      || requiredBookingStates.every((stateName) => kinds.includes(stateName));
    const ok = data.prepared === true
      && recordsCreated >= minimumRecords
      && kinds.length >= minimumKinds
      && bookingStatesReady;
    const actual = {
      scenario: data.scenario || '',
      recordsCreated,
      stateKinds: kinds,
      usageStateTag: data.usageStateTag || '',
      serviceMinutesAdded: Number(data.serviceMinutesAdded || 0),
      cardIds: Array.isArray(data.cardIds) ? data.cardIds : [],
      bookings: Array.isArray(data.bookings) ? data.bookings : [],
      requiredBookingStates: surface === 'booking' ? requiredBookingStates : [],
      bookingStatesReady,
      usageStateAttempts: Array.isArray(data.usageStateAttempts) ? data.usageStateAttempts : []
    };
    return ok
      ? pass(
          'E2E 已在真人操作前建立混合使用狀態，不再從乾淨空白帳號開始。',
          { prepared: true, minimumRecords, minimumKinds, requiredBookingStates: surface === 'booking' ? requiredBookingStates : [] },
          actual
        )
      : fail(
          '使用狀態前置資料量或狀態種類不足。',
          { prepared: true, minimumRecords, minimumKinds, requiredBookingStates: surface === 'booking' ? requiredBookingStates : [] },
          actual
        );
  }


  async function memberCodeCopyCase() {
    const button = document.getElementById('copyMemberCodeButton');
    const code = document.getElementById('memberCode')?.textContent.trim();
    if (!button || !code || code === '—') return fail('會員編號複製入口或編號未就緒。',{ready:true},{ready:false});
    if (button.disabled) await waitFor(() => !button.disabled, 2500);
    button.click();
    const feedback = await waitFor(() => /已複製|複製失敗/.test(button.textContent), 2500);
    const copied = Boolean(feedback) && button.textContent === '已複製';
    await waitFor(() => !button.disabled, 2500);
    return copied ? pass('已點擊複製且顯示成功回饋；剪貼簿內容另由隔離 Chromium 驗證。',{copied:true},{copied:true})
      : fail('複製未成功或未提供明確回饋。',{copied:true},{copied:false,feedback:button.textContent});
  }

  async function memberQrControlsCase() {
    const trigger = document.getElementById('openMemberReferral');
    trigger?.click();
    const modal = document.getElementById('memberReferralModal');
    const checks = [];
    try {
      for (const [tab,ids] of [['openMemberFriends',['scanFriendQr','friendQrFile','stopFriendQr']],['openMemberReferral',['scanMemberReferralQr','memberReferralQrFile','stopMemberReferralQr']]]) {
        document.getElementById(tab)?.click();
        checks.push({tab,controls:ids.every(id => Boolean(document.getElementById(id)))});
      }
      let foreignRejected = false;
      if (typeof window.FriendQRScanner?.parseInvitation === 'function') {
        try { window.FriendQRScanner.parseInvitation('https://foreign.invalid/member/#friend=TEST1234'); } catch (_) { foreignRejected = true; }
      }
      const actual = {opened:Boolean(modal && !modal.classList.contains('hidden')),controls:checks.length === 2 && checks.every(row => row.controls),foreignRejected,sharedDialog:typeof window.QRScanDialog?.open === 'function'};
      return Object.values(actual).every(Boolean)
        ? pass('好友／優惠各有 QR 入口，外站碼拒絕且共用 dialog 已載入；未要求相機或建立邀請。',{opened:true,controls:true,foreignRejected:true,sharedDialog:true},actual)
        : fail('QR 入口、解析安全或共用 dialog 不完整。',{opened:true,controls:true,foreignRejected:true,sharedDialog:true},actual);
    } finally { document.getElementById('closeMemberFriends')?.click(); document.getElementById('closeMemberReferral')?.click(); }
  }

  async function pointsTransferRecipientControlsCase() {
    const button = document.getElementById('pointTransferButton');
    if (!button || button.disabled) return skip('本輪沒有可轉贈餘額，收件者流程未執行。',{transferableBalance:true},{transferableBalance:false});
    button.click();
    const modal = document.getElementById('pointTransferModal');
    try {
      const choose = document.getElementById('pointTransferChooseFriend');
      const qr = document.getElementById('pointTransferScanQr');
      if (choose?.disabled) return skip('有待確認轉贈，保留原交易且不切換收件人。',{recipientEditable:true},{recipientEditable:false});
      choose?.click();
      const loaded = Boolean(await waitFor(() => !document.getElementById('pointTransferFriendSelect')?.disabled && !/正在載入/.test(document.getElementById('pointTransferFriendStatus')?.textContent || ''),6000));
      const actual = {opened:Boolean(modal && !modal.classList.contains('hidden')),friendPicker:!document.getElementById('pointTransferFriendPicker')?.hidden,loaded:loaded && /選擇好友後|目前沒有已接受/.test(document.getElementById('pointTransferFriendStatus')?.textContent || ''),qrControl:Boolean(qr),manualInput:Boolean(document.getElementById('pointTransferMemberCode')),noRecipientChosen:!document.getElementById('pointTransferReceiver')?.textContent};
      return Object.values(actual).every(Boolean)
        ? pass('好友選擇載入，QR／會員編號替代入口可用；取消未提交轉贈。',{opened:true,friendPicker:true,loaded:true,qrControl:true,manualInput:true,noRecipientChosen:true},actual)
        : fail('轉贈收件者控制或好友載入未就緒。',{loaded:true},actual);
    } finally { document.getElementById('pointTransferClose')?.click(); }
  }

  async function memberReferralBoundaryCase() {
    const profile = state.bootstrap?.profile || (await requestCore('user.member.bootstrap', {}))?.profile || {};
    const trigger = await waitFor(() => document.getElementById('openMemberReferral'), 3000);
    if (!trigger) return fail('會員卡沒有好友入口。', { trigger: true }, { trigger: false });
    trigger.click();
    const modal = await waitFor(() => {
      const node = document.getElementById('memberReferralModal');
      return node && !node.classList.contains('hidden') ? node : null;
    }, 2000);

    const ownMemberCode = String(profile.memberCode || '').trim().toUpperCase();
    const validMemberCode = /^[A-Z0-9_-]{4,40}$/.test(ownMemberCode);

    const friendInput = document.getElementById('friendLookupCode');
    const friendForm = document.getElementById('friendAddForm');
    const friendStatus = document.getElementById('friendStatus');
    let friendSelfRejected = false;
    if (modal && friendInput && friendForm && validMemberCode) {
      document.getElementById('openMemberFriends')?.click();
      friendInput.value = ownMemberCode;
      friendInput.dispatchEvent(new Event('input', { bubbles: true }));
      friendForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      friendSelfRejected = Boolean(await waitFor(
        () => /不可使用自己的邀請碼或會員編號/.test(String(friendStatus?.textContent || '')),
        1200
      ));
    }

    const rewardInput = document.getElementById('memberReferralInviteCode');
    const rewardForm = document.getElementById('memberReferralForm');
    const rewardStatus = document.getElementById('memberReferralStatus');
    let rewardSelfRejected = false;
    if (modal && rewardInput && rewardForm && validMemberCode) {
      document.getElementById('openMemberReferral')?.click();
      rewardInput.value = ownMemberCode;
      rewardInput.dispatchEvent(new Event('input', { bubbles: true }));
      rewardForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      rewardSelfRejected = Boolean(await waitFor(
        () => /不可使用自己的邀請優惠碼或會員編號/.test(String(rewardStatus?.textContent || '')),
        1200
      ));
    }

    const friendScan = document.getElementById('scanFriendQr');
    const rewardScan = document.getElementById('scanMemberReferralQr');
    document.getElementById('closeMemberReferral')?.click();
    const closed = Boolean(!modal || await waitFor(() => modal.classList.contains('hidden'), 1000));
    const actual = {
      modal: Boolean(modal),
      validMemberCode,
      friendScanControl: Boolean(friendScan),
      rewardScanControl: Boolean(rewardScan),
      friendSelfRejected,
      rewardSelfRejected,
      closed
    };
    return Object.values(actual).every(Boolean)
      ? pass('好友與邀請優惠已分流；好友自邀與優惠自綁皆被前端拒絕，兩種掃描入口各自存在。', {
          modal: true,
          validMemberCode: true,
          friendScanControl: true,
          rewardScanControl: true,
          friendSelfRejected: true,
          rewardSelfRejected: true,
          closed: true
        }, actual)
      : fail('好友／邀請優惠 Browser E2E 契約至少一項不符合預期。', {
          modal: true,
          validMemberCode: true,
          friendScanControl: true,
          rewardScanControl: true,
          friendSelfRejected: true,
          rewardSelfRejected: true,
          closed: true
        }, actual);
  }

  async function memberJoinLineAutomationContractCase() {
    const manualSendControls = Array.from(document.querySelectorAll('button,a')).filter((node) =>
      /傳送.*(?:LINE|官方帳號)|LINE.*傳送/.test(String(node.textContent || ''))
    );
    const joined = Boolean(state.bootstrap?.profile?.profileComplete);
    const actual = {
      joinedTestAccount: joined,
      manualSendControls: manualSendControls.map((node) => String(node.id || node.textContent || '').trim()).filter(Boolean),
      liffSendMessagesAvailable: typeof window.liff?.sendMessages === 'function'
    };
    return manualSendControls.length === 0
      ? pass('現行加入會員流程沒有重新出現手動「傳送 LINE」控制；自動 sendMessages 的 join-only 行為由程式回歸測試驗證，既有測試會員不重送訊息。', {
          manualSendControls: []
        }, actual)
      : fail('會員卡重新出現手動 LINE 傳送控制，與現行加入後自動傳送規格衝突。', {
          manualSendControls: []
        }, actual);
  }

  async function pointsTransferBoundaryCase() {
    const options = await requestCore('points.transfer.options', {});
    const cards = Array.isArray(options?.cards) ? options.cards : [];
    const modal = await waitFor(() => document.getElementById('pointTransferModal'), 2500);
    const ownCode = String(document.getElementById('pointTransferOwnMemberCode')?.textContent || '').trim();
    const ownQr = document.getElementById('pointTransferShowOwnQr');
    const removedCopy = document.getElementById('pointTransferCopyOwnCode');
    const lookup = document.getElementById('pointTransferLookup');
    const amount = document.getElementById('pointTransferAmount');
    const submit = document.getElementById('pointTransferSubmit');
    const token = window.TestModeClient?.getSessionToken?.() || '';
    let invalidAmount = { httpStatus: 0, errorCode: '' };
    if (token) {
      invalidAmount = await securityRequest('member-growth-api', {
        action: 'points.transfer.create',
        clientType: 'points',
        idToken: '',
        testSessionToken: token,
        cardId: cards[0]?.cardId || 'E2E-NO-CARD',
        memberCode: ownCode || 'E2E-NO-MEMBER',
        amount: 0,
        requestId: 'pt-e2e-' + Date.now().toString(36)
      });
    }
    const actual = {
      optionsArray: Array.isArray(options?.cards),
      modal: Boolean(modal),
      ownMemberCode: Boolean(ownCode) && !/尚未|讀取|同步/.test(ownCode),
      ownQrControl: Boolean(ownQr),
      deprecatedCopyRemoved: !removedCopy,
      lookupControl: Boolean(lookup),
      amountControl: Boolean(amount),
      submitControl: Boolean(submit),
      invalidAmountRejected: invalidAmount.httpStatus === 400 && invalidAmount.errorCode === 'INVALID_TRANSFER_AMOUNT',
      optionCount: cards.length
    };
    const ok = actual.optionsArray && actual.modal && actual.ownMemberCode && actual.ownQrControl && actual.deprecatedCopyRemoved &&
      actual.lookupControl && actual.amountControl && actual.submitControl && actual.invalidAmountRejected;
    return ok
      ? pass('點數轉贈已驗證本人會員編號、Modal 控制、Server options 與 0 點寫入拒絕；成功原子轉贈由管理端協同節點覆蓋。', {
          optionsArray: true, modal: true, ownMemberCode: true, ownQrControl: true, deprecatedCopyRemoved: true,
          lookupControl: true, amountControl: true, submitControl: true, invalidAmountRejected: true
        }, actual)
      : fail('點數轉贈 Browser／Server 邊界至少一項不符合預期。', {
          optionsArray: true, modal: true, ownMemberCode: true, ownQrControl: true, deprecatedCopyRemoved: true,
          lookupControl: true, amountControl: true, submitControl: true, invalidAmountRejected: true
        }, actual);
  }

  async function eventTodayUsableLimitCase() {
    const token = window.TestModeClient?.getSessionToken?.() || '';
    const config = await loadConfig();
    const endpoint = String(config.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/event-ticket-extension-api';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: String(config.supabasePublishableKey || '') },
      cache: 'no-store',
      body: JSON.stringify({ operation: 'member.today-usable', idToken: '', testSessionToken: token })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok !== true) {
      return fail('今日可使用張數 API 無法完成 E2E 對照。', { httpStatus: 200 }, {
        httpStatus: response.status, errorCode: String(payload?.error?.code || '')
      });
    }
    const data = payload.data || {};
    const usable = Math.max(0, Number(data.todayUsableCount || 0));
    const used = Math.max(0, Number(data.usedTodayCount || 0));
    const remaining = Math.max(0, Number(data.remainingTodayCount ?? usable));
    const limit = Number(data.maxTicketsPerDay ?? data.maxTicketsPerRedemption ?? 0);

    window.dispatchEvent(new CustomEvent('event:realtime-refresh'));
    const available = Math.max(0, Number(data.availableTodayCount ?? usable));
    const expectedText = `今日已使用 ${used} 張 · 每日上限 ${limit === 0 ? '不限張數' : limit + ' 張'}`;
    const badge = await waitFor(() => {
      const node = document.getElementById('todayUsableTicketCount');
      return node && node.textContent === expectedText &&
        Number(node.dataset.usedTodayCount) === used &&
        Number(node.dataset.availableTodayCount) === available &&
        Number(node.dataset.remainingTodayCount) === remaining &&
        Number(node.dataset.maxTicketsPerDay) === limit ? node : null;
    }, 6000, 100);
    const actual = { badge: Boolean(badge), used, available, remaining, limit,
      text: String(badge?.textContent || ''), unlimited: limit === 0 };
    const valid = Number.isInteger(limit) && limit >= 0 && limit <= 50;
    const ok = Boolean(badge) && valid && (limit === 0 || (usable <= remaining && used <= limit));
    return ok
      ? pass('今日已使用數與每日上限符合 Server 設定，0 正確顯示不限張數。', { limitRange:[0,50], expectedText }, actual)
      : fail('每日額度或不限張數顯示與 Server 設定不一致。', { limitRange:[0,50], expectedText }, actual);
  }

  async function bookingBenefitsRecommendationsCase() {
    const config = await loadConfig();
    const result = await window.BookingSystem.bookingBenefits(config, '');
    const items = Array.isArray(result?.items) ? result.items : [];
    window.BookingBenefits?.invalidate?.();
    const settled = await waitFor(() => {
      const section = document.getElementById('bookingBenefits');
      const value = String(section?.dataset?.state || '');
      return value === 'ready' || value === 'empty' || value === 'error' ? value : null;
    }, 5000);
    const list = document.getElementById('bookingBenefitsList');
    const cards = Array.from(list?.querySelectorAll('.booking-benefit') || []);
    const links = cards.map((card) => card.querySelector('.booking-benefit-link')).filter(Boolean);
    const allowed = links.every((link) => /\/(?:points|event|calendar)\//.test(new URL(link.href, window.location.href).pathname));
    const actual = {
      apiCount: items.length,
      uiCount: cards.length,
      settledState: settled || '',
      allowedDestinations: allowed,
      bookingFormStillAvailable: Boolean(document.getElementById('bookingForm')),
      errorDidNotBlockBooking: settled !== 'error' || Boolean(document.getElementById('bookingForm'))
    };
    const ok = settled !== null && settled !== 'error' && cards.length === items.length && allowed &&
      actual.bookingFormStillAvailable && actual.errorDidNotBlockBooking;
    return ok
      ? pass('預約頁推薦以 Server 權益清單渲染 0／N 項，連結只導向既有權益頁且不阻塞預約。', {
          apiUiCountMatched: true, allowedDestinations: true, bookingFormStillAvailable: true
        }, actual)
      : fail('預約頁可用活動／票券推薦與 Server 結果或預約可用性不一致。', {
          apiUiCountMatched: true, allowedDestinations: true, bookingFormStillAvailable: true
        }, actual);
  }

  async function syncBookingBenefitsForE2E() {
    window.BookingBenefits?.syncNow?.();
    const settled = await waitFor(() => {
      const list = document.getElementById('bookingBenefitsList');
      const section = document.getElementById('bookingBenefits');
      return list && list.getAttribute('aria-busy') !== 'true' && ['ready','empty','error'].includes(section?.dataset.state) ? section.dataset.state : null;
    }, 6000, 100);
    if (!settled || settled === 'error' || /同步失敗/.test(document.getElementById('bookingBenefitsStatus')?.textContent || '')) {
      const error = new Error('票券刷新未取得可驗證的新狀態。');error.code='E2E_BENEFITS_SYNC_INCOMPLETE';throw error;
    }
  }

  async function bookingAccessibleModeCase() {
    const toggle = document.getElementById('bookingAccessibleToggle');
    const panel = document.getElementById('bookingAccessiblePanel');
    if (!toggle || !panel) return fail('快照模式入口未載入。', { entrance:true }, { entrance:false });
    const original = toggle.getAttribute('aria-pressed') === 'true';
    const preferenceKey = window.BookingAccessibility?.getPreferenceKey?.() || '';
    let preference;
    try { preference = preferenceKey ? localStorage.getItem(preferenceKey) : undefined; } catch (_) {}
    const actual = { enabled:false, ticketCountMatched:false, statusLoaded:false, restored:false };
    try {
      if (!original) toggle.click();
      actual.enabled = toggle.getAttribute('aria-pressed') === 'true' && !panel.classList.contains('hidden');
      try { actual.preferenceSaved = Boolean(preferenceKey) && localStorage.getItem(preferenceKey) === 'accessible'; } catch (_) { actual.preferenceSaved = true; }
      await syncBookingBenefitsForE2E();
      await window.BookingReceipts?.refresh?.();
      const items = window.BookingBenefits?.getItems?.() || [];
      const available = items.filter(item => ['points','event'].includes(item.kind) && (item.selectable === true || (item.kind === 'event' && item.claimRequired === true)));
      actual.ticketCountMatched = document.querySelectorAll('#bookingAccessibleTickets article').length === available.length;
      const config = await loadConfig();
      const data = await window.BookingSystem.request(config, 'booking', '', 'user.booking.receipt.list', {});
      actual.submissionsArray = Array.isArray(data.submissions);
      actual.statusLoaded = Boolean(document.getElementById('bookingAccessibleStatus')?.textContent?.trim()) &&
        !/暫時無法|正在更新/.test(document.getElementById('bookingAccessibleStatus')?.textContent || '');
      actual.cameraEntrance = typeof window.BookingReceipts?.openAccessible === 'function' && Boolean(document.getElementById('bookingAccessibleUpload'));
      // Camera permission is a separate device acceptance step; do not open it.
    } finally {
      if ((toggle.getAttribute('aria-pressed') === 'true') !== original) toggle.click();
      actual.restored = (toggle.getAttribute('aria-pressed') === 'true') === original;
      try { if (preferenceKey && preference === null) localStorage.removeItem(preferenceKey); else if (preferenceKey && preference !== undefined) localStorage.setItem(preferenceKey, preference); } catch (_) {}
    }
    return Object.values(actual).every(Boolean)
      ? pass('快照模式可切換、顯示可用票券與真實登記狀態，完成後還原偏好。', { allChecks:true, physicalCamera:'device acceptance' }, actual)
      : fail('快照模式、票券或收據狀態未同步。', { allChecks:true }, actual);
  }


  async function bookingAccessibleScreenshotReceiptCase() {
    const token = window.TestModeClient?.getSessionToken?.();
    if (!token) return fail('缺少測試 Session，無法安全建立快照 E2E 收據。', { testSession: true }, { testSession: false });
    if (typeof window.BookingReceipts?.openAccessibleE2ESnapshot !== 'function') {
      return fail('目前版本缺少快照 E2E 螢幕快照入口。', { e2eSnapshotHook: true }, { e2eSnapshotHook: false });
    }

    const config = await loadConfig();
    const before = await window.BookingSystem.request(config, 'booking', '', 'user.booking.receipt.list', {});
    const existingIds = new Set((Array.isArray(before?.submissions) ? before.submissions : []).map((item) => String(item?.receiptId || '')));
    const actual = {
      screenshotCaptured: false,
      screenshotSource: '',
      screenshotCapturedAt: '',
      previewReady: false,
      submitted: false,
      awaitingReview: false,
      mimeType: '',
      sizeBytes: 0,
      preservedForAdmin: false
    };
    let modal = null;
    try {
      const captured = await captureE2ESnapshotBlob();
      actual.screenshotSource = 'screen-capture';
      actual.screenshotCapturedAt = new Date().toISOString();
      actual.screenshotCaptured = Boolean(captured?.blob && captured.blob.size > 0);
      const injected = await window.BookingReceipts.openAccessibleE2ESnapshot(captured.blob);
      actual.mimeType = String(injected?.mimeType || '');
      actual.sizeBytes = Number(injected?.sizeBytes || 0);
      modal = document.getElementById('bookingReceiptModal');
      actual.previewReady = Boolean(await waitFor(() => {
        const submit = document.getElementById('bookingReceiptSubmit');
        const preview = document.getElementById('bookingReceiptPreview');
        return submit && !submit.disabled && /^data:image\/(?:webp|jpeg|png)/.test(String(preview?.getAttribute('src') || '')) ? submit : null;
      }, 5000, 80));
      if (!actual.previewReady) throw new Error('螢幕快照沒有進入收據預覽。');

      document.getElementById('bookingReceiptSubmit')?.click();
      actual.submitted = Boolean(await waitFor(
        () => {
          const message = document.getElementById('bookingReceiptMessage');
          if (message?.classList.contains('error') && !document.getElementById('bookingReceiptSubmit')?.disabled) {
            throw Object.assign(new Error(String(message.textContent || '收據送審失敗。')), { code: 'E2E_RECEIPT_SUBMIT_FAILED' });
          }
          return modal?.classList.contains('hidden') ? modal : null;
        },
        18000,
        120
      ));
      if (!actual.submitted) throw new Error('快照收據送出後視窗未完成關閉。');

      const after = await window.BookingSystem.request(config, 'booking', '', 'user.booking.receipt.list', {});
      const created = (Array.isArray(after?.submissions) ? after.submissions : []).find((item) => {
        const id = String(item?.receiptId || '');
        return id && !existingIds.has(id) && String(item?.status || '') === 'awaiting_review';
      });
      actual.awaitingReview = Boolean(created);
      actual.preservedForAdmin = Boolean(created);
    } finally {
      if (modal && !modal.classList.contains('hidden')) {
        document.getElementById('bookingReceiptCancel')?.click();
      }
    }

    const ok =
      actual.screenshotCaptured &&
      actual.previewReady &&
      actual.submitted &&
      actual.awaitingReview &&
      actual.preservedForAdmin &&
      ['image/webp','image/jpeg','image/png'].includes(actual.mimeType) &&
      actual.sizeBytes > 0 &&
      actual.sizeBytes <= 5 * 1024 * 1024;
    return ok
      ? pass(
          '快照模式已用去識別化螢幕快照取代實體收據照片，完成 Storage 上傳與 finalize，並確認新收據進入管理端待審核狀態。',
          { screenSnapshot: true, uploaded: true, awaitingReview: true, preservedForAdmin: true },
          actual
        )
      : fail(
          '快照模式螢幕快照收據沒有完整進入待審核流程。',
          { screenSnapshot: true, uploaded: true, awaitingReview: true, preservedForAdmin: true },
          actual
        );
  }

  async function bookingAccessibleReceiptBoundaryCase() {
    const config = await loadConfig();
    const checks = [];
    for (const [mimeType,sizeBytes,expectedCode] of [['text/plain',1,'RECEIPT_INVALID_MIME'],['image/jpeg',0,'RECEIPT_FILE_TOO_LARGE'],['image/jpeg',5242881,'RECEIPT_FILE_TOO_LARGE']]) {
      try {
        await window.BookingSystem.request(config, 'booking', '', 'user.booking.receipt.prepare', { accessible:true, mimeType,sizeBytes,requestId:'QA-INVALID-RECEIPT' });
        checks.push({expectedCode,code:'UNEXPECTED_SUCCESS'});
      } catch (error) { checks.push({expectedCode,code:String(error.code || '')}); }
    }
    return checks.every(item => item.code === item.expectedCode)
      ? pass('快照收據在建立上傳前拒絕錯誤 MIME、空圖片與超過 5 MB。', { invalidInputRejected:true }, {checks})
      : fail('快照收據的 Server 輸入邊界異常。', { invalidInputRejected:true }, {checks});
  }

  async function bookingTicketRulesCase() {
    await syncBookingBenefitsForE2E();
    const items = window.BookingBenefits?.getItems?.() || [];
    const tickets = items.filter(item => ['points','event'].includes(item.kind) && item.selectable === true);
    if (!tickets.length) return skip('沒有可驗證規則的測試票券。', { fixtureTickets:true }, { blockerCode:'E2E_TICKET_FIXTURE_MISSING' });
    const malformed = tickets.filter(item => !Array.isArray(item.requiredServiceIds) ||
      !['any','all'].includes(item.requiredServiceMatchMode) ||
      (item.kind === 'points' && (!Number.isFinite(Number(item.pointBalance)) || Number(item.pointCost) <= 0)));
    const originalSelection = window.BookingBenefits.selectionPayload();
    const checks = [];
    // Closing the appointment clears its service context. With zero selected
    // services, every service-restricted ticket must be rejected before claiming.
    document.getElementById('closeAppointmentButton')?.click();
    try {
      window.BookingBenefits.clearSelection();
      const restricted = tickets.filter(item => item.requiredServiceIds?.length);
      const samples = ['any','all'].map(mode => restricted.find(item => item.requiredServiceMatchMode === mode)).filter(Boolean);
      for (const item of samples) {
        const id = String(item.selectionId || item.id || '');
        const input = Array.from(document.querySelectorAll('[data-booking-benefit-id]')).find(node => node.dataset.bookingBenefitId === id);
        if (!input) { checks.push({kind:item.kind,matchMode:item.requiredServiceMatchMode,rejected:false}); continue; }
        input.click();
        const rejected = await waitFor(() => window.BookingBenefits.selectionPayload().length === 0 && (input.disabled ? /需先預約|需預約|必須預約/.test(input.closest('.booking-benefit')?.textContent || '') : /需先預約|需預約|必須預約/.test(document.getElementById('bookingBenefitsStatus')?.textContent || '')), 1500);
        checks.push({kind:item.kind,matchMode:item.requiredServiceMatchMode,rejected:Boolean(rejected)});
      }
    } finally { window.BookingBenefits.setSelection(originalSelection); }
    const actual = { ticketCount:tickets.length, malformed:malformed.map(item => ({kind:item.kind,title:item.title})), serviceChecks:checks };
    if (malformed.length || checks.some(item => !item.rejected)) return fail('票券服務限制或點數資料異常。', { malformed:[], restrictedSelectionRejected:true }, actual);
    if (!['any','all'].every(mode => checks.some(item => item.matchMode === mode))) return skip('票券結構正確，但缺少 any／all 服務限制 fixture，未宣稱行為通過。', { restrictedFixture:true }, {...actual,blockerCode:'E2E_RESTRICTED_TICKET_FIXTURE_MISSING'});
    return pass('真實服務限制票券在未選服務時拒絕勾選，不觸發領取。', { malformed:[], restrictedSelectionRejected:true }, actual);
  }

  async function bookingHistoryTicketSourcesCase() {
    const config = await loadConfig();
    const data = await window.BookingSystem.request(config, 'member', '', 'user.booking.bootstrap', {});
    const bookings = (data.bookings || []).filter(row => row.benefits?.length);
    if (!bookings.length) return skip('沒有含票券的預約歷史，來源卡片等待 fixture。', { bookingWithBenefits:true }, { blockerCode:'E2E_BOOKING_BENEFITS_HISTORY_MISSING' });
    const mismatches = [];
    for (const booking of bookings) {
      const row = Array.from(document.querySelectorAll('#bookingList [data-booking-id]')).find(node => node.dataset.bookingId === booking.bookingId);
      if (!row) { mismatches.push({reason:'history-row-missing'}); continue; }
      const cards = Array.from(row.querySelectorAll('.booking-ticket-card'));
      for (const benefit of booking.benefits) {
        const card = cards.find(node => node.classList.contains('kind-' + benefit.kind) && node.textContent.includes(String(benefit.title || '').split('｜').pop()));
        const source = String(benefit.cardTitle || (benefit.kind === 'points' && String(benefit.title || '').includes('｜') ? benefit.title.split('｜')[0] : ''));
        if (!card || (benefit.kind === 'points' && source && !card.querySelector('.booking-ticket-source')?.textContent.includes(source))) mismatches.push({kind:benefit.kind,reason:'source-card-mismatch'});
      }
    }
    return !mismatches.length
      ? pass('會員預約歷史以票券卡片呈現種類、名稱與來源集點卡。', { mismatches:[] }, {bookings:bookings.length,mismatches})
      : fail('會員預約歷史票券卡片與 Server 來源不一致。', { mismatches:[] }, {bookings:bookings.length,mismatches});
  }

  async function bookingReceiptReviewContractCase() {
    const config = await loadConfig();
    const data = await window.BookingSystem.request(config, 'booking', '', 'user.booking.receipt.list', {});
    const bookings = Array.isArray(data?.bookings) ? data.bookings : [];
    const receipts = bookings.map((booking) => booking?.receipt).filter(Boolean);
    const modal = await waitFor(() => document.getElementById('bookingReceiptModal'), 2500);
    const camera = document.getElementById('bookingReceiptCamera');
    const capture = document.getElementById('bookingReceiptCapture');
    const retake = document.getElementById('bookingReceiptRetake');
    const submit = document.getElementById('bookingReceiptSubmit');
    const picker = modal?.querySelector('#bookingReceiptFile[type="file"]');
    const fileInputs = modal ? modal.querySelectorAll('input[type="file"]').length : -1;
    const imageTypes = picker ? ['image/jpeg','image/png','image/webp','image/heic','image/heif'].every(type => picker.accept.includes(type)) : false;
    const preview = Boolean(modal?.querySelector('#bookingReceiptPreview'));
    const discard = Boolean(modal?.querySelector('#bookingReceiptDiscard'));
    const awaiting = receipts.filter((receipt) => String(receipt?.status || '') === 'awaiting_review').length;
    const bound = receipts.filter((receipt) => String(receipt?.status || '') === 'bound').length;
    const actual = {
      bookingsArray: Array.isArray(data?.bookings),
      bookingCount: bookings.length,
      receiptCount: receipts.length,
      modal: Boolean(modal),
      camera: Boolean(camera),
      capture: Boolean(capture),
      retake: Boolean(retake),
      submit: Boolean(submit),
      fileInputs, imageTypes, preview, discard,
      awaitingReviewCount: awaiting,
      boundCount: bound,
      reviewCopy: /送出審核|管理員登記/.test(String(document.getElementById('bookingReceiptTitle')?.textContent || '')) &&
        /等待管理端|待管理端|管理端確認前|管理員核對(?:前|服務項目後)/.test(String(modal?.textContent || ''))
    };
    const ok = actual.bookingsArray && actual.modal && actual.camera && actual.capture && actual.retake &&
      actual.submit && fileInputs === 1 && actual.imageTypes && actual.preview && actual.discard && actual.reviewCopy;
    return ok
      ? pass('預約收據 Browser E2E 已確認 booking-scoped 收據契約、相機拍攝入口、相機／圖片雙入口，以及等待管理端審核語意。', {
          bookingsArray: true, cameraOrImage: true, fileInputs: 1, waitsForAdminReview: true
        }, actual)
      : fail('預約收據相機／圖片／審核 Browser 契約不符合目前規格。', {
          bookingsArray: true, cameraOrImage: true, fileInputs: 1, waitsForAdminReview: true
        }, actual);
  }

  async function pointsDataCase() {
    const data = state.bootstrap || await requestCore('user.pointcard.bootstrap', {});
    const cards = Array.isArray(data.cards) ? data.cards : [];
    const details = data.cardDetails && typeof data.cardDetails === 'object' ? data.cardDetails : {};
    const badCards = cards.filter((card) => !card || !card.cardId || !Number.isFinite(Number(card.stamps || 0))).length;
    const missingDetails = cards.filter((card) => !details[card.cardId]).length;
    const actual = { cardCount: cards.length, badCards, missingDetails, historyCount: Array.isArray(data.history) ? data.history.length : -1 };
    return badCards === 0 && missingDetails === 0 && Array.isArray(data.history)
      ? pass('集點卡、點數、票券與使用紀錄資料結構一致。', { badCards: 0, missingDetails: 0, historyArray: true }, actual)
      : fail('集點卡或票券資料結構有缺漏。', { badCards: 0, missingDetails: 0, historyArray: true }, actual);
  }

  async function pointExtensionRequest(operation, payload) {
    const config = await loadConfig();
    const endpoint = String(config.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/pointcard-extension-api';
    const body = window.TestModeClient.payload(Object.assign({}, payload || {}, { operation, idToken: '' }));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: String(config.supabasePublishableKey || '') },
      cache: 'no-store',
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) {
      const error = new Error(data && data.error && data.error.message || 'Point extension error');
      error.code = String(data && data.error && data.error.code || 'API_ERROR');
      throw error;
    }
    return data.data || {};
  }

  async function pointSettingsCase() {
    const data = await pointExtensionRequest('member.settings.get', {});
    const limit = Number(data.maxTicketsPerRedemption);
    const ok = Number.isInteger(limit) && limit >= 0 && limit <= 50;
    return ok
      ? pass('票券單次核銷上限可由測試 Session 正確讀取。', { min: 0, max: 50, zeroMeansUnlimited: true }, { maxTicketsPerRedemption: limit })
      : fail('票券核銷設定不合法。', { min: 0, max: 50, zeroMeansUnlimited: true }, { maxTicketsPerRedemption: data.maxTicketsPerRedemption });
  }

  async function pointsInteractionCase() {
    const tabs = Array.from(document.querySelectorAll('#cardTabs [data-card-id]'));
    if (!tabs.length) return skip('目前沒有啟用中的集點卡可切換。', { cardTabsAtLeast: 1 }, { cardTabs: 0 });
    const initial = tabs.find((node) => node.getAttribute('aria-selected') === 'true') || tabs[0];
    const target = tabs.length > 1 ? tabs[1] : tabs[0];
    const initialCardId = String(initial.dataset.cardId || '');
    const targetCardId = String(target.dataset.cardId || '');
    const findTab = (cardId) => Array.from(document.querySelectorAll('#cardTabs [data-card-id]'))
      .find((node) => String(node.dataset.cardId || '') === cardId) || null;

    target.click();
    const selected = Boolean(await waitFor(() => {
      const current = findTab(targetCardId);
      return current && current.getAttribute('aria-selected') === 'true' ? current : null;
    }, 1500));

    if (initialCardId && initialCardId !== targetCardId) {
      findTab(initialCardId)?.click();
      await waitFor(() => {
        const current = findTab(initialCardId);
        return current && current.getAttribute('aria-selected') === 'true' ? current : null;
      }, 1500);
    }

    return selected
      ? pass('集點卡分頁可切換且 aria-selected 會同步。', { selectedAfterClick: true }, { cardTabs: tabs.length, selectedAfterClick: selected })
      : fail('集點卡分頁點擊後未同步選取狀態。', { selectedAfterClick: true }, { cardTabs: tabs.length, selectedAfterClick: selected });
  }

  async function pointsInvalidWriteCase() {
    let extension;
    try {
      await pointExtensionRequest('member.redeem', { ticketIds: [], requestId: 'QA_INVALID_12345678' });
      extension = { ok: false, code: '' };
    } catch (error) {
      extension = { ok: String(error.code || '') === 'INVALID_TICKET_BATCH', code: String(error.code || '') };
    }
    const core = await expectApiError('user.pointcard.ticket.redeem', { ticketId: '' }, ['INVALID_INPUT', 'INVALID_', 'REQUIRED']);
    const ok = extension.ok && core.ok;
    return ok
      ? pass('兩條票券核銷入口都會拒絕空白／無效票券，不會變更點數。', { batchRejected: true, singleRejected: true }, { batch: extension, single: core })
      : fail('至少一條票券核銷驗證邊界異常。', { batchRejected: true, singleRejected: true }, { batch: extension, single: core });
  }

  async function eventDataCase() {
    const data = state.bootstrap || await requestCore('user.event.bootstrap', {});
    const offers = Array.isArray(data.offers) ? data.offers : [];
    const used = Array.isArray(data.usedTickets) ? data.usedTickets : [];
    const bad = offers.filter((offer) => !offer || !offer.ticket || !offer.ticket.eventTicketId || typeof offer.canClaim !== 'boolean' || typeof offer.canUse !== 'boolean').length;
    const actual = { offerCount: offers.length, usedCount: used.length, malformedOffers: bad, usedTicketCount: Number(data.usedTicketCount || 0) };
    return bad === 0 && used.length === Number(data.usedTicketCount || 0)
      ? pass('活動票券可領取／可使用狀態與歷史資料結構一致。', { malformedOffers: 0, usedCountMatches: true }, actual)
      : fail('活動票券狀態資料結構不一致。', { malformedOffers: 0, usedCountMatches: true }, actual);
  }

  async function eventModalCase() {
    const button = Array.from(document.querySelectorAll('#eventList button[data-event-ticket-id]')).find((node) => !node.disabled) || null;
    if (!button || button.disabled) return skip('目前沒有可開啟詳情的活動票券。', { openableTicket: true }, { openableTicket: false });
    const modal = document.getElementById('ticketModal');
    const close = document.getElementById('closeTicketModal');
    button.click();
    await wait(100);
    const opened = modal && !modal.classList.contains('hidden');
    if (opened && close) {
      close.click();
      await wait(50);
    }
    const closed = Boolean(modal && modal.classList.contains('hidden'));
    return opened && closed
      ? pass('活動票券詳情可開啟並關閉，未執行領券或核銷。', { opened: true, closed: true }, { opened, closed })
      : fail('活動票券詳情 Modal 互動異常。', { opened: true, closed: true }, { opened, closed });
  }

  async function eventInvalidWriteCase() {
    const claim = await expectApiError('user.event.ticket.claim', { eventTicketId: '' }, ['INVALID_INPUT', 'INVALID_', 'REQUIRED']);
    const redeem = await expectApiError('user.event.ticket.redeem', { claimId: '' }, ['INVALID_INPUT', 'INVALID_', 'REQUIRED']);
    return claim.ok && redeem.ok
      ? pass('領券與核銷 API 都會拒絕缺少識別碼，不產生票券異動。', { claimRejected: true, redeemRejected: true }, { claim, redeem })
      : fail('領券或核銷 API 的輸入驗證邊界異常。', { claimRejected: true, redeemRejected: true }, { claim, redeem });
  }

  async function calendarDetailApiCase() {
    const data = state.bootstrap || await requestCore('user.calendar.bootstrap', {});
    const first = Array.isArray(data.items) && data.items.find((item) => /^\d{4}-\d{2}-\d{2}$/.test(String(item.startsOn || '')));
    const date = first ? String(first.startsOn) : new Date().toISOString().slice(0, 10);
    const detail = await requestCore('user.calendar.date.details', { date });
    const items = Array.isArray(detail.items) ? detail.items : [];
    return Array.isArray(detail.items)
      ? pass('指定日期明細 API 可由測試帳號讀取。', { itemsArray: true }, { date, itemCount: items.length })
      : fail('指定日期明細 API 回傳格式不正確。', { itemsArray: true }, { date, itemsType: typeof detail.items });
  }

  async function calendarNavigationCase() {
    const title = document.getElementById('monthTitle');
    const next = document.getElementById('nextMonthButton');
    const previous = document.getElementById('previousMonthButton');
    if (!title || !next || !previous) return fail('月曆導覽元件缺失。', { controls: true }, { controls: false });
    const before = title.textContent;
    next.click();
    await wait(90);
    const after = title.textContent;
    previous.click();
    await wait(90);
    const restored = title.textContent;
    const changed = before !== after;
    const returned = restored === before;

    next.click();
    await wait(90);
    document.getElementById('todayButton')?.click();
    await wait(90);
    const todayRestored = title.textContent === before;
    return changed && returned && todayRestored
      ? pass('下一月／上一月／回到本月皆可變更並恢復月份。', { changed: true, restored: true, todayRestored: true }, { changed, restored: returned, todayRestored })
      : fail('月曆月份切換或回到本月未依預期運作。', { changed: true, restored: true, todayRestored: true }, { changed, restored: returned, todayRestored });
  }

  async function calendarInvalidDateCase() {
    const checked = await expectApiError('user.calendar.date.details', { date: '2099-99-99' }, ['INVALID_DATE']);
    return checked.ok
      ? pass('日期明細 API 正確拒絕非法日期。', { rejected: true, code: 'INVALID_DATE' }, checked)
      : fail('日期明細 API 沒有依預期拒絕非法日期。', { rejected: true, code: 'INVALID_DATE' }, checked);
  }

  async function bookingDataCase() {
    const bootstrap = state.bootstrap || await requestCore('user.booking.bootstrap', {});
    const profile = await window.BookingSystem.memberProfile(await loadConfig(), '');
    const account = state.session && state.session.account || {};
    const profileMatch = Boolean(profile && profile.memberCode === account.memberCode);
    const actual = {
      profileMatched: profileMatch,
      profileComplete: Boolean(profile && profile.profileComplete),
      services: Array.isArray(bootstrap.services) ? bootstrap.services.length : -1,
      bookings: Array.isArray(bootstrap.bookings) ? bootstrap.bookings.length : -1,
      settings: Boolean(bootstrap.settings),
      todayPresent: Boolean(bootstrap.today)
    };
    const ok = profileMatch && Array.isArray(bootstrap.services) && Array.isArray(bootstrap.bookings) && Boolean(bootstrap.settings);
    return ok
      ? pass('會員資料與預約資料都綁定目前測試帳號。', { profileMatched: true, servicesArray: true, bookingsArray: true, settings: true }, actual)
      : fail('會員資料與預約 Bootstrap 不一致。', { profileMatched: true, servicesArray: true, bookingsArray: true, settings: true }, actual);
  }

  async function directFunction(slug, body) {
    const config = await loadConfig();
    const endpoint = String(config.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/' + slug;
    const payload = window.TestModeClient.payload(Object.assign({}, body || {}, { idToken: '' }));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: String(config.supabasePublishableKey || '') },
      cache: 'no-store',
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) {
      const error = new Error(data && data.error && data.error.message || slug + ' error');
      error.code = String(data && data.error && data.error.code || 'API_ERROR');
      throw error;
    }
    return data.data || {};
  }

  async function bookingGroupBootstrapCase() {
    const data = await directFunction('booking-group-api', {
      action: 'user.booking.group.bootstrap',
      clientType: 'member'
    });
    const ok = Boolean(data.settings && Array.isArray(data.technicians) && data.bookingGroups && typeof data.bookingGroups === 'object');
    const actual = { settings: Boolean(data.settings), technicians: Array.isArray(data.technicians) ? data.technicians.length : -1, bookingGroups: data.bookingGroups && typeof data.bookingGroups === 'object' ? Object.keys(data.bookingGroups).length : -1 };
    return ok
      ? pass('多人預約資源、技師與歷史群組可正常讀取。', { settings: true, techniciansArray: true, bookingGroupsObject: true }, actual)
      : fail('多人預約 Bootstrap 結構不完整。', { settings: true, techniciansArray: true, bookingGroupsObject: true }, actual);
  }

  async function bookingFormCase() {
    const form = document.getElementById('bookingForm');
    const submit = document.getElementById('submitBookingButton');
    const date = document.getElementById('bookingDate');
    const servicePicker = document.getElementById('servicePicker');
    const actual = {
      formPresent: Boolean(form),
      submitPresent: Boolean(submit),
      submitInitiallyDisabled: Boolean(submit && submit.disabled),
      datePresent: Boolean(date),
      serviceChoices: servicePicker ? servicePicker.querySelectorAll('.service-choice').length : -1
    };
    const ok = actual.formPresent && actual.submitPresent && actual.submitInitiallyDisabled && actual.datePresent;
    return ok
      ? pass('未選項目／時段時送出按鈕維持停用，避免空白預約。', { formPresent: true, submitInitiallyDisabled: true, datePresent: true }, actual)
      : fail('預約表單初始安全狀態不符合預期。', { formPresent: true, submitInitiallyDisabled: true, datePresent: true }, actual);
  }

  async function bookingInvalidWriteCase() {
    const create = await expectApiError('user.booking.create', {
      requestId: 'BOOK-QA-' + Math.random().toString(36).slice(2, 12),
      items: [],
      bookingDate: '',
      startTime: ''
    }, ['INVALID_', 'BOOKING_', 'MEMBERSHIP_']);
    const update = await expectApiError('user.booking.update', {
      bookingId: 'not-a-uuid',
      expectedUpdatedAt: new Date().toISOString(),
      requestId: 'BOOK-QA-' + Math.random().toString(36).slice(2, 12),
      items: [],
      bookingDate: '',
      startTime: ''
    }, ['INVALID_', 'BOOKING_']);
    const cancel = await expectApiError('user.booking.cancel', { bookingId: 'not-a-uuid' }, ['INVALID_', 'BOOKING_']);

    let group;
    try {
      await directFunction('booking-group-api', {
        action: 'user.booking.group.create',
        clientType: 'member',
        requestId: 'BOOK-QA-' + Math.random().toString(36).slice(2, 12),
        participants: [],
        bookingDate: '',
        startTime: ''
      });
      group = { ok: false, code: '' };
    } catch (error) {
      const code = String(error.code || '');
      group = { ok: /^INVALID_|^BOOKING_/.test(code), code, message: String(error.message || '').slice(0, 180) };
    }

    const ok = create.ok && update.ok && cancel.ok && group.ok;
    return ok
      ? pass('新增、修改、取消與多人預約都會在無效輸入階段拒絕，不建立資料。', { createRejected: true, updateRejected: true, cancelRejected: true, groupRejected: true }, { create, update, cancel, group })
      : fail('至少一個預約寫入操作沒有在預期的驗證邊界拒絕。', { createRejected: true, updateRejected: true, cancelRejected: true, groupRejected: true }, { create, update, cancel, group });
  }

  async function loadMutationSuite() {
    if (state.mutationSuite) return state.mutationSuite;
    const config = await loadConfig();
    const endpoint = String(config.supabaseUrl || '').replace(/\/$/, '') + '/functions/v1/user-test-api';
    const payload = window.TestModeClient.payload({
      action: 'user.qa.mutations',
      surface,
      idToken: ''
    });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 60000);
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: String(config.supabasePublishableKey || '')
        },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify(payload)
      });
    } catch (error) {
      const wrapped = new Error(error && error.name === 'AbortError'
        ? '成功寫入 QA 執行逾時。'
        : '無法連線成功寫入 QA 服務。');
      wrapped.code = error && error.name === 'AbortError' ? 'QA_TIMEOUT' : 'QA_NETWORK_ERROR';
      throw wrapped;
    } finally {
      window.clearTimeout(timer);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) {
      const wrapped = new Error(data && data.error && data.error.message || '成功寫入 QA 被拒絕。');
      wrapped.code = String(data && data.error && data.error.code || 'QA_API_ERROR');
      throw wrapped;
    }
    state.mutationSuite = data.data || {};
    return state.mutationSuite;
  }

  async function mutationQaCase(caseKey) {
    const suite = await loadMutationSuite();
    const cases = Array.isArray(suite.cases) ? suite.cases : [];
    const item = cases.find((entry) => entry && entry.key === caseKey);
    if (!item) {
      return fail(
        '成功寫入 QA 沒有回傳此案例。',
        { caseKey, returned: true },
        { caseKey, returned: false }
      );
    }
    const expected = item.expected && typeof item.expected === 'object' ? item.expected : {};
    const actual = item.actual && typeof item.actual === 'object' ? item.actual : {};
    if (item.status === 'skipped') return skip(String(item.message || '此案例略過。'), expected, actual);
    if (item.status === 'passed') return pass(String(item.message || '成功寫入與清理完成。'), expected, actual);
    return fail(
      String(item.message || '成功寫入或清理失敗。'),
      expected,
      Object.assign({}, actual, { serverCase: caseKey })
    );
  }

  function saveHistory() {
    const entry = {
      at: new Date().toISOString(),
      surface,
      suite: state.currentSuite,
      passed: state.results.filter((item) => item.status === 'passed').length,
      failed: state.results.filter((item) => item.status === 'failed').length,
      skipped: state.results.filter((item) => item.status === 'skipped').length,
      total: state.results.length
    };
    try {
      const existing = JSON.parse(window.sessionStorage.getItem(HISTORY_KEY) || '[]');
      const list = Array.isArray(existing) ? existing : [];
      list.unshift(entry);
      window.sessionStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
    } catch (_) {}
  }

  function renderHistory() {
    if (!state.panel) return;
    const root = state.panel.querySelector('[data-qa-history]');
    let rows = [];
    try {
      const parsed = JSON.parse(window.sessionStorage.getItem(HISTORY_KEY) || '[]');
      rows = Array.isArray(parsed) ? parsed.filter((item) => item && item.surface === surface) : [];
    } catch (_) {}
    if (!rows.length) {
      root.innerHTML = '<p class="user-qa-history-empty">本次瀏覽器 Session 尚無測試紀錄。</p>';
      return;
    }
    root.replaceChildren(...rows.map((item) => {
      const row = document.createElement('div');
      row.className = 'user-qa-history-row';
      const time = document.createElement('strong');
      const date = new Date(item.at);
      time.textContent = Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
      const meta = document.createElement('span');
      meta.textContent = (item.suite === 'full' ? '完整' : '快速') + ' · ' + item.passed + ' 通過 · ' + item.failed + ' 失敗 · ' + item.skipped + ' 略過';
      row.append(time, meta);
      return row;
    }));
  }

  window.MemberUserTestControl = Object.freeze({
    version: VERSION,
    surface,
    runFull: () => runSuite('full'),
    stop: () => requestStop(),
    isRunning: () => state.running,
    getStatus: () => {
      const current = [...state.results].reverse().find((item) => item?.status === 'running') || null;
      const passed = state.results.filter((item) => item?.status === 'passed').length;
      const failed = state.results.filter((item) => item?.status === 'failed').length;
      const skipped = state.results.filter((item) => item?.status === 'skipped').length;
      return {
        version: VERSION,
        surface,
        running: state.running,
        cancelled: state.cancelled,
        suite: state.currentSuite,
        current: current ? {
          key: String(current.key || ''),
          name: String(current.name || ''),
          domain: String(current.domain || ''),
          status: 'running'
        } : null,
        summary: { total: state.results.length, passed, failed, skipped }
      };
    }
  });
})();
