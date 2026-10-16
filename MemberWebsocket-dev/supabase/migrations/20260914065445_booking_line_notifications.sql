-- Transactional LINE notifications. No tokens or recipient IDs in source control.
-- Requires existing pg_net, pg_cron, Vault, bookings, booking_items, members, admins.
create schema if not exists booking_notifications;
revoke all on schema booking_notifications from public, anon, authenticated;

create table booking_notifications.config (
  id boolean primary key default true check (id),
  enabled boolean not null default false
);
insert into booking_notifications.config default values;

create table booking_notifications.outbox (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  event_key text not null,
  channel text not null check (channel in ('admin','member')),
  recipient text not null check (recipient ~ '^U[0-9a-f]{32}$'),
  message_text text not null check (char_length(message_text) between 1 and 4500),
  status text not null default 'pending' check (status in ('pending','sending','accepted','failed','skipped')),
  attempt_count integer not null default 0,
  request_id bigint,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  accepted_at timestamptz,
  last_error text,
  line_request_id text,
  created_at timestamptz not null default now(),
  unique (event_key, channel, recipient)
);
create index booking_notifications_due on booking_notifications.outbox(next_attempt_at)
  where status in ('pending','sending');
alter table booking_notifications.config enable row level security;
alter table booking_notifications.outbox enable row level security;
revoke all on all tables in schema booking_notifications from public, anon, authenticated;

-- Internal function only: PostgreSQL cron and the trigger owner may invoke it.
-- A pg_net request is sent only after the surrounding transaction commits.
create function booking_notifications.dispatch(p_limit integer default 20)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  job booking_notifications.outbox%rowtype;
  reply net._http_response%rowtype;
  token text;
  new_request_id bigint;
  sent integer := 0;
  terminal boolean;
begin
  if not coalesce((select enabled from booking_notifications.config where id),false) then return 0; end if;
  -- Avoid deadlocks and duplicate claims between concurrent booking commits and cron.
  if not pg_try_advisory_xact_lock(738491205314::bigint) then return 0; end if;
  for job in select * from booking_notifications.outbox
    where status in ('pending','sending') and next_attempt_at <= now()
    order by next_attempt_at,created_at limit greatest(1,least(p_limit,100)) for update skip locked
  loop
    if job.status = 'sending' then
      select * into reply from net._http_response where id = job.request_id;
      if found and ((reply.status_code between 200 and 299) or
        (reply.status_code = 409 and nullif(reply.headers->>'x-line-accepted-request-id','') is not null)) then
        update booking_notifications.outbox set status='accepted', accepted_at=now(), last_error=null,
          line_request_id=coalesce(reply.headers->>'x-line-accepted-request-id',reply.headers->>'x-line-request-id')
          where id=job.id;
        continue;
      end if;
      -- Missing responses may represent a lost response or pg_net restart; reuse the same UUID.
      terminal := coalesce(reply.status_code between 400 and 499 and reply.status_code <> 429,false);
      update booking_notifications.outbox set status=case when terminal then 'failed' else 'pending' end,
        last_error=case when reply.status_code is not null then 'LINE HTTP '||reply.status_code else 'LINE response unavailable' end,
        line_request_id=reply.headers->>'x-line-request-id',
        next_attempt_at=now()+make_interval(secs => least(1800,60*power(2,job.attempt_count)::integer))
        where id=job.id;
      continue;
    end if;
    -- Never retry beyond LINE's 24-hour idempotency window (use a conservative 12 hours).
    if job.attempt_count >= 5 or job.first_attempt_at < now()-interval '12 hours' then
      update booking_notifications.outbox set status='failed',last_error='Retry limit reached' where id=job.id;
      continue;
    end if;
    -- Re-check administrator authorization before every delivery; never notify disabled admins.
    if job.channel='admin' and not exists (
      select 1 from public.admins where line_user_id=job.recipient and status='active' and role='admin'
    ) then
      update booking_notifications.outbox set status='skipped',last_error='Administrator no longer active' where id=job.id;
      continue;
    end if;
    select decrypted_secret into token from vault.decrypted_secrets
      where name=case job.channel when 'admin' then 'LINE_BOOKING_ADMIN_CHANNEL_ACCESS_TOKEN'
        else 'LINE_BOOKING_MEMBER_CHANNEL_ACCESS_TOKEN' end limit 1;
    if nullif(btrim(token),'') is null then
      update booking_notifications.outbox set last_error='Channel token missing',next_attempt_at=now()+interval '5 minutes'
        where id=job.id;
      continue;
    end if;
    begin
      new_request_id := net.http_post(
        url := 'https://api.line.me/v2/bot/message/push',
        body := jsonb_build_object('to',job.recipient,'messages',jsonb_build_array(jsonb_build_object('type','text','text',job.message_text))),
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token,'X-Line-Retry-Key',job.id::text),
        timeout_milliseconds := 10000
      );
      update booking_notifications.outbox set status='sending',attempt_count=attempt_count+1,
        request_id=new_request_id,first_attempt_at=coalesce(first_attempt_at,now()),
        next_attempt_at=now()+interval '1 minute',last_error=null where id=job.id;
      sent := sent+1;
    exception when others then
      -- Do not expose HTTP headers/tokens via database error messages.
      update booking_notifications.outbox set status='pending',attempt_count=attempt_count+1,
        first_attempt_at=coalesce(first_attempt_at,now()),last_error='Unable to queue LINE request',
        next_attempt_at=now()+interval '2 minutes' where id=job.id;
    end;
  end loop;
  return sent;
end;
$$;

create function booking_notifications.enqueue()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  event_kind text;
  event_id text;
  member_record public.members%rowtype;
  latest public.bookings%rowtype;
  items text;
  details text;
  contact text;
begin
  if TG_OP='INSERT' then
    if NEW.status <> 'pending' then return null; end if;
    event_kind := 'created';
    event_id := NEW.id::text||':created';
  elsif OLD.status='pending' and NEW.status='confirmed' then
    event_kind := 'confirmed';
    event_id := NEW.id::text||':confirmed:'||NEW.updated_at::text;
  else
    return null;
  end if;
  -- Deferred trigger: include the final contact details and items from the whole transaction.
  select * into latest from public.bookings where id=NEW.id;
  if not found or latest.status <> NEW.status then return null; end if;
  select * into member_record from public.members where id=latest.member_id;
  select string_agg(service_title||' × '||quantity,E'\n' order by created_at,id)
    into items from public.booking_items where booking_id=NEW.id;
  contact := coalesce(nullif(latest.contact_surname,''),member_record.display_name,'會員')||
    case latest.contact_salutation when 'mr' then '先生' when 'ms' then '小姐' else '' end;
  details := E'\n預約編號：'||NEW.id::text||E'\n預約人：'||contact||
    E'\n日期：'||to_char(latest.booking_date,'YYYY/MM/DD')||
    E'\n時段：'||left(latest.start_time::text,5)||'–'||left(latest.end_time::text,5)||'（台北時間）'||
    E'\n項目：\n'||coalesce(items,'請至預約頁查看');
  if event_kind='created' then
    insert into booking_notifications.outbox(booking_id,event_key,channel,recipient,message_text)
      select NEW.id,event_id,'admin',line_user_id,
        left('【新預約・待確認】'||details,3800)||
        E'\n請開啟管理端確認預約：\nhttps://liff.line.me/2010791619-vhevCvvD'
      from public.admins where status='active' and role='admin' and line_user_id ~ '^U[0-9a-f]{32}$'
      on conflict (event_key,channel,recipient) do nothing;
  elsif member_record.line_user_id ~ '^U[0-9a-f]{32}$' then
    insert into booking_notifications.outbox(booking_id,event_key,channel,recipient,message_text)
      values(NEW.id,event_id,'member',member_record.line_user_id,
        left('【預約已確認】'||details,3800)||
        E'\n您的預約已由管理員確認，請依預約時間到場。\n查看預約：\nhttps://liff.line.me/2010787602-sgiB0ETj')
      on conflict (event_key,channel,recipient) do nothing;
  end if;
  begin
    perform booking_notifications.dispatch(20);
  exception when others then
    -- The durable outbox remains available for cron; delivery errors cannot undo a booking.
    null;
  end;
  return null;
end;
$$;

revoke all on all functions in schema booking_notifications from public,anon,authenticated,service_role;
create constraint trigger bookings_enqueue_line_notification
  after insert or update on public.bookings deferrable initially deferred
  for each row execute function booking_notifications.enqueue();
select cron.schedule('dispatch-booking-line-notifications','* * * * *','select booking_notifications.dispatch(20);');
-- Enable config only after channel tokens and recipient mapping have been verified.
