-- Existing and future tenants must expose the reminder text consumed by Edge.
-- Additive only: preserve merchant prose, booking choices, timestamps and grants.
begin;

create or replace function platform_private.install_booking_reminder_message(p_schema text)
returns void language plpgsql security definer set search_path = '' as $installer$
begin
  if p_schema !~ '^business_[0-9a-f]{32}$'
     or not exists(select 1 from platform_private.tenants where runtime_schema=p_schema) then
    raise exception 'BUSINESS_SCHEMA_INVALID';
  end if;
  if to_regclass(format('%I.booking_settings',p_schema)) is null then
    raise exception 'BOOKING_SETTINGS_MISSING_IN_BUSINESS_SCHEMA';
  end if;
  execute format('alter table %I.booking_settings add column if not exists reminder_message text not null default %L',
    p_schema,'請準時到場；如需調整請至預約頁操作。');
  if not exists(select 1 from pg_catalog.pg_constraint
    where conrelid=to_regclass(format('%I.booking_settings',p_schema))
      and conname='booking_reminder_message_length_check') then
    execute format('alter table %I.booking_settings add constraint booking_reminder_message_length_check check (char_length(reminder_message) between 1 and 400)',p_schema);
  end if;
end $installer$;
revoke all on function platform_private.install_booking_reminder_message(text) from public,anon,authenticated;
grant execute on function platform_private.install_booking_reminder_message(text) to service_role;

-- Keep the current installer and all of its authorization/transaction adapters.
-- Fail closed if its expected insertion point has changed; never replace the
-- newer booking/receipt RPCs merely to repair an existing settings column.
do $upgrade$
declare
  v_definition text;
  v_schema text;
  v_anchor constant text := '  select not exists (';
  v_call constant text := '  perform platform_private.install_booking_reminder_message(p_schema);';
begin
  select pg_get_functiondef('platform_private.install_booking_reminder(text)'::regprocedure)
    into strict v_definition;
  if position(v_call in v_definition)=0 then
    if (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor) <> 1 then
      raise exception 'BOOKING_REMINDER_INSTALLER_CONTRACT_CHANGED';
    end if;
    execute replace(v_definition,v_anchor,v_call||E'\n\n'||v_anchor);
  end if;
  for v_schema in select runtime_schema from platform_private.tenants
    where runtime_schema is not null
  loop
    perform platform_private.install_booking_reminder_message(v_schema);
  end loop;
end $upgrade$;
notify pgrst,'reload schema';
commit;
