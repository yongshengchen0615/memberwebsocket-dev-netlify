const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpers = Promise.all([
  import('../supabase/functions/_shared/booking-notification-wake.mjs'),
  import('../supabase/functions/_shared/notification-batches.mjs'),
]);

function bookingInput(dispatch, changes = {}) {
  return {
    name: 'booking-api',
    context: { id: 'trusted-tenant' },
    body: { action: 'admin.booking.status.update', recipient: 'forged-recipient' },
    response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
    dispatch,
    ...changes,
  };
}

test('AC-LINE-001: committed booking response does not await the outbox wake RPC when EdgeRuntime tracks it', async () => {
  const [{ scheduleBookingNotificationWake }] = await helpers;
  const tenants = [];
  let unblock;
  const slow = new Promise(resolve => { unblock = resolve; });
  let tracked;
  const completed = await scheduleBookingNotificationWake(
    bookingInput(async tenant => { tenants.push(tenant); return slow; }),
    task => { tracked = task; },
  );
  assert.equal(completed, true, 'background registration must return without waiting for dispatch');
  assert.ok(tracked instanceof Promise, 'registered task must remain tracked until settled');
  assert.deepEqual(tenants, ['trusted-tenant'], 'trusted outbox wake starts immediately');
  unblock({ data: true, error: null });
  assert.equal(await tracked, true);
  assert.deepEqual(tenants, ['trusted-tenant'], 'never forward caller-supplied recipients');
});

test('AC-LINE-002: no background runtime preserves durable synchronous wake fallback', async () => {
  const [{ scheduleBookingNotificationWake }] = await helpers;
  let unblock;
  const pending = new Promise(resolve => { unblock = resolve; });
  let settled = false;
  const result = scheduleBookingNotificationWake(bookingInput(() => pending));
  result.then(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  unblock({ data: true, error: null });
  assert.equal(await result, true);
});

test('AC-LINE-003: failed/read-only bookings never register dispatch, registration errors fall back safely', async () => {
  const [{ scheduleBookingNotificationWake }] = await helpers;
  let dispatches = 0;
  let tracked = 0;
  for (const changes of [
    { response: new Response(JSON.stringify({ ok: false })) },
    { body: { action: 'user.booking.bootstrap' } },
    { name: 'scheduled-grant-messages' },
    { context: null },
  ]) {
    assert.equal(await scheduleBookingNotificationWake(
      bookingInput(async () => { dispatches++; return { data: true }; }, changes),
      () => { tracked++; },
    ), false);
  }
  assert.equal(dispatches, 0);
  assert.equal(tracked, 0);
  assert.equal(await scheduleBookingNotificationWake(
    bookingInput(async () => { dispatches++; return { data: true }; }),
    () => { throw new Error('EdgeRuntime is unavailable'); },
  ), true);
  assert.equal(dispatches, 1);
});

test('AC-LINE-004: scheduled LINE sends use bounded concurrency and visit every claimed job once', async () => {
  const [, { processNotificationBatches }] = await helpers;
  let active = 0, peak = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const seen = [];
  const task = processNotificationBatches([1, 2, 3, 4, 5, 6, 7], 3, async id => {
    active++;
    peak = Math.max(peak, active);
    seen.push(id);
    if (id <= 3) await barrier;
    active--;
  });
  assert.deepEqual(seen, [1, 2, 3], 'no unbounded fanout to LINE');
  release();
  await task;
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peak, 3);
  assert.equal(active, 0);
});

test('AC-LINE-005: a broken batch prevents later work from being started and reports failure', async () => {
  const [, { processNotificationBatches }] = await helpers;
  const seen = [];
  await assert.rejects(processNotificationBatches([1, 2, 3], 2, async id => {
    seen.push(id);
    if (id === 2) throw new Error('database unavailable');
  }), /database unavailable/);
  assert.deepEqual(seen, [1, 2]);
  await assert.rejects(processNotificationBatches([1], 0, async () => {}), /INVALID_BATCH_LIMIT/);
});

test('AC-LINE-006: scheduled grants use bounded delivery without changing recipient, retry key or suppressed-ticket guards', () => {
  const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/scheduled-grant-messages/index.ts'), 'utf8');
  assert.match(source, /processNotificationBatches\(rows,\s*4,\s*async\s*\(row\)/);
  assert.match(source, /withBusinessModule\(module,\s*\(\)\s*=>\s*dispatchOne\(supabase,token,row,eventLiffUrl\)\)/);
  assert.match(source, /["']X-Line-Retry-Key["']:\s*String\(row\.id\)/);
  assert.match(source, /fixed_ticket_notification_delivery/);
  assert.match(source, /isTestMember\(supabase,row\)/);
});
