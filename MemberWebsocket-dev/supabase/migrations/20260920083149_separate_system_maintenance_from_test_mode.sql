alter table public.test_mode_settings
  add column if not exists maintenance_enabled boolean not null default false;

comment on column public.test_mode_settings.maintenance_enabled is
  'Global user-surface maintenance gate. When true, all member-facing surfaces are blocked, including test sessions.';

create or replace function public.admin_save_test_mode_v2(
  p_test_mode_enabled boolean,
  p_maintenance_enabled boolean,
  p_maintenance_message text,
  p_updated_by text,
  p_add_account_count integer default 0
)
returns table (
  created_account_count integer,
  total_test_accounts integer
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
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

  select count(*)::integer
    into v_existing
    from public.members
   where is_test_account = true;

  if v_existing + v_count > 200 then
    raise exception 'TEST_ACCOUNT_LIMIT_REACHED';
  end if;

  insert into public.test_mode_settings (
    id, enabled, allow_admin_user_login, maintenance_enabled,
    maintenance_message, updated_by, updated_at
  )
  values (
    true,
    coalesce(p_test_mode_enabled, false),
    true,
    coalesce(p_maintenance_enabled, false),
    v_message,
    nullif(btrim(coalesce(p_updated_by, '')), ''),
    now()
  )
  on conflict (id) do update set
    enabled = excluded.enabled,
    allow_admin_user_login = true,
    maintenance_enabled = excluded.maintenance_enabled,
    maintenance_message = excluded.maintenance_message,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  if not coalesce(p_test_mode_enabled, false) or coalesce(p_maintenance_enabled, false) then
    update public.test_login_sessions
       set revoked_at = coalesce(revoked_at, now())
     where revoked_at is null;
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
      'active', 'active', date '1990-01-01',
      '09' || lpad((v_seq % 100000000)::text, 8, '0'),
      now(), now(), '測試', null, true, v_seq, now(), now()
    );
  end loop;

  return query
  select v_count, count(*)::integer
    from public.members
   where is_test_account = true;
end;
$$;

revoke all on function public.admin_save_test_mode_v2(boolean, boolean, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.admin_save_test_mode_v2(boolean, boolean, text, text, integer)
  to service_role;
