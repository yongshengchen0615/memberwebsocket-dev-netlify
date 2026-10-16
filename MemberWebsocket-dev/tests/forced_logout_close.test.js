const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

for (const [label, relative] of [
  ['member core', 'member-system.js'],
  ['booking core', 'booking/common.js'],
]) {
  test(`${label} alerts before closing the LIFF window on forced logout`, () => {
    const source = read(relative);
    assert.match(source, /SESSION_REVOKED/);
    assert.match(source, /function terminateAccessSession\(/);
    const helperStart = source.indexOf('function terminateAccessSession(');
    const helper = source.slice(helperStart, source.indexOf('\n  async function logout()', helperStart));
    assert.ok(helper.includes('window.alert(notice)'));
    assert.ok(helper.includes('window.liff.logout()'));
    assert.ok(helper.includes('window.liff.closeWindow()'));
    assert.ok(helper.indexOf('window.alert(notice)') < helper.indexOf('window.liff.closeWindow()'));
    assert.ok(helper.includes('window.close()'));
  });
}


test('admin force logout keeps admin surface but revokes the same identity on user surfaces', () => {
  const auth = read('supabase/functions/_shared/auth-contract.ts');
  const api = read('supabase/functions/api/index.ts');
  assert.match(auth, /const adminChannelId =/);
  assert.match(auth, /const canBypassUserRestrictions = isActiveAdmin && expectedChannelId === adminChannelId/);
  assert.match(auth, /if \(!canBypassUserRestrictions && revokedAtMs > 0/);
  assert.doesNotMatch(api, /SELF_FORCE_LOGOUT_BLOCKED/);
  assert.match(api, /\["member","points","event","calendar","booking","admin"\]/);
});


test('force logout admin handler refreshes the current member page without an undefined helper', () => {
  const source = read('admin/app.js');
  assert.doesNotMatch(source, /refreshMembers\(\)/);
  assert.match(source, /loadMembersPage\(state\.memberPage\.page, state\.memberPage\.query\)/);
});


test('test users map revoked sessions to forced logout and close immediately', () => {
  const auth = read('supabase/functions/_shared/test-mode-auth.ts');
  const client = read('test-mode-client.js');
  assert.match(auth, /session\.revoked_at/);
  assert.match(auth, /SESSION_REVOKED/);
  assert.match(client, /eventType === 'admin\.member\.force-logout'/);
  assert.match(client, /sessionStatus\(config, realtimeSurface\)/);
  assert.match(client, /terminateForcedTestSession\(error\.message\)/);
  assert.match(client, /window\.alert\(notice\)/);
  assert.match(client, /window\.liff\.closeWindow\(\)/);
  assert.match(client, /window\.close\(\)/);
});


test('test client revalidates a test session after Realtime reconnect', () => {
  const client = read('test-mode-client.js');
  assert.match(client, /subscribe\(\(status\) =>/);
  assert.match(client, /status !== 'SUBSCRIBED'/);
  assert.match(client, /sessionStatus\(config, realtimeSurface\)/);
  assert.match(client, /SESSION_REVOKED/);
});


test('test client filters forced logout realtime events to the active test surface', () => {
  const client = read('test-mode-client.js');
  assert.match(client, /const scope = String\(row\.scope \|\| ''\)/);
  assert.match(client, /scope === 'all' \|\| scope === realtimeSurface/);
});
