const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'admin', 'app.js'), 'utf8');
const start = source.indexOf('  function mergeNewerPresenceObservations(');
const end = source.indexOf('  function refreshData(showBusy)', start);
assert.ok(start !== -1 && end > start, 'presence reconciliation functions must exist');
const functions = source.slice(start, end);

function harness(responses = []) {
  const calls = [];
  const state = {
    config: { api: 'test' },
    idToken: 'test',
    memberKind: 'real',
    members: [{ lineUserId: 'line-1', isOnline: false, lastSeenAt: '', onlineSurfaces: [] }],
  };
  let renders = 0;
  const ctx = {
    state,
    Date,
    Map,
    window: { MemberSystem: { request(_config, _clientType, _token, action, body) {
      assert.equal(action, 'admin.members.presence.list');
      assert.deepEqual(Array.from(body.lineUserIds), ['line-1']);
      calls.push(action);
      const next = responses.shift();
      if (!next) throw Error('unexpected presence request');
      return next;
    } } },
    renderMembers() { renders++; },
  };
  const exported = vm.runInNewContext(
    'let memberPresencePollPending = false; let memberPresencePollQueued = false;' +
    'let memberPresencePageVersion = 0;' +
    'const memberPresenceObservations = new Map();' +
    functions +
    '({ refreshMemberPresence, mergeNewerPresenceObservations, memberPresenceObservations, ' +
    'markMemberPageApplied() { memberPresencePageVersion++; } })',
    ctx
  );
  return { ...exported, state, calls, get renders() { return renders; } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('slow bootstrap must not overwrite a presence request that started later', () => {
  const ctx = harness();
  const now = Date.now();
  ctx.memberPresenceObservations.set('line-1', {
    requestStartedAt: now + 10, isOnline: true, lastSeenAt: '2026-10-13T00:00:00Z',
    onlineSurfaces: ['points'],
  });
  const old = [{ lineUserId: 'line-1', isOnline: false, lastSeenAt: '', onlineSurfaces: [] }];
  assert.equal(ctx.mergeNewerPresenceObservations(old, now)[0].isOnline, true);
  assert.equal(ctx.mergeNewerPresenceObservations(old, now + 20)[0].isOnline, false,
    'a newer bootstrap response is allowed to replace an older observation');
});

test('presence refresh requested while another is pending is replayed, not lost', async () => {
  const first = deferred();
  const second = deferred();
  const ctx = harness([first.promise, second.promise]);
  const current = ctx.refreshMemberPresence();
  await ctx.refreshMemberPresence(); // Must queue a second request.
  first.resolve({ members: [{ lineUserId: 'line-1', isOnline: true,
    lastSeenAt: '2026-10-13T00:00:00Z', onlineSurfaces: ['points'] }] });
  await current;
  assert.equal(ctx.calls.length, 2, 'queued refresh starts as first finishes');
  second.resolve({ members: [{ lineUserId: 'line-1', isOnline: false,
    lastSeenAt: '', onlineSurfaces: [] }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.state.members[0].isOnline, false);
  assert.equal(ctx.renders, 2);
});

test('older in-flight presence responses cannot roll back a freshly applied member list', async () => {
  const first = deferred();
  const second = deferred();
  const ctx = harness([first.promise, second.promise]);
  const older = ctx.refreshMemberPresence();
  // A newer bootstrap has returned online=true while the old poll is in flight.
  ctx.state.members[0].isOnline = true;
  ctx.markMemberPageApplied();
  const newest = ctx.refreshMemberPresence(); // queued behind the old poll
  first.resolve({ members: [{ lineUserId: 'line-1', isOnline: false,
    lastSeenAt: '', onlineSurfaces: [] }] });
  await older;
  await newest;
  assert.equal(ctx.state.members[0].isOnline, true, 'old poll must be discarded');
  second.resolve({ members: [{ lineUserId: 'line-1', isOnline: true,
    lastSeenAt: '2026-10-13T00:00:00Z', onlineSurfaces: ['points'] }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.state.members[0].isOnline, true);
});

test('missing or malformed response must not mark an online member offline', async () => {
  const ctx = harness([Promise.resolve({})]);
  ctx.state.members[0].isOnline = true;
  await assert.rejects(ctx.refreshMemberPresence(), /回應不完整/);
  assert.equal(ctx.state.members[0].isOnline, true);
});

test('presence query for a previous member tab cannot overwrite the new tab', async () => {
  const first = deferred();
  const ctx = harness([first.promise]);
  const pending = ctx.refreshMemberPresence();
  ctx.state.memberKind = 'test';
  ctx.state.members = [{ lineUserId: 'test-1', isOnline: false,
    lastSeenAt: '', onlineSurfaces: [] }];
  first.resolve({ members: [{ lineUserId: 'line-1', isOnline: true,
    lastSeenAt: '2026-10-13T00:00:00Z', onlineSurfaces: ['points'] }] });
  await pending;
  assert.equal(ctx.state.members[0].lineUserId, 'test-1');
  assert.equal(ctx.state.members[0].isOnline, false);
});

test('admin triggers an immediate refresh when the tab becomes visible', () => {
  assert.match(source, /document\.addEventListener\('visibilitychange',[\s\S]*?refreshMemberPresence\(\)/);
  assert.match(source, /mergeNewerPresenceObservations\(result\.members, requestStartedAt\)/);
});
