-- #82: fix repeatable full wipe when another Platform LINE login occurred
-- after a prior successful reset and the first root is still uninitialized.
-- No data deletion occurs when this migration is applied.
BEGIN;

CREATE OR REPLACE FUNCTION maintenance.request_full_reset_from_sql(p_confirmation text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_job uuid := pg_catalog.gen_random_uuid();
  v_ticket text;
  v_preview jsonb;
  v_request bigint;
begin
  if current_user <> 'postgres' then
    raise exception 'RESET_DBA_ONLY' using errcode='42501';
  end if;
  if p_confirmation is distinct from 'RESET MEMBERWEBSOCKET TEST DATA' then
    raise exception 'RESET_EXACT_CONFIRMATION_REQUIRED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('maintenance:sql-full-reset-request',0));
  -- A failed pg_net dispatch or Edge cold-start must never strand this test
  -- environment in queued/running forever. Tickets expire after 5 minutes;
  -- an Edge task running for 30+ minutes is no longer recoverable.
  update maintenance.sql_full_reset_jobs
  set state='failed', finished_at=pg_catalog.clock_timestamp(),
      error_code='RESET_STALE_BACKGROUND_JOB_EXPIRED'
  where (state='queued' and requested_at < pg_catalog.clock_timestamp()-interval '6 minutes')
     or (state='running' and started_at < pg_catalog.clock_timestamp()-interval '30 minutes');
  if exists(select 1 from maintenance.sql_full_reset_jobs
     where state in ('queued','running')) then
    raise exception 'RESET_JOB_ALREADY_ACTIVE';
  end if;
  -- Pending root bootstrap is a reset OUTPUT, not a prohibition on rerun.
  -- Pending Platform LINE identities must be erasable before root setup.
  -- Deliberate test-sandbox policy: this approved project is disposable.
  -- Require exact project scope, NOT backup/restore or provider attestations.
  if not exists (
    select 1 from maintenance.sandbox_reset_target
    where singleton and project_ref = 'dbuquirnaskrwcamdxki'
      and sandbox_approved
  ) then
    raise exception 'WRONG_RESET_PROJECT';
  end if;
  v_preview := maintenance.plan_sandbox_database_reset();
  v_ticket := pg_catalog.encode(extensions.gen_random_bytes(32),'hex');
  insert into maintenance.sql_full_reset_jobs(id,ticket_sha256,fingerprint)
  values(v_job,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_ticket,'UTF8')),'hex'),
         v_preview->>'fingerprint');
  -- pg_net only sends after SQL COMMIT. Never put service_role API keys in
  -- queued headers; this random ticket is scoped to one already approved job.
  select net.http_post(
    url := 'https://dbuquirnaskrwcamdxki.supabase.co/functions/v1/sql-full-reset-worker',
    body := pg_catalog.jsonb_build_object('job_id',v_job,'ticket',v_ticket),
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 120000
  ) into v_request;
  update maintenance.sql_full_reset_jobs
  set pg_net_request_id=v_request where id=v_job;
  return pg_catalog.jsonb_build_object(
    'submitted',true,'completed',false,'jobId',v_job,
    'message','QUEUED_NOT_YET_CLEARED',
    'checkStatusSql','select maintenance.latest_full_reset_status();');
end;
$function$


CREATE OR REPLACE FUNCTION maintenance.execute_sandbox_database_reset(p_request_id uuid, p_expected_fingerprint text, p_confirmation text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
 v_plan jsonb;
 v_table_list text;
 v_list_before text;
 v_list_after text;
 v_schema record;
 v_removed_schemas integer:=0;
 v_table_count integer;
 v_removed_rows bigint;
 v_current_request uuid;
begin
 -- Never grant this function to JWT roles or public Data API.
 if current_user is distinct from 'postgres' then
  raise exception 'RESET_DBA_ONLY' using errcode='42501';
 end if;
 if p_confirmation is distinct from 'RESET MEMBERWEBSOCKET TEST DATA'
  then raise exception 'RESET_EXACT_CONFIRMATION_REQUIRED'; end if;
 if p_request_id is null or p_expected_fingerprint !~ '^[a-f0-9]{64}$'
  then raise exception 'RESET_REQUEST_AND_PREVIEW_REQUIRED'; end if;
 perform pg_catalog.pg_advisory_xact_lock(
   pg_catalog.hashtextextended('maintenance:sandbox-reset-epoch',0));
 select last_completed_request into v_current_request
 from maintenance.sandbox_reset_epoch where singleton=true;
 if v_current_request = p_request_id then
   return pg_catalog.jsonb_build_object(
     'alreadyCompleted',true,'requestId',p_request_id,'rootBootstrapRequired',true);
 end if;
 -- This project's dataset is disposable by its owner's explicit policy.
 -- Preserve immutable authorization checks, SQL snapshot fingerprint, managed
 -- Auth/Storage zero postconditions and one-time bootstrap requirements.
 if not exists (
  select 1 from maintenance.sandbox_reset_target
  where singleton=true and project_ref='dbuquirnaskrwcamdxki'
    and sandbox_approved
 ) then raise exception 'WRONG_RESET_PROJECT'; end if;
 -- Permit repeat wipe during pending root bootstrap. Keep all other gates.
 if exists(select 1 from auth.users)
    or exists(select 1 from storage.objects) then
   raise exception 'RESET_AUTH_OR_STORAGE_API_CLEANUP_PENDING'; end if;
 if pg_catalog.to_regclass('cron.job') is not null then
   if exists(select 1 from cron.job where active) then
     raise exception 'RESET_ACTIVE_CRON_JOBS_PRESENT';
   end if;
 end if;
 -- Any TRUNCATE trigger could enqueue external work. Refuse unknown triggers.
 if exists (
  select 1 from pg_catalog.pg_trigger tr
  join pg_catalog.pg_class c on c.oid=tr.tgrelid
  join pg_catalog.pg_namespace ns on ns.oid=c.relnamespace
  where not tr.tgisinternal and (tr.tgtype::int & 32) <> 0
    and (ns.nspname in ('public','platform_private','booking_notifications','line_config')
      or ns.nspname ~ '^business_[a-f0-9]{32}$')
 ) then raise exception 'RESET_TRUNCATE_TRIGGER_REVIEW_REQUIRED'; end if;
 -- Before dropping a tenant schema, refuse externally owned materialized
 -- views, views or FKs that depend on tenant objects.
 if exists(
  select 1 from pg_catalog.pg_depend d
  join pg_catalog.pg_rewrite rw on rw.oid=d.objid
  join pg_catalog.pg_class dep on dep.oid=rw.ev_class
  join pg_catalog.pg_namespace depns on depns.oid=dep.relnamespace
  join pg_catalog.pg_class ref on ref.oid=d.refobjid
  join pg_catalog.pg_namespace refns on refns.oid=ref.relnamespace
  where refns.nspname ~ '^business_[a-f0-9]{32}$'
   and depns.nspname !~ '^business_[a-f0-9]{32}$'
   and dep.relkind in ('v','m')
 ) or exists(
  select 1 from pg_catalog.pg_constraint fk
  join pg_catalog.pg_class dep on dep.oid=fk.conrelid
  join pg_catalog.pg_namespace depns on depns.oid=dep.relnamespace
  join pg_catalog.pg_class ref on ref.oid=fk.confrelid
  join pg_catalog.pg_namespace refns on refns.oid=ref.relnamespace
  where fk.contype='f'
   and refns.nspname ~ '^business_[a-f0-9]{32}$'
   and depns.nspname !~ '^business_[a-f0-9]{32}$'
 ) then raise exception 'RESET_EXTERNAL_SCHEMA_DEPENDENCIES'; end if;
 -- No application table may be silently omitted if the schema is amended
 -- during approval. All verified assets are locked before final fingerprint.
 select pg_catalog.string_agg(pg_catalog.format('%I.%I',schemaname,tablename),
     ', ' order by schemaname,tablename),
    pg_catalog.string_agg(pg_catalog.format('%I.%I',schemaname,tablename),
     ';' order by schemaname,tablename),count(*)::integer
 into v_table_list,v_list_before,v_table_count
 from pg_catalog.pg_tables
 where (schemaname in ('public','platform_private','booking_notifications','line_config')
    or schemaname ~ '^business_[a-f0-9]{32}$')
   and not (schemaname='platform_private' and tablename='business_templates')
   and not (schemaname='line_config' and tablename='settings');
 if v_table_list is null or v_table_count=0
    then raise exception 'RESET_NO_TARGET_TABLES'; end if;
 execute 'lock table ' || v_table_list || ' in access exclusive mode';
 select pg_catalog.string_agg(pg_catalog.format('%I.%I',schemaname,tablename),
    ';' order by schemaname,tablename) into v_list_after
 from pg_catalog.pg_tables
 where (schemaname in ('public','platform_private','booking_notifications','line_config')
    or schemaname ~ '^business_[a-f0-9]{32}$')
   and not (schemaname='platform_private' and tablename='business_templates')
   and not (schemaname='line_config' and tablename='settings');
 if v_list_after is distinct from v_list_before
    then raise exception 'RESET_SCHEMA_DRIFT'; end if;
 v_plan := maintenance.plan_sandbox_database_reset();
 if v_plan->>'fingerprint' is distinct from p_expected_fingerprint
    then raise exception 'RESET_STALE_PREVIEW'; end if;
 v_removed_rows := (v_plan->>'plannedRows')::bigint;
 execute 'truncate table ' || v_table_list || ' restart identity';
 -- Remove inactive merchant runtime namespaces as well as their data.
 -- This only affects explicitly allowlisted business_<32hex> schemas.
 for v_schema in
   select nspname from pg_catalog.pg_namespace
   where nspname ~ '^business_[a-f0-9]{32}$' order by nspname
 loop
   execute pg_catalog.format('drop schema %I cascade',v_schema.nspname);
   v_removed_schemas := v_removed_schemas+1;
 end loop;
 -- Reconcile exposed business schemas inside this reset transaction.
 perform maintenance.prune_orphaned_postgrest_business_schemas();
 -- Recreate the system-required application configuration, not any account.
 perform maintenance.ensure_required_system_baseline();
 perform maintenance.ensure_referral_reward_baseline();
 perform maintenance.ensure_event_ticket_settings_baseline();
 if exists(select 1 from public.admins)
  or exists(select 1 from public.members)
  or exists(select 1 from platform_private.super_admins)
  or exists(select 1 from platform_private.tenants)
  or exists(select 1 from auth.users)
  or exists(select 1 from storage.objects)
  or exists(select 1 from pg_catalog.pg_namespace
    where nspname ~ '^business_[a-f0-9]{32}$')
 then raise exception 'RESET_POSTCONDITION_RESIDUAL_ACCOUNTS_OR_BUSINESSES'; end if;
 update maintenance.sandbox_reset_epoch
 set last_completed_request=p_request_id,
     last_completed_at=pg_catalog.clock_timestamp(),
     root_bootstrap_required=true,bootstrapped_at=null where singleton=true;
 if not found then raise exception 'RESET_EPOCH_NOT_INITIALIZED'; end if;
 -- Require a new independent backup and isolation proof for another reset.
 update maintenance.sandbox_reset_target
 set backup_verified_at=null,storage_restore_verified_at=null,
     provider_isolation_verified_at=null where singleton=true;
 return pg_catalog.jsonb_build_object(
   'requestId',p_request_id,
   'databaseReset',true,'removedRows',v_removed_rows,
   'truncatedTableCount',v_table_count,'droppedBusinessSchemas',v_removed_schemas,
   'rootBootstrapRequired',true,
   'managedStorageRemovedBySql',false,
   'environmentSecretsPreserved',true);
end;
$function$

COMMIT;
