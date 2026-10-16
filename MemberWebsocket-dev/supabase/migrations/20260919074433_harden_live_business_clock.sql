do $migration$
declare
  v_oid oid;
  v_def text;
  v_next text;
begin
  -- Event claim: evaluate the business date only after the event row lock is held.
  select p.oid into strict v_oid
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='claim_event_ticket'
    and pg_get_function_identity_arguments(p.oid)='p_line_user_id text, p_event_ticket_id text';
  v_def := pg_get_functiondef(v_oid);
  v_next := replace(v_def,
    'v_today date := (now() at time zone ''Asia/Taipei'')::date;',
    'v_today date;');
  if v_next = v_def then raise exception 'claim_event_ticket declaration drift'; end if;
  v_def := v_next;
  v_next := replace(v_def,
    'if not found or v_event.status <> ''active'' then raise exception ''EVENT_TICKET_NOT_AVAILABLE''; end if;',
    'if not found or v_event.status <> ''active'' then raise exception ''EVENT_TICKET_NOT_AVAILABLE''; end if;' || E'\n  ' ||
    'v_today := (clock_timestamp() at time zone ''Asia/Taipei'')::date;');
  if v_next = v_def then raise exception 'claim_event_ticket lock point drift'; end if;
  execute v_next;

  -- Event redemption: same rule, after the event row lock.
  select p.oid into strict v_oid
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='redeem_event_ticket'
    and pg_get_function_identity_arguments(p.oid)='p_line_user_id text, p_claim_id text';
  v_def := pg_get_functiondef(v_oid);
  v_next := replace(v_def,
    'v_today date := (now() at time zone ''Asia/Taipei'')::date;',
    'v_today date;');
  if v_next = v_def then raise exception 'redeem_event_ticket declaration drift'; end if;
  v_def := v_next;
  v_next := replace(v_def,
    'if not found or v_event.status <> ''active'' then raise exception ''EVENT_TICKET_NOT_AVAILABLE''; end if;',
    'if not found or v_event.status <> ''active'' then raise exception ''EVENT_TICKET_NOT_AVAILABLE''; end if;' || E'\n  ' ||
    'v_today := (clock_timestamp() at time zone ''Asia/Taipei'')::date;');
  if v_next = v_def then raise exception 'redeem_event_ticket lock point drift'; end if;
  execute v_next;

  -- Point-ticket expiry must be checked against wall clock after card locks.
  for v_oid in
    select p.oid
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('redeem_point_ticket','redeem_point_tickets')
  loop
    v_def := pg_get_functiondef(v_oid);
    v_next := replace(v_def,
      '(now() at time zone ''Asia/Taipei'')::date',
      '(clock_timestamp() at time zone ''Asia/Taipei'')::date');
    if v_next = v_def then raise exception 'point redemption clock replacement drift for %', v_oid; end if;
    execute v_next;
  end loop;

  -- Point grant card-expiry check executes after the member/card locks.
  select p.oid into strict v_oid
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='grant_member_benefits';
  v_def := pg_get_functiondef(v_oid);
  v_next := replace(v_def,
    '(now() at time zone ''Asia/Taipei'')::date',
    '(clock_timestamp() at time zone ''Asia/Taipei'')::date');
  if v_next = v_def then raise exception 'grant_member_benefits clock replacement drift'; end if;
  execute v_next;

  -- Calendar bonus business date is captured only after the member row lock.
  select p.oid into strict v_oid
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='grant_member_benefits_with_event_bonus';
  v_def := pg_get_functiondef(v_oid);
  v_next := replace(v_def,
    'v_today date := (now() at time zone ''Asia/Taipei'')::date;',
    'v_today date;');
  if v_next = v_def then raise exception 'grant bonus declaration drift'; end if;
  v_def := v_next;
  v_next := replace(v_def,
    'if not found then' || E'\n    ' || 'raise exception ''MEMBER_NOT_FOUND'';' || E'\n  ' || 'end if;',
    'if not found then' || E'\n    ' || 'raise exception ''MEMBER_NOT_FOUND'';' || E'\n  ' || 'end if;' ||
    E'\n\n  ' || 'v_today := (clock_timestamp() at time zone ''Asia/Taipei'')::date;');
  if v_next = v_def then raise exception 'grant bonus member lock point drift'; end if;
  execute v_next;

  -- Trigger-driven fixed-ticket evaluation should use the wall clock at trigger time.
  for v_oid in
    select p.oid
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'backfill_fixed_tickets_for_member',
      'reevaluate_fixed_tickets_for_member',
      'reevaluate_fixed_tickets_for_member_profile'
    )
  loop
    v_def := pg_get_functiondef(v_oid);
    v_next := replace(v_def,
      '(now() at time zone ''Asia/Taipei'')::date',
      '(clock_timestamp() at time zone ''Asia/Taipei'')::date');
    if v_next = v_def then raise exception 'fixed-ticket clock replacement drift for %', v_oid; end if;
    execute v_next;
  end loop;
end;
$migration$;
