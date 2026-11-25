const { test } = require('node:test'), assert = require('node:assert/strict');
const { frontdeskSyncHarness: harness } = require('./helpers/frontdesk-sync-harness.cjs');

for (const suspended of ['hidden', 'offline']) {
  test(`AC-004 frontdesk: definitive denial while ${suspended} still clears current private access`, async () => {
    const h = harness(); h.start(); await h.tick();
    if (suspended === 'hidden') { h.document.visibilityState = 'hidden'; h.emit('visibilitychange', true); }
    else { h.navigator.onLine = false; h.emit('offline'); }
    h.probes[0].reject({ code: 'FRONTDESK_AUTH_INVALID', denied: true }); await h.tick();
    assert.equal(h.failures.length, 1);
    h.document.visibilityState = 'visible'; h.navigator.onLine = true;
    h.emit('visibilitychange', true); h.emit('online'); await h.tick(60000);
    assert.equal(h.probes.length, 1); assert.equal(h.timers.size, 0);
  });
  test(`AC-004 frontdesk: ${suspended} invalidates a pending probe and recovery reads exactly once`, async () => {
    const h = harness(); h.start(); await h.tick();
    if (suspended === 'hidden') { h.document.visibilityState = 'hidden'; h.emit('visibilitychange', true); }
    else { h.navigator.onLine = false; h.emit('offline'); }
    await h.tick(60000); assert.equal(h.probes.length, 1);
    h.document.visibilityState = 'visible'; h.navigator.onLine = true;
    for (let i = 0; i < 20; i++) { h.emit('visibilitychange', true); h.emit('online'); h.emit('focus'); }
    await h.tick();
    h.probes[0].resolve({ revision: '1' }); await h.tick();
    assert.equal(h.loads.length, 0, 'pre-suspension authority must not repaint the current view');
    assert.equal(h.probes.length, 2, 'one fresh recovery must follow the stale request');
    h.probes[1].resolve({ revision: '2' }); await h.tick(); assert.equal(h.loads.length, 1);
    await h.tick(2999); assert.equal(h.probes.length, 2);
    await h.tick(1); assert.equal(h.probes.length, 3); h.stop();
  });
}

test('AC-004 frontdesk: a replaced credential cannot be revoked by an old probe denial', async () => {
  const h = harness(); h.start(); await h.tick();
  h.context.idToken = 'replacement-staff';
  h.probes[0].reject({ code: 'FRONTDESK_AUTH_INVALID', denied: true }); await h.tick();
  assert.equal(h.failures.length, 0); h.stop();
});

test('AC-004 frontdesk: foreground event bursts share a current probe without a trailing request', async () => {
  const h = harness(); h.start(); await h.tick();
  for (let i = 0; i < 100; i++) { h.emit('online'); h.emit('focus'); h.emit('visibilitychange', true); }
  h.probes[0].resolve({ revision: '1' }); await h.tick();
  assert.equal(h.probes.length, 1); assert.equal(h.loads.length, 1); h.stop();
});

test('AC-004 frontdesk: events during a slow full refresh retain one immediate trailing probe', async () => {
  const h = harness(); h.holdLoad(); h.start(); await h.tick();
  h.probes[0].resolve({ revision: '1' }); await h.tick();
  for (let i = 0; i < 20; i++) h.emit('focus');
  await h.tick(); await h.finishLoad(); await h.tick();
  assert.equal(h.probes.length, 2); h.stop();
});

test('AC-004 frontdesk: stop clears recovery; a delayed response cannot restart synchronization', async () => {
  const h = harness(); h.start(); await h.tick();
  h.navigator.onLine = false; h.emit('offline'); h.navigator.onLine = true; h.emit('online');
  h.stop(); h.probes[0].resolve({ revision: '1' }); await h.tick(60000);
  assert.equal(h.loads.length, 0); assert.equal(h.probes.length, 1); assert.equal(h.timers.size, 0);
});

test('AC-004 frontdesk: denied access stops recovery and a service failure retains bounded backoff', async () => {
  const denied = harness(); denied.start(); await denied.tick();
  denied.probes[0].reject({ code: 'FRONTDESK_REVIEW_REQUIRED', denied: true }); await denied.tick(60000);
  assert.equal(denied.probes.length, 1); assert.equal(denied.failures.length, 1);
  const unavailable = harness(); unavailable.start(); await unavailable.tick();
  unavailable.probes[0].reject({ code: 'SERVICE_UNAVAILABLE' }); await unavailable.tick(5999);
  assert.equal(unavailable.probes.length, 1); await unavailable.tick(1); assert.equal(unavailable.probes.length, 2); unavailable.stop();
});
