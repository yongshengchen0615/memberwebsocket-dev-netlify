begin;

alter table public.point_card_settings
  drop constraint if exists point_card_settings_max_tickets_per_redemption_check;
alter table public.point_card_settings
  add constraint point_card_settings_max_tickets_per_redemption_check
  check (max_tickets_per_redemption between 0 and 50);

alter table public.event_ticket_settings
  drop constraint if exists event_ticket_settings_max_tickets_per_redemption_check;
alter table public.event_ticket_settings
  add constraint event_ticket_settings_max_tickets_per_redemption_check
  check (max_tickets_per_redemption between 0 and 50);

alter table public.event_ticket_settings
  drop constraint if exists event_ticket_settings_max_tickets_per_day_check;
alter table public.event_ticket_settings
  add constraint event_ticket_settings_max_tickets_per_day_check
  check (max_tickets_per_day between 0 and 50);

comment on column public.point_card_settings.max_tickets_per_redemption
is 'Maximum point-card tickets per redemption; 0 means no business quantity limit.';

comment on column public.event_ticket_settings.max_tickets_per_redemption
is 'Compatibility event-ticket limit; 0 means no business quantity limit.';

comment on column public.event_ticket_settings.max_tickets_per_day
is 'Maximum event tickets per Asia/Taipei business date; 0 means no business quantity limit.';

do $migration$
declare
  v_definition text;
  v_before text;
  v_after text;
begin
  select pg_get_functiondef('public.redeem_point_tickets(text,text[],text)'::regprocedure)
    into v_definition;
  v_before := 'if cardinality(p_ticket_ids) > v_global_max_tickets then raise exception ''TICKET_BATCH_LIMIT_EXCEEDED''; end if;';
  v_after := 'if v_global_max_tickets > 0 and cardinality(p_ticket_ids) > v_global_max_tickets then raise exception ''TICKET_BATCH_LIMIT_EXCEEDED''; end if;';
  if position(v_before in v_definition) = 0 then
    raise exception 'UNLIMITED_TICKET_MIGRATION_POINT_PATTERN_MISSING';
  end if;
  execute replace(v_definition, v_before, v_after);

  select pg_get_functiondef('public.count_today_usable_event_tickets(text)'::regprocedure)
    into v_definition;
  v_before := 'v_remaining_today := greatest(v_max_tickets - v_used_today_count, 0);';
  v_after := 'if v_max_tickets = 0 then
    v_remaining_today := v_available_count;
  else
    v_remaining_today := greatest(v_max_tickets - v_used_today_count, 0);
  end if;';
  if position(v_before in v_definition) = 0 then
    raise exception 'UNLIMITED_TICKET_MIGRATION_EVENT_COUNT_PATTERN_MISSING';
  end if;
  execute replace(v_definition, v_before, v_after);

  select pg_get_functiondef('public.redeem_event_ticket(text,text,jsonb)'::regprocedure)
    into v_definition;
  v_before := 'if v_used_today_count >= v_max_tickets then';
  v_after := 'if v_max_tickets > 0 and v_used_today_count >= v_max_tickets then';
  if position(v_before in v_definition) = 0 then
    raise exception 'UNLIMITED_TICKET_MIGRATION_EVENT_SINGLE_LIMIT_PATTERN_MISSING';
  end if;
  v_definition := replace(v_definition, v_before, v_after);
  v_before := '''remainingTodayCount'',greatest(v_max_tickets - (v_used_today_count + 1),0)';
  v_after := '''remainingTodayCount'',case when v_max_tickets = 0 then null else greatest(v_max_tickets - (v_used_today_count + 1),0) end';
  if position(v_before in v_definition) = 0 then
    raise exception 'UNLIMITED_TICKET_MIGRATION_EVENT_SINGLE_REMAINING_PATTERN_MISSING';
  end if;
  execute replace(v_definition, v_before, v_after);

  select pg_get_functiondef('public.redeem_event_tickets_with_location(text,text[],text,jsonb)'::regprocedure)
    into v_definition;
  v_before := 'if v_used_today_count + cardinality(p_claim_ids) > v_max_tickets then';
  v_after := 'if v_max_tickets > 0 and v_used_today_count + cardinality(p_claim_ids) > v_max_tickets then';
  if position(v_before in v_definition) = 0 then
    raise exception 'UNLIMITED_TICKET_MIGRATION_EVENT_BATCH_LIMIT_PATTERN_MISSING';
  end if;
  v_definition := replace(v_definition, v_before, v_after);
  v_before := '''remainingTodayCount'',greatest(v_max_tickets - (v_used_today_count + v_processed),0)';
  v_after := '''remainingTodayCount'',case when v_max_tickets = 0 then null else greatest(v_max_tickets - (v_used_today_count + v_processed),0) end';
  if position(v_before in v_definition) = 0 then
    raise exception 'UNLIMITED_TICKET_MIGRATION_EVENT_BATCH_REMAINING_PATTERN_MISSING';
  end if;
  execute replace(v_definition, v_before, v_after);
end
$migration$;

commit;
