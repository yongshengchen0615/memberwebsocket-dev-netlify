-- AC-FR-MODAL-004: reject a pending member booking and register the replacement
-- walk-in/telephone reservation in one PostgreSQL transaction. No partial reject.
-- The existing authorized reviewer RPC and its frozen request payload hash are
-- deliberately reused for CAS, revocation and idempotent lost-response retries.
do $upgrade$
declare d text;
 v_anchor constant text:=$anchor$ if p_action='bookings' then$anchor$;
 v_block constant text:=$block$ if p_action='booking.reject_phone' then
   if p_body->>'status' is distinct from 'rejected'
      or p_body->>'rejectionReason' is distinct from 'unrecorded_phone_booking'
      or p_body->>'phoneRequestId' !~ '^PHONE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or p_body->>'requestId' is null or p_body->>'bookingId' is null
      or p_body->>'startTime' is null or p_body->'items' is null
   then raise exception 'PLATFORM_INVALID_INPUT';end if;
   -- Never trust a client-supplied booking date or owner for replacement.
   execute format('select to_jsonb(b) from %I.bookings b where id=$1',t.runtime_schema)
      into b using (p_body->>'bookingId')::uuid;
   if b is null then raise exception 'FRONTDESK_NOT_FOUND';end if;
   -- Both operations run inside this function call's single transaction:
   -- a slot conflict or failed phone insert rolls back the rejection,
   -- its audit event, realtime event and deferred LINE notification together.
   -- Keep phoneRequestId/items/startTime in the underlying review request
   -- payload so the existing requestId hash forbids changing them on replay.
   v:=public.platform_frontdesk_request(p_tenant_id,p_actor,p_channel_id,p_issued_at,'booking.update',p_body);
   execute format('select to_jsonb(%I.frontdesk_create_phone_booking_request($1,$2,$3,$4,$5,$6,$7,$8,$9))',t.runtime_schema)
      into b using p_body->>'phoneRequestId',p_actor,(b->>'booking_date')::date,
       (p_body->>'startTime')::time,'現場','mr',null,p_body->'items','原預約 '||(p_body->>'bookingId')||' 拒絕後的現場／電話預約';
   return v||jsonb_build_object('phoneBookingId',b->>'id','phoneBookingStatus',b->>'status');
 end if;
 if p_action='bookings' then$block$;
begin
 select pg_get_functiondef('public.platform_frontdesk_request(uuid,text,text,timestamp with time zone,text,jsonb)'::regprocedure) into strict d;
 if position('if p_action=''booking.reject_phone'' then' in d)>0 then return;end if;
 if (length(d)-length(replace(d,v_anchor,'')))/length(v_anchor)<>1
   then raise exception 'FRONTDESK_REJECTION_ROUTER_CONTRACT_CHANGED';end if;
 execute replace(d,v_anchor,v_block);
end $upgrade$;
-- Correct a development database that received the earlier version of this
-- function during transactional QA, before the source-booking binding was added.
do $repair$
declare d text;old_note constant text:='''櫃檯拒絕原預約後補登記現場／電話預約''';
 new_note constant text:='''原預約 ''||(p_body->>''bookingId'')||'' 拒絕後的現場／電話預約''';
begin
 select pg_get_functiondef('public.platform_frontdesk_request(uuid,text,text,timestamp with time zone,text,jsonb)'::regprocedure) into strict d;
 if position(old_note in d)>0 then execute replace(d,old_note,new_note);end if;
end $repair$;
notify pgrst,'reload schema';
