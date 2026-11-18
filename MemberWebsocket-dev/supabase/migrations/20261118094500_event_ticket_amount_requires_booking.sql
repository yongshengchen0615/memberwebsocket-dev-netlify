-- Direct event-ticket use must never bypass an amount requirement.
-- Preserve service-only rules, per-booking amount validation, snapshot flows and point tickets.
-- booking_ticket_meets_amount(NULL, ...) returns true only for unrestricted event tickets.
begin;
do $migration$
declare
  s text;
  prefix text;
  fn text;
  def text;
  old_part text;
  new_part text;
  tpl jsonb;
  funcs jsonb;
begin
  for s in
    select nspname from pg_namespace
    where nspname='public' or nspname ~ '^business_[0-9a-f]{32}$'
    order by nspname
  loop
    if to_regclass(format('%I.event_tickets',s)) is null then continue; end if;
    prefix := format('%I.',s);

    for fn in select unnest(array[
      'member_ticket_booking_options',
      'redeem_member_tickets_for_booking_request'
    ]::text[]) loop
      select pg_get_functiondef(p.oid) into strict def
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=s and p.proname=fn and p.prokind='f';

      if fn='member_ticket_booking_options' then
        -- The booking-aware options are already checked by booking_ticket_meets_amount.
        -- Only the separately generated no-booking option was missing its gate.
        old_part := ' if not '||prefix||
          'ticket_has_service_requirement(p_member_id,t.kind,t.ref) and not exists(';
        new_part := ' if not '||prefix||
          'ticket_has_service_requirement(p_member_id,t.kind,t.ref) and '||prefix||
          'booking_ticket_meets_amount(null::uuid,p_member_id,t.kind,t.ref) and not exists(';
      else
        -- Defense in depth: requests may forge "no-booking" even when the UI omits it.
        old_part := '    if p_booking_id is not null and p_kind=''event'' and not '||prefix||
          'booking_ticket_meets_amount(p_booking_id,v_member.id,p_kind,v_ref) then raise exception ''BOOKING_BENEFIT_AMOUNT_REQUIRED''; end if;';
        new_part := '    if p_booking_id is null and p_kind=''event'' and not '||prefix||
          'booking_ticket_meets_amount(null::uuid,v_member.id,p_kind,v_ref) then raise exception ''BOOKING_BENEFIT_AMOUNT_REQUIRED''; end if;'||
          E'\n'||old_part;
      end if;

      if strpos(def,old_part)=0 or strpos(def,new_part)>0
         or length(def)-length(replace(def,old_part,''))<>length(old_part) then
        raise exception 'EVENT_AMOUNT_DIRECT_USE_SOURCE_CHANGED: %.%',s,fn;
      end if;
      execute replace(def,old_part,new_part);
    end loop;
  end loop;

  -- The provisioner clones this blueprint for future merchants.
  -- Refresh only the two changed functions; preserve all unrelated objects.
  if to_regclass('platform_private.business_templates') is not null then
    select snapshot into strict tpl
    from platform_private.business_templates
    where version='business-v1-20261019' for update;
    select jsonb_agg(
      jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid))
      order by p.proname
    ) into funcs
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f'
      and p.proname in ('member_ticket_booking_options','redeem_member_tickets_for_booking_request');
    if coalesce(jsonb_array_length(funcs),0)<>2 then
      raise exception 'EVENT_AMOUNT_DIRECT_USE_TEMPLATE_FUNCTIONS_MISSING';
    end if;
    tpl:=jsonb_set(tpl,'{functions}',
      coalesce((
        select jsonb_agg(f order by ordinal)
        from jsonb_array_elements(tpl->'functions') with ordinality a(f,ordinal)
        where f->>'name' not in (
          'member_ticket_booking_options',
          'redeem_member_tickets_for_booking_request'
        )
      ),'[]'::jsonb)||funcs);
    update platform_private.business_templates
    set snapshot=tpl where version='business-v1-20261019';
  end if;
end;
$migration$;
notify pgrst,'reload schema';
commit;
