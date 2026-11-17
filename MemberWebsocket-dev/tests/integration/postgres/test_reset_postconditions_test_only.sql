-- Run against MemberWebsocket-test only after the asynchronous job reaches completed.
-- Read-only postconditions for AC-001/002/003; intentionally fails closed.
DO $assert_test_reset$
DECLARE
  v_ref text;
  v_remaining bigint;
  v_status jsonb;
BEGIN
  SELECT project_ref INTO v_ref
  FROM maintenance.sandbox_reset_target
  WHERE singleton IS TRUE AND sandbox_approved IS TRUE;
  IF v_ref IS DISTINCT FROM 'bmwhojszsnxliekkhrka' THEN
    RAISE EXCEPTION 'RESET_TEST_WRONG_PROJECT';
  END IF;

  v_status := maintenance.latest_full_reset_status();
  IF v_status->>'state' IS DISTINCT FROM 'completed'
     OR v_status->'result'->>'databaseReset' IS DISTINCT FROM 'true'
  THEN
    RAISE EXCEPTION 'RESET_TEST_JOB_NOT_COMPLETED: %', v_status->>'state';
  END IF;

  SELECT
    (SELECT count(*) FROM auth.users)
    + (SELECT count(*) FROM storage.objects)
    + (SELECT count(*) FROM public.admins)
    + (SELECT count(*) FROM public.members)
    + (SELECT count(*) FROM platform_private.super_admins)
    + (SELECT count(*) FROM platform_private.tenants)
    + (SELECT count(*) FROM public.realtime_events)
    + (SELECT count(*) FROM cron.job WHERE active)
    + (SELECT count(*) FROM pg_catalog.pg_namespace
       WHERE nspname ~ '^business_[a-f0-9]{32}$')
    INTO v_remaining;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'RESET_TEST_RESIDUAL_APPLICATION_DATA: %', v_remaining;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM maintenance.sandbox_reset_epoch
                 WHERE singleton IS TRUE
                   AND root_bootstrap_required IS TRUE
                   AND last_completed_request IS NOT NULL)
  THEN
    RAISE EXCEPTION 'RESET_TEST_MISSING_COMPLETION_EPOCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.booking_settings WHERE id=1)
     OR NOT EXISTS (SELECT 1 FROM public.event_ticket_settings WHERE id=1)
     OR (SELECT count(*) FROM public.membership_tier_settings
         WHERE tier_key IN ('general','silver','gold','platinum'))<>4
  THEN
    RAISE EXCEPTION 'RESET_TEST_REQUIRED_SYSTEM_BASELINE_MISSING';
  END IF;
END
$assert_test_reset$;
