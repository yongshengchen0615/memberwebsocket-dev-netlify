const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const migration = read('supabase/migrations/20261123120000_event_ticket_automatic_issuance.sql');
const api = read('supabase/functions/api/index.ts');
const event = read('event/app.js');
const admin = read('admin/app.js');

test('AC-001: only issued event ticket claims are visible to a member', () => {
  assert.match(api, /if \(!claimRow\) return \[\];/);
  assert.match(api, /canClaim: false,/);
  assert.doesNotMatch(event, /user\.event\.ticket\.claim/);
  assert.doesNotMatch(event, /claimTicket\(/);
  assert.doesNotMatch(event, /offer\.canClaim/);
  assert.match(event, /由系統發放至符合條件的 LINE 會員帳戶/);
});

test('AC-002: issuance creates claims and consumes one allocation per successful insert', () => {
  assert.match(migration, /after insert or update of status on public\.event_tickets/);
  assert.match(migration, /on conflict \(event_ticket_id, member_id\) do nothing/);
  assert.match(migration, /get diagnostics v_rows = row_count;/);
  assert.match(migration, /v_issued := v_issued \+ v_rows;/);
  assert.match(migration, /greatest\(new\.quota - count\(\*\), 0\)/);
  assert.match(admin, /已發放 \$\{Number\(ticket\.claimedCount \|\| 0\)\}/);
});

test('AC-003: manual claim remains read-only for legacy clients', () => {
  assert.match(migration, /raise exception 'EVENT_TICKET_ISSUANCE_ONLY'/);
  assert.match(api, /EVENT_TICKET_ISSUANCE_ONLY/);
  assert.match(migration, /alreadyClaimed', true/);
});

test('AC-004: existing and new business schemas receive identical issuance semantics', () => {
  assert.match(migration, /\^business_\[0-9a-f\]\{32\}\$/);
  assert.match(migration, /platform_private\.business_templates/);
  assert.match(migration, /auto_issue_general_event_ticket/);
  assert.match(migration, /event_ticket_transfers/);
  assert.match(migration, /membership_status = 'active'/);
});
