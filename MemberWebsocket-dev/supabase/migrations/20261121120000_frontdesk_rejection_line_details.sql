-- AC-001..004: one audited frontdesk rejection notice with optional paired
-- walk-in reservation; no second LINE message from the paired booking.
-- No changes to booking state, RPC authorization, or request idempotency.
-- Only an atomic, audited frontdesk rejection + replacement is eligible.
-- A user-editable admin_note alone can never suppress ordinary booking notices.
create or replace function platform_private.frontdesk_paired_phone_source(p_schema text,p_booking jsonb)
returns uuid language plpgsql security definer set search_path='' as $pair$
declare v_id uuid;v_source text;v_valid boolean;
begin
 if p_schema !~ '^business_[0-9a-f]{32}$' or
   not exists(select 1 from platform_private.tenants where runtime_schema=p_schema) then
   return null;
 end if;
 if p_booking->>'status' is distinct from 'pending' then return null;end if;
 v_source:=substring(coalesce(p_booking->>'admin_note','')
   from '^原預約 ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) 拒絕後的現場／電話預約$');
 if v_source is null then return null;end if;
 v_id:=v_source::uuid;
 execute format($q$
  select exists(
    select 1 from %1$I.bookings original
    where original.id=$1 and original.id<>$2
      and original.status='rejected' and original.rejection_reason='unrecorded_phone_booking'
      and original.rejected_by ~ '^U[0-9a-f]{32}$'
      and original.booking_date=$3
      and original.rejected_at is not null and original.rejected_at <= $4
      and exists(select 1 from %1$I.booking_audit_events a
        where a.target_type='booking' and a.target_id=$2::text
          and a.action='BOOKING_PHONE_CREATED' and a.actor_role='frontdesk'
          and a.actor_line_user_id=original.rejected_by)
      and exists(select 1 from %1$I.booking_audit_events a
        where a.target_type='booking' and a.target_id=original.id::text
          and a.action='BOOKING_REJECTED' and a.actor_role='frontdesk'
          and a.actor_line_user_id=original.rejected_by)
  )$q$,p_schema) into v_valid using v_id,(p_booking->>'id')::uuid,
  (p_booking->>'booking_date')::date,(p_booking->>'created_at')::timestamptz;
 return case when v_valid then v_id else null end;
end $pair$;
revoke all on function platform_private.frontdesk_paired_phone_source(text,jsonb) from public,anon,authenticated;


create or replace function platform_private.append_booking_rejection_notice()
returns trigger language plpgsql security definer set search_path='' as $rejection$
declare v_schema text:=TG_TABLE_SCHEMA;v_reason text;v_custom text;v_suffix text;v_event text;v_frontdesk boolean;v_admin_message text;v_old jsonb;v_phone_row jsonb;v_phone jsonb;v_phone_id uuid;v_old_services text;v_phone_services text;v_old_tech text;v_phone_tech text;
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
     -- Original booking details are always present; a paired phone booking is
     -- included only when its audit actor, original rejection and marker match.
     v_old:=platform_private.frontdesk_booking_json(v_schema,NEW.id);
     select coalesce(string_agg(coalesce(i->>'title','預約項目')||
       case when coalesce((i->>'quantity')::int,1)>1 then ' × '||(i->>'quantity') else '' end,'、'),'—')
       into v_old_services from jsonb_array_elements(coalesce(v_old->'services','[]'::jsonb)) i;
     select string_agg(distinct nullif(p->>'technician',''),'、') into v_old_tech
       from jsonb_array_elements(coalesce(v_old->'participants','[]'::jsonb)) p;
     v_old_tech:=coalesce(nullif(v_old_tech,''),v_old->>'fallbackTechnician','現場安排');
     execute format('select to_jsonb(b) from %I.bookings b
       where b.admin_note=$1 and b.booking_date=$2 and b.status=''pending''
       order by b.created_at desc limit 1',v_schema)
       into v_phone_row using '原預約 '||NEW.id::text||' 拒絕後的現場／電話預約',NEW.booking_date;
     if v_phone_row is not null and
       platform_private.frontdesk_paired_phone_source(v_schema,v_phone_row)=NEW.id then
       v_phone_id:=(v_phone_row->>'id')::uuid;
       v_phone:=platform_private.frontdesk_booking_json(v_schema,v_phone_id);
       select coalesce(string_agg(coalesce(i->>'title','預約項目')||
         case when coalesce((i->>'quantity')::int,1)>1 then ' × '||(i->>'quantity') else '' end,'、'),'—')
         into v_phone_services from jsonb_array_elements(coalesce(v_phone->'services','[]'::jsonb)) i;
       select string_agg(distinct nullif(p->>'technician',''),'、') into v_phone_tech
         from jsonb_array_elements(coalesce(v_phone->'participants','[]'::jsonb)) p;
       v_phone_tech:=coalesce(nullif(v_phone_tech,''),v_phone->>'fallbackTechnician','現場安排');
     end if;
     v_admin_message:='【櫃檯拒絕預約】'
       ||E'\n預約人：櫃檯人員'
       ||case when v_reason is not null then E'\n拒絕原因：'||v_reason else '' end
       ||E'\n\n【原預約資料】'
       ||E'\n預約編號：'||NEW.id::text
       ||E'\n預約日期：'||NEW.booking_date::text
       ||E'\n預約時間：'||to_char(NEW.start_time,'HH24:MI')
       ||E'\n原預約會員：'||coalesce(v_old->>'name','會員')
       ||E'\n電話：'||coalesce(nullif(v_old->>'phone',''),'未提供')
       ||E'\n預約人數：'||greatest(coalesce(NEW.party_size,1),1)::text||' 位'
       ||E'\n預約項目：'||v_old_services
       ||E'\n預約技師：'||v_old_tech
       ||case when nullif(btrim(coalesce(NEW.member_note,'')),'') is not null
         then E'\n會員備註：'||left(btrim(NEW.member_note),500) else '' end
       ||case when nullif(btrim(coalesce(NEW.admin_note,'')),'') is not null
         then E'\n管理端說明：'||left(btrim(NEW.admin_note),500) else '' end
       ||case when v_phone_id is null then '' else
           E'\n\n【櫃檯新增的預約資料】'
           ||E'\n新增預約編號：'||v_phone_id::text
           ||E'\n預約日期：'||coalesce(v_phone->>'bookingDate','—')
           ||E'\n預約時間：'||coalesce(v_phone->>'startTime','—')
           ||E'\n預約人：'||coalesce(v_phone->>'name','現場')
           ||E'\n電話：'||coalesce(nullif(v_phone->>'phone',''),'未提供')
           ||E'\n預約人數：'||coalesce(v_phone->>'partySize','1')||' 位'
           ||E'\n預約項目：'||v_phone_services
           ||E'\n預約技師：'||v_phone_tech
           ||E'\n預約狀態：待管理員確認'
           end;
     execute format('insert into %I.notice_outbox(booking_id,event_key,channel,recipient,message_text)
       select $1,$2,''admin'',a.line_user_id,$3 from %I.admins a
       where a.status=''active'' and a.role=''admin'' and a.line_user_id ~ ''^U[0-9a-f]{32}
 end if;
 return null;
end $rejection$;
'
       on conflict(event_key,channel,recipient) do nothing',v_schema,v_schema)
       using NEW.id,'frontdesk.rejected:'||NEW.id::text||':'||NEW.updated_at::text,left(v_admin_message,8000);
   end if;
 end if;
 return null;
end $rejection$;

revoke all on function platform_private.append_booking_rejection_notice() from public,anon,authenticated;

-- Do not queue a second admin/frontdesk notice for the replacement insert.
-- The original rejection trigger above creates the single combined admin alert.
create or replace function platform_private.install_frontdesk_paired_notice(p_schema text)
returns void language plpgsql security definer set search_path='' as $install$
declare d text;
 v_old constant text:=$old$begin
  if TG_OP = 'INSERT' then$old$;
 v_new constant text:=$new$begin
  if TG_OP = 'INSERT' and
     platform_private.frontdesk_paired_phone_source(TG_TABLE_SCHEMA,to_jsonb(NEW)) is not null
    then return null;end if;
  if TG_OP = 'INSERT' then$new$;
begin
 if p_schema !~ '^business_[0-9a-f]{32}$' or
    not exists(select 1 from platform_private.tenants where runtime_schema=p_schema) then
   raise exception 'BUSINESS_SCHEMA_INVALID';end if;
 select pg_get_functiondef(to_regprocedure(format('%I.notice_enqueue()',p_schema))) into strict d;
 if position('frontdesk_paired_phone_source(TG_TABLE_SCHEMA' in d)>0 then return;end if;
 if (length(d)-length(replace(d,v_old,'')))/length(v_old)<>1
   then raise exception 'BOOKING_NOTICE_ENQUEUE_CONTRACT_CHANGED';end if;
 execute replace(d,v_old,v_new);
end $install$;
revoke all on function platform_private.install_frontdesk_paired_notice(text) from public,anon,authenticated;

do $upgrade$
declare d text;v_schema text;
 v_anchor constant text:=$anchor$ execute format('create constraint trigger bookings_zz_append_rejection_notice after update on %I.bookings deferrable initially deferred for each row execute function platform_private.append_booking_rejection_notice()',p_schema);$anchor$;
 v_new constant text:=$call$ perform platform_private.install_frontdesk_paired_notice(p_schema);$call$;
begin
 -- Ensure newly provisioned tenant schemas inherit this delivery contract.
 select pg_get_functiondef('platform_private.install_booking_rejection(text)'::regprocedure) into strict d;
 if position(v_new in d)=0 then
   if (length(d)-length(replace(d,v_anchor,'')))/length(v_anchor)<>1
     then raise exception 'BOOKING_REJECTION_INSTALLER_CONTRACT_CHANGED';end if;
   execute replace(d,v_anchor,v_anchor||E'\n'||v_new);
 end if;
 for v_schema in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
   perform platform_private.install_frontdesk_paired_notice(v_schema);
 end loop;
end $upgrade$;

-- Existing outbox rows already sent are deliberately not edited or recalled.
notify pgrst,'reload schema';
