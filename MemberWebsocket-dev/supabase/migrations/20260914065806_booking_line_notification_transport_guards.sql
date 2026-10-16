-- Keep channel credentials in queued pg_net requests inaccessible to client roles.
revoke select on net.http_request_queue from public, anon, authenticated;

-- LINE counts UTF-16 units; cap text conservatively even for all-emoji service names.
alter table booking_notifications.outbox drop constraint outbox_message_text_check;
alter table booking_notifications.outbox add constraint outbox_message_text_check check (char_length(message_text) between 1 and 2400);

create or replace function booking_notifications.enqueue()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  event_kind text;
  event_id text;
  member_record public.members%rowtype;
  latest public.bookings%rowtype;
  items text;
  details text;
  contact text;
begin
  if TG_OP='INSERT' then
    if NEW.status <> 'pending' then return null; end if;
    event_kind := 'created';
    event_id := NEW.id::text||':created';
  elsif OLD.status='pending' and NEW.status='confirmed' then
    event_kind := 'confirmed';
    event_id := NEW.id::text||':confirmed:'||NEW.updated_at::text;
  else
    return null;
  end if;
  -- Deferred trigger: include the final contact details and items from the whole transaction.
  select * into latest from public.bookings where id=NEW.id;
  if not found or latest.status <> NEW.status then return null; end if;
  select * into member_record from public.members where id=latest.member_id;
  select string_agg(service_title||' × '||quantity,E'\n' order by created_at,id)
    into items from public.booking_items where booking_id=NEW.id;
  contact := coalesce(nullif(latest.contact_surname,''),member_record.display_name,'會員')||
    case latest.contact_salutation when 'mr' then '先生' when 'ms' then '小姐' else '' end;
  details := E'\n預約編號：'||NEW.id::text||E'\n預約人：'||contact||
    E'\n日期：'||to_char(latest.booking_date,'YYYY/MM/DD')||
    E'\n時段：'||left(latest.start_time::text,5)||'–'||left(latest.end_time::text,5)||'（台北時間）'||
    E'\n項目：\n'||coalesce(items,'請至預約頁查看');
  if event_kind='created' then
    insert into booking_notifications.outbox(booking_id,event_key,channel,recipient,message_text)
      select NEW.id,event_id,'admin',line_user_id,
        left('【新預約・待確認】'||details,2200)||
        E'\n請開啟管理端確認預約：\nhttps://liff.line.me/2010791619-vhevCvvD'
      from public.admins where status='active' and role='admin' and line_user_id ~ '^U[0-9a-f]{32}$'
      on conflict (event_key,channel,recipient) do nothing;
  elsif member_record.line_user_id ~ '^U[0-9a-f]{32}$' then
    insert into booking_notifications.outbox(booking_id,event_key,channel,recipient,message_text)
      values(NEW.id,event_id,'member',member_record.line_user_id,
        left('【預約已確認】'||details,2200)||
        E'\n您的預約已由管理員確認，請依預約時間到場。\n查看預約：\nhttps://liff.line.me/2010787602-sgiB0ETj')
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
$$;
