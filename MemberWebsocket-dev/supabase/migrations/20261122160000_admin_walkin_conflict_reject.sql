-- AC-ADM-WALKIN-001..009: the management review now shares the frontdesk's
-- duration-only, merchant-policy and half-open overlap contract.
-- One service-role-only SQL transaction rejects the original and creates the
-- confirmed replacement. Losing a response is safe to retry with the same ID.
-- Do not broaden permissions for the existing frontdesk entry points.

-- The frontdesk duration helper remains unchanged. A separate verified-admin
-- helper preserves truthful audit provenance while reusing the same insert
-- shape, bundle assertions, business-hours checks and tenant configuration.
CREATE OR REPLACE FUNCTION platform_private.admin_create_duration_booking(p_schema text, p_request_id text, p_actor text, p_booking_date date, p_start_time time without time zone, p_duration integer, p_note text, p_audit_at timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_settings jsonb;v_store jsonb;v_saved jsonb;v_booking jsonb;
 v_start timestamp without time zone;v_fits boolean;v_participant uuid;
 v_store_id constant uuid:='00000000-0000-4000-8000-000000000010';
 v_note text:=coalesce(p_note,'');v_authorized boolean;
 v_policy jsonb;v_clock integer;
begin
 if p_schema !~ '^business_[0-9a-f]{32}$'
    or not exists(select 1 from platform_private.tenants where runtime_schema=p_schema)
 then raise exception 'BUSINESS_SCHEMA_INVALID';end if;
 execute format('select exists(select 1 from %I.admins where line_user_id=$1 and role=''admin'' and status=''active'')',p_schema)
   into v_authorized using p_actor;
 if v_authorized is distinct from true then raise exception 'ADMIN_REQUIRED';end if;
 if p_request_id !~ '^PHONE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 then raise exception 'INVALID_REQUEST_ID';end if;
 if p_duration is null or p_duration not between 1 and 1439
 then raise exception 'INVALID_BOOKING_DURATION';end if;
 if p_booking_date is null or p_start_time is null
 then raise exception 'INVALID_BOOKING_SLOT';end if;
 if char_length(v_note)>500 then raise exception 'INVALID_BOOKING_NOTE';end if;

 -- Repeat the merchant's 10-minute policy on the authoritative SQL write
 -- boundary; the frontend dropdown is not a security boundary.
 select module_line#>'{booking,frontdesk}' into v_policy
 from platform_private.tenants where runtime_schema=p_schema;
 v_clock:=extract(hour from p_start_time)::integer*60
          +extract(minute from p_start_time)::integer;
 if extract(second from p_start_time)<>0 or v_clock%10<>0
  or p_duration%10<>0
  or v_clock<coalesce((v_policy->>'conflictStartMin')::integer,0)
  or v_clock>coalesce((v_policy->>'conflictStartMax')::integer,1430)
  or p_duration<coalesce((v_policy->>'conflictDurationMin')::integer,10)
  or p_duration>coalesce((v_policy->>'conflictDurationMax')::integer,1430)
 then raise exception 'FRONTDESK_CONFLICT_POLICY';end if;

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
    actor_line_user_id,actor_role,action,target_type,target_id,result,metadata,created_at)
   values($1,'admin','BOOKING_PHONE_CREATED','booking',$2,'success',
    jsonb_build_object('source','phone','partySize',1,'durationMinutes',$3),$4)$audit$,p_schema)
  using p_actor,v_booking->>'id',p_duration,p_audit_at;
 return v_booking;
exception when exclusion_violation then raise exception 'BOOKING_SLOT_TAKEN';
end $function$;

revoke all on function platform_private.admin_create_duration_booking(text,text,text,date,time without time zone,integer,text,timestamptz) from public,anon,authenticated;
grant execute on function platform_private.admin_create_duration_booking(text,text,text,date,time without time zone,integer,text,timestamptz) to service_role;

-- The existing booking-item bundle validation requires paired audit evidence
-- before moving the replacement to confirmed. Accept admin-admin as well as
-- frontdesk-frontdesk provenance, never a mix of roles or actors.
do $pair$
declare t record; d text; v_snapshot jsonb; entries jsonb; existing text;
 old_phone constant text:='phone_audit.actor_role=''frontdesk''';
 new_phone constant text:='phone_audit.actor_role in (''frontdesk'',''admin'')';
 old_reject constant text:='reject_audit.actor_role=''frontdesk''';
 new_reject constant text:='reject_audit.actor_role=phone_audit.actor_role';
begin
 for t in select runtime_schema from platform_private.tenants loop
  if t.runtime_schema !~ '^business_[0-9a-f]{32}$' then raise exception 'ADMIN_WALKIN_SCHEMA_INVALID';end if;
  select pg_get_functiondef((format('%I.assert_booking_item_bundle()',t.runtime_schema))::regprocedure) into strict d;
  if position(new_phone in d)>0 then continue;end if;
  if position(old_phone in d)=0 or position(old_reject in d)=0 then raise exception 'ADMIN_WALKIN_BUNDLE_CONTRACT_CHANGED';end if;
  execute replace(replace(d,old_phone,new_phone),old_reject,new_reject);
 end loop;
 select snapshot into strict v_snapshot from platform_private.business_templates
  where version='business-v1-20261019' for update;
 select x->>'definition' into existing from jsonb_array_elements(v_snapshot->'functions') x
  where x->>'name'='assert_booking_item_bundle';
 if existing is null or (position(old_phone in existing)=0 and position(new_phone in existing)=0)
 then raise exception 'ADMIN_WALKIN_TEMPLATE_UNVERIFIED';end if;
 if position(new_phone in existing)=0 then
  if position(old_reject in existing)=0 then raise exception 'ADMIN_WALKIN_TEMPLATE_CONTRACT_CHANGED';end if;
  select jsonb_agg(
    case when x->>'name'='assert_booking_item_bundle'
      then jsonb_set(x,'{definition}',to_jsonb(replace(replace(x->>'definition',old_phone,new_phone),old_reject,new_reject)))
      else x end order by ord)
   into entries
   from jsonb_array_elements(v_snapshot->'functions') with ordinality as items(x,ord);
  update platform_private.business_templates
   set snapshot=jsonb_set(v_snapshot,'{functions}',entries)
   where version='business-v1-20261019';
 end if;
end $pair$;

create or replace function public.platform_admin_reject_walkin(
 p_tenant_id uuid,p_actor text,p_issued_at timestamptz,p_body jsonb default '{}'::jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $walkin$
declare
 t platform_private.tenants;
 r platform_private.requests;
 original jsonb; replacement jsonb; outcome jsonb;
 v_request uuid; v_phone_request text; v_booking uuid; v_hash text;
 v_duration integer; v_clock integer; v_start time without time zone;
 v_candidate timestamp without time zone; v_at timestamptz;
 v_policy jsonb; v_admin boolean;
begin
 select * into t from platform_private.tenants where id=p_tenant_id for share;
 if t.id is null or t.status<>'active' or t.runtime_schema !~ '^business_[0-9a-f]{32}$'
   or t.features->>'booking' is distinct from 'true'
 then raise exception 'ADMIN_REQUIRED';end if;
 if p_actor is distinct from t.owner_line_user_id
   or p_actor !~ '^U[0-9a-f]{32}$'
   or p_issued_at is null or not isfinite(p_issued_at)
   or p_issued_at>clock_timestamp()+interval '60 seconds'
   or p_issued_at<=coalesce(t.access_revoked_before,'-infinity'::timestamptz)
 then raise exception 'ADMIN_REQUIRED';end if;
 execute format('select exists(select 1 from %I.admins where line_user_id=$1 and status=''active'' and role=''admin'')',t.runtime_schema)
  into v_admin using p_actor;
 if v_admin is distinct from true then raise exception 'ADMIN_REQUIRED';end if;

 if jsonb_typeof(p_body) is distinct from 'object'
  or p_body->>'status' is distinct from 'rejected'
  or p_body->>'rejectionReason' is distinct from 'unrecorded_phone_booking'
  or coalesce(p_body->>'startTime','') !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
  or coalesce(p_body->>'totalDurationMinutes','') !~ '^[1-9][0-9]{1,3}$'
  or nullif(p_body->>'bookingId','') is null
  or nullif(p_body->>'expectedUpdatedAt','') is null
  or nullif(p_body->>'requestId','') is null
  or char_length(coalesce(p_body->>'adminNote',''))>500
 then raise exception 'ADMIN_WALKIN_POLICY';end if;
 v_start:=(p_body->>'startTime')::time;
 v_duration:=(p_body->>'totalDurationMinutes')::integer;
 v_clock:=extract(hour from v_start)::integer*60 + extract(minute from v_start)::integer;
 v_policy:=t.module_line->'booking'->'frontdesk';
 if v_duration<10 or v_duration>1430 or v_duration%10<>0 or v_clock%10<>0
  or v_clock<coalesce((v_policy->>'conflictStartMin')::integer,0)
  or v_clock>coalesce((v_policy->>'conflictStartMax')::integer,1430)
  or v_duration<coalesce((v_policy->>'conflictDurationMin')::integer,10)
  or v_duration>coalesce((v_policy->>'conflictDurationMax')::integer,1430)
 then raise exception 'ADMIN_WALKIN_POLICY';end if;
 v_request:=(p_body->>'requestId')::uuid;
 v_booking:=(p_body->>'bookingId')::uuid;
 v_phone_request:='PHONE-'||v_request::text;
 if p_body->>'phoneRequestId' is distinct from v_phone_request then raise exception 'ADMIN_WALKIN_POLICY';end if;
 v_hash:=encode(sha256(convert_to((p_body-'requestId')::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(v_request::text,0));
 select * into r from platform_private.requests where request_id=v_request for update;
 if found then
  if r.actor<>p_actor or r.operation<>'admin:booking:walkin:'||t.id::text
   or r.payload_hash<>v_hash then raise exception 'ADMIN_WALKIN_REQUEST_CONFLICT';end if;
  return r.result||'{"alreadyApplied":true}'::jsonb;
 end if;

 execute format('select to_jsonb(b) from %I.bookings b where b.id=$1 for update',t.runtime_schema)
  into original using v_booking;
 if original is null then raise exception 'BOOKING_NOT_FOUND';end if;
 if original->>'status'<>'pending'
  or (original->>'updated_at')::timestamptz is distinct from
    (p_body->>'expectedUpdatedAt')::timestamptz
 then raise exception 'BOOKING_CONFLICT';end if;
 if original->>'cancellation_requested_at' is not null
  and original->>'cancellation_reviewed_at' is null
 then raise exception 'BOOKING_CANCELLATION_PENDING';end if;
 if original->>'booking_date' is null or original->>'start_at' is null
   or coalesce((original->>'total_duration_minutes')::integer,0)<=0
 then raise exception 'ADMIN_WALKIN_NOT_OVERLAPPING';end if;

 -- The exact same canonical business-day timestamp calculation used by the
 -- frontdesk overlap SQL, including shifts which cross midnight.
 execute format('select %1$I.booking_slot_start_at($1,$2,s.work_start_time,s.work_end_time) from %1$I.booking_settings s where s.id=1',t.runtime_schema)
  into v_candidate using (original->>'booking_date')::date,v_start;
 if v_candidate is null
   or v_candidate >= (original->>'start_at')::timestamp
       + make_interval(mins=>(original->>'total_duration_minutes')::integer)
   or v_candidate + make_interval(mins=>v_duration)
       <= (original->>'start_at')::timestamp
 then raise exception 'ADMIN_WALKIN_NOT_OVERLAPPING';end if;

 v_at:=clock_timestamp();
 execute format('update %I.bookings b set status=''rejected'',rejected_by=$2,rejected_at=$3,rejection_reason=''unrecorded_phone_booking'',admin_note=$4 where b.id=$1 and b.status=''pending'' returning to_jsonb(b)',t.runtime_schema)
  into original using v_booking,p_actor,v_at,coalesce(p_body->>'adminNote','');
 if original is null then raise exception 'BOOKING_CONFLICT';end if;
 execute format($audit$
  insert into %I.booking_audit_events(
   actor_line_user_id,actor_role,action,target_type,target_id,result,metadata,created_at)
  values($1,'admin','BOOKING_REJECTED','booking',$2,'success',
   jsonb_build_object('previousStatus','pending','rejectionReason','unrecorded_phone_booking'),$3)
 $audit$,t.runtime_schema) using p_actor,v_booking::text,v_at;

 replacement:=platform_private.admin_create_duration_booking(
   t.runtime_schema,v_phone_request,p_actor,
   (original->>'booking_date')::date,v_start,v_duration,
   '原預約 '||v_booking::text||' 拒絕後的現場／電話預約',v_at);
 execute format('update %I.bookings b set status=''confirmed'',confirmed_by=$2,confirmed_at=$3,contact_surname=''管理端'',contact_salutation=null where b.id=$1 and b.status=''pending'' returning to_jsonb(b)',t.runtime_schema)
  into replacement using (replacement->>'id')::uuid,p_actor,v_at;
 if replacement is null then raise exception 'BOOKING_CONFLICT';end if;

 outcome:=jsonb_build_object('bookingId',v_booking,'status','rejected',
  'phoneBookingId',replacement->>'id','phoneBookingStatus','confirmed','alreadyApplied',false);
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
  values(v_request,p_actor,'admin:booking:walkin:'||t.id::text,v_hash,outcome);
 return outcome;
exception when exclusion_violation then raise exception 'PHONE_BOOKING_CONFLICT';
end $walkin$;

revoke all on function public.platform_admin_reject_walkin(uuid,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.platform_admin_reject_walkin(uuid,text,timestamptz,jsonb) to service_role;
notify pgrst,'reload schema';
