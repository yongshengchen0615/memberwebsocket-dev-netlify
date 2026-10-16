-- Realtime invalidation events are append-only cache invalidation signals.
-- Retention must not run on every insert statement because that adds write-path latency.
-- Keep a bounded seven-day history with one scheduled, index-backed prune per hour.

drop trigger if exists realtime_events_prune_after_insert on public.realtime_events;
drop function if exists public.prune_realtime_events();

create function public.prune_realtime_events()
returns bigint
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  deleted_count bigint := 0;
begin
  delete from public.realtime_events
  where created_at < clock_timestamp() - interval '7 days';

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$function$;

revoke all on function public.prune_realtime_events() from public, anon, authenticated;
grant execute on function public.prune_realtime_events() to service_role;

-- Make the migration safe to re-apply in ephemeral/test environments.
select cron.unschedule('realtime-events-retention-hourly')
where exists (
  select 1
  from cron.job
  where jobname = 'realtime-events-retention-hourly'
);

select cron.schedule(
  'realtime-events-retention-hourly',
  '17 * * * *',
  $cron$select public.prune_realtime_events();$cron$
);
