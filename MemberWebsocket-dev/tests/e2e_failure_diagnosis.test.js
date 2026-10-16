const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

async function diagnosticsModule() {
  const source = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/_shared/e2e-diagnostics.js'),
    'utf8'
  );
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  return import(url);
}

test('E2E diagnostics classifies rate limits and timeouts into queryable failure codes', async () => {
  const { diagnoseE2EFailure } = await diagnosticsModule();
  const rate = diagnoseE2EFailure({
    caseKey: 'BOOKING_SYNC',
    domain: 'Booking',
    message: '請求過於密集，請稍後再試。',
    actual: { statusCode: 429 }
  });
  assert.equal(rate.code, 'E2E_RATE_LIMIT');
  assert.equal(rate.category, 'rate-limit');
  assert.equal(rate.retryable, true);

  const timeout = diagnoseE2EFailure({
    caseKey: 'BACKGROUND_RUNNER_LOGIN',
    domain: 'Admin',
    message: '背景管理端 Runner 未能在允許時間內完成登入與初始化。'
  });
  assert.equal(timeout.code, 'E2E_TIMEOUT');
  assert.equal(timeout.category, 'timeout');
  assert.equal(timeout.retryable, true);
});

test('E2E diagnostics distinguishes auth, realtime, backend and client failures', async () => {
  const { diagnoseE2EFailure } = await diagnosticsModule();
  assert.equal(diagnoseE2EFailure({
    caseKey: 'AUTHZ',
    actual: { httpStatus: 403, code: 'FORBIDDEN' }
  }).code, 'E2E_AUTHORIZATION');

  assert.equal(diagnoseE2EFailure({
    caseKey: 'AUTHN',
    actual: { httpStatus: 401, code: 'SESSION_EXPIRED' }
  }).code, 'E2E_AUTHENTICATION');

  assert.equal(diagnoseE2EFailure({
    caseKey: 'REALTIME',
    message: 'Realtime channel disconnected before booking sync'
  }).code, 'E2E_REALTIME');

  assert.equal(diagnoseE2EFailure({
    caseKey: 'BACKEND',
    actual: { httpStatus: 503 }
  }).code, 'E2E_BACKEND');

  assert.equal(diagnoseE2EFailure({
    caseKey: 'CLIENT',
    trace: { events: [{ type: 'window.error', detail: { message: 'TypeError' } }] }
  }).code, 'E2E_CLIENT_ERROR');
});

test('E2E failure fingerprints are stable and avoid raw messages', async () => {
  const { diagnoseE2EFailure, attachE2EDiagnosis, summarizeE2EFailureDiagnoses } = await diagnosticsModule();
  const input = {
    caseKey: 'BOOKING_SYNC',
    domain: 'Booking',
    message: '請求過於密集，請稍後再試。',
    trace: { apiTimings: [{ path: '/functions/v1/booking-api' }] }
  };
  const first = diagnoseE2EFailure(input);
  const second = diagnoseE2EFailure({ ...input, message: '429 too many requests' });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.doesNotMatch(JSON.stringify(first), /請求過於密集|too many requests/i);

  const attached = attachE2EDiagnosis({ artifactVersion: 1, seed: 'qa-seed' }, first);
  assert.equal(attached.artifactVersion, 3);
  assert.equal(attached.diagnosis.code, 'E2E_RATE_LIMIT');

  const summary = summarizeE2EFailureDiagnoses([first, second]);
  assert.equal(summary.total, 2);
  assert.equal(summary.byCategory['rate-limit'], 2);
  assert.equal(summary.fingerprints[first.fingerprint], 2);
});

test('diagnosis points to the failing request after successful bootstrap traffic', async () => {
  const { diagnoseE2EFailure } = await diagnosticsModule();
  const diagnosis = diagnoseE2EFailure({
    caseKey: 'BOOKING_SYNC',
    message: '預約狀態沒有更新',
    trace: { apiTimings: [
      { path: '/functions/v1/test-mode-api', responseStatus: 200 },
      { path: '/functions/v1/booking-api', responseStatus: 503 },
      { path: '/functions/v1/test-control-api', responseStatus: 200 }
    ] }
  });
  assert.equal(diagnosis.code, 'E2E_BACKEND');
  assert.equal(diagnosis.signal.httpStatus, 503);
  assert.equal(diagnosis.signal.path, '/functions/v1/booking-api');
  assert.match(diagnosis.nextCheck, /Edge Function/);

  const realtime = diagnoseE2EFailure({
    caseKey: 'BOOKING_REALTIME', message: 'Realtime 同步逾時'
  });
  assert.equal(realtime.code, 'E2E_REALTIME');
});

test('a date-window assertion does not inherit an expected conflict or a successful Realtime label', async () => {
  const { diagnoseE2EFailure } = await diagnosticsModule();
  const result = diagnoseE2EFailure({
    caseKey: 'ADMIN_BOOKING_SHARED_SETTINGS',
    domain: 'Admin Settings E2E',
    message: '預約設定 Realtime／日期範圍同步失敗',
    expected: { userRealtimeSettingsSynced: true, userRealtimeNoticeSynced: true, userDateWindowEnforced: true },
    actual: {
      userRealtimeSettingsSynced: true, userRealtimeNoticeSynced: true, userDateWindowEnforced: false,
      userDateWindowProbe: { endpoint: 'booking-group-slots-api', tooEarly: { slots: 0, earliestBookingDate: '' } }
    },
    trace: { apiTimings: [{ path: '/functions/v1/booking-admin-api', responseStatus: 409 }] }
  });
  assert.equal(result.code, 'E2E_API_CONTRACT');
  assert.equal(result.category, 'api-contract');
  assert.equal(result.signal.httpStatus, null);
  assert.equal(result.signal.path, '/functions/v1/booking-group-slots-api');

  const realSyncFailure = diagnoseE2EFailure({
    caseKey: 'ADMIN_BOOKING_SHARED_SETTINGS',
    message: '預約設定 Realtime／日期範圍同步失敗',
    expected: { userRealtimeSettingsSynced: true, userDateWindowEnforced: true },
    actual: { userRealtimeSettingsSynced: false, userDateWindowEnforced: true }
  });
  assert.equal(realSyncFailure.code, 'E2E_REALTIME');

  const rateLimited = diagnoseE2EFailure({
    caseKey: 'ADMIN_BOOKING_SHARED_SETTINGS',
    expected: { userDateWindowEnforced: true },
    actual: { userDateWindowEnforced: false },
    trace: { apiTimings: [{ path: '/functions/v1/booking-group-slots-api', responseStatus: 429 }] }
  });
  assert.equal(rateLimited.code, 'E2E_RATE_LIMIT');
});

test('admin and user browser E2E persist classified failure codes and v3 diagnostics', () => {
  const adminApi = fs.readFileSync(path.join(ROOT, 'supabase/functions/test-control-api/index.ts'), 'utf8');
  const userApi = fs.readFileSync(path.join(ROOT, 'supabase/functions/user-test-api/index.ts'), 'utf8');
  for (const source of [adminApi, userApi]) {
    assert.match(source, /e2e-diagnostics\.js/);
    assert.match(source, /diagnoseE2EFailure/);
    assert.match(source, /attachE2EDiagnosis/);
    assert.match(source, /summarizeE2EFailureDiagnoses/);
    assert.match(source, /diagnosticsVersion:\s*3/);
    assert.match(source, /failureDiagnostics(?:\s*:|\s*,)/);
    assert.match(source, /diagnosis\?\.code/);
  }
});

test('failure diagnostics have a partial database index for fast triage queries', () => {
  const migration = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260923114000_add_e2e_failure_diagnostic_index.sql'),
    'utf8'
  );
  assert.match(migration, /automation_test_cases_failure_diagnostics_idx/);
  assert.match(migration, /failure_code, created_at desc/);
  assert.match(migration, /where status = 'failed'/);
});


test('E2E diagnostics classifies browser policy and background Runner lifecycle failures', async () => {
  const { diagnoseE2EFailure } = await diagnosticsModule();
  const popup = diagnoseE2EFailure({
    caseKey: 'PAIRED_RUNNER_FATAL',
    actual: { code: 'E2E_BACKGROUND_POPUP_BLOCKED' }
  });
  assert.equal(popup.code, 'E2E_BROWSER_POLICY');
  assert.equal(popup.category, 'browser-policy');
  assert.equal(popup.retryable, false);
  assert.match(popup.nextCheck, /彈出式視窗/);

  const closed = diagnoseE2EFailure({
    caseKey: 'E2E_BACKGROUND_RUNNER_FAILURE',
    actual: { code: 'E2E_BACKGROUND_RUNNER_CLOSED' },
    message: '背景 Runner 視窗已關閉。'
  });
  assert.equal(closed.code, 'E2E_RUNNER_LIFECYCLE');
  assert.equal(closed.category, 'runner-lifecycle');
  assert.equal(closed.layer, 'orchestration');
  assert.equal(closed.retryable, true);
  assert.match(closed.nextCheck, /最後心跳/);
});

test('paired browser records the actual controller version and Runner lifecycle context', () => {
  const controller = fs.readFileSync(path.join(ROOT, 'admin/e2e-control.js'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'supabase/functions/test-control-api/index.ts'), 'utf8');
  assert.match(controller, /runnerVersion: VERSION/);
  assert.match(controller, /lastStatusAgeMs/);
  assert.match(controller, /lastCompletedCaseKey/);
  assert.match(api, /runnerVersion: asText\(body\.runnerVersion, 80\) \|\| "admin-browser-e2e-legacy"/);
  assert.doesNotMatch(api, /runnerVersion: "admin-browser-e2e-20260927-replay1"/);
});

test('startup failure codes point to the precise Runner stage instead of a generic timeout', async () => {
  const { diagnoseE2EFailure } = await diagnosticsModule();
  for (const [sourceCode, nextCheck] of [
    ['E2E_BACKGROUND_RUNNER_CONTROL_LOAD_FAILED', /loader.*HTTP/],
    ['E2E_BACKGROUND_RUNNER_VERSION_MISMATCH', /controllerVersion/],
    ['E2E_BACKGROUND_RUNNER_NOT_READY', /adminReady.*controllerReady/],
    ['E2E_BACKGROUND_RUNNER_BOOT_FAILED', /登入／初始化/],
  ]) {
    const diagnosis = diagnoseE2EFailure({
      caseKey: 'E2E_BACKGROUND_RUNNER_FAILURE',
      message: '背景管理端 Runner 未能在允許時間內完成登入與初始化。',
      actual: { code: sourceCode },
    });
    assert.equal(diagnosis.code, 'E2E_RUNNER_LIFECYCLE');
    assert.equal(diagnosis.signal.sourceCode, sourceCode);
    assert.match(diagnosis.nextCheck, nextCheck);
  }
});
