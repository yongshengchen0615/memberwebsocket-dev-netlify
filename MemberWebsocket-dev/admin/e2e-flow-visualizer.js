(() => {
  'use strict';

  const VERSION = '2026-10-06.1';
  const MODULES = Object.freeze({
    member: '會員卡',
    points: '集點卡',
    event: '活動票券',
    calendar: '營運日曆',
    integration: '整合中心',
    booking: '預約'
  });
  const MODULE_ORDER = Object.keys(MODULES);
  const CLIENT_MODULES = MODULE_ORDER.filter((key) => key !== 'integration');
  const MODULE_EVIDENCE = Object.freeze({
    member: 'ADMIN_TEST_MEMBER_PROFILE_EDIT',
    points: 'ADMIN_POINT_CARD_CRUD',
    event: 'ADMIN_EVENT_TICKET_CRUD',
    calendar: 'ADMIN_CALENDAR_CRUD',
    integration: 'ADMIN_INTEGRATION_CENTER',
    booking: 'ADMIN_BOOKING_CONTROLS'
  });
  const STAGES = Object.freeze([
    ['prepare', '準備', '維護模式、Session、測試資料'],
    ['backend', '後端 QA', '共用安全與資料一致性'],
    ['admin-preflight', '管理端前置', '權限、導覽、預約前置'],
    ['client', '用戶端模組', '會員／集點／票券／日曆／預約'],
    ['admin', '管理端完整', 'CRUD、設定、審核、核銷'],
    ['sync', '跨端同步', 'Realtime、紀錄回寫、終態'],
    ['coverage', '覆蓋驗證', '勾選模組執行證據 Gate'],
    ['complete', '完成', '結果保存與可重播紀錄']
  ]);

  const nativeOpen = typeof window.open === 'function' ? window.open.bind(window) : null;
  const trackedWindows = [];
  let lastSelectedModules = [];
  let timer = 0;
  let mounted = false;

  if (nativeOpen) {
    window.open = function () {
      const args = Array.from(arguments);
      const child = nativeOpen.apply(window, args);
      if (child) {
        trackedWindows.push({
          child,
          name: String(args[1] || ''),
          openedAt: Date.now()
        });
      }
      return child;
    };
  }

  function safeCall(fn, fallback) {
    try {
      const value = fn();
      return value == null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]);
  }

  function normalizeModules(value) {
    const source = Array.isArray(value) ? value : [];
    return MODULE_ORDER.filter((key) => source.includes(key));
  }

  function checkedModules() {
    return normalizeModules(Array.from(document.querySelectorAll('[data-e2e-module]:checked')).map((input) => String(input.dataset.e2eModule || '')));
  }

  function rememberSelectedModules() {
    const selected = checkedModules();
    if (selected.length) lastSelectedModules = selected;
  }

  function moduleFromText(key, domain, explicitSurface) {
    const surface = String(explicitSurface || '').toLowerCase();
    if (MODULES[surface]) return surface;
    const joined = (String(key || '') + ' ' + String(domain || '')).toUpperCase();
    if (joined.includes('INTEGRATION')) return 'integration';
    if (joined.includes('BOOKING')) return 'booking';
    if (joined.includes('CALENDAR')) return 'calendar';
    if (joined.includes('EVENT') || joined.includes('BIRTHDAY') || joined.includes('FIXED_TICKET')) return 'event';
    if (joined.includes('POINT') || joined.includes('CARD') || joined.includes('TICKET')) return 'points';
    if (joined.includes('MEMBER') || joined.includes('TIER') || joined.includes('TERMS')) return 'member';
    return '';
  }

  function sideFromRow(row) {
    const key = String(row?.key || '');
    const domain = String(row?.domain || '');
    if (key === 'UNIFIED_SERVER_FULL_E2E' || domain.includes('Backend')) return '後端';
    if (/^PAIRED_\d+_(MEMBER|POINTS|EVENT|CALENDAR|BOOKING)$/.test(key)) return '用戶端';
    if (/Audit|Realtime|Terminal|Risk Scan/.test(domain) || /_ADMIN_RECORD_SYNC|_TERMINAL|_REALTIME|_RISK_SCAN/.test(key)) return '跨端';
    if (/Orchestration/.test(domain)) return '系統協調';
    return '管理端';
  }

  function flowFromRow(row) {
    const key = String(row?.key || '');
    const domain = String(row?.domain || '');
    if (key === 'UNIFIED_SERVER_FULL_E2E') return '後端共用安全 QA';
    if (/ACCESSIBLE/.test(key)) return '快照預約審核';
    if (/BOOKING/.test(key) && /CONFIRM/.test(key)) return '預約確認';
    if (/BOOKING/.test(key) && /COMPLETE/.test(key)) return '預約完成與核銷';
    if (/CANCELLATION|CANCEL/.test(key)) return '取消／改約處理';
    if (/RECEIPT/.test(key)) return '收據快照';
    if (/REALTIME/.test(key)) return 'Realtime 同步';
    if (/CRUD/.test(key)) return 'CRUD 真人操作';
    if (/COVERAGE/.test(key)) return '覆蓋驗證';
    if (/SYNC/.test(key)) return '跨端同步';
    return domain || 'E2E 流程';
  }

  function backendActivity() {
    const status = safeCall(() => window.MemberAdminTestControl?.getStatus?.(), null);
    const cases = Array.isArray(status?.detail?.cases) ? status.detail.cases : [];
    const current = cases.find((item) => item?.status === 'running');
    if (!current) return null;
    const module = moduleFromText(current.key, current.domain, '');
    return {
      side: '後端',
      module,
      flow: '後端共用安全 QA',
      feature: String(current.name || current.key || '後端案例'),
      key: String(current.key || ''),
      domain: String(current.domain || ''),
      source: 'backend'
    };
  }

  function childActivities() {
    const result = [];
    for (const item of trackedWindows) {
      const child = item.child;
      if (!child || safeCall(() => child.closed, true)) continue;
      const status = safeCall(() => child.MemberUserTestControl?.getStatus?.(), null);
      if (!status?.running || !status?.current) continue;
      result.push({
        side: '用戶端',
        module: String(status.surface || ''),
        flow: String(status.current.domain || '用戶端真人 E2E'),
        feature: String(status.current.name || status.current.key || '用戶端案例'),
        key: String(status.current.key || ''),
        domain: String(status.current.domain || ''),
        source: 'client'
      });
    }
    return result;
  }

  function adminActivities(status) {
    const rows = Array.isArray(status?.results) ? status.results : [];
    return rows.filter((row) => row?.status === 'running' && row?.key !== 'UNIFIED_SERVER_FULL_E2E').map((row) => ({
      side: sideFromRow(row),
      module: moduleFromText(row.key, row.domain, ''),
      flow: flowFromRow(row),
      feature: String(row.name || row.key || '管理端案例'),
      key: String(row.key || ''),
      domain: String(row.domain || ''),
      source: 'admin'
    }));
  }

  function currentActivities(status) {
    const activities = [];
    const backend = backendActivity();
    if (backend) activities.push(backend);
    activities.push(...childActivities());
    activities.push(...adminActivities(status));
    return activities;
  }

  function stageForActivity(activity) {
    if (!activity) return 'prepare';
    if (activity.side === '後端') return 'backend';
    if (activity.source === 'client') return 'client';
    if (activity.key === 'PAIRED_HUMAN_INTERACTION_COVERAGE' || /Coverage/.test(activity.domain)) return 'coverage';
    if (/_ADMIN_RECORD_SYNC/.test(activity.key) || activity.side === '跨端') return 'sync';
    if (['ADMIN_AUTH_READY', 'ADMIN_PRIMARY_NAVIGATION', 'ADMIN_BOOKING_CONTROLS', 'ADMIN_BOOKING_SHARED_SETTINGS'].includes(activity.key)) return 'admin-preflight';
    if (activity.side === '管理端') return 'admin';
    return 'prepare';
  }

  function resultStatus(rows, key) {
    return String([...rows].reverse().find((row) => row?.key === key)?.status || '');
  }

  function stageStates(status, activities) {
    const rows = Array.isArray(status?.results) ? status.results : [];
    const running = Boolean(status?.running);
    const coverage = resultStatus(rows, 'PAIRED_HUMAN_INTERACTION_COVERAGE');
    const backend = resultStatus(rows, 'UNIFIED_SERVER_FULL_E2E');
    const hasClient = rows.some((row) => /^PAIRED_\d+_(MEMBER|POINTS|EVENT|CALENDAR|BOOKING)$/.test(String(row?.key || '')));
    const hasAdmin = rows.some((row) => /^ADMIN_/.test(String(row?.key || '')) && !['ADMIN_AUTH_READY', 'ADMIN_PRIMARY_NAVIGATION'].includes(String(row?.key || '')));
    const hasSync = rows.some((row) => /_ADMIN_RECORD_SYNC|_REALTIME|_TERMINAL|_RISK_SCAN/.test(String(row?.key || '')));
    const activeStage = activities.length ? stageForActivity(activities[0]) : running ? 'prepare' : coverage ? 'complete' : 'prepare';
    const order = STAGES.map(([key]) => key);
    const activeIndex = order.indexOf(activeStage);
    const result = {};
    for (let index = 0; index < STAGES.length; index += 1) {
      const key = STAGES[index][0];
      result[key] = index < activeIndex ? 'passed' : index === activeIndex && running ? 'running' : 'queued';
    }
    result.prepare = rows.length || running ? 'passed' : 'queued';
    if (backend) result.backend = backend === 'failed' ? 'failed' : backend === 'running' ? 'running' : 'passed';
    if (hasClient && result.client === 'queued') result.client = 'passed';
    if (hasAdmin && result.admin === 'queued') result.admin = 'passed';
    if (hasSync && result.sync === 'queued') result.sync = 'passed';
    if (coverage) result.coverage = coverage === 'passed' ? 'passed' : coverage === 'failed' ? 'failed' : coverage === 'skipped' ? 'skipped' : 'running';
    if (!running && coverage) result.complete = coverage === 'passed' ? 'passed' : 'failed';
    return result;
  }

  function moduleState(module, selectedModules, status, activities) {
    if (!selectedModules.includes(module)) return { status: 'off', admin: '—', client: '—' };
    const rows = Array.isArray(status?.results) ? status.results : [];
    const active = activities.some((item) => item.module === module);
    const adminKey = MODULE_EVIDENCE[module];
    const adminStatus = resultStatus(rows, adminKey);
    const participants = Array.isArray(status?.participants) ? status.participants : [];
    let clientRows = [];
    if (CLIENT_MODULES.includes(module)) {
      const suffix = '_' + module.toUpperCase();
      clientRows = rows.filter((row) => /^PAIRED_\d+_/.test(String(row?.key || '')) && String(row.key || '').endsWith(suffix));
    }
    const clientFailed = clientRows.some((row) => row?.status === 'failed');
    const clientRunning = clientRows.some((row) => row?.status === 'running');
    const clientPassed = !CLIENT_MODULES.includes(module)
      ? true
      : participants.length > 0 && clientRows.length >= participants.length && clientRows.every((row) => row?.status === 'passed');
    const coveragePassed = resultStatus(rows, 'PAIRED_HUMAN_INTERACTION_COVERAGE') === 'passed';
    const failed = adminStatus === 'failed' || clientFailed;
    const passed = coveragePassed || (adminStatus === 'passed' && clientPassed);
    return {
      status: failed ? 'failed' : active || clientRunning || adminStatus === 'running' ? 'running' : passed ? 'passed' : 'queued',
      admin: adminStatus || '等待',
      client: CLIENT_MODULES.includes(module) ? (clientPassed ? '通過' : clientFailed ? '失敗' : clientRunning ? '執行中' : '等待') : '不適用'
    };
  }

  function selectedModulesFromStatus(status) {
    const fromStatus = normalizeModules(status?.selectedModules);
    if (fromStatus.length) {
      lastSelectedModules = fromStatus;
      return fromStatus;
    }
    const checked = checkedModules();
    if (checked.length) {
      lastSelectedModules = checked;
      return checked;
    }
    return lastSelectedModules.slice();
  }

  function statusLabel(status) {
    return status === 'passed' ? '已完成'
      : status === 'failed' ? '失敗'
      : status === 'running' ? '執行中'
      : status === 'skipped' ? '略過'
      : status === 'off' ? '未勾選'
      : '等待';
  }

  function mount() {
    if (mounted || document.getElementById('e2eFlowVisualizer')) return;
    const host = document.querySelector('.test-control-center');
    const layout = host?.querySelector('.test-control-layout');
    if (!host || !layout) return;
    const section = document.createElement('section');
    section.id = 'e2eFlowVisualizer';
    section.className = 'e2e-flow-visualizer';
    section.setAttribute('aria-labelledby', 'e2eFlowVisualizerTitle');
    section.innerHTML = [
      '<div class="e2e-flow-heading">',
        '<div><span class="test-mode-eyebrow">Live execution map</span><h4 id="e2eFlowVisualizerTitle">E2E 即時流程圖</h4>',
        '<p>從開始到完成顯示目前端別、模組、流程與功能；背景 Runner 狀態會同步回此頁。</p></div>',
        '<span class="e2e-flow-live-badge" data-e2e-flow-badge>待命</span>',
      '</div>',
      '<div class="e2e-flow-selected" aria-label="本輪勾選模組"><strong>本輪模組</strong><div data-e2e-flow-selected></div></div>',
      '<ol class="e2e-flow-rail" data-e2e-flow-rail aria-label="E2E 從開始到完成流程"></ol>',
      '<section class="e2e-flow-current" aria-labelledby="e2eFlowCurrentTitle">',
        '<div class="e2e-flow-current-heading"><strong id="e2eFlowCurrentTitle">目前執行位置</strong><span data-e2e-flow-stage>尚未開始</span></div>',
        '<div class="e2e-flow-activity-list" data-e2e-flow-activities><p class="e2e-flow-empty">尚未開始 E2E。</p></div>',
      '</section>',
      '<section class="e2e-flow-module-matrix" aria-labelledby="e2eFlowModuleMatrixTitle">',
        '<div class="e2e-flow-current-heading"><strong id="e2eFlowModuleMatrixTitle">勾選模組執行證據</strong><span>管理端 + 用戶端 + 最終覆蓋 Gate</span></div>',
        '<div class="e2e-flow-module-grid" data-e2e-flow-modules></div>',
      '</section>'
    ].join('');
    host.insertBefore(section, layout);
    mounted = true;
  }

  function renderRail(root, states, activeStage) {
    root.innerHTML = STAGES.map((stage, index) => {
      const key = stage[0];
      const state = states[key] || 'queued';
      const current = key === activeStage && state === 'running';
      return '<li class="e2e-flow-step is-' + escapeHtml(state) + (current ? ' is-current' : '') + '">' +
        '<span class="e2e-flow-step-index">' + (index + 1) + '</span>' +
        '<div><strong>' + escapeHtml(stage[1]) + '</strong><small>' + escapeHtml(stage[2]) + '</small></div>' +
        '<span class="e2e-flow-step-state">' + escapeHtml(statusLabel(state)) + '</span>' +
      '</li>';
    }).join('');
  }

  function activityCard(activity, index) {
    const moduleLabel = MODULES[activity.module] || (activity.module ? activity.module : '共用／跨模組');
    return '<article class="e2e-flow-activity' + (index === 0 ? ' is-primary' : '') + '">' +
      '<div class="e2e-flow-activity-path">' +
        '<span><small>端別</small><strong>' + escapeHtml(activity.side) + '</strong></span>' +
        '<i aria-hidden="true">→</i>' +
        '<span><small>模組</small><strong>' + escapeHtml(moduleLabel) + '</strong></span>' +
        '<i aria-hidden="true">→</i>' +
        '<span><small>流程</small><strong>' + escapeHtml(activity.flow) + '</strong></span>' +
        '<i aria-hidden="true">→</i>' +
        '<span class="e2e-flow-feature"><small>功能</small><strong>' + escapeHtml(activity.feature) + '</strong></span>' +
      '</div>' +
    '</article>';
  }

  function renderActivities(root, activities, running, fallbackMessage) {
    if (!activities.length) {
      root.innerHTML = '<p class="e2e-flow-empty">' + escapeHtml(running ? (fallbackMessage || 'Runner 執行中，正在等待下一個可觀察節點。') : '尚未開始 E2E。') + '</p>';
      return;
    }
    root.innerHTML = activities.map(activityCard).join('');
  }

  function renderModules(root, selectedModules, status, activities) {
    root.innerHTML = MODULE_ORDER.map((module) => {
      const state = moduleState(module, selectedModules, status, activities);
      return '<article class="e2e-flow-module is-' + escapeHtml(state.status) + '">' +
        '<div><strong>' + escapeHtml(MODULES[module]) + '</strong><span>' + escapeHtml(statusLabel(state.status)) + '</span></div>' +
        '<small>管理端：' + escapeHtml(state.admin) + ' · 用戶端：' + escapeHtml(state.client) + '</small>' +
      '</article>';
    }).join('');
  }

  function render() {
    mount();
    const root = document.getElementById('e2eFlowVisualizer');
    if (!root) return;
    const status = safeCall(() => window.MemberAdminE2EControl?.getStatus?.(), {}) || {};
    const selectedModules = selectedModulesFromStatus(status);
    const activities = currentActivities(status);
    const states = stageStates(status, activities);
    const running = Boolean(status.running || window.MemberAdminTestControl?.isRunning?.());
    const activeStage = activities.length ? stageForActivity(activities[0]) : running ? 'prepare' : states.complete === 'passed' || states.complete === 'failed' ? 'complete' : 'prepare';
    const stage = STAGES.find((item) => item[0] === activeStage);

    const badge = root.querySelector('[data-e2e-flow-badge]');
    badge.textContent = running ? '執行中' : states.complete === 'passed' ? '已完成' : states.complete === 'failed' ? '有異常' : '待命';
    badge.className = 'e2e-flow-live-badge ' + (running ? 'is-running' : states.complete === 'passed' ? 'is-passed' : states.complete === 'failed' ? 'is-failed' : '');

    const selectedRoot = root.querySelector('[data-e2e-flow-selected]');
    selectedRoot.innerHTML = selectedModules.length
      ? selectedModules.map((module) => '<span class="e2e-flow-module-chip">' + escapeHtml(MODULES[module]) + '</span>').join('')
      : '<span class="e2e-flow-module-chip is-empty">尚未選擇</span>';

    renderRail(root.querySelector('[data-e2e-flow-rail]'), states, activeStage);
    root.querySelector('[data-e2e-flow-stage]').textContent = (stage ? stage[1] : '準備') + (activities.length > 1 ? ' · 同時執行 ' + activities.length + ' 個節點' : '');
    renderActivities(root.querySelector('[data-e2e-flow-activities]'), activities, running, status.message);
    renderModules(root.querySelector('[data-e2e-flow-modules]'), selectedModules, status, activities);
  }

  document.addEventListener('change', (event) => {
    if (event.target?.matches?.('[data-e2e-module]')) {
      rememberSelectedModules();
      render();
    }
  }, true);
  document.addEventListener('click', (event) => {
    if (event.target?.closest?.('#runPairedFullE2EButton')) rememberSelectedModules();
  }, true);

  function start() {
    mount();
    rememberSelectedModules();
    render();
    if (!timer) timer = window.setInterval(render, 350);
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  window.addEventListener('pagehide', () => {
    if (timer) window.clearInterval(timer);
    timer = 0;
  });
  window.addEventListener('pageshow', () => {
    if (!timer) timer = window.setInterval(render, 350);
    render();
  });

  window.MemberE2EFlowVisualizer = Object.freeze({
    version: VERSION,
    render,
    getSnapshot: () => {
      const status = safeCall(() => window.MemberAdminE2EControl?.getStatus?.(), {}) || {};
      const selectedModules = selectedModulesFromStatus(status);
      const activities = currentActivities(status);
      return {
        selectedModules,
        activities,
        stage: activities.length ? stageForActivity(activities[0]) : status.running ? 'prepare' : 'complete',
        trackedWindowCount: trackedWindows.filter((item) => item.child && !safeCall(() => item.child.closed, true)).length
      };
    }
  });
})();