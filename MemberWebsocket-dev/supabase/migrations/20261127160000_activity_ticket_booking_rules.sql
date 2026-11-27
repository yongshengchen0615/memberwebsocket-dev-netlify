-- Event-ticket booking party range and member-calendar activity booking conditions.
-- Scope: public plus every existing tenant schema; update the versioned future-tenant blueprint.
-- 0 means no party-size bound. Unrestricted legacy rows retain original behavior.
do $migration$
declare
  s text;
  def text;
  old_part text;
  new_part text;
  tpl jsonb;
  table_rows jsonb;
  funcs jsonb;
  chk jsonb;
begin
  for s in select nspname from pg_namespace
    where nspname='public' or nspname ~ '^business_[0-9a-f]{32}$'
    order by nspname
  loop
    if to_regclass(format('%I.event_tickets',s)) is null
      or to_regclass(format('%I.calendar_items',s)) is null then
      continue;
    end if;
    execute format('alter table %I.event_tickets add column if not exists min_booking_party_size integer not null default 0',s);
    execute format('alter table %I.event_tickets add column if not exists max_booking_party_size integer not null default 0',s);
    execute format('alter table %I.calendar_items add column if not exists usage_conditions jsonb not null default ''{}''::jsonb',s);
    if not exists(select 1 from pg_constraint c join pg_class t on t.oid=c.conrelid
      join pg_namespace n on n.oid=t.relnamespace
      where n.nspname=s and t.relname='event_tickets' and c.conname='event_ticket_party_size_check') then
      execute format('alter table %I.event_tickets add constraint event_ticket_party_size_check check (min_booking_party_size between 0 and 20 and max_booking_party_size between 0 and 20 and (max_booking_party_size=0 or min_booking_party_size<=max_booking_party_size))',s);
    end if;
    execute format($function$
      create or replace function %1$I.booking_ticket_meets_party_size(
        p_booking_id uuid,p_member_id uuid,p_kind text,p_ref text
      ) returns boolean language sql stable set search_path to '' as $body$
        select case when p_kind <> 'event' then true else coalesce((
          select case when et.min_booking_party_size=0 and et.max_booking_party_size=0 then true
          else exists(
            select 1 from %1$I.bookings b
            where b.id=p_booking_id and b.member_id=p_member_id
              and b.party_size >= greatest(1,et.min_booking_party_size)
              and (et.max_booking_party_size=0 or b.party_size<=et.max_booking_party_size)
          ) end
          from %1$I.event_ticket_claims ec
          join %1$I.event_tickets et on et.id=ec.event_ticket_id
          where ec.member_id=p_member_id and ec.claim_id=p_ref
        ),false) end;
      $body$;
    $function$,s);
    execute format('revoke all on function %I.booking_ticket_meets_party_size(uuid,uuid,text,text) from public,anon,authenticated',s);
    execute format('grant execute on function %I.booking_ticket_meets_party_size(uuid,uuid,text,text) to service_role',s);
    select pg_get_functiondef(p.oid) into strict def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=s and p.proname='booking_ticket_meets_amount' and p.prokind='f';
    old_part := 'select case when p_kind <> ''event'' then true else coalesce((';
    new_part := 'select case when p_kind <> ''event'' then true when not '||
       format('%I.',s)||
       'booking_ticket_meets_party_size(p_booking_id,p_member_id,p_kind,p_ref) then false else coalesce((';
    if strpos(def,old_part)=0 or (length(def)-length(replace(def,old_part,'')))<>length(old_part) then
      raise exception 'PARTY_RULE_AMOUNT_GATE_SOURCE_CHANGED: %',s;
    end if;
    execute replace(def,old_part,new_part);

    execute format($function$
      create or replace function %1$I.calendar_usage_conditions_valid(c jsonb)
      returns boolean language plpgsql immutable set search_path to '' as $body$
      declare
        mode text;
        amount_mode text;
        amount integer;
        lo integer;
        hi integer;
        entry jsonb;
        v text;
        ids jsonb;
        groups jsonb;
        selected jsonb;
      begin
        if c is null or jsonb_typeof(c)<>'object' then return false; end if;
        if c='{}'::jsonb then return true; end if;
        if exists(select 1 from jsonb_object_keys(c) k where k not in
          ('requiredServiceIds','requiredServiceMatchMode','requiredServiceGroups',
           'minBookingAmountMode','minBookingAmount','minBookingServiceIds',
           'minBookingPartySize','maxBookingPartySize')) then return false; end if;
        mode:=coalesce(c->>'requiredServiceMatchMode','any');
        amount_mode:=coalesce(c->>'minBookingAmountMode','none');
        if mode not in ('any','all','groups') or amount_mode not in ('none','total','selected_services') then return false; end if;
        ids:=coalesce(c->'requiredServiceIds','[]'::jsonb);
        selected:=coalesce(c->'minBookingServiceIds','[]'::jsonb);
        groups:=coalesce(c->'requiredServiceGroups','[]'::jsonb);
        if jsonb_typeof(ids)<>'array' or jsonb_array_length(ids)>20
          or jsonb_typeof(selected)<>'array' or jsonb_array_length(selected)>20
          or not %1$I.ticket_service_groups_valid(groups) then return false; end if;
        for v in select value from jsonb_array_elements_text(ids)
          union all select value from jsonb_array_elements_text(selected) loop
          if v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
        end loop;
        if (mode='groups') <> (jsonb_array_length(groups)>0) then return false; end if;
        if mode='groups' and jsonb_array_length(ids)>0 then return false; end if;
        amount:=coalesce((c->>'minBookingAmount')::integer,0);
        if (amount_mode='none' and (amount<>0 or jsonb_array_length(selected)>0))
          or (amount_mode='total' and (amount not between 1 and 10000000 or jsonb_array_length(selected)>0))
          or (amount_mode='selected_services' and (amount not between 1 and 10000000 or jsonb_array_length(selected)=0))
          then return false; end if;
        lo:=coalesce((c->>'minBookingPartySize')::integer,0);
        hi:=coalesce((c->>'maxBookingPartySize')::integer,0);
        if lo not between 0 and 20 or hi not between 0 and 20 or (hi>0 and lo>hi) then return false; end if;
        return true;
      exception when others then return false;
      end $body$;
    $function$,s);
    execute format('revoke all on function %I.calendar_usage_conditions_valid(jsonb) from public,anon,authenticated',s);
    execute format('grant execute on function %I.calendar_usage_conditions_valid(jsonb) to service_role',s);
    if not exists(select 1 from pg_constraint c join pg_class t on t.oid=c.conrelid
      join pg_namespace n on n.oid=t.relnamespace
      where n.nspname=s and t.relname='calendar_items' and c.conname='calendar_usage_conditions_check') then
      execute format('alter table %1$I.calendar_items add constraint calendar_usage_conditions_check check (%1$I.calendar_usage_conditions_valid(usage_conditions) and (item_type=''event'' or usage_conditions=''{}''::jsonb))',s);
    end if;
    -- apply_calendar_batch is the existing transactional + version-checked admin write boundary.
    select pg_get_functiondef(p.oid) into strict def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=s and p.proname='apply_calendar_batch' and p.prokind='f';
    old_part:='visibility_policy, link_label, link_url, created_by, updated_by';
    new_part:='visibility_policy, usage_conditions, link_label, link_url, created_by, updated_by';
    if strpos(def,old_part)=0 then raise exception 'ACTIVITY_INSERT_COLUMNS_CHANGED: %',s; end if;
    def:=replace(def,old_part,new_part);
    old_part:='coalesce(nullif(v_item->>''visibilityPolicy'', ''''), ''eligible_only''),';
    new_part:=old_part||E'\n          '||'coalesce(v_item->''usageConditions'', ''{}''::jsonb),';
    if strpos(def,old_part)=0 then raise exception 'ACTIVITY_INSERT_VALUES_CHANGED: %',s; end if;
    def:=replace(def,old_part,new_part);
    old_part:='visibility_policy = coalesce(nullif(v_item->>''visibilityPolicy'', ''''), visibility_policy),';
    new_part:=old_part||E'\n          '||'usage_conditions = coalesce(v_item->''usageConditions'', usage_conditions),';
    if strpos(def,old_part)=0 then raise exception 'ACTIVITY_UPDATE_CHANGED: %',s; end if;
    execute replace(def,old_part,new_part);
  end loop;

  -- Future merchants are created from a versioned snapshot, not today's public catalog.
  if to_regclass('platform_private.business_templates') is not null then
    select snapshot into strict tpl from platform_private.business_templates
      where version='business-v1-20261019' for update;
    select jsonb_agg(
      case when t->>'name'='event_tickets' then
        jsonb_set(t,'{columns}',(t->'columns')||
          jsonb_build_array(
            jsonb_build_object('name','min_booking_party_size','type','integer','default','0','notNull',true,'identity','','generated',''),
            jsonb_build_object('name','max_booking_party_size','type','integer','default','0','notNull',true,'identity','','generated','')))
      when t->>'name'='calendar_items' then
        jsonb_set(t,'{columns}',(t->'columns')||
          jsonb_build_array(jsonb_build_object('name','usage_conditions','type','jsonb',
            'default','''{}''::jsonb','notNull',true,'identity','','generated','')))
      else t end order by ordinal)
    into table_rows from jsonb_array_elements(tpl->'tables') with ordinality a(t,ordinal);
    tpl:=jsonb_set(tpl,'{tables}',table_rows);

    select jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid),'identityArgs',pg_get_function_identity_arguments(p.oid)) order by p.proname)
      into funcs from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f' and p.proname in
        ('booking_ticket_meets_amount','booking_ticket_meets_party_size',
         'calendar_usage_conditions_valid','apply_calendar_batch');
    if coalesce(jsonb_array_length(funcs),0)<>4 then raise exception 'ACTIVITY_BLUEPRINT_FUNCTIONS_MISSING'; end if;
    tpl:=jsonb_set(tpl,'{functions}',
      coalesce((select jsonb_agg(f order by ordinal) from jsonb_array_elements(tpl->'functions')
      with ordinality a(f,ordinal) where f->>'name' not in
      ('booking_ticket_meets_amount','booking_ticket_meets_party_size','calendar_usage_conditions_valid','apply_calendar_batch')),'[]'::jsonb)||funcs);
    for chk in
      select jsonb_build_object('table',t.relname,'name',c.conname,
        'type',c.contype,'definition',pg_get_constraintdef(c.oid)) as obj
      from pg_constraint c join pg_class t on t.oid=c.conrelid
      join pg_namespace n on n.oid=t.relnamespace
      where n.nspname='public' and c.conname in
        ('event_ticket_party_size_check','calendar_usage_conditions_check')
    loop
      tpl:=jsonb_set(tpl,'{constraints}',
        coalesce((select jsonb_agg(c order by ordinal) from jsonb_array_elements(tpl->'constraints')
           with ordinality a(c,ordinal) where c->>'name'<>chk->>'name'),'[]'::jsonb)
        || jsonb_build_array(chk));
    end loop;
    update platform_private.business_templates set snapshot=tpl where version='business-v1-20261019';
  end if;
end;
$migration$;
notify pgrst,'reload schema';
