-- AC-FD-VAC-TIME-001..005. Use the original booking date/time in the
-- member-facing rejection snapshot. The frontdesk never supplies this text.
-- Previous bookings and idempotent replies keep their saved descriptions.
create or replace function platform_private.frontdesk_vacation_member_description(
  p_schema text,p_booking_id uuid,p_names text[]
) returns text language plpgsql stable set search_path='' as $vacation_description$
declare v_booking_date date;v_start_time time without time zone;v_message text;
begin
 if p_schema is null or p_schema !~ '^business_[0-9a-f]{32}$'
    or p_booking_id is null or coalesce(cardinality(p_names),0)=0
 then raise exception 'VACATION_TECHNICIANS_INVALID';end if;
 -- The wrapper already verified tenant and staff permissions. Read only this
 -- tenant's booking, by its UUID, not a caller-provided date or free text.
 execute format('select booking_date,start_time from %I.bookings where id=$1',p_schema)
  into v_booking_date,v_start_time using p_booking_id;
 if v_booking_date is null or v_start_time is null then
  raise exception 'FRONTDESK_BOOKING_NOT_FOUND';end if;
 v_message:='目前預約時間：'||to_char(v_booking_date,'YYYY/MM/DD')
  ||' '||to_char(v_start_time,'HH24:MI')||'，'
  ||array_to_string(p_names,'、')||' 技師休假。';
 -- Do not silently truncate a selected name or the reason suffix.
 if char_length(v_message)>400 then
  raise exception 'VACATION_DESCRIPTION_TOO_LONG';end if;
 return v_message;
end $vacation_description$;
revoke all on function platform_private.frontdesk_vacation_member_description(text,uuid,text[])
 from public,anon,authenticated;
grant execute on function platform_private.frontdesk_vacation_member_description(text,uuid,text[])
 to service_role;

do $update_vacation_rejection$
declare d text;begin_pos integer;end_pos integer;old_text text;old_tail text;
 replacement text;
begin
 select pg_get_functiondef(
  'public.platform_frontdesk_rejection_request(uuid,text,text,timestamptz,text,jsonb)'::regprocedure)
  into strict d;
 begin_pos:=position('v_description:=left(''目前 ' in d);
 old_tail:='||v_description,400);';
 end_pos:=position(old_tail in d);
 if begin_pos=0 or end_pos<=begin_pos then
  raise exception 'VACATION_DESCRIPTION_CONTRACT_CHANGED';end if;
 old_text:=substring(d from begin_pos for end_pos+length(old_tail)-begin_pos);
 if position('array_to_string(v_names,''、'')' in old_text)=0
  or position('技師休假' in old_text)=0 then
  raise exception 'VACATION_DESCRIPTION_CONTRACT_CHANGED';end if;
 replacement:='v_description:=platform_private.frontdesk_vacation_member_description('
  ||'t.runtime_schema,(p_body->>''bookingId'')::uuid,v_names);';
 execute substring(d from 1 for begin_pos-1)||replacement||
   substring(d from end_pos+length(old_tail));
end $update_vacation_rejection$;
notify pgrst,'reload schema';
