-- AC-BPN-001..006: official-account pending booking notice, per-merchant template.
-- Additive migration. Do not change existing admin/frontdesk/confirmation notifications.

alter table public.booking_settings
  add column if not exists pending_message text not null
  default '我們已收到您的預約申請，請等待管理員確認；確認後會再透過 LINE 通知您。';
alter table public.booking_settings
  drop constraint if exists booking_pending_message_length_check;
alter table public.booking_settings
  add constraint booking_pending_message_length_check
  check (char_length(btrim(pending_message)) between 1 and 400);

-- The trigger runs only for a real member-origin pending INSERT.
-- SECURITY DEFINER is necessary for writing the private outbox. Never expose this as an RPC.
create or replace function platform_private.enqueue_member_pending_booking()
returns trigger language plpgsql security definer set search_path='' as $pending$
declare
  v_schema text := TG_TABLE_SCHEMA;
  v_outbox_schema text;
  v_line_user_id text;
  v_surname text;
  v_salutation text;
  v_contact text;
  v_notice text;
  v_message text;
begin
  if TG_OP <> 'INSERT' or NEW.status <> 'pending'
     -- Online member booking APIs use BOOK-* request keys. Contact source
     -- identifies whose phone/name is used and may legitimately be 'custom'.
     -- Phone, receipt and staff-created records have different provenance.
     or NEW.member_id is null or NEW.request_id !~ '^BOOK-[A-Za-z0-9-]{8,95}
    return null;
  end if;

  if v_schema <> 'public'
     and (v_schema !~ '^business_[0-9a-f]{32}$'
       or not exists(select 1 from platform_private.tenants where runtime_schema=v_schema)) then
    raise exception 'BOOKING_NOTICE_SCHEMA_INVALID';
  end if;

  execute format(
    'select line_user_id,surname,salutation from %I.members where id=$1 and status=''active'' and coalesce(is_test_account,false)=false',
    v_schema
  ) into v_line_user_id,v_surname,v_salutation using NEW.member_id;
  if v_line_user_id is null or v_line_user_id !~ '^U[0-9a-f]{32}$' then
    return null;
  end if;

  execute format('select pending_message from %I.booking_settings where id=1',v_schema)
    into v_notice;
  if nullif(btrim(coalesce(v_notice,'')),'') is null then
    v_notice := '我們已收到您的預約申請，請等待管理員確認；確認後會再透過 LINE 通知您。';
  end if;
  v_notice := replace(replace(btrim(v_notice),E'\r\n',E'\n'),E'\r',E'\n');

  v_contact := coalesce(nullif(btrim(NEW.contact_surname),''),
                        nullif(btrim(v_surname),''),'會員')
    || case coalesce(nullif(NEW.contact_salutation,''),v_salutation,'')
       when 'mr' then '先生' when 'ms' then '小姐' else '' end;
  v_message :=
    '【預約申請】' ||
    E'\n狀態：等待管理員確認預約' ||
    E'\n日期：' || to_char(NEW.booking_date,'YYYY/MM/DD') ||
    E'\n時段：' || to_char(coalesce(NEW.start_at,NEW.booking_date + NEW.start_time),'YYYY/MM/DD HH24:MI') ||
    '–' || to_char(coalesce(NEW.end_at,NEW.booking_date + NEW.end_time),'YYYY/MM/DD HH24:MI') || '（台北時間）' ||
    E'\n預約人：' || v_contact ||
    E'\n預約人數：' || greatest(coalesce(NEW.party_size,1),1)::text || ' 位' ||
    E'\n預約編號：' || NEW.id::text ||
    E'\n提醒事項：' || replace(v_notice,E'\n',E'\n提醒事項：');

  v_outbox_schema := case when v_schema='public' then 'booking_notifications' else v_schema end;
  execute format(
    'insert into %I.%I(booking_id,event_key,channel,recipient,message_text)
      values ($1,$2,''member'',$3,$4)
      on conflict (event_key,channel,recipient) do nothing',
    v_outbox_schema,
    case when v_schema='public' then 'outbox' else 'notice_outbox' end
  ) using NEW.id,NEW.id::text||':created:member',v_line_user_id,left(v_message,2200);
  return null;
end $pending$;
revoke all on function platform_private.enqueue_member_pending_booking() from public,anon,authenticated;

drop trigger if exists bookings_enqueue_member_pending_line_notice on public.bookings;
create trigger bookings_enqueue_member_pending_line_notice
  after insert on public.bookings for each row
  execute function platform_private.enqueue_member_pending_booking();

-- The versioned business provisioner calls install_booking_reminder for each
-- new tenant. Extend that installer rather than modifying existing tenant RPCs.
create or replace function platform_private.install_booking_pending_notice(p_schema text)
returns void language plpgsql security definer set search_path='' as $installer$
begin
  if p_schema !~ '^business_[0-9a-f]{32}$'
     or not exists(select 1 from platform_private.tenants where runtime_schema=p_schema) then
    raise exception 'BUSINESS_SCHEMA_INVALID';
  end if;
  if to_regclass(format('%I.booking_settings',p_schema)) is null
     or to_regclass(format('%I.bookings',p_schema)) is null
     or to_regclass(format('%I.notice_outbox',p_schema)) is null then
    raise exception 'BOOKING_PENDING_NOTICE_SCHEMA_MISSING';
  end if;

  execute format('alter table %I.booking_settings add column if not exists pending_message text not null default %L',
    p_schema,'我們已收到您的預約申請，請等待管理員確認；確認後會再透過 LINE 通知您。');
  if not exists(select 1 from pg_catalog.pg_constraint
    where conrelid=to_regclass(format('%I.booking_settings',p_schema))
      and conname='booking_pending_message_length_check') then
    execute format('alter table %I.booking_settings add constraint booking_pending_message_length_check check (char_length(btrim(pending_message)) between 1 and 400)',p_schema);
  end if;
  execute format('drop trigger if exists bookings_enqueue_member_pending_line_notice on %I.bookings',p_schema);
  execute format('create trigger bookings_enqueue_member_pending_line_notice after insert on %I.bookings for each row execute function platform_private.enqueue_member_pending_booking()',p_schema);
end $installer$;
revoke all on function platform_private.install_booking_pending_notice(text) from public,anon,authenticated;
grant execute on function platform_private.install_booking_pending_notice(text) to service_role;

do $upgrade$
declare
  v_definition text;
  v_schema text;
  v_anchor constant text := '  perform platform_private.install_booking_reminder_message(p_schema);';
  v_call constant text := '  perform platform_private.install_booking_pending_notice(p_schema);';
begin
  select pg_get_functiondef('platform_private.install_booking_reminder(text)'::regprocedure)
    into strict v_definition;
  if position(v_call in v_definition)=0 then
    if (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor) <> 1 then
      raise exception 'BOOKING_REMINDER_INSTALLER_CONTRACT_CHANGED';
    end if;
    execute replace(v_definition,v_anchor,v_anchor||E'\n'||v_call);
  end if;
  for v_schema in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
    perform platform_private.install_booking_pending_notice(v_schema);
  end loop;
end $upgrade$;

notify pgrst,'reload schema';
 then
    return null;
  end if;

  if v_schema <> 'public'
     and (v_schema !~ '^business_[0-9a-f]{32}$'
       or not exists(select 1 from platform_private.tenants where runtime_schema=v_schema)) then
    raise exception 'BOOKING_NOTICE_SCHEMA_INVALID';
  end if;

  execute format(
    'select line_user_id,surname,salutation from %I.members where id=$1 and status=''active'' and coalesce(is_test_account,false)=false',
    v_schema
  ) into v_line_user_id,v_surname,v_salutation using NEW.member_id;
  if v_line_user_id is null or v_line_user_id !~ '^U[0-9a-f]{32}$' then
    return null;
  end if;

  execute format('select pending_message from %I.booking_settings where id=1',v_schema)
    into v_notice;
  if nullif(btrim(coalesce(v_notice,'')),'') is null then
    v_notice := '我們已收到您的預約申請，請等待管理員確認；確認後會再透過 LINE 通知您。';
  end if;
  v_notice := replace(replace(btrim(v_notice),E'\r\n',E'\n'),E'\r',E'\n');

  v_contact := coalesce(nullif(btrim(NEW.contact_surname),''),
                        nullif(btrim(v_surname),''),'會員')
    || case coalesce(nullif(NEW.contact_salutation,''),v_salutation,'')
       when 'mr' then '先生' when 'ms' then '小姐' else '' end;
  v_message :=
    '【預約申請】' ||
    E'\n狀態：等待管理員確認預約' ||
    E'\n日期：' || to_char(NEW.booking_date,'YYYY/MM/DD') ||
    E'\n時段：' || to_char(coalesce(NEW.start_at,NEW.booking_date + NEW.start_time),'YYYY/MM/DD HH24:MI') ||
    '–' || to_char(coalesce(NEW.end_at,NEW.booking_date + NEW.end_time),'YYYY/MM/DD HH24:MI') || '（台北時間）' ||
    E'\n預約人：' || v_contact ||
    E'\n預約人數：' || greatest(coalesce(NEW.party_size,1),1)::text || ' 位' ||
    E'\n預約編號：' || NEW.id::text ||
    E'\n提醒事項：' || replace(v_notice,E'\n',E'\n提醒事項：');

  v_outbox_schema := case when v_schema='public' then 'booking_notifications' else v_schema end;
  execute format(
    'insert into %I.%I(booking_id,event_key,channel,recipient,message_text)
      values ($1,$2,''member'',$3,$4)
      on conflict (event_key,channel,recipient) do nothing',
    v_outbox_schema,
    case when v_schema='public' then 'outbox' else 'notice_outbox' end
  ) using NEW.id,NEW.id::text||':created:member',v_line_user_id,left(v_message,2200);
  return null;
end $pending$;
revoke all on function platform_private.enqueue_member_pending_booking() from public,anon,authenticated;

drop trigger if exists bookings_enqueue_member_pending_line_notice on public.bookings;
create trigger bookings_enqueue_member_pending_line_notice
  after insert on public.bookings for each row
  execute function platform_private.enqueue_member_pending_booking();

-- The versioned business provisioner calls install_booking_reminder for each
-- new tenant. Extend that installer rather than modifying existing tenant RPCs.
create or replace function platform_private.install_booking_pending_notice(p_schema text)
returns void language plpgsql security definer set search_path='' as $installer$
begin
  if p_schema !~ '^business_[0-9a-f]{32}$'
     or not exists(select 1 from platform_private.tenants where runtime_schema=p_schema) then
    raise exception 'BUSINESS_SCHEMA_INVALID';
  end if;
  if to_regclass(format('%I.booking_settings',p_schema)) is null
     or to_regclass(format('%I.bookings',p_schema)) is null
     or to_regclass(format('%I.notice_outbox',p_schema)) is null then
    raise exception 'BOOKING_PENDING_NOTICE_SCHEMA_MISSING';
  end if;

  execute format('alter table %I.booking_settings add column if not exists pending_message text not null default %L',
    p_schema,'我們已收到您的預約申請，請等待管理員確認；確認後會再透過 LINE 通知您。');
  if not exists(select 1 from pg_catalog.pg_constraint
    where conrelid=to_regclass(format('%I.booking_settings',p_schema))
      and conname='booking_pending_message_length_check') then
    execute format('alter table %I.booking_settings add constraint booking_pending_message_length_check check (char_length(btrim(pending_message)) between 1 and 400)',p_schema);
  end if;
  execute format('drop trigger if exists bookings_enqueue_member_pending_line_notice on %I.bookings',p_schema);
  execute format('create trigger bookings_enqueue_member_pending_line_notice after insert on %I.bookings for each row execute function platform_private.enqueue_member_pending_booking()',p_schema);
end $installer$;
revoke all on function platform_private.install_booking_pending_notice(text) from public,anon,authenticated;
grant execute on function platform_private.install_booking_pending_notice(text) to service_role;

do $upgrade$
declare
  v_definition text;
  v_schema text;
  v_anchor constant text := '  perform platform_private.install_booking_reminder_message(p_schema);';
  v_call constant text := '  perform platform_private.install_booking_pending_notice(p_schema);';
begin
  select pg_get_functiondef('platform_private.install_booking_reminder(text)'::regprocedure)
    into strict v_definition;
  if position(v_call in v_definition)=0 then
    if (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor) <> 1 then
      raise exception 'BOOKING_REMINDER_INSTALLER_CONTRACT_CHANGED';
    end if;
    execute replace(v_definition,v_anchor,v_anchor||E'\n'||v_call);
  end if;
  for v_schema in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
    perform platform_private.install_booking_pending_notice(v_schema);
  end loop;
end $upgrade$;

notify pgrst,'reload schema';
