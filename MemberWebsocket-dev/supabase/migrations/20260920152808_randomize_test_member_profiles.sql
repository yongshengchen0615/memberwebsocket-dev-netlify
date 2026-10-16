do $$
declare
  r record;
  v_surnames text[] := array['陳','林','黃','張','李','王','吳','劉','蔡','楊','許','鄭','謝','洪','郭','邱','曾','廖','賴','徐'];
  v_male_names text[] := array['志明','俊傑','冠宇','柏翰','家豪','承翰','宇翔','子豪','建宏','宗翰','彥廷','品睿'];
  v_female_names text[] := array['怡君','雅婷','欣怡','佳穎','郁婷','佩珊','詩涵','筱涵','雨柔','佳蓉','婉婷','思妤'];
  v_surname text;
  v_given_name text;
  v_salutation text;
  v_birthday date;
  v_phone text;
begin
  for r in
    select id
    from public.members
    where is_test_account = true
      and display_name ~ '^測試會員 [0-9]+$'
      and coalesce(surname, '') = '測試'
      and birthday = date '1990-01-01'
      and coalesce(phone, '') ~ '^090+[0-9]+$'
  loop
    v_salutation := case when random() < 0.5 then 'mr' else 'ms' end;
    v_surname := v_surnames[1 + floor(random() * array_length(v_surnames, 1))::int];
    if v_salutation = 'mr' then
      v_given_name := v_male_names[1 + floor(random() * array_length(v_male_names, 1))::int];
    else
      v_given_name := v_female_names[1 + floor(random() * array_length(v_female_names, 1))::int];
    end if;
    v_birthday := ((current_date - make_interval(years => 18 + floor(random() * 48)::int))::date
      - floor(random() * 365)::int);

    loop
      v_phone := '09' || lpad(floor(random() * 100000000)::bigint::text, 8, '0');
      exit when not exists (
        select 1 from public.members m
        where m.phone = v_phone and m.id <> r.id
      );
    end loop;

    update public.members
    set
      display_name = v_surname || v_given_name || '（測試）',
      surname = v_surname,
      salutation = v_salutation,
      birthday = v_birthday,
      phone = v_phone,
      membership_status = 'active',
      updated_at = now()
    where id = r.id;
  end loop;
end;
$$;

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
  v_surnames text[] := array['陳','林','黃','張','李','王','吳','劉','蔡','楊','許','鄭','謝','洪','郭','邱','曾','廖','賴','徐'];
  v_male_names text[] := array['志明','俊傑','冠宇','柏翰','家豪','承翰','宇翔','子豪','建宏','宗翰','彥廷','品睿'];
  v_female_names text[] := array['怡君','雅婷','欣怡','佳穎','郁婷','佩珊','詩涵','筱涵','雨柔','佳蓉','婉婷','思妤'];
  v_surname text;
  v_given_name text;
  v_salutation text;
  v_birthday date;
  v_phone text;
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
    v_salutation := case when random() < 0.5 then 'mr' else 'ms' end;
    v_surname := v_surnames[1 + floor(random() * array_length(v_surnames, 1))::int];
    if v_salutation = 'mr' then
      v_given_name := v_male_names[1 + floor(random() * array_length(v_male_names, 1))::int];
    else
      v_given_name := v_female_names[1 + floor(random() * array_length(v_female_names, 1))::int];
    end if;
    v_birthday := ((current_date - make_interval(years => 18 + floor(random() * 48)::int))::date
      - floor(random() * 365)::int);

    loop
      v_phone := '09' || lpad(floor(random() * 100000000)::bigint::text, 8, '0');
      exit when not exists (select 1 from public.members where phone = v_phone);
    end loop;

    insert into public.members (
      line_user_id, display_name, member_code, status, membership_status,
      birthday, phone, joined_at, last_login_at, surname, salutation,
      is_test_account, test_account_sequence, created_at, updated_at
    ) values (
      'TEST-' || replace(gen_random_uuid()::text, '-', ''),
      v_surname || v_given_name || '（測試）',
      'TST' || lpad(v_seq::text, 6, '0'),
      'active',
      'active',
      v_birthday,
      v_phone,
      now(),
      now(),
      v_surname,
      v_salutation,
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
