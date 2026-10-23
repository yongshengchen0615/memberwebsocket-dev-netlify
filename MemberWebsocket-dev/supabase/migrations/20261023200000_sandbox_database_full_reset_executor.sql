-- #82: Real application reset, restricted to the owner-approved test project.
-- This is only the database phase of the full orchestration. The operator must
-- separately back up/restore-test DB and Storage, remove Storage object BYTES
-- via Storage API, revoke managed Auth sessions via Admin API and stop dispatch.
-- This migration NEVER performs a reset at install time.
begin;

create or replace function maintenance.plan_sandbox_database_reset()
returns jsonb language plpgsql stable security invoker set search_path=''
as $fn$
declare
 t record;
 n bigint;
 v_digest text;
 v_signature text := '';
 v_items jsonb := '[]'::jsonb;
 v_rows bigint := 0;
 v_tables integer := 0;
 v_schemas integer := 0;
begin
 if not exists(
  select 1 from maintenance.sandbox_reset_target
  where singleton=true and sandbox_approved and project_ref='dbuquirnaskrwcamdxki'
 ) then raise exception 'WRONG_RESET_PROJECT'; end if;
 for t in
  select schemaname,tablename from pg_catalog.pg_tables
  where (schemaname in ('public','platform_private','booking_notifications','line_config')
         or schemaname ~ '^business_[a-f0-9]{32}$')
    and not (schemaname='platform_private' and tablename='business_templates')
    and not (schemaname='line_config' and tablename='settings')
  order by schemaname,tablename
 loop
  -- SHA-256 includes actual row contents, not merely row counts. Do not return
  -- plaintext member, LINE or secret data to the operator.
  execute pg_catalog.format(
   'select count(*)::bigint, encode(sha256(convert_to(coalesce(string_agg(md5(row_to_json(t)::text),''|'' order by md5(row_to_json(t)::text)),''''),''UTF8'')),''hex'') from %I.%I t',
   t.schemaname,t.tablename
  ) into n,v_digest;
  v_signature := v_signature || pg_catalog.format('%I.%I',t.schemaname,t.tablename)
    || ':' || n::text || ':' || v_digest || ';';
  v_rows := v_rows + n;
  v_tables := v_tables + 1;
  v_items := v_items || pg_catalog.jsonb_build_array(
   pg_catalog.jsonb_build_object('schema',t.schemaname,'table',t.tablename,'rows',n));
 end loop;
 select count(*) into v_schemas from pg_catalog.pg_namespace
 where nspname ~ '^business_[a-f0-9]{32}$';
 return pg_catalog.jsonb_build_object(
   'projectRef','dbuquirnaskrwcamdxki',
   'operation','delete_every_account_and_business_in_test_project',
   'readOnly',true,'executionAllowed',false,
   'tableCount',v_tables,'plannedRows',v_rows,
   'businessSchemas',v_schemas,'tables',v_items,
   'fingerprint',pg_catalog.encode(
     pg_catalog.sha256(pg_catalog.convert_to(v_signature,'UTF8')),'hex')
 );
end;
$fn$;

create or replace function maintenance.execute_sandbox_database_reset(
 p_request_id uuid, p_expected_fingerprint text, p_confirmation text)
returns jsonb language plpgsql security invoker set search_path=''
as $fn$
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
 if not exists (
  select 1 from maintenance.sandbox_reset_target
  where singleton=true and project_ref='dbuquirnaskrwcamdxki'
    and sandbox_approved
    and backup_verified_at is not null
    and storage_restore_verified_at is not null
    and provider_isolation_verified_at is not null
 ) then raise exception 'RESET_BACKUP_STORAGE_AND_PROVIDER_PROOF_REQUIRED'; end if;
 if exists(select 1 from maintenance.sandbox_reset_epoch
   where singleton=true and root_bootstrap_required) then
   raise exception 'RESET_ROOT_BOOTSTRAP_PENDING'; end if;
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
$fn$;
revoke all on function maintenance.plan_sandbox_database_reset()
 from public,anon,authenticated,service_role;
revoke all on function maintenance.execute_sandbox_database_reset(uuid,text,text)
 from public,anon,authenticated,service_role;
commit;
