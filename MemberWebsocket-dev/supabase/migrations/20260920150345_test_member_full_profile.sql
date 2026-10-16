update public.members
set
  birthday = coalesce(birthday, date '1990-01-01'),
  phone = case
    when nullif(btrim(coalesce(phone, '')), '') is null
      then '09' || lpad((coalesce(test_account_sequence, 0) % 100000000)::text, 8, '0')
    else phone
  end,
  surname = coalesce(nullif(btrim(surname), ''), '測試'),
  salutation = case
    when salutation in ('mr', 'ms') then salutation
    when coalesce(test_account_sequence, 1) % 2 = 0 then 'ms'
    else 'mr'
  end,
  membership_status = 'active',
  updated_at = now()
where is_test_account = true
  and (
    birthday is null
    or nullif(btrim(coalesce(phone, '')), '') is null
    or nullif(btrim(coalesce(surname, '')), '') is null
    or salutation is null
    or salutation not in ('mr', 'ms')
    or membership_status <> 'active'
  );

create or replace function public.admin_save_maintenance_test_access(
  p_maintenance_enabled boolean,
  p_allow_pc_test_login boolean,
  p_allow_mobile_test_login boolean,
  p_maintenance_message text,
  p_updated_by text,
  p_add_account_count integer default 0
)
returns table(created_account_count integer, total_test_accounts integer)
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_count integer := coalesce(p_add_account_count, 0);
  v_message text := coalesce(p_maintenance_message, '');
  v_existing integer;
  v_seq bigint;
  v_i integer;
begin
  if v_count < 0 or v_count > 50 then
    raise exception 'INVALID_TEST_ACCOUNT_COUNT';
  end if;
  if char_length(v_message) > 500 then
    raise exception 'INVALID_MAINTENANCE_MESSAGE';
  end if;

  perform pg_advisory_xact_lock(2026092001);

  select count(*)::integer into v_existing
  from public.members
  where is_test_account = true;

  if v_existing + v_count > 200 then
    raise exception 'TEST_ACCOUNT_LIMIT_REACHED';
  end if;

  insert into public.test_mode_settings (
    id, enabled, allow_admin_user_login, maintenance_enabled,
    allow_pc_test_login, allow_mobile_test_login, maintenance_message,
    updated_by, updated_at
  )
  values (
    true, true, true,
    coalesce(p_maintenance_enabled, false),
    coalesce(p_allow_pc_test_login, false),
    coalesce(p_allow_mobile_test_login, false),
    v_message,
    nullif(btrim(coalesce(p_updated_by, '')), ''),
    now()
  )
  on conflict (id) do update set
    enabled = true,
    allow_admin_user_login = true,
    maintenance_enabled = excluded.maintenance_enabled,
    allow_pc_test_login = excluded.allow_pc_test_login,
    allow_mobile_test_login = excluded.allow_mobile_test_login,
    maintenance_message = excluded.maintenance_message,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  if not coalesce(p_maintenance_enabled, false) then
    update public.test_login_sessions
       set revoked_at = coalesce(revoked_at, now())
     where revoked_at is null;
  else
    if not coalesce(p_allow_pc_test_login, false) then
      update public.test_login_sessions
         set revoked_at = coalesce(revoked_at, now())
       where revoked_at is null
         and device_class = 'pc';
    end if;
    if not coalesce(p_allow_mobile_test_login, false) then
      update public.test_login_sessions
         set revoked_at = coalesce(revoked_at, now())
       where revoked_at is null
         and device_class = 'mobile';
    end if;
  end if;

  for v_i in 1..v_count loop
    v_seq := nextval('public.test_member_sequence');
    insert into public.members (
      line_user_id, display_name, member_code, status, membership_status,
      birthday, phone, joined_at, last_login_at, surname, salutation,
      is_test_account, test_account_sequence, created_at, updated_at
    ) values (
      'TEST-' || replace(gen_random_uuid()::text, '-', ''),
      '測試會員 ' || lpad(v_seq::text, 3, '0'),
      'TST' || lpad(v_seq::text, 6, '0'),
      'active',
      'active',
      date '1990-01-01',
      '09' || lpad((v_seq % 100000000)::text, 8, '0'),
      now(),
      now(),
      '測試',
      case when v_seq % 2 = 0 then 'ms' else 'mr' end,
      true,
      v_seq,
      now(),
      now()
    );
  end loop;

  return query
  select v_count, count(*)::integer
  from public.members
  where is_test_account = true;
end;
$function$;

revoke all on function public.admin_save_maintenance_test_access(boolean, boolean, boolean, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.admin_save_maintenance_test_access(boolean, boolean, boolean, text, text, integer)
  to service_role;
