-- General-booking-only event-ticket amount gate.
-- Snapshot validation, direct-use/no-booking eligibility and receipt registration functions are intentionally untouched.
-- Canonical sums use booking_items (also aggregates group participants) once.
begin;
do $migration$
declare
  s text;
  prefix text;
  fn text;
  def text;
  old_part text;
  new_part text;
  old_count integer;
  replacement_count integer;
  tpl jsonb;
  cols jsonb;
  funcs jsonb;
  constraints jsonb;
  func_names text[] := array[
    'booking_ticket_meets_amount',
    'assert_general_booking_event_amount',
    'member_update_booking_benefits_request',
    'admin_replace_booking_benefit_selections_request',
    'redeem_member_tickets_for_booking_request',
    'complete_booking_with_benefits_request',
    'reconcile_booking_ticket_services',
    'member_ticket_booking_options_with_booking'
  ];
begin
  for s in
    select nspname from pg_namespace
    where nspname='public' or nspname ~ '^business_[0-9a-f]{32}$'
    order by nspname
  loop
    if to_regclass(format('%I.event_tickets',s)) is null then continue; end if;
    prefix := format('%I.',s);
    execute format('alter table %I.event_tickets add column if not exists min_booking_amount_mode text not null default ''none''',s);
    execute format('alter table %I.event_tickets add column if not exists min_booking_amount integer not null default 0',s);
    execute format('alter table %I.event_tickets add column if not exists min_booking_service_ids uuid[] not null default ''{}''::uuid[]',s);
    if not exists(select 1 from pg_constraint c join pg_class t on t.oid=c.conrelid
      join pg_namespace n on n.oid=t.relnamespace where n.nspname=s and t.relname='event_tickets'
      and c.conname='event_ticket_min_booking_amount_check') then
      execute format($check$
        alter table %I.event_tickets add constraint event_ticket_min_booking_amount_check check (
          (min_booking_amount_mode='none' and min_booking_amount=0 and cardinality(min_booking_service_ids)=0)
          or (min_booking_amount_mode='total' and min_booking_amount between 1 and 10000000 and cardinality(min_booking_service_ids)=0)
          or (min_booking_amount_mode='selected_services' and min_booking_amount between 1 and 10000000 and cardinality(min_booking_service_ids) between 1 and 20)
        )
      $check$,s);
    end if;
    execute format($function$
      create or replace function %1$I.booking_ticket_meets_amount(
        p_booking_id uuid,p_member_id uuid,p_kind text,p_ref text
      ) returns boolean language sql stable set search_path to '' as $body$
        select case when p_kind <> 'event' then true else coalesce((
          select case when et.min_booking_amount_mode='none' then true
          else exists(
            select 1 from %1$I.bookings b
            where b.id=p_booking_id and b.member_id=p_member_id
              and (select coalesce(sum(bi.unit_price_amount::bigint * bi.quantity::bigint),0)
                   from %1$I.booking_items bi where bi.booking_id=b.id
                   and (et.min_booking_amount_mode='total'
                     or bi.service_id=any(et.min_booking_service_ids))) >= et.min_booking_amount
          ) end
          from %1$I.event_ticket_claims ec
          join %1$I.event_tickets et on et.id=ec.event_ticket_id
          where ec.member_id=p_member_id and ec.claim_id=p_ref
        ),false) end;
      $body$;
    $function$,s);
    execute format($function$
      create or replace function %1$I.assert_general_booking_event_amount(
        p_booking_id uuid,p_member_id uuid,p_selections jsonb
      ) returns void language plpgsql set search_path to '' as $body$
      declare item jsonb;
      begin
        if jsonb_typeof(p_selections) is distinct from 'array' then
          raise exception 'INVALID_BOOKING_BENEFITS';
        end if;
        for item in select value from jsonb_array_elements(p_selections) loop
          if item->>'kind'='event' and not %1$I.booking_ticket_meets_amount(
            p_booking_id,p_member_id,'event',item->>'id') then
              raise exception 'BOOKING_BENEFIT_AMOUNT_REQUIRED';
          end if;
        end loop;
      end $body$;
    $function$,s);

    -- Existing normal-booking transactions remain the authorization boundary.
    for fn in select unnest(func_names[3:8]) loop
      select pg_get_functiondef(p.oid) into strict def from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=s and p.proname=fn and p.prokind='f';

      if fn='member_update_booking_benefits_request' then
        old_part := '  perform '||prefix||'replace_booking_benefit_selections_request(b.id,m.id,normalized ||';
        new_part := '  perform '||prefix||'assert_general_booking_event_amount(b.id,m.id,normalized);'||E'\n'||old_part;
      elsif fn='admin_replace_booking_benefit_selections_request' then
        old_part := '  perform '||prefix||'replace_booking_benefit_selections_request(';
        new_part := '  perform '||prefix||'assert_general_booking_event_amount(v_booking.id,v_booking.member_id,p_selections);'||E'\n'||old_part;
      elsif fn='redeem_member_tickets_for_booking_request' then
        old_part := '    if (p_booking_id is not null and not '||prefix||'booking_ticket_matches_services(p_booking_id,v_member.id,p_kind,v_ref))';
        new_part := '    if p_booking_id is not null and p_kind=''event'' and not '||prefix||'booking_ticket_meets_amount(p_booking_id,v_member.id,p_kind,v_ref) then raise exception ''BOOKING_BENEFIT_AMOUNT_REQUIRED''; end if;'||E'\n'||old_part;
      elsif fn='complete_booking_with_benefits_request' then
        old_part := '  v_tier := '||prefix||'current_tier_key(v_booking.member_id);';
        new_part := '  -- A snapshot receipt is explicitly exempt from this general-booking rule.'||E'\n'||
          '  if v_booking.receipt_submission_id is null and not exists('||
          'select 1 from '||prefix||'booking_receipts r where r.booking_id=v_booking.id) then'||E'\n'||
          '    perform '||prefix||'assert_general_booking_event_amount(v_booking.id,v_booking.member_id,'||
          'coalesce((select jsonb_agg(jsonb_build_object(''kind'',s.benefit_kind,''id'',s.benefit_ref)) from '||
          prefix||'booking_benefit_selections s where s.booking_id=v_booking.id and s.benefit_kind=''event'' and s.status in (''pending'',''redeemed'',''applied'')),''[]''::jsonb));'||E'\n'||
          '  end if;'||E'\n'||old_part;
      elsif fn='reconcile_booking_ticket_services' then
        old_part := 'not '||prefix||'booking_ticket_matches_services(p_booking_id,s.member_id,s.benefit_kind,s.benefit_ref)';
        new_part := '(not '||prefix||'booking_ticket_matches_services(p_booking_id,s.member_id,s.benefit_kind,s.benefit_ref)'||
          ' or (s.benefit_kind=''event'' and v_booking.receipt_submission_id is null'||
          ' and not exists(select 1 from '||prefix||'booking_receipts r where r.booking_id=p_booking_id)'||
          ' and not '||prefix||'booking_ticket_meets_amount(p_booking_id,s.member_id,s.benefit_kind,s.benefit_ref)))';
      elsif fn='member_ticket_booking_options_with_booking' then
        old_part := '      and '||prefix||'booking_ticket_matches_services(b.id,p_member_id,t.kind,t.ref)';
        new_part := old_part||E'\n'||'      and '||prefix||'booking_ticket_meets_amount(b.id,p_member_id,t.kind,t.ref)';
      end if;
      if strpos(def,old_part)=0 then
        raise exception 'GENERAL_AMOUNT_PATCH_SOURCE_CHANGED: %.%',s,fn;
      end if;
      if fn='reconcile_booking_ticket_services' then
        old_count:=length(def)-length(replace(def,old_part,''));
        if old_count<>2*length(old_part) then raise exception 'GENERAL_AMOUNT_RECONCILE_SOURCE_CHANGED: %',s; end if;
      end if;
      execute replace(def,old_part,new_part);
    end loop;
    execute format('revoke all on function %I.booking_ticket_meets_amount(uuid,uuid,text,text), %I.assert_general_booking_event_amount(uuid,uuid,jsonb) from public,anon,authenticated',s,s);
    execute format('grant execute on function %I.booking_ticket_meets_amount(uuid,uuid,text,text), %I.assert_general_booking_event_amount(uuid,uuid,jsonb) to service_role',s,s);
  end loop;

  -- The provisioner clones a versioned blueprint, not the public live catalog.
  -- Seed three columns, the check and all affected/new functions for future tenants.
  if to_regclass('platform_private.business_templates') is not null then
    select snapshot into tpl from platform_private.business_templates
      where version='business-v1-20261019' for update;
    if tpl is null then raise exception 'BUSINESS_TEMPLATE_MISSING'; end if;
    select jsonb_agg(
      case when t->>'name'='event_tickets' then
        jsonb_set(t,'{columns}',(t->'columns')||
          (select jsonb_agg(v)
           from (values
             (jsonb_build_object('name','min_booking_amount_mode','type','text','default','''none''::text','notNull',true,'identity','','generated','')),
             (jsonb_build_object('name','min_booking_amount','type','integer','default','0','notNull',true,'identity','','generated','')),
             (jsonb_build_object('name','min_booking_service_ids','type','uuid[]','default','''{}''::uuid[]','notNull',true,'identity','','generated',''))
           ) x(v)
           where not exists(select 1 from jsonb_array_elements(t->'columns') prior where prior->>'name'=v->>'name')))
      else t end order by ordinal)
    into cols from jsonb_array_elements(tpl->'tables') with ordinality a(t,ordinal);
    tpl:=jsonb_set(tpl,'{tables}',cols);
    select jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid)) order by p.proname,p.oid)
    into funcs from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f' and p.proname=any(func_names);
    if jsonb_array_length(funcs)<>array_length(func_names,1) then
      raise exception 'BUSINESS_TEMPLATE_AMOUNT_FUNCTIONS_MISSING';
    end if;
    tpl:=jsonb_set(tpl,'{functions}',
      coalesce((select jsonb_agg(f order by ordinal) from jsonb_array_elements(tpl->'functions') with ordinality a(f,ordinal)
        where not (f->>'name'=any(func_names))),'[]'::jsonb)||funcs);
    select jsonb_build_object('table',t.relname,'name',c.conname,'type',c.contype,'definition',pg_get_constraintdef(c.oid))
      into constraints from pg_constraint c join pg_class t on t.oid=c.conrelid
      join pg_namespace n on n.oid=t.relnamespace where n.nspname='public'
      and c.conname='event_ticket_min_booking_amount_check';
    tpl:=jsonb_set(tpl,'{constraints}',
      coalesce((select jsonb_agg(c order by ordinal) from jsonb_array_elements(tpl->'constraints') with ordinality a(c,ordinal)
        where c->>'name'<>'event_ticket_min_booking_amount_check'),'[]'::jsonb)
      || jsonb_build_array(constraints));
    update platform_private.business_templates set snapshot=tpl where version='business-v1-20261019';
  end if;
end;
$migration$;
notify pgrst,'reload schema';
commit;
