const { test, expect } = require('playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
let server, base;

test.beforeAll(async () => {
  const controller = fs.readFileSync(path.join(root, 'admin/e2e-control.js'), 'utf8').replace(
    '  window.MemberAdminE2EControl =', `
    sleep = ms => new Promise(resolve => window.setTimeout(resolve, Math.min(ms, 10)));
    createPairedSession = async account => ({ account, testSessionToken: 'fixture', expiresAt: new Date(Date.now()+60000).toISOString() });
    runPairedAdminBookingLive = async () => null;
    window.scopeProbe = { state, runParticipantSurfaces };
    window.MemberAdminE2EControl =`);
  const client = `
    const surface = location.pathname.split('/').filter(Boolean).at(-1);
    window.MemberUserTestControl = { surface, runFull: async () => {
      const failed = surface === 'points';
      return { ok: !failed, account: { memberId: 'fixture-member' },
        coverage: { complete: !failed }, summary: { passed: failed ? 0 : 1, failed: failed ? 1 : 0, total: 1 },
        humanInteraction: { requiredCases: 1, passedCases: failed ? 0 : 1, missingEvidenceKeys: [] } };
    } };
  `;
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : 'text/html');
    if (pathname === '/control.js') return response.end(controller);
    if (pathname === '/client.js') return response.end(client);
    if (pathname === '/admin/') return response.end('<!doctype html><html><body><div class="test-control-center"><div class="test-control-layout"></div></div><script src="/control.js" defer></script></body></html>');
    return response.end('<!doctype html><html><body><script src="/client.js" defer></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.afterAll(async () => new Promise(resolve => server.close(resolve)));

for (const drainingAdmin of [false, true]) test(`all selected pages navigate in the same real popup after a failed page (admin draining: ${drainingAdmin})`, async ({ page, context }) => {
  const errors = [];
  context.on('page', child => child.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/admin/');
  await expect(page.locator('[data-e2e-module]:checked')).toHaveCount(6);
  const result = await page.evaluate(async draining => {
    const { state, runParticipantSurfaces } = window.scopeProbe;
    state.selectedModules = Array.from(document.querySelectorAll('[data-e2e-module]:checked'), input => input.dataset.e2eModule);
    if (draining) state.pendingTimedOutNode = new Promise(() => {});
    const child = window.open('about:blank', 'scope-fixture');
    const participant = { index: 1, account: { memberId: 'fixture-member' }, window: child, runCodes: [],
      surfacePlan: ['points', 'member', 'event', 'calendar', 'booking'].map(key => [key, key]) };
    await runParticipantSurfaces(participant);
    const result = { rows: state.results, cancelled: state.cancelled, path: child.location.pathname };
    child.close();
    return result;
  }, drainingAdmin);
  expect(result.rows.map(row => row.key)).toEqual(['PAIRED_1_POINTS', 'PAIRED_1_MEMBER', 'PAIRED_1_EVENT', 'PAIRED_1_CALENDAR', 'PAIRED_1_BOOKING']);
  expect(result.rows.map(row => row.status)).toEqual(['failed', 'passed', 'passed', 'passed', 'passed']);
  expect(result.cancelled).toBe(false);
  expect(result.path).toBe('/booking/');
  expect(errors).toEqual([]);
});
