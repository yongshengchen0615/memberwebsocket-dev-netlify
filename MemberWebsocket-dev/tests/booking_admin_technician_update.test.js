const fs = require('node:fs');
const assert = require('node:assert/strict');

const edge = fs.readFileSync('MemberWebsocket-dev/supabase/functions/booking-admin-operations/index.ts', 'utf8');
const migration = fs.readFileSync('MemberWebsocket-dev/supabase/migrations/20260918161000_admin_booking_participant_technicians.sql', 'utf8');
const core = fs.readFileSync('MemberWebsocket-dev/admin/booking-panel-core.js', 'utf8');

assert.ok(core.includes('修改此位技師'));
assert.ok(core.includes('admin.booking.participants.technicians.update'));
assert.ok(core.includes('expectedUpdatedAt: booking.updatedAt'));
assert.ok(core.includes('每筆預約至少一位服務對象須預約主要技師，才能成立預約'));
assert.ok(core.includes('同一筆多人預約不可重複指定同一位技師'));
assert.equal(fs.existsSync('MemberWebsocket-dev/booking-admin-group-details.js'), false);

assert.ok(edge.includes('async function updateParticipantTechnicians'));
assert.ok(edge.includes('admin_update_booking_participant_technicians_request'));
assert.ok(edge.includes('BOOKING_PRIMARY_TECHNICIAN_REQUIRED'));
assert.ok(edge.includes('DUPLICATE_PARTICIPANT_TECHNICIAN'));
assert.ok(edge.includes('BOOKING_TECHNICIAN_DISABLED'));
assert.ok(edge.includes('BOOKING_SLOT_TAKEN'));
assert.ok(edge.includes('admin.booking.participants.technicians.update'));

assert.ok(migration.includes('for update'));
assert.ok(migration.includes('b.updated_at <> p_expected_updated_at'));
assert.ok(migration.includes("b.status not in ('pending', 'confirmed')"));
assert.ok(migration.includes('BOOKING_CANCELLATION_PENDING'));
assert.ok(migration.includes('validate_group_booking_technicians(p_participants)'));
assert.ok(migration.includes('delete from public.booking_participant_reservations'));
assert.ok(migration.indexOf('delete from public.booking_participant_reservations') < migration.indexOf('for person in'));
assert.ok(migration.includes('when exclusion_violation'));
assert.ok(migration.includes('BOOKING_PARTICIPANT_TECHNICIANS_UPDATED'));

console.log('booking participant technician update is owned by the current admin renderer');
