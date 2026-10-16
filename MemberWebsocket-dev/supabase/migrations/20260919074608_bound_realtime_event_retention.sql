create or replace function public.prune_realtime_events()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  delete from public.realtime_events
  where created_at < clock_timestamp() - interval '7 days';
  return null;
end;
$function$;

drop trigger if exists realtime_events_prune_after_insert on public.realtime_events;
create trigger realtime_events_prune_after_insert
after insert on public.realtime_events
for each statement
execute function public.prune_realtime_events();

revoke all on function public.prune_realtime_events() from public, anon, authenticated;
grant execute on function public.prune_realtime_events() to service_role;
