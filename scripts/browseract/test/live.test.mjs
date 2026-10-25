import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserActClient, publicTask, assessTask, validateTarget } from '../core.mjs';
import { createViewerServer } from '../live-server.mjs';
import { executeAcceptance } from '../run-ci.mjs';

const baseUrl = 'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/';
const success = { id: 'task_123', status: 'finished', steps: [{ id: 's1', status: 'succeed', step_goal: '驗證登入入口', screenshots_url: 'https://cdn.example.test/step.png' }], output: { string: JSON.stringify({ scenario_id: 'AC-001', passed: true, checks: [{ name: '未登入無法讀取資料', passed: true }] }) } };

test('AC-001: finished only passes if all structured assertions pass', () => {
  assert.equal(assessTask(success, 'AC-001').verdict, 'pass');
  for (const bad of [
    { ...success, output: { string: '' } },
    { ...success, output: { string: '{"passed":true}' } },
    { ...success, output: { string: JSON.stringify({ scenario_id: 'AC-001', passed: true, checks: [] }) } },
    { ...success, output: { string: JSON.stringify({ scenario_id: 'AC-002', passed: true, checks: [{ name: 'ok', passed: true }] }) } },
    { ...success, output: { string: JSON.stringify({ scenario_id: 'AC-001', passed: true, checks: [{ name: 'ok', passed: false }] }) } }
  ]) assert.equal(assessTask(bad, 'AC-001').verdict, 'fail');
  assert.equal(assessTask({ ...success, status: 'running' }).verdict, 'pending');
  assert.equal(assessTask({ ...success, status: 'canceled' }).verdict, 'blocked');
  assert.equal(assessTask({ ...success, status: 'failed' }).verdict, 'fail');
});

test('target allowlist prevents external origins and credential injection', () => {
  assert.equal(validateTarget(baseUrl + '#hash', [new URL(baseUrl).origin]), baseUrl);
  for (const bad of ['http://example.com', 'https://evil.test/', 'https://user:pass@integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/']) {
    assert.throws(() => validateTarget(bad, [new URL(baseUrl).origin]));
  }
});

test('public result excludes sensitive BrowserAct internal fields', () => {
  const safe = publicTask({ ...success, profile_id: 'private', input_parameters: 'secret=token', steps: [{ ...success.steps[0], screenshots_url: 'javascript:alert(1)' }] }, 'AC-001');
  assert.equal(safe.steps[0].screenshot, null);
  assert.equal(safe.liveUrl, null);
  assert.doesNotMatch(JSON.stringify(safe), /private|secret=token|javascript:/);
});

test('BrowserAct API client sends server-side authorization and exact workflow parameters', async () => {
  const seen = [];
  const client = createBrowserActClient({ apiKey: 'only-server', fetchImpl: async (url, args) => {
    seen.push({ url: String(url), args });
    return { ok: true, status: 200, json: async () => url.pathname.endsWith('run-task') ? { id: 'task_123' } : success };
  } });
  assert.deepEqual(await client.start({ workflowId: 'flow', baseUrl, scenarioId: 'AC-001' }), { id: 'task_123' });
  assert.equal((await client.get('task_123')).status, 'finished');
  assert.equal(seen[0].args.headers.Authorization, 'Bearer only-server');
  assert.deepEqual(JSON.parse(seen[0].args.body).input_parameters, [{ name: 'base_url', value: baseUrl }, { name: 'scenario_id', value: 'AC-001' }]);
  assert.ok(seen[1].url.endsWith('task_id=task_123'));
});

test('viewer: auth stays on server, origin checks protect write endpoints and task can be watched', async t => {
  const client = {
    start: async () => ({ id: 'task_123' }), get: async () => ({ ...success, status: 'running', live_url_info: { live_url: 'https://live.example.test/watch', width: 1280, height: 720 } }),
    stop: async () => {}, resume: async () => {}
  };
  const server = createViewerServer({ client, workflowId: 'flow', defaultUrl: baseUrl, port: 0 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const address = `http://127.0.0.1:${port}`;
  const page = await fetch(address);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /BrowserAct 即時驗收監控台/);
  const forbidden = await fetch(address + '/api/tasks', { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  const started = await fetch(address + '/api/tasks', { method: 'POST', headers: { Origin: address, 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl, scenarioId: 'AC-001' }) });
  assert.equal(started.status, 201);
  assert.deepEqual(await started.json(), { id: 'task_123' });
  const task = await (await fetch(address + '/api/tasks/task_123')).json();
  assert.equal(task.liveUrl, 'https://live.example.test/watch');
  assert.equal(task.status, 'running');
  assert.equal(task.verdict, 'pending');
  assert.equal((await fetch(address + '/api/tasks/task_123/stop', { method: 'PUT', headers: { Origin: address } })).status, 200);
  assert.equal((await fetch(address + '/api/tasks/task_123/resume', { method: 'PUT', headers: { Origin: address } })).status, 200);
});

test('CI runner fails closed on bad assertions and reports valid completion', async () => {
  const logs = [];
  const client = { start: async () => ({ id: 'task_123' }), get: async () => success };
  const result = await executeAcceptance({ client, workflowId: 'flow', baseUrl, scenarioId: 'AC-001', log: x => logs.push(x) });
  assert.equal(result.verdict, 'pass');
  assert.match(logs.join('\n'), /steps=1 verdict=pass/);
  const bad = await executeAcceptance({ client: { ...client, get: async () => ({ ...success, output: { string: '' } }) }, workflowId: 'flow', baseUrl, scenarioId: 'AC-001', log: () => {} });
  assert.equal(bad.verdict, 'fail');
});
