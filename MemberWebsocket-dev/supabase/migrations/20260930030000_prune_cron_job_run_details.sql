-- Keep pg_cron observability bounded while retaining two weeks of completed runs.
select cron.schedule(
  'prune-cron-job-run-details',
  '43 19 * * *',
  $$
    delete from cron.job_run_details
    where end_time < now() - interval '14 days';
  $$
);
