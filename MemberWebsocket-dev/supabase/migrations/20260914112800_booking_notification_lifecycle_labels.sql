create or replace function booking_notifications.enqueue()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  event_kind text;
  event_id text;
  member_record public.members%rowtype;
  latest public.bookings%rowtype;
  items text;
  contact text;
  phone text;
  admin_details text;
  member_details text;
  admin_message text;
  member_message text;
begin
  if TG_OP='INSERT' then
    if NEW.status <> 'pending' then return null; end if;
    event_kind := 'created';
    event_id := NEW.id::text||':created';
  elsif OLD.status='pending' and NEW.status='confirmed' then
    event_kind := 'confirmed';
    event_id := NEW.id::text||':confirmed:'||NEW.updated_at::text;
  elsif NEW.status='completed' and OLD.status is distinct from NEW.status then
    event_kind := 'completed';
    event_id := NEW.id::text||':completed:'||NEW.updated_at::text;
  elsif OLD.status in ('pending','confirmed') and NEW.status in ('pending','confirmed') then
    event_kind := 'modified';
    event_id := NEW.id::text||':modified:'||NEW.updated_at::text;
  else
    return null;
  end if;

  -- Deferred trigger: read the final booking/contact/items state from the whole transaction.
  select * into latest from public.bookings where id=NEW.id;
  if not found or latest.status <> NEW.status then return null; end if;

  select * into member_record from public.members where id=latest.member_id;

  select string_agg(bi.service_title, E'\n' order by bi.created_at, bi.id, copies.n)
    into items
  from public.booking_items bi
  cross join lateral generate_series(1, greatest(coalesce(bi.quantity, 1), 1)) as copies(n)
  where bi.booking_id=NEW.id
    and bi.service_id <> '00000000-0000-4000-8000-000000000010'::uuid;

  contact := coalesce(nullif(latest.contact_surname,''), member_record.display_name, '會員') ||
    case latest.contact_salutation when 'mr' then '先生' when 'ms' then '小姐' else '' end;
  phone := coalesce(nullif(latest.contact_phone,''), nullif(member_record.phone,''), '未提供');

  admin_details :=
    '預約編號：'||NEW.id::text||
    E'\n預約人：'||contact||
    E'\n日期：'||to_char(latest.booking_date,'YYYY/MM/DD')||
    E'\n時段：'||left(latest.start_time::text,5)||'–'||left(latest.end_time::text,5)||'（台北時間）'||
    E'\n電話：'||phone||
    E'\n預約項目：\n'||coalesce(items,'請至預約頁查看');

  member_details :=
    '預約人：'||contact||
    E'\n日期：'||to_char(latest.booking_date,'YYYY/MM/DD')||
    E'\n時段：'||left(latest.start_time::text,5)||'–'||left(latest.end_time::text,5)||'（台北時間）'||
    E'\n電話：'||phone||
    E'\n預約項目：\n'||coalesce(items,'請至預約頁查看');

  if event_kind='created' then
    admin_message := '【預約】'||E'\n'||admin_details;
    insert into booking_notifications.outbox(booking_id,event_key,channel,recipient,message_text)
      select NEW.id,event_id,'admin',line_user_id,left(admin_message,2200)
      from public.admins
      where status='active' and role='admin' and line_user_id ~ '^U[0-9a-f]{32}$'
      on conflict (event_key,channel,recipient) do nothing;

  elsif event_kind='confirmed' then
    if member_record.line_user_id ~ '^U[0-9a-f]{32}$' then
      member_message := '【預約確認】'||E'\n'||member_details;
      insert into booking_notifications.outbox(booking_id,event_key,channel,recipient,message_text)
        values(NEW.id,event_id,'member',member_record.line_user_id,left(member_message,2200))
        on conflict (event_key,channel,recipient) do nothing;
    end if;

  elsif event_kind='modified' then
    admin_message := '【修改預約】'||E'\n'||admin_details;
    insert into booking_notifications.outbox(booking_id,event_key,channel,recipient,message_text)
      select NEW.id,event_id,'admin',line_user_id,left(admin_message,2200)
      from public.admins
      where status='active' and role='admin' and line_user_id ~ '^U[0-9a-f]{32}$'
      on conflict (event_key,channel,recipient) do nothing;

    if member_record.line_user_id ~ '^U[0-9a-f]{32}$' then
      member_message := '【修改預約】'||E'\n'||member_details;
      insert into booking_notifications.outbox(booking_id,event_key,channel,recipient,message_text)
        values(NEW.id,event_id,'member',member_record.line_user_id,left(member_message,2200))
        on conflict (event_key,channel,recipient) do nothing;
    end if;

  elsif event_kind='completed' and member_record.line_user_id ~ '^U[0-9a-f]{32}$' then
    member_message := '【完成服務】'||E'\n'||member_details;
    insert into booking_notifications.outbox(booking_id,event_key,channel,recipient,message_text)
      values(NEW.id,event_id,'member',member_record.line_user_id,left(member_message,2200))
      on conflict (event_key,channel,recipient) do nothing;
  end if;

  begin
    perform booking_notifications.dispatch(20);
  exception when others then
    -- The durable outbox remains available for cron; delivery errors cannot undo a booking.
    null;
  end;

  return null;
end;
$function$;
