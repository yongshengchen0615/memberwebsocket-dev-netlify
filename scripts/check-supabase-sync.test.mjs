import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareAppliedMigrations,
  fetchAppliedMigrations,
  formatReport,
} from './check-supabase-sync.mjs';

const local = ['20261020000000_first.sql', '20261021000000_second.sql'];
const remote = [
  { version: '20261020000000', name: 'first' },
  { version: '20261021000001', name: 'other' },
];

test('detects local-only and remote-only migrations', () => {
  const result = compareAppliedMigrations(local, remote);
  assert.equal(result.localCount, 2);
  assert.equal(result.remoteCount, 2);
  assert.equal(result.matchingVersions, 1);
  assert.deepEqual(result.localOnly, ['20261021000000']);
  assert.deepEqual(result.remoteOnly, ['20261021000001']);
  assert.equal(result.inSync, false);
  assert.match(formatReport(result), /Migration history has drift/);
});

test('accepts exact version and name parity', () => {
  const result = compareAppliedMigrations(['20261020000000_first.sql'], [remote[0]]);
  assert.equal(result.inSync, true);
  assert.equal(result.renamed.length, 0);
});

test('detects same-version different-name drift', () => {
  const result = compareAppliedMigrations(['20261020000000_correct.sql'], [remote[0]]);
  assert.equal(result.inSync, false);
  assert.deepEqual(result.renamed, [{
    version: '20261020000000', local: 'correct', remote: 'first',
  }]);
});

test('rejects malformed, duplicate and empty remote migration metadata', () => {
  assert.throws(() => compareAppliedMigrations(['not-a-migration.sql'], []), /Invalid local/);
  assert.throws(() => compareAppliedMigrations([
    '20261020000000_first.sql', '20261020000000_duplicate.sql',
  ], []), /Duplicate local/);
  assert.throws(() => compareAppliedMigrations([], [{ version: 'x', name: 'bad' }]), /Invalid remote/);
  assert.throws(() => compareAppliedMigrations([], [remote[0], remote[0]]), /Duplicate remote/);
  assert.throws(() => compareAppliedMigrations(null, []), /must be arrays/);
});

test('fetches only migration history with scoped token', async () => {
  let seen = null;
  const rows = await fetchAppliedMigrations({
    token: 'TEST_TOKEN_ONLY',
    projectRef: 'dbuquirnaskrwcamdxki',
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, status: 200, json: async () => remote };
    },
  });
  assert.deepEqual(rows, remote);
  assert.equal(seen.url, 'https://api.supabase.com/v1/projects/dbuquirnaskrwcamdxki/database/migrations');
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.headers.Authorization, 'Bearer TEST_TOKEN_ONLY');
  assert.equal(seen.options.redirect, 'error');
});

test('fails closed on missing token, invalid project, unauthorized API or invalid JSON', async () => {
  await assert.rejects(fetchAppliedMigrations({ token: '', projectRef: 'dbuquirnaskrwcamdxki' }), /Missing/);
  await assert.rejects(fetchAppliedMigrations({ token: 'TEST', projectRef: 'x' }), /Invalid/);
  await assert.rejects(fetchAppliedMigrations({
    token: 'TEST', projectRef: 'dbuquirnaskrwcamdxki',
    fetchImpl: async () => ({ ok: false, status: 403 }),
  }), /HTTP 403/);
  await assert.rejects(fetchAppliedMigrations({
    token: 'TEST', projectRef: 'dbuquirnaskrwcamdxki',
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('secret body'); } }),
  }), /Invalid response JSON/);
  await assert.rejects(fetchAppliedMigrations({
    token: 'TEST', projectRef: 'dbuquirnaskrwcamdxki',
    fetchImpl: async () => ({ ok: true, json: async () => ({ not: 'array' }) }),
  }), /non-array/);
  await assert.rejects(fetchAppliedMigrations({
    token: 'TEST', projectRef: 'dbuquirnaskrwcamdxki',
    fetchImpl: async () => { throw new Error('network data'); },
  }), /Cannot reach/);
});
