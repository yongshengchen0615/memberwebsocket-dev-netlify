'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('../business-runtime-fixture.cjs');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../../../supabase/migrations/20261124140000_event_ticket_claim_relative_expiry.sql'),
  'utf8'
);

test('Postgres: existing tenant, public schema, and new tenant have per-claim expiry', async () => {
  const h = await fixture();
  try {
    const owner = 'U' + '2'.repeat(32);
    const old = await h.approve(owner, 'rolling-expiry-before');
    const s = old.runtime_schema;
    assert.match(s, /^business_[0-9a-f]{32}$/);

    const memberId = (await h.db.query(
      "insert into " + s + ".members(line_user_id,member_code,invite_code,status,membership_status,is_test_account) values($1,'EXPIRY-MEMBER','EXPR123456','active','active',true) returning id",
      ['U' + '3'.repeat(32)]
    )).rows[0].id;
    const oldTicketId = (await h.db.query(
      "insert into " + s + ".event_tickets(event_ticket_id,title,ticket_type,description,usage_method,usage_instructions,status,created_by,updated_by) values('EXPIRY-LEGACY','Legacy','coupon','Synthetic','Visit','Use','active','admin','admin') returning id"
    )).rows[0].id;
    const legacyClaim = 'EXPIRY-LEGACY-CLAIM';
    await h.db.query(
      "insert into " + s + ".event_ticket_claims(claim_id,event_ticket_id,member_id,ticket_type,ticket_title,status) values($1,$2,$3,'coupon','Legacy','claimed')",
      [legacyClaim, oldTicketId, memberId]
    );

    // The migration never retroactively expires an already-held ticket.
    await h.db.exec(migration);
    const previous = (await h.db.query("select expires_at from " + s + ".event_ticket_claims where claim_id=$1", [legacyClaim])).rows[0];
    assert.equal(previous.expires_at, null);

    const ticketId = (await h.db.query(
      "insert into " + s + ".event_tickets(event_ticket_id,title,ticket_type,description,usage_method,usage_instructions,status,created_by,updated_by,validity_days_after_claim) values('EXPIRY-ROLLING','Rolling','coupon','Synthetic','Visit','Use','active','admin','admin',2) returning id"
    )).rows[0].id;

    const expiredClaim = 'EXPIRY-USED-TOO-LATE';
    const expired = (await h.db.query(
      "insert into " + s + ".event_ticket_claims(claim_id,event_ticket_id,member_id,ticket_type,ticket_title,status,claimed_at) values($1,$2,$3,'coupon','Rolling','claimed',now() - interval '3 days') returning claimed_at,expires_at",
      [expiredClaim,ticketId,memberId]
    )).rows[0];
    const d = Date.parse(String(expired.expires_at)) - Date.parse(String(expired.claimed_at));
    assert.equal(d, 2 * 86400000, 'deadline is calculated from this claim, not campaign start');

    await assert.rejects(
      h.db.query("update " + s + ".event_ticket_claims set status='used',used_at=now() where claim_id=$1", [expiredClaim]),
      /EVENT_TICKET_CLAIM_EXPIRED/
    );
    assert.equal((await h.db.query("select status from " + s + ".event_ticket_claims where claim_id=$1", [expiredClaim])).rows[0].status, 'claimed');

    const currentClaim = 'EXPIRY-VALID';
    const valid = (await h.db.query(
      "insert into " + s + ".event_ticket_claims(claim_id,event_ticket_id,member_id,ticket_type,ticket_title,status) values($1,$2,$3,'coupon','Rolling','claimed') returning claimed_at,expires_at",
      [currentClaim,ticketId,memberId]
    )).rows[0];
    assert.equal(Date.parse(String(valid.expires_at))-Date.parse(String(valid.claimed_at)), 2 * 86400000);

    await assert.rejects(
      h.db.query("update " + s + ".event_ticket_claims set expires_at=expires_at + interval '1 day' where claim_id=$1", [currentClaim]),
      /EVENT_TICKET_EXPIRY_IMMUTABLE/
    );
    await assert.rejects(
      h.db.query("update " + s + ".event_tickets set validity_days_after_claim=0 where id=$1", [ticketId]),
      /event_ticket_validity_days_after_claim_check/
    );

    // Editing a campaign cannot reset the deadlines already granted to members.
    await h.db.query("update " + s + ".event_tickets set validity_days_after_claim=3 where id=$1", [ticketId]);
    const retained = (await h.db.query("select expires_at from " + s + ".event_ticket_claims where claim_id=$1", [currentClaim])).rows[0];
    assert.equal(Date.parse(String(retained.expires_at)), Date.parse(String(valid.expires_at)));

    for (const ns of ['public',s]) {
      const cols = (await h.db.query(
        "select column_name from information_schema.columns where table_schema=$1 and table_name='event_tickets' and column_name='validity_days_after_claim'",
        [ns]
      )).rows;
      assert.equal(cols.length, 1, ns + ' has the new setting');
    }
    const next = await h.approve('U' + '4'.repeat(32), 'rolling-expiry-after');
    assert.match(next.runtime_schema, /^business_[0-9a-f]{32}$/);
    assert.equal((await h.db.query(
      "select count(*)::integer as count from information_schema.columns where table_schema=$1 and table_name='event_ticket_claims' and column_name='expires_at'",
      [next.runtime_schema]
    )).rows[0].count, 1, 'future tenants receive the claim deadline');
  } finally {
    await h.db.close();
  }
});
