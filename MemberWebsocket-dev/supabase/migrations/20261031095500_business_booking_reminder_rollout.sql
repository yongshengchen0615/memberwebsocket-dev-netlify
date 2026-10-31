-- AC-010..AC-014: synchronize booking reminder contract into every isolated business schema.
-- Existing merchant schemas are independent PostgreSQL schemas, not views over public.
-- This installer is idempotent: only first install backfills legacy policy.
create or replace function platform_private.install_booking_reminder(p_schema text)
returns void
language plpgsql security definer set search_path = '' as $installer$
declare
  v_new boolean;
  v_def text;
  v_fn record;
  v_sync oid;
  v_guard oid;
begin
  if p_schema !~ '^business_[0-9a-f]{32}$'
     or not exists (select 1 from platform_private.tenants t where t.runtime_schema = p_schema) then
    raise exception 'BUSINESS_SCHEMA_INVALID';
  end if;
  if to_regclass(format('%I.bookings',p_schema)) is null
     or to_regclass(format('%I.notice_outbox',p_schema)) is null
     or to_regclass(format('%I.notice_config',p_schema)) is null then
    raise exception 'BUSINESS_REMINDER_SCHEMA_MISSING';
  end if;

  select not exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = to_regclass(format('%I.bookings',p_schema))
      and a.attname = 'reminder_enabled' and not a.attisdropped
  ) into v_new;

  execute format('alter table %I.bookings add column if not exists reminder_enabled boolean not null default false',p_schema);
  execute format('alter table %I.bookings add column if not exists reminder_time time without time zone not null default time ''18:00''',p_schema);

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid=to_regclass(format('%I.bookings',p_schema))
      and conname='bookings_reminder_minute_check'
  ) then
    execute format('alter table %I.bookings add constraint bookings_reminder_minute_check check (extract(second from reminder_time)=0)',p_schema);
  end if;

  if v_new then
    execute format($backfill$
      update %1$I.bookings b set reminder_enabled=s.reminder_enabled,reminder_time=s.reminder_time
      from %1$I.booking_settings s where s.id=1 and b.status='confirmed'
        and b.start_at::date > (now() at time zone 'Asia/Taipei')::date
    $backfill$,p_schema);
  end if;

  -- Copy the already-tested public transactional adapters, binding ALL relations and
  -- called RPCs to this tenant, not to public. Expose only to Edge service_role.
  for v_fn in select p.oid,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) args
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'create_booking_bundle_with_benefits_reminder',
      'update_booking_bundle_with_benefits_reminder',
      'create_booking_bundle_with_contact_reminder',
      'update_booking_bundle_with_contact_reminder',
      'create_group_booking_with_benefits_reminder_v2',
      'update_group_booking_with_benefits_reminder_v2',
      'create_friend_booking_with_reminder'
    )
  loop
    v_def := replace(pg_catalog.pg_get_functiondef(v_fn.oid), 'public.', format('%I.',p_schema));
    execute v_def;
    execute format('revoke all on function %I.%I(%s) from public,anon,authenticated',p_schema,v_fn.proname,v_fn.args);
    execute format('grant execute on function %I.%I(%s) to service_role',p_schema,v_fn.proname,v_fn.args);
  end loop;

  -- Tenant notice_outbox/notice_config are scoped, unlike root booking_notifications.
  select p.oid into strict v_sync from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   where n.nspname='booking_notifications' and p.proname='sync_day_before_reminders';
  v_def := pg_catalog.pg_get_functiondef(v_sync);
  v_def := replace(v_def,'booking_notifications.sync_day_before_reminders',format('%I.notice_sync_day_before_reminders',p_schema));
  v_def := replace(v_def,'booking_notifications.outbox',format('%I.notice_outbox',p_schema));
  v_def := replace(v_def,'booking_notifications.config',format('%I.notice_config',p_schema));
  v_def := replace(v_def,'public.',format('%I.',p_schema));
  execute v_def;
  execute format('revoke all on function %I.notice_sync_day_before_reminders() from public,anon,authenticated',p_schema);
  execute format('grant execute on function %I.notice_sync_day_before_reminders() to service_role',p_schema);

  select p.oid into strict v_guard from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='skip_invalid_booking_reminder';
  v_def := pg_catalog.pg_get_functiondef(v_guard);
  v_def := replace(v_def,'booking_notifications.outbox',format('%I.notice_outbox',p_schema));
  v_def := replace(v_def,'booking_notifications.config',format('%I.notice_config',p_schema));
  v_def := replace(v_def,'public.',format('%I.',p_schema));
  execute v_def;
  execute format('revoke all on function %I.skip_invalid_booking_reminder(uuid,integer) from public,anon,authenticated',p_schema);
  execute format('grant execute on function %I.skip_invalid_booking_reminder(uuid,integer) to service_role',p_schema);
end $installer$;
revoke all on function platform_private.install_booking_reminder(text) from public,anon,authenticated;
grant execute on function platform_private.install_booking_reminder(text) to service_role;

-- Upgrade existing tenants. Future tenants get exactly the same install after
-- the existing provisioning base + member-invitations hooks have run.
do $tenants$
declare v record;
begin
  for v in select runtime_schema from platform_private.tenants
    where runtime_schema is not null
  loop
    perform platform_private.install_booking_reminder(v.runtime_schema);
  end loop;
end $tenants$;

create or replace function public.platform_provision_business(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = '' as $provision$
declare v_schema text;
begin
  perform public.platform_provision_business_base_20261028_invitation(p_tenant_id);
  select runtime_schema into strict v_schema from platform_private.tenants where id=p_tenant_id;
  perform platform_private.install_member_invitations(v_schema);
  perform platform_private.install_booking_reminder(v_schema);
end $provision$;
revoke all on function public.platform_provision_business(uuid) from public,anon,authenticated;
grant execute on function public.platform_provision_business(uuid) to service_role;

-- Isolated booking-only tick: do not reactivate the broad platform cron because
-- it also issues unrelated tickets and cleans realtime records.
create or replace function public.platform_tick_booking_reminders()
returns integer
language plpgsql security definer set search_path = '' as $tick$
declare t record; processed integer := 0;
begin
  for t in select id,runtime_schema from platform_private.tenants
    where status='active' and runtime_schema is not null
      and features->>'booking'='true'
      and (expires_at is null or expires_at>clock_timestamp())
  loop
    begin
      execute format('select %I.notice_sync_day_before_reminders()',t.runtime_schema);
      perform public.platform_dispatch_booking(t.id);
      processed := processed + 1;
    exception when others then
      insert into platform_private.audit_events(actor,tenant_id,action,detail)
      values ('system',t.id,'BOOKING_REMINDER_TICK_FAILED',pg_catalog.jsonb_build_object('sqlstate',sqlstate));
    end;
  end loop;
  return processed;
end $tick$;
revoke all on function public.platform_tick_booking_reminders() from public,anon,authenticated;
grant execute on function public.platform_tick_booking_reminders() to service_role;

select cron.schedule('platform-booking-reminders','* * * * *',
  'select public.platform_tick_booking_reminders();');
