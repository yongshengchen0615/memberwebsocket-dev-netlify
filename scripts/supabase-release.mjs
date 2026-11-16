import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const targets = new Map([
  ['master', { projectRef: 'dbuquirnaskrwcamdxki', environment: 'production' }],
  ['Integrated-Marketing-Platform', { projectRef: 'bmwhojszsnxliekkhrka', environment: 'testing' }],
]);
const fail = code => { throw new Error(code); };
const checksum = text => createHash('sha256').update(text).digest('hex');
export function releaseTarget(branch) {
  if (!targets.has(branch)) fail('RELEASE_BRANCH_NOT_ALLOWED');
  return { ...targets.get(branch) };
}

// Only inspect top-level SQL. Function/dollar bodies, quoted identifiers,
// strings and nested comments cannot introduce transaction control commands.
function topLevelSQL(sql) {
  let result = '', i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end; result += ' '; }
    else if (sql.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) fail('UNTERMINATED_SQL_COMMENT');
      result += ' ';
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++];
      const escaped = quote === "'" && /\b[eE]$/.test(sql.slice(0, i - 1));
      let closed = false;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') i += 2;
        else if (sql[i] === quote) {
          if (sql[i + 1] === quote) i += 2;
          else { i++; closed = true; break; }
        } else i++;
      }
      if (!closed) fail('UNTERMINATED_SQL_STRING');
      result += ' value ';
    } else {
      const tag = /^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end < 0) fail('UNTERMINATED_SQL_BODY');
        i = end + tag[0].length; result += ' body ';
      } else result += sql[i++];
    }
  }
  return result;
}

export function loadReleasePlan(root = process.cwd()) {
  const base = path.join(root, 'MemberWebsocket-dev/supabase');
  const baseline = JSON.parse(readFileSync(path.join(base, 'deployment-baseline.json'), 'utf8'));
  if (baseline.schemaVersion !== 1 || !/^\d{14}$/.test(baseline.through)) fail('INVALID_DEPLOYMENT_BASELINE');
  const dir = path.join(base, 'migrations');
  const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  for (const [name, expected] of Object.entries(baseline.historical)) {
    if (!files.includes(name) || checksum(readFileSync(path.join(dir, name))) !== expected) fail('HISTORICAL_MIGRATION_CHANGED');
  }
  const migrations = [], versions = new Set();
  for (const filename of files) {
    if (Object.hasOwn(baseline.historical, filename)) continue;
    const match = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(filename);
    if (!match || match[1] <= baseline.through) fail('BACKDATED_OR_INVALID_MIGRATION');
    if (versions.has(match[1])) fail('DUPLICATE_MIGRATION_VERSION');
    versions.add(match[1]);
    const source = readFileSync(path.join(dir, filename), 'utf8');
    let sql = source;
    // This already-published, idempotent grant repair predates this pipeline.
    // Future files must leave transaction ownership to the release runner.
    if (filename === '20261115124713_restore_platform_login_column_grants.sql') {
      sql = sql.replace(/^((?:\s*--[^\n]*\n)*\s*)BEGIN\s*;/i, '$1').replace(/COMMIT\s*;\s*$/i, '');
    }
    if (/(?:^|;)\s*(?:BEGIN\b|COMMIT\b|ROLLBACK\b|END\b|START\s+TRANSACTION\b|PREPARE\s+TRANSACTION\b|ABORT\b)/i.test(topLevelSQL(sql))) fail('MIGRATION_TRANSACTION_CONTROL_NOT_ALLOWED');
    if (!sql.trim()) fail('EMPTY_MIGRATION');
    migrations.push({ filename, version: match[1], checksum: checksum(source), sql });
  }
  const retired = new Set(['test-mode-api', 'test-control-api', 'user-test-api', 'e2e-artifact-api', 'e2e-artifact-retention']);
  if (!Array.isArray(baseline.functions) || !baseline.functions.length || new Set(baseline.functions).size !== baseline.functions.length) fail('INVALID_FUNCTION_MANIFEST');
  for (const name of baseline.functions) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || name.endsWith('-preview') || name === 'sql-full-reset-worker' || retired.has(name)
      || !existsSync(path.join(base, 'functions', name, 'index.ts'))) fail('UNSAFE_OR_MISSING_FUNCTION');
  }
  return { migrations, functions: baseline.functions, through: baseline.through };
}

const literal = value => "'" + value.replaceAll("'", "''") + "'";
function dollar(sql, stem) {
  let tag = '$' + stem + '$';
  while (sql.includes(tag)) tag = tag.slice(0, -1) + '_x$';
  return tag + sql + tag;
}
export function migrationSQL(plan, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha || '')) fail('EXACT_COMMIT_REQUIRED');
  const entries = plan.migrations.map(({ version, filename, checksum }) => ({ version, filename, checksum }));
  const declared = literal(JSON.stringify(entries)) + '::jsonb';
  return `BEGIN;
SET LOCAL standard_conforming_strings = on;
SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(166838721, 1);
DO $preflight$ BEGIN
  IF to_regclass('public.members') IS NULL OR to_regclass('platform_private.super_admins') IS NULL THEN
    RAISE EXCEPTION 'APPLICATION_SCHEMA_BASELINE_REQUIRED';
  END IF;
END $preflight$;
CREATE SCHEMA IF NOT EXISTS deployment_private;
REVOKE ALL ON SCHEMA deployment_private FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS deployment_private.schema_releases (
  version text PRIMARY KEY, filename text NOT NULL UNIQUE,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  source_sha text NOT NULL CHECK (source_sha ~ '^[a-f0-9]{40}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE deployment_private.schema_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON deployment_private.schema_releases FROM PUBLIC, anon, authenticated, service_role;
DO $validate$ BEGIN
  IF EXISTS (
    SELECT 1 FROM deployment_private.schema_releases r
    LEFT JOIN jsonb_to_recordset(${declared}) AS l(version text, filename text, checksum text)
      ON l.version = r.version AND l.filename = r.filename AND l.checksum = r.checksum
    WHERE l.version IS NULL
  ) THEN RAISE EXCEPTION 'APPLIED_MIGRATION_DRIFT'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(${declared}) AS l(version text)
    WHERE l.version < (SELECT max(version) FROM deployment_private.schema_releases)
      AND NOT EXISTS (SELECT 1 FROM deployment_private.schema_releases r WHERE r.version = l.version)
  ) THEN RAISE EXCEPTION 'OUT_OF_ORDER_MIGRATION'; END IF;
END $validate$;
${plan.migrations.map(m => 'DO ' + dollar(`BEGIN
  IF NOT EXISTS (SELECT 1 FROM deployment_private.schema_releases WHERE version = ${literal(m.version)}) THEN
    EXECUTE ${dollar(m.sql, 'migration_' + m.version)};
    INSERT INTO deployment_private.schema_releases (version,filename,checksum,source_sha)
      VALUES (${literal(m.version)},${literal(m.filename)},${literal(m.checksum)},${literal(sha)});
  END IF;
END`, 'release_apply') + ';').join('\n')}
COMMIT;`;
}

export async function deployBackend({ root = process.cwd(), branch, sha, token, fetchImpl = fetch, deployFunction }) {
  const target = releaseTarget(branch);
  if (!/^[a-f0-9]{40}$/.test(sha || '')) fail('EXACT_COMMIT_REQUIRED');
  const plan = loadReleasePlan(root);
  if (!token) fail('SUPABASE_RELEASE_CREDENTIAL_REQUIRED');
  async function request(method, resource, body) {
    let response;
    try {
      response = await fetchImpl(`https://api.supabase.com/v1/projects/${target.projectRef}${resource}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(method === 'POST' ? 360000 : 20000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { fail(method === 'POST' ? 'DATABASE_OUTCOME_UNKNOWN_INSPECT_LEDGER' : 'PROJECT_LOOKUP_UNAVAILABLE'); }
    if (!response.ok) fail((method === 'POST' ? 'DATABASE' : 'PROJECT') + '_HTTP_' + response.status);
    try { return await response.json(); } catch { fail(method === 'POST' ? 'DATABASE_OUTCOME_UNKNOWN_INSPECT_LEDGER' : 'PROJECT_RESPONSE_INVALID'); }
  }
  const project = await request('GET', '');
  if (project.id !== target.projectRef || project.status !== 'ACTIVE_HEALTHY') fail('PROJECT_IDENTITY_OR_HEALTH_INVALID');
  await request('POST', '/database/query', { query: migrationSQL(plan, sha) });
  const ledger = await request('POST', '/database/query', {
    query: 'SELECT version, filename, checksum FROM deployment_private.schema_releases ORDER BY version;', read_only: true,
  });
  if (!Array.isArray(ledger) || ledger.length !== plan.migrations.length || plan.migrations.some(m =>
    !ledger.some(row => row.version === m.version && row.filename === m.filename && row.checksum === m.checksum))) fail('DATABASE_LEDGER_NOT_COMMITTED');
  for (const name of plan.functions) {
    if (deployFunction) await deployFunction(name, target);
    else {
      // Explicit names only. Preserve the existing verify_jwt=false contract:
      // LINE identity / internal secrets are validated by the handlers.
      const result = spawnSync('supabase', ['functions', 'deploy', name, '--project-ref', target.projectRef,
        '--use-api', '--no-verify-jwt', '--yes', '--workdir', path.join(root, 'MemberWebsocket-dev')], {
        env: { ...process.env, SUPABASE_ACCESS_TOKEN: token }, encoding: 'utf8', timeout: 180000,
        maxBuffer: 2 * 1024 * 1024,
      });
      // Provider stderr can contain source context or credentials; log only name/status.
      if (result.status !== 0 || result.error) fail('EDGE_DEPLOY_FAILED_' + name);
    }
  }
  const active = await request('GET', '/functions');
  if (!Array.isArray(active) || plan.functions.some(name => !active.some(fn => fn.slug === name && fn.status === 'ACTIVE'
    && Number.isInteger(fn.version) && fn.version > 0 && fn.verify_jwt === false))) fail('EDGE_READBACK_FAILED');
  return { status: 'backend-ready', sha, branch, ...target,
    migrations: plan.migrations.map(({ filename, checksum }) => ({ filename, checksum })),
    functions: plan.functions.map(name => { const fn = active.find(row => row.slug === name); return { name, version: fn.version }; }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  if (mode === '--plan') {
    const plan = loadReleasePlan();
    console.log(JSON.stringify({ ...releaseTarget(process.env.GITHUB_REF_NAME), migrations: plan.migrations.map(({ filename, checksum }) => ({ filename, checksum })), functions: plan.functions }, null, 2));
  } else if (mode === '--deploy') {
    mkdirSync('evidence', { recursive: true });
    const evidence = { sha: process.env.GITHUB_SHA, branch: process.env.GITHUB_REF_NAME, startedAt: new Date().toISOString(), status: 'failed' };
    try {
      Object.assign(evidence, await deployBackend({ branch: evidence.branch, sha: evidence.sha, token: process.env.SUPABASE_ACCESS_TOKEN }));
    } catch (error) {
      evidence.error = /^[A-Z0-9_-]+$/.test(error.message) ? error.message : 'BACKEND_RELEASE_FAILED';
      console.error(evidence.error); process.exitCode = 1;
    } finally {
      evidence.completedAt = new Date().toISOString();
      writeFileSync('evidence/backend-release.json', JSON.stringify(evidence, null, 2));
    }
  } else fail('EXPECTED_PLAN_OR_DEPLOY');
}
