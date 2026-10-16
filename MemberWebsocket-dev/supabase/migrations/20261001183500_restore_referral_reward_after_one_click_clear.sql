begin;

create or replace function maintenance.ensure_referral_reward_baseline()
returns void
language plpgsql
set search_path = ''
as $function$
begin
  insert into public.fixed_ticket_templates(
    fixed_ticket_id,title,description,usage_method,usage_instructions,status,
    schedule_type,schedule_day,quota,accent,allowed_tier_keys,notify_line,
    created_by,updated_by,expiry_mode,expiry_days,calendar_enabled,
    requires_location,redemption_locations,deleted_at
  )
  values (
    'REFERRAL-REWARD',
    '好友邀請獎勵券',
    '成功邀請好友加入會員後取得的專屬優惠券。',
    '出示活動票券並依現場規則核銷',
    '每張票券限使用一次；實際適用服務以現場公告為準。',
    'archived',
    'monthly',
    1,
    0,
    '#6D4AA0',
    array['general','silver','gold','platinum']::text[],
    false,
    'system',
    'system',
    'days_after_issue',
    30,
    false,
    false,
    '[]'::jsonb,
    null
  )
  on conflict (fixed_ticket_id) do update
    set deleted_at = null,
        updated_at = clock_timestamp();

  if not exists (
    select 1
      from public.fixed_ticket_templates
     where fixed_ticket_id = 'REFERRAL-REWARD'
       and deleted_at is null
  ) then
    raise exception 'REQUIRED_REFERRAL_REWARD_BASELINE_INVALID';
  end if;
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

  select count(*) into admin_count_after from public.admins;
  if admin_count_after is distinct from admin_count_before then
    raise exception 'ADMIN_PRESERVATION_FAILED';
  end if;

  return query select coalesce(table_count, 0);
end;
$function$;

select maintenance.ensure_referral_reward_baseline();

commit;
