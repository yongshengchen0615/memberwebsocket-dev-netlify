-- The versioned provisioner clones a blueprint, not the live public schema.
-- Keep only the confirmed ticket-group and calendar-bonus contracts in sync.
-- Existing tenant data/functions and unrelated blueprint entries are untouched.
begin;
do $template$
declare
  tpl jsonb;
  v_table text;
  v_column text;
  v_columns jsonb;
  v_functions jsonb;
  v_constraints jsonb;
  v_triggers jsonb;
  v_names constant text[] := array[
    'ticket_service_groups_valid','booking_meets_required_service_groups',
    'booking_meets_required_services','booking_ticket_matches_services',
    'ticket_has_service_requirement','validate_booking_benefit_service_requirement_row',
    'validate_booking_service_requirements_on_completion','save_point_card_service_items',
    'prevent_delete_ticket_required_service_item','validate_ticket_required_service_ids',
    'complete_booking_with_rewards_request'
  ];
begin
  select snapshot into strict tpl from platform_private.business_templates
    where version='business-v1-20261019' for update;
  for v_table,v_column in values
    ('event_tickets','required_service_groups'),
    ('point_card_rewards','required_service_groups'),
    ('booking_completion_settlements','calendar_bonus_details')
  loop
    if not exists(select 1 from jsonb_array_elements(tpl->'tables') t where t->>'name'=v_table) then
      raise exception 'BUSINESS_TEMPLATE_TABLE_MISSING: %',v_table;
    end if;
    if not exists(select 1 from information_schema.columns
      where table_schema='public' and table_name=v_table and column_name=v_column
        and udt_name='jsonb' and is_nullable='NO') then
      raise exception 'BUSINESS_TEMPLATE_SOURCE_COLUMN_MISSING: %.%',v_table,v_column;
    end if;
    select jsonb_agg(case when t->>'name'=v_table then
      jsonb_set(t,'{columns}',(t->'columns')||case when exists(
        select 1 from jsonb_array_elements(t->'columns') c where c->>'name'=v_column
      ) then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
        'name',v_column,'type','jsonb','default','''[]''::jsonb',
        'notNull',true,'identity','','generated','')) end)
      else t end order by ordinal)
    into v_columns from jsonb_array_elements(tpl->'tables') with ordinality a(t,ordinal);
    tpl:=jsonb_set(tpl,'{tables}',v_columns);
  end loop;

  if exists(select 1 from unnest(v_names) wanted(name) where not exists(
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f' and p.proname=wanted.name
  )) then raise exception 'BUSINESS_TEMPLATE_SOURCE_FUNCTION_MISSING'; end if;
  select jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid)) order by p.proname,p.oid)
  into v_functions from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prokind='f' and p.proname=any(v_names);
  tpl:=jsonb_set(tpl,'{functions}',
    coalesce((select jsonb_agg(f order by ordinal) from jsonb_array_elements(tpl->'functions') with ordinality a(f,ordinal)
      where not (f->>'name'=any(v_names))),'[]'::jsonb)||v_functions);

  select jsonb_agg(jsonb_build_object('table',r.relname,'name',c.conname,'type',c.contype,'definition',pg_get_constraintdef(c.oid)) order by c.conname)
  into v_constraints from pg_constraint c join pg_class r on r.oid=c.conrelid
  join pg_namespace n on n.oid=r.relnamespace where n.nspname='public'
    and c.conname in ('event_ticket_service_groups_check','point_reward_service_groups_check');
  if coalesce(jsonb_array_length(v_constraints),0)<>2 then raise exception 'BUSINESS_TEMPLATE_SOURCE_CONSTRAINT_MISSING'; end if;
  tpl:=jsonb_set(tpl,'{constraints}',
    coalesce((select jsonb_agg(c order by ordinal) from jsonb_array_elements(tpl->'constraints') with ordinality a(c,ordinal)
      where c->>'name' not in ('event_ticket_service_groups_check','point_reward_service_groups_check')),'[]'::jsonb)||v_constraints);

  select jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid)) order by t.tgname)
  into v_triggers from pg_trigger t join pg_class r on r.oid=t.tgrelid
  join pg_namespace n on n.oid=r.relnamespace where n.nspname='public' and not t.tgisinternal
    and t.tgname in ('event_ticket_service_groups_guard','point_reward_service_groups_guard');
  if coalesce(jsonb_array_length(v_triggers),0)<>2 then raise exception 'BUSINESS_TEMPLATE_SOURCE_TRIGGER_MISSING'; end if;
  tpl:=jsonb_set(tpl,'{triggers}',
    coalesce((select jsonb_agg(t order by ordinal) from jsonb_array_elements(tpl->'triggers') with ordinality a(t,ordinal)
      where t->>'name' not in ('event_ticket_service_groups_guard','point_reward_service_groups_guard')),'[]'::jsonb)||v_triggers);
  update platform_private.business_templates set snapshot=tpl where version='business-v1-20261019';
end $template$;
commit;
