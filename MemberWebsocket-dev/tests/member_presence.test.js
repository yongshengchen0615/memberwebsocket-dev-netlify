const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const shared = fs.readFileSync(path.join(root, 'member-system.js'), 'utf8');
const booking = fs.readFileSync(path.join(root, 'booking', 'common.js'), 'utf8');
const bookingFresh = fs.readFileSync(path.join(root, 'booking', 'liff-fresh-login.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'supabase', 'functions', 'api', 'index.ts'), 'utf8');

test('server recognizes online, heartbeat and offline actions for every member-facing surface', () => {
  for (const action of [
    'user.member.presence.online', 'user.member.presence.heartbeat', 'user.member.presence.offline',
    'user.pointcard.presence.online', 'user.pointcard.presence.heartbeat', 'user.pointcard.presence.offline',
    'user.event.presence.online', 'user.event.presence.heartbeat', 'user.event.presence.offline',
    'user.calendar.presence.online', 'user.calendar.presence.heartbeat', 'user.calendar.presence.offline',
    'user.booking.presence.online', 'user.booking.presence.heartbeat', 'user.booking.presence.offline',
  ]) assert.ok(api.includes(action), action);

  assert.match(api, /type ClientType = "member" \| "points" \| "event" \| "calendar" \| "booking" \| "admin"/);
  assert.match(api, /booking: "LINE_MEMBER_CHANNEL_ID"/);
  assert.match(api, /const presence = presenceActionInfo\(action\)/);
});

test('presence events remain authenticated server-side and append only minimal audit detail', () => {
  const identityPosition = api.indexOf('identity = await verifyLineIdToken(idToken,clientType,action.endsWith(".session.claim"));');
  const actionPosition = api.indexOf('const presence = presenceActionInfo(action);', api.indexOf('async function handleAction'));
  assert.ok(identityPosition >= 0);
  assert.ok(actionPosition >= 0);

  assert.match(api, /actor_role:"member"/);
  assert.match(api, /target_type:"member"/);
  assert.match(api, /detail:\{ sessionId,surface:presence\.surface,reason \}/);
  assert.doesNotMatch(api, /detail:\{[^}]*idToken/s);
  assert.doesNotMatch(api, /detail:\{[^}]*testSessionToken/s);
  assert.match(api, /\["signin","logout","pagehide","hidden","bfcache","resume","relogin","heartbeat"\]/);
});

test('online and offline presence changes notify admin while heartbeat avoids realtime fanout', () => {
  assert.match(api, /if \(presence\.event === "heartbeat"\) return;/);
  assert.match(api, /scope:"admin",event_type:action/);
});

test('online status aggregates every active client session for the same member', () => {
  const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260920143801_member_presence_realtime_tracking.sql'), 'utf8');
  assert.match(migration, /unique \(member_id, session_id\)/);
  assert.match(api, /from\("member_presence_sessions"\)/);
  assert.match(api, /\.is\("offline_at",null\)/);
  assert.match(api, /\.gte\("last_seen_at",presenceCutoff\)/);
  assert.match(api, /isOnline:Boolean\(presence\)/);
  assert.match(api, /admin\.members\.presence\.list/);
});

test('shared member client records sign in, logout, page leave and BFCache resume', () => {
  assert.match(shared, /await startPresence\(config, surface, idToken\)/);
  assert.match(shared, /window\.addEventListener\('pagehide'/);
  assert.match(shared, /stopPresence\(event && event\.persisted \? 'bfcache' : 'pagehide', true\)/);
  assert.match(shared, /window\.addEventListener\('pageshow'/);
  assert.match(shared, /startPresence\(previous\.config, previous\.surface, currentPresenceIdToken\(previous\), 'resume'\)/);
  assert.match(shared, /stopPresence\('logout', true\)/);
  assert.match(shared, /keepalive: true/);
  assert.match(shared, /1200, '上線紀錄逾時。'/);
  assert.match(shared, /PRESENCE_HEARTBEAT_MS = 30_000/);
  assert.match(shared, /\.heartbeat'/);
  assert.doesNotMatch(shared, /presenceContext\.closed \|\| document\.visibilityState === 'hidden'/);
});

test('booking fresh login path cannot bypass presence tracking', () => {
  assert.match(booking, /window\.BookingSystem = \{ loadConfig, signIn, completeSignIn, startPresence,/);
  assert.match(booking, /if \(clientType === 'booking'\) await startPresence\(config, clientType, token\)/);
  assert.match(booking, /user\.booking\.presence\.' \+ event/);
  assert.match(booking, /keepalive: true/);
  assert.match(booking, /stopPresence\('logout'\)/);
  assert.match(bookingFresh, /window\.BookingSystem\.completeSignIn\(config, 'booking', idToken\)/);
  assert.match(booking, /authenticatedSession = \{ config, idToken: token \}/);
  assert.match(booking, /PRESENCE_HEARTBEAT_MS = 30_000/);
  assert.match(booking, /sendPresence\(context, 'heartbeat', 'heartbeat'\)/);
});

test('presence session IDs use browser cryptographic randomness', () => {
  assert.match(shared, /crypto\.randomUUID/);
  assert.match(shared, /crypto\.getRandomValues/);
  assert.doesNotMatch(shared, /Math\.random\(\)/);
  assert.match(booking, /crypto\.randomUUID/);
  assert.match(booking, /crypto\.getRandomValues/);
});

test('LINE WebView hidden/page close sends an offline beacon and visible resume starts a fresh session', () => {
  for (const client of [shared, booking]) {
    assert.match(client, /document\.addEventListener\('visibilitychange'/);
    assert.match(client, /if \(document\.visibilityState !== 'visible'\) \{/);
    assert.match(client, /stopPresence\('hidden'/);
    assert.match(client, /if \(context\.closed\) \{/);
    assert.match(client, /presenceContext = null;\s+void startPresence\(/);
    assert.match(client, /navigator\.sendBeacon\(endpoint, beacon(?:Body)?\)/);
    assert.match(client, /text\/plain;charset=UTF-8/);
    assert.match(client, /keepalive: true/);
  }
  assert.match(fs.readFileSync(path.join(root, 'admin', 'app.js'), 'utf8'), /hidden:'LINE 頁面轉入背景或關閉'/);
});

test('exit beacon leaves tokens in authenticated POST body, never a query string', () => {
  assert.match(shared, /idToken: currentPresenceIdToken\(context\)/);
  assert.match(booking, /idToken: currentPresenceIdToken\(context\)/);
  assert.doesNotMatch(shared, /endpoint\s*\+\s*['"].*idToken/);
  assert.doesNotMatch(booking, /endpoint\s*\+\s*['"].*idToken/);
});
