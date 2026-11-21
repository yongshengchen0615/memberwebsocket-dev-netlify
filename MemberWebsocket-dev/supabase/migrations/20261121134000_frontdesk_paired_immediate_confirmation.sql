-- AC-FR-007: An approved reviewing frontdesk staff member who rejects an
-- unrecorded walk-in booking immediately confirms its paired replacement.
-- No administrator approval step, second LINE push or change to standalone
-- phone.create (which retains the existing pending approval contract).
-- Safety: both writes and the confirmation remain in one PostgreSQL transaction.
do $apply$
declare d text;
 v_old constant text:=$old$
   v:=public.platform_frontdesk_request(p_tenant_id,p_actor,p_channel_id,p_issued_at,'booking.update',p_body);
   execute format('select to_jsonb(%I.frontdesk_create_phone_booking_request($1,$2,$3,$4,$5,$6,$7,$8,$9))',t.runtime_schema)
      into b using p_body->>'phoneRequestId',p_actor,(b->>'booking_date')::date,
       (p_body->>'startTime')::time,'現場','mr',null,p_body->'items','原預約 '||(p_body->>'bookingId')||' 拒絕後的現場／電話預約';
   return v||jsonb_build_object('phoneBookingId',b->>'id','phoneBookingStatus',b->>'status');
$old$;
 v_new constant text:=$new$
   v:=public.platform_frontdesk_request(p_tenant_id,p_actor,p_channel_id,p_issued_at,'booking.update',p_body);
   -- The original review request and replacement creation share one transaction.
   -- Only a verified replay may return a previously confirmed replacement.
   if coalesce((v->>'alreadyApplied')::boolean,false) then
     execute format('select to_jsonb(x) from %I.bookings x where x.request_id=$1',t.runtime_schema)
       into b using p_body->>'phoneRequestId';
     if b is null or b->>'status'<>'confirmed'
       or platform_private.frontdesk_paired_phone_source(t.runtime_schema,b)
          is distinct from (p_body->>'bookingId')::uuid then
       raise exception 'FRONTDESK_REQUEST_CONFLICT';
     end if;
     return v||jsonb_build_object('phoneBookingId',b->>'id','phoneBookingStatus',b->>'status');
   end if;
   execute format('select to_jsonb(%I.frontdesk_create_phone_booking_request($1,$2,$3,$4,$5,$6,$7,$8,$9))',t.runtime_schema)
     into b using p_body->>'phoneRequestId',p_actor,(b->>'booking_date')::date,
       (p_body->>'startTime')::time,'現場','mr',null,p_body->'items',
       '原預約 '||(p_body->>'bookingId')||' 拒絕後的現場／電話預約';
   -- The confirmed state, staff actor and exact display name are durable data,
   -- not merely a LINE presentation change. Preserve request-ID replay above.
   execute format('update %I.bookings x set status=''confirmed'',
       confirmed_by=$2,confirmed_at=clock_timestamp(),
       contact_surname=''櫃檯人員'',contact_salutation=null
       where x.id=$1 and x.status=''pending'' returning to_jsonb(x)',t.runtime_schema)
     into b using (b->>'id')::uuid,p_actor;
   if b is null then raise exception 'FRONTDESK_PHONE_CONFIRM_CONFLICT';end if;
   return v||jsonb_build_object('phoneBookingId',b->>'id','phoneBookingStatus',b->>'status');
$new$;
begin
 select pg_get_functiondef('public.platform_frontdesk_request(uuid,text,text,timestamp with time zone,text,jsonb)'::regprocedure) into strict d;
 -- The testing project may have received this migration before the release
 -- ledger was established; a second application must be a verified no-op.
 if position('FRONTDESK_PHONE_CONFIRM_CONFLICT' in d)>0 then
   if position('contact_surname=''''櫃檯人員''''' in d)=0 then
     raise exception 'FRONTDESK_PAIRED_CONFIRM_INCOMPLETE';end if;
   return;
 end if;
 if (length(d)-length(replace(d,v_old,'')))<>length(v_old) then
   raise exception 'FRONTDESK_PAIRED_CONFIRM_ROUTER_CONTRACT_CHANGED';
 end if;
 execute replace(d,v_old,v_new);
end $apply$;

-- A deferred INSERT notification sees NEW.status=pending, but the committed
-- booking is confirmed. Both states must be recognized as the same paired
-- replacement, never a second member/frontdesk/admin booking notice.
do $helper$
declare d text;
 v_old constant text:=$old$if p_booking->>'status' is distinct from 'pending' then return null;end if;$old$;
 v_new constant text:=$new$if coalesce(p_booking->>'status','') not in ('pending','confirmed') then return null;end if;$new$;
begin
 select pg_get_functiondef('platform_private.frontdesk_paired_phone_source(text,jsonb)'::regprocedure) into strict d;
 if position('not in (''pending'',''confirmed'')' in d)>0 then return;end if;
 if (length(d)-length(replace(d,v_old,'')))<>length(v_old) then
   raise exception 'FRONTDESK_PAIRED_SOURCE_CONTRACT_CHANGED';
 end if;
 execute replace(d,v_old,v_new);
end $helper$;

-- The rejected booking's deferred notice runs after the paired replacement
-- has been confirmed. Include the confirmed replacement in its single alert.
do $notice$
declare d text;
 v_old_status constant text:=$old$and b.status=''pending''$old$;
 v_new_status constant text:=$new$and b.status in (''pending'',''confirmed'')$new$;
 v_old_actor constant text:=$old$||E'\n預約人：'||coalesce(v_phone->>'name','現場')$old$;
 v_new_actor constant text:=$new$||E'\n預約人：櫃檯人員'$new$;
 v_old_review constant text:=$old$||E'\n預約狀態：待管理員確認'$old$;
 v_new_review constant text:=$new$||E'\n預約狀態：'||case when v_phone->>'status'='confirmed' then '已確認' else '待管理員確認' end$new$;
begin
 select pg_get_functiondef('platform_private.append_booking_rejection_notice()'::regprocedure) into strict d;
 if position('then ''已確認'' else ''待管理員確認''' in d)>0 then return;end if;
 if (length(d)-length(replace(d,v_old_status,'')))<>length(v_old_status)
    or (length(d)-length(replace(d,v_old_actor,'')))<>length(v_old_actor)
    or (length(d)-length(replace(d,v_old_review,'')))<>length(v_old_review) then
   raise exception 'FRONTDESK_PAIRED_REJECTION_NOTICE_CONTRACT_CHANGED';
 end if;
 execute replace(replace(replace(d,v_old_status,v_new_status),v_old_actor,v_new_actor),
   v_old_review,v_new_review);
end $notice$;

notify pgrst,'reload schema';
