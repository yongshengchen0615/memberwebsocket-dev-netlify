const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const sql = read('supabase/migrations/20261008083358_test_account_duplicate_login_setting.sql');
const takeoverSql = read('supabase/migrations/20261008091007_test_login_takeover_single_session.sql');

test('duplicate-login is explicitly admin controlled and disabled by default', () => {
  const html = read('admin/index.html');
  const ui = read('admin/test-mode.js');
  const api = read('supabase/functions/test-mode-api/index.ts');
  assert.match(html, /id="testModeDuplicateLoginEnabled"/);
  assert.match(html, /測試強制登出/);
  assert.match(html, /新登入成功會撤銷舊 Session/);
  assert.match(html, /正式會員不受影響/);
  assert.match(ui, /allowDuplicateTestLogin: els\.testModeDuplicateLoginEnabled\.checked/);
  assert.match(ui, /settings\.allowDuplicateTestLogin/);
  assert.match(api, /"admin\.test-mode\.save"/);
  assert.match(api, /await authorizeAdmin\(supabase, identity\)/);
  assert.match(api, /admin_save_maintenance_test_access_v2/);
  assert.match(api, /p_allow_duplicate_test_login: asBoolean\(body\.allowDuplicateTestLogin\)/);
  assert.match(sql, /allow_duplicate_test_login boolean NOT NULL DEFAULT false/i);
  assert.match(sql, /SECURITY INVOKER/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.admin_save_maintenance_test_access_v2/);
});

test('session issuance ignores untrusted toggle inputs and is virtual-member-only', () => {
  const api = read('supabase/functions/test-mode-api/index.ts');
  const client = read('test-mode-client.js');
  assert.match(api, /create_test_login_session_v3/);
  assert.match(api, /allowDuplicateTestLogin: row\.allow_duplicate_test_login === true/);
  assert.match(client, /const unavailable = inUse && !allowDuplicateTestLogin/);
  assert.match(client, /新登入將踢除舊連線/);
  assert.match(client, /test_mode\.session\.started/);
  assert.match(client, /SESSION_REPLACED/);
  assert.doesNotMatch(client, /可重複登入/);
  assert.match(client, /result\.allowDuplicateTestLogin === true/);
  assert.match(sql, /is_test_account IS TRUE/);
  assert.match(sql, /v_allow_duplicate/);
  assert.match(sql, /WHERE id = true FOR SHARE/);
  assert.match(sql, /TEST_SURFACE_ALREADY_ACTIVE/);
  assert.match(sql, /PARTITION BY member_id, surface/);
  assert.match(sql, /revoked_at = clock_timestamp\(\)/);
  assert.match(takeoverSql, /revoked_reason = 'replaced_by_new_login'/);
  assert.match(takeoverSql, /UPDATE public\.member_presence_sessions/);
  assert.match(takeoverSql, /INSERT INTO public\.realtime_events\(scope,event_type\)/);
  assert.doesNotMatch(api, /await emitTestModeEvent\(supabase, "test_mode\.session\.started"\)/);
  assert.match(takeoverSql, /UPDATE public\.test_login_sessions[\s\S]*?INSERT INTO public\.test_login_sessions/);
  assert.match(read('supabase/functions/_shared/test-mode-auth.ts'), /"SESSION_REPLACED"/);
  assert.match(read('supabase/functions/api/index.ts'), /revoked_reason:"admin_force_logout"/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.create_test_login_session_v3/);
  assert.doesNotMatch(api, /p_allow_duplicate_test_login: asBoolean\(body\.[^)]*\)\s*,\s*p_token_hash/);
  assert.match(read('supabase/functions/_shared/auth-contract.ts'), /LINE/);
});

test('all five user surfaces load the updated selector and admin cache is refreshed', () => {
  assert.match(read('admin/index.html'), /test-mode\.js\?v=test-login-takeover-20261008-2/);
  for (const surface of ['member','points','event','calendar','booking']) {
    assert.match(read(surface + '/index.html'), /test-mode-client\.js\?v=test-login-takeover-20261008-2/);
  }
});
