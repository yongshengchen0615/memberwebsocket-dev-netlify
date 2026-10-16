-- The global "valid booking required" switch controls whether a ticket may
-- be redeemed without a booking. Service matching still applies when a booking
-- is chosen. Ownership, pending holds, points, GPS and request replay guards remain.
begin;
do $patch$
declare
  v_definition text;
  v_old text;
begin
  select pg_get_functiondef('public.member_ticket_booking_options(uuid)'::regprocedure)
    into v_definition;
  v_old := E'if not public.ticket_has_service_requirement(p_member_id,t.kind,t.ref)\n and not exists';
  if position(v_old in v_definition) = 0 then
    raise exception 'OPTIONAL_BOOKING_OPTIONS_PATCH_SOURCE_CHANGED';
  end if;
  execute replace(v_definition, v_old, 'if not exists');

  select pg_get_functiondef('public.redeem_member_tickets_for_booking_request(text,uuid,text,text[],text,jsonb)'::regprocedure)
    into v_definition;
  v_old := 'or (p_booking_id is null and public.ticket_has_service_requirement(v_member.id,p_kind,v_ref))';
  if position(v_old in v_definition) = 0 then
    raise exception 'OPTIONAL_BOOKING_REDEMPTION_PATCH_SOURCE_CHANGED';
  end if;
  execute replace(v_definition, v_old, '');
end;
$patch$;
revoke all on function public.member_ticket_booking_options(uuid)
  from public, anon, authenticated;
revoke all on function public.redeem_member_tickets_for_booking_request(text,uuid,text,text[],text,jsonb)
  from public, anon, authenticated;
grant execute on function public.member_ticket_booking_options(uuid),
  public.redeem_member_tickets_for_booking_request(text,uuid,text,text[],text,jsonb)
  to service_role;
commit;
