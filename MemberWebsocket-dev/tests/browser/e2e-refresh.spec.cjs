const { test, expect } = require('playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
let server, base;
const fixtureScript = `
  document.documentElement.dataset.memberAdminReady = 'true';
  document.getElementById('loadingView').classList.add('hidden');
  document.getElementById('adminView').classList.remove('hidden');
  document.getElementById('testModeTab').addEventListener('click', () => {
    document.getElementById('testModeTab').setAttribute('aria-selected', 'true');
    document.getElementById('testModePanel').classList.remove('hidden');
  });
  window.MemberAdminSession = { wait: async () => ({ config: {
    supabaseUrl: 'https://fixture.supabase.co', supabasePublishableKey: 'fixture-publishable'
  }, idToken: 'private-fixture-token' }) };
`;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/fixture.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(fixtureScript);
    }
    if (pathname === '/admin/') {
      const html = fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      const fixture = '<script src="/fixture.js"></script><script src="/e2e-scenario-graph.js"></script><script src="/admin/test-control.js"></script><script src="/admin/e2e-control-loader.js"></script>';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html.replace('</body>', fixture + '</body>'));
    }
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end();
    }
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.afterAll(async () => new Promise(resolve => server.close(resolve)));
test.beforeEach(async ({ page }, info) => {
  info.browserErrors = [];
  page.on('pageerror', error => info.browserErrors.push(error.message));
  await page.route(/https?:\/\/(?!127\.0\.0\.1|fixture\.supabase\.co)/, route => route.abort());
});
test.afterEach(async ({}, info) => expect(info.browserErrors).toEqual([]));

function record(id, featureCoverage = null) {
  return { run: { id, runCode: id.toUpperCase(), suite: 'full', status: 'passed', totalCases: 1, passedCases: 1,
    failedCases: 0, summary: { runnerKind: 'paired-browser', featureCoverage, clientCoverage: [] } }, cases: [] };
}

test('coverage survives a real reload, lazy controller startup and a historical report without coverage', async ({ page }) => {
  let coverage = { total: 33, counts: { passed: 2, 'not-run': 31 }, complete: false };
  await page.route('https://fixture.supabase.co/**', async route => {
    const body = route.request().postDataJSON(), current = record('browser-saved', coverage);
    const data = body.action.endsWith('.list') ? { runs: [current.run] } : { ...current, runs: [current.run] };
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.goto(base + '/admin/');
  await page.locator('#testModeTab').click();
  await expect(page.locator('.e2e-feature-coverage-card p')).toHaveText('2 / 33 功能群組通過');
  const saved = await page.evaluate(() => sessionStorage.getItem('member-admin-e2e-coverage-v1'));
  expect(saved).not.toContain('private-fixture-token');
  coverage = null; // Old history has no stored coverage; the current tab retains its last saved report.
  await page.reload();
  await page.locator('#testModeTab').click();
  await expect(page.locator('.e2e-feature-coverage-card p')).toHaveText('2 / 33 功能群組通過');
  await expect(page.locator('.e2e-feature-coverage-card small')).toContainText('未執行 31');
  expect(await page.evaluate(() => window.MemberAdminE2EControl.isRunning())).toBe(false);
});

test('history recovers when a purge removes a run between list and detail requests', async ({ page }) => {
  const deleted = record('deleted'), current = record('remaining', { total: 33, counts: { passed: 2, 'not-run': 31 } });
  const requests = [];
  await page.route('https://fixture.supabase.co/**', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    const data = body.action.endsWith('.list') ? { runs: [deleted.run] }
      : body.runId === 'deleted' ? { run: null, cases: [], runMissing: true, runs: [current.run] }
        : { ...current, runs: [current.run] };
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.goto(base + '/admin/');
  await page.locator('#testModeTab').click();
  await expect(page.locator('#automationTestRunCode')).toHaveText('REMAINING');
  await expect(page.locator('.e2e-feature-coverage-card p')).toHaveText('2 / 33 功能群組通過');
  expect(requests.filter(body => body.runId === 'deleted')).toHaveLength(1);
});
