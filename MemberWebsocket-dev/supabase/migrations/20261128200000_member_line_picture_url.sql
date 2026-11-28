-- Synchronize the shared schema, active merchant schemas and future merchant blueprint.
-- The LINE picture claim is taken only from a LINE-verified ID token.
-- Existing members remain NULL until their next verified login.
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS line_picture_url text;

DO $line_member_picture$
DECLARE
  v_schema text;
  v_template jsonb;
  v_tables jsonb;
BEGIN
  SELECT snapshot INTO STRICT v_template
  FROM platform_private.business_templates
  WHERE version = 'business-v1-20261019'
  FOR UPDATE;

  IF (SELECT count(*) FROM jsonb_array_elements(v_template->'tables') t
      WHERE t->>'name' = 'members') <> 1 THEN
    RAISE EXCEPTION 'MEMBER_PICTURE_TEMPLATE_MEMBERS_MISSING';
  END IF;

  -- Each registered merchant has its own members table and RLS boundary.
  FOR v_schema IN
    SELECT runtime_schema FROM platform_private.tenants
    WHERE runtime_schema ~ '^business_[0-9a-f]{32}$'
    ORDER BY runtime_schema
  LOOP
    IF to_regclass(format('%I.members', v_schema)) IS NULL THEN
      RAISE EXCEPTION 'MEMBER_PICTURE_TENANT_MEMBERS_MISSING: %', v_schema;
    END IF;
    EXECUTE format('ALTER TABLE %I.members ADD COLUMN IF NOT EXISTS line_picture_url text', v_schema);
  END LOOP;

  -- Provisioning clones a stored JSON snapshot, not the live public table.
  SELECT jsonb_agg(
    CASE WHEN t->>'name' = 'members'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(t->'columns') col
        WHERE col->>'name' = 'line_picture_url'
      )
    THEN jsonb_set(t, '{columns}', t->'columns' || jsonb_build_array(
      jsonb_build_object('name','line_picture_url','type','text',
        'default','','notNull',false,'identity','','generated','')
    ))
    ELSE t END ORDER BY ordinal
  ) INTO v_tables
  FROM jsonb_array_elements(v_template->'tables') WITH ORDINALITY a(t,ordinal);

  UPDATE platform_private.business_templates
  SET snapshot = jsonb_set(v_template, '{tables}', v_tables)
  WHERE version = 'business-v1-20261019';
END;
$line_member_picture$;

NOTIFY pgrst, 'reload schema';
