const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { localTimestamp } = require('../supabase/functions/_shared/booking-hours.ts');

const source = fs.readFileSync(require('node:path').join(__dirname, '../supabase/functions/booking-api/index.ts'), 'utf8')
  .replace(/^import .*\n/gm, '');

const fixtureIdentity = { lineUserId: 'fixture-user', displayName: 'Fixture' };
const requireActiveAdminContract = async ({ supabase, identity, createError }) => {
  const result = await supabase.from('admins').select('*').eq('line_user_id', identity.lineUserId).maybeSingle();
  if (result.error) throw createError(500, 'DATABASE_ERROR', 'admin lookup failed');
  if (!result.data || result.data.role !== 'admin' || result.data.status !== 'active') {
    throw createError(403, 'ADMIN_PENDING', 'admin authorization required');
  }
  return result.data;
};
const verifyLineIdTokenContract = async ({ idToken, createError }) => {
  if (!idToken) throw createError(401, 'AUTH_REQUIRED', 'login required');
  return fixtureIdentity;
};
const context = vm.createContext({
  Deno: { serve() {}, env: { get() { return ''; } } },
  Date, Intl, Set, Map, console, crypto: require('node:crypto').webcrypto, TextEncoder,
  requireActiveAdminContract, verifyLineIdTokenContract, localTimestamp,
  hasCurrentTermsConsent: async () => true,
});
vm.runInContext(stripTypeScriptTypes(source), context);

const id = '10000000-0000-4000-8000-000000000001';
const version = '2026-09-11T00:00:00.000Z';
const identity = fixtureIdentity;

function db(booking, admin = { role: 'admin', status: 'active', display_name: 'Fixture' }) {
  const writes = [];
  const rpcs = [];
  return { writes, rpcs, rpc(name, args) {
    rpcs.push({ name, args });
    return Promise.resolve({ data: { alreadyRequested: false }, error: null });
  }, from(table) {
    const result = {
      data: table === 'bookings' ? booking
        : table === 'admins' ? admin
        : table === 'members' ? { id, membership_status: 'active', status: 'active' }
        : [],
      error: null,
    };
    const q = {
      then(resolve) { return Promise.resolve(result).then(resolve); },
      update(patch) { writes.push({ table, patch }); result.data = { ...booking, ...patch }; return q; },
      insert() { return q; },
    };
    for (const key of ['select', 'eq', 'in', 'order', 'limit', 'gte']) q[key] = () => q;
    q.single = q.maybeSingle = async () => result;
    return q;
  } };
}

const booking = {
  id,
  status: 'confirmed',
  updated_at: version,
  booking_date: '2020-01-01',
  start_time: '09:00:00',
  end_time: '10:00:00',
};

test('generic booking status endpoint cannot bypass canonical completion settlement', async () => {
  const client = db(booking);
  await assert.rejects(
    context.adminStatusUpdate(client, identity, {
      bookingId: id,
      status: 'completed',
      expectedUpdatedAt: version,
    }),
    { code: 'BOOKING_COMPLETION_CANONICAL_REQUIRED' },
  );
  assert.equal(client.writes.length, 0);
});

test('pending booking can still be confirmed with actor and timestamp attribution', async () => {
  const client = db({ ...booking, status: 'pending' });
  const result = await context.adminStatusUpdate(client, identity, {
    bookingId: id,
    status: 'confirmed',
    expectedUpdatedAt: version,
  });
  assert.equal(result.booking.status, 'confirmed');
  assert.equal(client.writes[0].patch.confirmed_by, identity.lineUserId);
  assert.ok(client.writes[0].patch.confirmed_at);
});

test('stale confirmation cannot confirm a rescheduled pending appointment', async () => {
  const client = db({ ...booking, status: 'pending', updated_at: '2026-09-11T01:00:00.000Z' });
  await assert.rejects(
    context.adminStatusUpdate(client, identity, {
      bookingId: id,
      status: 'confirmed',
      expectedUpdatedAt: version,
    }),
    { code: 'BOOKING_CONFLICT' },
  );
  assert.equal(client.writes.length, 0);
});

test('pending cancellation blocks generic admin lifecycle changes', async () => {
  const client = db({
    ...booking,
    cancellation_requested_at: '2026-09-18T00:00:00.000Z',
    cancellation_reviewed_at: null,
  });
  await assert.rejects(
    context.adminStatusUpdate(client, identity, {
      bookingId: id,
      status: 'cancelled',
      expectedUpdatedAt: version,
    }),
    { code: 'BOOKING_CANCELLATION_PENDING' },
  );
  assert.equal(client.writes.length, 0);
});

test('legacy member cancel action creates a cancellation request instead of cancelling immediately', async () => {
  const future = {
    ...booking,
    booking_date: '2099-01-01',
    cancellation_requested_at: null,
    cancellation_reviewed_at: null,
  };
  const client = db(future);
  const result = await context.userCancel(client, identity, { id }, { bookingId: id });
  assert.equal(result.booking.status, 'cancel_requested');
  assert.equal(result.booking.baseStatus, 'confirmed');
  assert.equal(client.writes.length, 0, 'cancellation request must not mutate booking status directly');
  assert.equal(client.rpcs[0].name, 'request_booking_cancellation');
  assert.equal(client.rpcs[0].args.p_booking_id, id);
  assert.equal(client.rpcs[0].args.p_member_id, id);
  assert.equal(client.rpcs[0].args.p_actor, identity.lineUserId);
});

test('member cannot reach admin status action', async () => {
  await assert.rejects(
    context.route(db(booking), identity, 'member', 'admin.booking.status.update', {}),
    { code: 'ACTION_NOT_FOUND' },
  );
});

test('inactive administrator cannot reach admin booking actions', async () => {
  const client = db(booking, { role: 'admin', status: 'pending' });
  await assert.rejects(
    context.route(client, identity, 'admin', 'admin.booking.status.update', {}),
    { code: 'ADMIN_PENDING' },
  );
  assert.equal(client.writes.length, 0);
});

test('missing login token is rejected by the shared identity contract', async () => {
  await assert.rejects(context.verifyLineIdToken('', 'member'), { code: 'AUTH_REQUIRED' });
});

test('edit rejects missing version before database mutation', async () => {
  const client = db(booking);
  await assert.rejects(context.userUpdate(client, identity, { id }, { bookingId: id }), { code: 'INVALID_INPUT' });
  assert.equal(client.writes.length, 0);
});
