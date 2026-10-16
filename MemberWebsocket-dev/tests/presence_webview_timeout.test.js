const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261013101500_member_presence_offline_timeout.sql'), 'utf8');
const api = fs.readFileSync(path.join(root, 'supabase/functions/api/index.ts'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'admin/app.js'), 'utf8');
const member = fs.readFileSync(path.join(root, 'member-system.js'), 'utf8');
const booking = fs.readFileSync(path.join(root, 'booking/common.js'), 'utf8');

test('a lost LINE WebView close beacon has a server-side heartbeat lease deadline', () => {
  assert.match(api, /PRESENCE_ONLINE_WINDOW_MS = 90_000/);
  assert.match(migration, /last_seen_at < now\(\) - interval '90 seconds'/);
  assert.match(migration, /offline_at = presence\.last_seen_at \+ interval '90 seconds'/);
  assert.match(migration, /offline_reason = 'heartbeat_timeout'/);
  assert.match(migration, /where presence\.offline_at is null/);
  assert.match(migration, /cron\.schedule\([\s\S]*'30 seconds'/);
});

test('presence expiry does not revoke any login token and cannot be called anonymously', () => {
  assert.doesNotMatch(migration, /member_login_token_grants|member_login_sessions|force_logout_after/i);
  assert.match(migration, /security invoker/);
  assert.match(migration, /revoke all on function public\.expire_member_presence_sessions\(\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /member_removal_jobs/);
});

test('admin receives invalidation when online/offline changes, not for heartbeats', () => {
  assert.match(migration, /tg_op = 'UPDATE' and old\.offline_at is not distinct from new\.offline_at/);
  assert.match(migration, /array\['admin'\], 'member\.presence\.changed'/);
  assert.match(migration, /array\['all'\], 'test_mode\.presence\.changed'/);
  assert.match(admin, /type\.includes\('\.presence\.'\)/);
  assert.match(admin, /refreshMemberPresence\(\)/);
  assert.match(admin, /MEMBER_PRESENCE_POLL_MS = 15_000/);
});

test('both LINE LIFF user clients still emit offline with simple beacon and keepalive fallback', () => {
  for (const script of [member, booking]) {
    assert.match(script, /addEventListener\('pagehide'/);
    assert.match(script, /visibilitychange/);
    assert.match(script, /navigator\.sendBeacon/);
    assert.match(script, /text\/plain;charset=UTF-8/);
    assert.match(script, /keepalive:\s*true/);
  }
});
