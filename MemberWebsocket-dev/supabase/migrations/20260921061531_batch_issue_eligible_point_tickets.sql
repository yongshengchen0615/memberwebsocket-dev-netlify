create or replace function public.issue_eligible_point_tickets_for_member(
  p_member_id uuid,
  p_point_card_ids uuid[]
)
returns integer
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_point_card_id uuid;
  v_total integer := 0;
begin
  if p_member_id is null then
    raise exception 'MEMBER_NOT_FOUND';
  end if;

  if p_point_card_ids is null or coalesce(cardinality(p_point_card_ids), 0) = 0 then
    return 0;
  end if;

  if cardinality(p_point_card_ids) > 100 then
    raise exception 'TOO_MANY_POINT_CARDS';
  end if;

  for v_point_card_id in
    select distinct point_card_id
    from unnest(p_point_card_ids) as point_card_id
    where point_card_id is not null
  loop
    v_total := v_total + public.issue_eligible_point_tickets(p_member_id, v_point_card_id);
  end loop;

  return v_total;
end;
$function$;

revoke execute on function public.issue_eligible_point_tickets_for_member(uuid, uuid[]) from public;
revoke execute on function public.issue_eligible_point_tickets_for_member(uuid, uuid[]) from anon, authenticated;
grant execute on function public.issue_eligible_point_tickets_for_member(uuid, uuid[]) to service_role;
