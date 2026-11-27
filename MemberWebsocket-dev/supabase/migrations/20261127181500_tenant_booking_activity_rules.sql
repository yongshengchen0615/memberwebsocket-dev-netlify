-- Expand the validated public migration to every existing merchant and the future-merchant blueprint.
-- Guardrail: replace functions only when the existing tenant definition exactly matches the template
-- (after schema substitution). This avoids overwriting tenant-specific drift or unrelated changes.
DO $tenant_rules$
DECLARE
  v_schema text;
  v_fn text;
  v_old text;
  v_public text;
  v_template jsonb;
  v_snapshot jsonb;
  v_table text;
  v_tables jsonb;
  v_columns jsonb;
  v_col jsonb;
  v_funcs jsonb;
  v_constraints jsonb;
  v_triggers jsonb;
  v_constraint text;
  v_definition text;
  v_trigger text;
  v_names text[] := ARRAY[
    'booking_meets_activity_usage',
    'booking_ticket_matches_services',
    'ticket_has_service_requirement',
    'apply_calendar_batch',
    'replace_booking_benefit_selections_request',
    'validate_booking_benefit_service_requirement_row',
    'reconcile_booking_ticket_services',
    'guard_booking_party_size_benefits'
  ];
BEGIN
  SELECT snapshot INTO STRICT v_template
  FROM platform_private.business_templates
  WHERE version='business-v1-20261019' FOR UPDATE;

  -- Fail before any schema DDL if a tenant no longer matches its saved baseline.
  FOR v_schema IN
    SELECT runtime_schema FROM platform_private.tenants
    WHERE runtime_schema ~ '^business_[0-9a-f]{32}$'
    ORDER BY runtime_schema
  LOOP
    FOREACH v_fn IN ARRAY v_names[2:7] LOOP
      SELECT pg_get_functiondef(p.oid) INTO STRICT v_old
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=v_schema AND p.proname=v_fn AND p.prokind='f';
      SELECT e->>'definition' INTO STRICT v_definition
      FROM jsonb_array_elements(v_template->'functions') e
      WHERE e->>'name'=v_fn;
      -- The 2026-10-30 service-group migration updated existing function bodies
      -- but its versioned provisioning blueprint was not yet reseeded. Recognize
      -- only that documented patch; retain strict refusal for arbitrary drift.
      IF replace(v_old,v_schema,'public') IS DISTINCT FROM v_definition AND
         v_fn IN ('booking_ticket_matches_services','ticket_has_service_requirement',
                  'validate_booking_benefit_service_requirement_row') THEN
        v_definition := replace(v_definition,v_schema,'public');
        IF v_fn='booking_ticket_matches_services' THEN
          v_definition:=replace(v_definition,
            $a$coalesce(r.required_service_match_mode,'any'))$a$,
            $b$coalesce(r.required_service_match_mode,'any'),coalesce(r.required_service_groups,'[]'::jsonb))$b$);
          v_definition:=replace(v_definition,
            $a$et.required_service_match_mode)$a$,
            $b$et.required_service_match_mode,coalesce(et.required_service_groups,'[]'::jsonb))$b$);
        ELSIF v_fn='ticket_has_service_requirement' THEN
          v_definition:=replace(v_definition,
            $a$cardinality(coalesce(r.required_service_ids,'{}'::uuid[]))>0$a$,
            $b$(cardinality(coalesce(r.required_service_ids,'{}'::uuid[]))>0 or jsonb_array_length(coalesce(r.required_service_groups,'[]'::jsonb))>0)$b$);
          v_definition:=replace(v_definition,
            $a$cardinality(e.required_service_ids)>0$a$,
            $b$(cardinality(e.required_service_ids)>0 or jsonb_array_length(coalesce(e.required_service_groups,'[]'::jsonb))>0)$b$);
        ELSE
          v_definition:=replace(v_definition,
            $a$v_match_mode text := 'any';$a$,
            $b$v_match_mode text := 'any';$b$||E'\n  v_groups jsonb := ''[]''::jsonb;');
          v_definition:=replace(v_definition,
            $a$coalesce(r.required_service_match_mode, 'any')$a$,
            $b$coalesce(r.required_service_match_mode, 'any'), coalesce(r.required_service_groups,'[]'::jsonb)$b$);
          v_definition:=replace(v_definition,
            $a$coalesce(et.required_service_match_mode, 'any')$a$,
            $b$coalesce(et.required_service_match_mode, 'any'), coalesce(et.required_service_groups,'[]'::jsonb)$b$);
          v_definition:=replace(v_definition,
            $a$into v_required, v_match_mode$a$,
            $b$into v_required, v_match_mode, v_groups$b$);
          v_definition:=replace(v_definition,
            $a$if cardinality(v_required) > 0$a$,
            $b$if (cardinality(v_required) > 0 or jsonb_array_length(coalesce(v_groups,'[]'::jsonb)) > 0)$b$);
          v_definition:=replace(v_definition,
            $a$v_required, v_match_mode)$a$,
            $b$v_required, v_match_mode, v_groups)$b$);
        END IF;
      END IF;
      IF replace(v_old,v_schema,'public') IS DISTINCT FROM v_definition THEN
        RAISE EXCEPTION 'BOOKING_ACTIVITY_TENANT_FUNCTION_DRIFT: %.%',v_schema,v_fn;
      END IF;
    END LOOP;
  END LOOP;

  FOR v_schema IN
    SELECT runtime_schema FROM platform_private.tenants
    WHERE runtime_schema ~ '^business_[0-9a-f]{32}$'
    ORDER BY runtime_schema
  LOOP
    EXECUTE format('ALTER TABLE %I.event_tickets ADD COLUMN IF NOT EXISTS min_booking_party_size smallint NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS max_booking_party_size smallint NOT NULL DEFAULT 0',v_schema);
    EXECUTE format('ALTER TABLE %I.calendar_items
      ADD COLUMN IF NOT EXISTS required_service_ids uuid[] NOT NULL DEFAULT %L::uuid[],
      ADD COLUMN IF NOT EXISTS required_service_match_mode text NOT NULL DEFAULT %L,
      ADD COLUMN IF NOT EXISTS required_service_groups jsonb NOT NULL DEFAULT %L::jsonb,
      ADD COLUMN IF NOT EXISTS min_booking_amount_mode text NOT NULL DEFAULT %L,
      ADD COLUMN IF NOT EXISTS min_booking_amount integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS min_booking_service_ids uuid[] NOT NULL DEFAULT %L::uuid[],
      ADD COLUMN IF NOT EXISTS min_booking_party_size smallint NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS max_booking_party_size smallint NOT NULL DEFAULT 0',v_schema,'{}','any','[]','none','{}');

    EXECUTE format('ALTER TABLE %I.event_tickets ADD CONSTRAINT event_ticket_booking_party_size_chk
      CHECK (min_booking_party_size BETWEEN 0 AND 20 AND max_booking_party_size BETWEEN 0 AND 20
      AND (max_booking_party_size=0 OR max_booking_party_size>=greatest(1,min_booking_party_size)))',v_schema);
    EXECUTE format('ALTER TABLE %I.calendar_items ADD CONSTRAINT calendar_booking_rule_chk CHECK (
      required_service_match_mode IN (''any'',''all'') AND jsonb_typeof(required_service_groups)=''array''
      AND min_booking_amount_mode IN (''none'',''total'',''selected_services'')
      AND min_booking_amount BETWEEN 0 AND 10000000
      AND (min_booking_amount_mode=''none'' AND min_booking_amount=0 OR min_booking_amount_mode<>''none'' AND min_booking_amount>0)
      AND (min_booking_amount_mode<>''selected_services'' OR cardinality(min_booking_service_ids)>0)
      AND min_booking_party_size BETWEEN 0 AND 20 AND max_booking_party_size BETWEEN 0 AND 20
      AND (max_booking_party_size=0 OR max_booking_party_size>=greatest(1,min_booking_party_size)))',v_schema);

    FOREACH v_fn IN ARRAY v_names LOOP
      SELECT pg_get_functiondef(p.oid) INTO STRICT v_public
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=v_fn AND p.prokind='f';
      v_definition := replace(replace(v_public,'public.',format('%I.',v_schema)),'''public''',quote_literal(v_schema));
      EXECUTE v_definition;
    END LOOP;
    SELECT pg_get_triggerdef(t.oid) INTO STRICT v_trigger
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='bookings' AND t.tgname='booking_party_size_benefits_guard';
    EXECUTE replace(v_trigger,'public.',format('%I.',v_schema));
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %I.booking_meets_activity_usage(uuid,uuid,uuid[],text,jsonb,text,integer,uuid[],integer,integer),%I.guard_booking_party_size_benefits() FROM PUBLIC,anon,authenticated',v_schema,v_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.booking_meets_activity_usage(uuid,uuid,uuid[],text,jsonb,text,integer,uuid[],integer,integer) TO service_role',v_schema);
  END LOOP;

  -- Future merchants clone this versioned snapshot, rather than introspecting public tables.
  SELECT jsonb_agg(
    CASE WHEN t->>'name' IN ('event_tickets','calendar_items') THEN
      jsonb_set(t,'{columns}',t->'columns' || coalesce((
        SELECT jsonb_agg(c)
        FROM (
          SELECT jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
            'default',coalesce(pg_get_expr(d.adbin,d.adrelid),''),
            'notNull',a.attnotnull,'identity','','generated','') c
          FROM pg_attribute a
          JOIN pg_class r ON r.oid=a.attrelid JOIN pg_namespace n ON n.oid=r.relnamespace
          LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE n.nspname='public' AND r.relname=t->>'name'
            AND a.attname=ANY(CASE WHEN t->>'name'='event_tickets'
              THEN ARRAY['min_booking_party_size','max_booking_party_size']
              ELSE ARRAY['required_service_ids','required_service_match_mode','required_service_groups','min_booking_amount_mode','min_booking_amount','min_booking_service_ids','min_booking_party_size','max_booking_party_size'] END)
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t->'columns') prior WHERE prior->>'name'=a.attname)
        ) new_columns
      ),'[]'::jsonb))
    ELSE t END ORDER BY ordinal
  ) INTO v_tables
  FROM jsonb_array_elements(v_template->'tables') WITH ORDINALITY a(t,ordinal);
  v_template:=jsonb_set(v_template,'{tables}',v_tables);

  SELECT jsonb_agg(jsonb_build_object('table',r.relname,'name',c.conname,'type',c.contype,
    'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conname)
  INTO v_constraints
  FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
  WHERE n.nspname='public' AND c.conname IN ('calendar_booking_rule_chk','event_ticket_booking_party_size_chk');
  v_template:=jsonb_set(v_template,'{constraints}',coalesce((
    SELECT jsonb_agg(x ORDER BY ordinal)
    FROM jsonb_array_elements(v_template->'constraints') WITH ORDINALITY a(x,ordinal)
    WHERE x->>'name' NOT IN ('calendar_booking_rule_chk','event_ticket_booking_party_size_chk')
  ),'[]'::jsonb) || v_constraints);

  SELECT jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid)) ORDER BY array_position(v_names,p.proname))
  INTO v_funcs FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f' AND p.proname=ANY(v_names);
  IF jsonb_array_length(v_funcs)<>8 THEN RAISE EXCEPTION 'BOOKING_ACTIVITY_TEMPLATE_FUNCTIONS_MISSING'; END IF;
  v_template:=jsonb_set(v_template,'{functions}',coalesce((
    SELECT jsonb_agg(f ORDER BY ordinal)
    FROM jsonb_array_elements(v_template->'functions') WITH ORDINALITY a(f,ordinal)
    WHERE f->>'name'<>ALL(v_names)
  ),'[]'::jsonb)||v_funcs);

  SELECT jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid))
  INTO v_triggers FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='bookings' AND t.tgname='booking_party_size_benefits_guard';
  v_template:=jsonb_set(v_template,'{triggers}',coalesce((
    SELECT jsonb_agg(t ORDER BY ordinal)
    FROM jsonb_array_elements(v_template->'triggers') WITH ORDINALITY a(t,ordinal)
    WHERE t->>'name'<>'booking_party_size_benefits_guard'
  ),'[]'::jsonb)||jsonb_build_array(v_triggers));
  UPDATE platform_private.business_templates SET snapshot=v_template WHERE version='business-v1-20261019';
END;
$tenant_rules$;
REVOKE EXECUTE ON FUNCTION public.booking_meets_activity_usage(uuid,uuid,uuid[],text,jsonb,text,integer,uuid[],integer,integer),public.guard_booking_party_size_benefits() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.booking_meets_activity_usage(uuid,uuid,uuid[],text,jsonb,text,integer,uuid[],integer,integer) TO service_role;
NOTIFY pgrst,'reload schema';
