const test = require('node:test');
const assert = require('node:assert/strict');

const NOW = '2026-11-10T04:02:00+00:00';
const EVENT_HISTORY = [
  { id: 9, created_at: NOW, scope: 'admin', event_type: 'booking.db.bookings.update' },
  { id: 10, created_at: NOW, scope: 'admin', event_type: 'user.booking.presence.offline' },
  { id: 11, created_at: NOW, scope: 'admin', event_type: 'member.presence.changed' },
];

async function revisionFor(history = EVENT_HISTORY, surface = 'admin', authorized = true) {
  const { syncRevision } = await import('../supabase/functions/_shared/sync-revision.mjs');
  const calls = [];
  const db = {
    from(table) {
      let rows = history;
      return {
        select() { return this; },
        eq() { return this; },
        in(field, values) { rows = rows.filter(row => values.includes(row[field])); return this; },
        not(field, operator, pattern) {
          assert.equal(field, 'event_type');
          assert.equal(operator, 'like');
          assert.equal(pattern, '%.presence.%');
          rows = rows.filter(row => !row.event_type.includes('.presence.'));
          return this;
        },
        order(field, { ascending }) {
          rows = rows.toSorted((a, b) => ascending ? a[field] - b[field] : b[field] - a[field]);
          return this;
        },
        limit(count) { rows = rows.slice(0, count); return this; },
        async maybeSingle() {
          calls.push(table);
          if (table === 'admins') return { data: { role: authorized ? 'admin' : 'member', status: 'active' }, error: null };
          if (table === 'members') return { data: { status: 'active' }, error: null };
          return { data: rows[0] || null, error: null };
        },
      };
    },
  };
  const createError = (status, code, message) => Object.assign(new Error(message), { status, code });
  return { run: () => syncRevision(db, surface, 'synthetic-user', createError), calls };
}

test('AC-429-001: admin presence-only changes do not trigger a full-panel revision', async () => {
  const { run } = await revisionFor();
  assert.equal((await run()).revision, '9:' + NOW);
});

test('AC-429-002: actual booking data changes still trigger an admin revision', async () => {
  const { run } = await revisionFor([
    { id: 12, created_at: NOW, scope: 'admin', event_type: 'booking.benefits.changed' },
    ...EVENT_HISTORY,
  ]);
  assert.equal((await run()).revision, '12:' + NOW);
});

test('AC-429-003: member-facing subscriptions retain their existing revisions', async () => {
  const { run } = await revisionFor([
    { id: 22, created_at: NOW, scope: 'member', event_type: 'user.member.presence.online' },
  ], 'member');
  assert.equal((await run()).revision, '22:' + NOW);
});

test('AC-429-004: unauthorized admins remain blocked before revision reads', async () => {
  const { run, calls } = await revisionFor([], 'admin', false);
  await assert.rejects(run, { code: 'ADMIN_REQUIRED', status: 403 });
  assert.deepEqual(calls, ['admins']);
});

test('AC-429-005: presence-only history has a stable empty admin revision', async () => {
  const { run } = await revisionFor([
    { id: 2, created_at: NOW, scope: 'admin', event_type: 'member.presence.changed' },
  ]);
  assert.equal((await run()).revision, '0');
});
