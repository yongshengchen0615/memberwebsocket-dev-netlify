// Isolated PostgreSQL acceptance for tier inheritance and late issuance.
const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');

const migration = readFileSync(join(__dirname, '../../supabase/migrations/20261127010000_tier_inheritance_late_issuance.sql'), 'utf8');
const tiers = ['general', 'silver', 'gold', 'platinum'];
const ids = [
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
];
async function run() {
 const db = new PGlite();
 try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.members(
      id uuid primary key, line_user_id text unique, member_code text unique,
      status text not null default 'active', membership_status text not null default 'active',
      joined_at timestamptz default now(),created_at timestamptz default now()
    );
    create table public.membership_tier_settings(
      tier_key text not null, required_service_minutes integer not null
    );
    insert into public.membership_tier_settings values
      ('general',0),('silver',600),('gold',1800),('platinum',3600);
    create table public.service_time_entries(
      id uuid primary key default gen_random_uuid(),entry_id text unique,
      member_id uuid references public.members(id),minutes integer not null,
      created_by text not null
    );
    create table public.event_tickets(
      id uuid primary key default gen_random_uuid(),event_ticket_id text unique not null,
      title text not null,ticket_type text not null,description text default '',
      usage_method text default '', usage_instructions text default '',prizes jsonb default '[]'::jsonb,
      status text default 'draft',deleted_at timestamptz,starts_on date,ends_on date,
      quota integer default 0,allowed_tier_keys text[] not null default array['general'],
      fixed_ticket_template_id uuid,referral_source_event_ticket_id uuid,
      updated_by text default 'qa',created_at timestamptz default now()
    );
    create table public.event_ticket_claims(
      id uuid primary key default gen_random_uuid(),claim_id text not null unique,
      event_ticket_id uuid not null references public.event_tickets(id),
      member_id uuid not null references public.members(id),
      ticket_type text not null,ticket_title text not null,ticket_description text default '',
      usage_method text default '',usage_instructions text default '',
      prizes jsonb default '[]'::jsonb,status text default 'claimed',
      unique(event_ticket_id,member_id)
    );
    create table public.event_ticket_transfers(
      event_ticket_id uuid not null references public.event_tickets(id),
      sender_member_id uuid,receiver_member_id uuid
    );
    create table public.audit_logs(
      audit_id text,actor_line_user_id text,actor_role text,action text,
      target_type text,target_id text,result text,detail jsonb
    );
    create function public.new_public_id(text) returns text language sql
      as $$ select replace(gen_random_uuid()::text,'-','') $$;
    create function public.current_tier_key(p_member_id uuid) returns text language sql stable
      as $$ with t as (select coalesce(sum(minutes),0) n from public.service_time_entries where member_id=p_member_id)
            select case when n>=3600 then 'platinum' when n>=1800 then 'gold'
              when n>=600 then 'silver' else 'general' end from t $$;
    create function public.issue_eligible_general_event_ticket(p_event_id uuid)
      returns integer language plpgsql security definer as $f$
    declare v_event public.event_tickets%rowtype; v_issued integer;
    begin
      select * into v_event from public.event_tickets where id=p_event_id for update;
      if v_event.status <> 'active' or v_event.deleted_at is not null
        or v_event.ticket_type not in ('coupon','lottery')
        or v_event.fixed_ticket_template_id is not null
        or v_event.referral_source_event_ticket_id is not null then return 0; end if;
      with issued as (
        insert into public.event_ticket_claims
          (claim_id,event_ticket_id,member_id,ticket_type,ticket_title,
          ticket_description,usage_method,usage_instructions,prizes)
        select public.new_public_id('EC'),v_event.id,m.id,v_event.ticket_type,v_event.title,
          v_event.description,v_event.usage_method,v_event.usage_instructions,v_event.prizes
        from public.members m where m.status='active' and m.membership_status='active'
          and public.current_tier_key(m.id)=any(v_event.allowed_tier_keys)
          and not exists (select 1 from public.event_ticket_claims c
                          where c.event_ticket_id=v_event.id and c.member_id=m.id)
        on conflict do nothing returning id
      ) select count(*) into v_issued from issued;
      return v_issued;
    end; $f$;
  `);
  // These isolated stand-ins allow the migration to assert that every production
  // authorization family is rewritten, without importing unrelated booking schemas.
  const families = [
    'issue_fixed_tickets','bind_member_referral','issue_membership_join_ticket',
    'redeem_event_ticket','redeem_event_tickets_with_location',
    'redeem_event_tickets_for_booking_request','count_today_usable_event_tickets',
    'fixed_ticket_notification_delivery','replace_booking_benefit_selections_request',
    'validate_snapshot_ticket_selection','complete_booking_with_benefits_request',
    'complete_booking_with_rewards_request','grant_member_benefits_with_event_bonus',
  ];
  for(const name of families) {
    await db.exec(`create function public.${name}() returns boolean language sql as
      $tier_stub$select tier=any(allowed_tier_keys) from (select 'general'::text as tier, array['general']::text[] as allowed_tier_keys) t$tier_stub$;`);
  }
  await db.exec(`
    create table public.qa_fixed_calls(member_id uuid,called_at date);
    create function public.issue_fixed_tickets(p_business_date date,
      p_member_id uuid,p_template_id uuid) returns jsonb language plpgsql
    as $fixed$
    begin
      insert into public.qa_fixed_calls(member_id,called_at)
      values(p_member_id,p_business_date);
      return '{"issued":0}'::jsonb;
    end;
    $fixed$;
  `);
  await db.exec(migration);
  // The release ledger can replay a previously applied schema from another tool;
  // repeat with identical SQL and reject all destructive or non-idempotent drift.
  await db.exec(migration);
  const matrix = (await db.query(`
   select t.current,a.required,public.tier_allows(t.current,array[a.required]) allowed
   from unnest(array['general','silver','gold','platinum']) t(current)
   cross join unnest(array['general','silver','gold','platinum']) a(required)`)).rows;
  assert.equal(matrix.length,16);
  for(const {current,required,allowed} of matrix)
    assert.equal(allowed,tiers.indexOf(current)>=tiers.indexOf(required),`${current}->${required}`);
  assert.equal((await db.query("select public.tier_allows('unknown',array['general']) ok")).rows[0].ok,false);
  assert.equal((await db.query("select public.tier_allows('platinum',array['invalid']) ok")).rows[0].ok,false);
  assert.equal((await db.query("select public.tier_allows('gold',array['silver','platinum']) ok")).rows[0].ok,true);

  const addEvent=async (code,required,ends='2099-12-31') => {
    const out=await db.query(`insert into public.event_tickets
     (event_ticket_id,title,ticket_type,status,allowed_tier_keys,ends_on,updated_by)
     values($1,$1,'coupon','active',array[$2]::text[],$3,'qa') returning id`,[code,required,ends]);
    return out.rows[0].id;
  };
  const count=async (code, member) => Number((await db.query(`
    select count(*)::int n from public.event_ticket_claims c
    join public.event_tickets e on e.id=c.event_ticket_id
    where e.event_ticket_id=$1 and ($2::uuid is null or c.member_id=$2::uuid)`,[code,member||null])).rows[0].n);
  await db.query(`insert into public.members(id,line_user_id,member_code) values
    ($1,'tier-1','T1'),($2,'tier-2','T2'),($3,'tier-3','T3')`,ids);

  const fixedCalls=async()=>(await db.query(
    "select count(*)::integer as count from public.qa_fixed_calls")).rows[0].count;
  assert.equal(await fixedCalls(),3,'newly active members reconcile fixed-cycle entitlements');
  await addEvent('SILVER','silver');
  assert.equal(await count('SILVER'),0,'general users cannot receive silver');
  await db.query('insert into public.service_time_entries(entry_id,member_id,minutes,created_by) values ($1,$2,$3,\'qa\')',['a',ids[0],600]);
  assert.equal(await count('SILVER',ids[0]),1,'promoted silver member receives existing ticket');
  await db.query('insert into public.service_time_entries(entry_id,member_id,minutes,created_by) values ($1,$2,$3,\'qa\')',['b',ids[1],1800]);
  assert.equal(await count('SILVER',ids[1]),1,'gold member inherits silver tickets');
  assert.equal(await fixedCalls(),5,'both upgrades reconcile fixed-cycle entitlements');
  await db.query('select public.issue_member_tier_event_tickets($1)',[ids[0]]);
  await db.query('select public.issue_member_tier_event_tickets($1)',[ids[0]]);
  assert.equal(await count('SILVER',ids[0]),1,'retry must not create duplicate entitlements');
  assert.equal(await fixedCalls(),5,'repeat read must not replay fixed-cycle issuer');

  await addEvent('GOLD','gold');
  assert.equal(await count('GOLD',ids[0]),0,'silver cannot receive gold');
  assert.equal(await count('GOLD',ids[1]),1,'gold qualifies for gold');
  await addEvent('EXPIRED','gold','2020-01-01');
  await db.query('insert into public.service_time_entries(entry_id,member_id,minutes,created_by) values ($1,$2,$3,\'qa\')',['c',ids[2],1800]);
  assert.equal(await count('GOLD',ids[2]),1,'newly promoted gold member receives still-active gold event');
  assert.equal(await fixedCalls(),6,'newly promoted member runs fixed-cycle issuer');
  assert.equal(await count('EXPIRED',ids[2]),0,'expired event must not be issued on promotion');
  await addEvent('PLATINUM','platinum');
  assert.equal(await count('PLATINUM'),0);
  await db.query('insert into public.service_time_entries(entry_id,member_id,minutes,created_by) values ($1,$2,$3,\'qa\')',['a2',ids[0],3000]);
  assert.equal(await count('PLATINUM',ids[0]),1,'platinum promotion auto issues platinum');
  assert.equal(await count('PLATINUM',ids[1]),0);
  assert.equal(await fixedCalls(),7,'platinum upgrade runs fixed-cycle issuer exactly once');
  assert.equal(await count('SILVER',ids[0]),1,'platinum promotion does not duplicate lower-tier claim');

  // Dynamic SQL rewriting in the migration must have reached the RPCs too.
  const gates=(await db.query(`select p.proname,p.prosrc from pg_proc p
    where p.pronamespace='public'::regnamespace and p.proname=any($1::text[])`,[families])).rows;
  assert.equal(gates.length,families.length);
  for(const gate of gates)assert.match(gate.prosrc,/tier_allows/i,`server gate still uses exact tier: ${gate.proname}`);
  console.log('tier inheritance: 16 tier pairs + 9 issuance/expiry/idempotency checks and server gates verified');
 } finally { await db.close(); }
}
run().catch(err=>{console.error(err);process.exitCode=1});
