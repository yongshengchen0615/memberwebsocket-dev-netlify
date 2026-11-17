-- AC-001: the approved MemberWebsocket-test reset must always have a
-- singleton epoch row before the asynchronous SQL worker can finalize a wipe.
--
-- Root cause observed 2026-11-17: maintenance.sandbox_reset_epoch was empty,
-- causing execute_sandbox_database_reset() to raise RESET_EPOCH_NOT_INITIALIZED,
-- which rolled back TRUNCATE/DROP SCHEMA and surfaced RESET_FINISH_DENIED.
--
-- This is a data repair for the explicitly approved disposable test project,
-- NOT a generic reset and NOT a production schema/data migration. It must be
-- inert when replayed against MemberWebsocket-main or an unrelated project.

DO $test_reset_epoch_seed$
DECLARE
  v_project_ref text;
BEGIN
  IF pg_catalog.to_regclass('maintenance.sandbox_reset_target') IS NULL
     OR pg_catalog.to_regclass('maintenance.sandbox_reset_epoch') IS NULL
  THEN
    RETURN;
  END IF;

  SELECT project_ref INTO v_project_ref
    FROM maintenance.sandbox_reset_target
   WHERE singleton IS TRUE AND sandbox_approved IS TRUE;

  IF v_project_ref IS DISTINCT FROM 'bmwhojszsnxliekkhrka' THEN
    RETURN;
  END IF;

  INSERT INTO maintenance.sandbox_reset_epoch(singleton)
  VALUES (TRUE)
  ON CONFLICT (singleton) DO NOTHING;

  IF (SELECT pg_catalog.count(*) FROM maintenance.sandbox_reset_epoch) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM maintenance.sandbox_reset_epoch WHERE singleton IS TRUE
     )
  THEN
    RAISE EXCEPTION 'RESET_EPOCH_SINGLETON_INITIALIZATION_FAILED';
  END IF;
END
$test_reset_epoch_seed$;
