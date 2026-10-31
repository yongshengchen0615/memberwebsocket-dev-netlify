-- Maintenance-only "移除所有資料": clear business data, merchant applications, and current root grants.
-- No client-facing route is exposed. SQL operator must type the exact confirmation.
begin;
create or replace function maintenance.remove_all_data(p_confirmation text default null)
returns table(truncated_table_count integer, removed_platform_rows bigint)
language plpgsql security invoker set search_path=''
as $function$
declare v_cleared integer;v_rows bigint;
begin
 if p_confirmation is distinct from 'REMOVE ALL DATA' then
  raise exception 'CONFIRM_REMOVE_ALL_DATA_REQUIRED';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('maintenance:remove_all_data',0));
 select c.truncated_table_count into v_cleared from maintenance.clear_public_data(true) c;
 select (select count(*) from platform_private.applications)
  +(select count(*) from platform_private.tenants)
  +(select count(*) from platform_private.tenant_secrets)
  +(select count(*) from platform_private.requests)
  +(select count(*) from platform_private.audit_events)
 into v_rows;
 truncate table platform_private.applications,platform_private.tenant_secrets,
  platform_private.audit_events,platform_private.requests,platform_private.tenants restart identity;
 update platform_private.super_admins set enabled=false;
 return query select v_cleared,v_rows;
end;
$function$;
revoke all on function maintenance.remove_all_data(text) from public,anon,authenticated,service_role;
commit;
