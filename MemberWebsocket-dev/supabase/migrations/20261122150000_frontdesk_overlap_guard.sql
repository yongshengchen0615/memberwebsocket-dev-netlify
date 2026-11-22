-- AC-FD-OVERLAP-001..004: the paired walk-in rejection reason requires a real time overlap.
-- No tables/data are modified; the existing atomic review/create and replay paths remain.
-- The half-open rule rejects boundary-only contact (A ends precisely as B starts).
-- Insert after verified replay handling and before creating the replacement. If rejected,
-- PL/pgSQL raises and the entire update/audit/outbox transaction rolls back.

do $patch$
declare
 d text;
 v_anchor constant text:=$anchor$   b:=platform_private.frontdesk_create_duration_booking($anchor$;
 v_guard constant text:=$guard$
   -- A conflicting on-site interval must intersect the original booking's
   -- persisted start/duration, not merely fit within merchant dropdown limits.
   if b->>'booking_date' is null or b->>'start_time' is null
      or coalesce((b->>'total_duration_minutes')::integer,0)<=0
      or not (
        ((b->>'booking_date')::date + (p_body->>'startTime')::time)
          < ((b->>'booking_date')::date + (b->>'start_time')::time
             + make_interval(mins=>(b->>'total_duration_minutes')::integer))
        and ((b->>'booking_date')::date + (p_body->>'startTime')::time
             + make_interval(mins=>(p_body->>'totalDurationMinutes')::integer))
          > ((b->>'booking_date')::date + (b->>'start_time')::time)
      )
   then raise exception 'FRONTDESK_NOT_OVERLAPPING';end if;
$guard$;
begin
 select pg_get_functiondef('public.platform_frontdesk_request(uuid,text,text,timestamp with time zone,text,jsonb)'::regprocedure)
  into strict d;
 if position('FRONTDESK_NOT_OVERLAPPING' in d)>0 then return;end if;
 if (length(d)-length(replace(d,v_anchor,'')))/length(v_anchor)<>1 then
  raise exception 'FRONTDESK_OVERLAP_ROUTER_CONTRACT_CHANGED';
 end if;
 execute replace(d,v_anchor,v_guard||v_anchor);
end $patch$;
notify pgrst,'reload schema';
