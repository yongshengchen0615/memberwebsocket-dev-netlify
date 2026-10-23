-- #82 CI-ONLY synthetic reset fixture; do not deploy as a Supabase migration.
-- This function can execute only in an ephemeral ci_booking_<uuid> PostgreSQL
-- database created by tests/integration/postgres/database.cjs. Managed Auth /
-- Storage tables below are synthetic test doubles, NOT Supabase-managed data.
create schema maintenance;
create schema platform_private;
create schema booking_notifications;
create schema auth;
create schema storage;
create schema business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
create schema business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;

create table public.admins(id integer primary key);
create table public.members(id integer primary key);
create table public.system_settings(id integer primary key, state text not null);
create table platform_private.super_admins(id integer primary key references public.admins(id) on delete restrict, enabled boolean not null);
create table platform_private.tenants(id integer primary key);
create table platform_private.module_secrets(tenant_id integer references platform_private.tenants(id) on delete restrict);
create table platform_private.module_notification_routes(tenant_id integer references platform_private.tenants(id) on delete restrict);
create table platform_private.audit_events(id integer primary key);
create table booking_notifications.outbox(id integer primary key);
create table business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.admins(id integer primary key);
create table business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.members(id integer primary key);
create table business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bookings(id integer primary key references business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.members(id));
create table business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.outbox(id integer primary key);
create table business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.admins(id integer primary key);
create table business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.members(id integer primary key);
create table business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bookings(id integer primary key references business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.members(id));
create table business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.outbox(id integer primary key);
create table auth.users(id integer primary key);
create table storage.objects(id integer primary key);
create table maintenance.ci_reset_audit(
 request_id uuid primary key, actor text not null, reviewer text not null,
 prior_plan text not null, backup_checksum text not null, result jsonb not null,
 occurred_at timestamptz not null default clock_timestamp()
);
create table maintenance.ci_dispatch_gate(blocked boolean not null);
insert into maintenance.ci_dispatch_gate values(true);
create table maintenance.ci_root_bootstrap(id integer primary key, required boolean not null, enabled boolean not null);
insert into maintenance.ci_root_bootstrap values(1,false,true);

insert into public.admins values(1);
insert into public.members values(1),(2);
insert into public.system_settings values(1,'configured');
insert into platform_private.super_admins values(1,true);
insert into platform_private.tenants values(1),(2);
insert into platform_private.module_secrets values(1),(2);
insert into platform_private.module_notification_routes values(1),(2);
insert into platform_private.audit_events values(1);
insert into booking_notifications.outbox values(1);
insert into business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.admins values(1);
insert into business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.members values(1);
insert into business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bookings values(1);
insert into business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.outbox values(1);
insert into business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.admins values(2);
insert into business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.members values(2);
insert into business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bookings values(2);
insert into business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.outbox values(2);
insert into auth.users values(1);
insert into storage.objects values(1);

create function maintenance.ci_reset_plan() returns jsonb
language plpgsql stable security invoker set search_path=''
as $$
declare v_database text := pg_catalog.current_database(); v_names text[] := array[
 'public.admins','public.members','public.system_settings',
 'platform_private.super_admins','platform_private.tenants',
 'platform_private.module_secrets','platform_private.module_notification_routes','platform_private.audit_events',
 'booking_notifications.outbox',
 'business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.admins',
 'business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.members',
 'business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bookings',
 'business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.outbox',
 'business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.admins',
 'business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.members',
 'business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bookings',
 'business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.outbox',
 'auth.users','storage.objects'];
 v_actual integer; v_table text; v_n bigint; v_total bigint:=0; v_signature text:='';
begin
 if v_database !~ '^ci_booking_[a-f0-9]{32}$' then raise exception 'CI_ONLY_DATABASE_REQUIRED'; end if;
 select count(*)::integer into v_actual from pg_catalog.pg_tables
 where schemaname in ('public','platform_private','booking_notifications','auth','storage')
    or schemaname ~ '^business_[a-f0-9]{32}$';
 if v_actual <> pg_catalog.cardinality(v_names) or exists(
  select 1 from pg_catalog.pg_tables t
  where (t.schemaname in ('public','platform_private','booking_notifications','auth','storage')
    or t.schemaname ~ '^business_[a-f0-9]{32}$')
    and not (t.schemaname||'.'||t.tablename = any(v_names))
 ) then raise exception 'CI_RESET_UNKNOWN_TABLE_OR_SCHEMA_DRIFT'; end if;
 foreach v_table in array v_names loop
  execute 'select count(*)::bigint from '||v_table into v_n;
  v_total:=v_total+v_n;
  v_signature:=v_signature||v_table||':'||v_n::text||';';
 end loop;
 return pg_catalog.jsonb_build_object('tableCount',v_actual,'rowCount',v_total,
  'fingerprint',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_signature,'UTF8')),'hex'),
  'environment','synthetic_disposable_postgres','allowed',false);
end $$;

create function maintenance.ci_reset_synthetic(
 p_request_id uuid,p_plan_sha text,p_backup_sha text,p_actor text,p_reviewer text,
 p_confirmation text,p_fail_after_truncate boolean default false)
returns jsonb language plpgsql security invoker set search_path=''
as $$
declare v_prior maintenance.ci_reset_audit%rowtype; v_plan jsonb; v_result jsonb;
begin
 if pg_catalog.current_database() !~ '^ci_booking_[a-f0-9]{32}$'
   then raise exception 'CI_ONLY_DATABASE_REQUIRED'; end if;
 -- SQL caller identity is not trusted. These literal actors are a simulation
 -- only; live execution must use server-side attested MFA + two-person review.
 if p_actor is distinct from 'ci-root-actor' or p_reviewer is distinct from 'ci-separate-reviewer'
    or p_actor = p_reviewer then raise exception 'CI_TWO_PERSON_REVIEW_REQUIRED'; end if;
 if p_confirmation is distinct from 'RESET SYNTHETIC DATABASE'
    then raise exception 'CI_EXACT_CONFIRMATION_REQUIRED'; end if;
 if p_request_id is null or p_backup_sha is null or p_backup_sha !~ '^[a-f0-9]{64}$'
    or p_plan_sha is null or p_plan_sha !~ '^[a-f0-9]{64}$'
    then raise exception 'CI_BACKUP_AND_PLAN_REQUIRED'; end if;

 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ci_reset_synthetic',0));
 select * into v_prior from maintenance.ci_reset_audit where request_id=p_request_id;
 if found then
   if v_prior.actor<>p_actor or v_prior.reviewer<>p_reviewer
     or v_prior.prior_plan<>p_plan_sha or v_prior.backup_checksum<>p_backup_sha
   then raise exception 'CI_RESET_REPLAY_CONFLICT'; end if;
   return v_prior.result;
 end if;
 if not exists(select 1 from maintenance.ci_dispatch_gate where blocked=true)
    or exists(select 1 from maintenance.ci_dispatch_gate where blocked=false)
   then raise exception 'CI_EXTERNAL_DISPATCH_NOT_BLOCKED'; end if;
 v_plan:=maintenance.ci_reset_plan();
 if v_plan->>'fingerprint' is distinct from p_plan_sha then raise exception 'CI_RESET_STALE_PLAN'; end if;

 -- Entire synthetic fixture in a single transaction. Every FK parent AND
 -- child is named explicitly; never use CASCADE or dynamic unchecked TRUNCATE.
 truncate table
  public.admins,public.members,public.system_settings,
  platform_private.super_admins,platform_private.tenants,platform_private.module_secrets,
  platform_private.module_notification_routes,platform_private.audit_events,
  booking_notifications.outbox,
  business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.admins,
  business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.members,
  business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bookings,
  business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.outbox,
  business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.admins,
  business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.members,
  business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bookings,
  business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.outbox,
  auth.users,storage.objects restart identity;
 if p_fail_after_truncate then raise exception 'CI_INJECTED_TRANSACTION_FAILURE'; end if;
 insert into public.system_settings values(1,'ready');
 update maintenance.ci_root_bootstrap set required=true,enabled=false where id=1;
 v_result:=pg_catalog.jsonb_build_object('reset','synthetic_only','removedRows',(v_plan->>'rowCount')::bigint,
    'systemReady',true,'rootBootstrapRequired',true,'externalProviderVerified',false);
 insert into maintenance.ci_reset_audit(request_id,actor,reviewer,prior_plan,backup_checksum,result)
 values(p_request_id,p_actor,p_reviewer,p_plan_sha,p_backup_sha,v_result);
 return v_result;
end $$;
revoke all on function maintenance.ci_reset_plan(),
 maintenance.ci_reset_synthetic(uuid,text,text,text,text,text,boolean)
 from public,anon,authenticated,service_role;
