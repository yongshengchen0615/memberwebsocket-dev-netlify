-- AC-FD-RT-001: private booking revision for approved frontdesk reviewers.
-- AC-FD-NOTIFY-001: transactionally queue an admin LINE message on desk confirmation.
-- No new public grants, subscriptions, or anonymous access.
CREATE OR REPLACE FUNCTION public.platform_frontdesk_request(p_tenant_id uuid, p_actor text, p_channel_id text, p_issued_at timestamp with time zone, p_action text, p_body jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare t platform_private.tenants;s platform_private.frontdesk_staff;cfg jsonb;v jsonb;b jsonb;bid uuid;rid uuid;hash text;r platform_private.requests;notice_details text;notice_message text;
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
 if p_action='bookings' then
  bid:=nullif(p_body->>'bookingId','')::uuid;
  execute format('select coalesce(jsonb_agg(platform_private.frontdesk_booking_json($1,x.id) order by x.start_at),''[]'') from (select id,start_at from %I.bookings where ($2::uuid is null and status=''pending'') or id=$2 order by start_at,id limit 50) x',t.runtime_schema) into v using t.runtime_schema,bid;
  return jsonb_build_object('bookings',v);
 end if;
 if p_action is distinct from 'booking.update' or coalesce(p_body->>'status','') not in ('confirmed','rejected') then raise exception 'PLATFORM_INVALID_INPUT';end if;
 bid:=(p_body->>'bookingId')::uuid;rid:=(p_body->>'requestId')::uuid;
 if bid is null or rid is null or nullif(p_body->>'expectedUpdatedAt','') is null then raise exception 'PLATFORM_INVALID_INPUT';end if;
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
 execute format('update %I.bookings set status=$2,admin_note=coalesce($3,admin_note),%I=$4,%I=clock_timestamp() where id=$1',t.runtime_schema,case when p_body->>'status'='confirmed' then 'confirmed_by' else 'rejected_by' end,case when p_body->>'status'='confirmed' then 'confirmed_at' else 'rejected_at' end) using bid,p_body->>'status',left(p_body->>'note',500),p_actor;
 execute format('insert into %I.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata) values($1,''frontdesk'',$2,''booking'',$3,''success'',$4)',t.runtime_schema) using p_actor,'BOOKING_'||upper(p_body->>'status'),bid::text,jsonb_build_object('previousStatus','pending');
 v:=jsonb_build_object('booking',platform_private.frontdesk_booking_json(t.runtime_schema,bid),'alreadyApplied',false);

 -- Frontdesk-only admin notification; member confirmation stays in the existing trigger.
 if p_body->>'status'='confirmed' then
   b:=v->'booking';
   select string_agg(
      (case p.idx when 1 then '第一' when 2 then '第二' when 3 then '第三'
        when 4 then '第四' when 5 then '第五' when 6 then '第六'
        when 7 then '第七' when 8 then '第八' when 9 then '第九'
        when 10 then '第十' else '第 '||p.idx::text||' ' end)||'位預約'
      ||E'\n預約項目：'||coalesce((
         select string_agg(coalesce(nullif(i.value->>'title',''),'未命名項目')
          ||case when coalesce((i.value->>'quantity')::integer,1)>1
              then ' × '||(i.value->>'quantity') else '' end,'、')
         from jsonb_array_elements(coalesce(p.value->'services','[]'::jsonb)) i
       ),'請至預約頁查看')
      ||E'\n預約技師：'||coalesce(nullif(p.value->>'technician',''),'現場安排')
      ||case when nullif(btrim(coalesce(p.value->>'note','')),'') is not null
         then E'\n個別備註：'||left(btrim(p.value->>'note'),500) else '' end,
      E'\n\n' order by p.idx)
    into notice_details
    from jsonb_array_elements(coalesce(b->'participants','[]'::jsonb)) with ordinality p(value,idx);
   if notice_details is null then
     notice_details:='第一位預約'
       ||E'\n預約項目：'||coalesce((
          select string_agg(coalesce(nullif(i.value->>'title',''),'未命名項目'),'、')
          from jsonb_array_elements(coalesce(b->'services','[]'::jsonb)) i
         ),'請至預約頁查看')
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

notify pgrst, 'reload schema';
