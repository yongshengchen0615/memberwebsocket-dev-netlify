-- Normal ticket redemption requires a confirmed matching booking only if the
-- member-held ticket has selected required service items.
-- Snapshot receipt SQL and policies remain unchanged.
begin;
do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef('public.member_ticket_booking_options(uuid)'::regprocedure)
    into v_definition;
  v_old := E'if (select ticket_booking_required from public.booking_settings where id=1) is false\n and exists(select 1 from public.members where id=p_member_id and status=''active'' and membership_status=''active'') then';
  v_new := 'if exists(select 1 from public.members where id=p_member_id and status=''active'' and membership_status=''active'') then';
  if (length(v_definition)-length(replace(v_definition,v_old,''))) <> length(v_old) then
    raise exception 'TICKET_SERVICE_OPTIONS_GLOBAL_GATE_CHANGED';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  v_old := 'if not exists(select 1 from public.booking_benefit_selections s where s.member_id=p_member_id and s.benefit_kind=t.kind and s.benefit_ref=t.ref and s.status=''pending'') then';
  v_new := 'if not public.ticket_has_service_requirement(p_member_id,t.kind,t.ref) and not exists(select 1 from public.booking_benefit_selections s where s.member_id=p_member_id and s.benefit_kind=t.kind and s.benefit_ref=t.ref and s.status=''pending'') then';
  if (length(v_definition)-length(replace(v_definition,v_old,''))) <> length(v_old) then
    raise exception 'TICKET_SERVICE_OPTIONS_RULE_CHANGED';
  end if;
  execute replace(v_definition,v_old,v_new);

  select pg_get_functiondef('public.redeem_member_tickets_for_booking_request(text,uuid,text,text[],text,jsonb)'::regprocedure)
    into v_definition;
  v_old := 'if p_booking_id is null and (select ticket_booking_required from public.booking_settings where id=1) then raise exception ''BOOKING_TICKET_CONFIRMATION_REQUIRED''; end if;';
  if (length(v_definition)-length(replace(v_definition,v_old,''))) <> 2*length(v_old) then
    raise exception 'TICKET_SERVICE_REDEEM_GLOBAL_GATES_CHANGED';
  end if;
  v_definition:=replace(v_definition,v_old,'');
  v_old:=E'foreach v_ref in array v_refs loop\n    if (p_booking_id is not null and not public.booking_ticket_matches_services(p_booking_id,v_member.id,p_kind,v_ref))';
  v_new:=E'foreach v_ref in array v_refs loop\n    if (p_booking_id is null and public.ticket_has_service_requirement(v_member.id,p_kind,v_ref))\n      then raise exception ''BOOKING_TICKET_CONFIRMATION_REQUIRED''; end if;\n    if (p_booking_id is not null and not public.booking_ticket_matches_services(p_booking_id,v_member.id,p_kind,v_ref))';
  if (length(v_definition)-length(replace(v_definition,v_old,''))) <> length(v_old) then
    raise exception 'TICKET_SERVICE_REDEEM_MATCH_GUARD_CHANGED';
  end if;
  execute replace(v_definition,v_old,v_new);
end;
$patch$;
revoke all on function public.member_ticket_booking_options(uuid) from public,anon,authenticated;
revoke all on function public.redeem_member_tickets_for_booking_request(text,uuid,text,text[],text,jsonb) from public,anon,authenticated;
grant execute on function public.member_ticket_booking_options(uuid),
  public.redeem_member_tickets_for_booking_request(text,uuid,text,text[],text,jsonb) to service_role;
commit;
