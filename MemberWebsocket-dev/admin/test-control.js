(() => {
  'use strict';

  const VERSION = '2026-10-10.1';
  const els = {};
  const artifactPreviewCache = new Map();
  const artifactPrefetchQueue = [];
  const ARTIFACT_URL_MIN_TTL_MS = 45_000;
  const ARTIFACT_PREFETCH_CONCURRENCY = 2;
  let artifactPrefetchActive = 0;
  let currentRunId = '';
  let pollTimer = 0;
  let pollInFlight = false;
  let busy = false;
  let historyTimer = 0;
  let historyRequest = null;
  let detailRevision = 0;
  let followLatest = true;
  let latestDetail = null;
  let latestRuns = [];
  let lastMessage = '';
  let lastMessageError = false;
  let backgroundRunId = '';
  let backgroundRevision = -1;
  let statusRevision = 0;
  let detailFingerprint = '';
  let historyFingerprint = '';

  window.addEventListener('DOMContentLoaded', () => {
    [
      'testModeTab',
      'automationTestRunnerBadge',
      'purgeTestDataButton',
      'keepTestHistoryOnPurge',
      'automationTestMessage',
      'automationTestRunCode',
      'automationTestRunStatus',
      'automationTestRunSuite',
      'automationTestProgress',
      'automationTestProgressBar',
      'automationTestProgressText',
      'automationTestPassedCount',
      'automationTestFailedCount',
      'automationTestTotalCount',
      'automationTestCaseList',
      'automationTestCaseEmpty',
      'automationTestHistoryList',
      'automationTestHistoryEmpty'
    ].forEach((id) => { els[id] = document.getElementById(id); });

    if (!els.testModeTab) return;

    els.purgeTestDataButton?.addEventListener('click', () => purgeTestData().catch(showError));
    els.testModeTab.addEventListener('click', () => loadHistory().catch(showError));

    window.addEventListener('member-admin-ready', () => {
      if (els.testModeTab.getAttribute('aria-selected') === 'true') {
        loadHistory().catch(showError);
      }
    });

    const resume = () => {
      if (historyVisible()) loadHistory().catch(() => {});
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', () => { startHistorySync(); resume(); });
    window.addEventListener('pagehide', () => {
      stopPolling();
      if (historyTimer) window.clearInterval(historyTimer);
      historyTimer = 0;
      detailRevision += 1;
    });
    window.addEventListener('beforeunload', stopPolling);
    startHistorySync();
  });

  function apiUrl(config) {
    const base = String(config && config.supabaseUrl || '').replace(/\/$/, '');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(base)) {
      throw new Error('自動化測試服務設定不完整。');
    }
    return base + '/functions/v1/test-control-api';
  }

  function artifactApiUrl(config) {
    const base = String(config && config.supabaseUrl || '').replace(/\/$/, '');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(base)) {
      throw new Error('E2E 快照服務設定不完整。');
    }
    return base + '/functions/v1/e2e-artifact-api';
  }

  async function requestArtifactSignedUrl(path) {
    const session = await window.MemberAdminSession.wait();
    const response = await fetch(artifactApiUrl(session.config), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: String(session.config.supabasePublishableKey || '')
      },
      cache: 'no-store',
      body: JSON.stringify({
        action: 'admin.e2e-artifact.signed-url',
        idToken: session.idToken,
        path: String(path || '')
      })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.ok !== true || !body.data?.signedUrl) {
      const error = new Error(body?.error?.message || '目前無法取得 E2E 失敗快照。');
      error.code = body?.error?.code || 'E2E_ARTIFACT_VIEW_FAILED';
      throw error;
    }
    return body.data;
  }

  function artifactCacheEntryFresh(entry) {
    const expiresAt = Date.parse(String(entry?.expiresAt || ''));
    return Boolean(entry?.signedUrl) &&
      Number.isFinite(expiresAt) &&
      expiresAt - Date.now() > ARTIFACT_URL_MIN_TTL_MS;
  }

  function preloadArtifactImage(signedUrl) {
    return new Promise((resolve, reject) => {
      const probe = new Image();
      probe.decoding = 'async';
      probe.fetchPriority = 'high';
      probe.onload = () => resolve(true);
      probe.onerror = () => reject(new Error('快照連結已建立，但圖片預載失敗。'));
      probe.src = signedUrl;
    });
  }

  async function prepareArtifactPreview(path) {
    const key = String(path || '');
    const cached = artifactPreviewCache.get(key);
    if (cached?.pendingPromise) return cached.pendingPromise;
    if (artifactCacheEntryFresh(cached)) {
      if (cached.readyPromise) await cached.readyPromise;
      return cached;
    }

    const pendingPromise = (async () => {
      const data = await requestArtifactSignedUrl(key);
      const entry = {
        signedUrl: String(data.signedUrl || ''),
        expiresAt: String(data.expiresAt || ''),
        readyPromise: null,
        pendingPromise: null
      };
      entry.readyPromise = preloadArtifactImage(entry.signedUrl);
      artifactPreviewCache.set(key, entry);
      await entry.readyPromise;
      return entry;
    })().catch((error) => {
      artifactPreviewCache.delete(key);
      throw error;
    });

    artifactPreviewCache.set(key, { pendingPromise });
    return pendingPromise;
  }

  function drainArtifactPrefetchQueue() {
    while (artifactPrefetchActive < ARTIFACT_PREFETCH_CONCURRENCY && artifactPrefetchQueue.length) {
      const job = artifactPrefetchQueue.shift();
      artifactPrefetchActive += 1;
      prepareArtifactPreview(job.path)
        .then(job.resolve, job.reject)
        .finally(() => {
          artifactPrefetchActive = Math.max(0, artifactPrefetchActive - 1);
          drainArtifactPrefetchQueue();
        });
    }
  }

  function queueArtifactPrefetch(path) {
    const cached = artifactPreviewCache.get(String(path || ''));
    if (cached?.pendingPromise || artifactCacheEntryFresh(cached)) {
      return prepareArtifactPreview(path);
    }
    return new Promise((resolve, reject) => {
      artifactPrefetchQueue.push({ path, resolve, reject });
      drainArtifactPrefetchQueue();
    });
  }

  async function request(action, payload = {}) {
    const session = await window.MemberE2EScenarioGraph.runWithDeadline(
      () => window.MemberAdminSession.wait(), 30000, 'TEST_CONTROL_SESSION'
    );
    const controller = new AbortController();
    const timeoutMs = action === 'admin.test-control.execute' ? 140000 : 30000;
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let body;
    try {
      response = await fetch(apiUrl(session.config), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: String(session.config.supabasePublishableKey || '')
        },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify({
          ...payload,
          action,
          clientType: 'admin',
          idToken: session.idToken
        })
      });
      body = await response.json().catch(() => null);
      if (controller.signal.aborted) throw new Error('request-aborted');
    } catch (error) {
      if (controller.signal.aborted) {
        const timeout = new Error('後端 QA 請求逾時：' + action);
        timeout.code = 'TEST_CONTROL_REQUEST_TIMEOUT';
        throw timeout;
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }

    if (!response.ok || !body || body.ok !== true) {
      const error = new Error(body?.error?.message || '自動化測試服務拒絕此操作。');
      error.code = body?.error?.code || 'TEST_CONTROL_ERROR';
      throw error;
    }
    return body.data || {};
  }

  function isBackgroundRunner() {
    return new URLSearchParams(window.location.search).get('e2eBackgroundRunner') === '1';
  }

  function historyVisible() {
    return !isBackgroundRunner() && !document.hidden &&
      els.testModeTab?.getAttribute('aria-selected') === 'true' &&
      document.documentElement.dataset.memberAdminReady === 'true';
  }

  function startHistorySync() {
    if (historyTimer || isBackgroundRunner()) return;
    // The Runner pushes backend progress; this bounded fallback discovers new
    // browser records and changes made in another admin tab without a reload.
    historyTimer = window.setInterval(() => {
      if (historyVisible() && !busy && !pollTimer) loadHistory().catch(() => {});
    }, 5000);
  }

  function loadHistory() {
    if (historyRequest) return historyRequest;
    historyRequest = (async () => {
      const revision = detailRevision;
      const data = await request('admin.test-control.list');
      if (revision !== detailRevision) return;
      const runs = Array.isArray(data.runs) ? data.runs : [];
      if (!runs.length) {
        currentRunId = '';
        stopPolling();
        resetDetail();
        renderHistory(runs);
        window.dispatchEvent(new Event('member-admin-test-history-cleared'));
        return;
      }
      if (followLatest || !currentRunId || !runs.some((run) => String(run.id || '') === currentRunId)) {
        currentRunId = String(runs[0].id || '');
      }
      renderHistory(runs);
      // Refresh the selected run even when its identity did not change.
      await loadSelectedRun();
    })().finally(() => { historyRequest = null; });
    return historyRequest;
  }

  async function loadSelectedRun(recoverMissing = true) {
    const runId = currentRunId;
    const revision = ++detailRevision;
    if (!runId) return;
    const data = await request('admin.test-control.status', { runId });
    if (revision !== detailRevision || runId !== currentRunId) return;
    if (data.runMissing === true) {
      const runs = (Array.isArray(data.runs) ? data.runs : []).filter(run => String(run.id || '') !== runId);
      currentRunId = '';
      stopPolling();
      resetDetail();
      renderHistory(runs);
      if (recoverMissing && runs.length) {
        followLatest = true;
        currentRunId = String(runs[0].id || '');
        await loadSelectedRun(false);
      } else if (!runs.length) {
        window.dispatchEvent(new Event('member-admin-test-history-cleared'));
      }
      return;
    }
    renderDetail(data);
    renderHistory(Array.isArray(data.runs) ? data.runs : latestRuns);
    if (['queued', 'running'].includes(String(data.run?.status || ''))) beginPolling();
    else stopPolling();
  }

  function publishTestStatus() {
    statusRevision += 1;
    if (isBackgroundRunner()) window.MemberAdminE2EControl?.publishStatus?.();
  }

  function testStatusSnapshot() {
    return { revision: statusRevision, detail: latestDetail, runs: latestRuns,
      busy, message: lastMessage, messageError: lastMessageError };
  }

  function receiveBackgroundStatus(snapshot, runId) {
    if (isBackgroundRunner() || !snapshot || !runId) return false;
    const revision = Number(snapshot.revision);
    if (!Number.isFinite(revision) || revision < 0) return false;
    if (backgroundRunId !== runId) {
      backgroundRunId = runId;
      backgroundRevision = -1;
      followLatest = true;
    }
    if (revision <= backgroundRevision) return false;
    backgroundRevision = revision;
    detailRevision += 1;
    stopPolling(); // The isolated Runner already polls this same backend run.
    if (snapshot.detail?.run && (followLatest || String(snapshot.detail.run.id || '') === currentRunId)) {
      renderDetail(snapshot.detail);
    }
    renderHistory(Array.isArray(snapshot.runs) ? snapshot.runs : latestRuns);
    setBusy(snapshot.busy);
    setMessage(snapshot.message, snapshot.messageError);
    return true;
  }

  function acceptRecordedRun(data) {
    detailRevision += 1;
    if (data?.run && (followLatest || String(data.run.id || '') === currentRunId)) renderDetail(data);
    if (Array.isArray(data?.runs)) renderHistory(data.runs);
  }

  async function purgeTestData() {
    if (busy) return;
    const keepTestHistory = els.keepTestHistoryOnPurge?.checked !== false;
    const confirmed = window.confirm(
      '確定移除測試資料？\n\n' +
      '會清除測試帳號的點數、票券、預約、收據快照、測試條款同意、Session／Presence、相關操作稽核及 QA 前置資源。\n\n' +
      (keepTestHistory
        ? '保留 E2E 執行歷史、案例步驟、分析資料與失敗快照。\n\n'
        : '同時刪除 E2E 執行歷史、案例步驟、演進狀態與失敗快照。\n\n') +
      '測試帳號與測試模式環境設定會保留。測試用戶端必須重新登入。已刪除的資料無法復原。'
    );
    if (!confirmed) return;

    stopPolling();
    detailRevision += 1;
    setBusy(true);
    setMessage('正在移除測試資料…');
    try {
      const data = await request('admin.test-control.purge-test-data', { keepTestHistory });
      if (!keepTestHistory) {
        currentRunId = '';
        resetDetail();
        window.dispatchEvent(new Event('member-admin-test-history-cleared'));
      }
      renderHistory(Array.isArray(data.runs) ? data.runs : []);
      const purge = data && data.purge && typeof data.purge === 'object' ? data.purge : {};
      const removed = [
        Number(purge.deletedAutomationRuns || 0),
        Number(purge.deletedBookings || 0),
        Number(purge.deletedBookingReceipts || 0),
        Number(purge.deletedReceiptObjects || 0),
        Number(purge.deletedMembershipConsents || 0),
        Number(purge.deletedEvolutionStateRows || 0),
        Number(purge.deletedEventClaims || 0),
        Number(purge.deletedPointEntries || 0),
        Number(purge.deletedPointTickets || 0),
        Number(purge.deletedPointBalances || 0),
        Number(purge.deletedServiceTimeEntries || 0),
        Number(purge.deletedFixedTicketGrants || 0),
        Number(purge.deletedBirthdayBenefitGrants || 0),
        Number(purge.deletedQaArtifacts || 0),
        Number(purge.deletedExtendedQaArtifacts || 0),
        Number(purge.deletedStorageObjects || 0)
      ].reduce((sum, value) => sum + value, 0);
      let refreshFailed = false;
      if (typeof window.MemberAdminDataSync?.refresh === 'function') {
        try {
          await window.MemberAdminDataSync.refresh();
        } catch (_) {
          refreshFailed = true;
        }
      }
      window.dispatchEvent(new CustomEvent('test-data-purged', { detail: purge }));
      setMessage(
        '測試資料已移除，共清除 ' + removed + ' 筆主要測試資料；' +
        Number(purge.testAccountCount || 0) + ' 個測試帳號已保留；' +
        (purge.historyRetained === true ? 'E2E 測試紀錄與快照已保留。' : 'E2E 測試紀錄與快照已清除。') +
        (Number(purge.remainingQaArtifacts || 0) > 0 ? ' 尚有 ' + Number(purge.remainingQaArtifacts) + ' 筆 QA 資源未完成清理。' : '') +
        (refreshFailed ? ' 管理畫面同步失敗，請按重新整理確認。' : ' 管理畫面已重新同步。') +
        ' 測試用戶端請重新登入。',
        refreshFailed
      );
    } finally {
      setBusy(false);
    }
  }

  async function startRun(suite, options = {}) {
    if (busy) {
      const error = new Error('自動化測試目前正在執行。');
      error.code = 'TEST_CONTROL_BUSY';
      throw error;
    }
    const rethrow = options?.rethrow === true;
    followLatest = true;
    detailRevision += 1;
    setBusy(true);
    setMessage(suite === 'full' ? '正在建立完整測試…' : '正在建立快速測試…');
    try {
      const created = await request('admin.test-control.create', { suite, selectedModules: options?.selectedModules });
      currentRunId = String(created.run?.id || '');
      renderDetail(created);
      renderHistory(Array.isArray(created.runs) ? created.runs : []);
      if (!currentRunId) throw new Error('自動化測試建立成功，但未取得執行識別。');

      setMessage('完整 E2E 後端階段執行中；畫面會持續更新每個案例與測試數據。');
      beginPolling();

      const executingRunId = currentRunId;
      const finalData = await request('admin.test-control.execute', { runId: executingRunId });
      stopPolling();
      detailRevision += 1;
      renderDetail(finalData);
      renderHistory(Array.isArray(finalData.runs) ? finalData.runs : []);
      const failed = Number(finalData.run?.failedCases || 0);
      const skipped = Number(
        finalData.run?.skippedCases
        || (Array.isArray(finalData.cases) ? finalData.cases.filter((testCase) => testCase?.status === 'skipped').length : 0)
        || 0
      );
      setMessage(
        failed > 0
          ? '後端完整 E2E 完成：有 ' + failed + ' 個案例失敗，Browser 協同階段仍會繼續收集結果。'
          : skipped > 0
            ? '後端完整 E2E 完成：' + skipped + ' 個環境條件未配置而略過，其餘案例通過。'
            : '後端完整 E2E 完成：所有案例通過。',
        failed > 0
      );
      return finalData;
    } catch (error) {
      stopPolling();
      detailRevision += 1;
      showError(error);
      if (rethrow) throw error;
      return { error: { code: String(error?.code || error?.name || 'ERROR'), message: String(error?.message || '未知錯誤') } };
    } finally {
      setBusy(false);
    }
  }

  function beginPolling() {
    stopPolling();
    const tick = async () => {
      if (!currentRunId || pollInFlight) return;
      const runId = currentRunId;
      const revision = detailRevision;
      pollInFlight = true;
      try {
        const data = await request('admin.test-control.status', { runId });
        if (revision !== detailRevision || runId !== currentRunId) return;
        if (data.runMissing === true) {
          stopPolling();
          currentRunId = '';
          detailRevision += 1;
          resetDetail();
          await loadHistory();
          return;
        }
        renderDetail(data);
        renderHistory(Array.isArray(data.runs) ? data.runs : []);
        const status = String(data.run?.status || '');
        if (['passed', 'failed', 'cancelled'].includes(status)) stopPolling();
      } catch (_) {
        // The execute request owns the terminal error; polling is observational.
      } finally { pollInFlight = false; }
    };
    pollTimer = window.setInterval(tick, 900);
  }

  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = 0;
  }

  function setBusy(value) {
    busy = Boolean(value);
    if (els.purgeTestDataButton) els.purgeTestDataButton.disabled = busy;
    if (els.automationTestRunnerBadge && (busy || !latestDetail?.run)) {
      els.automationTestRunnerBadge.textContent = busy ? 'Runner：完整 E2E 執行中' : 'Runner：待命';
      els.automationTestRunnerBadge.classList.toggle('is-on', busy);
      els.automationTestRunnerBadge.classList.toggle('is-off', !busy);
    } else if (latestDetail?.run) {
      renderRunnerBadge(runVerificationStatus(latestDetail.run));
    }
    publishTestStatus();
  }

  function statusText(status) {
    const map = {
      queued: '等待執行',
      running: '執行中',
      passed: '通過',
      failed: '失敗',
      cancelled: '已取消',
      skipped: '略過',
      incomplete: '覆蓋未完成'
    };
    return map[status] || status || '尚未執行';
  }

  function runVerificationStatus(run) {
    const status = String(run?.status || 'queued');
    if (status !== 'passed') return status;
    return run.summary?.verificationStatus === 'incomplete' || Number(run.skippedCases || run.summary?.skippedCases || 0) > 0
      ? 'incomplete' : status;
  }

  function suiteText(suite) {
    return suite === 'full' ? '完整測試' : suite === 'quick' ? '快速測試' : '—';
  }

  function statusClass(status) {
    if (status === 'incomplete') return ' is-skipped';
    return ['queued', 'running', 'passed', 'failed', 'cancelled', 'skipped'].includes(status)
      ? ' is-' + status
      : '';
  }

  function formatTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('zh-TW', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date);
  }

  function formatDuration(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return Math.round(ms) + ' ms';
    return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
  }

  function formatData(value) {
    if (value === null || value === undefined) return '—';
    try {
      const text = JSON.stringify(value, null, 2);
      return text === '{}' ? '—' : text;
    } catch (_) {
      return String(value);
    }
  }

  function resetDetail() {
    latestDetail = null;
    detailFingerprint = '';
    els.automationTestRunCode.textContent = '尚未執行';
    els.automationTestRunStatus.textContent = '等待執行';
    els.automationTestRunStatus.className = 'test-control-run-status is-queued';
    els.automationTestRunSuite.textContent = '—';
    els.automationTestPassedCount.textContent = '0';
    els.automationTestFailedCount.textContent = '0';
    els.automationTestTotalCount.textContent = '0';
    els.automationTestProgressBar.style.width = '0%';
    els.automationTestProgressText.textContent = '0% · 0 / 0';
    els.automationTestProgress.setAttribute('aria-valuenow', '0');
    els.automationTestProgress.setAttribute('aria-valuetext', '0%');
    els.automationTestRunnerBadge.textContent = 'Runner：待命';
    els.automationTestRunnerBadge.className = 'test-mode-status-badge is-off';
    els.automationTestCaseList.replaceChildren();
    els.automationTestCaseEmpty.classList.remove('hidden');
    publishTestStatus();
  }

  function renderDetail(data) {
    const run = data && data.run ? data.run : null;
    const cases = Array.isArray(data && data.cases) ? data.cases : [];
    if (!run) {
      resetDetail();
      return;
    }

    const fingerprint = JSON.stringify({ run, cases });
    if (fingerprint === detailFingerprint) return;
    detailFingerprint = fingerprint;
    latestDetail = { run, cases };
    window.dispatchEvent(new CustomEvent('member-admin-test-detail', { detail: latestDetail }));
    const openCases = new Set(Array.from(els.automationTestCaseList.querySelectorAll('details[open][data-test-case-id]'))
      .map((node) => node.dataset.testCaseId));

    currentRunId = String(run.id || currentRunId);
    const total = Number(run.totalCases || cases.length || 0);
    const passed = Number(run.passedCases || 0);
    const failed = Number(run.failedCases || 0);
    const skipped = Number(run.skippedCases || cases.filter((testCase) => testCase?.status === 'skipped').length || 0);
    const complete = Math.min(total, passed + failed + skipped);
    const progress = total > 0 ? Math.round((complete / total) * 100) : 0;
    const status = runVerificationStatus(run);

    els.automationTestRunCode.textContent = String(run.runCode || '—');
    els.automationTestRunStatus.textContent = statusText(status);
    els.automationTestRunStatus.className = 'test-control-run-status' + statusClass(status);
    els.automationTestRunSuite.textContent = suiteText(run.suite);
    els.automationTestPassedCount.textContent = String(passed);
    els.automationTestFailedCount.textContent = String(failed);
    els.automationTestTotalCount.textContent = String(total);
    els.automationTestProgressBar.style.width = progress + '%';
    els.automationTestProgressText.textContent = progress + '% · ' + complete + ' / ' + total + (skipped > 0 ? ' · 略過 ' + skipped : '');
    els.automationTestProgress.setAttribute('aria-valuenow', String(progress));
    els.automationTestProgress.setAttribute('aria-valuetext', progress + '%');

    renderRunnerBadge(status);

    els.automationTestCaseList.replaceChildren(...cases.map((testCase) => {
      const node = renderCase(testCase);
      node.dataset.testCaseId = String(testCase.id || testCase.key || '');
      if (openCases.has(node.dataset.testCaseId)) node.open = true;
      return node;
    }));
    els.automationTestCaseEmpty.classList.toggle('hidden', cases.length !== 0);
    publishTestStatus();
  }

  function renderRunnerBadge(status) {
    els.automationTestRunnerBadge.textContent = status === 'running'
      ? 'Runner：執行中'
      : status === 'incomplete' ? 'Runner：覆蓋未完成（有略過）'
        : status === 'passed'
        ? 'Runner：全部通過'
        : status === 'failed'
          ? 'Runner：發現異常'
          : 'Runner：待命';
    els.automationTestRunnerBadge.className = 'test-mode-status-badge' + (
      ['running','incomplete'].includes(status) ? ' is-warning' :
      status === 'passed' ? ' is-active' :
      status === 'failed' ? ' is-error' : ' is-off'
    );
  }

  function renderCase(testCase) {
    const details = document.createElement('details');
    details.className = 'test-control-case' + statusClass(String(testCase.status || 'queued'));
    details.open = ['running', 'failed'].includes(String(testCase.status || ''));

    const summary = document.createElement('summary');

    const identity = document.createElement('div');
    identity.className = 'test-control-case-identity';

    const mark = document.createElement('span');
    mark.className = 'test-control-case-mark';
    mark.textContent = testCase.status === 'passed' ? '✓' : testCase.status === 'failed' ? '!' : testCase.status === 'running' ? '●' : '○';

    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = String(testCase.name || testCase.key || '測試案例');
    const meta = document.createElement('small');
    const duration = formatDuration(testCase.durationMs);
    meta.textContent = [String(testCase.domain || ''), duration].filter(Boolean).join(' · ');
    copy.append(title, meta);
    identity.append(mark, copy);

    const state = document.createElement('span');
    state.className = 'test-control-case-state' + statusClass(String(testCase.status || 'queued'));
    state.textContent = statusText(String(testCase.status || 'queued'));

    summary.append(identity, state);
    details.append(summary);

    if (testCase.failureMessage) {
      const failure = document.createElement('div');
      failure.className = 'test-control-failure';
      const code = document.createElement('strong');
      code.textContent = String(testCase.failureCode || 'TEST_FAILED');
      const message = document.createElement('span');
      message.textContent = String(testCase.failureMessage || '');
      failure.append(code, message);
      details.append(failure);
    }

    const steps = Array.isArray(testCase.steps) ? testCase.steps : [];
    const diagnosis = steps.find((step) => step?.key === 'failure-trace')?.actual?.diagnosis;
    if (diagnosis && typeof diagnosis === 'object') {
      const box = document.createElement('div');
      box.className = 'test-control-diagnosis';
      const label = document.createElement('strong');
      label.textContent = ['診斷', diagnosis.category, diagnosis.layer, diagnosis.fingerprint].filter(Boolean).join(' · ');
      const signal = document.createElement('span');
      const fields = [diagnosis.signal?.sourceCode, diagnosis.signal?.httpStatus,
        diagnosis.signal?.path].filter((value) => value != null && value !== '');
      signal.textContent = fields.length ? fields.join(' · ') : '無明確 API 錯誤訊號';
      const next = document.createElement('span');
      next.textContent = String(diagnosis.nextCheck || '比對 Expected／Actual 與失敗診斷資料。');
      box.append(label, signal, next);
      details.append(box);
    }
    const stepList = document.createElement('div');
    stepList.className = 'test-control-step-list';
    if (!steps.length) {
      const pending = document.createElement('p');
      pending.className = 'test-control-step-empty';
      pending.textContent = '等待此案例開始執行。';
      stepList.append(pending);
    } else {
      steps.forEach((step) => stepList.append(renderStep(step)));
    }
    details.append(stepList);
    return details;
  }

  function renderScreenshotArtifact(step) {
    const screenshot = step?.actual?.screenshot;
    const path = String(screenshot?.path || '');
    if (!/^runs\/[A-Za-z0-9._-]{1,240}\.webp$/.test(path)) return null;

    const box = document.createElement('section');
    box.className = 'test-control-screenshot';
    const top = document.createElement('div');
    top.className = 'test-control-screenshot-heading';

    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = '失敗螢幕快照';
    const meta = document.createElement('small');
    const sizeKb = Math.max(1, Math.round(Number(screenshot.size || 0) / 1024));
    const dimensions = Number(screenshot.width || 0) && Number(screenshot.height || 0)
      ? String(screenshot.width) + '×' + String(screenshot.height)
      : '';
    meta.textContent = [
      dimensions,
      sizeKb + ' KB',
      screenshot.capturedAt ? formatTime(screenshot.capturedAt) : '',
      'Private · 30 天保留'
    ].filter(Boolean).join(' · ');
    copy.append(title, meta);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-small';
    button.textContent = '查看快照';
    top.append(copy, button);

    const status = document.createElement('p');
    status.className = 'test-control-screenshot-status';
    status.textContent = '圖片儲存在 Private Storage；接近畫面時會安全預載。';

    const image = document.createElement('img');
    image.className = 'test-control-screenshot-image hidden';
    image.alt = 'E2E 失敗螢幕快照';
    image.loading = 'eager';
    image.decoding = 'async';
    image.fetchPriority = 'high';
    image.referrerPolicy = 'no-referrer';

    const link = document.createElement('a');
    link.className = 'test-control-screenshot-link hidden';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '在新分頁開啟';

    function loadInlinePreview(signedUrl) {
      if (image.src === signedUrl && image.complete && image.naturalWidth > 0) {
        return Promise.resolve(true);
      }
      return new Promise((resolve, reject) => {
        image.onload = () => {
          image.onload = null;
          image.onerror = null;
          resolve(true);
        };
        image.onerror = () => {
          image.onload = null;
          image.onerror = null;
          reject(new Error('快照連結已建立，但管理端無法載入圖片。'));
        };
        image.src = signedUrl;
      });
    }

    let prefetchStarted = false;
    const prefetch = () => {
      if (prefetchStarted) return;
      prefetchStarted = true;
      status.textContent = '正在預先準備失敗快照…';
      queueArtifactPrefetch(path)
        .then((data) => {
          link.href = data.signedUrl;
          link.classList.remove('hidden');
          status.textContent = '快照已預載，可直接查看。';
        })
        .catch(() => {
          prefetchStarted = false;
          status.textContent = '快照尚未預載；點擊「查看快照」可立即重試。';
        });
    };

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        prefetch();
      }, { rootMargin: '320px 0px' });
      observer.observe(box);
    }

    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      status.textContent = '正在準備失敗快照…';
      try {
        const data = await prepareArtifactPreview(path);
        link.href = data.signedUrl;
        link.classList.remove('hidden');
        await loadInlinePreview(data.signedUrl);
        image.classList.remove('hidden');
        button.textContent = '重新整理快照';
        status.textContent = '快照已直接載入管理端；Signed URL 約 5 分鐘後失效。';
      } catch (error) {
        image.removeAttribute('src');
        image.classList.add('hidden');
        status.textContent = error?.message || '快照讀取失敗；可能已超過 30 天保留期限。';
      } finally {
        button.disabled = false;
      }
    });

    box.append(top, status, image, link);
    return box;
  }

  function renderStep(step) {
    const row = document.createElement('section');
    row.className = 'test-control-step' + statusClass(String(step.status || 'queued'));

    const heading = document.createElement('div');
    heading.className = 'test-control-step-heading';

    const name = document.createElement('strong');
    name.textContent = String(step.order || '') + '. ' + String(step.name || step.key || '步驟');

    const meta = document.createElement('span');
    meta.textContent = [statusText(String(step.status || 'queued')), formatDuration(step.durationMs)].filter(Boolean).join(' · ');
    heading.append(name, meta);
    row.append(heading);

    if (step.message) {
      const message = document.createElement('p');
      message.className = 'test-control-step-message';
      message.textContent = String(step.message);
      row.append(message);
    }

    const data = document.createElement('div');
    data.className = 'test-control-data-grid';

    const expected = document.createElement('div');
    const expectedTitle = document.createElement('span');
    expectedTitle.textContent = 'Expected';
    const expectedValue = document.createElement('pre');
    expectedValue.textContent = formatData(step.expected);
    expected.append(expectedTitle, expectedValue);

    const actual = document.createElement('div');
    const actualTitle = document.createElement('span');
    actualTitle.textContent = 'Actual';
    const actualValue = document.createElement('pre');
    actualValue.textContent = formatData(step.actual);
    actual.append(actualTitle, actualValue);

    data.append(expected, actual);
    row.append(data);
    const screenshot = renderScreenshotArtifact(step);
    if (screenshot) row.append(screenshot);
    return row;
  }

  function replayVerdictText(value) {
    return value === 'resolved' ? '重播：原錯誤已消失'
      : value === 'reproduced' ? '重播：已重現原錯誤'
      : value === 'changed' ? '重播：錯誤型態已改變' : '';
  }
  function renderHistory(runs) {
    const list=Array.isArray(runs)?runs:[];
    latestRuns = list;
    const fingerprint = currentRunId + ':' + JSON.stringify(list);
    if (fingerprint === historyFingerprint) return;
    historyFingerprint = fingerprint;
    els.automationTestHistoryList.replaceChildren(...list.map((run)=>{
      const entry=document.createElement('div');
      entry.className='test-control-history-entry'+(String(run.id||'')===currentRunId?' active':'');
      const button=document.createElement('button'); button.type='button'; button.className='test-control-history-item'; button.dataset.testRunId=String(run.id||'');
      button.addEventListener('click',async()=>{
        if(busy)return; followLatest=false; stopPolling(); currentRunId=String(run.id||''); renderHistory(latestRuns);
        try{await loadSelectedRun();}catch(error){showError(error);}
      });
      const top=document.createElement('span'); top.className='test-control-history-top';
      const code=document.createElement('strong'); code.textContent=String(run.runCode||'Test run');
      const status=document.createElement('span'); status.className='test-control-history-status'+statusClass(runVerificationStatus(run)); status.textContent=statusText(runVerificationStatus(run));
      top.append(code,status);
      const meta=document.createElement('small');
      const failureCodes=Object.entries(run.summary?.failureDiagnostics?.byCode||{}).filter(([,count])=>Number(count)>0).sort((a,b)=>Number(b[1])-Number(a[1])).slice(0,2).map(([code,count])=>String(code)+' ×'+Number(count));
      meta.textContent=[suiteText(run.suite),formatTime(run.createdAt),Number(run.passedCases||0)+'/'+Number(run.totalCases||0)+' 通過',failureCodes.join('、'),replayVerdictText(String(run.summary?.replayComparison?.verdict||''))].filter(Boolean).join(' · ');
      button.append(top,meta); entry.append(button);
      const replayable=String(run.status||'')==='failed'&&run.suite==='full'&&run.summary?.rootRun===true&&run.summary?.runnerKind==='paired-browser'&&run.summary?.replayManifest;
      if(replayable){
        const replay=document.createElement('button'); replay.type='button'; replay.className='button button-small test-control-replay-button'; replay.textContent='↻ 重播失敗流程';
        replay.addEventListener('click',async()=>{
          if(busy)return; const control=window.MemberAdminE2EControl;
          if(!control||typeof control.replayFailedRun!=='function'){showError(new Error('失敗重播控制器尚未載入。'));return;}
          replay.disabled=true; setMessage('正在讀取 '+String(run.runCode||'失敗 E2E')+' 的 Replay Manifest…');
          try{
            const result=await control.replayFailedRun(String(run.id||''));
            if(!result?.started) throw new Error(result?.reason==='already-running'?'目前已有 E2E 執行中。':'無法啟動失敗重播。');
            setMessage('已啟動 '+String(run.runCode||'失敗 E2E')+' 的 locked-path 重播；完成後會自動更新歷史結果。');
          }catch(error){showError(error);}finally{replay.disabled=false;}
        });
        entry.append(replay);
      }
      return entry;
    }));
    els.automationTestHistoryEmpty.classList.toggle('hidden',list.length!==0);
    publishTestStatus();
  }

  function setMessage(message, error = false) {
    lastMessage = String(message || '');
    lastMessageError = Boolean(error);
    els.automationTestMessage.textContent = String(message || '');
    els.automationTestMessage.classList.toggle('hidden', !message);
    els.automationTestMessage.classList.toggle('error', Boolean(error));
    publishTestStatus();
  }

  function showError(error) {
    setMessage(error && error.message ? error.message : '自動化測試操作失敗，請稍後再試。', true);
  }

  window.MemberAdminTestControl = Object.freeze({
    version: VERSION,
    runFull: (selectedModules) => startRun('full', { rethrow: true, selectedModules }),
    refresh: () => loadHistory(),
    getStatus: () => testStatusSnapshot(),
    receiveBackgroundStatus: (snapshot, runId) => receiveBackgroundStatus(snapshot, runId),
    acceptRecordedRun: (data) => acceptRecordedRun(data),
    isRunning: () => busy,
    currentRunId: () => currentRunId
  });
})();
