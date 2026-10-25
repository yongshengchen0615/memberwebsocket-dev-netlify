import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserActClient } from '../core.mjs';
import { diagnose } from '../doctor.mjs';
import { launchViewer, openBrowser } from '../launch.mjs';

const baseUrl = 'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/';

test('BrowserAct stop/resume HTTP 200 empty body does not become an error', async () => {
  const client = createBrowserActClient({ apiKey: 'test-key', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }) });
  assert.deepEqual(await client.stop('task_123'), {});
  assert.deepEqual(await client.resume('task_123'), {});
});

test('doctor verifies published workflow metadata and required inputs', async () => {
  const env = { BROWSERACT_API_KEY: 'test-key', BROWSERACT_WORKFLOW_ID: 'my-workflow', BROWSERACT_BASE_URL: baseUrl };
  const good = await diagnose({
    env,
    clientFactory: () => ({ getWorkflow: async () => ({ name: '會員系統驗收', publish_at: '2026-10-25T10:00:00Z', input_parameters: [{ name: 'base_url' }, { name: 'scenario_id' }] }) }),
    fetchImpl: async () => ({ ok: true, status: 200 })
  });
  assert.equal(good.ok, true, JSON.stringify(good));
  const bad = await diagnose({
    env,
    clientFactory: () => ({ getWorkflow: async () => ({ name: '草稿', publish_at: null, input_parameters: [{ name: 'base_url' }] }) }),
    fetchImpl: async () => ({ ok: true, status: 200 })
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.results.some(x => x.name === 'Workflow 輸入參數' && !x.ok));
  assert.ok(bad.results.some(x => x.name === 'BrowserAct Workflow 已發布' && !x.ok));
});

test('missing secrets produces setup failures and never calls BrowserAct', async () => {
  const result = await diagnose({
    env: { BROWSERACT_BASE_URL: baseUrl },
    clientFactory: () => { throw new Error('Unexpected API call'); },
    fetchImpl: async () => ({ ok: true, status: 200 })
  });
  assert.equal(result.ok, false);
  assert.equal(result.results.find(x => x.name === 'BROWSERACT_API_KEY').ok, false);
});

test('one-command launcher opens local viewer safely even before API setup', async t => {
  const { server, ready } = launchViewer({ env: { BROWSERACT_VIEWER_PORT: '4181', BROWSERACT_NO_OPEN: '1', BROWSERACT_BASE_URL: baseUrl }, listen: false });
  assert.equal(ready, false);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = await fetch(origin + '/api/config');
  assert.equal(config.status, 200);
  assert.equal((await config.json()).configured, false);
  const start = await fetch(origin + '/api/tasks', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ scenarioId: 'AC-001', baseUrl }) });
  assert.equal(start.status, 503);
  const spawned = [];
  assert.equal(openBrowser('http://127.0.0.1:4181', 'linux', (command, args) => { spawned.push({ command, args }); return { on: () => {}, unref: () => {} }; }), true);
  assert.equal(spawned[0].command, 'xdg-open');
});
