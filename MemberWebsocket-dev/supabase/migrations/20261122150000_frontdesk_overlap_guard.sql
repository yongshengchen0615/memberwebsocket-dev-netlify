-- AC-FD-OVERLAP-001..004: the paired walk-in rejection reason requires a real time overlap.
-- No tables/data are modified; the existing atomic review/create and replay paths remain.
-- The half-open rule rejects boundary-only contact (A ends precisely as B starts).
-- Insert after verified replay handling and before creating the replacement. If rejected,
-- PL/pgSQL raises and the entire update/audit/outbox transaction rolls back.

do $patch$
declare
 d text;
 v_anchor constant text:=$anchor$   b:=platform_private.frontdesk_create_duration_booking($anchor$;
 v_declaration_anchor constant text:='notice_details text;';
 v_declaration_replacement constant text:='notice_details text;v_conflict_overlap boolean;';
 v_guard constant text:=$guard$
   -- Compare actual tenant business-day timestamps. A cross-midnight shop's
   -- 00:10 time belongs to the following calendar day, not the raw booking_date.
   if b->>'booking_date' is null or b->>'start_at' is null
      or coalesce((b->>'total_duration_minutes')::integer,0)<=0
   then raise exception 'FRONTDESK_NOT_OVERLAPPING';end if;
   execute format($overlap$
     select (
       %1$I.booking_slot_start_at($1,$2,s.work_start_time,s.work_end_time)
         < $3::timestamp + make_interval(mins=>$4::integer)
       and
       %1$I.booking_slot_start_at($1,$2,s.work_start_time,s.work_end_time)
         + make_interval(mins=>$5::integer) > $3::timestamp
     ) from %1$I.booking_settings s where s.id=1
   $overlap$,t.runtime_schema)
   into v_conflict_overlap
   using (b->>'booking_date')::date,(p_body->>'startTime')::time,
     (b->>'start_at')::timestamp,(b->>'total_duration_minutes')::integer,
     (p_body->>'totalDurationMinutes')::integer;
   if v_conflict_overlap is distinct from true then
     raise exception 'FRONTDESK_NOT_OVERLAPPING';end if;
$guard$;
begin
 select pg_get_functiondef('public.platform_frontdesk_request(uuid,text,text,timestamp with time zone,text,jsonb)'::regprocedure)
  into strict d;
 if position('FRONTDESK_NOT_OVERLAPPING' in d)>0 then return;end if;
 if (length(d)-length(replace(d,v_anchor,'')))/length(v_anchor)<>1
   or (length(d)-length(replace(d,v_declaration_anchor,'')))/length(v_declaration_anchor)<>1
 then raise exception 'FRONTDESK_OVERLAP_ROUTER_CONTRACT_CHANGED';end if;
 d:=replace(d,v_declaration_anchor,v_declaration_replacement);
 execute replace(d,v_anchor,v_guard||v_anchor);
end $patch$;
notify pgrst,'reload schema';
