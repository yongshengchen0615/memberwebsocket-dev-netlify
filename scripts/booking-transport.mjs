// Operational recovery for the testing project's booking notification transport.
// Do not turn the intentionally retired legacy/public dispatch schedules back on.
const expected = new Map([['Integrated-Marketing-Platform', 'bmwhojszsnxliekkhrka']]);
export function bookingTransportSQL(branch, projectRef) {
  if (expected.get(branch) !== projectRef) throw Error('BOOKING_TRANSPORT_BRANCH_NOT_ALLOWED');
  const projectUrl = 'https://' + projectRef + '.supabase.co';
  return `DO $restore_booking_transport$
DECLARE
  v_project_url text := '${projectUrl}';
  v_current_url text;
  v_job record;
  v_secret_count integer;
BEGIN
  IF to_regclass('cron.job') IS NULL OR to_regclass('vault.secrets') IS NULL
    OR to_regprocedure('public.platform_tick_businesses()') IS NULL
    OR to_regprocedure('public.platform_dispatch_booking(uuid)') IS NULL
  THEN RAISE EXCEPTION 'BOOKING_DISPATCH_DEPENDENCIES_MISSING'; END IF;

  -- A missing URL is restored to this exact verified testing project. A URL
  -- pointing elsewhere is a hard failure: never silently reroute notifications.
  SELECT count(*) INTO v_secret_count FROM vault.secrets WHERE name='project_url';
  IF v_secret_count>1 THEN RAISE EXCEPTION 'BOOKING_DISPATCH_PROJECT_URL_DUPLICATE'; END IF;
  IF v_secret_count=0 THEN
    PERFORM vault.create_secret(v_project_url,'project_url','Verified testing tenant dispatch origin');
  ELSE
    SELECT decrypted_secret INTO v_current_url
      FROM vault.decrypted_secrets WHERE name='project_url';
    IF v_current_url IS DISTINCT FROM v_project_url THEN
      RAISE EXCEPTION 'BOOKING_DISPATCH_PROJECT_URL_MISMATCH';
    END IF;
  END IF;

  -- Create a cryptographically random internal dispatch secret only if absent.
  -- Its value is never echoed to CI, the frontend or any SQL response.
  SELECT count(*) INTO v_secret_count FROM vault.secrets
    WHERE name='BOOKING_NOTIFICATION_DISPATCH_SECRET';
  IF v_secret_count>1 THEN RAISE EXCEPTION 'BOOKING_DISPATCH_SECRET_DUPLICATE'; END IF;
  IF v_secret_count=0 THEN
    PERFORM vault.create_secret(encode(gen_random_bytes(32),'hex'),
      'BOOKING_NOTIFICATION_DISPATCH_SECRET','Testing booking notification internal dispatch');
  ELSIF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
    WHERE name='BOOKING_NOTIFICATION_DISPATCH_SECRET'
      AND length(decrypted_secret)>=32
  ) THEN RAISE EXCEPTION 'BOOKING_DISPATCH_SECRET_INVALID'; END IF;

  -- This is the tenant-aware scheduler. The old global notification cron must
  -- not be recreated, because its public outbox is not the merchant outbox.
  SELECT * INTO v_job FROM cron.job WHERE jobname='platform-business-runtime';
  IF FOUND THEN
    IF v_job.schedule<>'* * * * *'
      OR btrim(v_job.command)<>'select public.platform_tick_businesses();'
    THEN RAISE EXCEPTION 'BOOKING_DISPATCH_JOB_CHANGED'; END IF;
    IF NOT v_job.active THEN
      PERFORM cron.alter_job(job_id := v_job.jobid, active := true);
    END IF;
  ELSE
    PERFORM cron.schedule('platform-business-runtime','* * * * *',
      'select public.platform_tick_businesses();');
  END IF;
END;
$restore_booking_transport$;
SELECT (
  (SELECT count(*)=1 FROM vault.secrets WHERE name='project_url')
  AND (SELECT count(*)=1 FROM vault.secrets
       WHERE name='BOOKING_NOTIFICATION_DISPATCH_SECRET')
  AND (SELECT count(*)=1 FROM cron.job
       WHERE jobname='platform-business-runtime' AND active
         AND schedule='* * * * *'
         AND btrim(command)='select public.platform_tick_businesses();')
) AS ready;`;
}
