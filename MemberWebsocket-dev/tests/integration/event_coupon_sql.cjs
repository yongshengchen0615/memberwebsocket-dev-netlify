const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');

const db = new PGlite();
const migration = readFileSync(join(__dirname, '../../supabase/migrations/20260928101903_event_coupon_inventory_location.sql'), 'utf8');
const retryMigration = readFileSync(join(__dirname, '../../supabase/migrations/20260928102644_event_coupon_idempotent_retry.sql'), 'utf8');
const multiLocationMigration = readFileSync(join(__dirname, '../../supabase/migrations/20260929012256_event_coupon_multiple_redemption_locations.sql'), 'utf8');

async function run() {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.members (
      id uuid primary key, line_user_id text unique not null,
      status text not null default 'active', membership_status text not null default 'active'
    );
    create table public.event_tickets (
      id uuid primary key, event_ticket_id text unique not null, ticket_type text not null,
      status text not null default 'active', deleted_at timestamptz, starts_on date, ends_on date,
      fixed_ticket_template_id uuid, allowed_tier_keys text[] not null default array['general'],
      quota integer not null default 0, title text not null default '券', description text not null default '',
      usage_method text not null default '', usage_instructions text not null default '', prizes jsonb not null default '[]'
    );
    create table public.event_ticket_claims (
      id uuid primary key default gen_random_uuid(), claim_id text unique not null,
      event_ticket_id uuid not null references public.event_tickets(id),
      member_id uuid not null references public.members(id),
      ticket_type text not null, ticket_title text not null, ticket_description text not null,
      usage_method text not null, usage_instructions text not null, prizes jsonb not null,
      status text not null default 'claimed', used_at timestamptz, result jsonb, updated_at timestamptz,
      unique(event_ticket_id,member_id)
    );
    create table public.audit_logs (
      audit_id text, actor_line_user_id text, actor_role text, action text,
      target_type text, target_id text, result text
    );
    create function public.current_tier_key(uuid) returns text language sql as $$ select 'general'::text $$;
    create function public.new_public_id(text) returns text language sql as $$ select gen_random_uuid()::text $$;
    create function public.pick_lottery_prize(jsonb) returns jsonb language sql as $$ select null::jsonb $$;
    insert into public.members(id,line_user_id) values
      ('00000000-0000-0000-0000-000000000001','member-1'),
      ('00000000-0000-0000-0000-000000000002','member-2');
    insert into public.event_tickets(id,event_ticket_id,ticket_type,quota) values
      ('10000000-0000-0000-0000-000000000001','LAST','coupon',1),
      ('10000000-0000-0000-0000-000000000002','GEO','coupon',1),
      ('10000000-0000-0000-0000-000000000003','OLD','coupon',1),
      ('10000000-0000-0000-0000-000000000004','RACE','coupon',1),
      ('10000000-0000-0000-0000-000000000005','EXPIRED','coupon',1);
  `);
  await db.exec(migration);
  await db.exec(retryMigration);
  const claim = async (member, ticket) => (await db.query(
    'select public.claim_event_ticket($1,$2) as value', [member, ticket]
  )).rows[0].value;
  const redeem = async (member, id, location) => (await db.query(
    'select public.redeem_event_ticket($1,$2,$3::jsonb) as value', [member, id, location && JSON.stringify(location)]
  )).rows[0].value;

  const first = await claim('member-1', 'LAST');
  assert.equal(first.alreadyClaimed, false);
  assert.equal((await claim('member-1', 'LAST')).alreadyClaimed, true, 'full stock must not break retries');
  await assert.rejects(claim('member-2', 'LAST'), /EVENT_QUOTA_REACHED/);
  await db.exec("update public.event_tickets set ends_on=current_date-1 where event_ticket_id='LAST'");
  assert.equal((await claim('member-1', 'LAST')).claimId, first.claimId, 'an ended campaign must retain the same claim');
  await db.exec("update public.event_tickets set deleted_at=now() where event_ticket_id='LAST'");
  assert.equal((await claim('member-1', 'LAST')).claimId, first.claimId, 'an archived campaign must retain the same claim');
  await assert.rejects(claim('member-2', 'LAST'), /EVENT_TICKET_NOT_AVAILABLE/);
  const race = await Promise.allSettled([claim('member-1','RACE'),claim('member-2','RACE')]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(race.filter((result) => result.status === 'rejected' && /EVENT_QUOTA_REACHED/.test(String(result.reason))).length, 1);
  await db.exec("update public.event_tickets set ends_on=current_date-1 where event_ticket_id='EXPIRED'");
  await assert.rejects(claim('member-1','EXPIRED'), /EVENT_ENDED/);
  const count = (await db.query("select claimed_count from public.event_ticket_claim_counts(array['10000000-0000-0000-0000-000000000001']::uuid[])")).rows[0].claimed_count;
  assert.equal(Number(count), 1);

  await db.exec("update public.event_tickets set requires_location=true, redemption_latitude=25.033964, redemption_longitude=121.564468, redemption_radius_meters=150 where event_ticket_id='GEO'");
  await db.exec(multiLocationMigration);
  const backfilled = (await db.query("select redemption_locations from public.event_tickets where event_ticket_id='GEO'")).rows[0].redemption_locations;
  assert.equal(backfilled.length, 1, 'old location must migrate without losing the rule');
  await db.exec(`update public.event_tickets set redemption_locations='[
    {"name":"遠端據點","latitude":24.000000,"longitude":120.000000,"radiusMeters":100},
    {"name":"台北據點","latitude":25.033964,"longitude":121.564468,"radiusMeters":150}
  ]'::jsonb where event_ticket_id='GEO'`);
  const geo = await claim('member-1', 'GEO');
  assert.ok(geo.claimId, 'claim must work without location');
  await assert.rejects(redeem('member-1', geo.claimId, null), /LOCATION_REQUIRED/);
  await assert.rejects(redeem('member-2', geo.claimId, null), /CLAIM_NOT_FOUND/);
  const near = { latitude:25.033964, longitude:121.564468, accuracy:10, observedAt:new Date().toISOString() };
  await assert.rejects(redeem('member-1', geo.claimId, { ...near, latitude:25.1 }), /LOCATION_OUT_OF_RANGE/);
  await assert.rejects(db.exec("update public.event_tickets set redemption_locations='[{\"name\":\"\",\"latitude\":25,\"longitude\":121,\"radiusMeters\":100}]'::jsonb where event_ticket_id='GEO'"), /event_tickets_redemption_locations_valid/);
  await assert.rejects(redeem('member-1', geo.claimId, { ...near, accuracy:200 }), /LOCATION_INVALID/);
  await assert.rejects(redeem('member-1', geo.claimId, { ...near, observedAt:new Date(Date.now()-300000).toISOString() }), /LOCATION_INVALID/);
  assert.equal((await redeem('member-1', geo.claimId, near)).alreadyUsed, false);
  assert.equal((await redeem('member-1', geo.claimId, null)).alreadyUsed, true, 'replay must not consume again');
  assert.equal((await db.query('select count(*)::int as n from public.audit_logs where action=$1', ['user.event.ticket.redeem'])).rows[0].n, 1);
  await assert.rejects(db.exec("update public.event_tickets set requires_location=true where event_ticket_id='OLD'"), /event_tickets_redemption_location_valid/);
  await db.exec("update public.event_tickets set requires_location=true, redemption_latitude=25.033964, redemption_longitude=121.564468, redemption_radius_meters=100 where event_ticket_id='OLD'");
  assert.equal((await db.query("select jsonb_array_length(redemption_locations) as n from public.event_tickets where event_ticket_id='OLD'")).rows[0].n, 1,
    'legacy admin save must remain compatible during rollout');
  await db.close();
}

run().then(() => console.log('event coupon inventory, location, ownership, replay: passed')).catch((error) => {
  console.error(error); process.exitCode = 1;
});
