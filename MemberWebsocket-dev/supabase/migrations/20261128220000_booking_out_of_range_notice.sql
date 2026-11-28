-- Optional merchant-owned booking out-of-range notice (0-400 characters).
-- Update public, every existing merchant runtime, and the versioned template
-- used to provision future merchants, in the same forward-only transaction.
DO $out_of_range_notice$
DECLARE
  v_schema text;
  v_template jsonb;
  v_tables jsonb;
  v_constraints jsonb;
  v_definition text;
  v_count integer;
  v_check_count integer;
BEGIN
  FOR v_schema IN
    SELECT 'public'::text
    UNION
    SELECT runtime_schema FROM platform_private.tenants
    WHERE runtime_schema IS NOT NULL
  LOOP
    IF v_schema <> 'public' AND v_schema !~ '^business_[0-9a-f]{32}$' THEN
      RAISE EXCEPTION 'OUT_OF_RANGE_NOTICE_INVALID_TENANT_SCHEMA: %', v_schema;
    END IF;
    IF to_regclass(format('%I.booking_settings', v_schema)) IS NULL THEN
      RAISE EXCEPTION 'OUT_OF_RANGE_NOTICE_BOOKING_SETTINGS_MISSING: %', v_schema;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.booking_settings ADD COLUMN IF NOT EXISTS out_of_range_notice text NOT NULL DEFAULT %L',
      v_schema, ''
    );
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass(format('%I.booking_settings', v_schema))
        AND conname = 'booking_settings_out_of_range_notice_length'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.booking_settings ADD CONSTRAINT booking_settings_out_of_range_notice_length CHECK (char_length(out_of_range_notice) <= 400)',
        v_schema
      );
    END IF;
    EXECUTE format('COMMENT ON COLUMN %I.booking_settings.out_of_range_notice IS %L',
      v_schema, 'Optional admin-configured out-of-range notice, max 400 characters. Empty uses member-facing fallback.');
  END LOOP;

  -- New merchants use this immutable blueprint, not current public DDL.
  SELECT snapshot INTO STRICT v_template
  FROM platform_private.business_templates
  WHERE version='business-v1-20261019' FOR UPDATE;
  SELECT count(*) INTO v_count FROM jsonb_array_elements(v_template->'tables') t
  WHERE t->>'name'='booking_settings';
  IF v_count <> 1 THEN RAISE EXCEPTION 'OUT_OF_RANGE_NOTICE_TEMPLATE_TABLE_COUNT: %', v_count; END IF;

  SELECT count(*) INTO v_count FROM jsonb_array_elements(v_template->'tables') t,
    LATERAL jsonb_array_elements(t->'columns') c
  WHERE t->>'name'='booking_settings' AND c->>'name'='out_of_range_notice';
  IF v_count > 1 THEN RAISE EXCEPTION 'OUT_OF_RANGE_NOTICE_TEMPLATE_DUPLICATE_COLUMN'; END IF;
  IF v_count = 0 THEN
    SELECT jsonb_agg(
      CASE WHEN t->>'name'='booking_settings' THEN
        jsonb_set(t,'{columns}',t->'columns'||jsonb_build_array(jsonb_build_object(
          'name','out_of_range_notice','type','text','default',quote_literal('')||'::text',
          'notNull',true,'identity','','generated',''
        )))
      ELSE t END ORDER BY ord
    ) INTO v_tables
    FROM jsonb_array_elements(v_template->'tables') WITH ORDINALITY a(t,ord);
    v_template := jsonb_set(v_template,'{tables}',v_tables);
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO STRICT v_definition
  FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace
  WHERE n.nspname='public' AND r.relname='booking_settings'
    AND c.conname='booking_settings_out_of_range_notice_length';
  SELECT count(*) INTO v_check_count
  FROM jsonb_array_elements(v_template->'constraints') c
  WHERE c->>'name'='booking_settings_out_of_range_notice_length'
    AND c->>'table'='booking_settings';
  IF v_check_count > 1 THEN RAISE EXCEPTION 'OUT_OF_RANGE_NOTICE_TEMPLATE_DUPLICATE_CHECK'; END IF;
  IF v_check_count = 0 THEN
    v_constraints := coalesce(v_template->'constraints','[]'::jsonb) || jsonb_build_array(
      jsonb_build_object('table','booking_settings',
        'name','booking_settings_out_of_range_notice_length',
        'type','c','definition',v_definition)
    );
    v_template := jsonb_set(v_template,'{constraints}',v_constraints);
  END IF;
  UPDATE platform_private.business_templates
    SET snapshot=v_template WHERE version='business-v1-20261019';
END $out_of_range_notice$;

NOTIFY pgrst, 'reload schema';
