-- Presence is a *lease*, not a permanent login flag. LINE may close a
-- WebView without delivering pagehide / visibilitychange / sendBeacon.
-- Member login tokens are NOT revoked by a presence timeout.
--
-- The API considers a session online only if its last heartbeat is within
-- PRESENCE_ONLINE_WINDOW_MS (90 seconds). Keep this DB timeout in sync.
create or replace function public.expire_member_presence_sessions()
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  expired_count integer := 0;
begin
  update public.member_presence_sessions as presence
     set offline_at = presence.last_seen_at + interval '90 seconds',
         offline_reason = 'heartbeat_timeout',
         updated_at = now()
   where presence.offline_at is null
     and presence.last_seen_at < now() - interval '90 seconds'
     and not exists (
       select 1 from public.member_removal_jobs as removal
        where removal.member_id = presence.member_id
          and removal.state = 'deleting'
     );
  get diagnostics expired_count = row_count;
  return expired_count;
end
$function$;

-- Only the database scheduler/privileged roles may run this maintenance RPC.
revoke all on function public.expire_member_presence_sessions()
  from public, anon, authenticated;
grant execute on function public.expire_member_presence_sessions() to postgres;

-- Retain existing test-mode invalidations; additionally notify admin when
-- any member actually becomes online/offline. Heartbeats do NOT produce events.
create or replace function public.notify_test_presence_realtime_change()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_member_id uuid := coalesce(new.member_id, old.member_id);
begin
  if tg_op = 'UPDATE' and old.offline_at is not distinct from new.offline_at then
    return null;
  end if;

  perform public.emit_realtime_invalidation(
    array['admin'], 'member.presence.changed'
  );
  if exists (
    select 1 from public.members as m
    where m.id = v_member_id and m.is_test_account = true
  ) then
    perform public.emit_realtime_invalidation(
      array['all'], 'test_mode.presence.changed'
    );
  end if;
  return null;
end
$function$;

-- pg_cron is already enabled in this project; 30-second cadence shortens
-- the delay after an undelivered WebView-close beacon.
select cron.schedule(
  'expire-member-presence-sessions',
  '30 seconds',
  'select public.expire_member_presence_sessions();'
);
