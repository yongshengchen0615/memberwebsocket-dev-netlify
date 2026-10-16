create or replace function public.admin_replace_booking_benefit_selections_request(
  p_booking_id uuid,
  p_expected_updated_at timestamp with time zone,
  p_actor text,
  p_selections jsonb default '[]'::jsonb
)
returns public.bookings
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_booking public.bookings%rowtype;
  v_previous jsonb := '[]'::jsonb;
  v_current jsonb := '[]'::jsonb;
begin
  select * into v_booking
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception 'BOOKING_NOT_FOUND';
  end if;
  if p_expected_updated_at is null or v_booking.updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_CONFLICT';
  end if;
  if v_booking.status not in ('pending', 'confirmed') then
    raise exception 'BOOKING_NOT_EDITABLE';
  end if;
  if v_booking.cancellation_requested_at is not null
     and v_booking.cancellation_reviewed_at is null then
    raise exception 'BOOKING_CANCELLATION_PENDING';
  end if;

  p_selections := coalesce(p_selections, '[]'::jsonb);
  if jsonb_typeof(p_selections) <> 'array'
     or jsonb_array_length(p_selections) > 20
     or exists (
       select 1
       from jsonb_array_elements(p_selections) item
       where lower(btrim(coalesce(item->>'kind', ''))) not in ('points', 'event')
     ) then
    raise exception 'INVALID_BOOKING_BENEFITS';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', benefit_kind,
        'id', benefit_ref,
        'title', title_snapshot
      )
      order by selected_at
    ),
    '[]'::jsonb
  )
  into v_previous
  from public.booking_benefit_selections
  where booking_id = p_booking_id
    and status = 'pending'
    and benefit_kind in ('points', 'event');

  perform public.replace_booking_benefit_selections_request(
    p_booking_id,
    v_booking.member_id,
    p_selections
  );

  update public.bookings
  set updated_at = clock_timestamp()
  where id = p_booking_id
  returning * into v_booking;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', benefit_kind,
        'id', benefit_ref,
        'title', title_snapshot
      )
      order by selected_at
    ),
    '[]'::jsonb
  )
  into v_current
  from public.booking_benefit_selections
  where booking_id = p_booking_id
    and status = 'pending'
    and benefit_kind in ('points', 'event');

  insert into public.booking_audit_events(
    actor_line_user_id,
    actor_role,
    action,
    target_type,
    target_id,
    result,
    metadata
  ) values (
    left(coalesce(p_actor, ''), 255),
    'admin',
    'BOOKING_BENEFITS_UPDATED',
    'booking',
    p_booking_id::text,
    'success',
    jsonb_build_object(
      'previousSelections', v_previous,
      'selections', v_current,
      'status', v_booking.status
    )
  );

  return v_booking;
end;
$function$;

revoke all on function public.admin_replace_booking_benefit_selections_request(
  uuid, timestamp with time zone, text, jsonb
) from public;
revoke all on function public.admin_replace_booking_benefit_selections_request(
  uuid, timestamp with time zone, text, jsonb
) from anon;
revoke all on function public.admin_replace_booking_benefit_selections_request(
  uuid, timestamp with time zone, text, jsonb
) from authenticated;
grant execute on function public.admin_replace_booking_benefit_selections_request(
  uuid, timestamp with time zone, text, jsonb
) to service_role;
