/**
 * Read-only verification of Supabase migration version IDs.
 * Does not compare SQL text, current schema, or deployed Edge Function code.
 */
import { readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function parseMigrationList(output) {
  const rows = [];
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  for (const line of clean.split(/\r?\n/)) {
    if (!line.includes('│') && !line.includes('|')) continue;
    const cells = line.split(/[│|]/).map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const local = /^\d{14}$/.test(cells[0]) ? cells[0] : null;
    const remote = /^\d{14}$/.test(cells[1]) ? cells[1] : null;
    if (local || remote) rows.push({ local, remote });
  }
  if (rows.length === 0) {
    throw new Error('Unable to parse migration list: CLI output format changed or no migration rows found');
  }
  return rows;
}

export function compareMigrationList(output, localMigrationFilenames) {
  const rows = parseMigrationList(output);
  const local = new Set(rows.map((row) => row.local).filter(Boolean));
  const remote = new Set(rows.map((row) => row.remote).filter(Boolean));
  const expected = new Set();
  for (const name of localMigrationFilenames) {
    const match = name.match(/^(\d{14})_.+\.sql$/);
    if (!match) throw new Error('Malformed local migration filename: ' + name);
    if (expected.has(match[1])) throw new Error('Duplicate local migration version: ' + match[1]);
    expected.add(match[1]);
  }
  const cliLocalMismatch = [...new Set([...local].filter((v) => !expected.has(v)).concat([...expected].filter((v) => !local.has(v))))].sort();
  const pending = [...local].filter((v) => !remote.has(v)).sort();
  const remoteOnly = [...remote].filter((v) => !local.has(v)).sort();
  const both = [...local].filter((v) => remote.has(v)).length;
  return { localCount: local.size, remoteCount: remote.size, matchedCount: both, pending, remoteOnly, cliLocalMismatch, inSync: pending.length === 0 && remoteOnly.length === 0 && cliLocalMismatch.length === 0 };
}

export function formatReport(result) {
  const fmt = (versions) => versions.length ? versions.slice(0, 15).join(', ') + (versions.length > 15 ? ' (+' + (versions.length - 15) + ' more)' : '') : 'none';
  return [
    '## Supabase migration history audit (read-only)',
    '',
    '| Check | Count |',
    '| --- | ---: |',
    '| GitHub migrations recognized by CLI | ' + result.localCount + ' |',
    '| Supabase applied migrations | ' + result.remoteCount + ' |',
    '| Matching version IDs | ' + result.matchedCount + ' |',
    '| GitHub-only versions (pending or renamed) | ' + result.pending.length + ' |',
    '| Supabase-only versions | ' + result.remoteOnly.length + ' |',
    '| CLI vs checked-in local mismatch | ' + result.cliLocalMismatch.length + ' |',
    '',
    'GitHub-only samples: ' + fmt(result.pending),
    '',
    'Supabase-only samples: ' + fmt(result.remoteOnly),
    '',
    'CLI/local mismatch samples: ' + fmt(result.cliLocalMismatch),
    '',
    result.inSync ? 'Version IDs match. SQL content, database schema, RLS and Edge Function parity still require separate verification.' : 'Migration version history differs. Deployment must remain blocked pending reconciliation. Do not run db push, migration repair, or db reset automatically.',
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const outputPath = process.argv[2];
    if (!outputPath) throw new Error('Usage: node scripts/check-supabase-sync.mjs <captured-cli-output-file>');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const migrationDir = path.join(repoRoot, 'MemberWebsocket-dev', 'supabase', 'migrations');
    const migrationNames = readdirSync(migrationDir).filter((name) => name.endsWith('.sql'));
    const result = compareMigrationList(readFileSync(outputPath, 'utf8'), migrationNames);
    const report = formatReport(result);
    process.stdout.write(report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
    if (!result.inSync) process.exitCode = 1;
  } catch (err) {
    process.stderr.write('Supabase audit failed safely: ' + err.message + '\n');
    process.exitCode = 1;
  }
}
