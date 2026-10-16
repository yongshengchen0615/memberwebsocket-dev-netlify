const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'supabase/functions/_shared/test-mode-auth.ts'),
  'utf8',
);

test('maintenance-aware test auth reuses prefetched settings', () => {
  assert.match(
    source,
    /resolveTestSession\(\s*supabase:\s*any,\s*rawToken:\s*string,\s*prefetchedSettings:\s*any\s*=\s*null/s,
  );
  assert.match(
    source,
    /const settingsPromise = prefetchedSettings\s*\?\s*Promise\.resolve\(\{ data: prefetchedSettings, error: null \}\)/s,
  );
  assert.match(
    source,
    /return await resolveTestSession\(supabase, token, settingsResult\.data\);/,
  );
});

test('direct test-session verification keeps an independent settings lookup', () => {
  const body = source.slice(
    source.indexOf('export async function resolveTestSession'),
    source.indexOf('export async function resolveUserTestIdentity'),
  );
  assert.match(body, /from\("test_mode_settings"\)/);
  assert.match(body, /from\("test_login_sessions"\)/);
  assert.match(body, /Promise\.all\(/);
  assert.match(body, /maintenance_enabled/);
  assert.match(body, /allow_pc_test_login/);
  assert.match(body, /allow_mobile_test_login/);
});


test('test session activity writes are rate-limited without weakening expiry checks', () => {
  assert.match(source, /const SESSION_TOUCH_INTERVAL_MS = 60_000/);
  assert.match(source, /expires_at,revoked_at,revoked_reason,last_used_at/);
  assert.match(source, /now - lastUsedAt >= SESSION_TOUCH_INTERVAL_MS/);
  assert.match(source, /\.lt\("last_used_at", staleBefore\)/);
  assert.match(source, /session\.revoked_at/);
  assert.match(source, /expiresAt <= Date\.now\(\)/);
});
