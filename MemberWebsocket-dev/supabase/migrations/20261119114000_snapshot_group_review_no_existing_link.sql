-- AC-001..006. Snapshot review always creates a new retrospective booking.
-- Preserve confirmed/completed historical records and all ticket settlement SQL.
-- In-place patch current source, not a stale redefinition of auth/benefit logic.
begin;
do $snapshot_group$
declare
  v_schema text;
  v_source text;
  v_new text;
  v_old_start text := E'  else\n    if p_booking_date is null';
  v_old_end text := E'  end if;\n\n  if b.status = ''confirmed'' then';
  v_start integer;
  v_end integer;
  v_rows integer;
  v_insert text := $group_body$
    if p_booking_date is null or p_start_time is null or extract(second from p_start_time) <> 0 then
      raise exception 'INVALID_BOOKING_SLOT';
    end if;
    select * into settings from __SCHEMA__.booking_settings where id=1 for share;
    if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
    if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) < 1 then
      raise exception 'INVALID_BOOKING_PARTICIPANTS';
    end if;
    -- One-person legacy submissions remain acceptable during frontend rollout.
    if (p_items->0) ? 'serviceId' then
      p_items := jsonb_build_array(jsonb_build_object(
        'technicianId',coalesce(settings.primary_technician_id::text,''),
        'items',p_items
      ));
    end if;
    v_party_size := jsonb_array_length(p_items);
    if v_party_size < 1 or v_party_size > least(10,settings.max_party_size) then
      raise exception 'INVALID_BOOKING_PARTICIPANTS';
    end if;
    -- Reuse the canonical normal-booking technician/primary/duplicate checks.
    v_primary_technician := __SCHEMA__.validate_group_booking_technicians(p_items);
    select * into store from __SCHEMA__.booking_services
      where id='00000000-0000-4000-8000-000000000010'
        and is_active and deleted_at is null for share;
    if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;

    v_max_duration := 0;
    for v_person in select value from jsonb_array_elements(p_items) loop
      if jsonb_typeof(v_person) <> 'object' or
         jsonb_typeof(v_person->'items') is distinct from 'array' or
         jsonb_array_length(v_person->'items') not between 1 and 20 then
        raise exception 'INVALID_BOOKING_ITEMS';
      end if;
      if length(coalesce(v_person->>'memberNote','')) > 500 then
        raise exception 'INVALID_BOOKING_PARTICIPANTS';
      end if;
      v_seen := array[]::uuid[];
      v_person_duration := 0;
      for item in select value from jsonb_array_elements(v_person->'items') loop
        begin
          v_service_id := (item->>'serviceId')::uuid;
          minutes := (item->>'minutes')::integer;
          quantity := (item->>'quantity')::integer;
        exception when invalid_text_representation or numeric_value_out_of_range then
          raise exception 'INVALID_BOOKING_ITEMS';
        end;
        if v_service_id is null or v_service_id='00000000-0000-4000-8000-000000000010'
           or v_service_id = any(v_seen) or minutes is null or minutes not between 1 and 720
           or quantity is null or quantity not between 1 and 2 then
          raise exception 'INVALID_BOOKING_ITEMS';
        end if;
        v_seen := array_append(v_seen,v_service_id);
        select * into s from __SCHEMA__.booking_services
          where id=v_service_id and is_active and deleted_at is null for share;
        if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
        v_person_duration := v_person_duration + minutes*quantity;
      end loop;
      v_max_duration := greatest(v_max_duration,v_person_duration);
    end loop;

    total := v_max_duration + store.duration_minutes;
    if total not between 1 and 1439 then raise exception 'INVALID_BOOKING_DURATION'; end if;
    start_at := p_booking_date + p_start_time +
      case when settings.work_end_time < settings.work_start_time
                and p_start_time < settings.work_end_time
        then interval '1 day' else interval '0 days' end;
    if start_at + make_interval(mins => total) >
         (clock_timestamp() at time zone 'Asia/Taipei') then
      raise exception 'BOOKING_NOT_FINISHED_YET';
    end if;

    insert into __SCHEMA__.bookings(
      request_id,service_id,member_id,booking_date,start_time,end_time,status,
      total_duration_minutes,technician_id,party_size,confirmed_by,confirmed_at,
      receipt_submission_id,contact_source,contact_surname,contact_salutation,contact_phone
    ) values (
      'receipt-register:'||r.id::text,
      (p_items->0->'items'->0->>'serviceId')::uuid,
      r.member_id,p_booking_date,p_start_time,
      (p_start_time+make_interval(mins=>total))::time,'confirmed',
      total,v_primary_technician,v_party_size,p_actor,now(),r.receipt_id,
      'member',m.surname,m.salutation,m.phone
    ) returning * into b;

    v_position := 0;
    for v_person in select value from jsonb_array_elements(p_items) loop
      v_position := v_position+1;
      insert into __SCHEMA__.booking_participants(
        booking_id,position,technician_id,member_note
      ) values (
        b.id,v_position,nullif(btrim(coalesce(v_person->>'technicianId','')),'')::uuid,
        left(btrim(coalesce(v_person->>'memberNote','')),500)
      ) returning id into participant;
      for item in select value from jsonb_array_elements(v_person->'items') loop
        v_service_id := (item->>'serviceId')::uuid;
        minutes := (item->>'minutes')::integer;
        quantity := (item->>'quantity')::integer;
        select * into s from __SCHEMA__.booking_services where id=v_service_id;
        -- Global booking_items has UNIQUE(booking_id,service_id) and drives
        -- settlement totals. An identical service cannot have two minute rates.
        select unit_duration_minutes into v_existing_minutes
          from __SCHEMA__.booking_items
          where booking_id=b.id and service_id=v_service_id;
        if found and v_existing_minutes <> minutes then
          raise exception 'INVALID_BOOKING_ITEMS';
        end if;
        insert into __SCHEMA__.booking_participant_items(
          participant_id,service_id,service_title,unit_duration_minutes,
          unit_price_amount,quantity
        ) values (participant,s.id,s.title,minutes,s.price_amount,quantity);
        insert into __SCHEMA__.booking_items(
          booking_id,service_id,service_title,unit_duration_minutes,quantity,
          unit_price_amount,service_type,counts_toward_membership
        ) values (
          b.id,s.id,s.title,minutes,quantity,s.price_amount,s.service_type,
          s.counts_toward_membership
        ) on conflict (booking_id,service_id) do update
          set quantity=__SCHEMA__.booking_items.quantity+excluded.quantity;
      end loop;
    end loop;
    -- Store duration is added once to the parallel group span, not per person.
    insert into __SCHEMA__.booking_items(
      booking_id,service_id,service_title,unit_duration_minutes,quantity,
      unit_price_amount,service_type,counts_toward_membership
    ) values (b.id,store.id,store.title,store.duration_minutes,1,
      store.price_amount,store.service_type,false);
$group_body$;
  v_vars text := $group_vars$
  v_party_size integer;
  v_primary_technician uuid;
  v_person jsonb;
  v_seen uuid[];
  v_service_id uuid;
  v_position integer;
  v_person_duration integer;
  v_max_duration integer;
  v_existing_minutes integer;
$group_vars$;
begin
  for v_schema in
    select 'public'::text
    union
    select runtime_schema from platform_private.tenants
      where runtime_schema ~ '^business_[0-9a-f]{32}$'
  loop
    select pg_get_functiondef(p.oid) into v_source
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=v_schema
        and p.proname='register_accessible_receipt_with_benefits_request';
    if v_source is null then
      raise exception 'SNAPSHOT_GROUP_FUNCTION_MISSING: %',v_schema;
    end if;
    v_start:=strpos(v_source,v_old_start);
    v_end:=strpos(v_source,v_old_end);
    if v_start=0 or v_end<=v_start or
       strpos(v_source,E'  settlement jsonb;\nBEGIN')=0 or
       strpos(v_source,E'  if p_booking_id is not null then\n    select * into b')=0 then
      raise exception 'SNAPSHOT_GROUP_SOURCE_CHANGED: %',v_schema;
    end if;
    v_new:=left(v_source,v_start-1)||
      E'  else\n'||replace(v_insert,'__SCHEMA__',quote_ident(v_schema))||
      substr(v_source,v_end);
    v_new:=replace(v_new,E'  settlement jsonb;\nBEGIN',
      E'  settlement jsonb;\n'||v_vars||'BEGIN');
    v_new:=replace(v_new,
      E'  if p_booking_id is not null then\n    select * into b',
      E'  if p_booking_id is not null then\n    raise exception ''SNAPSHOT_EXISTING_BOOKING_LINK_DISABLED'';\n    select * into b');
    execute v_new;
  end loop;

  -- Provisioning template is the contract for all FUTURE merchants. Keep it
  -- synchronized with the public and existing tenant runtime functions.
  select f.value->>'definition' into v_source
    from platform_private.business_templates t,
         jsonb_array_elements(t.snapshot->'functions') f(value)
    where t.version='business-v1-20261019'
      and f.value->>'name'='register_accessible_receipt_with_benefits_request';
  if v_source is null then raise exception 'SNAPSHOT_GROUP_TEMPLATE_MISSING'; end if;
  v_start:=strpos(v_source,v_old_start);
  v_end:=strpos(v_source,v_old_end);
  if v_start=0 or v_end<=v_start or
     strpos(v_source,E'  settlement jsonb;\nbegin')=0 or
     strpos(v_source,E'  if p_booking_id is not null then\n    select * into b')=0 then
    raise exception 'SNAPSHOT_GROUP_TEMPLATE_CHANGED';
  end if;
  v_new:=left(v_source,v_start-1)||E'  else\n'||
    replace(v_insert,'__SCHEMA__','public')||substr(v_source,v_end);
  v_new:=replace(v_new,E'  settlement jsonb;\nbegin',
    E'  settlement jsonb;\n'||v_vars||'begin');
  v_new:=replace(v_new,
    E'  if p_booking_id is not null then\n    select * into b',
    E'  if p_booking_id is not null then\n    raise exception ''SNAPSHOT_EXISTING_BOOKING_LINK_DISABLED'';\n    select * into b');
  update platform_private.business_templates t
    set snapshot=jsonb_set(t.snapshot,'{functions}',(
      select jsonb_agg(
        case when f.value->>'name'='register_accessible_receipt_with_benefits_request'
             then jsonb_set(f.value,'{definition}',to_jsonb(v_new),true)
             else f.value end order by f.ordinality
      )
      from jsonb_array_elements(t.snapshot->'functions')
        with ordinality as f(value,ordinality)
    ),true)
    where t.version='business-v1-20261019';
  get diagnostics v_rows=row_count;
  if v_rows<>1 then raise exception 'SNAPSHOT_GROUP_TEMPLATE_WRITE_FAILED'; end if;
  perform pg_notify('pgrst','reload schema');
end $snapshot_group$;
commit;
