const fs = require('node:fs');
const assert = require('node:assert/strict');

const core = fs.readFileSync('MemberWebsocket-dev/admin/booking-panel-core.js', 'utf8');
const edge = fs.readFileSync('MemberWebsocket-dev/supabase/functions/booking-admin-operations/index.ts', 'utf8');
const migration = fs.readFileSync('MemberWebsocket-dev/supabase/migrations/20261001141229_fix_booking_participant_end_at_ambiguity.sql', 'utf8');

assert.ok(core.includes('admin.booking.participants.items.update'));
assert.ok(core.includes('expectedUpdatedAt: booking.updatedAt'));
assert.ok(edge.includes('admin_update_booking_participant_items_request'));
assert.ok(edge.includes('admin.booking.participants.items.update'));

assert.ok(migration.includes('create or replace function public.admin_update_booking_participant_items_request'));
assert.ok(migration.includes('v_end_time time;'));
assert.ok(migration.includes('v_end_time := b.start_time + make_interval(mins => total_minutes);'));
assert.ok(migration.includes('end_time = v_end_time'));
assert.equal(migration.includes('  end_at time;'), false);
assert.equal(migration.includes('end_time = end_at'), false);

console.log('booking participant item update avoids bookings.end_at PL/pgSQL ambiguity');
