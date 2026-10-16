create or replace function public.admin_delete_test_accounts(
  p_member_ids uuid[]
)
returns table (
  deleted_account_count integer,
  total_test_accounts integer
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_requested_count integer := coalesce(cardinality(p_member_ids), 0);
  v_distinct_count integer := 0;
  v_matched_count integer := 0;
  v_deleted_count integer := 0;
begin
  if v_requested_count < 1 or v_requested_count > 200 then
    raise exception 'INVALID_TEST_ACCOUNT_DELETE_COUNT';
  end if;

  select count(distinct member_id)::integer
    into v_distinct_count
    from unnest(p_member_ids) as requested(member_id);

  if v_distinct_count <> v_requested_count then
    raise exception 'DUPLICATE_TEST_ACCOUNT_ID';
  end if;

  perform id
    from public.members
   where id = any(p_member_ids)
   for update;

  select count(*)::integer
    into v_matched_count
    from public.members
   where id = any(p_member_ids)
     and is_test_account = true;

  if v_matched_count <> v_requested_count then
    raise exception 'INVALID_TEST_ACCOUNT_SELECTION';
  end if;

  delete from public.booking_completion_settlements
   where member_id = any(p_member_ids);

  delete from public.birthday_benefit_grants
   where member_id = any(p_member_ids);

  delete from public.event_ticket_claims
   where member_id = any(p_member_ids);

  delete from public.fixed_ticket_grants
   where member_id = any(p_member_ids);

  delete from public.scheduled_grant_messages
   where member_id = any(p_member_ids);

  delete from public.point_tickets
   where member_id = any(p_member_ids);

  delete from public.point_entries
   where member_id = any(p_member_ids);

  delete from public.service_time_entries
   where member_id = any(p_member_ids);

  delete from public.bookings
   where member_id = any(p_member_ids);

  delete from public.members
   where id = any(p_member_ids)
     and is_test_account = true;

  get diagnostics v_deleted_count = row_count;

  return query
  select
    v_deleted_count,
    count(*)::integer
  from public.members
  where is_test_account = true;
end;
$$;

revoke all on function public.admin_delete_test_accounts(uuid[])
  from public, anon, authenticated;
grant execute on function public.admin_delete_test_accounts(uuid[])
  to service_role;
