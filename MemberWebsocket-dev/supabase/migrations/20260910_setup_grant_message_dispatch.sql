create extension if not exists pg_net;
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

do $setup$
declare
  v_secret_id uuid;
  v_project_url_id uuid;
begin
  select id into v_secret_id
  from vault.secrets
  where name = 'GRANT_MESSAGE_DISPATCH_SECRET'
  limit 1;

  if v_secret_id is null then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'GRANT_MESSAGE_DISPATCH_SECRET',
      'Internal secret for scheduled grant message dispatcher'
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
  else
    perform vault.update_secret(
      v_project_url_id,
      'https://dbuquirnaskrwcamdxki.supabase.co',
      'project_url',
      'Supabase project URL used by scheduled Edge Function calls'
    );
  end if;
end;
$setup$;

create or replace function public.get_grant_dispatch_secret()
returns text
language sql
stable
security definer
set search_path to 'public', 'vault', 'pg_temp'
as $function$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'GRANT_MESSAGE_DISPATCH_SECRET'
  order by updated_at desc
  limit 1;
$function$;

revoke all on function public.get_grant_dispatch_secret() from public, anon, authenticated;
grant execute on function public.get_grant_dispatch_secret() to service_role;

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
    ) as request_id;
  $cron$
);