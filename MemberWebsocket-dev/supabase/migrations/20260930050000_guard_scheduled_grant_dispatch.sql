-- Avoid invoking the dispatcher when no work is due while preserving one-minute delivery checks.
select cron.schedule(
  'dispatch-scheduled-grant-messages',
  '* * * * *',
  $cron$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'project_url'
        order by updated_at desc
        limit 1
      ) || '/functions/v1/scheduled-grant-messages',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-dispatch-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'GRANT_MESSAGE_DISPATCH_SECRET'
          order by updated_at desc
          limit 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    ) as request_id
    where exists (
      select 1
      from public.scheduled_grant_messages
      where status = 'pending'
        and scheduled_for <= now()
    )
    or exists (
      select 1
      from public.scheduled_grant_messages
      where status = 'sending'
        and updated_at < now() - interval '10 minutes'
    );
  $cron$
);
