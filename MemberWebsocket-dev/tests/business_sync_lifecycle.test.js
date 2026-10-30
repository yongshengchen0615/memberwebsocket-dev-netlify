const { test } = require('node:test');
const assert = require('node:assert/strict');
const { businessSyncHarness, flush } = require('./helpers/business-sync-harness.cjs');

for (const kind of ['member', 'booking']) {
  test(`AC-001 ${kind}: resume bursts share an in-flight revision read`, async () => {
    const h = await businessSyncHarness(kind);
    h.holdProbes(); const stop = h.subscribe();
    try {
      await h.tick(); assert.equal(h.probes.length, 1);
      for (let i = 0; i < 20; i++) { h.emit('pageshow'); h.emit('online'); h.emit('visibilitychange', true); }
      h.holdProbes(false); h.probes[0].resolve(); await h.tick();
      assert.equal(h.probes.length, 1, 'same foreground generation must not add a trailing request');
      assert.equal(h.updates.length, 1);
      await h.tick(kind === 'booking' ? 3000 : 10000); assert.equal(h.probes.length, 2);
    } finally { stop(); }
  });
  test(`AC-002 ${kind}: late hidden response does not refresh and foreground rechecks authority`, async () => {
    const h = await businessSyncHarness(kind);
    h.holdProbes(); const stop = h.subscribe();
    try {
      await h.tick(); h.document.visibilityState = 'hidden'; h.emit('visibilitychange', true);
      h.probes[0].resolve(); await h.tick(30000);
      assert.equal(h.updates.length, 0, 'background response cannot reload the view');
      assert.equal(h.probes.length, 1);
      h.setRevision('changed'); h.holdProbes(false);
      h.document.visibilityState = 'visible'; h.emit('visibilitychange', true); await h.tick();
      assert.deepEqual(h.updates, ['changed']);
      assert.equal(h.probes.length, 2, 'resumed probe consumes the queued recovery');
    } finally { stop(); }
  });
  test(`AC-002 ${kind}: hide/show before a response forces exactly one fresh probe`, async () => {
    const h = await businessSyncHarness(kind);
    h.holdProbes(); const stop = h.subscribe();
    try {
      await h.tick(); h.document.visibilityState = 'hidden'; h.emit('visibilitychange', true);
      h.document.visibilityState = 'visible'; h.emit('visibilitychange', true); h.emit('pageshow');
      h.setRevision('new'); h.holdProbes(false); h.probes[0].resolve(); await h.tick();
      assert.equal(h.probes.length, 2); assert.deepEqual(h.updates, ['new']);
    } finally { stop(); }
  });
  test(`AC-003 ${kind}: pagehide stops polling and pageshow resumes without visibility events`, async () => {
    const h = await businessSyncHarness(kind), stop = h.subscribe();
    try {
      await h.tick(); h.emit('pagehide'); await h.tick(60000);
      assert.equal(h.probes.length, 1);
      h.setRevision('restored'); h.emit('pageshow'); await h.tick();
      assert.deepEqual(h.updates, ['initial', 'restored']);
    } finally { stop(); }
  });
  test(`AC-003 ${kind}: offline responses are discarded and unsubscribe cancels recovery`, async () => {
    const h = await businessSyncHarness(kind);
    h.holdProbes(); const stop = h.subscribe();
    await h.tick(); h.navigator.onLine = false; h.emit('offline');
    h.probes[0].resolve(); await h.tick(60000); assert.equal(h.updates.length, 0);
    stop(); h.navigator.onLine = true; h.emit('online'); await h.tick(60000);
    assert.equal(h.probes.length, 1);
  });
  test(`AC-004 ${kind}: a changed revision during a slow refresh retains one trailing check`, async () => {
    const h = await businessSyncHarness(kind); h.holdUpdates(); const stop = h.subscribe();
    try {
      await h.tick(); h.setRevision('during-refresh'); h.emit('pageshow'); h.emit('online');
      h.holdUpdates(false); h.finishUpdate(); await flush(); await h.tick();
      assert.equal(h.probes.length, 2); assert.deepEqual(h.updates, ['initial', 'during-refresh']);
    } finally { stop(); }
  });
}
test('AC-005 booking: subscriptions isolate businesses and cleanup preserves the other shop', async () => {
  const h = await businessSyncHarness('booking');
  const stopA = h.subscribe(), stopB = h.subscribe({ ...h.config, business: 'shop-b' });
  try {
    assert.notEqual(stopA, stopB);
    await h.tick(); assert.deepEqual(h.probes.map(p => p.body.business).sort(), ['shop-a', 'shop-b']);
    stopA(); await h.tick(3000);
    assert.deepEqual(h.probes.map(p => p.body.business), ['shop-a', 'shop-b', 'shop-b']);
  } finally { stopA(); stopB(); }
});
test('AC-003 booking: disposal during refresh suppresses the late benefits callback', async () => {
  const h = await businessSyncHarness('booking'); h.holdUpdates(); const stop = h.subscribe();
  await h.tick(); stop(); h.finishUpdate(); await flush();
  assert.equal(h.benefits.length, 0);
});

test('AC-006 booking: visible shop detects a changed booking revision within 3 seconds without repeated full reads', async () => {
  const h = await businessSyncHarness('booking');
  const stop = h.subscribe();
  try {
    await h.tick(0);
    assert.deepEqual(h.updates, ['initial']);
    h.setRevision('manager-booking-created');
    await h.tick(2999);
    assert.deepEqual(h.updates, ['initial'], 'a poll must not start before the bounded delay');
    await h.tick(1);
    assert.deepEqual(h.updates, ['initial', 'manager-booking-created']);
    const observed = h.updates.length;
    await h.tick(3000);
    assert.equal(h.updates.length, observed, 'unchanged revisions do not re-fetch booking pages');
    h.document.visibilityState = 'hidden';
    h.emit('visibilitychange', true);
    await h.tick(30000);
    assert.equal(h.updates.length, observed, 'hidden windows must not poll or load member booking details');
    h.setRevision('admin-booking-cancelled');
    h.document.visibilityState = 'visible';
    h.emit('visibilitychange', true);
    await h.tick(0);
    assert.equal(h.updates.at(-1), 'admin-booking-cancelled');
  } finally { stop(); }
});
