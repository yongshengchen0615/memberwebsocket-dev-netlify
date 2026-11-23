// Database acceptance tests for automatic issuance (isolated PGlite, synthetic users only).
const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const migration = readFileSync(join(__dirname,
  '../../supabase/migrations/20261123120000_event_ticket_automatic_issuance.sql'), 'utf8');
const usageMigration = readFileSync(join(__dirname,
  '../../supabase/migrations/20261123133000_event_ticket_redemption_quota_not_issuance.sql'), 'utf8');

async function run() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      create table public.members (
        id uuid primary key, line_user_id text unique not null,
        member_code text unique not null, tier text not null default 'general',
        status text not null default 'active', membership_status text not null default 'active',
        joined_at timestamptz, created_at timestamptz default now()
      );
      create table public.member_referrals(id uuid primary key default gen_random_uuid());
      create table public.event_tickets (
        id uuid primary key default gen_random_uuid(), event_ticket_id text unique not null,
        title text not null, ticket_type text not null, status text not null default 'draft',
        deleted_at timestamptz, fixed_ticket_template_id uuid, referral_source_event_ticket_id uuid,
        quota integer not null default 0, allowed_tier_keys text[] not null default array['general'],
        description text not null default '', usage_method text not null default '',
        usage_instructions text not null default '', prizes jsonb not null default '[]'::jsonb,
        updated_by text
      );
      create table public.event_ticket_claims (
        id uuid primary key default gen_random_uuid(), claim_id text not null unique,
        event_ticket_id uuid not null references public.event_tickets(id),
        member_id uuid not null references public.members(id),
        ticket_type text not null, ticket_title text not null,
        ticket_description text not null default '',
        usage_method text not null default '', usage_instructions text not null default '',
        prizes jsonb not null default '[]'::jsonb, status text default 'claimed',
        unique(event_ticket_id,member_id)
      );
      create table public.event_ticket_transfers (
        event_ticket_id uuid not null references public.event_tickets(id),
        sender_member_id uuid, receiver_member_id uuid
      );
      create table public.audit_logs (
        audit_id text, actor_line_user_id text, actor_role text, action text,
        target_type text, target_id text, result text, detail jsonb
      );
      create function public.new_public_id(text) returns text language sql as
        $$ select replace(gen_random_uuid()::text,'-','') $$;
      create function public.current_tier_key(p_member_id uuid) returns text
        language sql stable as
        $$ select tier from public.members where id=p_member_id $$;
      insert into public.members(id,line_user_id,member_code,tier,joined_at) values
        ('00000000-0000-0000-0000-000000000001','member-1','C1','general','2026-01-01'),
        ('00000000-0000-0000-0000-000000000002','member-2','C2','general','2026-01-02'),
        ('00000000-0000-0000-0000-000000000003','member-3','C3','gold','2026-01-03');
    `);
    await db.exec(migration);
    // Existing quota-limited active campaign has only one grant under the old rule.
    await db.exec("insert into public.event_tickets(event_ticket_id,title,ticket_type,quota,status,updated_by) values('LEGACY','Legacy','coupon',1,'active','qa')");
    const legacyBefore=(await db.query("select count(*)::integer n from public.event_ticket_claims c join public.event_tickets e on e.id=c.event_ticket_id where e.event_ticket_id='LEGACY'")).rows[0].n;
    assert.equal(legacyBefore,1);
    await db.exec(usageMigration);
    const legacyAfter=(await db.query("select count(*)::integer n from public.event_ticket_claims c join public.event_tickets e on e.id=c.event_ticket_id where e.event_ticket_id='LEGACY'")).rows[0].n;
    assert.equal(legacyAfter,2,'migration backfills all eligible accounts despite usage quota');
    const count = async (code) => Number((await db.query(
      'select count(*)::int as n from public.event_ticket_claims c join public.event_tickets e on e.id=c.event_ticket_id where e.event_ticket_id=$1',[code]
    )).rows[0].n);
    const add = async (code,quota,tier='general',status='active',kind='coupon') => db.query(
      `insert into public.event_tickets (event_ticket_id,title,ticket_type,quota,allowed_tier_keys,status,updated_by)
        values ($1,$1,$2,$3,array[$4]::text[],$5,'admin-1') returning id`,
      [code,kind,quota,tier,status]
    );
    const claim = async (member,code) => (await db.query(
      'select public.claim_event_ticket($1,$2) as result',[member,code]
    )).rows[0].result;

    // AC-001: quota=1 still issues to ALL eligible members, not one member.
    await add('ONE',1);
    assert.equal(await count('ONE'),2);
    const issued=await claim('member-1','ONE');
    assert.ok(issued.claimId);
    assert.equal(issued.alreadyClaimed,true);
    assert.equal((await claim('member-2','ONE')).alreadyClaimed,true);
    assert.equal(await count('ONE'),2,'issued count is independent of quota');

    // AC-002: same event/activation repeated does not duplicate claims or audit.
    await db.exec("update public.event_tickets set status='active' where event_ticket_id='ONE'");
    assert.equal(await count('ONE'),2);
    assert.equal((await claim('member-1','ONE')).claimId,issued.claimId);
    const audit=(await db.query(
      "select detail->>'issuedCount' as issued from public.audit_logs where target_id='ONE'"
    )).rows;
    assert.equal(audit.length,1);
    assert.equal(audit[0].issued,'2');

    // AC-003: a draft does not issue; activation issues all two eligible members.
    await add('TWO',2,'general','draft');
    assert.equal(await count('TWO'),0);
    await db.exec("update public.event_tickets set status='active' where event_ticket_id='TWO'");
    assert.equal(await count('TWO'),2);
    await assert.rejects(claim('member-3','TWO'),/EVENT_TICKET_ISSUANCE_ONLY/);

    // AC-004: zero quota permits unlimited redemptions and one owned copy per member.
    await add('ALL',0);
    assert.equal(await count('ALL'),2);
    await db.exec("update public.event_tickets set status='archived' where event_ticket_id='ALL'");
    await db.exec("update public.event_tickets set status='active' where event_ticket_id='ALL'");
    assert.equal(await count('ALL'),2);

    // AC-005: finite quota stops the next successful redemption, not issuance.
    const oneId=(await db.query("select id from public.event_tickets where event_ticket_id='ONE'")).rows[0].id;
    const [oneFirst,oneSecond]=(await db.query(
      "select id from public.event_ticket_claims where event_ticket_id=$1 order by member_id",[oneId]
    )).rows;
    await db.query("update public.event_ticket_claims set status='used' where id=$1",[oneFirst.id]);
    const usedCount=async (code)=>(await db.query(
      "select used_count::integer as n from public.event_ticket_used_counts(array[(select id from public.event_tickets where event_ticket_id=$1)])",[code]
    )).rows[0].n;
    assert.equal(await usedCount('ONE'),1);
    await assert.rejects(db.query("update public.event_ticket_claims set status='used' where id=$1",[oneSecond.id]),/EVENT_USAGE_QUOTA_REACHED/);
    assert.equal(await usedCount('ONE'),1,'rejected use must not increment used count');
    assert.equal(await count('ONE'),2,'rejected use must not revoke already-issued claims');
    await db.query("update public.event_ticket_claims set status='used' where id=$1",[oneFirst.id]);
    assert.equal(await usedCount('ONE'),1,'duplicate use stays idempotent');

    // AC-006: unlimited usage permits more redemptions than the finite quota.
    await db.exec("update public.event_ticket_claims set status='used' where event_ticket_id=(select id from public.event_tickets where event_ticket_id='ALL')");
    assert.equal(await usedCount('ALL'),2);
    await assert.rejects(db.exec("update public.event_tickets set quota=1 where event_ticket_id='ALL'"),/EVENT_USAGE_QUOTA_BELOW_USED_COUNT/);
    assert.equal(await usedCount('ALL'),2,'refused quota reduction retains used history');

    // AC-007: synthetic referral/member-join campaigns remain explicitly issued.
    await add('REF',1,'general','active','referral');
    await add('JOIN',1,'general','active','membership_join');
    assert.equal(await count('REF'),0);
    assert.equal(await count('JOIN'),0);
    await assert.rejects(claim('member-1','REF'),/REFERRAL_TICKET_AUTO_ONLY/);
    await assert.rejects(claim('member-1','JOIN'),/MEMBERSHIP_JOIN_TICKET_AUTO_ONLY/);

    // AC-008: referral children share their source campaign's usage quota.
    const refId=(await db.query("select id from public.event_tickets where event_ticket_id='REF'")).rows[0].id;
    const ref1=(await db.query(
      "insert into public.event_tickets(event_ticket_id,title,ticket_type,status,quota,updated_by,referral_source_event_ticket_id) values('REF1','R1','referral','active',1,'qa',$1) returning id",[refId]
    )).rows[0].id;
    const ref2=(await db.query(
      "insert into public.event_tickets(event_ticket_id,title,ticket_type,status,quota,updated_by,referral_source_event_ticket_id) values('REF2','R2','referral','active',1,'qa',$1) returning id",[refId]
    )).rows[0].id;
    await db.query("insert into public.event_ticket_claims(claim_id,event_ticket_id,member_id,ticket_type,ticket_title) values('REFCLAIM1',$1,'00000000-0000-0000-0000-000000000001','referral','Referral 1')",[ref1]);
    await db.query("insert into public.event_ticket_claims(claim_id,event_ticket_id,member_id,ticket_type,ticket_title) values('REFCLAIM2',$1,'00000000-0000-0000-0000-000000000002','referral','Referral 2')",[ref2]);
    await db.exec("update public.event_ticket_claims set status='used' where claim_id='REFCLAIM1'");
    await assert.rejects(db.exec("update public.event_ticket_claims set status='used' where claim_id='REFCLAIM2'"),/EVENT_USAGE_QUOTA_REACHED/);
    assert.equal(await usedCount('REF'),1);

    // AC-009: no newly eligible user may bypass automatic issuance through a stale client.
    await db.exec(`insert into public.members (id,line_user_id,member_code,tier)
      values('00000000-0000-0000-0000-000000000004','member-4','C4','general')`);
    await assert.rejects(claim('member-4','ALL'),/EVENT_TICKET_ISSUANCE_ONLY/);
    assert.equal(await count('ALL'),2);

    console.log('event ticket issuance and usage quota: 9 PGlite acceptance scenarios passed');
  } finally {
    await db.close();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
