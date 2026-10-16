const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const root = path.join(__dirname, '..');
const coverage = import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(
  path.join(root, 'supabase/functions/_shared/e2e-coverage.js'), 'utf8')).toString('base64'));
const runId = '11111111-1111-4111-8111-111111111111';

async function api({ missing = true, databaseError = false, denied = false } = {}) {
  const inserts = [];
  let row = null, handler, dbReads = 0;
  const db = {
    rpc: async () => ({ data: null, error: null }),
    from(table) {
      dbReads++;
      const q = {
        select() { return this; }, eq() { return this; }, in() { return this; }, lt() { return this; }, order() { return this; },
        insert(value) {
          this.inserted = value;
          inserts.push({ table, value });
          if (table === 'automation_test_runs') row = { ...value, id: runId };
          return this;
        },
        single: async () => ({ data: row, error: null }),
        maybeSingle: async () => ({ data: row || (missing ? null : { id: runId, status: 'passed', summary: {} }),
          error: databaseError ? { message: 'unavailable' } : null }),
        limit: async () => ({ data: [], error: null }),
        then(resolve, reject) {
          const data = table === 'automation_test_cases' && Array.isArray(this.inserted)
            ? this.inserted.map((value, index) => ({ ...value, id: 'case-' + index })) : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        }
      };
      return q;
    }
  };
  const source = fs.readFileSync(path.join(root, 'supabase/functions/test-control-api/index.ts'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '');
  const context = {
    ...await coverage, createClient: () => db, Request, Response, TextEncoder, crypto,
    verifyLineIdTokenContract: async options => {
      if (denied) throw options.createError(401, 'AUTH_REQUIRED', '請登入');
      return { lineUserId: 'fixture-admin' };
    },
    requireActiveAdminContract: async () => {},
    summarizeE2EFailureDiagnoses: () => ({}), diagnoseE2EFailure: () => null,
    Deno: {
      env: { get: key => ({ SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture-secret' })[key] },
      serve: callback => { handler = callback; }
    }
  };
  vm.runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }), context);
  return { inserts, reads: () => dbReads, async request(action, payload = {}) {
    const response = await handler(new Request('https://fixture.supabase.co/functions/v1/test-control-api', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, clientType: 'admin', idToken: 'fixture-id-token', ...payload })
    }));
    return { status: response.status, body: await response.json() };
  } };
}

test('a purged run is a recoverable status observation, while unknown actions and DB errors remain errors', async () => {
  const server = await api();
  const missing = await server.request('admin.test-control.status', { runId });
  assert.equal(missing.status, 200);
  assert.equal(missing.body.ok, true);
  assert.deepEqual(missing.body.data, { run: null, cases: [], runMissing: true, runs: [] });
  const unknown = await server.request('admin.test-control.unknown');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'ACTION_NOT_FOUND');
  const broken = await (await api({ databaseError: true })).request('admin.test-control.status', { runId });
  assert.equal(broken.status, 503);
  assert.equal(broken.body.error.code, 'TEST_RUN_READ_FAILED');
});

test('missing-run recovery still requires authentication and a valid UUID', async () => {
  const denied = await api({ denied: true });
  assert.equal((await denied.request('admin.test-control.status', { runId })).status, 401);
  assert.equal(denied.reads(), 0);
  const invalid = await (await api()).request('admin.test-control.status', { runId: 'not-a-uuid' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'INVALID_RUN_ID');
});

test('recording persists bounded admin and client feature counts without trusting complete or copying secrets', async () => {
  const server = await api();
  const result = await server.request('admin.test-control.record-browser-run', {
    runnerKind: 'admin-browser', suite: 'full', rootRun: true,
    cases: [{ key: 'ADMIN_THEME_TOGGLE', status: 'passed' }],
    featureCoverage: { total: 33, counts: { passed: 2, 'not-run': 31 }, complete: true, idToken: 'should-never-persist' },
    clientCoverage: [{ participant: 1, surface: 'booking', coverage: { total: 3, counts: { passed: 1, blocked: 2 } }, secret: 'private' }]
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const summary = server.inserts.find(item => item.table === 'automation_test_runs').value.summary;
  assert.deepEqual(JSON.parse(JSON.stringify(summary.featureCoverage)), {
    version: 1, total: 33, counts: { passed: 2, 'not-run': 31 }, complete: false
  });
  assert.equal(summary.clientCoverage[0].coverage.complete, false);
  assert.equal(summary.coverageComplete, false);
  assert.equal(summary.verificationStatus, 'incomplete');
  assert.doesNotMatch(JSON.stringify(summary), /should-never-persist|private|fixture-secret|fixture-id-token/);
});

test('malformed feature counts are rejected and incomplete results remain incomplete', async () => {
  const { normalizeFeatureCoverage: normalize } = await coverage;
  for (const value of [null, {}, { total: 33, counts: { passed: 34 } }, { total: 33, counts: { passed: 2 } },
    { total: 33, counts: { passed: 33, failed: -1 } }, { total: 1, counts: { passed: 0.5 } }]) assert.equal(normalize(value), null);
  assert.equal(normalize({ total: 33, counts: { passed: 2, 'not-run': 31 }, complete: true }).complete, false);
  assert.equal(normalize({ total: 33, counts: { passed: 33 }, complete: false }).complete, true);
});

test('persisting a paired run with passing admin rows cannot hide missing selected client pages', async () => {
  const server = await api();
  const result = await server.request('admin.test-control.record-browser-run', {
    runnerKind:'paired-browser', suite:'full', selectedModules:['member','points'], participantCount:2,
    expectedAdminKeys:['ADMIN_A'], featureCoverage:{total:1,counts:{passed:1}}, clientCoverage:[],
    cases:[{key:'ADMIN_A',name:'admin passed',status:'passed'}],
  });
  assert.equal(result.status,201,JSON.stringify(result.body));
  const run = server.inserts.find(item => item.table === 'automation_test_runs').value;
  assert.equal(run.status,'failed');
  assert.equal(run.summary.verificationStatus,'incomplete');
  assert.equal(run.summary.coverageComplete,false);
  assert.equal(run.summary.scopeCoverage.complete,false);
  assert.equal(run.summary.scopeCoverage.expectedClientSurfaces,4);
  assert.equal(run.summary.scopeCoverage.clients.filter(item => !item.complete).length,4);
});
