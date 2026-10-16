create or replace function booking_notifications.enqueue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  event_kind text;
  event_id text;
  notification_coalesce_key text;
  mod_audit_id bigint;
  mod_actor_role text;
  mod_action text;
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
  if TG_OP = 'INSERT' then
    if NEW.status <> 'pending' then return null; end if;
    event_kind := 'created';
    event_id := NEW.id::text || ':created';
  elsif OLD.status = 'pending' and NEW.status = 'confirmed' then
    event_kind := 'confirmed';
    event_id := NEW.id::text || ':confirmed:' || NEW.updated_at::text;
  elsif NEW.status = 'completed' and OLD.status is distinct from NEW.status then
    event_kind := 'completed';
    event_id := NEW.id::text || ':completed:' || NEW.updated_at::text;
  elsif NEW.status = 'rejected' and OLD.status is distinct from NEW.status then
    event_kind := 'rejected';
    event_id := NEW.id::text || ':rejected:' || NEW.updated_at::text;
  elsif NEW.status = 'cancelled' and OLD.status is distinct from NEW.status then
    event_kind := 'cancelled';
    event_id := NEW.id::text || ':cancelled:' || NEW.updated_at::text;
  elsif OLD.cancellation_requested_at is null and NEW.cancellation_requested_at is not null and NEW.cancellation_reviewed_at is null then
    event_kind := 'cancellation_requested';
    event_id := NEW.id::text || ':cancellation_requested:' || NEW.updated_at::text;
  elsif OLD.cancellation_requested_at is not null and NEW.cancellation_requested_at is null and NEW.cancellation_decision = 'rejected' and NEW.cancellation_reviewed_at is not null then
    event_kind := 'cancellation_rejected';
    event_id := NEW.id::text || ':cancellation_rejected:' || NEW.updated_at::text;
  elsif OLD.status in ('pending','confirmed') and NEW.status in ('pending','confirmed') then
    select e.id, e.actor_role, e.action into mod_audit_id, mod_actor_role, mod_action
    from public.booking_audit_events e
    where e.target_type = 'booking'
      and e.target_id = NEW.id::text
      and e.created_at = NEW.updated_at
      and e.action in ('BOOKING_UPDATED','BOOKING_ITEMS_UPDATED')
    order by e.id desc
    limit 1;

    if mod_audit_id is null then return null; end if;

    if mod_actor_role = 'member' and mod_action = 'BOOKING_UPDATED' then
      event_kind := 'modified_by_member';
      notification_coalesce_key := NEW.id::text || ':modified_by_member';
    elsif mod_actor_role = 'admin' and mod_action = 'BOOKING_ITEMS_UPDATED' then
      event_kind := 'modified_by_admin';
      notification_coalesce_key := NEW.id::text || ':modified_by_admin';
    else
      return null;
    end if;
    event_id := NEW.id::text || ':modified:' || mod_audit_id::text;
  else
    return null;
  end if;

  select * into latest from public.bookings where id = NEW.id;
  if not found then return null; end if;

  if event_kind = 'confirmed' and latest.status <> 'confirmed' then return null; end if;
  if event_kind = 'completed' and latest.status <> 'completed' then return null; end if;
  if event_kind = 'rejected' and latest.status <> 'rejected' then return null; end if;
  if event_kind = 'cancelled' and latest.status <> 'cancelled' then return null; end if;

  if event_kind in ('confirmed','completed','rejected','cancelled') then
    update booking_notifications.outbox
      set status = 'skipped',
          last_error = 'Superseded by later booking state transition'
    where booking_id = NEW.id
      and status = 'pending'
      and attempt_count = 0
      and first_attempt_at is null
      and coalesce_key is not null;
  end if;

  select * into member_record from public.members where id = latest.member_id;

  select string_agg(bi.service_title, E'\n' order by bi.created_at, bi.id, copies.n)
    into items
  from public.booking_items bi
  cross join lateral generate_series(1, greatest(coalesce(bi.quantity, 1), 1)) as copies(n)
  where bi.booking_id = NEW.id
    and bi.service_id <> '00000000-0000-4000-8000-000000000010'::uuid;

  contact := coalesce(nullif(latest.contact_surname,''), member_record.display_name, '會員') ||
    case latest.contact_salutation when 'mr' then '先生' when 'ms' then '小姐' else '' end;
  phone := coalesce(nullif(latest.contact_phone,''), nullif(member_record.phone,''), '未提供');

  admin_details :=
    '預約編號：' || NEW.id::text ||
    E'\n預約人：' || contact ||
    E'\n日期：' || to_char(latest.booking_date,'YYYY/MM/DD') ||
    E'\n時段：' || left(latest.start_time::text,5) || '–' || left(latest.end_time::text,5) || '（台北時間）' ||
    E'\n電話：' || phone ||
    E'\n預約項目：\n' || coalesce(items,'請至預約頁查看');

  member_details :=
    '預約人：' || contact ||
    E'\n日期：' || to_char(latest.booking_date,'YYYY/MM/DD') ||
    E'\n時段：' || left(latest.start_time::text,5) || '–' || left(latest.end_time::text,5) || '（台北時間）' ||
    E'\n電話：' || phone ||
    E'\n預約項目：\n' || coalesce(items,'請至預約頁查看');

  if event_kind in ('created','modified_by_member','cancellation_requested') then
    admin_message := case event_kind
      when 'created' then '【預約】'
      when 'modified_by_member' then '【修改預約】'
      when 'cancellation_requested' then '【取消預約申請】'
    end || E'\n' || admin_details;

    if event_kind = 'modified_by_member' then
      insert into booking_notifications.outbox(
        booking_id,event_key,channel,recipient,message_text,coalesce_key,next_attempt_at
      )
        select NEW.id,event_id,'admin',line_user_id,left(admin_message,2200),notification_coalesce_key,now()+interval '15 seconds'
        from public.admins
        where status='active' and role='admin' and line_user_id ~ '^U[0-9a-f]{32}$'
      on conflict (coalesce_key,channel,recipient)
        where status='pending' and attempt_count=0 and first_attempt_at is null and coalesce_key is not null
      do update set
        event_key = excluded.event_key,
        message_text = excluded.message_text,
        next_attempt_at = excluded.next_attempt_at,
        last_error = null;
    else
      insert into booking_notifications.outbox(booking_id,event_key,channel,recipient,message_text)
        select NEW.id,event_id,'admin',line_user_id,left(admin_message,2200)
        from public.admins
        where status='active' and role='admin' and line_user_id ~ '^U[0-9a-f]{32}$'
        on conflict (event_key,channel,recipient) do nothing;
    end if;

  elsif event_kind in ('confirmed','modified_by_admin','completed','rejected','cancelled','cancellation_rejected') then
    if member_record.line_user_id ~ '^U[0-9a-f]{32}$' then
      member_message := case event_kind
        when 'confirmed' then '【預約確認】'
        when 'modified_by_admin' then '【修改預約】'
        when 'completed' then '【完成服務】'
        when 'rejected' then '【預約未通過】'
        when 'cancelled' then '【預約取消】'
        when 'cancellation_rejected' then '【取消申請未通過】'
      end || E'\n' || member_details;

      if event_kind = 'modified_by_admin' then
        insert into booking_notifications.outbox(
          booking_id,event_key,channel,recipient,message_text,coalesce_key,next_attempt_at
        ) values(
          NEW.id,event_id,'member',member_record.line_user_id,left(member_message,2200),notification_coalesce_key,now()+interval '15 seconds'
        )
        on conflict (coalesce_key,channel,recipient)
          where status='pending' and attempt_count=0 and first_attempt_at is null and coalesce_key is not null
        do update set
          event_key = excluded.event_key,
          message_text = excluded.message_text,
          next_attempt_at = excluded.next_attempt_at,
          last_error = null;
      else
        insert into booking_notifications.outbox(booking_id,event_key,channel,recipient,message_text)
          values(NEW.id,event_id,'member',member_record.line_user_id,left(member_message,2200))
          on conflict (event_key,channel,recipient) do nothing;
      end if;
    end if;
  end if;

  begin
    perform booking_notifications.dispatch(20);
  exception when others then
    null;
  end;

  return null;
end;
$function$;
