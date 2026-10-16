create index if not exists birthday_benefit_grants_event_ticket_idx
  on public.birthday_benefit_grants(event_ticket_id)
  where event_ticket_id is not null;
