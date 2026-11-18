-- Read-only acceptance check for a separately authorized and completed
-- MemberWebsocket-main full reset. DO NOT use this script to initiate reset.
-- This fails if the last job is incomplete, application data remains,
-- or the mandatory system baseline was not restored.
DO $main_reset_postcheck$
DECLARE
  v_scope text;
  v_state text;
  v_remaining bigint;
BEGIN
  SELECT project_ref INTO v_scope
  FROM maintenance.sandbox_reset_target
  WHERE singleton IS TRUE AND sandbox_approved IS TRUE;

  IF v_scope IS DISTINCT FROM 'dbuquirnaskrwcamdxki' THEN
    RAISE EXCEPTION 'MAIN_RESET_CHECK_WRONG_PROJECT';
  END IF;
  v_state := maintenance.latest_full_reset_status()->>'state';
  IF v_state IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'MAIN_RESET_CHECK_NOT_COMPLETED: %', v_state;
  END IF;

  SELECT
     (SELECT count(*) FROM public.realtime_events)
   + (SELECT count(*) FROM public.admins)
   + (SELECT count(*) FROM public.members)
   + (SELECT count(*) FROM platform_private.tenants)
   + (SELECT count(*) FROM platform_private.super_admins)
   + (SELECT count(*) FROM auth.users)
   + (SELECT count(*) FROM storage.objects)
   + (SELECT count(*) FROM cron.job WHERE active)
   + (SELECT count(*) FROM pg_catalog.pg_namespace
      WHERE nspname ~ '^business_[a-f0-9]{32}$')
  INTO v_remaining;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'MAIN_RESET_CHECK_RESIDUAL_DATA: %', v_remaining;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.booking_settings WHERE id=1)
     OR NOT EXISTS (SELECT 1 FROM public.event_ticket_settings WHERE id=1)
     OR (SELECT count(*) FROM public.membership_tier_settings
         WHERE tier_key IN ('general','silver','gold','platinum'))<>4
  THEN
    RAISE EXCEPTION 'MAIN_RESET_CHECK_BASELINE_MISSING';
  END IF;
END
$main_reset_postcheck$;
