-- AC-001..006: OR between groups, AND within each group.
-- Empty groups preserve all existing 'any' and 'all' behavior.
begin;
do $migration$
declare
  s text;
  def text;
  old_part text;
  new_part text;
  fname text;
begin
  for s in select nspname from pg_namespace
    where nspname='public' or nspname ~ '^business_[0-9a-f]{32}$'
  loop
    if to_regclass(format('%I.event_tickets',s)) is null then continue; end if;
    execute format('alter table %I.event_tickets add column if not exists required_service_groups jsonb not null default ''[]''::jsonb',s);
    execute format('alter table %I.point_card_rewards add column if not exists required_service_groups jsonb not null default ''[]''::jsonb',s);

    execute format($ddl$
      create or replace function %1$I.ticket_service_groups_valid(groups jsonb)
      returns boolean language plpgsql immutable set search_path to '' as $body$
      declare g jsonb; v text; total integer:=0;
      begin
        if groups is null or jsonb_typeof(groups)<>'array' or jsonb_array_length(groups)>10 then return false;end if;
        for g in select value from jsonb_array_elements(groups) loop
          if jsonb_typeof(g)<>'array' or jsonb_array_length(g) not between 1 and 20 then return false;end if;
          total:=total+jsonb_array_length(g);
          if total>40 then return false;end if;
          for v in select value from jsonb_array_elements_text(g) loop
            if v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false;end if;
          end loop;
        end loop;
        return true;
      exception when others then return false;
      end $body$;
    $ddl$,s);
    execute format('alter table %1$I.event_tickets add constraint event_ticket_service_groups_check check (%1$I.ticket_service_groups_valid(required_service_groups))',s);
    execute format('alter table %1$I.point_card_rewards add constraint point_reward_service_groups_check check (%1$I.ticket_service_groups_valid(required_service_groups))',s);

    execute format($ddl$
      create or replace function %1$I.booking_meets_required_service_groups(p_booking_id uuid, groups jsonb)
      returns boolean language sql stable set search_path to '' as $body$
      with booked as (
        select bi.service_id::text id from %1$I.booking_items bi where bi.booking_id=p_booking_id and bi.service_id is not null
        union
        select bpi.service_id::text from %1$I.booking_participants bp
        join %1$I.booking_participant_items bpi on bpi.participant_id=bp.id
        where bp.booking_id=p_booking_id and bpi.service_id is not null
      )
      select exists(
        select 1 from jsonb_array_elements(coalesce(groups,'[]'::jsonb)) grp(items)
        where jsonb_typeof(grp.items)='array' and jsonb_array_length(grp.items)>0
          and not exists (
            select 1 from jsonb_array_elements_text(grp.items) req(id)
            where not exists(select 1 from booked b where b.id=req.id)
          )
      );
      $body$;
    $ddl$,s);
    execute format($ddl$
      create or replace function %1$I.booking_meets_required_services(
        p_booking_id uuid,p_required_service_ids uuid[],p_match_mode text,p_groups jsonb)
      returns boolean language sql stable set search_path to '' as $body$
      select case when jsonb_array_length(coalesce(p_groups,'[]'::jsonb))>0
        then %1$I.booking_meets_required_service_groups(p_booking_id,p_groups)
        else %1$I.booking_meets_required_services(p_booking_id,p_required_service_ids,p_match_mode)
      end;
      $body$;
    $ddl$,s);

    for fname in select unnest(array[
      'booking_ticket_matches_services','ticket_has_service_requirement',
      'validate_booking_benefit_service_requirement_row',
      'validate_booking_service_requirements_on_completion',
      'save_point_card_service_items','prevent_delete_ticket_required_service_item',
      'validate_ticket_required_service_ids'
    ]) loop
      select pg_get_functiondef(p.oid) into def from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=s and p.proname=fname limit 1;
      if def is null then raise exception 'MISSING_TICKET_FUNCTION: %.%',s,fname;end if;
      if fname='booking_ticket_matches_services' then
        old_part:='coalesce(r.required_service_match_mode,''any''))';
        new_part:='coalesce(r.required_service_match_mode,''any''),coalesce(r.required_service_groups,''[]''::jsonb))';
        if def not like '%'||old_part||'%' then raise exception 'MATCH_RULE_CHANGED: %',s;end if;
        def:=replace(def,old_part,new_part);
        old_part:='et.required_service_match_mode)';
        new_part:='et.required_service_match_mode,coalesce(et.required_service_groups,''[]''::jsonb))';
        if def not like '%'||old_part||'%' then raise exception 'EVENT_MATCH_RULE_CHANGED: %',s;end if;
        def:=replace(def,old_part,new_part);
      elsif fname='ticket_has_service_requirement' then
        old_part:='cardinality(coalesce(r.required_service_ids,''{}''::uuid[]))>0';
        new_part:='(cardinality(coalesce(r.required_service_ids,''{}''::uuid[]))>0 or jsonb_array_length(coalesce(r.required_service_groups,''[]''::jsonb))>0)';
        if def not like '%'||old_part||'%' then raise exception 'POINT_REQUIREMENT_CHANGED: %',s;end if;
        def:=replace(def,old_part,new_part);
        old_part:='cardinality(e.required_service_ids)>0';
        new_part:='(cardinality(e.required_service_ids)>0 or jsonb_array_length(coalesce(e.required_service_groups,''[]''::jsonb))>0)';
        if def not like '%'||old_part||'%' then raise exception 'EVENT_REQUIREMENT_CHANGED: %',s;end if;
        def:=replace(def,old_part,new_part);
      elsif fname in ('validate_booking_benefit_service_requirement_row','validate_booking_service_requirements_on_completion') then
        if fname='validate_booking_benefit_service_requirement_row' then
          old_part:='v_match_mode text := ''any'';';
        else
          old_part:='v_match_mode text;';
        end if;
        if def not like '%'||old_part||'%' then raise exception 'TRIGGER_DECL_CHANGED: %.%',s,fname;end if;
        def:=replace(def,old_part,old_part||E'\n  v_groups jsonb := ''[]''::jsonb;');
        old_part:='coalesce(r.required_service_match_mode, ''any'')';
        new_part:='coalesce(r.required_service_match_mode, ''any''), coalesce(r.required_service_groups,''[]''::jsonb)';
        def:=replace(def,old_part,new_part);
        old_part:='coalesce(et.required_service_match_mode, ''any'')';
        new_part:='coalesce(et.required_service_match_mode, ''any''), coalesce(et.required_service_groups,''[]''::jsonb)';
        def:=replace(def,old_part,new_part);
        old_part:='into v_required, v_match_mode';
        new_part:='into v_required, v_match_mode, v_groups';
        if def not like '%'||old_part||'%' then raise exception 'TRIGGER_SELECT_CHANGED: %.%',s,fname;end if;
        def:=replace(def,old_part,new_part);
        old_part:='if cardinality(v_required) > 0';
        new_part:='if (cardinality(v_required) > 0 or jsonb_array_length(coalesce(v_groups,''[]''::jsonb)) > 0)';
        if def not like '%'||old_part||'%' then raise exception 'TRIGGER_GUARD_CHANGED: %.%',s,fname;end if;
        def:=replace(def,old_part,new_part);
        old_part:='v_required, v_match_mode)';
        new_part:='v_required, v_match_mode, v_groups)';
        def:=replace(def,old_part,new_part);
        if fname='validate_booking_service_requirements_on_completion' then
          old_part:='v_match_mode := ''any'';';
          def:=replace(def,old_part,old_part||E'\n    v_groups := ''[]''::jsonb;');
        end if;
      elsif fname='save_point_card_service_items' then
        old_part:='v_reward_id uuid;';
        if def not like '%'||old_part||'%' then raise exception 'REWARD_DECL_CHANGED: %',s;end if;
        def:=replace(def,old_part,old_part||E'\n  v_groups jsonb;');
        old_part:='v_required_service_ids := ''{}''::uuid[];';
        new_part:=old_part||E'\n      v_groups := coalesce(v_reward->''requiredServiceGroups'',''[]''::jsonb);\n      if not '||quote_ident(s)||'.ticket_service_groups_valid(v_groups) then raise exception ''INVALID_REQUIRED_SERVICE_GROUPS'';end if;';
        def:=replace(def,old_part,new_part);
        old_part:='required_service_match_mode = v_required_service_match_mode,';
        new_part:=old_part||E'\n           required_service_groups = v_groups,';
        if def not like '%'||old_part||'%' then raise exception 'REWARD_UPDATE_CHANGED: %',s;end if;
        def:=replace(def,old_part,new_part);
      elsif fname='prevent_delete_ticket_required_service_item' then
        old_part:='old.id = any(coalesce(et.required_service_ids, ''{}''::uuid[]))';
        new_part:='(old.id = any(coalesce(et.required_service_ids, ''{}''::uuid[])) or exists(select 1 from jsonb_array_elements(et.required_service_groups) g cross join lateral jsonb_array_elements_text(g.value) v where v.value=old.id::text))';
        if def not like '%'||old_part||'%' then raise exception 'EVENT_DELETE_GUARD_CHANGED: %',s;end if;
        def:=replace(def,old_part,new_part);
        old_part:='old.id = any(coalesce(r.required_service_ids, ''{}''::uuid[]))';
        new_part:='(old.id = any(coalesce(r.required_service_ids, ''{}''::uuid[])) or exists(select 1 from jsonb_array_elements(r.required_service_groups) g cross join lateral jsonb_array_elements_text(g.value) v where v.value=old.id::text))';
        if def not like '%'||old_part||'%' then raise exception 'POINT_DELETE_GUARD_CHANGED: %',s;end if;
        def:=replace(def,old_part,new_part);
      elsif fname='validate_ticket_required_service_ids' then
        old_part:='  return new;';
        new_part:=E'  if exists(select 1 from jsonb_array_elements(coalesce(new.required_service_groups,''[]''::jsonb)) g\n    cross join lateral jsonb_array_elements_text(g.value) v\n    left join '||quote_ident(s)||E'.booking_services bs on bs.id::text=v.value\n    where bs.id is null) then raise exception ''INVALID_REQUIRED_SERVICE_GROUPS'';end if;\n  return new;';
        if def not like '%'||old_part||'%' then raise exception 'SERVICE_ID_GUARD_CHANGED: %',s;end if;
        def:=replace(def,old_part,new_part);
      end if;
      execute def;
    end loop;
    execute format('create trigger event_ticket_service_groups_guard before insert or update of required_service_groups on %I.event_tickets for each row execute function %I.validate_ticket_required_service_ids()',s,s);
    execute format('create trigger point_reward_service_groups_guard before insert or update of required_service_groups on %I.point_card_rewards for each row execute function %I.validate_ticket_required_service_ids()',s,s);
    for fname in select unnest(array['ticket_service_groups_valid(jsonb)','booking_meets_required_service_groups(uuid,jsonb)','booking_meets_required_services(uuid,uuid[],text,jsonb)']) loop
      execute format('revoke all on function %I.%s from public,anon,authenticated',s,fname);
      execute format('grant execute on function %I.%s to service_role',s,fname);
    end loop;
  end loop;
end;
$migration$;
notify pgrst,'reload schema';
commit;
