-- AC-FR-001..006: reason codes + tenant-specific rejection LINE notice.
-- Additive: existing bookings and member authentication unchanged.
alter table public.booking_settings add column if not exists rejection_message text not null
 default '很抱歉，本次預約未通過。請依拒絕原因調整預約時間或洽詢店家。';
alter table public.bookings add column if not exists rejection_reason text;
alter table public.booking_settings drop constraint if exists booking_rejection_message_length_check;
alter table public.booking_settings add constraint booking_rejection_message_length_check
 check(char_length(btrim(rejection_message)) between 1 and 400);
alter table public.bookings drop constraint if exists booking_rejection_reason_choice_check;
alter table public.bookings add constraint booking_rejection_reason_choice_check
 check(rejection_reason is null or rejection_reason in('technician_leave','unrecorded_phone_booking'));

-- Deferred to run after the pre-existing deferred bookings_enqueue_line_notification.
-- Append to the original member "rejected" notification, never send a second LINE message.
create or replace function platform_private.append_booking_rejection_notice()
returns trigger language plpgsql security definer set search_path='' as $rejection$
declare v_schema text:=TG_TABLE_SCHEMA;v_reason text;v_custom text;v_suffix text;v_event text;
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
 if v_suffix='' then return null;end if;
 v_event:=NEW.id::text||':rejected:'||NEW.updated_at::text;
 if v_schema='public' then
   update booking_notifications.outbox o set message_text=left(o.message_text||v_suffix,8000)
   where o.booking_id=NEW.id and o.event_key=v_event and o.channel='member' and o.status='pending';
 else
   execute format('update %I.notice_outbox set message_text=left(message_text||$1,8000)
      where booking_id=$2 and event_key=$3 and channel=''member'' and status=''pending''',v_schema)
   using v_suffix,NEW.id,v_event;
 end if;
 return null;
end $rejection$;
revoke all on function platform_private.append_booking_rejection_notice() from public,anon,authenticated;
drop trigger if exists bookings_zz_append_rejection_notice on public.bookings;
create constraint trigger bookings_zz_append_rejection_notice
 after update on public.bookings deferrable initially deferred
 for each row execute function platform_private.append_booking_rejection_notice();

create or replace function platform_private.install_booking_rejection(p_schema text)
returns void language plpgsql security definer set search_path='' as $install$
begin
 if p_schema !~ '^business_[0-9a-f]{32}$' or
     not exists(select 1 from platform_private.tenants where runtime_schema=p_schema) then
   raise exception 'BUSINESS_SCHEMA_INVALID';end if;
 execute format('alter table %I.booking_settings add column if not exists rejection_message text not null default %L',
   p_schema,'很抱歉，本次預約未通過。請依拒絕原因調整預約時間或洽詢店家。');
 execute format('alter table %I.bookings add column if not exists rejection_reason text',p_schema);
 if not exists(select 1 from pg_catalog.pg_constraint where conrelid=to_regclass(format('%I.booking_settings',p_schema))
   and conname='booking_rejection_message_length_check') then
   execute format('alter table %I.booking_settings add constraint booking_rejection_message_length_check check(char_length(btrim(rejection_message)) between 1 and 400)',p_schema);
 end if;
 if not exists(select 1 from pg_catalog.pg_constraint where conrelid=to_regclass(format('%I.bookings',p_schema))
   and conname='booking_rejection_reason_choice_check') then
   execute format('alter table %I.bookings add constraint booking_rejection_reason_choice_check check(rejection_reason is null or rejection_reason in (''technician_leave'',''unrecorded_phone_booking''))',p_schema);
 end if;
 execute format('drop trigger if exists bookings_zz_append_rejection_notice on %I.bookings',p_schema);
 execute format('create constraint trigger bookings_zz_append_rejection_notice after update on %I.bookings deferrable initially deferred for each row execute function platform_private.append_booking_rejection_notice()',p_schema);
end $install$;
revoke all on function platform_private.install_booking_rejection(text) from public,anon,authenticated;
grant execute on function platform_private.install_booking_rejection(text) to service_role;

-- Every newly provisioned tenant also gets the columns and deferred trigger.
do $upgrade$
declare v_schema text;v_definition text;
 v_anchor constant text:='  perform platform_private.install_booking_pending_notice(p_schema);';
 v_call constant text:='  perform platform_private.install_booking_rejection(p_schema);';
begin
 select pg_get_functiondef('platform_private.install_booking_reminder(text)'::regprocedure) into strict v_definition;
 if position(v_call in v_definition)=0 then
   if (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 then
     raise exception 'BOOKING_INSTALLER_CONTRACT_CHANGED';end if;
   execute replace(v_definition,v_anchor,v_anchor||E'\n'||v_call);
 end if;
 for v_schema in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
   perform platform_private.install_booking_rejection(v_schema);
 end loop;
end $upgrade$;
notify pgrst,'reload schema';
