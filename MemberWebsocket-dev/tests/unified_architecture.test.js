const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('member surfaces use one browser core without runtime monkey patches', () => {
  for (const entry of ['admin/index.html', 'member/index.html', 'points/index.html', 'event/index.html', 'calendar/index.html']) {
    const html = read(entry);
    assert.match(html, /\.\.\/member-system\.js\?v=[^"'\\s>]+/);
    assert.equal((html.match(/member-system\.js/g) || []).length, 1, entry);
    assert.doesNotMatch(html, /\.\/common\.js/);
    assert.doesNotMatch(html, /realtime-resync\.js/);
    assert.doesNotMatch(html, /tier-sync\.js/);
  }

  for (const legacy of [
    'admin/common.js',
    'member/common.js',
    'points/common.js',
    'event/common.js',
    'calendar/common.js',
    'realtime-resync.js',
    'calendar/tier-sync.js',
  ]) {
    assert.equal(fs.existsSync(path.join(root, legacy)), false, legacy);
  }
});

test('shared browser core owns API routing and realtime lifecycle', () => {
  const source = read('member-system.js');
  assert.match(source, /function requestEndpoint\(/);
  assert.match(source, /memberCalendarFunctionUrl/);
  assert.match(source, /table: 'realtime_events'/);
  assert.match(source, /addEventListener\('visibilitychange'/);
  assert.match(source, /addEventListener\('online'/);
  assert.doesNotMatch(source, /loadBookingAdminPanelExtension/);
  assert.doesNotMatch(source, /booking-workbench/);
});

test('calendar backend returns final display contract', () => {
  const config = JSON.parse(read('config.json'));
  assert.match(config.memberCalendarFunctionUrl, /\/functions\/v1\/member-calendar-api$/);

  const source = read('supabase/functions/member-calendar-api/index.ts');
  assert.match(source, /verifyWithCoreApi/);
  assert.match(source, /decorateTierEligibility/);
  assert.match(source, /allowedTierLabels/);
  assert.match(source, /tierEligible/);
  assert.match(source, /applyCalendarDisplayRules/);
  assert.match(source, /calendarDisplaySourceId/);
});


test('admin authentication has one LIFF owner and one shared session broker', () => {
  const adminDir = path.join(root, 'admin');
  const adminJsFiles = fs.readdirSync(adminDir).filter((name) => name.endsWith('.js'));
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const session = read('admin/admin-session.js');

  assert.match(html, /admin-session\.js\?v=admin-session-20260919-1/);
  assert.ok(html.indexOf('admin-session.js') < html.indexOf('pointcard-redemption-limit.js'));
  assert.ok(html.indexOf('admin-session.js') < html.indexOf('app.js'));
  assert.match(app, /MemberSystem\.signIn\(state\.config, 'admin'\)/);
  assert.match(app, /MemberAdminSession\.establish/);
  assert.match(session, /function wait\(/);
  assert.match(session, /function establish\(/);
  assert.doesNotMatch(session, /liff\.init|getIDToken|window\.liff/);

  for (const name of adminJsFiles) {
    const source = read(`admin/${name}`);
    assert.doesNotMatch(source, /window\.liff|getIDToken|liff\.init/, name);
    if (name !== 'app.js') assert.doesNotMatch(source, /MemberSystem\.signIn/, name);
  }
});
