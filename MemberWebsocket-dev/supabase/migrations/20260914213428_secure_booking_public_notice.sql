drop policy if exists booking_settings_public_notice_read on public.booking_settings;

create policy booking_settings_public_notice_read
on public.booking_settings
for select
to anon, authenticated
using (id = 1);

revoke select on public.booking_settings from anon, authenticated;
grant select (booking_notice) on public.booking_settings to anon, authenticated;

create or replace function public.get_booking_public_notice()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(bs.booking_notice, '')
  from public.booking_settings bs
  where bs.id = 1;
$$;

revoke all on function public.get_booking_public_notice() from public;
grant execute on function public.get_booking_public_notice() to anon, authenticated, service_role;
