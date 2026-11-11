const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');

const migration = readFileSync(join(__dirname, '../../supabase/migrations/20261111122500_event_ticket_friend_transfer.sql'), 'utf8');
const giftPolicy = readFileSync(join(__dirname, '../../supabase/migrations/20261111134000_event_ticket_one_time_gift_tier_exemption.sql'), 'utf8');
const db = new PGlite();

const A = '00000000-0000-0000-0000-000000000001';
const B = '00000000-0000-0000-0000-000000000002';
const C = '00000000-0000-0000-0000-000000000003';
const D = '00000000-0000-0000-0000-000000000004';
const E = '00000000-0000-0000-0000-000000000005';
const F = '00000000-0000-0000-0000-000000000006';
const tid = n => '10000000-0000-0000-0000-' + String(n).padStart(12, '0');
const actor = id => ({ [A]: 'actor-a', [B]: 'actor-b', [C]: 'actor-c', [D]: 'actor-d' })[id] || 'actor-a';
const code = id => ({ [A]: 'MEMBERA1', [B]: 'MEMBERB1', [C]: 'MEMBERC1', [D]: 'MEMBERD1', [E]: 'MEMBERE1', [F]: 'MEMBERF1' })[id];
const ticketId = n => tid(n);
const transfer = (sender, claim, receiver, request) => db.query(
  'select public.transfer_event_ticket_to_friend($1,$2,$3,$4) as result',
  [actor(sender), claim, code(receiver), request]
).then(r => r.rows[0].result);
const claimOwner = async claim => {
  const rows = await db.query('select member_id::text as owner from public.event_ticket_claims where claim_id=$1', [claim]);
  return rows.rows[0].owner;
};
const ledgerCount = async n => {
  const rows = await db.query('select count(*)::integer as total from public.event_ticket_transfers where event_ticket_id=$1', [ticketId(n)]);
  return Number(rows.rows[0].total);
};
const mustReject = async (promise, codeName) => assert.rejects(promise, error => {
  assert.match(String(error), new RegExp(codeName));
  return true;
});
async function createTicket(n, type = 'coupon', owner = A, extra = '') {
  await db.query(
    "insert into public.event_tickets(id,event_ticket_id,ticket_type,status,allowed_tier_keys) values($1,$2,$3,'active',array['general'])",
    [ticketId(n), 'EVENT-' + n, type]
  );
  if (extra) await db.exec(`update public.event_tickets set ${extra} where id='${ticketId(n)}'`);
  await db.query(
    "insert into public.event_ticket_claims(claim_id,event_ticket_id,member_id,status) values($1,$2,$3,'claimed')",
    ['CLAIM-' + n, ticketId(n), owner]
  );
}
async function friendship(a,b,status) {
  const [first,last] = [a,b].sort();
  await db.query(
    'insert into public.member_friendships(member_a,member_b,status) values($1,$2,$3)',
    [first,last,status]
  );
}
async function run() {
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      create table public.members (
        id uuid primary key,
        line_user_id text not null unique,
        member_code text not null unique,
        status text not null default 'active',
        membership_status text not null default 'active',
        is_test_account boolean not null default false
      );
      create table public.event_tickets (
        id uuid primary key,
        event_ticket_id text unique not null,
        ticket_type text not null,
        status text not null default 'active',
        deleted_at timestamptz,
        ends_on date,
        fixed_ticket_template_id uuid,
        allowed_tier_keys text[] not null default array['general']
      );
      create table public.event_ticket_claims (
        id uuid primary key default gen_random_uuid(),
        claim_id text not null unique,
        event_ticket_id uuid not null references public.event_tickets(id),
        member_id uuid not null references public.members(id),
        status text not null,
        updated_at timestamptz not null default now(),
        unique(event_ticket_id,member_id)
      );
      create table public.member_friendships (
        id uuid primary key default gen_random_uuid(),
        member_a uuid not null references public.members(id),
        member_b uuid not null references public.members(id),
        status text not null,
        unique(member_a,member_b)
      );
      create table public.booking_benefit_selections (
        member_id uuid not null references public.members(id),
        benefit_kind text not null,
        benefit_ref text not null,
        status text not null
      );
      create table public.booking_receipts (
        member_id uuid not null references public.members(id),
        submission_mode text not null,
        status text not null,
        requested_benefits jsonb not null default '[]'
      );
      create function public.current_tier_key(uuid) returns text
        language sql stable as $$ select 'general'::text $$;
      insert into public.members(id,line_user_id,member_code,is_test_account) values
        ('${A}','actor-a','MEMBERA1',false),
        ('${B}','actor-b','MEMBERB1',false),
        ('${C}','actor-c','MEMBERC1',false),
        ('${D}','actor-d','MEMBERD1',false),
        ('${E}','actor-e','MEMBERE1',false),
        ('${F}','actor-f','MEMBERF1',true);
    `);
    await db.exec(migration);
    // A previous release allowed A->B->C. Preserve that historical ledger while
    // rejecting a third gift after the upgraded one-time policy.
    await createTicket(12,'coupon',C);
    await db.query(
      "insert into public.event_ticket_transfers(event_ticket_id,claim_id,sender_member_id,receiver_member_id,request_id,created_at) values ($1,'CLAIM-12',$2,$3,'LEGACY-12-A',now()-interval '2 days'),($1,'CLAIM-12',$3,$4,'LEGACY-12-B',now()-interval '1 day')",
      [ticketId(12),A,B,C]
    );
    await db.exec(giftPolicy);
    const legacy=(await db.query("select transfer_ordinal from public.event_ticket_transfers where claim_id='CLAIM-12' order by transfer_ordinal")).rows;
    assert.deepEqual(legacy.map(row=>row.transfer_ordinal),[1,2],'historical forwarding remains auditable');
    await mustReject(db.query(
      "insert into public.event_ticket_transfers(event_ticket_id,claim_id,sender_member_id,receiver_member_id,request_id) values($1,'CLAIM-12',$2,$3,'LEGACY-12-C')",
      [ticketId(12),C,B]
    ),'event_ticket_transfers_claim_once_idx');
    await friendship(A, B, 'accepted');
    await friendship(A, C, 'accepted');
    await friendship(A, D, 'pending');
    await friendship(A, E, 'blocked');
    await friendship(A, F, 'accepted');
    await friendship(B, C, 'accepted');
    await mustReject(transfer(C,'CLAIM-12',B,'LEGACY-12-TRY'),'EVENT_TICKET_ALREADY_TRANSFERRED');

    await createTicket(1);
    await mustReject(transfer(A,'CLAIM-1',D,'transfer-pending-1'), 'EVENT_TICKET_FRIEND_REQUIRED');
    await mustReject(transfer(A,'CLAIM-1',E,'transfer-blocked-1'), 'EVENT_TICKET_FRIEND_REQUIRED');
    await mustReject(transfer(A,'CLAIM-1',F,'transfer-test-1'), 'EVENT_TICKET_FRIEND_REQUIRED');
    await mustReject(transfer(A,'CLAIM-1',A,'transfer-self-1'), 'EVENT_TICKET_FRIEND_REQUIRED');
    assert.equal(await claimOwner('CLAIM-1'), A);
    assert.equal(await ledgerCount(1), 0, 'rejections must not create ledger records');

    const first = await transfer(A,'CLAIM-1',B,'transfer-accepted-1');
    assert.equal(first.claimId, 'CLAIM-1');
    assert.equal(first.alreadyTransferred, false);
    assert.equal(await claimOwner('CLAIM-1'), B);
    assert.equal(await ledgerCount(1), 1, 'exactly one physical claim is transferred');
    const retry = await transfer(A,'CLAIM-1',B,'transfer-accepted-1');
    assert.equal(retry.alreadyTransferred, true, 'idempotent retry does not create a new gift');
    assert.equal(await ledgerCount(1), 1);
    await mustReject(transfer(A,'CLAIM-1',C,'transfer-accepted-1'), 'TICKET_TRANSFER_REQUEST_CONFLICT');
    await mustReject(transfer(A,'CLAIM-1',C,'transfer-accepted-2'), 'EVENT_TICKET_TRANSFER_NOT_OWNED');
    await mustReject(db.query(
      "insert into public.event_ticket_claims(claim_id,event_ticket_id,member_id,status) values('NEW-OWNER',$1,$2,'claimed')",
      [ticketId(1),A]
    ), 'EVENT_TICKET_ALREADY_TRANSFERRED');
    await mustReject(transfer(B,'CLAIM-1',A,'transfer-return-1'), 'EVENT_TICKET_ALREADY_TRANSFERRED');
    await mustReject(transfer(B,'CLAIM-1',C,'transfer-forward-1'), 'EVENT_TICKET_ALREADY_TRANSFERRED');
    assert.equal(await claimOwner('CLAIM-1'), B, 'the gifted recipient retains the ticket');
    assert.equal(await ledgerCount(1), 1, 'each physical claim can only be gifted once');
    await mustReject(db.query(
      "insert into public.event_ticket_claims(claim_id,event_ticket_id,member_id,status) values('GIFT-RECLAIM',$1,$2,'claimed')",
      [ticketId(1),B]
    ), 'EVENT_TICKET_ALREADY_TRANSFERRED');

    await createTicket(2);
    await db.query("update public.event_ticket_claims set status='used' where claim_id='CLAIM-2'");
    await mustReject(transfer(A,'CLAIM-2',B,'transfer-used-1'),'EVENT_TICKET_TRANSFER_NOT_AVAILABLE');

    await createTicket(3);
    await mustReject(transfer(C,'CLAIM-3',B,'transfer-ownership-1'),'EVENT_TICKET_TRANSFER_NOT_OWNED');

    await createTicket(4);
    await db.query(
      "insert into public.booking_benefit_selections values($1,'event','CLAIM-4','pending')",[A]
    );
    await mustReject(transfer(A,'CLAIM-4',B,'transfer-reserved-1'),'EVENT_TICKET_TRANSFER_RESERVED');
    await db.exec("delete from public.booking_benefit_selections where benefit_ref='CLAIM-4'");
    await db.query(
      "insert into public.booking_receipts values($1,'accessible','awaiting_review',$2::jsonb)",
      [A,JSON.stringify([{kind:'event',id:'CLAIM-4'}])]
    );
    await mustReject(transfer(A,'CLAIM-4',B,'transfer-snapshot-1'),'EVENT_TICKET_TRANSFER_RESERVED');
    await db.exec("delete from public.booking_receipts");
    await transfer(A,'CLAIM-4',B,'transfer-unreserved-1');
    assert.equal(await claimOwner('CLAIM-4'),B);

    await createTicket(5,'coupon',A,`fixed_ticket_template_id='${tid(99)}'`);
    await mustReject(transfer(A,'CLAIM-5',B,'transfer-fixed-1'),'EVENT_TICKET_TRANSFER_RESTRICTED');
    await createTicket(6,'referral');
    await mustReject(transfer(A,'CLAIM-6',B,'transfer-referral-1'),'EVENT_TICKET_TRANSFER_RESTRICTED');
    await createTicket(7);
    await db.exec("update public.event_tickets set ends_on=current_date-1 where event_ticket_id='EVENT-7'");
    await mustReject(transfer(A,'CLAIM-7',B,'transfer-expired-1'),'EVENT_TICKET_TRANSFER_NOT_AVAILABLE');
    await createTicket(8);
    await db.exec("update public.event_tickets set allowed_tier_keys=array['gold'] where event_ticket_id='EVENT-8'");
    const goldToGeneral = await transfer(A,'CLAIM-8',B,'transfer-tier-1');
    assert.equal(goldToGeneral.alreadyTransferred,false,'a general-tier friend receives a gold-tier claim');
    assert.equal(await claimOwner('CLAIM-8'),B);
    await mustReject(transfer(B,'CLAIM-8',C,'transfer-tier-2'),'EVENT_TICKET_ALREADY_TRANSFERRED');

    await createTicket(9);
    await db.query(
      "insert into public.event_ticket_claims(claim_id,event_ticket_id,member_id,status) values('CLAIM-9-B',$1,$2,'claimed')",
      [ticketId(9),B]
    );
    await mustReject(transfer(A,'CLAIM-9',B,'transfer-duplicate-1'),'EVENT_TICKET_RECEIVER_ALREADY_OWNED');

    await createTicket(10);
    const race = await Promise.allSettled([
      transfer(A,'CLAIM-10',B,'transfer-race-a'),
      transfer(A,'CLAIM-10',C,'transfer-race-b'),
    ]);
    assert.equal(race.filter(x=>x.status==='fulfilled').length,1,'at most one concurrent winner');
    assert.equal(race.filter(x=>x.status==='rejected').length,1,'a stale sender is denied');
    assert.equal(await ledgerCount(10),1);
    assert.ok([B,C].includes(await claimOwner('CLAIM-10')));

    await db.query("update public.members set status='suspended' where id=$1",[A]);
    await createTicket(11);
    await mustReject(transfer(A,'CLAIM-11',B,'transfer-suspended-1'),'MEMBERSHIP_REQUIRED');
    console.log('event ticket friend transfer and one-time gift policy: 12 tickets, legacy-forwarding retention, lower-tier recipient, re-gifting rejection, atomicity and authorization passed');
  } finally {
    await db.close();
  }
}
run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
