alter table public.test_login_sessions
  add column if not exists device_class text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'test_login_sessions_device_class_check'
      and conrelid = 'public.test_login_sessions'::regclass
  ) then
    alter table public.test_login_sessions
      add constraint test_login_sessions_device_class_check
      check (device_class is null or device_class in ('pc', 'mobile'));
  end if;
end
$$;

comment on column public.test_login_sessions.device_class is
  'Device class on which the direct test session was issued: pc or mobile.';

update public.test_login_sessions
set revoked_at = coalesce(revoked_at, now())
where revoked_at is null
  and device_class is null;
