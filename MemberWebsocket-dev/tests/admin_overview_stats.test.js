const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = async (db, day) => (await import('../supabase/functions/_shared/admin-overview-stats.mjs'))
  .loadAdminOverviewStats(db, day);

function mockDatabase(data = {}, errors = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [], orFilters: [], orders: [], range: null, count: false };
      calls.push(call);
      const q = {
        select(_fields, options = {}) { call.count = options.count === 'exact' && options.head === true; return q; },
        eq(key, value) { call.filters.push([key, 'eq', value]); return q; },
        is(key, value) { call.filters.push([key, 'is', value]); return q; },
        gt(key, value) { call.filters.push([key, 'gt', value]); return q; },
        gte(key, value) { call.filters.push([key, 'gte', value]); return q; },
        lt(key, value) { call.filters.push([key, 'lt', value]); return q; },
        or(value) { call.orFilters.push(value); return q; },
        order(key, opts = {}) { call.orders.push([key, opts.ascending !== false]); return q; },
        range(a, b) { call.range = [a, b]; return q; },
        then(resolve, reject) {
          const matches = (row, key, operator, value) => {
            if (operator === 'is') return value === null || value === 'null' ? row[key] == null : row[key] === value;
            if (row[key] == null) return false;
            const left = row[key];
            if (operator === 'eq') return left === value;
            if (operator === 'neq') return left !== value;
            if (operator === 'gte') return left >= value;
            if (operator === 'lte') return left <= value;
            if (operator === 'gt') return left > value;
            if (operator === 'lt') return left < value;
            throw new Error('Unknown mock operator: ' + operator);
          };
          const rows = (data[table] || []).filter((row) =>
            call.filters.every(([key, op, value]) => matches(row, key, op, value)) &&
            call.orFilters.every((group) => group.split(',').some((expression) => {
              const match = /^([^.]+)\.(is|eq|neq|gte|lte|gt|lt)\.(.*)$/.exec(expression);
              assert.ok(match, 'Unsupported filter: ' + expression);
              return matches(row, match[1], match[2], match[3]);
            }))
          );
          for (const [key, ascending] of call.orders.slice().reverse()) {
            rows.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1));
          }
          const selected = call.range ? rows.slice(call.range[0], call.range[1] + 1) : rows;
          return Promise.resolve(errors[table]
            ? { data: null, count: null, error: new Error(errors[table]) }
            : { data: selected, count: rows.length, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

const card = (expiry_mode, expires_on, status = 'active') => ({ expiry_mode, expires_on, status });
const event = (starts_on, ends_on, extra = {}) => ({
  starts_on, ends_on, status: 'active', deleted_at: null,
  referral_source_event_ticket_id: null, ...extra,
});

test('AC-001/002: in-progress cards and event tickets must respect active dates and deletion', async () => {
  const db = mockDatabase({
    members: [
      { is_test_account: false, status: 'active' },
      { is_test_account: false, status: 'suspended' },
      { is_test_account: true, status: 'active' },
    ],
    point_cards: [
      card('unlimited', null),
      card('date', '2026-11-28'),
      card('date', '2026-11-27'),
      card('date', null),
      card('unlimited', null, 'archived'),
    ],
    event_tickets: [
      event(null, null),
      event('2026-11-28', '2026-11-28'),
      event('2026-11-29', null),
      event(null, '2026-11-27'),
      event(null, null, { status: 'archived' }),
      event(null, null, { deleted_at: '2026-11-01T00:00:00Z' }),
      event(null, null, { referral_source_event_ticket_id: 'referral' }),
    ],
  });
  const stats = await load(db, '2026-11-28');
  assert.deepEqual(stats, {
    memberCount: 2, activeMemberCount: 1, activeCardCount: 3,
    activeEventTicketCount: 2, todayEntryCount: 0,
  });
  const cards = db.calls.find((c) => c.table === 'point_cards');
  const events = db.calls.find((c) => c.table === 'event_tickets');
  assert.equal(cards.count, true);
  assert.match(cards.orFilters.join(','), /expires_on\.gte\.2026-11-28/);
  assert.equal(events.orFilters.length, 2);
  assert.deepEqual(events.filters.filter((f) => f[1] === 'is'), [
    ['deleted_at', 'is', null], ['referral_source_event_ticket_id', 'is', null],
  ]);
});

test('AC-003: sum issued points on Taiwan calendar day, excluding transfers and adjacent days', async () => {
  const db = mockDatabase({
    point_entries: [
      { id: 'a', entry_type: 'grant', amount: 3, created_at: '2026-11-27T16:00:00.000Z' },
      { id: 'b', entry_type: 'grant', amount: 2, created_at: '2026-11-28T15:59:59.999Z' },
      { id: 'c', entry_type: 'grant', amount: 30, created_at: '2026-11-27T15:59:59.999Z' },
      { id: 'd', entry_type: 'grant', amount: 40, created_at: '2026-11-28T16:00:00.000Z' },
      { id: 'e', entry_type: 'transfer_in', amount: 9, created_at: '2026-11-28T03:00:00.000Z' },
      { id: 'f', entry_type: 'transfer_out', amount: -9, created_at: '2026-11-28T03:00:00.000Z' },
    ],
  });
  const stats = await load(db, '2026-11-28');
  assert.equal(stats.todayEntryCount, 5);
  const points = db.calls.find((c) => c.table === 'point_entries');
  assert.deepEqual(points.filters, [
    ['entry_type', 'eq', 'grant'], ['amount', 'gt', 0],
    ['created_at', 'gte', '2026-11-27T16:00:00.000Z'],
    ['created_at', 'lt', '2026-11-28T16:00:00.000Z'],
  ]);
});

test('AC-004: more than 1000 same-day grants are counted, never truncated', async () => {
  const today = '2026-11-28T02:00:00.000Z';
  const db = mockDatabase({
    point_entries: Array.from({ length: 1003 }, (_, n) => ({
      id: String(n).padStart(4, '0'), entry_type: 'grant', amount: 2, created_at: today,
    })),
  });
  const stats = await load(db, '2026-11-28');
  assert.equal(stats.todayEntryCount, 2006);
  assert.deepEqual(db.calls.filter((c) => c.table === 'point_entries').map((c) => c.range), [
    [0, 999], [1000, 1999],
  ]);
});

test('AC-005: use only the injected business-scoped client and fail closed on DB errors', async () => {
  const a = await load(mockDatabase({ point_cards: [card('unlimited', null)] }), '2026-11-28');
  const b = await load(mockDatabase({ event_tickets: [event(null, null)] }), '2026-11-28');
  assert.equal(a.activeCardCount, 1);
  assert.equal(b.activeCardCount, 0);
  assert.equal(a.activeEventTicketCount, 0);
  assert.equal(b.activeEventTicketCount, 1);
  await assert.rejects(load(mockDatabase({}, { event_tickets: 'READ_DENIED' }), '2026-11-28'), /READ_DENIED/);
  await assert.rejects(load(mockDatabase({}, { point_entries: 'POINTS_QUERY_ERROR' }), '2026-11-28'), /POINTS_QUERY_ERROR/);
});

test('AC-006: canonical admin API uses the shared statistics routine without changing response fields', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/api/index.ts'), 'utf8');
  assert.match(source, /from ["']\.\.\/_shared\/admin-overview-stats\.mjs["']/);
  assert.match(source, /async function summaryStats\([\s\S]*?loadAdminOverviewStats\(supabase,\s*taipeiDate\(\)\)/);
  for (const field of ['memberCount', 'activeMemberCount', 'activeCardCount', 'activeEventTicketCount', 'todayEntryCount']) {
    assert.match(fs.readFileSync(path.resolve(__dirname, '../admin/app.js'), 'utf8'), new RegExp('state\\.stats\\.' + field));
  }
});
