import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMigrationList, compareMigrationList, formatReport } from './check-supabase-sync.mjs';

const example = 'Connecting to remote database...\n        LOCAL      │     REMOTE      │ TIME (UTC)\n──────────────────┼─────────────────┼────────────────\n 20261020000000   │ 20261020000000  │ 2026-10-20\n 20261021000000   │                 │ 2026-10-21\n                  │ 20261021000001  │ 2026-10-21\n';
const files = ['20261020000000_good.sql', '20261021000000_pending.sql'];

test('detect remote-only and local-only versions', () => {
  const x = compareMigrationList(example, files);
  assert.equal(x.localCount, 2);
  assert.equal(x.remoteCount, 2);
  assert.equal(x.matchedCount, 1);
  assert.deepEqual(x.pending, ['20261021000000']);
  assert.deepEqual(x.remoteOnly, ['20261021000001']);
  assert.equal(x.inSync, false);
  assert.match(formatReport(x), /Deployment must remain blocked/);
});

test('accept exact version alignment and empty drift', () => {
  const cli = 'LOCAL │ REMOTE │ TIME\n20261020000000 │ 20261020000000 │ timestamp\n';
  const x = compareMigrationList(cli, ['20261020000000_good.sql']);
  assert.equal(x.inSync, true);
});

test('fail closed on unexpected output', () => {
  assert.throws(() => parseMigrationList('CLI changed output format'), /Unable to parse/);
  assert.throws(() => compareMigrationList(example, ['nonsense.sql']), /Malformed/);
  assert.throws(() => compareMigrationList(example, ['20261020000000_one.sql', '20261020000000_two.sql']), /Duplicate/);
});

test('fail on inconsistency between CLI local rows and repo files', () => {
  const x = compareMigrationList('20261020000000 │ 20261020000000 │ timestamp', ['20261021000000_other.sql']);
  assert.deepEqual(x.cliLocalMismatch, ['20261020000000', '20261021000000']);
  assert.equal(x.inSync, false);
});
