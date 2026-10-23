/**
 * Read-only migration-version audit against the Supabase Management API.
 * Requires only a project-scoped Supabase token with Migrations: Read.
 * It never connects to Postgres or modifies any Supabase resource.
 */
import { readdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = /^\d{14}$/;
const PROJECT_REF = /^[a-z]{20}$/;

export function compareAppliedMigrations(localFilenames, remoteMigrations) {
  if (!Array.isArray(localFilenames) || !Array.isArray(remoteMigrations)) {
    throw new Error('Migration sources must be arrays');
  }
  const local = new Map();
  for (const filename of localFilenames) {
    const match = /^(\d{14})_(.+)\.sql$/.exec(filename);
    if (!match) throw new Error('Invalid local migration filename: ' + String(filename));
    if (local.has(match[1])) throw new Error('Duplicate local migration version: ' + match[1]);
    local.set(match[1], match[2]);
  }
  const remote = new Map();
  if (remoteMigrations.length > 10000) throw new Error('Unexpected remote migration count');
  for (const row of remoteMigrations) {
    if (!row || typeof row !== 'object' || !VERSION.test(row.version) ||
        typeof row.name !== 'string' || !row.name) {
      throw new Error('Invalid remote migration metadata');
    }
    if (remote.has(row.version)) throw new Error('Duplicate remote migration version: ' + row.version);
    remote.set(row.version, row.name);
  }
  const localOnly = [...local.keys()].filter(v => !remote.has(v)).sort();
  const remoteOnly = [...remote.keys()].filter(v => !local.has(v)).sort();
  const renamed = [...local.keys()].filter(v => remote.has(v) && local.get(v) !== remote.get(v))
    .sort().map(v => ({ version: v, local: local.get(v), remote: remote.get(v) }));
  return {
    localCount: local.size, remoteCount: remote.size,
    matchingVersions: local.size - localOnly.length,
    localOnly, remoteOnly, renamed,
    inSync: !localOnly.length && !remoteOnly.length && !renamed.length,
  };
}

export async function fetchAppliedMigrations({ token, projectRef, fetchImpl = fetch }) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('Missing SUPABASE_ACCESS_TOKEN');
  if (!PROJECT_REF.test(projectRef ?? '')) throw new Error('Invalid SUPABASE_PROJECT_REF');
  const url = 'https://api.supabase.com/v1/projects/' + projectRef + '/database/migrations';
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('Cannot reach Supabase migration read API');
  }
  if (!response || !response.ok) {
    const status = Number.isInteger(response?.status) ? response.status : 'unknown';
    throw new Error('Supabase migration read API returned HTTP ' + status);
  }
  let rows;
  try { rows = await response.json(); }
  catch { throw new Error('Invalid response JSON from Supabase migration read API'); }
  if (!Array.isArray(rows)) throw new Error('Supabase migration read API returned a non-array response');
  return rows;
}

export function formatReport(result) {
  const sample = a => a.length ? a.slice(0, 15).join(', ') +
    (a.length > 15 ? ' (+' + (a.length - 15) + ' more)' : '') : 'none';
  return [
    '## GitHub ↔ Supabase migration history (read-only)',
    '',
    '| Check | Count |',
    '| --- | ---: |',
    '| GitHub migration files | ' + result.localCount + ' |',
    '| Supabase applied migration records | ' + result.remoteCount + ' |',
    '| Matching version IDs | ' + result.matchingVersions + ' |',
    '| GitHub-only versions | ' + result.localOnly.length + ' |',
    '| Supabase-only versions | ' + result.remoteOnly.length + ' |',
    '| Same version / different name | ' + result.renamed.length + ' |',
    '',
    'GitHub-only sample: ' + sample(result.localOnly),
    '',
    'Supabase-only sample: ' + sample(result.remoteOnly),
    '',
    'Name mismatch sample: ' + sample(result.renamed.map(row => row.version)),
    '',
    result.inSync
      ? 'Migration versions and names match. Full SQL, schema, RLS and Edge Function parity still require separate checks.'
      : 'Migration history has drift. Review before deployment; never auto-apply, reset or repair.',
    '',
  ].join('\n');
}

export async function runAudit({ token, projectRef, directory, fetchImpl = fetch }) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql'));
  const rows = await fetchAppliedMigrations({ token, projectRef, fetchImpl });
  return compareAppliedMigrations(names, rows);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const result = await runAudit({
      token: process.env.SUPABASE_ACCESS_TOKEN,
      projectRef: process.env.SUPABASE_PROJECT_REF,
      directory: path.join(repoRoot, 'MemberWebsocket-dev', 'supabase', 'migrations'),
    });
    const report = formatReport(result);
    process.stdout.write(report);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
    if (!result.inSync) process.exitCode = 1;
  } catch (error) {
    process.stderr.write('Supabase migration audit failed safely: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
