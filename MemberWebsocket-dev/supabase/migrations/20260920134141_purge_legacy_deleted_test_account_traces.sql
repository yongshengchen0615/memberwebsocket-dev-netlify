do $$
declare
  v_orphan_lines text[] := array[]::text[];
  v_deleted_member_ids text[] := array[]::text[];
  v_deleted_member_codes text[] := array[]::text[];
  v_deleted_booking_ids text[] := array[]::text[];
begin
  select coalesce(array_agg(distinct line_user_id), array[]::text[])
    into v_orphan_lines
  from (
    select actor_line_user_id as line_user_id
    from public.audit_logs
    where actor_line_user_id like 'TEST-%'
    union all
    select actor_line_user_id
    from public.booking_audit_events
    where actor_line_user_id like 'TEST-%'
    union all
    select actor_line_user_id
    from public.idempotency_results
    where actor_line_user_id like 'TEST-%'
    union all
    select line_user_id
    from public.scheduled_grant_messages
    where line_user_id like 'TEST-%'
  ) traces
  where not exists (
    select 1
    from public.members m
    where m.is_test_account = true
      and m.line_user_id = traces.line_user_id
  );

  select coalesce(array_agg(distinct value), array[]::text[])
    into v_deleted_member_ids
  from (
    select target_id as value
    from public.audit_logs
    where actor_line_user_id = any(v_orphan_lines)
      and target_type = 'member'
      and target_id is not null
    union all
    select jsonb_array_elements_text(detail->'memberIds')
    from public.audit_logs
    where action in ('test_mode.account.delete','test_mode.accounts.batch_delete')
      and target_type = 'test_account'
      and jsonb_typeof(detail->'memberIds') = 'array'
  ) ids
  where value is not null;

  select coalesce(array_agg(distinct detail->>'memberCode'), array[]::text[])
    into v_deleted_member_codes
  from public.audit_logs
  where actor_line_user_id = any(v_orphan_lines)
    and nullif(detail->>'memberCode','') is not null;

  select coalesce(array_agg(distinct target_id), array[]::text[])
    into v_deleted_booking_ids
  from public.booking_audit_events
  where actor_line_user_id = any(v_orphan_lines)
    and target_type = 'booking'
    and target_id is not null;

  delete from public.api_rate_limits
   where principal_hash = any (
     select encode(extensions.digest(line_user_id, 'sha256'), 'hex')
     from unnest(v_orphan_lines) as ids(line_user_id)
   );

  delete from public.idempotency_results
   where actor_line_user_id = any(v_orphan_lines)
      or exists (
        select 1
        from unnest(v_deleted_member_ids || v_deleted_member_codes || v_deleted_booking_ids || v_orphan_lines) as ids(value)
        where result::text like '%' || value || '%'
      );

  delete from public.scheduled_grant_messages
   where line_user_id = any(v_orphan_lines);

  delete from public.booking_audit_events
   where actor_line_user_id = any(v_orphan_lines)
      or target_id = any(v_deleted_booking_ids)
      or target_id = any(v_deleted_member_ids)
      or exists (
        select 1
        from unnest(v_deleted_member_ids || v_deleted_member_codes || v_deleted_booking_ids || v_orphan_lines) as ids(value)
        where metadata::text like '%' || value || '%'
      );

  delete from public.audit_logs
   where actor_line_user_id = any(v_orphan_lines)
      or target_id = any(v_deleted_member_ids)
      or target_id = any(v_deleted_member_codes)
      or target_id = any(v_deleted_booking_ids)
      or (
        action in ('test_mode.account.delete','test_mode.accounts.batch_delete')
        and target_type = 'test_account'
      )
      or exists (
        select 1
        from unnest(v_deleted_member_ids || v_deleted_member_codes || v_deleted_booking_ids || v_orphan_lines) as ids(value)
        where detail::text like '%' || value || '%'
      );
end;
$$;
