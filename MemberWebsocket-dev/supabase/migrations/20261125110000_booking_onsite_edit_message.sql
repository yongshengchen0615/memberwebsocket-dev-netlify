-- Independent member-facing onsite-edit notice, scoped to each merchant.
-- Forward-only: public + existing business schemas + the versioned new-business blueprint.
-- The update API keeps the existing booking_settings CAS and owner authorization.
do $onsite_notice$
declare
  v_schema text;
  v_default constant text := '此預約已超過線上可修改時間，請至現場洽詢修改預約。';
  v_template jsonb;
  v_tables jsonb;
  v_constraints jsonb;
  v_definition text;
  v_count integer;
begin
  for v_schema in
    select 'public'::text
    union all
    select runtime_schema from platform_private.tenants
      where runtime_schema is not null
  loop
    if v_schema <> 'public' and v_schema !~ '^business_[0-9a-f]{32}$' then
      raise exception 'ONSITE_NOTICE_INVALID_TENANT_SCHEMA: %', v_schema;
    end if;
    if to_regclass(format('%I.booking_settings', v_schema)) is null then
      raise exception 'ONSITE_NOTICE_BOOKING_SETTINGS_MISSING: %', v_schema;
    end if;
    execute format(
      'alter table %I.booking_settings add column if not exists onsite_edit_message text not null default %L',
      v_schema, v_default
    );
    if not exists (
      select 1 from pg_constraint
      where conrelid=to_regclass(format('%I.booking_settings', v_schema))
        and conname='booking_onsite_edit_message_length_check'
    ) then
      execute format(
        'alter table %I.booking_settings add constraint booking_onsite_edit_message_length_check check (char_length(btrim(onsite_edit_message)) between 1 and 400)',
        v_schema
      );
    end if;
  end loop;

  -- Provisioned merchants are based on the immutable versioned blueprint, not
  -- on current public DDL. Add the same field and CHECK without replacing RPCs.
  select snapshot into strict v_template
    from platform_private.business_templates
    where version='business-v1-20261019' for update;
  select count(*) into v_count from jsonb_array_elements(v_template->'tables') t
    where t->>'name'='booking_settings';
  if v_count <> 1 then raise exception 'ONSITE_NOTICE_TEMPLATE_BOOKING_SETTINGS_COUNT: %', v_count; end if;
  if exists (
    select 1 from jsonb_array_elements(v_template->'tables') t,
      lateral jsonb_array_elements(t->'columns') c
    where t->>'name'='booking_settings' and c->>'name'='onsite_edit_message'
  ) then raise exception 'ONSITE_NOTICE_TEMPLATE_ALREADY_PATCHED'; end if;

  select jsonb_agg(
    case when t->>'name'='booking_settings' then
      jsonb_set(t,'{columns}',t->'columns'||jsonb_build_array(jsonb_build_object(
        'name','onsite_edit_message','type','text',
        'default',quote_literal(v_default)||'::text',
        'notNull',true,'identity','','generated',''
      )))
    else t end order by ord
  ) into v_tables
  from jsonb_array_elements(v_template->'tables') with ordinality a(t,ord);
  v_template := jsonb_set(v_template,'{tables}',v_tables);

  select pg_get_constraintdef(c.oid) into strict v_definition
  from pg_constraint c
  join pg_class r on r.oid=c.conrelid
  join pg_namespace n on n.oid=r.relnamespace
  where n.nspname='public' and r.relname='booking_settings'
    and c.conname='booking_onsite_edit_message_length_check';
  if exists (
    select 1 from jsonb_array_elements(v_template->'constraints') c
    where c->>'name'='booking_onsite_edit_message_length_check'
  ) then raise exception 'ONSITE_NOTICE_TEMPLATE_CHECK_ALREADY_PATCHED'; end if;
  v_constraints := coalesce(v_template->'constraints','[]'::jsonb) || jsonb_build_array(
    jsonb_build_object('table','booking_settings',
      'name','booking_onsite_edit_message_length_check',
      'type','c','definition',v_definition)
  );
  v_template := jsonb_set(v_template,'{constraints}',v_constraints);
  update platform_private.business_templates
    set snapshot=v_template where version='business-v1-20261019';
end $onsite_notice$;

notify pgrst,'reload schema';
