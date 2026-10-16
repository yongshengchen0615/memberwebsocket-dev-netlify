const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const controller = read('admin/e2e-control.js');
const loader = process.env.E2E_LOADER_SOURCE
  ? fs.readFileSync(process.env.E2E_LOADER_SOURCE, 'utf8') : read('admin/e2e-control-loader.js');
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function page(query = '') {
  const dom = new JSDOM(read('admin/index.html'), {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'https://example.test/MemberWebsocket-dev/admin/' + query,
  });
  const w = dom.window;
  await new Promise((resolve) => w.addEventListener('load', resolve, { once: true }));
  w.performance.getEntriesByType = () => [];
  w.AbortController = AbortController;
  w.TextEncoder = TextEncoder;
  w.Request = Request;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  return dom;
}

function observeScripts(w, mode = 'success') {
  const append = w.document.head.appendChild.bind(w.document.head);
  const scripts = [];
  scripts.mode = mode;
  w.document.head.appendChild = (node) => {
    const result = append(node);
    if (node.dataset?.adminE2eControl) {
      scripts.push(node);
      queueMicrotask(() => {
        if (scripts.mode === 'success') w.eval(controller);
        node.dispatchEvent(new w.Event(scripts.mode === 'network-error' ? 'error' : 'load'));
      });
    }
    return result;
  };
  return scripts;
}

function probe(w) {
  w.eval(controller.replace('BACKGROUND_RUNNER_READY_TIMEOUT_MS = 90 * 1000', 'BACKGROUND_RUNNER_READY_TIMEOUT_MS = 1200').replace('  window.MemberAdminE2EControl =',
    '  window.startupProbe = { state, startUnifiedBackgroundE2E, waitForBackgroundRunnerControl, backgroundRunnerSnapshot, attachFailureScreenshot };\n  window.MemberAdminE2EControl ='));
  return w.startupProbe;
}

test('ordinary admin startup stays lazy; simultaneous requests load one controller', async () => {
  const dom = await page();
  const w = dom.window;
  try {
    const scripts = observeScripts(w);
    w.eval(loader);
    await tick();
    assert.equal(scripts.length, 0);
    assert.equal(w.AdminE2EControlLoader.getStatus().phase, 'idle');
    const first = w.AdminE2EControlLoader.load();
    assert.equal(w.AdminE2EControlLoader.load(), first);
    await first;
    for (const event of ['pointerenter', 'focus', 'click']) {
      w.document.getElementById('testModeTab').dispatchEvent(new w.Event(event));
    }
    assert.equal(scripts.length, 1);
    assert.equal(w.AdminE2EControlLoader.getStatus().phase, 'ready');
  } finally { w.close(); }
});

test('background popup inherits verified session and becomes ready without tab interaction', async () => {
  const parent = await page();
  const child = await page('?e2eBackgroundRunner=1&e2eRunId=BG-fixture');
  const w = child.window;
  try {
    parent.window.eval(read('admin/admin-session.js'));
    parent.window.MemberAdminSession.establish({ supabaseUrl: 'https://fixture.supabase.co' }, 'verified-fixture-token');
    const parentProbe = probe(parent.window);
    parentProbe.state.backgroundRunId = 'BG-fixture';
    w.opener = parent.window;
    let signsIn = 0;
    let bootstrap = 0;
    w.MemberSystem = {
      bindDialogKeyboard() {},
      loadConfig() { throw new Error('Popup must inherit config'); },
      signIn() { signsIn += 1; throw new Error('Popup must inherit session'); },
      request: async () => {
        bootstrap += 1;
        return { profile: {}, role: 'Admin', members: [], cards: [], tickets: [], eventTickets: [],
          calendarItems: [], tierSettings: [], messagePresets: [], stats: {},
          memberPage: { page: 1, pageSize: 100, total: 0, totalPages: 1 } };
      },
      subscribeRealtime() { throw new Error('Background admin must not duplicate realtime'); },
    };
    const scripts = observeScripts(w);
    w.eval(read('admin/admin-session.js'));
    w.eval(loader);
    // Observe the historical stall without spending its 90-second timeout.
    await tick();
    assert.equal(scripts.length, 1, 'Background URL must load controller automatically');
    w.eval(read('admin/coupon-location-editor.js'));
    w.eval(read('admin/app.js'));
    w.dispatchEvent(new w.Event('DOMContentLoaded'));
    const ready = await parentProbe.waitForBackgroundRunnerControl(w);
    assert.equal(ready, w.MemberAdminE2EControl);
    assert.equal(ready.version, parent.window.MemberAdminE2EControl.version);
    assert.equal(w.document.documentElement.dataset.memberAdminReady, 'true');
    assert.equal(w.MemberAdminSession.get().idToken, 'verified-fixture-token');
    assert.equal(bootstrap, 1);
    assert.equal(signsIn, 0);
  } finally { w.close(); parent.window.close(); }
});

for (const mode of ['network-error', 'missing-controller']) {
  test(`background ${mode} fails immediately with a load code and can explicitly retry`, async () => {
    const parent = await page();
    const child = await page('?e2eBackgroundRunner=1&e2eRunId=BG-fixture');
    try {
      const parentProbe = probe(parent.window);
      const scripts = observeScripts(child.window, mode);
      child.window.eval(loader);
      await tick();
      const start = Date.now();
      await assert.rejects(parentProbe.waitForBackgroundRunnerControl(child.window),
        (error) => error.code === 'E2E_BACKGROUND_RUNNER_CONTROL_LOAD_FAILED');
      assert.ok(Date.now() - start < 1000, 'Do not wait for the 90-second readiness deadline');
      assert.equal(scripts.length, 1, 'Do not retry failed network loads in a polling loop');
      assert.equal(child.window.document.querySelector('script[data-admin-e2e-control]'), null);
      scripts.mode = 'success';
      await child.window.AdminE2EControlLoader.load();
      assert.equal(child.window.AdminE2EControlLoader.getStatus().phase, 'ready');
    } finally { child.window.close(); parent.window.close(); }
  });
}

test('closed, boot-failed and stale-version popups have distinct terminal errors', async () => {
  const parent = await page();
  const child = await page();
  try {
    const p = probe(parent.window);
    await assert.rejects(p.waitForBackgroundRunnerControl({ closed: true }),
      (error) => error.code === 'E2E_BACKGROUND_RUNNER_CLOSED');
    child.window.document.getElementById('errorView').classList.remove('hidden');
    child.window.document.getElementById('errorMessage').textContent = 'Fixture boot failure';
    await assert.rejects(p.waitForBackgroundRunnerControl(child.window),
      (error) => error.code === 'E2E_BACKGROUND_RUNNER_BOOT_FAILED');
    child.window.document.getElementById('errorView').classList.add('hidden');
    child.window.document.documentElement.dataset.memberAdminReady = 'true';
    child.window.MemberAdminE2EControl = { version: 'old-version', runUnifiedBackground() {} };
    await assert.rejects(p.waitForBackgroundRunnerControl(child.window),
      (error) => error.code === 'E2E_BACKGROUND_RUNNER_VERSION_MISMATCH');
  } finally { child.window.close(); parent.window.close(); }
});

test('startup snapshots preserve readiness and timing without URL queries or member data', async () => {
  const parent = await page();
  const child = await page('?e2eBackgroundRunner=1&e2eRunId=BG-fixture&token=private-fixture-token');
  try {
    const p = probe(parent.window);
    child.window.performance.getEntriesByType = () => [{
      name: 'https://example.test/e2e-control.js?v=1&token=private-fixture-token',
      initiatorType: 'script', responseStatus: 404, duration: 127,
    }];
    child.window.document.getElementById('errorMessage').textContent = 'sensitive member text';
    const snapshot = p.backgroundRunnerSnapshot(child.window);
    assert.equal(snapshot.accessible, true);
    assert.equal(snapshot.adminReady, false);
    assert.equal(snapshot.loader.phase, 'unavailable');
    assert.equal(snapshot.controllerReady, false);
    assert.equal(snapshot.resources[0].responseStatus, 404);
    assert.equal(snapshot.resources[0].durationMs, 127);
    assert.doesNotMatch(JSON.stringify(snapshot), /private-fixture-token|sensitive member text|e2eRunId|\?v=/);
    assert.equal(p.backgroundRunnerSnapshot({ closed: true }).closed, true);
  } finally { child.window.close(); parent.window.close(); }
});

for (const captureFails of [false, true]) {
  test(`startup failure records runner evidence before closing (capture fails: ${captureFails})`, async () => {
    const parent = await page();
    const child = await page('?e2eBackgroundRunner=1&e2eRunId=BG-fixture');
    const w = parent.window;
    try {
      w.eval(read('admin/admin-session.js'));
      w.eval(read('e2e-scenario-graph.js'));
      w.MemberAdminSession.establish({ supabaseUrl: 'https://fixture.supabase.co' }, 'private-fixture-token');
      w.FormData = FormData;
      const p = probe(w);
      for (const input of w.document.querySelectorAll('[data-e2e-module]')) input.checked = input.dataset.e2eModule === 'integration';
      let closed = false;
      const close = child.window.close.bind(child.window);
      child.window.close = () => { closed = true; close(); };
      child.window.AdminE2EControlLoader = { getStatus: () => ({ phase: 'failed', errorCode: 'E2E_BACKGROUND_RUNNER_CONTROL_LOAD_FAILED' }) };
      w.open = () => child.window;
      w.focus = child.window.blur = () => {};
      let renders = 0;
      w.html2canvas = async (body, options) => {
        renders += 1;
        assert.equal(body, child.window.document.body, 'Capture failing Runner, not parent page');
        assert.equal(closed, false, 'Capture must precede window cleanup');
        if (captureFails) throw new Error('Fixture renderer unavailable');
        const clone = child.window.document.implementation.createHTMLDocument();
        clone.body.innerHTML = '<input id="memberPhone" value="sensitive-phone"><span data-line-user-id>private-id</span>';
        options.onclone(clone);
        assert.equal(clone.getElementById('memberPhone').value, '[redacted]');
        assert.equal(clone.querySelector('[data-line-user-id]').textContent, '[redacted]');
        return { width: 800, height: 600, toBlob(callback) { callback(new Blob(['fixture'], { type: 'image/webp' })); } };
      };
      let recorded;
      w.fetch = async (url, init) => {
        if (url.endsWith('/e2e-artifact-api')) {
          assert.equal(closed, false);
          assert.equal(init.body.get('surface'), 'admin');
          return { ok: true, json: async () => ({ ok: true, data: { screenshot: { bucket: 'e2e-failure-artifacts', path: 'admin/fixture/failure.webp' } } }) };
        }
        assert.ok(url.endsWith('/test-control-api'));
        recorded = JSON.parse(init.body);
        return { ok: true, json: async () => ({ ok: true, data: { run: { status: 'failed' } } }) };
      };
      const started = p.startUnifiedBackgroundE2E();
      assert.equal(started.started, true);
      const result = await started.completion;
      assert.equal(result.error.code, 'E2E_BACKGROUND_RUNNER_CONTROL_LOAD_FAILED');
      assert.equal(closed, true);
      assert.equal(renders, 1);
      assert.equal(recorded.cases.length, 1);
      const row = recorded.cases[0];
      assert.equal(row.status, 'failed');
      assert.equal(row.actual.runnerClosed, false, 'Do not misdiagnose our own cleanup as user closing Runner');
      assert.equal(row.trace.runnerSnapshot.loader.phase, 'failed');
      assert.equal(row.trace.screenshotSurface, 'background-runner');
      assert.equal(row.trace.selectedModules[0], 'integration');
      assert.equal(recorded.runnerVersion, w.MemberAdminE2EControl.version);
      if (captureFails) assert.equal(row.trace.screenshotCapture.status, 'failed');
      else assert.equal(row.trace.screenshot.path, 'admin/fixture/failure.webp');
      assert.doesNotMatch(JSON.stringify(row), /private-fixture-token|sensitive-phone|private-id/);
      assert.equal(p.state.running, false);
      assert.equal(p.state.backgroundRunnerWindow, null);
    } finally { child.window.close(); w.close(); }
  });
}

test('screenshot deadline aborts a stalled upload and leaves a failed capture record', async () => {
  const dom = await page();
  const w = dom.window;
  try {
    w.eval(read('admin/admin-session.js'));
    w.eval(read('e2e-scenario-graph.js'));
    w.MemberAdminSession.establish({ supabaseUrl: 'https://fixture.supabase.co' }, 'private-fixture-token');
    w.FormData = FormData;
    const p = probe(w);
    const setTimeout = w.setTimeout.bind(w);
    w.setTimeout = (fn, delay) => setTimeout(fn, delay === 12000 ? 20 : delay);
    w.html2canvas = async () => ({ width: 10, height: 10, toBlob(callback) { callback(new Blob(['fixture'], { type: 'image/webp' })); } });
    let uploadSignal;
    w.fetch = (_, init) => { uploadSignal = init.signal; return new Promise(() => {}); };
    const row = { status: 'failed', key: 'FIXTURE_UPLOAD' };
    await p.attachFailureScreenshot(row);
    assert.equal(uploadSignal.aborted, true);
    assert.equal(row.trace.screenshotCapture.status, 'failed');
    assert.equal(row.trace.screenshot, undefined);
  } finally { w.close(); }
});

test('stop during popup startup settles as skipped and never starts the suite', async () => {
  const parent = await page();
  const child = await page('?e2eBackgroundRunner=1&e2eRunId=BG-fixture');
  const w = parent.window;
  try {
    w.eval(read('admin/admin-session.js'));
    w.eval(read('e2e-scenario-graph.js'));
    w.MemberAdminSession.establish({ supabaseUrl: 'https://fixture.supabase.co' }, 'private-fixture-token');
    const p = probe(w);
    for (const input of w.document.querySelectorAll('[data-e2e-module]')) input.checked = input.dataset.e2eModule === 'integration';
    w.open = () => child.window;
    w.focus = child.window.blur = () => {};
    let suites = 0;
    child.window.MemberAdminE2EControl = { version: w.MemberAdminE2EControl.version, runUnifiedBackground() { suites += 1; } };
    let recorded;
    w.fetch = async (_, init) => {
      recorded = JSON.parse(init.body);
      return { ok: true, json: async () => ({ ok: true, data: {} }) };
    };
    const started = p.startUnifiedBackgroundE2E();
    assert.equal(w.MemberAdminE2EControl.stop(), true);
    child.window.document.documentElement.dataset.memberAdminReady = 'true';
    const result = await started.completion;
    assert.equal(result.cancelled, true);
    assert.equal(recorded.cases[0].status, 'skipped');
    assert.equal(recorded.cases[0].actual.code, 'E2E_BACKGROUND_RUNNER_START_CANCELLED');
    assert.equal(suites, 0);
    assert.equal(p.state.running, false);
  } finally { child.window.close(); w.close(); }
});
