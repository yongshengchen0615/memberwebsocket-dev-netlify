const { test } = require('node:test');
const assert = require('node:assert/strict');
const { realtimeLifecycleHarness: harness } = require('./helpers/realtime-lifecycle-harness.cjs');

for (const kind of ['member', 'booking']) {
  test(`AC-001 ${kind}: retired channel events and status have no effects`, async () => {
    const h = harness(kind); let updates = 0, benefits = 0;
    const stop = h.subscribe(() => updates++, h.config, () => benefits++), old = h.channels[0];
    old.status('SUBSCRIBED'); stop(); h.notifications.length = 0;
    for (let i = 0; i < 100; i++) {
      old.change({ new: { scope: 'all', event_type: 'booking.changed' } });
      old.status('SUBSCRIBED');
    }
    await h.tick(60000);
    assert.equal(h.notifications.length, 0, 'a retired channel cannot emit global invalidations/status');
    assert.equal(updates, 0); assert.equal(benefits, 0);
    assert.equal(h.activeChannels, 0); assert.equal(h.listenerCount, 0); assert.equal(h.intervals.size, 0);
  });

  test(`AC-002 ${kind}: pagehide releases the socket and recovery waits for teardown exactly once`, async () => {
    const h = harness(kind); let updates = 0;
    const stop = h.subscribe(() => updates++), old = h.channels[0];
    old.status('SUBSCRIBED'); h.holdRemoval(); h.emit('pagehide');
    assert.equal(h.activeChannels, 0, 'pagehide must release its channel');
    old.change({ new: { scope: 'all', event_type: 'booking.changed' } });
    for (const fn of h.intervals.values()) fn();
    await h.tick(60000); assert.equal(updates, 0);
    for (let i = 0; i < 20; i++) { h.emit('pageshow'); h.emit('online'); }
    assert.equal(h.channels.length, 1, 'do not join a replacement while SDK removal is unresolved');
    await h.finishRemoval(); assert.equal(h.channels.length, 2); assert.equal(h.activeChannels, 1);
    h.channels[1].status('SUBSCRIBED'); await h.tick(2000);
    assert.equal(updates, 1, 'the recovery burst shares one authoritative refresh');
    h.notifications.length = 0; old.status('CLOSED'); old.change({ new: { scope: 'all' } });
    assert.equal(h.notifications.length, 0, 'old generation cannot affect the replacement');
    stop(); await h.tick(); assert.equal(h.activeChannels, 0); assert.equal(h.listenerCount, 0);
  });

  test(`AC-002 ${kind}: offline sockets pause and hidden pages defer reconnect until visible`, async () => {
    const h = harness(kind); const stop = h.subscribe();
    h.navigator.onLine = false; h.emit('offline');
    assert.equal(h.activeChannels, 0);
    h.document.visibilityState = 'hidden'; h.navigator.onLine = true; h.emit('online'); await h.tick();
    assert.equal(h.channels.length, 1);
    h.document.visibilityState = 'visible'; h.emit('visibilitychange', true); await h.tick();
    assert.equal(h.channels.length, 2); assert.equal(h.activeChannels, 1);
    stop();
  });

  test(`AC-002 ${kind}: disposal while channel removal is pending cannot reopen`, async () => {
    const h = harness(kind); const stop = h.subscribe(); h.holdRemoval(); h.emit('pagehide');
    stop(); h.emit('pageshow'); await h.finishRemoval(); await h.tick(60000);
    assert.equal(h.channels.length, 1); assert.equal(h.activeChannels, 0);
    assert.equal(h.listenerCount, 0); assert.equal(h.intervals.size, 0);
  });

  test(`AC-002 ${kind}: SDK failure during deferred reconnect is contained and the next recovery can succeed`, async () => {
    const h = harness(kind), stop = h.subscribe(); h.holdRemoval(); h.emit('pagehide');
    h.emit('pageshow'); h.failChannels(true); await h.finishRemoval();
    await new Promise(setImmediate);
    assert.equal(h.activeChannels, 0);
    h.failChannels(false); h.emit('online'); await h.tick();
    assert.equal(h.activeChannels, 1); stop();
  });
  test(`AC-002 ${kind}: fully stopped subscriptions do not retain a stale pagehide flag`, async () => {
    const h = harness(kind), stop = h.subscribe(); h.emit('pagehide'); stop(); await h.tick();
    h.emit('pageshow');
    const next = h.subscribe(); await h.tick();
    assert.equal(h.activeChannels, 1); next();
  });
}

test('AC-003 member: disabling realtime releases the previous enabled subscription', () => {
  const h = harness('member'), stop = h.subscribe();
  h.subscribe(() => {}, { ...h.config, realtimeEnabled: false });
  assert.equal(h.activeChannels, 0); assert.equal(h.listenerCount, 0); stop();
});

test('AC-003 member: a replacement inherits pagehide and pending SDK removal', async () => {
  const h = harness('member'), stop = h.subscribe(); h.holdRemoval(); h.emit('pagehide');
  const replacement = h.subscribe(() => {}, { ...h.config, supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/another-api' });
  assert.equal(h.channels.length, 1, 'replacement must inherit the page suspension');
  h.emit('pageshow'); assert.equal(h.channels.length, 1, 'replacement must wait for the previous subscription removal');
  await h.finishRemoval(); assert.equal(h.channels.length, 2); assert.equal(h.activeChannels, 1);
  stop(); assert.equal(h.activeChannels, 1); replacement();
});

for (const [field, value] of [['supabasePublishableKey', 'another-public-key'], ['business', 'shop-b'],
  ['supabaseFunctionUrl', 'https://fixture.supabase.co/functions/v1/another-api']]) {
  test(`AC-003 member: changing ${field} replaces the previous surface subscription`, () => {
    const h = harness('member'), stop = h.subscribe();
    const replacement = h.subscribe(() => {}, { ...h.config, [field]: value });
    assert.notEqual(stop, replacement);
    assert.equal(h.channels[0].removed, true);
    stop(); replacement(); assert.equal(h.listenerCount, 0);
  });
}
