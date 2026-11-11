const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const migration = read('supabase/migrations/20261111122500_event_ticket_friend_transfer.sql');
const api = read('supabase/functions/api/index.ts');
const growth = read('supabase/functions/member-growth-api/index.ts');
const client = read('member-system.js');
const eventApp = read('event/app.js');
const eventPage = read('event/index.html');

test('AC-001: only accepted friendships can receive event tickets', () => {
  assert.match(migration, /f\.status = 'accepted'/);
  assert.match(migration, /EVENT_TICKET_FRIEND_REQUIRED/);
  assert.match(migration, /is_test_account = v_sender\.is_test_account/);
  assert.match(growth, /event: new Set\(\["event\.today-usable","member\.friend\.list"\]\)/);
  assert.match(eventApp, /friend\.status === 'accepted'/);
});

test('AC-002: transfer uses server-verified sender and atomic claimed-ticket ownership update', () => {
  assert.match(api, /action === "user\.event\.ticket\.transfer"/);
  assert.match(api, /p_actor_line_user_id: identity\.lineUserId/);
  assert.match(api, /transfer_event_ticket_to_friend/);
  assert.match(migration, /v_claim\.member_id <> v_sender\.id/);
  assert.match(migration, /for update of e/);
  assert.match(migration, /claim_id = p_claim_id for update/);
  assert.match(migration, /set member_id = v_receiver\.id/);
});

test('AC-003: do not transfer a used, expired, fixed or reserved ticket', () => {
  assert.match(migration, /v_claim\.status <> 'claimed'/);
  assert.match(migration, /v_ticket\.ends_on < v_today/);
  assert.match(migration, /v_ticket\.fixed_ticket_template_id is not null/);
  assert.match(migration, /v_ticket\.ticket_type not in \('coupon', 'lottery'\)/);
  assert.match(migration, /booking_benefit_selections/);
  assert.match(migration, /booking_receipts/);
  assert.match(migration, /EVENT_TICKET_TRANSFER_RESERVED/);
});

test('AC-004: idempotent transaction and no reclaim or duplicate receiving', () => {
  assert.match(migration, /unique \(sender_member_id, request_id\)/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /alreadyTransferred/);
  assert.match(migration, /TICKET_TRANSFER_REQUEST_CONFLICT/);
  assert.match(migration, /prevent_event_ticket_reclaim_after_transfer/);
  assert.match(migration, /EVENT_TICKET_RECEIVER_ALREADY_OWNED/);
  assert.match(api, /transferredOutEventIds/);
  assert.match(api, /canClaim: !transferredOut/);
});

test('AC-005: UI exposes friend-only selection and does not retry transfer as read', () => {
  for (const id of ['ticketTransferPanel','ticketTransferFriendSelect','ticketTransferButton']) {
    assert.match(eventPage, new RegExp('id="' + id + '"'));
    assert.ok(eventApp.includes(id));
  }
  assert.match(eventApp, /loadTransferFriends/);
  assert.match(eventApp, /transferTicketToFriend/);
  assert.match(eventApp, /window\.confirm/);
  assert.match(client, /'user\.event\.ticket\.transfer'/);
  assert.match(api, /"user\.event\.ticket\.transfer"/);
});

test('AC-006: restrict direct database invocation and protect gift ledger rows', () => {
  assert.match(migration, /alter table public\.event_ticket_transfers enable row level security/);
  assert.match(migration, /revoke all on public\.event_ticket_transfers from public, anon, authenticated/);
  assert.match(migration, /revoke all on function public\.transfer_event_ticket_to_friend\(text,text,text,text\)/);
  assert.match(migration, /grant execute on function public\.transfer_event_ticket_to_friend\(text,text,text,text\)\s+to service_role/);
});
