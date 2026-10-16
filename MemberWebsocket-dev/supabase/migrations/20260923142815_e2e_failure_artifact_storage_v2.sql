insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'e2e-failure-artifacts',
  'e2e-failure-artifacts',
  false,
  2097152,
  array['image/webp']::text[]
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $setup$
declare
  v_secret_id uuid;
  v_project_url_id uuid;
begin
  select id into v_secret_id
  from vault.secrets
  where name = 'E2E_ARTIFACT_RETENTION_SECRET'
  limit 1;

  if v_secret_id is null then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'E2E_ARTIFACT_RETENTION_SECRET',
      'Internal secret for E2E screenshot retention cleanup'
    );
  end if;

  select id into v_project_url_id
  from vault.secrets
  where name = 'project_url'
  limit 1;

  if v_project_url_id is null then
    perform vault.create_secret(
      'https://dbuquirnaskrwcamdxki.supabase.co',
      'project_url',
      'Supabase project URL used by scheduled Edge Function calls'
    );
  end if;
end;
$setup$;

create or replace function public.get_e2e_artifact_retention_secret()
returns text
language sql
stable
security definer
set search_path to 'public', 'vault', 'pg_temp'
as $function$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'E2E_ARTIFACT_RETENTION_SECRET'
  order by updated_at desc
  limit 1;
$function$;

revoke all on function public.get_e2e_artifact_retention_secret() from public, anon, authenticated;
grant execute on function public.get_e2e_artifact_retention_secret() to service_role;

do $cron$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid
  from cron.job
  where jobname = 'prune-e2e-failure-artifacts'
  limit 1;

  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;
end;
$cron$;

select cron.schedule(
  'prune-e2e-failure-artifacts',
  '17 19 * * *',
  $job$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'project_url'
        order by updated_at desc
        limit 1
      ) || '/functions/v1/e2e-artifact-retention',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-retention-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'E2E_ARTIFACT_RETENTION_SECRET'
          order by updated_at desc
          limit 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 20000
    ) as request_id;
  $job$
);
