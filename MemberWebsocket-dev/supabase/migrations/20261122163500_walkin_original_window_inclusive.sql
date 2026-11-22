-- AC-WALKIN-WINDOW-001..006
-- Merchant-defined conflict bounds are retired. Only 10-minute clock/duration
-- granularity, 10..1430-minute duration, booking-hours and scoped authorization
-- remain. A candidate START must be within [original start, original end].
-- The closing boundary is intentionally inclusive (adjacent counts as conflict).
-- Existing tenant JSON configuration stays intact for reversible compatibility.
-- pg_get_functiondef contract checks fail closed if another migration changed
-- any of the patched functions; CREATE OR REPLACE preserves signature/grants.

do $migration$
declare
 d text;
 sig regprocedure;
 v_old_bounds constant text:=$oldbounds$
  or v_clock<coalesce((v_policy->>'conflictStartMin')::integer,0)
  or v_clock>coalesce((v_policy->>'conflictStartMax')::integer,1430)
  or p_duration<coalesce((v_policy->>'conflictDurationMin')::integer,10)
  or p_duration>coalesce((v_policy->>'conflictDurationMax')::integer,1430)$oldbounds$;
 v_new_bounds constant text:=$newbounds$
  or p_duration<10 or p_duration>1430$newbounds$;
 v_old_admin_bounds constant text:=$oldadmin$
  or v_clock<coalesce((v_policy->>'conflictStartMin')::integer,0)
  or v_clock>coalesce((v_policy->>'conflictStartMax')::integer,1430)
  or v_duration<coalesce((v_policy->>'conflictDurationMin')::integer,10)
  or v_duration>coalesce((v_policy->>'conflictDurationMax')::integer,1430)$oldadmin$;
 v_old_overlap constant text:=$oldoverlap$
   or v_candidate >= (original->>'start_at')::timestamp
       + make_interval(mins=>(original->>'total_duration_minutes')::integer)
   or v_candidate + make_interval(mins=>v_duration)
       <= (original->>'start_at')::timestamp$oldoverlap$;
 v_new_overlap constant text:=$newoverlap$
   or v_candidate > (original->>'start_at')::timestamp
       + make_interval(mins=>(original->>'total_duration_minutes')::integer)
   or v_candidate < (original->>'start_at')::timestamp$newoverlap$;
 v_begin integer;
 v_end integer;
begin
 -- The tenant-scoped writer's real 10-minute check remains. The prior
 -- arbitrary merchant bounds must not override the original booking window.
 foreach sig in array array[
   'platform_private.frontdesk_create_duration_booking(text,text,text,date,time without time zone,integer,text)'::regprocedure,
   'platform_private.admin_create_duration_booking(text,text,text,date,time without time zone,integer,text,timestamp with time zone)'::regprocedure
 ] loop
  d:=pg_get_functiondef(sig);
  if strpos(d,v_old_bounds)=0 or strpos(d,'v_clock%10<>0')=0
     or strpos(d,'booking_slot_fits')=0
     or (length(d)-length(replace(d,
       '(v_settings->>''slot_interval_minutes'')::integer',
       '')))/length('(v_settings->>''slot_interval_minutes'')::integer')<>1
  then raise exception 'WALKIN_DURATION_CONTRACT_CHANGED: %',sig;end if;
  d:=replace(d,v_old_bounds,v_new_bounds);
  -- The normal booking calendar can be configured at 30-minute intervals.
  -- Paired walk-in registration is explicitly 10-minute clock-granular.
  -- Using the minimum supported schedule step (5) in booking_slot_fits
  -- preserves work-hour boundaries, including non-zero minute openings;
  -- the independent v_clock%10 and p_duration%10 checks stay authoritative.
  d:=replace(d,'(v_settings->>''slot_interval_minutes'')::integer','5');
  execute d;
 end loop;

 -- The frontdesk atomic paired rejection validates the candidate timestamp
 -- against the booking business day and uses inclusive boundary comparisons.
 select pg_get_functiondef(
   'public.platform_frontdesk_request(uuid,text,text,timestamp with time zone,text,jsonb)'::regprocedure
 ) into d;
 if strpos(d,' < $3::timestamp + make_interval(mins=>$4::integer)')=0
    or strpos(d,' + make_interval(mins=>$5::integer) > $3::timestamp')=0
    or strpos(d,'FRONTDESK_NOT_OVERLAPPING')=0
 then raise exception 'WALKIN_FRONTDESK_ROUTER_CONTRACT_CHANGED';end if;
 d:=replace(d,' < $3::timestamp + make_interval(mins=>$4::integer)',
              ' <= $3::timestamp + make_interval(mins=>$4::integer)');
 d:=replace(d,' + make_interval(mins=>$5::integer) > $3::timestamp',
              ' >= $3::timestamp');
 execute d;

 -- The manager's transaction needs the same inclusive original window.
 select pg_get_functiondef(
   'public.platform_admin_reject_walkin(uuid,text,timestamp with time zone,jsonb)'::regprocedure
 ) into d;
 if strpos(d,v_old_admin_bounds)=0 or strpos(d,v_old_overlap)=0
 then raise exception 'WALKIN_ADMIN_ROUTER_CONTRACT_CHANGED';end if;
 d:=replace(d,v_old_admin_bounds,'');
 d:=replace(d,v_old_overlap,v_new_overlap);
 execute d;

 -- Settings now accept only pageTitle. Do not delete historical stored bounds,
 -- which would mutate tenant data unnecessarily; all runtime writers ignore them.
 select pg_get_functiondef(
   'public.platform_frontdesk_admin(text,uuid,timestamp with time zone,text,jsonb)'::regprocedure
 ) into d;
 v_begin:=strpos(d,'  pref:=p_body->''preferences'';');
 if v_begin=0 then raise exception 'WALKIN_PREFERENCES_CONTRACT_CHANGED';end if;
 v_end:=strpos(substring(d from v_begin),'  update platform_private.tenants');
 if v_end=0 or strpos(substring(d from v_begin for v_end),'conflictStartMin')=0
 then raise exception 'WALKIN_PREFERENCES_CONTRACT_CHANGED';end if;
 v_end:=v_begin+v_end-1;
 d:=left(d,v_begin-1)||$page_title_only$
  pref:=p_body->'preferences';
  if jsonb_typeof(pref) is distinct from 'object'
     or jsonb_typeof(pref->'pageTitle') is distinct from 'string'
     or length(pref->>'pageTitle')>60
     or (pref->>'pageTitle') ~ '[[:cntrl:]]'
  then raise exception 'PLATFORM_INVALID_INPUT';end if;
  pref:=jsonb_build_object('pageTitle',btrim(pref->>'pageTitle'));
$page_title_only$||substr(d,v_end);
 execute d;
end $migration$;

notify pgrst,'reload schema';
