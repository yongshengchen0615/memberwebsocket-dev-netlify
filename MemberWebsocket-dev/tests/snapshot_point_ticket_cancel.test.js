const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('pending snapshot cancellation mutates only receipt intent and location proof', () => {
  const sql = read('supabase/migrations/20261013102334_member_cancel_snapshot_point_ticket.sql');
  assert.match(sql, /security invoker/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /member_id = v_member_id/i);
  assert.match(sql, /submission_mode = 'accessible'/i);
  assert.match(sql, /status <> 'awaiting_review'/i);
  assert.match(sql, /updated_at is distinct from p_expected_updated_at/i);
  assert.match(sql, /requested_benefits = v_benefits/i);
  assert.match(sql, /snapshot_location_verified_tickets = v_verified/i);
  assert.match(sql, /entry.item->>'kind' = 'points' and entry.item->>'id' = p_ticket_id/i);
  assert.match(sql, /SNAPSHOT_POINT_TICKET_CANCELLED/);
  assert.match(sql, /grant execute.*member_cancel_snapshot_point_ticket_request/s);
  assert.doesNotMatch(sql, /delete from public\.booking_receipts/i);
  assert.doesNotMatch(sql, /update public\.point_balances/i);
});

test('pointcard bootstrap returns member-scoped snapshot intents without treating them as reservations', () => {
  const api = read('supabase/functions/api/index.ts');
  assert.match(api, /"user.pointcard.snapshot-ticket.cancel"/);
  assert.match(api, /member_cancel_snapshot_point_ticket_request/);
  assert.match(api, /const member = await requireJoinedMember\(supabase,identity\)/);
  assert.match(api, /\.eq\("member_id",member\.id\)\.eq\("submission_mode","accessible"\)/);
  assert.match(api, /\.eq\("status","awaiting_review"\)/);
  assert.match(api, /pendingSnapshots: snapshotByPointTicket\.get/);
  assert.match(api, /p_expected_updated_at:expectedUpdatedAt/);
});

test('pointcard UI can remove pending snapshot ticket, but not redeemed ticket', () => {
  const points = read('points/pointcard-ticket-overview.js');
  assert.match(points, /if \(reservedForBooking\) statusText = '已預約使用'/);
  assert.match(points, /else if \(pendingSnapshot\) statusText = '快照待審核'/);
  assert.match(points, /baseCanUse: Boolean\(ticketId\) && !reservedForBooking && !pendingSnapshot/);
  assert.match(points, /checkbox\.checked = isSelected \|\| offer\.reservedForBooking \|\| Boolean\(offer\.pendingSnapshot\)/);
  assert.match(points, /onCancelSnapshot: async \(snapshot\)/);
  assert.match(points, /pendingSnapshots: offer\.pendingSnapshots/);
  assert.match(points, /onCancelBooking: async \(context\)/);
  assert.match(points, /reservedForBooking && pendingSnapshot\) statusText = '已預約使用・快照待審核'/);
  assert.match(points, /'user\.pointcard\.snapshot-ticket\.cancel'/);
  assert.match(points, /await state\.refreshData\(\)/);
  assert.match(read('points/index.html'), /pointcard-ticket-overview\.js\?v=[^"]*snapshot-cancel-20261013-1/);
});
