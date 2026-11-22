-- AC-FD-LINE-001..004: single-booking LINE entry restricts history at the tenant SQL boundary.
-- Keep staff-wide history when bookingId is absent, and filter BEFORE the 30-entry cap.
-- The existing approved review-staff, LINE identity, tenant, and audit-actor checks remain unchanged.
-- This forward-only migration preserves the existing audit and booking records.

CREATE OR REPLACE FUNCTION public.platform_frontdesk_request(p_tenant_id uuid, p_actor text, p_channel_id text, p_issued_at timestamp with time zone, p_action text, p_body jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare t platform_private.tenants;s platform_private.frontdesk_staff;cfg jsonb;v jsonb;b jsonb;bid uuid;rid uuid;hash text;r platform_private.requests;notice_details text;notice_message text;store_service_minutes integer;fallback_items text;fallback_minutes integer;fallback_amount bigint;
begin
 t:=platform_private.frontdesk_tenant(p_tenant_id);cfg:=t.module_line->'booking'->'frontdesk';
 if cfg->>'enabled' is distinct from 'true' then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 if p_actor is null or p_actor!~'^U[0-9a-f]{32}$' or p_channel_id is distinct from cfg->>'loginChannelId' or p_issued_at is null or not isfinite(p_issued_at) or p_issued_at>clock_timestamp()+interval '60 seconds' or p_issued_at<=coalesce(t.access_revoked_before,'-infinity') or p_issued_at<=coalesce((cfg->>'featureRevokedBefore')::timestamptz,'-infinity') then raise exception 'FRONTDESK_AUTH_INVALID';end if;
 select * into s from platform_private.frontdesk_staff where tenant_id=t.id and login_channel_id=p_channel_id and line_user_id=p_actor for share;
 if p_action='apply' then
  if p_body->>'oaVerified' is distinct from 'true' then raise exception 'FRONTDESK_OA_REQUIRED';end if;
  if p_body->>'verifiedMessagingChannelId' is distinct from cfg->>'messagingChannelId' or p_body->'verifiedConfigRevision' is distinct from cfg->'revision' then raise exception 'FRONTDESK_OA_STALE';end if;
  insert into platform_private.frontdesk_staff(tenant_id,login_channel_id,line_user_id,display_name,oa_verified_at)
   values(t.id,p_channel_id,p_actor,left(coalesce(nullif(p_body->>'displayName',''),'櫃檯人員'),120),clock_timestamp()) on conflict(tenant_id,login_channel_id,line_user_id) do nothing;
  select * into s from platform_private.frontdesk_staff where tenant_id=t.id and login_channel_id=p_channel_id and line_user_id=p_actor;
  return jsonb_build_object('staff',platform_private.frontdesk_staff_json(s));
 end if;
 if p_action='bootstrap' then return jsonb_build_object('staff',case when s.id is null then null else platform_private.frontdesk_staff_json(s) end);end if;
 if s.id is null or s.status<>'approved' or s.permission_mode<>'review' or s.oa_verified_at is null then raise exception 'FRONTDESK_REVIEW_REQUIRED';end if;
 if p_issued_at<=coalesce(s.access_revoked_before,'-infinity') then raise exception 'FRONTDESK_AUTH_INVALID';end if;

 -- A private tenant revision, checked only after approved review authorization.
 if p_action='sync.status' then
   execute format('select coalesce(max(id),0)::text from %I.realtime_events where scope=''admin'' and event_type like ''booking.%%''',t.runtime_schema) into hash;
   return jsonb_build_object('revision',hash);
 end if;
 if p_action='phone.catalog' then
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
 if p_action='booking.reject_phone' then
   if p_body->>'status' is distinct from 'rejected'
      or p_body->>'rejectionReason' is distinct from 'unrecorded_phone_booking'
      or p_body->>'phoneRequestId' !~ '^PHONE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or p_body->>'requestId' is null or p_body->>'bookingId' is null
      or p_body->>'startTime' is null or p_body ? 'items'
      or (case when coalesce(p_body->>'totalDurationMinutes','') ~ '^[1-9][0-9]{0,3}$'
         then (p_body->>'totalDurationMinutes')::integer between 1 and 1439
         else false end) is not true
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
   b:=platform_private.frontdesk_create_duration_booking(
      t.runtime_schema,p_body->>'phoneRequestId',p_actor,
      (b->>'booking_date')::date,(p_body->>'startTime')::time,
      (p_body->>'totalDurationMinutes')::integer,
      '原預約 '||(p_body->>'bookingId')||' 拒絕後的現場／電話預約');
   -- The confirmed state, staff actor and exact display name are durable data,
   -- not merely a LINE presentation change. Preserve request-ID replay above.
   execute format('update %I.bookings x set status=''confirmed'',
       confirmed_by=$2,confirmed_at=clock_timestamp(),
       contact_surname=''櫃檯人員'',contact_salutation=null
       where x.id=$1 and x.status=''pending'' returning to_jsonb(x)',t.runtime_schema)
     into b using (b->>'id')::uuid,p_actor;
   if b is null then raise exception 'FRONTDESK_PHONE_CONFIRM_CONFLICT';end if;
   return v||jsonb_build_object('phoneBookingId',b->>'id','phoneBookingStatus',b->>'status');
 end if;

 if p_action='history' then
  bid:=nullif(p_body->>'bookingId','')::uuid;
  -- Only review-authorized staff can reach this branch (staff guard above).
  -- Staff can inspect their own paired conflicts, never another tenant's.
  execute format($history$
   select coalesce(jsonb_agg(jsonb_build_object(
     'actionAt',e.created_at,
     'booking',case when b.id is null then null else platform_private.frontdesk_booking_json($1,b.id) end,
     'phoneBooking',(
       select platform_private.frontdesk_booking_json($1,p.id)
       from %1$I.booking_audit_events paired
       join %1$I.bookings p on p.id::text=paired.target_id
       where paired.actor_role='frontdesk'
         and paired.action='BOOKING_PHONE_CREATED'
         and paired.target_type='booking'
         and paired.actor_line_user_id=e.actor_line_user_id
         and paired.created_at=e.created_at
         -- This is an audit-proven HISTORICAL pair. Do not call the live
         -- frontdesk_paired_phone_source() helper here: it intentionally
         -- ignores completed/cancelled replacement bookings.
         and p.booking_date=b.booking_date
         and p.admin_note='原預約 '||b.id::text||' 拒絕後的現場／電話預約'
         and b.id is not null
       order by paired.id desc limit 1
     )
   ) order by e.id desc),'[]'::jsonb)
   from (
     select id,created_at,target_id,actor_line_user_id
     from %1$I.booking_audit_events
     where actor_role='frontdesk' and action='BOOKING_REJECTED'
       and target_type='booking' and result='success'
       and metadata->>'rejectionReason'='unrecorded_phone_booking'
       and actor_line_user_id=$2
       and ($3::uuid is null or target_id=$3::text)
     order by id desc limit 30
   ) e left join %1$I.bookings b on b.id::text=e.target_id
  $history$,t.runtime_schema) into v using t.runtime_schema,p_actor,bid;
  return jsonb_build_object('items',coalesce(v,'[]'::jsonb));
 end if;
 if p_action='bookings' then
  bid:=nullif(p_body->>'bookingId','')::uuid;
  execute format('select coalesce(jsonb_agg(platform_private.frontdesk_booking_json($1,x.id) order by x.start_at),''[]'') from (select id,start_at from %I.bookings where ($2::uuid is null and status=''pending'') or id=$2 order by start_at,id limit 50) x',t.runtime_schema) into v using t.runtime_schema,bid;
  return jsonb_build_object('bookings',v);
 end if;
 if p_action is distinct from 'booking.update' or coalesce(p_body->>'status','') not in ('confirmed','rejected') then raise exception 'PLATFORM_INVALID_INPUT';end if;
 bid:=(p_body->>'bookingId')::uuid;rid:=(p_body->>'requestId')::uuid;
 if bid is null or rid is null or nullif(p_body->>'expectedUpdatedAt','') is null then raise exception 'PLATFORM_INVALID_INPUT';end if;
 if p_body->>'status'='rejected' then
   if p_body->>'rejectionReason' is null or p_body->>'rejectionReason' not in ('technician_leave','unrecorded_phone_booking') then
     raise exception 'BOOKING_REJECTION_REASON_REQUIRED';end if;
 elsif p_body ? 'rejectionReason' then raise exception 'BOOKING_REJECTION_REASON_REQUIRED';end if;
 hash:=encode(sha256(convert_to((p_body-'requestId')::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(rid::text,0));
 select * into r from platform_private.requests where request_id=rid;
 if found then
  if r.actor<>p_actor or r.operation<>'frontdesk:booking:'||t.id or r.payload_hash<>hash then raise exception 'FRONTDESK_REQUEST_CONFLICT';end if;
  return r.result||'{"alreadyApplied":true}';
 end if;
 execute format('select to_jsonb(b) from %I.bookings b where id=$1 for update',t.runtime_schema) into b using bid;
 if b is null then raise exception 'FRONTDESK_NOT_FOUND';end if;
 if b->>'status'<>'pending' or (b->>'updated_at')::timestamptz is distinct from (p_body->>'expectedUpdatedAt')::timestamptz then raise exception 'BOOKING_CONFLICT';end if;
 if b->>'cancellation_requested_at' is not null and b->>'cancellation_reviewed_at' is null then raise exception 'BOOKING_CANCELLATION_PENDING';end if;
 execute format('update %I.bookings set status=$2,admin_note=coalesce($3,admin_note),rejection_reason=$5,%I=$4,%I=clock_timestamp() where id=$1',t.runtime_schema,case when p_body->>'status'='confirmed' then 'confirmed_by' else 'rejected_by' end,case when p_body->>'status'='confirmed' then 'confirmed_at' else 'rejected_at' end) using bid,p_body->>'status',left(p_body->>'note',500),p_actor,p_body->>'rejectionReason';
 execute format('insert into %I.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata) values($1,''frontdesk'',$2,''booking'',$3,''success'',$4)',t.runtime_schema) using p_actor,'BOOKING_'||upper(p_body->>'status'),bid::text,jsonb_build_object('previousStatus','pending','rejectionReason',p_body->>'rejectionReason');
 v:=jsonb_build_object('booking',platform_private.frontdesk_booking_json(t.runtime_schema,bid),'alreadyApplied',false);

 -- Frontdesk-only admin notification; member confirmation stays in the existing trigger.
 if p_body->>'status'='confirmed' then
   b:=v->'booking';
   -- Use stored participant-item snapshots, not the mutable service catalogue.
   -- Keep the duration/price rules identical to the existing booking LINE notice.
   execute format($stmt$
     select coalesce(sum(bi.unit_duration_minutes * greatest(coalesce(bi.quantity,1),1)),0)::integer
       from %1$I.booking_items bi
      where bi.booking_id=$1
        and bi.service_id='00000000-0000-4000-8000-000000000010'::uuid
   $stmt$,t.runtime_schema) into store_service_minutes using bid;

   execute format($stmt$
     select string_agg(
       case bp.position
         when 1 then '第一位預約' when 2 then '第二位預約'
         when 3 then '第三位預約' when 4 then '第四位預約'
         when 5 then '第五位預約' when 6 then '第六位預約'
         when 7 then '第七位預約' when 8 then '第八位預約'
         when 9 then '第九位預約' when 10 then '第十位預約'
         else '第 '||bp.position::text||' 位預約'
       end
       ||E'\n預約項目：'||coalesce(nullif(pi.items,''),'請至預約頁查看')
       ||E'\n個別時間：'||(coalesce(pi.service_minutes,0)
           +case when coalesce(pi.has_store_service,false) then 0 else $2 end)::text
           ||' 分鐘'
       ||case when $2>0 then '（含店內服務 '||$2::text||' 分鐘）' else '' end
       ||E'\n個別金額：NT$'||to_char(coalesce(pi.amount,0),'FM999,999,999,990')
       ||E'\n預約技師：'||coalesce(nullif(bt.name,''),'現場安排')
       ||case when nullif(btrim(bp.member_note),'') is not null
           then E'\n個別備註：'
             ||regexp_replace(left(btrim(bp.member_note),500),E'[\r\n]+',' ','g')
           else '' end,
       E'\n\n' order by bp.position
     )
       from %1$I.booking_participants bp
       left join %1$I.booking_technicians bt on bt.id=bp.technician_id
       left join lateral (
         select string_agg(bpi.service_title
                    ||case when greatest(coalesce(bpi.quantity,1),1)>1
                         then ' × '||greatest(coalesce(bpi.quantity,1),1)::text else '' end,
                    '、' order by bpi.created_at,bpi.id) as items,
                coalesce(bool_or(bpi.service_id='00000000-0000-4000-8000-000000000010'::uuid),false) as has_store_service,
                coalesce(sum(bpi.unit_duration_minutes * greatest(coalesce(bpi.quantity,1),1)),0)::integer as service_minutes,
                coalesce(sum(bpi.unit_price_amount * greatest(coalesce(bpi.quantity,1),1)),0)::bigint as amount
           from %1$I.booking_participant_items bpi
          where bpi.participant_id=bp.id
       ) pi on true
      where bp.booking_id=$1
   $stmt$,t.runtime_schema) into notice_details using bid,store_service_minutes;

   -- Historical single-person rows may have booking_items without participants.
   if notice_details is null then
     execute format($stmt$
       select string_agg(bi.service_title
                 ||case when greatest(coalesce(bi.quantity,1),1)>1
                     then ' × '||greatest(coalesce(bi.quantity,1),1)::text else '' end,
                 '、' order by bi.created_at,bi.id),
              coalesce(sum(bi.unit_duration_minutes * greatest(coalesce(bi.quantity,1),1)),0)::integer,
              coalesce(sum(bi.unit_price_amount * greatest(coalesce(bi.quantity,1),1)),0)::bigint
         from %1$I.booking_items bi
        where bi.booking_id=$1
          and bi.service_id<>'00000000-0000-4000-8000-000000000010'::uuid
     $stmt$,t.runtime_schema)
       into fallback_items,fallback_minutes,fallback_amount using bid;
     notice_details:='第一位預約'
       ||E'\n預約項目：'||coalesce(nullif(fallback_items,''),'請至預約頁查看')
       ||E'\n個別時間：'||(fallback_minutes+store_service_minutes)::text||' 分鐘'
       ||case when store_service_minutes>0
           then '（含店內服務 '||store_service_minutes::text||' 分鐘）' else '' end
       ||E'\n個別金額：NT$'||to_char(fallback_amount,'FM999,999,999,990')
       ||E'\n預約技師：'||coalesce(nullif(b->>'fallbackTechnician',''),'現場安排');
   end if;
   notice_message:='【櫃檯確認預約】'
      ||E'\n預約日期：'||coalesce(b->>'bookingDate','')
      ||E'\n預約時間：'||coalesce(b->>'startTime','')
      ||E'\n預約人：'||coalesce(b->>'name','')
      ||E'\n電話：'||coalesce(b->>'phone','')
      ||E'\n預約人數：'||coalesce(b->>'partySize','1')||' 位'
      ||case when nullif(btrim(coalesce(b->>'note','')),'') is not null
         then E'\n會員備註：'||left(btrim(b->>'note'),500) else '' end
      ||case when nullif(btrim(coalesce(b->>'adminNote','')),'') is not null
         then E'\n管理端說明：'||left(btrim(b->>'adminNote'),500) else '' end
      ||E'\n\n'||notice_details;
   execute format('insert into %I.notice_outbox(booking_id,event_key,channel,recipient,message_text)
        select $1,$2,''admin'',a.line_user_id,$3 from %I.admins a
        where a.status=''active'' and a.role=''admin'' and a.line_user_id ~ ''^U[0-9a-f]{32}$''
        on conflict (event_key,channel,recipient) do nothing',t.runtime_schema,t.runtime_schema)
        using bid,'frontdesk.confirmed:'||rid::text,left(notice_message,8000);
 end if;
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)values(rid,p_actor,'frontdesk:booking:'||t.id,hash,v);
 return v;
end $function$;

notify pgrst,'reload schema';
