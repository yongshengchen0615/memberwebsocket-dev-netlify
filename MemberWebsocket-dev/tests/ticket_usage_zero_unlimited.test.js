const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('ticket usage setting zero means unlimited across admin, member, booking, edge and database layers', () => {
  const migration = read('supabase/migrations/20261002221500_ticket_usage_zero_means_unlimited.sql');
  const pointAdmin = read('admin/pointcard-redemption-limit.js');
  const eventAdmin = read('admin/event-ticket-redemption-limit.js');
  const pointMember = read('points/pointcard-ticket-overview.js');
  const eventMember = read('event/batch-redemption.js');
  const eventToday = read('event/today-usable.js');
  const booking = read('booking/booking-benefits.js');
  const bookingShared = read('supabase/functions/_shared/booking-benefits.ts');
  const bookingApi = read('supabase/functions/booking-api/index.ts');
  const bookingGroupApi = read('supabase/functions/booking-group-api/index.ts');
  const pointExtension = read('supabase/functions/pointcard-extension-api/index.ts');
  const eventExtension = read('supabase/functions/event-ticket-extension-api/index.ts');

  assert.match(migration, /max_tickets_per_redemption between 0 and 50/);
  assert.match(migration, /max_tickets_per_day between 0 and 50/);
  assert.match(migration, /v_global_max_tickets > 0/);
  assert.match(migration, /v_max_tickets > 0 and v_used_today_count/);
  assert.match(migration, /v_max_tickets = 0 then/);

  for (const source of [pointAdmin, eventAdmin, pointMember, eventMember, booking]) {
    assert.match(source, /parsed >= 0/);
  }
  assert.match(pointAdmin, /0 代表不限張數/);
  assert.match(eventAdmin, /0 代表不限張數/);
  assert.match(pointMember, /hasRedemptionLimit/);
  assert.match(pointMember, /不限張數/);
  assert.match(eventMember, /hasDailyLimit/);
  assert.match(eventMember, /每日上限不限張數/);
  assert.match(eventToday, /maxTickets===0\?'不限張數'/);

  assert.match(bookingShared, /rawEventLimit >= 0/);
  assert.match(bookingShared, /rawPointLimit >= 0/);
  assert.match(bookingShared, /每日使用張數不限/);
  assert.match(bookingShared, /單次預約使用張數不限/);

  assert.match(bookingApi, /max_tickets_per_day \?\? 1/);
  assert.match(bookingApi, /max_tickets_per_redemption \?\? 1/);
  assert.match(bookingApi, /rawEventLimit >= 0/);
  assert.match(bookingApi, /rawPointLimit >= 0/);
  assert.match(bookingApi, /maxTicketsPerDay > 0 && eventCount > maxTicketsPerDay/);
  assert.match(bookingApi, /maxPointTicketsPerRedemption > 0 && pointCount > maxPointTicketsPerRedemption/);

  assert.match(bookingGroupApi, /max_tickets_per_day\?\?1/);
  assert.match(bookingGroupApi, /max_tickets_per_redemption\?\?1/);
  assert.match(bookingGroupApi, /rawEvent>=0/);
  assert.match(bookingGroupApi, /rawPoint>=0/);
  assert.match(bookingGroupApi, /maxEvent>0&&eventCount>maxEvent/);
  assert.match(bookingGroupApi, /maxPoint>0&&pointCount>maxPoint/);

  assert.match(pointExtension, /max_tickets_per_redemption \?\? 1/);
  assert.match(pointExtension, /setting\.maxTicketsPerRedemption > 0/);
  assert.match(pointExtension, /maxTickets < 0/);
  assert.match(eventExtension, /max_tickets_per_day \?\? 1/);
  assert.match(eventExtension, /maxTickets < 0/);
});
