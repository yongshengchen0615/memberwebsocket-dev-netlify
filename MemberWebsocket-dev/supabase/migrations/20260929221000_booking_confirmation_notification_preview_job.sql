create or replace function public.booking_notification_confirmation_preview_job(
  p_booking_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id,
    'booking_id', o.booking_id,
    'event_key', o.event_key,
    'channel', o.channel,
    'recipient', o.recipient,
    'message_text', o.message_text,
    'attempt_count', o.attempt_count
  )
  from booking_notifications.outbox o
  join public.bookings b on b.id = o.booking_id
  join public.members m on m.id = b.member_id
  where o.channel = 'member'
    and o.event_key like (o.booking_id::text || ':confirmed:%')
    and m.is_test_account = false
    and (p_booking_id is null or o.booking_id = p_booking_id)
  order by o.created_at desc
  limit 1;
$$;

revoke all on function public.booking_notification_confirmation_preview_job(uuid) from public, anon, authenticated;
grant execute on function public.booking_notification_confirmation_preview_job(uuid) to service_role;
