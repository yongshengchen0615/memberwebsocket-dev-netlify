-- AC-FR-DURATION-001..004: direct-duration paired walk-in replacement.
-- Standalone phone.create keeps its service selection; no backfill or existing booking mutation.
create or replace function platform_private.frontdesk_create_duration_booking(
 p_schema text,p_request_id text,p_actor text,p_booking_date date,
 p_start_time time without time zone,p_duration integer,p_note text
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
 v_settings jsonb;v_store jsonb;v_saved jsonb;v_booking jsonb;
 v_start timestamp without time zone;v_fits boolean;v_participant uuid;
 v_store_id constant uuid:='00000000-0000-4000-8000-000000000010';
 v_note text:=coalesce(p_note,'');
begin
 if p_schema !~ '^business_[0-9a-f]{32}$'
    or not exists(select 1 from platform_private.tenants where runtime_schema=p_schema)
 then raise exception 'BUSINESS_SCHEMA_INVALID';end if;
 if not exists(
   select 1 from platform_private.frontdesk_staff f
   join platform_private.tenants t on t.id=f.tenant_id
   where t.runtime_schema=p_schema and f.line_user_id=p_actor
    and f.status='approved' and f.permission_mode='review'
    and f.oa_verified_at is not null
 ) then raise exception 'FRONTDESK_REVIEW_REQUIRED';end if;
 if p_request_id !~ '^PHONE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 then raise exception 'INVALID_REQUEST_ID';end if;
 if p_duration is null or p_duration not between 1 and 1439
 then raise exception 'INVALID_BOOKING_DURATION';end if;
 if p_booking_date is null or p_start_time is null
 then raise exception 'INVALID_BOOKING_SLOT';end if;
 if char_length(v_note)>500 then raise exception 'INVALID_BOOKING_NOTE';end if;
 execute format('select %I.booking_price_context_time()',p_schema);
 execute format('select to_jsonb(x) from %I.booking_settings x where x.id=1 for share',p_schema)
  into v_settings;
 if v_settings is null then raise exception 'BOOKING_SETTINGS_MISSING';end if;
 execute format('select to_jsonb(x) from %I.booking_services x where x.id=$1 and x.is_active and x.deleted_at is null for share',p_schema)
  into v_store using v_store_id;
 if v_store is null then raise exception 'BOOKING_SERVICE_NOT_FOUND';end if;
 execute format('select %I.booking_slot_fits($1,$2,$3,$4,$5,$6)',p_schema)
  into v_fits using p_booking_date,p_start_time,p_duration,
    (v_settings->>'work_start_time')::time,(v_settings->>'work_end_time')::time,
    (v_settings->>'slot_interval_minutes')::integer;
 if v_fits is distinct from true then raise exception 'INVALID_BOOKING_SLOT';end if;
 execute format('select %I.booking_slot_start_at($1,$2,$3,$4)',p_schema)
  into v_start using p_booking_date,p_start_time,
    (v_settings->>'work_start_time')::time,(v_settings->>'work_end_time')::time;
 if v_start <= (clock_timestamp() at time zone 'Asia/Taipei')
 then raise exception 'BOOKING_TIME_PASSED';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id,0));
 execute format('select to_jsonb(x) from %I.bookings x where x.request_id=$1',p_schema)
  into v_saved using p_request_id;
 if v_saved is not null then raise exception 'REQUEST_ID_CONFLICT';end if;
 -- An operational placeholder is saved as a booking-item snapshot so downstream
 -- calendars and LINE notifications use the real held duration, without selling a service.
 execute format($insert$
   insert into %I.bookings as b(
    request_id,service_id,member_id,booking_date,start_time,end_time,
    total_duration_minutes,status,member_note,admin_note,
    contact_source,contact_surname,contact_salutation,contact_phone,
    technician_id,confirmed_by,confirmed_at
   ) values($1,$2,null,$3,$4,($4+make_interval(mins=>$5))::time,
    $5,'pending','',$6,'custom','現場','mr',null,null,null,null)
   returning to_jsonb(b)$insert$,p_schema)
  into v_booking using p_request_id,v_store_id,p_booking_date,p_start_time,p_duration,v_note;
 execute format('insert into %I.booking_participants(booking_id,position,technician_id) values($1,1,null) returning id',p_schema)
  into v_participant using (v_booking->>'id')::uuid;
 execute format($items$
   insert into %I.booking_items(
    booking_id,service_id,service_title,unit_duration_minutes,
    unit_price_amount,quantity,service_type,counts_toward_membership)
   values($1,$2,'現場預約時段',$3,0,1,$4,false)$items$,p_schema)
  using (v_booking->>'id')::uuid,v_store_id,p_duration,v_store->>'service_type';
 execute format($part$
   insert into %I.booking_participant_items(
    participant_id,service_id,service_title,unit_duration_minutes,unit_price_amount,quantity)
   values($1,$2,'現場預約時段',$3,0,1)$part$,p_schema)
  using v_participant,v_store_id,p_duration;
 execute format($audit$
   insert into %I.booking_audit_events(
    actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
   values($1,'frontdesk','BOOKING_PHONE_CREATED','booking',$2,'success',
    jsonb_build_object('source','phone','partySize',1,'durationMinutes',$3))$audit$,p_schema)
  using p_actor,v_booking->>'id',p_duration;
 return v_booking;
exception when exclusion_violation then raise exception 'BOOKING_SLOT_TAKEN';
end $fn$;
revoke all on function platform_private.frontdesk_create_duration_booking(text,text,text,date,time without time zone,integer,text)
 from public,anon,authenticated;
grant execute on function platform_private.frontdesk_create_duration_booking(text,text,text,date,time without time zone,integer,text)
 to service_role;

do $patch$
declare d text;
 v_old_req constant text:=$old$or p_body->>'startTime' is null or p_body->'items' is null$old$;
 v_new_req constant text:=$new$or p_body->>'startTime' is null or p_body ? 'items'
      or (case when coalesce(p_body->>'totalDurationMinutes','') ~ '^[1-9][0-9]{0,3}$'
         then (p_body->>'totalDurationMinutes')::integer between 1 and 1439
         else false end) is not true$new$;
 v_old_call constant text:=$old$   execute format('select to_jsonb(%I.frontdesk_create_phone_booking_request($1,$2,$3,$4,$5,$6,$7,$8,$9))',t.runtime_schema)
     into b using p_body->>'phoneRequestId',p_actor,(b->>'booking_date')::date,
       (p_body->>'startTime')::time,'現場','mr',null,p_body->'items',
       '原預約 '||(p_body->>'bookingId')||' 拒絕後的現場／電話預約';$old$;
 v_new_call constant text:=$new$   b:=platform_private.frontdesk_create_duration_booking(
      t.runtime_schema,p_body->>'phoneRequestId',p_actor,
      (b->>'booking_date')::date,(p_body->>'startTime')::time,
      (p_body->>'totalDurationMinutes')::integer,
      '原預約 '||(p_body->>'bookingId')||' 拒絕後的現場／電話預約');$new$;
begin
 select pg_get_functiondef('public.platform_frontdesk_request(uuid,text,text,timestamp with time zone,text,jsonb)'::regprocedure)
  into strict d;
 if position('platform_private.frontdesk_create_duration_booking(' in d)>0
 then return;end if;
 if (length(d)-length(replace(d,v_old_req,'')))<>length(v_old_req)
   or (length(d)-length(replace(d,v_old_call,'')))<>length(v_old_call)
 then raise exception 'FRONTDESK_DURATION_ROUTER_CONTRACT_CHANGED';end if;
 execute replace(replace(d,v_old_req,v_new_req),v_old_call,v_new_call);
end $patch$;
notify pgrst,'reload schema';
