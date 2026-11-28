-- AC-001..006: Admin vacation rejections use the same booking-scoped technician
-- candidates and immutable member wording as frontdesk, in one audited write.
-- No client-provided technician names, dates, or member description are trusted.
create or replace function public.platform_admin_reject_vacation(
 p_tenant_id uuid,p_actor text,p_issued_at timestamptz,p_body jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $vacation$
declare
 t platform_private.tenants;
 r platform_private.requests;
 v_booking uuid;v_request uuid;v_original jsonb;v_outcome jsonb;
 v_hash text;v_actor_is_admin boolean;v_ids text[]:=array[]::text[];
 v_names text[];v_item text;v_description text;v_at timestamptz;
begin
 select * into t from platform_private.tenants where id=p_tenant_id for share;
 if t.id is null or t.status<>'active'
   or t.runtime_schema !~ '^business_[0-9a-f]{32}$'
   or t.features->>'booking' is distinct from 'true'
 then raise exception 'ADMIN_REQUIRED';end if;
 if p_actor is distinct from t.owner_line_user_id
   or p_actor !~ '^U[0-9a-f]{32}$'
   or p_issued_at is null or not isfinite(p_issued_at)
   or p_issued_at>clock_timestamp()+interval '60 seconds'
   or p_issued_at<=coalesce(t.access_revoked_before,'-infinity'::timestamptz)
 then raise exception 'ADMIN_REQUIRED';end if;
 execute format('select exists(select 1 from %I.admins where line_user_id=$1 and status=''active'' and role=''admin'')',t.runtime_schema)
   into v_actor_is_admin using p_actor;
 if v_actor_is_admin is distinct from true then raise exception 'ADMIN_REQUIRED';end if;

 if jsonb_typeof(p_body) is distinct from 'object'
   or p_body->>'status' is distinct from 'rejected'
   or p_body->>'rejectionReason' is distinct from 'technician_leave'
   or coalesce(p_body->>'bookingId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   or coalesce(p_body->>'requestId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   or nullif(p_body->>'expectedUpdatedAt','') is null
   or char_length(coalesce(p_body->>'adminNote',''))>500
   or jsonb_typeof(p_body->'vacationTechnicianIds') is distinct from 'array'
 then raise exception 'VACATION_TECHNICIANS_INVALID';end if;
 if exists(select 1 from jsonb_object_keys(p_body) as k(key) where k.key not in (
   'bookingId','requestId','expectedUpdatedAt','status','rejectionReason','adminNote','vacationTechnicianIds'
 )) then raise exception 'VACATION_TECHNICIANS_INVALID';end if;
 if jsonb_array_length(p_body->'vacationTechnicianIds')<1
   or jsonb_array_length(p_body->'vacationTechnicianIds')>10
 then raise exception 'VACATION_TECHNICIANS_REQUIRED';end if;
 for v_item in select value from jsonb_array_elements_text(p_body->'vacationTechnicianIds') loop
   if v_item !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or v_item=any(v_ids)
   then raise exception 'VACATION_TECHNICIANS_INVALID';end if;
   v_ids:=array_append(v_ids,v_item);
 end loop;
 v_booking:=(p_body->>'bookingId')::uuid;
 v_request:=(p_body->>'requestId')::uuid;
 v_hash:=encode(sha256(convert_to((p_body-'requestId')::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(v_request::text,0));
 select * into r from platform_private.requests where request_id=v_request for update;
 if found then
   if r.actor<>p_actor or r.operation<>'admin:booking:vacation:'||t.id::text
     or r.payload_hash<>v_hash
   then raise exception 'ADMIN_VACATION_REQUEST_CONFLICT';end if;
   return r.result||'{"alreadyApplied":true}'::jsonb;
 end if;

 execute format('select to_jsonb(b) from %I.bookings b where b.id=$1 for update',t.runtime_schema)
   into v_original using v_booking;
 if v_original is null then raise exception 'BOOKING_NOT_FOUND';end if;
 if v_original->>'status'<>'pending'
   or (v_original->>'updated_at')::timestamptz is distinct from
      (p_body->>'expectedUpdatedAt')::timestamptz
 then raise exception 'BOOKING_CONFLICT';end if;
 if v_original->>'cancellation_requested_at' is not null
   and v_original->>'cancellation_reviewed_at' is null
 then raise exception 'BOOKING_CANCELLATION_PENDING';end if;

 v_names:=platform_private.frontdesk_booked_vacation_names(
   t.runtime_schema,v_booking,p_body->'vacationTechnicianIds');
 if cardinality(v_names)<>cardinality(v_ids)
 then raise exception 'VACATION_TECHNICIANS_INVALID';end if;
 v_description:=platform_private.frontdesk_vacation_member_description(
   t.runtime_schema,v_booking,v_names);
 v_at:=clock_timestamp();
 execute format($write$
   update %I.bookings
   set status='rejected',rejected_by=$2,rejected_at=$3,admin_note=$4,
       rejection_reason='technician_leave',rejection_reason_id='technician_leave',
       rejection_reason_label='預約中有休假技師',rejection_member_description=$5
   where id=$1 and status='pending'
   returning to_jsonb(bookings)
 $write$,t.runtime_schema)
   into v_original using v_booking,p_actor,v_at,coalesce(p_body->>'adminNote',''),v_description;
 if v_original is null then raise exception 'BOOKING_CONFLICT';end if;
 execute format($audit$
   insert into %I.booking_audit_events(
     actor_line_user_id,actor_role,action,target_type,target_id,result,metadata,created_at)
   values($1,'admin','BOOKING_REJECTED','booking',$2,'success',$3,$4)
 $audit$,t.runtime_schema)
   using p_actor,v_booking::text,
      jsonb_build_object('previousStatus','pending','rejectionReason','technician_leave',
        'vacationTechnicianIds',p_body->'vacationTechnicianIds'),v_at;
 v_outcome:=jsonb_build_object('bookingId',v_booking,'status','rejected',
   'rejectionReason','technician_leave','alreadyApplied',false);
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
   values(v_request,p_actor,'admin:booking:vacation:'||t.id::text,v_hash,v_outcome);
 return v_outcome;
end $vacation$;
revoke all on function public.platform_admin_reject_vacation(uuid,text,timestamptz,jsonb)
 from public,anon,authenticated;
grant execute on function public.platform_admin_reject_vacation(uuid,text,timestamptz,jsonb)
 to service_role;
notify pgrst,'reload schema';
