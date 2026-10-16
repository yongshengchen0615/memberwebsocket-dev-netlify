alter table public.event_tickets
  add column if not exists activity_url text not null default '';

alter table public.event_tickets
  drop constraint if exists event_tickets_activity_url_check;

alter table public.event_tickets
  add constraint event_tickets_activity_url_check
  check (
    activity_url = ''
    or (
      char_length(activity_url) <= 2048
      and activity_url ~ '^https://[^[:space:]]+$'
    )
  );
