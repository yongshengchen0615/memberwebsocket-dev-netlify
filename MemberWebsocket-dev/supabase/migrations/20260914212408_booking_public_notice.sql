update public.booking_settings
set booking_notice = '每筆預約會自動加入 10 分鐘店內服務，包含 10 分鐘肩頸服務、龜苓膏與熱茶。這 10 分鐘會算入預約佔用時間與結束時間，但不另外計價，也不計入會員累積消費服務時數或會員階級。'
where id = 1
  and btrim(coalesce(booking_notice, '')) = '';

create or replace function public.get_booking_public_notice()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(bs.booking_notice, '')
  from public.booking_settings bs
  where bs.id = 1;
$$;

revoke all on function public.get_booking_public_notice() from public, anon, authenticated;
grant execute on function public.get_booking_public_notice() to anon, authenticated, service_role;
