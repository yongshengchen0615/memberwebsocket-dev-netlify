-- AC-FD-VAC-BOOKED-001..006: only the technicians actually assigned to
-- this particular booking, excluding the configured primary technician.
-- Referencing a booking does NOT imply access: callers are separately gated
-- by existing frontdesk permissions and an expected booking version check.
create or replace function platform_private.frontdesk_booked_vacation_candidates(
 p_schema text,p_booking_id uuid
) returns jsonb language plpgsql stable set search_path='' as $candidates$
declare v_result jsonb;
begin
 if p_schema is null or p_schema !~ '^business_[0-9a-f]{32}$'
  or p_booking_id is null then
  raise exception 'FRONTDESK_REJECTION_INVALID_SCHEMA';end if;
 execute format($query$
  with assigned as (
   select bp.technician_id,bp.position::integer as ord
    from %1$I.booking_participants bp
    where bp.booking_id=$1 and bp.technician_id is not null
   union all
   select b.technician_id,1 from %1$I.bookings b
    where b.id=$1 and b.technician_id is not null
      and not exists(select 1 from %1$I.booking_participants bp
       where bp.booking_id=b.id)
  ),dedup as (
   select technician_id,min(ord) as ord from assigned group by technician_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',bt.id,
    'name',left(btrim(bt.name),80)) order by x.ord,bt.name,bt.id),'[]'::jsonb)
  from dedup x join %1$I.booking_technicians bt on bt.id=x.technician_id
    cross join %1$I.booking_settings bs
  where bs.id=1 and bt.id is distinct from bs.primary_technician_id
 $query$,p_schema) into v_result using p_booking_id;
 return coalesce(v_result,'[]'::jsonb);
end $candidates$;
revoke all on function platform_private.frontdesk_booked_vacation_candidates(text,uuid)
 from public,anon,authenticated;
grant execute on function platform_private.frontdesk_booked_vacation_candidates(text,uuid)
 to service_role;

create or replace function platform_private.frontdesk_booked_vacation_names(
 p_schema text,p_booking_id uuid,p_ids jsonb
) returns text[] language plpgsql stable set search_path='' as $names$
declare v_selected jsonb;v_names text[];
begin
 v_selected:=platform_private.frontdesk_booked_vacation_candidates(p_schema,p_booking_id);
 select coalesce(array_agg(c.item->>'name' order by s.ordinality),array[]::text[])
   into v_names
 from jsonb_array_elements_text(p_ids) with ordinality s(id,ordinality)
 join jsonb_array_elements(v_selected) c(item) on c.item->>'id'=s.id;
 return v_names;
end $names$;
revoke all on function platform_private.frontdesk_booked_vacation_names(text,uuid,jsonb)
 from public,anon,authenticated;
grant execute on function platform_private.frontdesk_booked_vacation_names(text,uuid,jsonb)
 to service_role;

-- Enrich only the already authorized booking JSON, rather than returning the
-- complete shop technician roster. Used in staff bookings and authenticated
-- review-history responses, with no public bootstrap exposure.
do $enrich_booking_json$
declare d text;needle text;replacement text;
begin
 select pg_get_functiondef('platform_private.frontdesk_booking_json(text,uuid)'::regprocedure) into strict d;
 needle:='''fallbackTechnician'',coalesce(nullif(fbt.name,''''),''現場安排'')';
 replacement:='''vacationTechnicians'',platform_private.frontdesk_booked_vacation_candidates(p_schema,b.id),'
    ||E'\n   '||needle;
 if length(d)-length(replace(d,needle,''))<>length(needle)
 then raise exception 'BOOKED_VACATION_BOOKING_JSON_CONTRACT_CHANGED';end if;
 execute replace(d,needle,replacement);
end $enrich_booking_json$;

-- Protect the immutable rejection description in the same locked server write
-- transaction. A disabled or renamed employee already assigned to the order
-- remains eligible; a random tenant employee or the store primary does not.
do $enforce_selected_booking_technicians$
declare d text;needle text;replacement text;
begin
 select pg_get_functiondef('public.platform_frontdesk_rejection_request(uuid,text,text,timestamptz,text,jsonb)'::regprocedure) into strict d;
 needle:='platform_private.frontdesk_vacation_names(t.runtime_schema,p_body->''vacationTechnicianIds'')';
 replacement:='platform_private.frontdesk_booked_vacation_names(t.runtime_schema,(p_body->>''bookingId'')::uuid,p_body->''vacationTechnicianIds'')';
 if length(d)-length(replace(d,needle,''))<>length(needle)
 then raise exception 'BOOKED_VACATION_REJECTION_POLICY_CONTRACT_CHANGED';end if;
 execute replace(d,needle,replacement);
end $enforce_selected_booking_technicians$;
notify pgrst,'reload schema';
