alter table public.test_login_sessions
  alter column admin_line_user_id drop not null;

comment on column public.test_login_sessions.admin_line_user_id is
  'Legacy source admin for sessions created before direct test-account login. Nullable for direct test sessions.';

comment on column public.test_mode_settings.allow_admin_user_login is
  'Deprecated compatibility flag. Direct test-account login is controlled only by test_mode_settings.enabled.';

update public.test_mode_settings
set allow_admin_user_login = true
where id = true;
