-- Reject implausible member phone numbers and keep new-booking chat messages member-sent.
-- Existing obviously invalid phones are cleared so the member must enter a valid number again.

update public.members
set phone = null,
    updated_at = now()
where nullif(btrim(phone), '') is not null
  and (
    phone !~ '^\+[1-9][0-9]{7,14}$'
    or phone ~ '([0-9])\1{6,}'
    or (phone like '+886%' and phone !~ '^\+886(9[0-9]{8}|[2-8][0-9]{7,8})$')
  );

alter table public.members
  drop constraint if exists members_phone_quality_check;

alter table public.members
  add constraint members_phone_quality_check
  check (
    phone is null
    or btrim(phone) = ''
    or (
      phone ~ '^\+[1-9][0-9]{7,14}$'
      and phone !~ '([0-9])\1{6,}'
      and (phone !~ '^\+886' or phone ~ '^\+886(9[0-9]{8}|[2-8][0-9]{7,8})$')
    )
  );

CREATE OR REPLACE FUNCTION public.accept_membership_terms(p_line_user_id text, p_terms_id uuid, p_version text, p_accepted boolean, p_birthday date DEFAULT NULL::date, p_phone text DEFAULT NULL::text, p_surname text DEFAULT NULL::text, p_salutation text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_member public.members%rowtype; v_terms public.membership_terms%rowtype; v_join boolean;
begin
 if p_accepted is distinct from true then raise exception 'TERMS_CONSENT_REQUIRED'; end if;
 select * into v_member from public.members where line_user_id=p_line_user_id for update;
 if not found or v_member.status <> 'active' then raise exception 'MEMBER_NOT_FOUND'; end if;
 select * into v_terms from public.membership_terms where status='active' for share;
 if not found then raise exception 'TERMS_UNAVAILABLE'; end if;
 if v_terms.id is distinct from p_terms_id or v_terms.version is distinct from p_version or not v_terms.required or v_terms.effective_at > now() then
   raise exception 'TERMS_VERSION_STALE';
 end if;
 v_join := v_member.membership_status <> 'active';
 if v_join and (p_birthday is null or p_birthday > current_date or p_birthday < date '1900-01-01'
     or p_phone !~ '^\+[1-9][0-9]{7,14}$'
     or p_phone ~ '([0-9])\1{6,}'
     or (p_phone like '+886%' and p_phone !~ '^\+886(9[0-9]{8}|[2-8][0-9]{7,8})$')
     or length(btrim(coalesce(p_surname,''))) not between 1 and 40
     or p_salutation not in ('mr','ms')) then raise exception 'INVALID_PROFILE'; end if;
 insert into public.membership_consents(member_id,terms_id) values(v_member.id,v_terms.id) on conflict (member_id,terms_id) do nothing;
 if v_join then
   update public.members set birthday=p_birthday,phone=p_phone,surname=btrim(p_surname),salutation=p_salutation,
      membership_status='active',joined_at=coalesce(joined_at,now()),updated_at=now() where id=v_member.id;
 end if;
 insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
 values('AUD-'||replace(gen_random_uuid()::text,'-',''),p_line_user_id,'member',
        case when v_join then 'MEMBERSHIP_JOIN_CONSENT' else 'MEMBERSHIP_TERMS_RECONSENT' end,
        'member',v_member.id::text,'success',jsonb_build_object('termsId',v_terms.id,'version',v_terms.version));
 return v_join;
end $function$
;

CREATE OR REPLACE FUNCTION booking_notifications.enqueue()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  participant_details text;
  fallback_technician text;
  store_service_minutes integer := 0;
  fallback_service_minutes integer := 0;
  fallback_amount bigint := 0;
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

  select coalesce(sum(
      bi.unit_duration_minutes * greatest(coalesce(bi.quantity, 1), 1)
    ), 0)::integer
    into store_service_minutes
  from public.booking_items bi
  where bi.booking_id = NEW.id
    and bi.service_id = '00000000-0000-4000-8000-000000000010'::uuid;

  select string_agg(
      case bp.position
        when 1 then '第一位預約'
        when 2 then '第二位預約'
        when 3 then '第三位預約'
        when 4 then '第四位預約'
        when 5 then '第五位預約'
        when 6 then '第六位預約'
        when 7 then '第七位預約'
        when 8 then '第八位預約'
        when 9 then '第九位預約'
        when 10 then '第十位預約'
        else '第 ' || bp.position::text || ' 位預約'
      end ||
      E'\n預約項目：' || coalesce(nullif(participant_items.items, ''), '請至預約頁查看') ||
      E'\n個別時間：' ||
        (coalesce(participant_items.service_minutes, 0) + store_service_minutes)::text || ' 分鐘' ||
        case when store_service_minutes > 0
          then '（含店內服務 ' || store_service_minutes::text || ' 分鐘）'
          else ''
        end ||
      E'\n個別金額：NT$' || to_char(coalesce(participant_items.amount, 0), 'FM999,999,999,990') ||
      E'\n預約技師：' || coalesce(nullif(bt.name, ''), '現場安排'),
      E'\n\n' order by bp.position
    )
    into participant_details
  from public.booking_participants bp
  left join public.booking_technicians bt on bt.id = bp.technician_id
  left join lateral (
    select
      string_agg(
        bpi.service_title ||
          case when greatest(coalesce(bpi.quantity, 1), 1) > 1
            then ' × ' || greatest(coalesce(bpi.quantity, 1), 1)::text
            else ''
          end,
        '、' order by bpi.created_at, bpi.id
      ) as items,
      coalesce(sum(
        bpi.unit_duration_minutes * greatest(coalesce(bpi.quantity, 1), 1)
      ), 0)::integer as service_minutes,
      coalesce(sum(
        bpi.unit_price_amount * greatest(coalesce(bpi.quantity, 1), 1)
      ), 0)::bigint as amount
    from public.booking_participant_items bpi
    where bpi.participant_id = bp.id
  ) participant_items on true
  where bp.booking_id = NEW.id;

  -- Legacy single-person bookings may predate booking_participants.
  if nullif(participant_details, '') is null then
    select
      string_agg(
        bi.service_title ||
          case when greatest(coalesce(bi.quantity, 1), 1) > 1
            then ' × ' || greatest(coalesce(bi.quantity, 1), 1)::text
            else ''
          end,
        '、' order by bi.created_at, bi.id
      ),
      coalesce(sum(
        bi.unit_duration_minutes * greatest(coalesce(bi.quantity, 1), 1)
      ), 0)::integer,
      coalesce(sum(
        bi.unit_price_amount * greatest(coalesce(bi.quantity, 1), 1)
      ), 0)::bigint
      into items, fallback_service_minutes, fallback_amount
    from public.booking_items bi
    where bi.booking_id = NEW.id
      and bi.service_id <> '00000000-0000-4000-8000-000000000010'::uuid;

    select bt.name
      into fallback_technician
    from public.booking_technicians bt
    where bt.id = latest.technician_id;

    participant_details :=
      '第一位預約' ||
      E'\n預約項目：' || coalesce(nullif(items, ''), '請至預約頁查看') ||
      E'\n個別時間：' || (fallback_service_minutes + store_service_minutes)::text || ' 分鐘' ||
        case when store_service_minutes > 0
          then '（含店內服務 ' || store_service_minutes::text || ' 分鐘）'
          else ''
        end ||
      E'\n個別金額：NT$' || to_char(fallback_amount, 'FM999,999,999,990') ||
      E'\n預約技師：' || coalesce(nullif(fallback_technician, ''), '現場安排');
  end if;

  contact := coalesce(nullif(latest.contact_surname,''), nullif(member_record.surname,''), '會員') ||
    case coalesce(nullif(latest.contact_salutation,''), nullif(member_record.salutation,''), '')
      when 'mr' then '先生'
      when 'ms' then '小姐'
      else ''
    end;
  phone := coalesce(nullif(latest.contact_phone,''), nullif(member_record.phone,''), '未提供');

  admin_details :=
    '預約編號：' || NEW.id::text ||
    E'\n預約人：' || contact ||
    E'\n營業日：' || to_char(latest.booking_date,'YYYY/MM/DD') ||
    E'\n時段：' || to_char(latest.start_at,'YYYY/MM/DD HH24:MI') || '–' || to_char(latest.end_at,'YYYY/MM/DD HH24:MI') || '（台北時間）' ||
    E'\n電話：' || phone ||
    E'\n預約人數：' || greatest(coalesce(latest.party_size, 1), 1)::text || ' 位' ||
    case
      when nullif(btrim(latest.member_note), '') is not null
        then E'\n會員備註：' || regexp_replace(btrim(latest.member_note), E'[\r\n]+', ' ', 'g')
      else ''
    end ||
    case
      when nullif(btrim(latest.admin_note), '') is not null
        then E'\n管理端說明：' || regexp_replace(btrim(latest.admin_note), E'[\r\n]+', ' ', 'g')
      else ''
    end ||
    E'\n\n' || coalesce(participant_details,'請至預約頁查看');

  member_details :=
    '預約人：' || contact ||
    E'\n營業日：' || to_char(latest.booking_date,'YYYY/MM/DD') ||
    E'\n時段：' || to_char(latest.start_at,'YYYY/MM/DD HH24:MI') || '–' || to_char(latest.end_at,'YYYY/MM/DD HH24:MI') || '（台北時間）' ||
    E'\n電話：' || phone ||
    E'\n預約人數：' || greatest(coalesce(latest.party_size, 1), 1)::text || ' 位' ||
    case
      when nullif(btrim(latest.member_note), '') is not null
        then E'\n會員備註：' || regexp_replace(btrim(latest.member_note), E'[\r\n]+', ' ', 'g')
      else ''
    end ||
    case
      when nullif(btrim(latest.admin_note), '') is not null
        then E'\n管理端說明：' || regexp_replace(btrim(latest.admin_note), E'[\r\n]+', ' ', 'g')
      else ''
    end ||
    E'\n\n' || coalesce(participant_details,'請至預約頁查看');

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
$function$
;

notify pgrst, 'reload schema';
