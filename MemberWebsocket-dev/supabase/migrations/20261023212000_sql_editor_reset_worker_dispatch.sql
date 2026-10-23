-- #82 SQL Editor one-command dispatcher. SQL only queues a hosted Edge worker:
-- SQL itself never edits managed Storage metadata or Auth tables.
-- Fail closed unless an independently verified backup, recovery and provider
-- isolation is already recorded by the privileged operator.
begin;
create table if not exists maintenance.sql_full_reset_jobs (
  id uuid primary key,
  ticket_sha256 text not null check(ticket_sha256 ~ '^[a-f0-9]{64}$'),
  fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
  state text not null default 'queued'
    check(state in ('queued','running','completed','failed')),
  requested_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  pg_net_request_id bigint,
  result jsonb,
  error_code text
);
revoke all on maintenance.sql_full_reset_jobs from public, anon, authenticated, service_role;

create or replace function maintenance.request_full_reset_from_sql(
  p_confirmation text
) returns jsonb language plpgsql security invoker set search_path = ''
as $body$
declare
  v_job uuid := pg_catalog.gen_random_uuid();
  v_ticket text;
  v_preview jsonb;
  v_request bigint;
begin
  if current_user <> 'postgres' then
    raise exception 'RESET_DBA_ONLY' using errcode='42501';
  end if;
  if p_confirmation is distinct from 'RESET MEMBERWEBSOCKET TEST DATA' then
    raise exception 'RESET_EXACT_CONFIRMATION_REQUIRED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('maintenance:sql-full-reset-request',0));
  if exists(select 1 from maintenance.sql_full_reset_jobs
     where state in ('queued','running')) then
    raise exception 'RESET_JOB_ALREADY_ACTIVE';
  end if;
  if exists(select 1 from maintenance.sandbox_reset_epoch
     where singleton and root_bootstrap_required) then
    raise exception 'RESET_ROOT_BOOTSTRAP_PENDING';
  end if;
  if not exists (
    select 1 from maintenance.sandbox_reset_target
    where singleton and project_ref = 'dbuquirnaskrwcamdxki'
      and sandbox_approved
      and backup_verified_at is not null
      and storage_restore_verified_at is not null
      and provider_isolation_verified_at is not null
  ) then
    raise exception 'RESET_BACKUP_STORAGE_AND_PROVIDER_PROOF_REQUIRED';
  end if;
  v_preview := maintenance.plan_sandbox_database_reset();
  v_ticket := pg_catalog.encode(extensions.gen_random_bytes(32),'hex');
  insert into maintenance.sql_full_reset_jobs(id,ticket_sha256,fingerprint)
  values(v_job,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_ticket,'UTF8')),'hex'),
         v_preview->>'fingerprint');
  -- pg_net only sends after SQL COMMIT. Never put service_role API keys in
  -- queued headers; this random ticket is scoped to one already approved job.
  select net.http_post(
    url := 'https://dbuquirnaskrwcamdxki.supabase.co/functions/v1/sql-full-reset-worker',
    body := pg_catalog.jsonb_build_object('job_id',v_job,'ticket',v_ticket),
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 120000
  ) into v_request;
  update maintenance.sql_full_reset_jobs
  set pg_net_request_id=v_request where id=v_job;
  return pg_catalog.jsonb_build_object(
    'submitted',true,'completed',false,'jobId',v_job,
    'message','QUEUED_NOT_YET_CLEARED',
    'checkStatusSql','select maintenance.latest_full_reset_status();');
end;
$body$;

create or replace function maintenance.latest_full_reset_status()
returns jsonb language sql stable security invoker set search_path=''
as $body$
  select coalesce((
    select pg_catalog.jsonb_build_object(
      'jobId',id,'state',state,'requestedAt',requested_at,
      'startedAt',started_at,'finishedAt',finished_at,
      'errorCode',error_code,'result',result)
    from maintenance.sql_full_reset_jobs order by requested_at desc limit 1
  ),'{"state":"not_started"}'::jsonb);
$body$;

-- Private worker RPCs. An untrusted HTTP caller must know a random 256-bit
-- ticket for an already DBA-authorized job. No public/anon JWT permissions.
create or replace function public.maintenance_sql_reset_claim(
  p_job_id uuid, p_ticket text
) returns jsonb language plpgsql security definer set search_path=''
as $body$
declare v_job maintenance.sql_full_reset_jobs%rowtype;
begin
  select * into v_job from maintenance.sql_full_reset_jobs
  where id=p_job_id for update;
  if not found or p_ticket is null or
     pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_ticket,'UTF8')),'hex')
       is distinct from v_job.ticket_sha256 then
    raise exception 'RESET_INVALID_JOB_TICKET' using errcode='42501';
  end if;
  if v_job.state <> 'queued' or
      v_job.requested_at < pg_catalog.clock_timestamp()- interval '5 minutes' then
    raise exception 'RESET_TICKET_EXPIRED_OR_CONSUMED' using errcode='42501';
  end if;
  if not exists(select 1 from maintenance.sandbox_reset_target
    where singleton and backup_verified_at is not null
      and storage_restore_verified_at is not null
      and provider_isolation_verified_at is not null) then
    raise exception 'RESET_PROOFS_NOT_VERIFIED';
  end if;
  if (maintenance.plan_sandbox_database_reset()->>'fingerprint')
       is distinct from v_job.fingerprint then
    raise exception 'RESET_PREVIEW_CHANGED';
  end if;
  update maintenance.sql_full_reset_jobs
  set state='running',started_at=pg_catalog.clock_timestamp()
  where id=p_job_id;
  return pg_catalog.jsonb_build_object('accepted',true);
end;
$body$;

create or replace function public.maintenance_sql_reset_phase(
  p_job_id uuid,p_ticket text,p_action text,p_result jsonb default null
) returns jsonb language plpgsql security definer set search_path=''
as $body$
declare v_job maintenance.sql_full_reset_jobs%rowtype;
declare v_id bigint;
declare v_output jsonb;
begin
  select * into v_job from maintenance.sql_full_reset_jobs
  where id=p_job_id for update;
  if not found or v_job.state <> 'running'
   or p_ticket is null or
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_ticket,'UTF8')),'hex')
      is distinct from v_job.ticket_sha256 then
    raise exception 'RESET_INVALID_RUNNING_JOB' using errcode='42501';
  end if;
  if p_action='pause' then
    for v_id in select jobid from cron.job where active order by jobid loop
      perform cron.alter_job(v_id,active:=false);
    end loop;
    if exists(select 1 from cron.job where active) then
      raise exception 'RESET_CRON_STILL_ACTIVE';
    end if;
    return '{"cronPaused":true}'::jsonb;
  elsif p_action='inventory' then
    return pg_catalog.jsonb_build_object(
      'authUsers',(select count(*) from auth.users),
      'storageObjects',(select count(*) from storage.objects),
      'activeCron',(select count(*) from cron.job where active),
      'buckets',(select coalesce(pg_catalog.jsonb_agg(id order by id),'[]'::jsonb) from storage.buckets));
  elsif p_action='finish' then
    if exists(select 1 from auth.users) or exists(select 1 from storage.objects)
      or exists(select 1 from cron.job where active) then
      raise exception 'RESET_MANAGED_RESOURCES_NOT_EMPTY';
    end if;
    if (maintenance.plan_sandbox_database_reset()->>'fingerprint')
        is distinct from v_job.fingerprint then
      raise exception 'RESET_APPLICATION_CHANGED_WHILE_CLEARING_FILES';
    end if;
    v_output := maintenance.execute_sandbox_database_reset(
      p_job_id,(maintenance.plan_sandbox_database_reset()->>'fingerprint'),
      'RESET MEMBERWEBSOCKET TEST DATA');
    update maintenance.sql_full_reset_jobs
    set state='completed',finished_at=pg_catalog.clock_timestamp(),result=v_output
    where id=p_job_id;
    return v_output;
  elsif p_action='fail' then
    update maintenance.sandbox_reset_target
    set backup_verified_at=null,storage_restore_verified_at=null,
        provider_isolation_verified_at=null where singleton=true;
    update maintenance.sql_full_reset_jobs
    set state='failed',finished_at=pg_catalog.clock_timestamp(),
        error_code=left(coalesce(p_result->>'error','RESET_WORKER_FAILED'),120)
    where id=p_job_id;
    return '{"failed":true}'::jsonb;
  end if;
  raise exception 'RESET_UNKNOWN_PHASE';
end;
$body$;

revoke all on function maintenance.request_full_reset_from_sql(text)
  from public,anon,authenticated,service_role;
revoke all on function maintenance.latest_full_reset_status()
  from public,anon,authenticated,service_role;
revoke all on function public.maintenance_sql_reset_claim(uuid,text)
  from public,anon,authenticated,service_role;
revoke all on function public.maintenance_sql_reset_phase(uuid,text,text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.maintenance_sql_reset_claim(uuid,text) to service_role;
grant execute on function public.maintenance_sql_reset_phase(uuid,text,text,jsonb) to service_role;
commit;
