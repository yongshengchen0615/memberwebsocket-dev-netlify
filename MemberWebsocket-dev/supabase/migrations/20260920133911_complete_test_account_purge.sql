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
  v_line_user_ids text[] := array[]::text[];
  v_member_codes text[] := array[]::text[];
  v_member_id_texts text[] := array[]::text[];
  v_booking_ids uuid[] := array[]::uuid[];
  v_booking_id_texts text[] := array[]::text[];
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

  select
    count(*)::integer,
    coalesce(array_agg(line_user_id order by id) filter (where line_user_id is not null), array[]::text[]),
    coalesce(array_agg(member_code order by id) filter (where member_code is not null), array[]::text[]),
    coalesce(array_agg(id::text order by id), array[]::text[])
  into
    v_matched_count,
    v_line_user_ids,
    v_member_codes,
    v_member_id_texts
  from public.members
  where id = any(p_member_ids)
    and is_test_account = true;

  if v_matched_count <> v_requested_count then
    raise exception 'INVALID_TEST_ACCOUNT_SELECTION';
  end if;

  select
    coalesce(array_agg(id order by id), array[]::uuid[]),
    coalesce(array_agg(id::text order by id), array[]::text[])
  into
    v_booking_ids,
    v_booking_id_texts
  from public.bookings
  where member_id = any(p_member_ids);

  delete from public.api_rate_limits
   where principal_hash = any (
     select encode(extensions.digest(line_user_id, 'sha256'), 'hex')
     from unnest(v_line_user_ids) as ids(line_user_id)
   );

  delete from public.idempotency_results
   where actor_line_user_id = any(v_line_user_ids)
      or exists (
        select 1
        from unnest(v_member_id_texts || v_member_codes || v_booking_id_texts || v_line_user_ids) as ids(value)
        where result::text like '%' || value || '%'
      );

  delete from public.booking_audit_events
   where actor_line_user_id = any(v_line_user_ids)
      or target_id = any(v_member_id_texts)
      or target_id = any(v_member_codes)
      or target_id = any(v_booking_id_texts)
      or exists (
        select 1
        from unnest(v_member_id_texts || v_member_codes || v_booking_id_texts || v_line_user_ids) as ids(value)
        where metadata::text like '%' || value || '%'
      );

  delete from public.audit_logs
   where actor_line_user_id = any(v_line_user_ids)
      or target_id = any(v_member_id_texts)
      or target_id = any(v_member_codes)
      or target_id = any(v_booking_id_texts)
      or exists (
        select 1
        from unnest(v_member_id_texts || v_member_codes || v_booking_id_texts || v_line_user_ids) as ids(value)
        where detail::text like '%' || value || '%'
      );

  delete from booking_notifications.outbox
   where booking_id = any(v_booking_ids);

  delete from public.booking_completion_settlements
   where member_id = any(p_member_ids)
      or booking_id = any(v_booking_ids);

  delete from public.birthday_benefit_grants
   where member_id = any(p_member_ids);

  delete from public.event_ticket_claims
   where member_id = any(p_member_ids);

  delete from public.scheduled_grant_messages
   where member_id = any(p_member_ids)
      or line_user_id = any(v_line_user_ids);

  delete from public.point_tickets
   where member_id = any(p_member_ids);

  delete from public.point_entries
   where member_id = any(p_member_ids);

  delete from public.point_balances
   where member_id = any(p_member_ids);

  delete from public.service_time_entries
   where member_id = any(p_member_ids);

  delete from public.fixed_ticket_grants
   where member_id = any(p_member_ids);

  delete from public.bookings
   where member_id = any(p_member_ids);

  delete from public.test_login_sessions
   where member_id = any(p_member_ids);

  delete from public.members
   where id = any(p_member_ids)
     and is_test_account = true;

  get diagnostics v_deleted_count = row_count;

  if v_deleted_count <> v_requested_count then
    raise exception 'TEST_ACCOUNT_DELETE_MISMATCH';
  end if;

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
