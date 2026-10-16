begin;

revoke all on function public.queue_booking_receipt_object_on_delete() from public, anon, authenticated;
grant execute on function public.queue_booking_receipt_object_on_delete() to service_role;

create index if not exists member_referrals_reward_event_ticket_idx
  on public.member_referrals(reward_event_ticket_id)
  where reward_event_ticket_id is not null;

commit;
