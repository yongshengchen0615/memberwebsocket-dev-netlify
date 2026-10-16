alter table public.event_tickets
  add column if not exists activity_link_name text not null default '';

alter table public.event_tickets
  drop constraint if exists event_tickets_activity_link_name_check;

alter table public.event_tickets
  add constraint event_tickets_activity_link_name_check
  check (
    char_length(activity_link_name) <= 120
    and activity_link_name !~ '[[:cntrl:]]'
  );
