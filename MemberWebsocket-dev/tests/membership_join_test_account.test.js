const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('test-mode login backfills the configured membership-join ticket idempotently', () => {
  const testMode = read('supabase/functions/test-mode-api/index.ts');
  const migration = read('supabase/migrations/20261003014000_membership_join_ticket_and_referral_configuration.sql');

  assert.match(testMode, /async function ensureMembershipJoinTicketForTestAccount/);
  assert.match(testMode, /supabase\.rpc\("issue_membership_join_ticket",\s*\{\s*p_member_id: memberId/s);
  assert.match(
    testMode,
    /if \(!member \|\| member\.is_test_account !== true[\s\S]*await ensureMembershipJoinTicketForTestAccount\(supabase, member\.id\);[\s\S]*const token = randomToken\(\);/
  );
  assert.match(
    testMode,
    /action === "session\.status"[\s\S]*await ensureMembershipJoinTicketForTestAccount\(supabase, identity\.memberId\);/
  );
  assert.match(migration, /where id = p_member_id[\s\S]*membership_status <> 'active'/);
  assert.match(migration, /where event_ticket_id = v_event\.id\s*and member_id = v_member\.id[\s\S]*'already_issued'/);
  assert.doesNotMatch(migration, /is_test_account\s*=\s*false/);
});
