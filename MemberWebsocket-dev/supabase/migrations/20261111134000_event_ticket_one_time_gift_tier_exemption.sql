-- A claimed ticket may be gifted once to an accepted friend, irrespective of the recipient's tier.
-- Subsequent redemption is tier-exempt only for the current recorded gifted owner.
-- All other restrictions (ownership, membership, campaign dates, booking, services, GPS) remain.
begin;
create temporary table gift_policy_rules (function_name text not null, before_text text not null, after_text text not null) on commit drop;
insert into gift_policy_rules values
('transfer_event_ticket_to_friend',
$before$if not coalesce(__SCHEMA__.current_tier_key(v_receiver.id) = any(v_ticket.allowed_tier_keys), false) then
    raise exception 'TIER_NOT_ALLOWED';
  end if;$before$,
$after$if exists (select 1 from __SCHEMA__.event_ticket_transfers t where t.claim_id = v_claim.claim_id) then
    raise exception 'EVENT_TICKET_ALREADY_TRANSFERRED';
  end if;$after$),
('redeem_event_ticket',
$before$if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception 'TIER_NOT_ALLOWED'; end if;$before$,
$after$if not (v_tier = any(v_event.allowed_tier_keys))
    and not exists (select 1 from __SCHEMA__.event_ticket_transfers t
      where t.claim_id = v_claim.claim_id and t.receiver_member_id = v_member.id)
  then raise exception 'TIER_NOT_ALLOWED'; end if;$after$),
('redeem_event_tickets_for_booking_request',
$before$if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception 'TIER_NOT_ALLOWED'; end if;$before$,
$after$if not (v_tier = any(v_event.allowed_tier_keys))
      and not exists (select 1 from __SCHEMA__.event_ticket_transfers t
        where t.claim_id = v_claim.claim_id and t.receiver_member_id = v_member.id)
    then raise exception 'TIER_NOT_ALLOWED'; end if;$after$),
('redeem_event_tickets_with_location',
$before$if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception 'TIER_NOT_ALLOWED'; end if;$before$,
$after$if not (v_tier = any(v_event.allowed_tier_keys))
      and not exists (select 1 from __SCHEMA__.event_ticket_transfers t
        where t.claim_id = v_claim.claim_id and t.receiver_member_id = v_member.id)
    then raise exception 'TIER_NOT_ALLOWED'; end if;$after$),
('replace_booking_benefit_selections_request',
$before$if coalesce(cardinality(v_event.allowed_tier_keys),0) > 0 and not coalesce(v_tier = any(v_event.allowed_tier_keys),false) then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;$before$,
$after$if coalesce(cardinality(v_event.allowed_tier_keys),0) > 0
        and not coalesce(v_tier = any(v_event.allowed_tier_keys),false)
        and not exists (select 1 from __SCHEMA__.event_ticket_transfers t
          where t.claim_id = v_ref and t.receiver_member_id = p_member_id)
      then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;$after$),
('validate_snapshot_ticket_selection',
$before$and (cardinality(e.allowed_tier_keys)=0 or __SCHEMA__.current_tier_key(p_member)=any(e.allowed_tier_keys))$before$,
$after$and (cardinality(e.allowed_tier_keys)=0 or __SCHEMA__.current_tier_key(p_member)=any(e.allowed_tier_keys)
   or exists (select 1 from __SCHEMA__.event_ticket_transfers t
     where t.claim_id = ref and t.receiver_member_id = p_member))$after$),
('count_today_usable_event_tickets',
$before$and v_tier=any(e.allowed_tier_keys);$before$,
$after$and (v_tier=any(e.allowed_tier_keys)
      or exists (select 1 from __SCHEMA__.event_ticket_transfers t
        where t.claim_id = c.claim_id and t.receiver_member_id = v_member.id));$after$);
do $gift$
declare
  s text;
  policy record;
  fn record;
  old_fragment text;
  new_fragment text;
  original_ddl text;
  hit_count integer;
  template jsonb;
  updated_functions jsonb;
  function_hits integer;
  idxdef text;
begin
  -- Tenant isolation is preserved by patching schema-local functions only.
  for s in select nspname from pg_namespace
    where nspname='public' or nspname ~ '^business_[0-9a-f]{32}$'
    order by nspname
  loop
    if to_regclass(format('%I.event_ticket_transfers',s)) is null then
      raise exception 'GIFT_LEDGER_MISSING: %',s;
    end if;
    execute format('create unique index if not exists event_ticket_transfers_claim_once_idx on %I.event_ticket_transfers (claim_id)',s);
    for policy in select * from gift_policy_rules loop
      old_fragment:=replace(policy.before_text,'__SCHEMA__',s);
      new_fragment:=replace(policy.after_text,'__SCHEMA__',s);
      hit_count:=0;
      for fn in select p.oid,pg_get_functiondef(p.oid) as definition
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname=s and p.proname=policy.function_name
      loop
        original_ddl:=fn.definition;
        if position(old_fragment in original_ddl)>0 then
          execute replace(original_ddl,old_fragment,new_fragment);
          hit_count:=hit_count+1;
        end if;
      end loop;
      -- A lightweight isolated SQL fixture may omit unrelated redemption functions.
      -- In a real schema, any existing target must have the expected baseline signature.
      if hit_count<>1 and exists (
        select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname=s and p.proname=policy.function_name
      ) then
        raise exception 'GIFT_POLICY_BASELINE_MISMATCH: % %. hits=%',s,policy.function_name,hit_count;
      end if;
    end loop;
  end loop;

  -- Future tenant schemas are cloned from the versioned snapshot, not live public functions.
  if to_regclass('platform_private.business_templates') is not null then
    select snapshot into template from platform_private.business_templates
      where version='business-v1-20261019' for update;
    if template is null then raise exception 'GIFT_POLICY_TEMPLATE_MISSING'; end if;
    for policy in select * from gift_policy_rules loop
      old_fragment:=replace(policy.before_text,'__SCHEMA__','public');
      new_fragment:=replace(policy.after_text,'__SCHEMA__','public');
      select count(*) into function_hits
      from jsonb_array_elements(template->'functions') f
      where f->>'name'=policy.function_name and position(old_fragment in f->>'definition')>0;
      if function_hits<>1 then
        raise exception 'GIFT_POLICY_TEMPLATE_MISMATCH: %. hits=%',policy.function_name,function_hits;
      end if;
      select coalesce(jsonb_agg(
        case when f->>'name'=policy.function_name and position(old_fragment in f->>'definition')>0
          then jsonb_set(f,'{definition}',to_jsonb(replace(f->>'definition',old_fragment,new_fragment)))
          else f end order by ord),'[]'::jsonb) into updated_functions
      from jsonb_array_elements(template->'functions') with ordinality x(f,ord);
      template:=jsonb_set(template,'{functions}',updated_functions);
    end loop;
    select pg_get_indexdef(i.indexrelid) into idxdef
      from pg_index i join pg_class c on c.oid=i.indrelid
      join pg_namespace n on n.oid=c.relnamespace
      join pg_class ic on ic.oid=i.indexrelid
      where n.nspname='public' and c.relname='event_ticket_transfers'
        and ic.relname='event_ticket_transfers_claim_once_idx';
    if idxdef is null then raise exception 'GIFT_POLICY_UNIQUE_INDEX_MISSING'; end if;
    template:=jsonb_set(template,'{indexes}',(
      select coalesce(jsonb_agg(x order by ord),'[]'::jsonb)
      from jsonb_array_elements(template->'indexes') with ordinality a(x,ord)
      where not (x->>'table'='event_ticket_transfers' and x->>'definition' ilike '%event_ticket_transfers_claim_once_idx%')
    ) || jsonb_build_array(jsonb_build_object('table','event_ticket_transfers','definition',idxdef)));
    update platform_private.business_templates set snapshot=template where version='business-v1-20261019';
  end if;
end;
$gift$;
notify pgrst,'reload schema';
commit;
