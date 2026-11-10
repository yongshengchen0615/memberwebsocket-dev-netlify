const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '../..');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261110184500_general_event_ticket_amount_gate.sql'), 'utf8');
const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
function definition(name) {
  const blocks = [...sql.matchAll(/execute format\(\$function\$([\s\S]*?)\$function\$,s\);/g)];
  const block = blocks.map(match => match[1]).find(text => text.includes('function %1$I.' + name + '('));
  assert.ok(block, 'missing SQL function ' + name);
  return block.replaceAll('%1$I', 'public');
}

test('AC-001..006: amount checks use canonical booking snapshot totals and never affect snapshot redemption', async (t) => {
  const db = new PGlite();
  const member = id(1), other = id(2), booking = id(3), otherBooking = id(4);
  const itemA = id(11), itemB = id(12), event = id(20);
  try {
    await db.exec(
      'create table public.bookings(id uuid primary key,member_id uuid not null);' +
      'create table public.booking_items(booking_id uuid not null,service_id uuid not null,unit_price_amount integer not null,quantity integer not null);' +
      "create table public.event_tickets(id uuid primary key,min_booking_amount_mode text not null default 'none',min_booking_amount integer not null default 0,min_booking_service_ids uuid[] not null default '{}');" +
      'create table public.event_ticket_claims(claim_id text not null,event_ticket_id uuid not null,member_id uuid not null);'
    );
    await db.exec(definition('booking_ticket_meets_amount'));
    await db.exec(definition('assert_general_booking_event_amount'));
    await db.query('insert into bookings(id,member_id) values($1,$2),($3,$4)', [booking, member, otherBooking, other]);
    await db.query("insert into event_tickets(id,min_booking_amount_mode,min_booking_amount) values($1,'total',300)",[event]);
    await db.query("insert into event_ticket_claims(claim_id,event_ticket_id,member_id) values('CLAIM',$1,$2)",[event,member]);
    await db.query('insert into booking_items(booking_id,service_id,unit_price_amount,quantity) values($1,$2,100,1),($1,$3,100,2)',[booking,itemA,itemB]);
    const isMet = async (b=booking,m=member,k='event',ref='CLAIM') =>
      (await db.query('select public.booking_ticket_meets_amount($1,$2,$3,$4) ok',[b,m,k,ref])).rows[0].ok;
    await t.test('AC-001: total 300 matches exactly, 301 fails without any rounding', async () => {
      assert.equal(await isMet(),true);
      await db.query('update event_tickets set min_booking_amount=301 where id=$1',[event]);
      assert.equal(await isMet(),false);
    });
    await t.test('AC-002: selected service subtotal excludes unrelated items and respects quantity', async () => {
      await db.query("update event_tickets set min_booking_amount_mode='selected_services',min_booking_amount=200,min_booking_service_ids=$2 where id=$1",[event,[itemB]]);
      assert.equal(await isMet(),true);
      await db.query('update event_tickets set min_booking_amount=201 where id=$1',[event]);
      assert.equal(await isMet(),false);
      await db.query('update event_tickets set min_booking_service_ids=$2,min_booking_amount=100 where id=$1',[event,[itemA]]);
      assert.equal(await isMet(),true);
    });
    await t.test('AC-003: booking ownership, non-existent claim and direct use cannot bypass amount rule', async () => {
      assert.equal(await isMet(otherBooking,other),false);
      assert.equal(await isMet(booking,other),false);
      assert.equal(await isMet(null),false);
      assert.equal(await isMet(booking,member,'event','MISSING'),false);
    });
    await t.test('AC-004: no amount requirement preserves former ticket behavior, point tickets are unchanged', async () => {
      await db.query("update event_tickets set min_booking_amount_mode='none',min_booking_amount=0,min_booking_service_ids='{}' where id=$1",[event]);
      assert.equal(await isMet(null),true);
      assert.equal(await isMet(null,member,'points','POINT'),true);
    });
    await t.test('AC-005: server assertion rejects below-minimum event selection without consuming tickets', async () => {
      await db.query("update event_tickets set min_booking_amount_mode='total',min_booking_amount=301 where id=$1",[event]);
      const select = async (entries) => db.query('select public.assert_general_booking_event_amount($1,$2,$3::jsonb)',[booking,member,JSON.stringify(entries)]);
      await assert.rejects(select([{kind:'event',id:'CLAIM'}]),/BOOKING_BENEFIT_AMOUNT_REQUIRED/);
      await select([{kind:'points',id:'POINT'}]);
      assert.equal((await db.query('select count(*)::integer n from event_ticket_claims')).rows[0].n,1);
    });
    await t.test('AC-006: snapshot receipt functions and service-only validators are not rewritten by this migration', () => {
      assert.doesNotMatch(sql,/pg_get_functiondef\([^;]*validate_snapshot_ticket_selection/);
      assert.doesNotMatch(sql,/pg_get_functiondef\([^;]*register_accessible_receipt_with_benefits_request/);
      assert.doesNotMatch(sql,/fn='booking_ticket_matches_services'/);
      assert.match(sql,/receipt_submission_id is null/);
      assert.match(sql,/booking_receipts r where r.booking_id/);
    });
  } finally { await db.close(); }
});
