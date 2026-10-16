-- Use a scoped wake-up secret in pg_net, never a LINE channel access token.
-- Managed pg_net grants may be owned by supabase_admin and not revocable by postgres.
do $$ begin
  if not exists(select 1 from vault.secrets where name='BOOKING_NOTIFICATION_DISPATCH_SECRET') then
    perform vault.create_secret(gen_random_uuid()::text||gen_random_uuid()::text,'BOOKING_NOTIFICATION_DISPATCH_SECRET');
  end if;
end $$;

create function public.booking_notification_config()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_object_agg(name,decrypted_secret) from vault.decrypted_secrets
  where name in ('BOOKING_NOTIFICATION_DISPATCH_SECRET','LINE_BOOKING_ADMIN_CHANNEL_ACCESS_TOKEN','LINE_BOOKING_MEMBER_CHANNEL_ACCESS_TOKEN');
$$;

create function public.claim_booking_notifications(p_limit integer default 20)
returns setof booking_notifications.outbox language plpgsql security definer set search_path='' as $$
begin
  if not coalesce((select enabled from booking_notifications.config where id),false) then return; end if;
  update booking_notifications.outbox set status='failed',last_error='Retry limit reached'
    where status in ('pending','sending') and next_attempt_at<=now()
    and (attempt_count>=5 or first_attempt_at<now()-interval '12 hours');
  update booking_notifications.outbox q set status='skipped',last_error='Administrator no longer active'
    where q.status in ('pending','sending') and q.channel='admin' and q.next_attempt_at<=now()
    and not exists(select 1 from public.admins a where a.line_user_id=q.recipient and a.status='active' and a.role='admin');
  return query
  with due as (
    select id from booking_notifications.outbox where status in ('pending','sending') and next_attempt_at<=now()
    order by next_attempt_at,created_at limit greatest(1,least(p_limit,20)) for update skip locked
  )
  update booking_notifications.outbox q set status='sending',attempt_count=q.attempt_count+1,
    first_attempt_at=coalesce(q.first_attempt_at,now()),next_attempt_at=now()+interval '2 minutes'
    from due where q.id=due.id returning q.*;
end;
$$;

create function public.finish_booking_notification(p_id uuid,p_attempt integer,p_accepted boolean,
  p_retryable boolean,p_status integer,p_line_request_id text default '')
returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  update booking_notifications.outbox set
    status=case when p_accepted then 'accepted' when p_retryable and attempt_count<5 then 'pending' else 'failed' end,
    accepted_at=case when p_accepted then now() else null end,
    last_error=case when p_accepted then null when p_status is null then 'LINE network or configuration error' else 'LINE HTTP '||p_status end,
    line_request_id=left(p_line_request_id,200),
    next_attempt_at=now()+make_interval(secs=>least(1800,60*power(2,attempt_count)::integer))
    where id=p_id and status='sending' and attempt_count=p_attempt;
  get diagnostics changed=row_count;
  return changed=1;
end;
$$;

revoke all on function public.booking_notification_config() from public,anon,authenticated;
revoke all on function public.claim_booking_notifications(integer) from public,anon,authenticated;
revoke all on function public.finish_booking_notification(uuid,integer,boolean,boolean,integer,text) from public,anon,authenticated;
grant execute on function public.booking_notification_config() to service_role;
grant execute on function public.claim_booking_notifications(integer) to service_role;
grant execute on function public.finish_booking_notification(uuid,integer,boolean,boolean,integer,text) to service_role;

create or replace function booking_notifications.dispatch(p_limit integer default 20)
returns integer language plpgsql security definer set search_path='' as $$
declare dispatch_secret text; project_url text;
begin
  if not coalesce((select enabled from booking_notifications.config where id),false) then return 0; end if;
  if not pg_try_advisory_xact_lock(738491205314::bigint) then return 0; end if;
  if not exists(select 1 from booking_notifications.outbox where status in ('pending','sending') and next_attempt_at<=now()) then return 0; end if;
  select decrypted_secret into dispatch_secret from vault.decrypted_secrets where name='BOOKING_NOTIFICATION_DISPATCH_SECRET';
  select decrypted_secret into project_url from vault.decrypted_secrets where name='project_url';
  if nullif(dispatch_secret,'') is null or nullif(project_url,'') is null then return 0; end if;
  perform net.http_post(url:=rtrim(project_url,'/')||'/functions/v1/booking-line-notifications',
    headers:=jsonb_build_object('Content-Type','application/json','x-dispatch-secret',dispatch_secret),
    body:='{}'::jsonb,timeout_milliseconds:=10000);
  return 1;
end;
$$;
