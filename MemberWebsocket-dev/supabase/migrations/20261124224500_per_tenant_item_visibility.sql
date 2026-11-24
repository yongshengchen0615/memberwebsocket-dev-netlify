-- Propagate tier visibility to existing tenant schemas and the versioned provisioning blueprint.
-- Existing tenant audit/RLS/transaction RPC bodies are patched in place, not copied from public.
-- Must run after public per-item migration, in one transaction, with failures aborting the rollout.
begin;
do $tenant_visibility$
declare
  s text;
  prev_policy text;
  fn text;
  tpl jsonb;
  tables_next jsonb;
  fn_next jsonb;
  constraints_next jsonb;
  r record;
  name text;
  n integer;
begin
  -- Patches are deliberately exact and fail closed when a tenant function has drifted.
  for s in select nspname from pg_namespace where nspname ~ '^business_[0-9a-f]{32}$' loop
    if to_regclass(format('%I.event_tickets',s)) is null
       or to_regclass(format('%I.calendar_items',s)) is null
       or to_regclass(format('%I.event_ticket_settings',s)) is null
    then raise exception 'TENANT_VISIBILITY_REQUIRED_TABLE_MISSING: %',s;end if;
    execute format('alter table %I.event_tickets add column if not exists visibility_policy text not null default ''eligible_only''',s);
    execute format('alter table %I.calendar_items add column if not exists visibility_policy text not null default ''eligible_only''',s);
    execute format('select visibility_policy from %I.event_ticket_settings where id=1',s) into prev_policy;
    prev_policy := case when prev_policy='higher_preview' then 'higher_preview' else 'eligible_only' end;
    execute format('update %I.event_tickets set visibility_policy=$1',s) using prev_policy;
    execute format('update %I.calendar_items set visibility_policy=$1',s) using prev_policy;
    execute format('alter table %I.event_tickets add constraint event_tickets_visibility_policy_allowed check(visibility_policy in (''eligible_only'',''higher_preview''))',s);
    execute format('alter table %I.calendar_items add constraint calendar_items_visibility_policy_allowed check(visibility_policy in (''eligible_only'',''higher_preview''))',s);
    select pg_get_functiondef(p.oid) into strict fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=s and p.proname='apply_calendar_batch' and p.prokind='f';
    for r in select * from (values
    ('allowed_tier_keys, link_label, link_url, created_by, updated_by', 'allowed_tier_keys, visibility_policy, link_label, link_url, created_by, updated_by'),
    ('coalesce(array(select jsonb_array_elements_text(v_item->''allowedTierKeys'')), array[]::text[]),
          coalesce(v_item->>''linkLabel'', ''''),', 'coalesce(array(select jsonb_array_elements_text(v_item->''allowedTierKeys'')), array[]::text[]),
          coalesce(nullif(v_item->>''visibilityPolicy'', ''''), ''eligible_only''),
          coalesce(v_item->>''linkLabel'', ''''),'),
    ('allowed_tier_keys = coalesce(array(select jsonb_array_elements_text(v_item->''allowedTierKeys'')), array[]::text[]),
          link_label', 'allowed_tier_keys = coalesce(array(select jsonb_array_elements_text(v_item->''allowedTierKeys'')), array[]::text[]),
          visibility_policy = coalesce(nullif(v_item->>''visibilityPolicy'', ''''), visibility_policy),
          link_label'),
    ('      v_id := nullif(v_item->>''calendarItemId'', '''');
      if v_id is null then', '      v_id := nullif(v_item->>''calendarItemId'', '''');
      if coalesce(nullif(v_item->>''visibilityPolicy'', ''''), ''eligible_only'') not in (''eligible_only'',''higher_preview'') then
        raise exception ''INVALID_VISIBILITY_POLICY'';
      end if;
      if v_id is null then')
    ) as patch(old_text,new_text)
    loop
      if position(r.old_text in fn)=0 or position(r.new_text in fn)>0 then
        raise exception 'TENANT_CALENDAR_RPC_DRIFT: %',s;
      end if;
      fn:=replace(fn,r.old_text,r.new_text);
    end loop;
    execute fn;
    -- Existing tenant schema ownership and original RPC ACL are preserved by CREATE OR REPLACE.
  end loop;

  select snapshot into strict tpl from platform_private.business_templates
    where version='business-v1-20261019' for update;
  for name in select unnest(array['event_tickets','calendar_items']) loop
    if not exists (select 1 from jsonb_array_elements(tpl->'tables') t where t->>'name'=name) then
      raise exception 'VISIBILITY_TEMPLATE_TABLE_MISSING: %',name;
    end if;
    if exists (select 1 from jsonb_array_elements(tpl->'tables') t
      cross join lateral jsonb_array_elements(t->'columns') c
      where t->>'name'=name and c->>'name'='visibility_policy') then
      raise exception 'VISIBILITY_TEMPLATE_ALREADY_PATCHED: %',name;
    end if;
    select jsonb_agg(
      case when t->>'name'=name then
        jsonb_set(t,'{columns}', t->'columns' || jsonb_build_array(
          jsonb_build_object('name','visibility_policy','type','text','default','''eligible_only''::text',
            'notNull',true,'identity','','generated','')))
      else t end order by ord) into tables_next
    from jsonb_array_elements(tpl->'tables') with ordinality a(t,ord);
    tpl:=jsonb_set(tpl,'{tables}',tables_next);
  end loop;

  -- Provisioning uses the template definition then rewrites the schema qualifier.
  select count(*)::integer into n from jsonb_array_elements(tpl->'functions') f
    where f->>'name'='apply_calendar_batch';
  if n<>1 then raise exception 'VISIBILITY_TEMPLATE_RPC_COUNT: %',n;end if;
  select f->>'definition' into strict fn from jsonb_array_elements(tpl->'functions') f
    where f->>'name'='apply_calendar_batch';
  for r in select * from (values
    ('allowed_tier_keys, link_label, link_url, created_by, updated_by', 'allowed_tier_keys, visibility_policy, link_label, link_url, created_by, updated_by'),
    ('coalesce(array(select jsonb_array_elements_text(v_item->''allowedTierKeys'')), array[]::text[]),
          coalesce(v_item->>''linkLabel'', ''''),', 'coalesce(array(select jsonb_array_elements_text(v_item->''allowedTierKeys'')), array[]::text[]),
          coalesce(nullif(v_item->>''visibilityPolicy'', ''''), ''eligible_only''),
          coalesce(v_item->>''linkLabel'', ''''),'),
    ('allowed_tier_keys = coalesce(array(select jsonb_array_elements_text(v_item->''allowedTierKeys'')), array[]::text[]),
          link_label', 'allowed_tier_keys = coalesce(array(select jsonb_array_elements_text(v_item->''allowedTierKeys'')), array[]::text[]),
          visibility_policy = coalesce(nullif(v_item->>''visibilityPolicy'', ''''), visibility_policy),
          link_label'),
    ('      v_id := nullif(v_item->>''calendarItemId'', '''');
      if v_id is null then', '      v_id := nullif(v_item->>''calendarItemId'', '''');
      if coalesce(nullif(v_item->>''visibilityPolicy'', ''''), ''eligible_only'') not in (''eligible_only'',''higher_preview'') then
        raise exception ''INVALID_VISIBILITY_POLICY'';
      end if;
      if v_id is null then')
  ) as patch(old_text,new_text)
  loop
    if position(r.old_text in fn)=0 or position(r.new_text in fn)>0 then
      raise exception 'VISIBILITY_TEMPLATE_RPC_DRIFT';
    end if;
    fn:=replace(fn,r.old_text,r.new_text);
  end loop;
  select jsonb_agg(case when f->>'name'='apply_calendar_batch'
    then jsonb_set(f,'{definition}',to_jsonb(fn)) else f end order by ord) into fn_next
  from jsonb_array_elements(tpl->'functions') with ordinality a(f,ord);
  tpl:=jsonb_set(tpl,'{functions}',fn_next);

  select jsonb_agg(jsonb_build_object('table',rel.relname,'name',c.conname,'type',c.contype,
    'definition',pg_get_constraintdef(c.oid)) order by c.conname)
    into constraints_next from pg_constraint c join pg_class rel on rel.oid=c.conrelid
    join pg_namespace n on n.oid=rel.relnamespace
    where n.nspname='public' and c.conname in
      ('event_tickets_visibility_policy_allowed','calendar_items_visibility_policy_allowed');
  if coalesce(jsonb_array_length(constraints_next),0)<>2 then
    raise exception 'VISIBILITY_TEMPLATE_SOURCE_CONSTRAINTS_MISSING';
  end if;
  tpl:=jsonb_set(tpl,'{constraints}', coalesce(tpl->'constraints','[]'::jsonb) || constraints_next);
  update platform_private.business_templates
    set snapshot=tpl where version='business-v1-20261019';
end $tenant_visibility$;
notify pgrst, 'reload schema';
commit;
