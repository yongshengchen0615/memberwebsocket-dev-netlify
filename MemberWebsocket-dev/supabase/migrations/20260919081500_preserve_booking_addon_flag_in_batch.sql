create or replace function public.apply_booking_service_batch(p_operations jsonb, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_op jsonb; v_kind text; v_service_id uuid; v_title text; v_type_input text; v_type text;
  v_duration integer; v_price integer; v_active boolean; v_requires_companion boolean; v_current_requires_companion boolean;
  v_expected timestamptz; v_current_updated_at timestamptz;
  v_created integer := 0; v_updated integer := 0; v_deleted integer := 0;
begin
  if jsonb_typeof(p_operations) <> 'array' or jsonb_array_length(p_operations) < 1 or jsonb_array_length(p_operations) > 100 then raise exception 'INVALID_BATCH_OPERATIONS'; end if;
  for v_op in select value from jsonb_array_elements(p_operations) loop
    v_kind := lower(btrim(coalesce(v_op->>'op', '')));
    if v_kind not in ('create','update','delete') then raise exception 'INVALID_BATCH_OPERATION'; end if;
    if v_kind = 'delete' then
      begin v_service_id := (v_op->>'serviceId')::uuid; exception when others then raise exception 'INVALID_SERVICE_ID'; end;
      if v_service_id = '00000000-0000-4000-8000-000000000010'::uuid then raise exception 'BOOKING_SYSTEM_SERVICE_IMMUTABLE'; end if;
      select updated_at into v_current_updated_at from public.booking_services where id = v_service_id and deleted_at is null for update;
      if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
      if nullif(v_op->>'expectedUpdatedAt','') is not null then
        begin v_expected := (v_op->>'expectedUpdatedAt')::timestamptz; exception when others then raise exception 'INVALID_EXPECTED_UPDATED_AT'; end;
        if v_current_updated_at <> v_expected then raise exception 'BOOKING_SERVICE_CONFLICT'; end if;
      end if;
      update public.booking_services set is_active = false, deleted_at = now(), deleted_by = nullif(btrim(coalesce(p_actor,'')), '') where id = v_service_id;
      v_deleted := v_deleted + 1; continue;
    end if;

    v_title := btrim(coalesce(v_op->>'title',''));
    v_type_input := btrim(coalesce(v_op->>'serviceType',''));
    begin v_duration := (v_op->>'durationMinutes')::integer; exception when others then raise exception 'INVALID_SERVICE_DURATION'; end;
    begin v_price := (v_op->>'priceAmount')::integer; exception when others then raise exception 'INVALID_SERVICE_PRICE'; end;
    begin v_active := coalesce((v_op->>'isActive')::boolean, true); exception when others then raise exception 'INVALID_BATCH_OPERATION'; end;
    if v_op ? 'requiresCompanionService' and v_op->>'requiresCompanionService' is not null then
      begin v_requires_companion := (v_op->>'requiresCompanionService')::boolean; exception when others then raise exception 'INVALID_BATCH_OPERATION'; end;
    else
      v_requires_companion := null;
    end if;

    if char_length(v_title) not between 1 and 100 then raise exception 'INVALID_SERVICE_TITLE'; end if;
    if v_duration < 1 or v_duration > 720 then raise exception 'INVALID_SERVICE_DURATION'; end if;
    if v_price < 0 or v_price > 10000000 then raise exception 'INVALID_SERVICE_PRICE'; end if;
    select name into v_type from public.booking_service_types where lower(btrim(name)) = lower(v_type_input) limit 1;
    if not found then raise exception 'BOOKING_SERVICE_TYPE_INVALID'; end if;

    if v_kind = 'create' then
      insert into public.booking_services(
        title, description, service_type, duration_minutes, price_amount,
        counts_toward_membership, is_active, requires_companion_service, created_by
      )
      values (
        v_title, '__TYPE__:' || v_type, v_type, v_duration, v_price,
        true, v_active, coalesce(v_requires_companion,false), p_actor
      );
      v_created := v_created + 1;
    else
      begin v_service_id := (v_op->>'serviceId')::uuid; exception when others then raise exception 'INVALID_SERVICE_ID'; end;
      if v_service_id = '00000000-0000-4000-8000-000000000010'::uuid then raise exception 'BOOKING_SYSTEM_SERVICE_IMMUTABLE'; end if;
      select updated_at, requires_companion_service
      into v_current_updated_at, v_current_requires_companion
      from public.booking_services
      where id = v_service_id and deleted_at is null
      for update;
      if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
      if nullif(v_op->>'expectedUpdatedAt','') is not null then
        begin v_expected := (v_op->>'expectedUpdatedAt')::timestamptz; exception when others then raise exception 'INVALID_EXPECTED_UPDATED_AT'; end;
        if v_current_updated_at <> v_expected then raise exception 'BOOKING_SERVICE_CONFLICT'; end if;
      end if;
      update public.booking_services
      set title=v_title,
          description='__TYPE__:'||v_type,
          service_type=v_type,
          duration_minutes=v_duration,
          price_amount=v_price,
          is_active=v_active,
          requires_companion_service=coalesce(v_requires_companion,v_current_requires_companion)
      where id=v_service_id;
      v_updated := v_updated + 1;
    end if;
  end loop;
  return jsonb_build_object('created', v_created, 'updated', v_updated, 'deleted', v_deleted);
end;
$function$;
