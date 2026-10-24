-- Fix PGRST002 after a guarded sandbox reset removes merchant runtimes.
-- Keep all existing reset preconditions and SQL fingerprints unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION maintenance.prune_orphaned_postgrest_business_schemas()
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path TO ''
AS $cleanup$
DECLARE
  v_exposed text;
  v_entry record;
  v_kept text[] := ARRAY[]::text[];
  v_removed integer := 0;
BEGIN
  IF current_user IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'POSTGREST_SCHEMA_REPAIR_DBA_ONLY' USING ERRCODE='42501';
  END IF;
  -- A dashboard-managed config without role override needs no adjustment.
  SELECT substring(config.value FROM char_length('pgrst.db_schemas=') + 1)
    INTO v_exposed
  FROM pg_catalog.pg_roles r
  CROSS JOIN LATERAL pg_catalog.unnest(coalesce(r.rolconfig,ARRAY[]::text[])) AS config(value)
  WHERE r.rolname = 'authenticator' AND config.value LIKE 'pgrst.db_schemas=%';
  IF v_exposed IS NULL THEN RETURN 0; END IF;
  FOR v_entry IN
    SELECT pg_catalog.btrim(e.name) AS schema_name
    FROM pg_catalog.unnest(pg_catalog.string_to_array(v_exposed,',')) WITH ORDINALITY AS e(name,ord)
    ORDER BY e.ord
  LOOP
    IF v_entry.schema_name ~ '^business_[a-f0-9]{32}$'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = v_entry.schema_name
      ) THEN
      v_removed := v_removed + 1;
    ELSE
      v_kept := pg_catalog.array_append(v_kept,v_entry.schema_name);
    END IF;
  END LOOP;
  IF v_removed = 0 THEN RETURN 0; END IF;
  IF pg_catalog.array_length(v_kept,1) IS NULL THEN
    RAISE EXCEPTION 'POSTGREST_SCHEMA_REPAIR_EMPTY_CONFIG';
  END IF;
  EXECUTE pg_catalog.format(
    'ALTER ROLE authenticator SET pgrst.db_schemas = %L',
    pg_catalog.array_to_string(v_kept,',')
  );
  PERFORM pg_catalog.pg_notify('pgrst','reload config');
  PERFORM pg_catalog.pg_notify('pgrst','reload schema');
  RETURN v_removed;
END
$cleanup$;

REVOKE ALL ON FUNCTION maintenance.prune_orphaned_postgrest_business_schemas()
  FROM PUBLIC, anon, authenticated, service_role;

-- Amend the existing guarded reset only at its post-cleanup hook.
-- Refuse any differing reset implementation rather than silently bypass
-- its confirmation, snapshot fingerprint, authorization or postconditions.
DO $patch$
DECLARE
  v_before text := E'   v_removed_schemas := v_removed_schemas+1;\n end loop;\n -- Recreate the system-required';
  v_after text := E'   v_removed_schemas := v_removed_schemas+1;\n end loop;\n -- Reconcile exposed business schemas inside this reset transaction.\n perform maintenance.prune_orphaned_postgrest_business_schemas();\n -- Recreate the system-required';
  v_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'maintenance.execute_sandbox_database_reset(uuid,text,text)'::pg_catalog.regprocedure
  ) INTO v_definition;
  IF v_definition IS NULL OR pg_catalog.strpos(v_definition,v_before) = 0
    OR pg_catalog.strpos(v_definition,'maintenance.prune_orphaned_postgrest_business_schemas()') > 0 THEN
    RAISE EXCEPTION 'POSTGREST_RESET_HOOK_DEFINITION_DRIFT';
  END IF;
  EXECUTE pg_catalog.replace(v_definition,v_before,v_after);
END
$patch$;

COMMIT;
