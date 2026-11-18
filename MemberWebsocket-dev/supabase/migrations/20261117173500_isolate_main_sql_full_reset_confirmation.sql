-- Full-reset environment isolation / MemberWebsocket-main only.
-- AC-001: production requires RESET MEMBERWEBSOCKET MAIN DATA, never TEST DATA.
-- AC-002: the DBA request, final execution and worker finish share one phrase.
-- AC-003: other Supabase projects (including MemberWebsocket-test) are no-ops.
-- AC-004: no existing job, Auth user, tenant, storage object or other business
--         row is changed simply by installing this migration.
-- This migration changes only three function bodies. It does NOT request a reset.
-- Keep the original one-time worker tickets, fingerprints, project-pinned URL
-- and DBA-only checks; refuse any signature or code drift.

DO $isolate_main_reset$
DECLARE
  v_project_ref text;
  v_pending_jobs integer;
  v_target record;
  v_definition text;
  v_next text;
  v_before text;
  v_after text;
  v_occurrences integer;
BEGIN
  IF pg_catalog.to_regclass('maintenance.sandbox_reset_target') IS NULL THEN
    RETURN;
  END IF;

  SELECT project_ref INTO v_project_ref
  FROM maintenance.sandbox_reset_target
  WHERE singleton IS TRUE AND sandbox_approved IS TRUE;

  -- An unrelated database must not be modified even when this migration
  -- is accidentally applied by a shared deployment pipeline.
  IF v_project_ref IS DISTINCT FROM 'dbuquirnaskrwcamdxki' THEN
    RETURN;
  END IF;

  IF current_user IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'MAIN_RESET_MIGRATION_DBA_ONLY' USING ERRCODE='42501';
  END IF;

  IF pg_catalog.to_regclass('maintenance.sql_full_reset_jobs') IS NULL THEN
    RAISE EXCEPTION 'MAIN_RESET_JOB_TABLE_MISSING';
  END IF;

  -- Prevent a queued/running ticket from straddling a confirmation cutover.
  SELECT pg_catalog.count(*) INTO v_pending_jobs
  FROM maintenance.sql_full_reset_jobs
  WHERE state IN ('queued', 'running');
  IF v_pending_jobs <> 0 THEN
    RAISE EXCEPTION 'MAIN_RESET_ACTIVE_JOB_BLOCKS_CONFIRMATION_CUTOVER';
  END IF;

  -- Patch all three contracts inside one PostgreSQL transaction. If any
  -- match fails, none of the functions is updated (no partial cutover).
  FOR v_target IN
    SELECT * FROM (VALUES
      (
        'maintenance.request_full_reset_from_sql(text)'::text,
        'if p_confirmation is distinct from ''RESET MEMBERWEBSOCKET TEST DATA''',
        'if p_confirmation is distinct from ''RESET MEMBERWEBSOCKET MAIN DATA'''
      ),
      (
        'maintenance.execute_sandbox_database_reset(uuid,text,text)',
        'if p_confirmation is distinct from ''RESET MEMBERWEBSOCKET TEST DATA''',
        'if p_confirmation is distinct from ''RESET MEMBERWEBSOCKET MAIN DATA'''
      ),
      (
        'public.maintenance_sql_reset_phase(uuid,text,text,jsonb)',
        '''RESET MEMBERWEBSOCKET TEST DATA'');',
        '''RESET MEMBERWEBSOCKET MAIN DATA'');'
      )
    ) AS clauses(signature, old_clause, new_clause)
  LOOP
    IF pg_catalog.to_regprocedure(v_target.signature) IS NULL THEN
      RAISE EXCEPTION 'MAIN_RESET_REQUIRED_FUNCTION_MISSING: %',
        v_target.signature;
    END IF;

    SELECT pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(v_target.signature))
    INTO v_definition;

    v_before := v_target.old_clause;
    v_after := v_target.new_clause;
    v_occurrences := (pg_catalog.length(v_definition) -
      pg_catalog.length(pg_catalog.replace(v_definition, v_before, ''))) /
        pg_catalog.length(v_before);

    IF pg_catalog.strpos(v_definition, v_after) > 0 AND v_occurrences = 0 THEN
      -- An already-migrated function is allowed on replay.
      CONTINUE;
    END IF;

    IF v_occurrences <> 1 OR
       pg_catalog.strpos(v_definition, v_after) > 0 THEN
      RAISE EXCEPTION 'MAIN_RESET_CONFIRMATION_DEFINITION_DRIFT: %',
        v_target.signature;
    END IF;

    -- Refuse to alter a function if the project-bound / privilege / worker
    -- contract was replaced by an unrelated implementation.
    IF v_target.signature LIKE 'maintenance.request_full_reset%' AND (
       pg_catalog.strpos(v_definition, 'current_user <> ''postgres''') = 0 OR
       pg_catalog.strpos(v_definition,
         'https://dbuquirnaskrwcamdxki.supabase.co/functions/v1/sql-full-reset-worker') = 0
    ) THEN
      RAISE EXCEPTION 'MAIN_RESET_REQUEST_SECURITY_CONTRACT_DRIFT';
    ELSIF v_target.signature LIKE 'maintenance.execute_sandbox%' AND
       pg_catalog.strpos(v_definition, 'RESET_DBA_ONLY') = 0 THEN
      RAISE EXCEPTION 'MAIN_RESET_EXECUTE_SECURITY_CONTRACT_DRIFT';
    ELSIF v_target.signature LIKE 'public.maintenance_sql_reset_phase%' AND
       pg_catalog.strpos(v_definition, 'RESET_INVALID_RUNNING_JOB') = 0 THEN
      RAISE EXCEPTION 'MAIN_RESET_WORKER_SECURITY_CONTRACT_DRIFT';
    END IF;

    v_next := pg_catalog.replace(v_definition, v_before, v_after);
    EXECUTE v_next;
  END LOOP;

  IF pg_catalog.strpos(pg_catalog.pg_get_functiondef(
       'maintenance.request_full_reset_from_sql(text)'::pg_catalog.regprocedure),
       'if p_confirmation is distinct from ''RESET MEMBERWEBSOCKET MAIN DATA''') = 0
     OR pg_catalog.strpos(pg_catalog.pg_get_functiondef(
       'maintenance.execute_sandbox_database_reset(uuid,text,text)'::pg_catalog.regprocedure),
       'if p_confirmation is distinct from ''RESET MEMBERWEBSOCKET MAIN DATA''') = 0
     OR pg_catalog.strpos(pg_catalog.pg_get_functiondef(
       'public.maintenance_sql_reset_phase(uuid,text,text,jsonb)'::pg_catalog.regprocedure),
       '''RESET MEMBERWEBSOCKET MAIN DATA'');') = 0
  THEN
    RAISE EXCEPTION 'MAIN_RESET_CONFIRMATION_ATOMIC_PATCH_INCOMPLETE';
  END IF;
END
$isolate_main_reset$;
