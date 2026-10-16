begin;

create or replace function public.count_today_usable_event_tickets(
  p_line_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_member public.members%rowtype;
  v_tier text;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_count integer := 0;
begin
  select * into v_member
  from public.members
  where line_user_id=p_line_user_id
    and status='active'
    and membership_status='active';
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  v_tier:=public.current_tier_key(v_member.id);

  select count(*)::integer into v_count
  from public.event_ticket_claims c
  join public.event_tickets e on e.id=c.event_ticket_id
  where c.member_id=v_member.id
    and c.status='claimed'
    and e.deleted_at is null
    and e.status='active'
    and (e.starts_on is null or e.starts_on<=v_today)
    and (e.ends_on is null or e.ends_on>=v_today)
    and v_tier=any(e.allowed_tier_keys);

  return jsonb_build_object(
    'businessDate',v_today,
    'todayUsableCount',v_count
  );
end;
$$;

revoke all on function public.count_today_usable_event_tickets(text) from public,anon,authenticated;
grant execute on function public.count_today_usable_event_tickets(text) to service_role;

commit;
