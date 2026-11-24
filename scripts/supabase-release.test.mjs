import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { releaseTarget, loadReleasePlan, migrationSQL, deployBackend } from './supabase-release.mjs';

const sha = 'a'.repeat(40);
const hash = sql => createHash('sha256').update(sql).digest('hex');
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'release-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'MemberWebsocket-dev/supabase');
  mkdirSync(path.join(dir, 'migrations'), { recursive: true });
  mkdirSync(path.join(dir, 'functions/api'), { recursive: true });
  writeFileSync(path.join(dir, 'functions/api/index.ts'), 'Deno.serve(() => new Response("test"));');
  writeFileSync(path.join(dir, 'migrations/20261111134000_legacy.sql'), 'select 1;');
  const baseline = { schemaVersion: 1, through: '20261111134000', historical: { '20261111134000_legacy.sql': hash('select 1;') }, functions: ['api'] };
  writeFileSync(path.join(dir, 'deployment-baseline.json'), JSON.stringify(baseline));
  return { root, dir, baseline, add: (name, sql) => writeFileSync(path.join(dir, 'migrations', name), sql) };
}

test('AC-001 rejects untrusted/case-confused branches and selects only its own project', () => {
  assert.equal(releaseTarget('master').projectRef, 'dbuquirnaskrwcamdxki');
  assert.equal(releaseTarget('Integrated-Marketing-Platform').projectRef, 'bmwhojszsnxliekkhrka');
  for (const branch of ['main', 'develop', 'integrated-marketing-platform', 'constructor', '', undefined]) assert.throws(() => releaseTarget(branch), /RELEASE_BRANCH/);
});

test('AC-002 only new migrations enter the deployment plan', t => {
  const f = fixture(t);
  f.add('20261116000100_add.sql', 'create table example(id int);');
  const plan = loadReleasePlan(f.root);
  assert.deepEqual(plan.migrations.map(x => x.filename), ['20261116000100_add.sql']);
  assert.equal(plan.migrations[0].checksum, 'a77decac6dfe6e39d386184d172d16b672f3c8cb8289bde74548b4adbb33c789');
});

test('AC-002 rejects changed/deleted historical files, backdated and duplicate versions', t => {
  for (const change of [
    f => f.add('20261111134000_legacy.sql', 'delete from members;'),
    f => rmSync(path.join(f.dir, 'migrations/20261111134000_legacy.sql')),
    f => f.add('20261010000000_backfill.sql', 'select 2;'),
    f => { f.add('20261116000100_a.sql', 'select 1;'); f.add('20261116000100_b.sql', 'select 2;'); },
  ]) { const f = fixture(t); change(f); assert.throws(() => loadReleasePlan(f.root), /HISTORICAL|BACKDATED|DUPLICATE/); }
});

test('AC-006 transaction escapes in new SQL are rejected but function bodies and comments are valid', t => {
  const f = fixture(t);
  for (const sql of ['COMMIT; select 1;', 'begin; select 1; end;', 'START TRANSACTION; select 1;', '/* nested /* comment */ */ rollback;', 'select 1; PREPARE TRANSACTION \'escape\';']) {
    f.add('20261116000100_bad.sql', sql);
    assert.throws(() => loadReleasePlan(f.root), /TRANSACTION_CONTROL/);
  }
  f.add('20261116000100_bad.sql', "-- COMMIT;\nselect 'BEGIN; ROLLBACK;'; DO $body$ BEGIN PERFORM 1; END $body$;");
  assert.equal(loadReleasePlan(f.root).migrations.length, 1);
});

test('AC-008 never selects preview, retired, reset or missing Edge implementations', t => {
  for (const name of ['platform-api-preview', 'test-mode-api', 'sql-full-reset-worker', 'missing']) {
    const f = fixture(t);
    f.baseline.functions.push(name);
    writeFileSync(path.join(f.dir, 'deployment-baseline.json'), JSON.stringify(f.baseline));
    assert.throws(() => loadReleasePlan(f.root), /FUNCTION/);
  }
});

test('AC-006 missing credentials stop before any provider request', async t => {
  const f = fixture(t); let requests = 0;
  await assert.rejects(deployBackend({ root: f.root, branch: 'master', sha, token: '', fetchImpl: async () => { requests++; } }), /CREDENTIAL/);
  assert.equal(requests, 0);
});

test('AC-006 SQL failure/unknown POST result never deploys Edge and provider bodies remain private', async t => {
  for (const fail of [() => new Response('SECRET DATABASE ERROR', { status: 500 }), () => { throw new Error('SECRET NETWORK ERROR'); }]) {
    const f = fixture(t); const writes = []; const edge = [];
    const fetchImpl = async (url, options) => {
      if (options.method === 'GET') return Response.json({ id: 'dbuquirnaskrwcamdxki', status: 'ACTIVE_HEALTHY' });
      writes.push(url); return fail();
    };
    await assert.rejects(deployBackend({ root: f.root, branch: 'master', sha, token: 'secret-token', fetchImpl, deployFunction: async name => edge.push(name) }), error => !/SECRET/.test(error.message) && /DATABASE/.test(error.message));
    assert.equal(writes.length, 1, 'a mutation with unknown outcome must not be retried');
    assert.deepEqual(edge, []);
  }
});

test('AC-006 backend completes only after verified project, committed SQL and every explicit Edge function', async t => {
  const f = fixture(t); const order = [];
  const fetchImpl = async (url, options) => {
    assert.match(url, /^https:\/\/api.supabase.com\/v1\/projects\/dbuquirnaskrwcamdxki/);
    order.push(options.method);
    if (url.endsWith('/functions')) return Response.json([{ slug: 'api', version: 2, status: 'ACTIVE', verify_jwt: false }]);
    if (options.method === 'GET') return Response.json({ id: 'dbuquirnaskrwcamdxki', status: 'ACTIVE_HEALTHY' });
    if (JSON.parse(options.body).query.startsWith('SELECT version')) return Response.json([]);
    assert.match(JSON.parse(options.body).query, /pg_advisory_xact_lock/);
    return Response.json([]);
  };
  const result = await deployBackend({ root: f.root, branch: 'master', sha, token: 'private', fetchImpl, deployFunction: async name => order.push(name) });
  assert.deepEqual(order, ['GET', 'POST', 'POST', 'api', 'GET']);
  assert.equal(result.sha, sha);
  assert.equal(result.status, 'backend-ready');
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('AC-009 testing API must prove commit and failure rollback in its own synthetic schema before deployment', async t => {
  const f = fixture(t); const calls = []; let rollbackRequests = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/functions')) return Response.json([{ slug: 'api', version: 2, status: 'ACTIVE', verify_jwt: false }]);
    if (options.method === 'GET') return Response.json({ id: 'bmwhojszsnxliekkhrka', status: 'ACTIVE_HEALTHY' });
    const { query } = JSON.parse(options.body); calls.push(query);
    if (query.includes('to_regnamespace')) return Response.json([{ exists: false }]);
    if (query.startsWith('SELECT marker')) return Response.json([{ marker: 1, partial_table: null }]);
    if (query.includes('SELECT 1/0')) { rollbackRequests++; return new Response('ERROR: 22012: division by zero', { status: 400 }); }
    if (query.includes('BOOKING_DISPATCH_DEPENDENCIES_MISSING')) return Response.json([{ready:true}]);
    return Response.json([]);
  };
  const result = await deployBackend({ root: f.root, branch: 'Integrated-Marketing-Platform', sha, token: 'private', fetchImpl, deployFunction: async () => {} });
  assert.equal(rollbackRequests, 1);
  assert.equal(result.transactionProbe, 'commit-and-rollback-verified');
  const setup = calls.findIndex(q => q.startsWith('BEGIN; CREATE SCHEMA release_probe_'));
  const failed = calls.findIndex(q => q.includes('SELECT 1/0'));
  const cleanup = calls.findIndex(q => q.startsWith('BEGIN; DROP TABLE release_probe_'));
  const migration = calls.findIndex(q => q.includes('CREATE TABLE IF NOT EXISTS deployment_private.schema_releases'));
  assert.ok(setup >= 0 && setup < failed && failed < cleanup && cleanup < migration);
  const health = calls.findIndex(q => q.includes('BOOKING_DISPATCH_DEPENDENCIES_MISSING'));
  assert.ok(health > migration, 'transport recovery follows committed ledger');
});

test('AC-009 transaction probe refuses wrong rollback state or unrelated API errors before migrations', async t => {
  for (const broken of ['state', 'provider']) {
    const f = fixture(t); let deploymentStarted = false, markerReads = 0;
    await assert.rejects(deployBackend({ root: f.root, branch: 'Integrated-Marketing-Platform', sha, token: 'private',
      fetchImpl: async (url, options) => {
        if (options.method === 'GET') return Response.json({ id: 'bmwhojszsnxliekkhrka', status: 'ACTIVE_HEALTHY' });
        const { query } = JSON.parse(options.body);
        if (query.includes('deployment_private.schema_releases')) deploymentStarted = true;
        if (query.includes('to_regnamespace')) return Response.json([{ exists: false }]);
        if (query.startsWith('SELECT marker')) { markerReads++; return Response.json([{ marker: markerReads === 2 ? 2 : 1, partial_table: null }]); }
        if (query.includes('SELECT 1/0')) return new Response(broken === 'provider' ? 'SECRET provider failure' : 'ERROR: 22012: division by zero', { status: 400 });
        return Response.json([]);
      }, deployFunction: async () => { deploymentStarted = true; },
    }), error => /TRANSACTION_PROBE|DATABASE_HTTP/.test(error.message) && !error.message.includes('SECRET'));
    assert.equal(deploymentStarted, false);
  }
});

test('AC-006 failed Edge deployment does not produce a backend-ready result', async t => {
  const f = fixture(t);
  let functionsRead = false;
  await assert.rejects(deployBackend({ root: f.root, branch: 'master', sha, token: 'token',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/functions')) { functionsRead = true; return Response.json([]); }
      return options.method === 'GET' ? Response.json({ id: 'dbuquirnaskrwcamdxki', status: 'ACTIVE_HEALTHY' }) : Response.json([]);
    }, deployFunction: async () => { throw new Error('EDGE_TEST_FAILURE'); },
  }), /EDGE_TEST_FAILURE/);
  assert.equal(functionsRead, false);
});

test('AC-006 missing committed ledger or inactive Edge status prevents release readiness', async t => {
  for (const missingLedger of [true, false]) {
    const f = fixture(t);
    f.add('20261116000100_add.sql', 'SELECT 1;');
    const planned = loadReleasePlan(f.root).migrations;
    let deploys = 0;
    await assert.rejects(deployBackend({ root: f.root, branch: 'master', sha, token: 'token',
      fetchImpl: async (url, options) => {
        if (url.endsWith('/functions')) return Response.json([{ slug: 'api', version: 2, status: 'INACTIVE', verify_jwt: false }]);
        if (options.method === 'GET') return Response.json({ id: 'dbuquirnaskrwcamdxki', status: 'ACTIVE_HEALTHY' });
        if (JSON.parse(options.body).query.startsWith('SELECT version')) return Response.json(missingLedger ? [] : planned);
        return Response.json([]);
      }, deployFunction: async () => { deploys++; },
    }), /DATABASE_LEDGER_NOT_COMMITTED|EDGE_READBACK_FAILED/);
    assert.equal(deploys, missingLedger ? 0 : 1);
  }
});

test('AC-001 wrong project identity prevents every write', async t => {
  const f = fixture(t); let count = 0;
  await assert.rejects(deployBackend({ root: f.root, branch: 'master', sha, token: 'test-token', fetchImpl: async () => { count++; return Response.json({ id: 'bmwhojszsnxliekkhrka', status: 'ACTIVE_HEALTHY' }); } }), /PROJECT_IDENTITY/);
  assert.equal(count, 1);
});

test('migration SQL refuses invalid release identities', () => {
  assert.throws(() => migrationSQL({ migrations: [] }, 'bad'), /COMMIT/);
});

test('AC-BN-006: missing or ambiguous testing transport health refuses all Edge deploys',async t=>{
 const f=fixture(t),events=[];
 const fetchImpl=async(url,options)=>{
  if(options.method==='GET')return Response.json({id:'bmwhojszsnxliekkhrka',status:'ACTIVE_HEALTHY'});
  const query=JSON.parse(options.body).query;events.push(query);
  if(query.includes('to_regnamespace'))return Response.json([{exists:false}]);
  if(query.startsWith('SELECT marker'))return Response.json([{marker:1,partial_table:null}]);
  if(query.includes('SELECT 1/0'))return new Response('ERROR: 22012: division by zero',{status:400});
  if(query.includes('BOOKING_DISPATCH_DEPENDENCIES_MISSING'))return Response.json([{ready:false}]);
  return Response.json([]);
 };
 let deployments=0;
 await assert.rejects(deployBackend({root:f.root,branch:'Integrated-Marketing-Platform',sha,token:'private',fetchImpl,deployFunction:async()=>{deployments++;}}),/BOOKING_DISPATCH_HEALTH_NOT_CONFIRMED/);
 assert.equal(deployments,0);
 assert.equal(events.filter(q=>q.includes('BOOKING_DISPATCH_DEPENDENCIES_MISSING')).length,1,'no unbounded retry on failed health');
});

// Release regression: the last deployed testing ledger entry is 20261124233000.
// Newly introduced calendar migrations must sort after that version because
// the exact-SHA deployer aborts an out-of-order or partially applied ledger.
test('AC-CALENDAR-RELEASE-001: visibility migrations follow the already-published frontdesk migration', () => {
  const plan = loadReleasePlan(path.resolve(import.meta.dirname, '..'));
  const calendarVersions = plan.migrations.filter(item => /_per_(?:item|tenant)_.*visibility\.sql$/.test(item.filename))
    .map(item => item.version).sort();
  assert.deepEqual(calendarVersions, ['20261124234000', '20261124234500']);
  assert.ok(calendarVersions.every(version => version > '20261124233000'), 'avoid live migration ledger OUT_OF_ORDER_MIGRATION');
  assert.ok(calendarVersions[0] < calendarVersions[1], 'public columns/RPC must precede tenant rollout');
});
