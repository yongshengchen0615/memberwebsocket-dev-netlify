-- AC-FR-005: frontdesk phone requests are pending, occupy slots and require admin review.
-- Clone the established phone-booking transaction into a separate tenant RPC;
-- never alter the old admin confirmed-phone contract.
create or replace function platform_private.install_frontdesk_phone(p_schema text)
returns void language plpgsql security definer set search_path='' as $install$
declare d text;old_auth text;new_auth text;v_target text;
begin
 if p_schema !~ '^business_[0-9a-f]{32}$' or
    not exists(select 1 from platform_private.tenants where runtime_schema=p_schema) then
   raise exception 'BUSINESS_SCHEMA_INVALID';end if;
 v_target:=format('%I.admin_create_phone_booking_request(text,text,date,time without time zone,text,text,text,jsonb,text)',p_schema);
 select pg_get_functiondef(to_regprocedure(v_target)) into strict d;
 -- A private, tenant-scoped copy receives only already-approved reviewers.
 d:=replace(d,format('%I.admin_create_phone_booking_request(',p_schema),
              format('%I.frontdesk_create_phone_booking_request(',p_schema));
 old_auth:=format($old$  if not exists (
    select 1 from %I.admins
    where line_user_id = p_actor and role = 'admin' and status = 'active'
  ) then raise exception 'ADMIN_REQUIRED'; end if;$old$,p_schema);
 new_auth:=$new$  if not exists (
    select 1 from platform_private.frontdesk_staff f
      join platform_private.tenants t on t.id=f.tenant_id
    where t.runtime_schema = TG_TABLE_SCHEMA
      and f.line_user_id = p_actor and f.status='approved'
      and f.permission_mode='review' and f.oa_verified_at is not null
  ) then raise exception 'FRONTDESK_REVIEW_REQUIRED'; end if;$new$;
 -- This function is not a trigger, so use the explicit prevalidated schema.
 new_auth:=replace(new_auth,'t.runtime_schema = TG_TABLE_SCHEMA',
                              format('t.runtime_schema = %L',p_schema));
 if length(d)-length(replace(d,old_auth,''))<>length(old_auth) then raise exception 'PHONE_AUTH_CONTRACT_CHANGED';end if;
 d:=replace(d,old_auth,new_auth);
 if position('or v_saved.confirmed_by is distinct from p_actor' in d)=0 then raise exception 'PHONE_REPLAY_CONTRACT_CHANGED';end if;
 d:=replace(d,'or v_saved.confirmed_by is distinct from p_actor',
    format($replay$or not exists(select 1 from %I.booking_audit_events ae
       where ae.target_type='booking' and ae.target_id=v_saved.id::text
         and ae.action='BOOKING_PHONE_CREATED' and ae.actor_role='frontdesk'
         and ae.actor_line_user_id=p_actor)$replay$,p_schema));
 if position('v_total,''confirmed'','''',v_note' in d)=0 then raise exception 'PHONE_STATUS_CONTRACT_CHANGED';end if;
 d:=replace(d,'v_total,''confirmed'','''',v_note','v_total,''pending'','''',v_note');
 if position('null,p_actor,clock_timestamp()' in d)=0 then raise exception 'PHONE_CONFIRM_CONTRACT_CHANGED';end if;
 d:=replace(d,'null,p_actor,clock_timestamp()','null,null,null');
 if position('p_actor,''admin'',''BOOKING_PHONE_CREATED''' in d)=0 then raise exception 'PHONE_AUDIT_CONTRACT_CHANGED';end if;
 d:=replace(d,'p_actor,''admin'',''BOOKING_PHONE_CREATED''','p_actor,''frontdesk'',''BOOKING_PHONE_CREATED''');
 execute d;
 execute format('revoke all on function %I.frontdesk_create_phone_booking_request(text,text,date,time without time zone,text,text,text,jsonb,text) from public,anon,authenticated',p_schema);
 execute format('grant execute on function %I.frontdesk_create_phone_booking_request(text,text,date,time without time zone,text,text,text,jsonb,text) to service_role',p_schema);
end $install$;
revoke all on function platform_private.install_frontdesk_phone(text) from public,anon,authenticated;
grant execute on function platform_private.install_frontdesk_phone(text) to service_role;

create or replace function platform_private.frontdesk_phone_catalog(p_schema text)
returns jsonb language plpgsql security definer set search_path='' as $catalog$
declare v jsonb;s jsonb;
begin
 if not exists(select 1 from platform_private.tenants where runtime_schema=p_schema) then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 execute format($q$select coalesce(jsonb_agg(jsonb_build_object('id',id,'title',title,'durationMinutes',duration_minutes,'priceAmount',price_amount) order by title),'[]'::jsonb)
  from %I.booking_services where is_active and deleted_at is null and id<>'00000000-0000-4000-8000-000000000010'::uuid$q$,p_schema) into v;
 execute format('select jsonb_build_object(''slotIntervalMinutes'',slot_interval_minutes,''workStart'',work_start_time,''workEnd'',work_end_time,''minAdvanceDays'',min_advance_days,''maxAdvanceDays'',max_advance_days) from %I.booking_settings where id=1',p_schema) into s;
 return jsonb_build_object('services',coalesce(v,'[]'::jsonb),'settings',s);
end $catalog$;
revoke all on function platform_private.frontdesk_phone_catalog(text) from public,anon,authenticated;

create or replace function platform_private.frontdesk_phone_slots(p_schema text,p_body jsonb)
returns jsonb language plpgsql security definer set search_path='' as $slots$
declare v_date date;v_items jsonb;v_item jsonb;v_service uuid;v_qty int;v_total int:=0;v_minutes int;
 v_open time;v_close time;v_interval int;v_min_days int;v_max_days int;v_holiday boolean;
 v_cursor time;v_start timestamp;v_end timestamp;v_overlap boolean;v_output jsonb:='[]'::jsonb;v_step int;
begin
 if not exists(select 1 from platform_private.tenants where runtime_schema=p_schema) then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 begin v_date:=(p_body->>'bookingDate')::date;exception when others then raise exception 'INVALID_BOOKING_SLOT';end;
 v_items:=p_body->'items';
 if v_items is null or jsonb_typeof(v_items)<>'array' or jsonb_array_length(v_items) not between 1 and 20 then raise exception 'INVALID_BOOKING_ITEMS';end if;
 execute format('select work_start_time,work_end_time,slot_interval_minutes,min_advance_days,max_advance_days from %I.booking_settings where id=1',p_schema)
  into v_open,v_close,v_interval,v_min_days,v_max_days;
 if v_open is null or v_interval is null or v_interval not between 1 and 1439 then raise exception 'BOOKING_SETTINGS_MISSING';end if;
 if v_date < (clock_timestamp() at time zone 'Asia/Taipei')::date+coalesce(v_min_days,0) or
    (coalesce(v_max_days,0)>0 and v_date > (clock_timestamp() at time zone 'Asia/Taipei')::date+v_max_days) then
   return jsonb_build_object('slots','[]'::jsonb,'reason','date');end if;
 execute format('select duration_minutes from %I.booking_services where id=''00000000-0000-4000-8000-000000000010''::uuid and is_active and deleted_at is null',p_schema) into v_total;
 if v_total is null then raise exception 'BOOKING_SERVICE_NOT_FOUND';end if;
 for v_item in select value from jsonb_array_elements(v_items) loop
   begin v_service:=(v_item->>'serviceId')::uuid;v_qty:=(v_item->>'quantity')::int;
   exception when others then raise exception 'INVALID_BOOKING_ITEMS';end;
   if v_qty not between 1 and 2 then raise exception 'INVALID_BOOKING_ITEMS';end if;
   execute format('select duration_minutes from %I.booking_services where id=$1 and is_active and deleted_at is null',p_schema)
    into v_minutes using v_service;
   if v_minutes is null then raise exception 'BOOKING_SERVICE_NOT_FOUND';end if;
   v_total:=v_total+v_minutes*v_qty;
 end loop;
 if v_total not between 1 and 1439 then raise exception 'INVALID_BOOKING_DURATION';end if;
 execute format('select exists(select 1 from %I.calendar_items where item_type=''holiday'' and status=''active'' and starts_on<=$1 and ends_on>=$1)',p_schema) into v_holiday using v_date;
 if v_holiday then return jsonb_build_object('slots','[]'::jsonb,'reason','holiday');end if;
 for v_step in 0..floor(1439.0/v_interval)::int loop
   v_cursor:=(v_open+make_interval(mins=>v_step*v_interval))::time;
   execute format('select %I.booking_slot_fits($1,$2,$3,$4,$5,$6)',p_schema)
    into v_overlap using v_date,v_cursor,v_total,v_open,v_close,v_interval;
   if not coalesce(v_overlap,false) then continue;end if;
   execute format('select %I.booking_slot_start_at($1,$2,$3,$4)',p_schema)
    into v_start using v_date,v_cursor,v_open,v_close;
   v_end:=v_start+make_interval(mins=>v_total);
   execute format('select exists(select 1 from %I.bookings where status in (''pending'',''confirmed'') and start_at<$2 and end_at>$1)',p_schema)
    into v_overlap using v_start,v_end;
   v_output:=v_output||jsonb_build_array(jsonb_build_object('startTime',to_char(v_cursor,'HH24:MI'),
     'available',not v_overlap and v_start>(clock_timestamp() at time zone 'Asia/Taipei')));
 end loop;
 return jsonb_build_object('slots',v_output,'totalDurationMinutes',v_total);
end $slots$;
revoke all on function platform_private.frontdesk_phone_slots(text,jsonb) from public,anon,authenticated;

do $upgrade$
declare d text;v_schema text;old text;replacement text;
begin
 select pg_get_functiondef('public.platform_frontdesk_request(uuid,text,text,timestamp with time zone,text,jsonb)'::regprocedure) into strict d;
 old:=$old$ if p_action='bookings' then$old$;
 replacement:=$new$ if p_action='phone.catalog' then
   return platform_private.frontdesk_phone_catalog(t.runtime_schema);
 end if;
 if p_action='phone.slots' then
   return platform_private.frontdesk_phone_slots(t.runtime_schema,p_body);
 end if;
 if p_action='phone.create' then
   execute format('select to_jsonb(%I.frontdesk_create_phone_booking_request($1,$2,$3,$4,$5,$6,$7,$8,$9))',t.runtime_schema)
     into v using p_body->>'requestId',p_actor,(p_body->>'bookingDate')::date,(p_body->>'startTime')::time,
       p_body->>'contactSurname',p_body->>'contactSalutation',p_body->>'contactPhone',
       p_body->'items',coalesce(p_body->>'adminNote','');
   return jsonb_build_object('bookingId',v->>'id','status',v->>'status');
 end if;
 if p_action='bookings' then$new$;
 if length(d)-length(replace(d,old,''))<>length(old) then raise exception 'FRONTDESK_PHONE_ROUTER_CONTRACT_CHANGED';end if;
 execute replace(d,old,replacement);
 for v_schema in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
   perform platform_private.install_frontdesk_phone(v_schema);
 end loop;
end $upgrade$;
notify pgrst,'reload schema';
