begin;

-- event_ticket_settings is a singleton business setting. One-click data clear
-- truncates all non-admin public tables, so it must be rebuilt with the other
-- required system baselines.
create or replace function maintenance.ensure_event_ticket_settings_baseline()
returns void
language plpgsql
set search_path = ''
as $function$
begin
  insert into public.event_ticket_settings(
    id,
    max_tickets_per_redemption,
    max_tickets_per_day,
    updated_by
  )
  values (1, 1, 1, 'system')
  on conflict (id) do nothing;

  if not exists (
    select 1
      from public.event_ticket_settings
     where id = 1
       and max_tickets_per_day between 1 and 50
       and max_tickets_per_redemption between 1 and 50
  ) then
    raise exception 'REQUIRED_EVENT_TICKET_SETTINGS_BASELINE_INVALID';
  end if;
end;
$function$;

revoke all on function maintenance.ensure_event_ticket_settings_baseline() from public, anon, authenticated;
grant execute on function maintenance.ensure_event_ticket_settings_baseline() to service_role;

create or replace function maintenance.clear_public_data(confirm_clear boolean default false)
returns table(truncated_table_count integer)
language plpgsql
set search_path = ''
as $function$
declare
  table_list text;
  table_count integer;
begin
  if confirm_clear is distinct from true then
    raise exception 'Refusing to clear data: call maintenance.clear_public_data(true) to confirm';
  end if;

  select
    string_agg(format('%I.%I', schemaname, tablename), ', ' order by schemaname, tablename),
    count(*)::integer
  into table_list, table_count
  from pg_catalog.pg_tables
  where schemaname in ('public', 'booking_notifications')
    and not (schemaname = 'public' and tablename = 'admins');

  if table_list is not null then
    execute 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY';
  end if;

  if pg_catalog.to_regclass('public.test_member_sequence') is not null then
    perform pg_catalog.setval('public.test_member_sequence'::regclass, 1, false);
  end if;

  perform maintenance.ensure_required_system_baseline();
  perform maintenance.ensure_event_ticket_settings_baseline();

  return query select coalesce(table_count, 0);
end;
$function$;

create or replace function maintenance.clear_non_admin_data(confirm_clear boolean default false)
returns table(truncated_table_count integer)
language plpgsql
set search_path = ''
as $function$
declare
  table_list text;
  table_count integer;
  admin_count_before bigint;
  admin_count_after bigint;
begin
  if confirm_clear is distinct from true then
    raise exception 'Refusing to clear data: call maintenance.clear_non_admin_data(true) to confirm';
  end if;

  select count(*) into admin_count_before from public.admins;

  select
    string_agg(format('%I.%I', schemaname, tablename), ', ' order by schemaname, tablename),
    count(*)::integer
  into table_list, table_count
  from pg_catalog.pg_tables
  where schemaname in ('public', 'booking_notifications')
    and not (schemaname = 'public' and tablename = 'admins');

  if table_list is not null then
    execute 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY';
  end if;

  perform maintenance.ensure_required_system_baseline();
  perform maintenance.ensure_referral_reward_baseline();
  perform maintenance.ensure_event_ticket_settings_baseline();

  select count(*) into admin_count_after from public.admins;
  if admin_count_after is distinct from admin_count_before then
    raise exception 'ADMIN_PRESERVATION_FAILED';
  end if;

  return query select coalesce(table_count, 0);
end;
$function$;

select maintenance.ensure_event_ticket_settings_baseline();

commit;
