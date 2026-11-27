-- Read-only environment isolation contract check.
-- Run independently against BOTH MemberWebsocket-test and MemberWebsocket-main.
-- Expected: main accepts MAIN phrase, test accepts TEST phrase; each targets
-- its own worker and refuses the other's confirmation phrase.
-- Never submits a reset, enqueues a job or modifies business data.
DO $verify_reset_isolation$
DECLARE
  v_ref text;
  v_expected text;
  v_forbidden text;
  v_url text;
  v_request text;
  v_execute text;
  v_phase text;
  v_jobs integer;
BEGIN
  SELECT project_ref INTO v_ref
  FROM maintenance.sandbox_reset_target
  WHERE singleton IS TRUE AND sandbox_approved IS TRUE;

  CASE v_ref
    WHEN 'dbuquirnaskrwcamdxki' THEN
      v_expected := 'RESET MEMBERWEBSOCKET MAIN DATA';
      v_forbidden := 'RESET MEMBERWEBSOCKET TEST DATA';
    WHEN 'bmwhojszsnxliekkhrka' THEN
      v_expected := 'RESET MEMBERWEBSOCKET TEST DATA';
      v_forbidden := 'RESET MEMBERWEBSOCKET MAIN DATA';
    ELSE
      RAISE EXCEPTION 'RESET_ISOLATION_UNRECOGNIZED_PROJECT';
  END CASE;
  v_url := 'https://' || v_ref || '.supabase.co/functions/v1/sql-full-reset-worker';

  SELECT pg_catalog.pg_get_functiondef(
    'maintenance.request_full_reset_from_sql(text)'::regprocedure)
    INTO v_request;
  SELECT pg_catalog.pg_get_functiondef(
    'maintenance.execute_sandbox_database_reset(uuid,text,text)'::regprocedure)
    INTO v_execute;
  SELECT pg_catalog.pg_get_functiondef(
    'public.maintenance_sql_reset_phase(uuid,text,text,jsonb)'::regprocedure)
    INTO v_phase;

  IF pg_catalog.strpos(v_request,
       'if p_confirmation is distinct from ' || quote_literal(v_expected))=0
    OR pg_catalog.strpos(v_execute,
       'if p_confirmation is distinct from ' || quote_literal(v_expected))=0
    OR pg_catalog.strpos(v_phase,quote_literal(v_expected)||');')=0
    OR pg_catalog.strpos(v_request,v_url)=0
  THEN
    RAISE EXCEPTION 'RESET_ISOLATION_MISMATCH: %',v_ref;
  END IF;

  IF pg_catalog.strpos(v_request,
       'if p_confirmation is distinct from ' || quote_literal(v_forbidden))>0
    OR pg_catalog.strpos(v_execute,
       'if p_confirmation is distinct from ' || quote_literal(v_forbidden))>0
    OR pg_catalog.strpos(v_phase,quote_literal(v_forbidden)||');')>0
  THEN
    RAISE EXCEPTION 'RESET_ISOLATION_CROSS_ENV_CONFIRMATION_ACCEPTED: %',v_ref;
  END IF;

  IF has_function_privilege('anon',
      'maintenance.request_full_reset_from_sql(text)','EXECUTE')
    OR has_function_privilege('authenticated',
      'maintenance.request_full_reset_from_sql(text)','EXECUTE')
    OR has_function_privilege('anon',
      'public.maintenance_sql_reset_phase(uuid,text,text,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated',
      'public.maintenance_sql_reset_phase(uuid,text,text,jsonb)','EXECUTE')
  THEN
    RAISE EXCEPTION 'RESET_ISOLATION_UNAUTHORIZED_RPC_GRANT: %', v_ref;
  END IF;

  SELECT pg_catalog.count(*) INTO v_jobs FROM maintenance.sql_full_reset_jobs
  WHERE state IN ('queued','running');
  IF v_jobs <> 0 THEN
    RAISE EXCEPTION 'RESET_ISOLATION_ACTIVE_JOB_PENDING: %',v_ref;
  END IF;
END
$verify_reset_isolation$;
