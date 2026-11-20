-- AC-FR-004/005: frontdesk denial creates an idempotent admin alert.
-- Keep the member rejected notice in its existing durable outbox.
create or replace function platform_private.append_booking_rejection_notice()
returns trigger language plpgsql security definer set search_path='' as $rejection$
declare v_schema text:=TG_TABLE_SCHEMA;v_reason text;v_custom text;v_suffix text;v_event text;v_frontdesk boolean;v_admin_message text;
begin
 if TG_OP<>'UPDATE' or NEW.status<>'rejected' or OLD.status is not distinct from NEW.status then return null;end if;
 if v_schema<>'public' and
    (v_schema !~ '^business_[0-9a-f]{32}$' or
     not exists(select 1 from platform_private.tenants where runtime_schema=v_schema)) then
   raise exception 'BOOKING_REJECTION_SCHEMA_INVALID';end if;
 v_reason:=case NEW.rejection_reason
   when 'technician_leave' then '預約中有休假技師'
   when 'unrecorded_phone_booking' then '該時段已被現場人員預約但未登記'
   else null end;
 execute format('select rejection_message from %I.booking_settings where id=1',v_schema) into v_custom;
 v_custom:=replace(replace(btrim(coalesce(v_custom,'')),E'\r\n',E'\n'),E'\r',E'\n');
 v_suffix:=case when v_reason is not null then E'\n拒絕原因：'||v_reason else '' end
   ||case when v_custom<>'' then E'\n'||v_custom else '' end;
 v_event:=NEW.id::text||':rejected:'||NEW.updated_at::text;
 if v_schema='public' then
   update booking_notifications.outbox o set message_text=left(o.message_text||v_suffix,8000)
   where o.booking_id=NEW.id and o.event_key=v_event and o.channel='member' and o.status='pending';
 else
   execute format('update %I.notice_outbox set message_text=left(message_text||$1,8000)
      where booking_id=$2 and event_key=$3 and channel=''member'' and status=''pending''',v_schema)
     using v_suffix,NEW.id,v_event;
   -- This audit is recorded within platform_frontdesk_request before commit.
   -- Admin-origin rejections do not match and never emit a "frontdesk" alert.
   execute format('select exists(select 1 from %I.booking_audit_events
     where actor_role=''frontdesk'' and action=''BOOKING_REJECTED''
       and target_type=''booking'' and target_id=$1
       and actor_line_user_id=$2 and created_at >= $3)',v_schema)
     into v_frontdesk using NEW.id::text,NEW.rejected_by,NEW.updated_at;
   if v_frontdesk then
     v_admin_message:='【櫃檯拒絕預約】'
       ||E'\n預約日期：'||NEW.booking_date::text
       ||E'\n預約時間：'||to_char(NEW.start_time,'HH24:MI')
       ||E'\n預約人：'||coalesce(NEW.contact_surname,'')||
          case coalesce(NEW.contact_salutation,'') when 'mr' then '先生' when 'ms' then '小姐' else '' end
       ||E'\n電話：'||coalesce(NEW.contact_phone,'未提供')
       ||E'\n預約人數：'||greatest(coalesce(NEW.party_size,1),1)::text||' 位'
       ||case when v_reason is not null then E'\n拒絕原因：'||v_reason else '' end
       ||case when nullif(btrim(coalesce(NEW.admin_note,'')),'') is not null then
          E'\n管理端說明：'||left(btrim(NEW.admin_note),500) else '' end;
     execute format('insert into %I.notice_outbox(booking_id,event_key,channel,recipient,message_text)
       select $1,$2,''admin'',a.line_user_id,$3 from %I.admins a
       where a.status=''active'' and a.role=''admin'' and a.line_user_id ~ ''^U[0-9a-f]{32}$''
       on conflict(event_key,channel,recipient) do nothing',v_schema,v_schema)
       using NEW.id,'frontdesk.rejected:'||NEW.id::text||':'||NEW.updated_at::text,left(v_admin_message,8000);
   end if;
 end if;
 return null;
end $rejection$;
revoke all on function platform_private.append_booking_rejection_notice() from public,anon,authenticated;

-- Retain original RPC auth, status guards, CAS and idempotent requests.
-- Patch its body only when the expected base contract is exact.
do $frontdesk_patch$
declare d text;old_text text;new_text text;
begin
 select pg_get_functiondef('public.platform_frontdesk_request(uuid,text,text,timestamp with time zone,text,jsonb)'::regprocedure) into strict d;
 old_text:=$old$ hash:=encode(sha256(convert_to((p_body-'requestId')::text,'UTF8')),'hex');$old$;
 new_text:=$new$ if p_body->>'status'='rejected' then
   if p_body->>'rejectionReason' is null or p_body->>'rejectionReason' not in ('technician_leave','unrecorded_phone_booking') then
     raise exception 'BOOKING_REJECTION_REASON_REQUIRED';end if;
 elsif p_body ? 'rejectionReason' then raise exception 'BOOKING_REJECTION_REASON_REQUIRED';end if;
 hash:=encode(sha256(convert_to((p_body-'requestId')::text,'UTF8')),'hex');$new$;
 if length(d)-length(replace(d,old_text,''))<>length(old_text) then raise exception 'FRONTDESK_RPC_HASH_CONTRACT_CHANGED';end if;
 d:=replace(d,old_text,new_text);
 old_text:=$old$status=$2,admin_note=coalesce($3,admin_note),%I=$4,%I=clock_timestamp()$old$;
 new_text:=$new$status=$2,admin_note=coalesce($3,admin_note),rejection_reason=$5,%I=$4,%I=clock_timestamp()$new$;
 if length(d)-length(replace(d,old_text,''))<>length(old_text) then raise exception 'FRONTDESK_RPC_UPDATE_CONTRACT_CHANGED';end if;
 d:=replace(d,old_text,new_text);
 old_text:=$old$using bid,p_body->>'status',left(p_body->>'note',500),p_actor;$old$;
 new_text:=$new$using bid,p_body->>'status',left(p_body->>'note',500),p_actor,p_body->>'rejectionReason';$new$;
 if length(d)-length(replace(d,old_text,''))<>length(old_text) then raise exception 'FRONTDESK_RPC_USING_CONTRACT_CHANGED';end if;
 d:=replace(d,old_text,new_text);
 old_text:=$old$jsonb_build_object('previousStatus','pending');$old$;
 new_text:=$new$jsonb_build_object('previousStatus','pending','rejectionReason',p_body->>'rejectionReason');$new$;
 if length(d)-length(replace(d,old_text,''))<>length(old_text) then raise exception 'FRONTDESK_RPC_AUDIT_CONTRACT_CHANGED';end if;
 execute replace(d,old_text,new_text);
end $frontdesk_patch$;
notify pgrst,'reload schema';
