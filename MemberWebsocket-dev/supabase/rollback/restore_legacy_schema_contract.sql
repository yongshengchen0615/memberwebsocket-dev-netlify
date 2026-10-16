-- Emergency rollback only. Restore database compatibility before deploying old Edge bundles.
-- Current business data stays intact. Retired configuration is recreated disabled;
-- unused historical service fields are reconstructed from canonical settings/defaults.
begin;
set local lock_timeout='5s';
alter table public.event_tickets add column if not exists required_service_types text[] default '{}'::text[] not null;
alter table public.event_tickets add column if not exists redemption_latitude numeric;
alter table public.event_tickets add column if not exists redemption_longitude numeric;
alter table public.event_tickets add column if not exists redemption_radius_meters int4;
alter table public.point_card_rewards add column if not exists required_service_types text[] default '{}'::text[] not null;
alter table public.event_ticket_settings add column if not exists max_tickets_per_redemption int4 default 1 not null;
alter table public.test_mode_settings add column if not exists enabled bool default false not null;
alter table public.test_mode_settings add column if not exists allow_admin_user_login bool default false not null;
alter table public.booking_services add column if not exists work_start_time time default '09:00:00'::time without time zone not null;
alter table public.booking_services add column if not exists work_end_time time default '17:00:00'::time without time zone not null;
alter table public.booking_services add column if not exists slot_minutes int4 default 30 not null;
alter table public.booking_services add column if not exists min_advance_days int4 default 0 not null;
alter table public.booking_services add column if not exists available_weekdays smallint[] default ARRAY[(0)::smallint, (1)::smallint, (2)::smallint, (3)::smallint, (4)::smallint, (5)::smallint, (6)::smallint] not null;
update public.event_ticket_settings set max_tickets_per_redemption=max_tickets_per_day;
update public.event_tickets set redemption_latitude=(redemption_locations->0->>'latitude')::numeric, redemption_longitude=(redemption_locations->0->>'longitude')::numeric, redemption_radius_meters=(redemption_locations->0->>'radiusMeters')::integer where requires_location;
create table if not exists public.birthday_benefit_grants (id uuid not null default gen_random_uuid(), member_id uuid not null, benefit_year integer not null, benefit_month integer not null, event_ticket_id uuid, claim_id text, status text not null default 'reserved'::text, notified_at timestamp with time zone, notification_error text not null default ''::text, created_at timestamp with time zone not null default now(), updated_at timestamp with time zone not null default now());
alter table public.birthday_benefit_grants enable row level security;
revoke all on public.birthday_benefit_grants from public,anon,authenticated;
grant all on public.birthday_benefit_grants to service_role;
alter table public.birthday_benefit_grants add constraint birthday_benefit_grants_benefit_month_check CHECK (((benefit_month >= 1) AND (benefit_month <= 12)));
alter table public.birthday_benefit_grants add constraint birthday_benefit_grants_benefit_year_check CHECK (((benefit_year >= 2000) AND (benefit_year <= 2100)));
alter table public.birthday_benefit_grants add constraint birthday_benefit_grants_claim_id_key UNIQUE (claim_id);
alter table public.birthday_benefit_grants add constraint birthday_benefit_grants_event_ticket_id_fkey FOREIGN KEY (event_ticket_id) REFERENCES event_tickets(id) ON DELETE RESTRICT;
alter table public.birthday_benefit_grants add constraint birthday_benefit_grants_member_id_benefit_year_key UNIQUE (member_id, benefit_year);
alter table public.birthday_benefit_grants add constraint birthday_benefit_grants_member_id_fkey FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT;
alter table public.birthday_benefit_grants add constraint birthday_benefit_grants_pkey PRIMARY KEY (id);
alter table public.birthday_benefit_grants add constraint birthday_benefit_grants_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'issued'::text, 'failed'::text])));
create table if not exists public.birthday_benefit_settings (singleton boolean not null default true, enabled boolean not null default false, title_template text not null default '🎂 {month}月壽星專屬優惠'::text, description text not null default '生日快樂！這是你的當月專屬生日優惠。'::text, usage_method text not null default '使用時請出示本活動票券。'::text, usage_instructions text not null default '限本人於生日當月使用一次，逾期失效。'::text, accent text not null default '#df6b4d'::text, allowed_tier_keys text[] not null default ARRAY['general'::text, 'silver'::text, 'gold'::text, 'platinum'::text], notify_line boolean not null default true, updated_by text not null default 'system'::text, updated_at timestamp with time zone not null default now());
alter table public.birthday_benefit_settings enable row level security;
revoke all on public.birthday_benefit_settings from public,anon,authenticated;
grant all on public.birthday_benefit_settings to service_role;
alter table public.birthday_benefit_settings add constraint birthday_benefit_settings_accent_check CHECK ((accent ~ '^#[0-9A-Fa-f]{6}$'::text));
alter table public.birthday_benefit_settings add constraint birthday_benefit_settings_description_check CHECK (((char_length(description) >= 1) AND (char_length(description) <= 240)));
alter table public.birthday_benefit_settings add constraint birthday_benefit_settings_pkey PRIMARY KEY (singleton);
alter table public.birthday_benefit_settings add constraint birthday_benefit_settings_singleton_check CHECK (singleton);
alter table public.birthday_benefit_settings add constraint birthday_benefit_settings_title_template_check CHECK (((char_length(title_template) >= 1) AND (char_length(title_template) <= 100)));
alter table public.birthday_benefit_settings add constraint birthday_benefit_settings_usage_instructions_check CHECK (((char_length(usage_instructions) >= 1) AND (char_length(usage_instructions) <= 500)));
alter table public.birthday_benefit_settings add constraint birthday_benefit_settings_usage_method_check CHECK (((char_length(usage_method) >= 1) AND (char_length(usage_method) <= 120)));
CREATE OR REPLACE FUNCTION public.admin_delete_test_accounts(p_member_ids uuid[])
 RETURNS TABLE(deleted_account_count integer, total_test_accounts integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_requested_count integer := coalesce(cardinality(p_member_ids), 0);
  v_distinct_count integer := 0;
  v_matched_count integer := 0;
  v_deleted_count integer := 0;
  v_remaining_count integer := 0;
  v_line_user_ids text[] := array[]::text[];
  v_member_codes text[] := array[]::text[];
  v_member_id_texts text[] := array[]::text[];
  v_booking_ids uuid[] := array[]::uuid[];
  v_booking_id_texts text[] := array[]::text[];
begin
  if v_requested_count < 1 or v_requested_count > 200 then
    raise exception 'INVALID_TEST_ACCOUNT_DELETE_COUNT';
  end if;

  select count(distinct member_id)::integer
    into v_distinct_count
    from unnest(p_member_ids) as requested(member_id);

  if v_distinct_count <> v_requested_count then
    raise exception 'DUPLICATE_TEST_ACCOUNT_ID';
  end if;

  perform pg_advisory_xact_lock(2026092001);

  perform id
    from public.members
   where id = any(p_member_ids)
   for update;

  select
    count(*)::integer,
    coalesce(array_agg(line_user_id order by id) filter (where line_user_id is not null), array[]::text[]),
    coalesce(array_agg(member_code order by id) filter (where member_code is not null), array[]::text[]),
    coalesce(array_agg(id::text order by id), array[]::text[])
  into
    v_matched_count,
    v_line_user_ids,
    v_member_codes,
    v_member_id_texts
  from public.members
  where id = any(p_member_ids)
    and is_test_account = true;

  if v_matched_count <> v_requested_count then
    raise exception 'INVALID_TEST_ACCOUNT_SELECTION';
  end if;

  select
    coalesce(array_agg(id order by id), array[]::uuid[]),
    coalesce(array_agg(id::text order by id), array[]::text[])
  into
    v_booking_ids,
    v_booking_id_texts
  from public.bookings
  where member_id = any(p_member_ids);

  if exists (
    select 1
      from public.point_transfers t
      join public.members sender on sender.id = t.sender_member_id
      join public.members receiver on receiver.id = t.receiver_member_id
     where (t.sender_member_id = any(p_member_ids) or t.receiver_member_id = any(p_member_ids))
       and (sender.is_test_account is not true or receiver.is_test_account is not true)
  ) then
    raise exception 'TEST_DATA_CROSS_BOUNDARY_POINT_TRANSFER';
  end if;

  if exists (
    select 1
      from public.member_referrals r
      join public.members inviter on inviter.id = r.inviter_member_id
      join public.members invitee on invitee.id = r.invitee_member_id
     where (r.inviter_member_id = any(p_member_ids) or r.invitee_member_id = any(p_member_ids))
       and (inviter.is_test_account is not true or invitee.is_test_account is not true)
  ) then
    raise exception 'TEST_DATA_CROSS_BOUNDARY_REFERRAL';
  end if;

  delete from public.api_rate_limits
   where principal_hash = any (
     select encode(extensions.digest(line_user_id, 'sha256'), 'hex')
     from unnest(v_line_user_ids) as ids(line_user_id)
   );

  delete from public.idempotency_results
   where actor_line_user_id = any(v_line_user_ids)
      or exists (
        select 1
        from unnest(v_member_id_texts || v_member_codes || v_booking_id_texts || v_line_user_ids) as ids(value)
        where result::text like '%' || value || '%'
      );

  delete from public.booking_audit_events
   where actor_line_user_id = any(v_line_user_ids)
      or target_id = any(v_member_id_texts)
      or target_id = any(v_member_codes)
      or target_id = any(v_booking_id_texts)
      or exists (
        select 1
        from unnest(v_member_id_texts || v_member_codes || v_booking_id_texts || v_line_user_ids) as ids(value)
        where metadata::text like '%' || value || '%'
      );

  delete from public.audit_logs
   where actor_line_user_id = any(v_line_user_ids)
      or target_id = any(v_member_id_texts)
      or target_id = any(v_member_codes)
      or target_id = any(v_booking_id_texts)
      or exists (
        select 1
        from unnest(v_member_id_texts || v_member_codes || v_booking_id_texts || v_line_user_ids) as ids(value)
        where detail::text like '%' || value || '%'
      );

  delete from booking_notifications.outbox
   where booking_id = any(v_booking_ids);

  delete from public.booking_completion_settlements
   where member_id = any(p_member_ids)
      or booking_id = any(v_booking_ids);

  delete from public.member_referrals
   where inviter_member_id = any(p_member_ids)
      or invitee_member_id = any(p_member_ids);

  delete from public.point_transfers
   where sender_member_id = any(p_member_ids)
      or receiver_member_id = any(p_member_ids);

  delete from public.birthday_benefit_grants
   where member_id = any(p_member_ids);

  delete from public.event_ticket_claims
   where member_id = any(p_member_ids);

  delete from public.scheduled_grant_messages
   where member_id = any(p_member_ids)
      or line_user_id = any(v_line_user_ids);

  delete from public.point_tickets
   where member_id = any(p_member_ids);

  delete from public.point_entries
   where member_id = any(p_member_ids);

  delete from public.point_balances
   where member_id = any(p_member_ids);

  delete from public.service_time_entries
   where member_id = any(p_member_ids);

  delete from public.fixed_ticket_grants
   where member_id = any(p_member_ids);

  delete from public.bookings
   where member_id = any(p_member_ids);

  delete from public.test_login_sessions
   where member_id = any(p_member_ids);

  delete from public.members
   where id = any(p_member_ids)
     and is_test_account = true;

  get diagnostics v_deleted_count = row_count;

  if v_deleted_count <> v_requested_count then
    raise exception 'TEST_ACCOUNT_DELETE_MISMATCH';
  end if;

  select count(*)::integer
    into v_remaining_count
  from public.members
  where is_test_account = true;

  if v_remaining_count = 0 then
    perform setval('public.test_member_sequence', 1, false);
  end if;

  return query
  select v_deleted_count, v_remaining_count;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.admin_prepare_complex_e2e_fixtures(p_run_tag text, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tag text := upper(regexp_replace(coalesce(p_run_tag,''), '[^A-Za-z0-9_-]', '', 'g'));
  v_created_by text;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_coupon1 uuid;
  v_coupon2 uuid;
  v_lottery1 uuid;
  v_lottery2 uuid;
  v_card1 uuid;
  v_card2 uuid;
  v_type1 uuid;
  v_type2 uuid;
  v_type3 uuid;
  v_ticket_count int := 0;
  v_card_count int := 0;
  v_reward_count int := 0;
  v_event_count int := 0;
  v_calendar_count int := 0;
  v_fixed_count int := 0;
  v_booking_type_count int := 0;
  v_booking_service_count int := 0;
  v_technician_count int := 0;
  v_primary_technician_id uuid;
  v_existing_primary_technician_id uuid;
  v_booking_max_party_size int := 1;
  v_rows int := 0;
begin
  if length(v_tag) < 4 or length(v_tag) > 40 then
    raise exception 'INVALID_QA_RUN_TAG';
  end if;
  v_created_by := left('qa:e2e:' || lower(v_tag), 120);

  insert into public.ticket_templates(
    ticket_template_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,created_by,updated_by
  ) values
  ('QA-TPL-'||v_tag||'-C1','E2E QA 通用優惠券 '||v_tag,'coupon','跨端 E2E：一般優惠券。','出示後由測試流程核銷。','僅供測試帳號與自動化測試使用。','[]'::jsonb,'active',v_created_by,v_created_by)
  returning id into v_coupon1;
  v_ticket_count := v_ticket_count + 1;

  insert into public.ticket_templates(
    ticket_template_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,created_by,updated_by
  ) values
  ('QA-TPL-'||v_tag||'-C2','E2E QA 高節點優惠券 '||v_tag,'coupon','跨端 E2E：高點數節點優惠券。','達指定節點後核銷。','驗證不同集點節點與多票券映射。','[]'::jsonb,'active',v_created_by,v_created_by)
  returning id into v_coupon2;
  v_ticket_count := v_ticket_count + 1;

  insert into public.ticket_templates(
    ticket_template_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,created_by,updated_by
  ) values
  ('QA-TPL-'||v_tag||'-L1','E2E QA 多獎項抽獎券 '||v_tag,'lottery','跨端 E2E：多獎項抽獎。','開啟後執行抽獎。','驗證機率合計與核銷歷史。',
    jsonb_build_array(
      jsonb_build_object('prizeTitle','A級獎項','prizeDescription','高價值測試獎項','winRate',52.5),
      jsonb_build_object('prizeTitle','B級獎項','prizeDescription','中價值測試獎項','winRate',27.5),
      jsonb_build_object('prizeTitle','C級獎項','prizeDescription','一般測試獎項','winRate',15),
      jsonb_build_object('prizeTitle','安慰獎','prizeDescription','邊界比例測試','winRate',5)
    ),'active',v_created_by,v_created_by)
  returning id into v_lottery1;
  v_ticket_count := v_ticket_count + 1;

  insert into public.ticket_templates(
    ticket_template_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,created_by,updated_by
  ) values
  ('QA-TPL-'||v_tag||'-L2','E2E QA 雙獎項抽獎券 '||v_tag,'lottery','跨端 E2E：第二種抽獎組合。','開啟後執行抽獎。','驗證不同節點映射到不同抽獎券。',
    jsonb_build_array(
      jsonb_build_object('prizeTitle','主要獎項','prizeDescription','主要測試獎項','winRate',73),
      jsonb_build_object('prizeTitle','次要獎項','prizeDescription','次要測試獎項','winRate',27)
    ),'active',v_created_by,v_created_by)
  returning id into v_lottery2;
  v_ticket_count := v_ticket_count + 1;

  insert into public.point_cards(
    card_id,title,description,status,accent,style_key,expiry_mode,expires_on,sort_order,
    usage_method,usage_instructions,benefit_description,created_by,updated_by
  ) values (
    'QA-CARD-'||v_tag||'-MULTI','E2E QA 多節點集點卡 '||v_tag,'四個節點、優惠券與抽獎券混合。','active',
    '#E47845','forest','unlimited',null,9001,
    '管理端發點與真人用戶操作混合。','測試節點 2 / 5 / 13 / 21 點。','跨節點出票、核銷與 Realtime 驗證。',
    v_created_by,v_created_by
  ) returning id into v_card1;
  v_card_count := v_card_count + 1;

  insert into public.point_card_rewards(reward_id,point_card_id,threshold_stamps,ticket_template_id)
  values
    ('QA-RWD-'||v_tag||'-02',v_card1,2,v_coupon1),
    ('QA-RWD-'||v_tag||'-05',v_card1,5,v_lottery1),
    ('QA-RWD-'||v_tag||'-13',v_card1,13,v_coupon2),
    ('QA-RWD-'||v_tag||'-21',v_card1,21,v_lottery2);
  get diagnostics v_rows = row_count;
  v_reward_count := v_reward_count + v_rows;

  insert into public.point_cards(
    card_id,title,description,status,accent,style_key,expiry_mode,expires_on,sort_order,
    usage_method,usage_instructions,benefit_description,created_by,updated_by
  ) values (
    'QA-CARD-'||v_tag||'-DATE','E2E QA 日期限制集點卡 '||v_tag,'指定到期日與雙節點。','active',
    '#4C7A73','ocean','date',v_today + 37,9002,
    '測試日期限制集點。','到期日前可正常顯示與累積。','驗證到期日與節點資料同步。',
    v_created_by,v_created_by
  ) returning id into v_card2;
  v_card_count := v_card_count + 1;

  insert into public.point_card_rewards(reward_id,point_card_id,threshold_stamps,ticket_template_id)
  values
    ('QA-RWD-'||v_tag||'-D03',v_card2,3,v_coupon1),
    ('QA-RWD-'||v_tag||'-D08',v_card2,8,v_lottery2);
  get diagnostics v_rows = row_count;
  v_reward_count := v_reward_count + v_rows;

  insert into public.point_cards(
    card_id,title,description,status,accent,style_key,expiry_mode,expires_on,sort_order,
    usage_method,usage_instructions,benefit_description,created_by,updated_by
  ) values (
    'QA-CARD-'||v_tag||'-DRAFT','E2E QA 草稿集點卡 '||v_tag,'管理端可見、用戶端不應公開。','draft',
    '#777777','midnight','unlimited',null,9003,
    '草稿資料。','不可對正式會員公開。','驗證公開狀態邊界。',
    v_created_by,v_created_by
  );
  v_card_count := v_card_count + 1;

  insert into public.event_tickets(
    event_ticket_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,
    starts_on,ends_on,quota,accent,allowed_tier_keys,created_by,updated_by
  ) values
  ('QA-EVT-'||v_tag||'-NOW-ALL','E2E QA 進行中全階級活動 '||v_tag,'coupon','目前進行中的全階級活動。','會員領取後核銷。','驗證日期、配額與全階級可見性。','[]'::jsonb,'active',v_today-2,v_today+10,0,'#DF6B4D',array['general','silver','gold','platinum'],v_created_by,v_created_by),
  ('QA-EVT-'||v_tag||'-TODAY-G','E2E QA 當日一般會員活動 '||v_tag,'coupon','僅今天且一般會員可參加。','當日使用。','驗證單日日期邊界與會員階級。','[]'::jsonb,'active',v_today,v_today,7,'#3D7A69',array['general'],v_created_by,v_created_by),
  ('QA-EVT-'||v_tag||'-LOT-VIP','E2E QA VIP 抽獎活動 '||v_tag,'lottery','銀級以上進行中的抽獎活動。','領券後抽獎。','驗證抽獎、多階級與有限配額。',
    jsonb_build_array(
      jsonb_build_object('prizeTitle','VIP A','prizeDescription','VIP 測試獎項','winRate',61),
      jsonb_build_object('prizeTitle','VIP B','prizeDescription','VIP 次獎','winRate',29),
      jsonb_build_object('prizeTitle','VIP C','prizeDescription','VIP 邊界獎','winRate',10)
    ),'active',v_today-1,v_today+4,12,'#6B5B95',array['silver','gold','platinum'],v_created_by,v_created_by),
  ('QA-EVT-'||v_tag||'-FUTURE','E2E QA 未來白金活動 '||v_tag,'coupon','尚未開始的高階會員活動。','活動開始後使用。','驗證未來日期與高階會員限制。','[]'::jsonb,'active',v_today+7,v_today+21,30,'#8A6D3B',array['gold','platinum'],v_created_by,v_created_by),
  ('QA-EVT-'||v_tag||'-PAST','E2E QA 已過期活動 '||v_tag,'coupon','已結束但仍保留狀態資料。','不可再領取。','驗證過期日期邊界。','[]'::jsonb,'active',v_today-21,v_today-1,5,'#555555',array['general','silver','gold','platinum'],v_created_by,v_created_by),
  ('QA-EVT-'||v_tag||'-DRAFT','E2E QA 草稿抽獎活動 '||v_tag,'lottery','草稿狀態活動。','不可公開。','驗證草稿不可由用戶端領取。',
    jsonb_build_array(
      jsonb_build_object('prizeTitle','草稿 A','prizeDescription','草稿測試','winRate',50),
      jsonb_build_object('prizeTitle','草稿 B','prizeDescription','草稿測試','winRate',50)
    ),'draft',v_today+1,v_today+30,100,'#999999',array['general','silver','gold','platinum'],v_created_by,v_created_by);
  get diagnostics v_event_count = row_count;

  insert into public.calendar_items(
    calendar_item_id,title,item_type,description,starts_on,ends_on,status,accent,allowed_tier_keys,
    link_label,link_url,created_by,updated_by,bonus_points_enabled,bonus_points,audience_type,audience_month
  ) values
  ('QA-CAL-'||v_tag||'-HOL','E2E QA 今日公休日 '||v_tag,'holiday','驗證公休日與預約衝突。',v_today,v_today,'active','#B64E4E',array[]::text[],'','',v_created_by,v_created_by,false,0,'all',null),
  ('QA-CAL-'||v_tag||'-GEN','E2E QA 一般銀級活動 '||v_tag,'event','一般與銀級會員活動。',v_today,v_today+1,'active','#367C72',array['general','silver'],'查看測試活動','https://example.com/qa-event',v_created_by,v_created_by,true,3,'all',null),
  ('QA-CAL-'||v_tag||'-VIP','E2E QA 金白金多日活動 '||v_tag,'event','金級與白金會員的多日活動。',v_today+2,v_today+5,'active','#7A5E9A',array['gold','platinum'],'活動詳情','https://example.com/qa-vip',v_created_by,v_created_by,true,8,'all',null),
  ('QA-CAL-'||v_tag||'-FUT','E2E QA 未來全階級活動 '||v_tag,'event','未來日期活動。',v_today+14,v_today+18,'active','#C57B38',array['general','silver','gold','platinum'],'未來活動','https://example.com/qa-future',v_created_by,v_created_by,false,0,'all',null),
  ('QA-CAL-'||v_tag||'-ARC','E2E QA 已封存活動 '||v_tag,'event','歷史封存活動。',v_today-30,v_today-28,'archived','#777777',array['general','silver','gold','platinum'],'','',v_created_by,v_created_by,false,0,'all',null);
  get diagnostics v_calendar_count = row_count;

  insert into public.fixed_ticket_templates(
    fixed_ticket_id,title,description,usage_method,usage_instructions,status,schedule_type,schedule_month,schedule_day,schedule_weekday,
    quota,accent,allowed_tier_keys,notify_line,created_by,updated_by,expiry_mode,expiry_date,expiry_days,calendar_enabled
  ) values
  ('QA-FIX-'||v_tag||'-BDAY','E2E QA 生日月固定票券 '||v_tag,'生日月固定發放。','系統自動發放。','測試帳號不傳 LINE。','active','birthday_month',null,null,null,0,'#E47845',array['general','silver','gold','platinum'],false,v_created_by,v_created_by,'month_end',null,null,true),
  ('QA-FIX-'||v_tag||'-YEAR','E2E QA 每年高階固定票券 '||v_tag,'每年固定日期發放。','系統自動發放。','金級與白金會員測試。','active','yearly',extract(month from v_today)::int,least(extract(day from v_today)::int,28),null,50,'#8A6D3B',array['gold','platinum'],false,v_created_by,v_created_by,'fixed_date',v_today+90,null,true),
  ('QA-FIX-'||v_tag||'-MONTH','E2E QA 每月限期固定票券 '||v_tag,'每月固定日發放。','系統自動發放。','一般與銀級會員測試。','active','monthly',null,least(extract(day from v_today)::int,28),null,100,'#3D7A69',array['general','silver'],false,v_created_by,v_created_by,'days_after_issue',null,14,false),
  ('QA-FIX-'||v_tag||'-WEEK','E2E QA 每週固定票券 '||v_tag,'每週固定日發放。','系統自動發放。','驗證當週到期模式。','active','weekly',null,null,extract(isodow from v_today)::int,0,'#6B5B95',array['general','silver','gold','platinum'],false,v_created_by,v_created_by,'week_end',null,null,false);
  get diagnostics v_fixed_count = row_count;

  insert into public.booking_service_types(name,sort_order)
  values
    ('E2E QA 基礎服務 '||v_tag,901),
    ('E2E QA 加購服務 '||v_tag,902),
    ('E2E QA 長時數服務 '||v_tag,903);
  v_booking_type_count := 3;

  select id into v_type1 from public.booking_service_types where name='E2E QA 基礎服務 '||v_tag order by created_at desc limit 1;
  select id into v_type2 from public.booking_service_types where name='E2E QA 加購服務 '||v_tag order by created_at desc limit 1;
  select id into v_type3 from public.booking_service_types where name='E2E QA 長時數服務 '||v_tag order by created_at desc limit 1;

  insert into public.booking_service_type_rewards(service_type_id,point_card_id,minutes_per_point,created_by,updated_by)
  values
    (v_type1,v_card1,30,v_created_by,v_created_by),
    (v_type3,v_card2,75,v_created_by,v_created_by);

  insert into public.booking_services(
    title,description,work_start_time,work_end_time,slot_minutes,min_advance_days,available_weekdays,is_active,
    created_by,duration_minutes,price_amount,service_type,counts_toward_membership,requires_companion_service
  ) values
  ('E2E QA 標準主服務 '||v_tag,'30 分鐘計入會員階級。','09:00','18:00',30,0,array[1,2,3,4,5]::smallint[],true,v_created_by,30,880,'E2E QA 基礎服務 '||v_tag,true,false),
  ('E2E QA 加購短服務 '||v_tag,'必須搭配其他項目，不計會員階級。','09:30','17:30',30,1,array[2,3,4,5,6]::smallint[],true,v_created_by,15,260,'E2E QA 加購服務 '||v_tag,false,true),
  ('E2E QA 長時數主服務 '||v_tag,'跨多時段、計入會員階級。','10:00','20:00',30,2,array[0,1,3,5,6]::smallint[],true,v_created_by,120,2480,'E2E QA 長時數服務 '||v_tag,true,false),
  ('E2E QA 停用服務 '||v_tag,'管理端保留但用戶端不可預約。','09:00','12:00',30,0,array[1,2,3,4,5]::smallint[],false,v_created_by,45,999,'E2E QA 基礎服務 '||v_tag,true,false);
  get diagnostics v_booking_service_count = row_count;

  insert into public.booking_technicians(name,is_active,sort_order,created_by)
  values
    ('E2E QA 技師甲 '||v_tag,true,901,v_created_by),
    ('E2E QA 技師乙 '||v_tag,true,902,v_created_by),
    ('E2E QA 停用技師 '||v_tag,false,903,v_created_by);
  get diagnostics v_technician_count = row_count;

  select id into v_primary_technician_id
    from public.booking_technicians
   where name = 'E2E QA 技師甲 '||v_tag
     and is_active = true
   order by created_at desc
   limit 1;

  -- A paired E2E fixture must be self-contained. Always bind the current
  -- fixture's active technician as primary instead of silently reusing a
  -- technician created by an earlier retained QA run.
  select primary_technician_id
    into v_existing_primary_technician_id
    from public.booking_settings
   where id = 1;

  if not found then
    insert into public.booking_settings(id,max_party_size,primary_technician_id,updated_by)
    values (1,2,v_primary_technician_id,v_created_by);
  else
    update public.booking_settings
       set primary_technician_id = v_primary_technician_id,
           max_party_size = greatest(max_party_size,2),
           updated_by = v_created_by,
           updated_at = clock_timestamp()
     where id = 1;
  end if;

  select max_party_size into v_booking_max_party_size
    from public.booking_settings
   where id = 1;

  return jsonb_build_object(
    'runTag', v_tag,
    'createdBy', v_created_by,
    'today', v_today,
    'ticketTemplates', v_ticket_count,
    'pointCards', v_card_count,
    'pointRewardNodes', v_reward_count,
    'eventTickets', v_event_count,
    'calendarItems', v_calendar_count,
    'fixedTickets', v_fixed_count,
    'bookingServiceTypes', v_booking_type_count,
    'bookingServices', v_booking_service_count,
    'bookingTechnicians', v_technician_count,
    'primaryTechnicianId', coalesce((select primary_technician_id::text from public.booking_settings where id=1),''),
    'maxPartySize', v_booking_max_party_size,
    'coverage', jsonb_build_object(
      'ticketTypes', jsonb_build_array('coupon','lottery','fixed'),
      'fixedSchedules', jsonb_build_array('birthday_month','yearly','monthly','weekly'),
      'fixedExpiryModes', jsonb_build_array('month_end','week_end','days_after_issue','fixed_date'),
      'eventDateStates', jsonb_build_array('past','today','active-window','future'),
      'membershipTiers', jsonb_build_array('general','silver','gold','platinum'),
      'pointThresholds', jsonb_build_array(2,3,5,8,13,21),
      'bookingModes', jsonb_build_array('primary','companion','membership-counting','non-membership','inactive')
    )
  );
end
$function$
;
CREATE OR REPLACE FUNCTION public.admin_purge_test_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_test_member_ids uuid[] := array[]::uuid[];
  v_line_user_ids text[] := array[]::text[];
  v_member_codes text[] := array[]::text[];
  v_member_id_texts text[] := array[]::text[];
  v_booking_ids uuid[] := array[]::uuid[];
  v_booking_id_texts text[] := array[]::text[];
  v_test_account_count integer := 0;
  v_automation_run_count integer := 0;
  v_booking_count integer := 0;
  v_event_claim_count integer := 0;
  v_point_entry_count integer := 0;
  v_point_ticket_count integer := 0;
  v_point_balance_count integer := 0;
  v_point_transfer_count integer := 0;
  v_member_referral_count integer := 0;
  v_service_time_count integer := 0;
  v_fixed_grant_count integer := 0;
  v_birthday_grant_count integer := 0;
  v_session_count integer := 0;
  v_presence_count integer := 0;
  v_audit_count integer := 0;
  v_idempotency_count integer := 0;
  v_rate_limit_count integer := 0;
  v_scheduled_message_count integer := 0;
  v_qa_artifact_count integer := 0;
  v_rows integer := 0;
begin
  perform pg_advisory_xact_lock(2026092001);
  perform pg_advisory_xact_lock(2026092202);

  select
    count(*)::integer,
    coalesce(array_agg(id order by id), array[]::uuid[]),
    coalesce(array_agg(id::text order by id), array[]::text[]),
    coalesce(array_agg(line_user_id order by id) filter (where line_user_id is not null), array[]::text[]),
    coalesce(array_agg(member_code order by id) filter (where member_code is not null), array[]::text[])
  into
    v_test_account_count,
    v_test_member_ids,
    v_member_id_texts,
    v_line_user_ids,
    v_member_codes
  from public.members
  where is_test_account = true;

  perform id
    from public.members
   where id = any(v_test_member_ids)
   for update;

  select
    coalesce(array_agg(id order by id), array[]::uuid[]),
    coalesce(array_agg(id::text order by id), array[]::text[])
  into v_booking_ids, v_booking_id_texts
  from public.bookings
  where member_id = any(v_test_member_ids);

  if exists (
    select 1
      from public.point_transfers t
      join public.members sender on sender.id = t.sender_member_id
      join public.members receiver on receiver.id = t.receiver_member_id
     where (t.sender_member_id = any(v_test_member_ids) or t.receiver_member_id = any(v_test_member_ids))
       and (sender.is_test_account is not true or receiver.is_test_account is not true)
  ) then
    raise exception 'TEST_DATA_CROSS_BOUNDARY_POINT_TRANSFER';
  end if;

  if exists (
    select 1
      from public.member_referrals r
      join public.members inviter on inviter.id = r.inviter_member_id
      join public.members invitee on invitee.id = r.invitee_member_id
     where (r.inviter_member_id = any(v_test_member_ids) or r.invitee_member_id = any(v_test_member_ids))
       and (inviter.is_test_account is not true or invitee.is_test_account is not true)
  ) then
    raise exception 'TEST_DATA_CROSS_BOUNDARY_REFERRAL';
  end if;

  delete from public.automation_test_runs
   where environment = 'MemberWebsocket-dev';
  get diagnostics v_automation_run_count = row_count;

  delete from public.api_rate_limits
   where principal_hash = any (
     select encode(extensions.digest(line_user_id, 'sha256'), 'hex')
       from unnest(v_line_user_ids) as ids(line_user_id)
   );
  get diagnostics v_rate_limit_count = row_count;

  delete from public.idempotency_results
   where actor_line_user_id = any(v_line_user_ids)
      or exists (
        select 1
          from unnest(v_member_id_texts || v_member_codes || v_booking_id_texts || v_line_user_ids) as ids(value)
         where result::text like '%' || value || '%'
      );
  get diagnostics v_idempotency_count = row_count;

  delete from public.booking_audit_events
   where actor_line_user_id = any(v_line_user_ids)
      or target_id = any(v_member_id_texts)
      or target_id = any(v_member_codes)
      or target_id = any(v_booking_id_texts)
      or exists (
        select 1
          from unnest(v_member_id_texts || v_member_codes || v_booking_id_texts || v_line_user_ids) as ids(value)
         where metadata::text like '%' || value || '%'
      );
  get diagnostics v_rows = row_count;
  v_audit_count := v_audit_count + v_rows;

  delete from public.audit_logs
   where actor_line_user_id = any(v_line_user_ids)
      or target_id = any(v_member_id_texts)
      or target_id = any(v_member_codes)
      or target_id = any(v_booking_id_texts)
      or exists (
        select 1
          from unnest(v_member_id_texts || v_member_codes || v_booking_id_texts || v_line_user_ids) as ids(value)
         where detail::text like '%' || value || '%'
      );
  get diagnostics v_rows = row_count;
  v_audit_count := v_audit_count + v_rows;

  delete from booking_notifications.outbox
   where booking_id = any(v_booking_ids);

  delete from public.booking_completion_settlements
   where member_id = any(v_test_member_ids)
      or booking_id = any(v_booking_ids);

  delete from public.member_referrals
   where inviter_member_id = any(v_test_member_ids)
      or invitee_member_id = any(v_test_member_ids);
  get diagnostics v_member_referral_count = row_count;

  delete from public.point_transfers
   where sender_member_id = any(v_test_member_ids)
      or receiver_member_id = any(v_test_member_ids);
  get diagnostics v_point_transfer_count = row_count;

  delete from public.birthday_benefit_grants
   where member_id = any(v_test_member_ids);
  get diagnostics v_birthday_grant_count = row_count;

  delete from public.event_ticket_claims
   where member_id = any(v_test_member_ids);
  get diagnostics v_event_claim_count = row_count;

  delete from public.scheduled_grant_messages
   where member_id = any(v_test_member_ids)
      or line_user_id = any(v_line_user_ids);
  get diagnostics v_scheduled_message_count = row_count;

  delete from public.point_tickets
   where member_id = any(v_test_member_ids);
  get diagnostics v_point_ticket_count = row_count;

  delete from public.point_entries
   where member_id = any(v_test_member_ids);
  get diagnostics v_point_entry_count = row_count;

  delete from public.point_balances
   where member_id = any(v_test_member_ids);
  get diagnostics v_point_balance_count = row_count;

  delete from public.service_time_entries
   where member_id = any(v_test_member_ids);
  get diagnostics v_service_time_count = row_count;

  delete from public.fixed_ticket_grants
   where member_id = any(v_test_member_ids);
  get diagnostics v_fixed_grant_count = row_count;

  delete from public.bookings
   where member_id = any(v_test_member_ids);
  get diagnostics v_booking_count = row_count;

  delete from public.test_login_sessions
   where member_id = any(v_test_member_ids);
  get diagnostics v_session_count = row_count;

  delete from public.member_presence_sessions
   where member_id = any(v_test_member_ids);
  get diagnostics v_presence_count = row_count;

  delete from public.calendar_items c
   where c.created_by like 'qa:%'
     and not exists (
       select 1
         from public.event_ticket_claims claim
        where claim.event_ticket_id = c.source_event_ticket_id
          and not (claim.member_id = any(v_test_member_ids))
     );
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.event_tickets e
   where e.created_by like 'qa:%'
     and not exists (select 1 from public.event_ticket_claims c where c.event_ticket_id = e.id)
     and not exists (select 1 from public.fixed_ticket_grants g where g.event_ticket_id = e.id)
     and not exists (select 1 from public.birthday_benefit_grants g where g.event_ticket_id = e.id)
     and not exists (select 1 from public.member_referrals r where r.reward_event_ticket_id = e.id);
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.point_cards pc
   where pc.created_by like 'qa:%'
     and not exists (select 1 from public.point_entries e where e.point_card_id = pc.id)
     and not exists (select 1 from public.point_tickets t where t.point_card_id = pc.id)
     and not exists (select 1 from public.point_balances b where b.point_card_id = pc.id)
     and not exists (select 1 from public.point_transfers t where t.point_card_id = pc.id);
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.ticket_templates tt
   where tt.created_by like 'qa:%'
     and not exists (select 1 from public.point_card_rewards r where r.ticket_template_id = tt.id)
     and not exists (select 1 from public.point_tickets t where t.ticket_template_id = tt.id);
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  return jsonb_build_object(
    'testAccountCount', v_test_account_count,
    'deletedAutomationRuns', v_automation_run_count,
    'deletedBookings', v_booking_count,
    'deletedEventClaims', v_event_claim_count,
    'deletedPointEntries', v_point_entry_count,
    'deletedPointTickets', v_point_ticket_count,
    'deletedPointBalances', v_point_balance_count,
    'deletedPointTransfers', v_point_transfer_count,
    'deletedMemberReferrals', v_member_referral_count,
    'deletedServiceTimeEntries', v_service_time_count,
    'deletedFixedTicketGrants', v_fixed_grant_count,
    'deletedBirthdayBenefitGrants', v_birthday_grant_count,
    'deletedSessions', v_session_count,
    'deletedPresenceSessions', v_presence_count,
    'deletedAuditRows', v_audit_count,
    'deletedIdempotencyRows', v_idempotency_count,
    'deletedRateLimitRows', v_rate_limit_count,
    'deletedScheduledMessages', v_scheduled_message_count,
    'deletedQaArtifacts', v_qa_artifact_count
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.admin_save_maintenance_test_access(p_maintenance_enabled boolean, p_allow_pc_test_login boolean, p_allow_mobile_test_login boolean, p_maintenance_message text, p_updated_by text, p_add_account_count integer DEFAULT 0)
 RETURNS TABLE(created_account_count integer, total_test_accounts integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_count integer := coalesce(p_add_account_count, 0);
  v_message text := coalesce(p_maintenance_message, '');
  v_existing integer;
  v_seq bigint;
  v_i integer;
  v_was_maintenance boolean := false;
  v_transition_to_maintenance boolean := false;
  v_revoked_at timestamptz;
  v_surnames text[] := array['陳','林','黃','張','李','王','吳','劉','蔡','楊','許','鄭','謝','洪','郭','邱','曾','廖','賴','徐'];
  v_male_names text[] := array['志明','俊傑','冠宇','柏翰','家豪','承翰','宇翔','子豪','建宏','宗翰','彥廷','品睿'];
  v_female_names text[] := array['怡君','雅婷','欣怡','佳穎','郁婷','佩珊','詩涵','筱涵','雨柔','佳蓉','婉婷','思妤'];
  v_surname text;
  v_given_name text;
  v_salutation text;
  v_birthday date;
  v_phone text;
begin
  if v_count < 0 or v_count > 50 then
    raise exception 'INVALID_TEST_ACCOUNT_COUNT';
  end if;
  if char_length(v_message) > 500 then
    raise exception 'INVALID_MAINTENANCE_MESSAGE';
  end if;

  perform pg_advisory_xact_lock(2026092001);

  select coalesce(maintenance_enabled, false)
    into v_was_maintenance
    from public.test_mode_settings
   where id = true;

  v_transition_to_maintenance :=
    not coalesce(v_was_maintenance, false)
    and coalesce(p_maintenance_enabled, false);
  if v_transition_to_maintenance then
    v_revoked_at := clock_timestamp();
  end if;

  select count(*)::integer into v_existing
  from public.members
  where is_test_account = true;

  if v_existing + v_count > 200 then
    raise exception 'TEST_ACCOUNT_LIMIT_REACHED';
  end if;

  insert into public.test_mode_settings (
    id, enabled, allow_admin_user_login, maintenance_enabled,
    allow_pc_test_login, allow_mobile_test_login, maintenance_message,
    maintenance_revoked_after, updated_by, updated_at
  )
  values (
    true, true, true,
    coalesce(p_maintenance_enabled, false),
    coalesce(p_allow_pc_test_login, false),
    coalesce(p_allow_mobile_test_login, false),
    v_message,
    case when v_transition_to_maintenance then v_revoked_at else null end,
    nullif(btrim(coalesce(p_updated_by, '')), ''),
    now()
  )
  on conflict (id) do update set
    enabled = true,
    allow_admin_user_login = true,
    maintenance_enabled = excluded.maintenance_enabled,
    allow_pc_test_login = excluded.allow_pc_test_login,
    allow_mobile_test_login = excluded.allow_mobile_test_login,
    maintenance_message = excluded.maintenance_message,
    maintenance_revoked_after = case
      when v_transition_to_maintenance then v_revoked_at
      else public.test_mode_settings.maintenance_revoked_after
    end,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  if v_transition_to_maintenance then
    update public.test_login_sessions
       set revoked_at = coalesce(revoked_at, v_revoked_at),
           last_used_at = v_revoked_at
     where revoked_at is null;

    update public.member_presence_sessions
       set last_seen_at = v_revoked_at,
           offline_at = v_revoked_at,
           offline_reason = 'maintenance',
           updated_at = v_revoked_at
     where offline_at is null;
  elsif not coalesce(p_maintenance_enabled, false) then
    update public.test_login_sessions
       set revoked_at = coalesce(revoked_at, now())
     where revoked_at is null;
  else
    if not coalesce(p_allow_pc_test_login, false) then
      update public.test_login_sessions
         set revoked_at = coalesce(revoked_at, now())
       where revoked_at is null
         and device_class = 'pc';
    end if;
    if not coalesce(p_allow_mobile_test_login, false) then
      update public.test_login_sessions
         set revoked_at = coalesce(revoked_at, now())
       where revoked_at is null
         and device_class = 'mobile';
    end if;
  end if;

  for v_i in 1..v_count loop
    v_seq := nextval('public.test_member_sequence');
    v_salutation := case when random() < 0.5 then 'mr' else 'ms' end;
    v_surname := v_surnames[1 + floor(random() * array_length(v_surnames, 1))::int];
    if v_salutation = 'mr' then
      v_given_name := v_male_names[1 + floor(random() * array_length(v_male_names, 1))::int];
    else
      v_given_name := v_female_names[1 + floor(random() * array_length(v_female_names, 1))::int];
    end if;
    v_birthday := ((current_date - make_interval(years => 18 + floor(random() * 48)::int))::date
      - floor(random() * 365)::int);

    loop
      -- Match the same E.164 and phone-quality constraints as real members.
      v_phone := '+8869' || lpad(floor(random() * 100000000)::bigint::text, 8, '0');
      exit when v_phone !~ '([0-9])\1{6,}'
        and not exists (select 1 from public.members where phone = v_phone);
    end loop;

    insert into public.members (
      line_user_id, display_name, member_code, status, membership_status,
      birthday, phone, joined_at, last_login_at, surname, salutation,
      is_test_account, test_account_sequence, created_at, updated_at
    ) values (
      'TEST-' || replace(gen_random_uuid()::text, '-', ''),
      v_surname || v_given_name || '（測試）',
      'TST' || lpad(v_seq::text, 6, '0'),
      'active',
      'active',
      v_birthday,
      v_phone,
      now(),
      now(),
      v_surname,
      v_salutation,
      true,
      v_seq,
      now(),
      now()
    );
  end loop;

  return query
  select v_count, count(*)::integer
  from public.members
  where is_test_account = true;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.admin_save_test_mode(p_enabled boolean, p_allow_admin_user_login boolean, p_maintenance_message text, p_updated_by text, p_add_account_count integer DEFAULT 0)
 RETURNS TABLE(created_account_count integer, total_test_accounts integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_count integer := coalesce(p_add_account_count, 0);
  v_message text := coalesce(p_maintenance_message, '');
  v_existing integer;
  v_seq bigint;
  v_i integer;
begin
  if v_count < 0 or v_count > 50 then
    raise exception 'INVALID_TEST_ACCOUNT_COUNT';
  end if;
  if char_length(v_message) > 500 then
    raise exception 'INVALID_MAINTENANCE_MESSAGE';
  end if;

  select count(*)::integer
    into v_existing
    from public.members
   where is_test_account = true;

  if v_existing + v_count > 200 then
    raise exception 'TEST_ACCOUNT_LIMIT_REACHED';
  end if;

  insert into public.test_mode_settings (
    id, enabled, allow_admin_user_login, maintenance_message, updated_by, updated_at
  )
  values (
    true,
    coalesce(p_enabled, false),
    coalesce(p_allow_admin_user_login, false),
    v_message,
    nullif(btrim(coalesce(p_updated_by, '')), ''),
    now()
  )
  on conflict (id) do update set
    enabled = excluded.enabled,
    allow_admin_user_login = excluded.allow_admin_user_login,
    maintenance_message = excluded.maintenance_message,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  if not coalesce(p_enabled, false) or not coalesce(p_allow_admin_user_login, false) then
    update public.test_login_sessions
       set revoked_at = coalesce(revoked_at, now())
     where revoked_at is null;
  end if;

  for v_i in 1..v_count loop
    v_seq := nextval('public.test_member_sequence');
    insert into public.members (
      line_user_id,
      display_name,
      member_code,
      status,
      membership_status,
      birthday,
      phone,
      joined_at,
      last_login_at,
      surname,
      salutation,
      is_test_account,
      test_account_sequence,
      created_at,
      updated_at
    ) values (
      'TEST-' || replace(gen_random_uuid()::text, '-', ''),
      '測試會員 ' || lpad(v_seq::text, 3, '0'),
      'TST' || lpad(v_seq::text, 6, '0'),
      'active',
      'active',
      date '1990-01-01',
      '09' || lpad((v_seq % 100000000)::text, 8, '0'),
      now(),
      now(),
      '測試',
      null,
      true,
      v_seq,
      now(),
      now()
    );
  end loop;

  return query
  select
    v_count,
    count(*)::integer
  from public.members
  where is_test_account = true;
end;
$function$
;
revoke all on function public.admin_save_test_mode(p_enabled boolean, p_allow_admin_user_login boolean, p_maintenance_message text, p_updated_by text, p_add_account_count integer) from public,anon,authenticated;
grant execute on function public.admin_save_test_mode(p_enabled boolean, p_allow_admin_user_login boolean, p_maintenance_message text, p_updated_by text, p_add_account_count integer) to service_role;
CREATE OR REPLACE FUNCTION public.admin_save_test_mode_v2(p_test_mode_enabled boolean, p_maintenance_enabled boolean, p_maintenance_message text, p_updated_by text, p_add_account_count integer DEFAULT 0)
 RETURNS TABLE(created_account_count integer, total_test_accounts integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_count integer := coalesce(p_add_account_count, 0);
  v_message text := coalesce(p_maintenance_message, '');
  v_existing integer;
  v_seq bigint;
  v_i integer;
begin
  if v_count < 0 or v_count > 50 then
    raise exception 'INVALID_TEST_ACCOUNT_COUNT';
  end if;
  if char_length(v_message) > 500 then
    raise exception 'INVALID_MAINTENANCE_MESSAGE';
  end if;

  select count(*)::integer
    into v_existing
    from public.members
   where is_test_account = true;

  if v_existing + v_count > 200 then
    raise exception 'TEST_ACCOUNT_LIMIT_REACHED';
  end if;

  insert into public.test_mode_settings (
    id,
    enabled,
    allow_admin_user_login,
    maintenance_enabled,
    maintenance_message,
    updated_by,
    updated_at
  )
  values (
    true,
    coalesce(p_test_mode_enabled, false),
    true,
    coalesce(p_maintenance_enabled, false),
    v_message,
    nullif(btrim(coalesce(p_updated_by, '')), ''),
    now()
  )
  on conflict (id) do update set
    enabled = excluded.enabled,
    allow_admin_user_login = true,
    maintenance_enabled = excluded.maintenance_enabled,
    maintenance_message = excluded.maintenance_message,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  if not coalesce(p_test_mode_enabled, false) or coalesce(p_maintenance_enabled, false) then
    update public.test_login_sessions
       set revoked_at = coalesce(revoked_at, now())
     where revoked_at is null;
  end if;

  for v_i in 1..v_count loop
    v_seq := nextval('public.test_member_sequence');
    insert into public.members (
      line_user_id, display_name, member_code, status, membership_status,
      birthday, phone, joined_at, last_login_at, surname, salutation,
      is_test_account, test_account_sequence, created_at, updated_at
    ) values (
      'TEST-' || replace(gen_random_uuid()::text, '-', ''),
      '測試會員 ' || lpad(v_seq::text, 3, '0'),
      'TST' || lpad(v_seq::text, 6, '0'),
      'active', 'active', date '1990-01-01',
      '09' || lpad((v_seq % 100000000)::text, 8, '0'),
      now(), now(), '測試', null, true, v_seq, now(), now()
    );
  end loop;

  return query
  select v_count, count(*)::integer
    from public.members
   where is_test_account = true;
end;
$function$
;
revoke all on function public.admin_save_test_mode_v2(p_test_mode_enabled boolean, p_maintenance_enabled boolean, p_maintenance_message text, p_updated_by text, p_add_account_count integer) from public,anon,authenticated;
grant execute on function public.admin_save_test_mode_v2(p_test_mode_enabled boolean, p_maintenance_enabled boolean, p_maintenance_message text, p_updated_by text, p_add_account_count integer) to service_role;
CREATE OR REPLACE FUNCTION public.admin_save_test_mode_v3(p_test_mode_enabled boolean, p_maintenance_enabled boolean, p_allow_pc_test_login boolean, p_allow_mobile_test_login boolean, p_maintenance_message text, p_updated_by text, p_add_account_count integer DEFAULT 0)
 RETURNS TABLE(created_account_count integer, total_test_accounts integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_count integer := coalesce(p_add_account_count, 0);
  v_message text := coalesce(p_maintenance_message, '');
  v_existing integer;
  v_seq bigint;
  v_i integer;
begin
  if v_count < 0 or v_count > 50 then
    raise exception 'INVALID_TEST_ACCOUNT_COUNT';
  end if;
  if char_length(v_message) > 500 then
    raise exception 'INVALID_MAINTENANCE_MESSAGE';
  end if;

  select count(*)::integer
    into v_existing
    from public.members
   where is_test_account = true;

  if v_existing + v_count > 200 then
    raise exception 'TEST_ACCOUNT_LIMIT_REACHED';
  end if;

  insert into public.test_mode_settings (
    id,
    enabled,
    allow_admin_user_login,
    maintenance_enabled,
    allow_pc_test_login,
    allow_mobile_test_login,
    maintenance_message,
    updated_by,
    updated_at
  )
  values (
    true,
    coalesce(p_test_mode_enabled, false),
    true,
    coalesce(p_maintenance_enabled, false),
    coalesce(p_allow_pc_test_login, false),
    coalesce(p_allow_mobile_test_login, false),
    v_message,
    nullif(btrim(coalesce(p_updated_by, '')), ''),
    now()
  )
  on conflict (id) do update set
    enabled = excluded.enabled,
    allow_admin_user_login = true,
    maintenance_enabled = excluded.maintenance_enabled,
    allow_pc_test_login = excluded.allow_pc_test_login,
    allow_mobile_test_login = excluded.allow_mobile_test_login,
    maintenance_message = excluded.maintenance_message,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  if not coalesce(p_maintenance_enabled, false)
     or not coalesce(p_test_mode_enabled, false)
     or not (
       coalesce(p_allow_pc_test_login, false)
       or coalesce(p_allow_mobile_test_login, false)
     )
  then
    update public.test_login_sessions
       set revoked_at = coalesce(revoked_at, now())
     where revoked_at is null;
  end if;

  for v_i in 1..v_count loop
    v_seq := nextval('public.test_member_sequence');
    insert into public.members (
      line_user_id, display_name, member_code, status, membership_status,
      birthday, phone, joined_at, last_login_at, surname, salutation,
      is_test_account, test_account_sequence, created_at, updated_at
    ) values (
      'TEST-' || replace(gen_random_uuid()::text, '-', ''),
      '測試會員 ' || lpad(v_seq::text, 3, '0'),
      'TST' || lpad(v_seq::text, 6, '0'),
      'active', 'active', date '1990-01-01',
      '09' || lpad((v_seq % 100000000)::text, 8, '0'),
      now(), now(), '測試', null, true, v_seq, now(), now()
    );
  end loop;

  return query
  select v_count, count(*)::integer
    from public.members
   where is_test_account = true;
end;
$function$
;
revoke all on function public.admin_save_test_mode_v3(p_test_mode_enabled boolean, p_maintenance_enabled boolean, p_allow_pc_test_login boolean, p_allow_mobile_test_login boolean, p_maintenance_message text, p_updated_by text, p_add_account_count integer) from public,anon,authenticated;
grant execute on function public.admin_save_test_mode_v3(p_test_mode_enabled boolean, p_maintenance_enabled boolean, p_allow_pc_test_login boolean, p_allow_mobile_test_login boolean, p_maintenance_message text, p_updated_by text, p_add_account_count integer) to service_role;
CREATE OR REPLACE FUNCTION public.apply_fixed_ticket_location_rule()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_requires boolean;
  v_locations jsonb;
  v_first jsonb;
begin
  if new.fixed_ticket_template_id is null then
    return new;
  end if;

  select requires_location, redemption_locations
    into v_requires, v_locations
  from public.fixed_ticket_templates
  where id = new.fixed_ticket_template_id;

  if found then
    new.requires_location := coalesce(v_requires,false);
    new.redemption_locations := case when coalesce(v_requires,false) then coalesce(v_locations,'[]'::jsonb) else '[]'::jsonb end;
    v_first := case when new.requires_location then new.redemption_locations->0 else null end;
    new.redemption_latitude := case when v_first is null then null else (v_first->>'latitude')::numeric end;
    new.redemption_longitude := case when v_first is null then null else (v_first->>'longitude')::numeric end;
    new.redemption_radius_meters := case when v_first is null then null else (v_first->>'radiusMeters')::integer end;
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.bind_member_referral(p_invitee_line_user_id text, p_invite_code text, p_request_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_invitee public.members%rowtype;
  v_inviter public.members%rowtype;
  v_existing public.member_referrals%rowtype;
  v_source_event public.event_tickets%rowtype;
  v_reward_event public.event_tickets%rowtype;
  v_referral_id text;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_claim_id text;
  v_claim_count integer := 0;
  v_inviter_tier text;
begin
  p_invite_code := upper(btrim(coalesce(p_invite_code, '')));
  p_request_id := btrim(coalesce(p_request_id, ''));

  if p_invite_code !~ '^[A-F0-9]{10}$' then
    raise exception 'INVALID_INVITE_CODE';
  end if;
  if p_request_id !~ '^[A-Za-z0-9_-]{8,120}$' then
    raise exception 'INVALID_REQUEST_ID';
  end if;

  select * into v_invitee
  from public.members
  where line_user_id = p_invitee_line_user_id
  for update;

  if not found
     or v_invitee.status <> 'active'
     or v_invitee.membership_status <> 'active' then
    raise exception 'MEMBERSHIP_REQUIRED';
  end if;

  select * into v_existing
  from public.member_referrals
  where invitee_member_id = v_invitee.id
  for update;

  if found then
    select * into v_inviter
    from public.members
    where id = v_existing.inviter_member_id;

    if v_existing.invite_code <> p_invite_code then
      raise exception 'REFERRAL_ALREADY_BOUND';
    end if;

    return jsonb_build_object(
      'referralId', v_existing.referral_id,
      'alreadyApplied', true,
      'rewardStatus', v_existing.reward_status,
      'rewardEventTicketId', (
        select e.event_ticket_id
        from public.event_tickets e
        where e.id = v_existing.reward_event_ticket_id
      ),
      'rewardExpiresOn', (
        select e.ends_on
        from public.event_tickets e
        where e.id = v_existing.reward_event_ticket_id
      ),
      'rewardRecipient', 'inviter',
      'inviterMemberCode', v_inviter.member_code
    );
  end if;

  select * into v_inviter
  from public.members
  where invite_code = p_invite_code
    and status = 'active'
    and membership_status = 'active';

  if not found then
    raise exception 'INVITE_CODE_NOT_FOUND';
  end if;
  if v_inviter.id = v_invitee.id then
    raise exception 'SELF_REFERRAL_NOT_ALLOWED';
  end if;

  if exists (
    with recursive descendants(member_id) as (
      select r.invitee_member_id
      from public.member_referrals r
      where r.inviter_member_id = v_invitee.id
      union
      select r.invitee_member_id
      from public.member_referrals r
      join descendants d on r.inviter_member_id = d.member_id
    )
    select 1 from descendants where member_id = v_inviter.id
  ) then
    raise exception 'REFERRAL_CYCLE_NOT_ALLOWED';
  end if;

  perform 1
  from public.members
  where id in (v_inviter.id, v_invitee.id)
  order by id
  for update;

  select * into v_source_event
  from public.event_tickets
  where ticket_type = 'referral'
    and referral_source_event_ticket_id is null
    and status = 'active'
    and deleted_at is null
    and (starts_on is null or starts_on <= v_today)
    and (ends_on is null or ends_on >= v_today)
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'REFERRAL_REWARD_UNAVAILABLE';
  end if;

  v_inviter_tier := public.current_tier_key(v_inviter.id);
  if not (v_inviter_tier = any(v_source_event.allowed_tier_keys)) then
    raise exception 'REFERRAL_REWARD_NOT_ELIGIBLE';
  end if;

  if v_source_event.quota > 0 then
    select count(*)::integer into v_claim_count
    from public.event_ticket_claims c
    join public.event_tickets reward_event
      on reward_event.id = c.event_ticket_id
    where c.ticket_type = 'referral'
      and (
        c.event_ticket_id = v_source_event.id
        or reward_event.referral_source_event_ticket_id = v_source_event.id
      );

    if v_claim_count >= v_source_event.quota then
      raise exception 'REFERRAL_REWARD_SOLD_OUT';
    end if;
  end if;

  v_referral_id := public.new_public_id('RF');

  insert into public.event_tickets(
    event_ticket_id,
    title,
    ticket_type,
    description,
    usage_method,
    usage_instructions,
    prizes,
    status,
    starts_on,
    ends_on,
    quota,
    accent,
    allowed_tier_keys,
    required_service_types,
    created_by,
    updated_by,
    activity_url,
    activity_link_name,
    requires_location,
    redemption_locations,
    referral_source_event_ticket_id
  ) values (
    'REFERRAL-' || v_referral_id,
    v_source_event.title,
    'referral',
    v_source_event.description,
    v_source_event.usage_method,
    v_source_event.usage_instructions,
    v_source_event.prizes,
    'active',
    v_today,
    v_source_event.ends_on,
    1,
    v_source_event.accent,
    v_source_event.allowed_tier_keys,
    coalesce(v_source_event.required_service_types, '{}'::text[]),
    'member-referral',
    'member-referral',
    v_source_event.activity_url,
    v_source_event.activity_link_name,
    false,
    '[]'::jsonb,
    v_source_event.id
  )
  returning * into v_reward_event;

  insert into public.member_referrals(
    referral_id,
    inviter_member_id,
    invitee_member_id,
    invite_code,
    request_id,
    trigger_type,
    reward_status,
    reward_event_ticket_id,
    rewarded_at
  ) values (
    v_referral_id,
    v_inviter.id,
    v_invitee.id,
    p_invite_code,
    p_request_id,
    'membership_activation',
    'issued',
    v_reward_event.id,
    now()
  );

  v_claim_id := public.new_public_id('EC');
  insert into public.event_ticket_claims(
    claim_id,
    event_ticket_id,
    member_id,
    ticket_type,
    ticket_title,
    ticket_description,
    usage_method,
    usage_instructions,
    prizes,
    status,
    claimed_at
  ) values (
    v_claim_id,
    v_reward_event.id,
    v_inviter.id,
    'referral',
    v_reward_event.title,
    v_reward_event.description,
    v_reward_event.usage_method,
    v_reward_event.usage_instructions,
    v_reward_event.prizes,
    'claimed',
    now()
  );

  insert into public.audit_logs(
    audit_id,
    actor_line_user_id,
    actor_role,
    action,
    target_type,
    target_id,
    result,
    detail
  ) values (
    public.new_public_id('AUD'),
    v_invitee.line_user_id,
    'member',
    'user.member.referral.bind',
    'member_referral',
    v_referral_id,
    'success',
    jsonb_build_object(
      'inviterMemberId', v_inviter.id,
      'inviteeMemberId', v_invitee.id,
      'trigger', 'invite_code_bind',
      'rewardRecipient', 'inviter',
      'rewardCount', 1,
      'rewardSourceEventTicketId', v_source_event.event_ticket_id,
      'rewardEventTicketId', v_reward_event.event_ticket_id,
      'rewardClaimId', v_claim_id,
      'rewardExpiresOn', v_reward_event.ends_on
    )
  );

  insert into public.realtime_events(scope,event_type)
  values ('event','member.referral.reward-issued');

  return jsonb_build_object(
    'referralId', v_referral_id,
    'alreadyApplied', false,
    'rewardStatus', 'issued',
    'rewardRecipient', 'inviter',
    'rewardEventTicketId', v_reward_event.event_ticket_id,
    'rewardExpiresOn', v_reward_event.ends_on,
    'rewardClaimId', v_claim_id,
    'inviterMemberCode', v_inviter.member_code
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.booking_has_required_service_id(p_booking_id uuid, p_required_service_ids uuid[])
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    coalesce(cardinality(p_required_service_ids), 0) = 0
    or exists (
      select 1
      from public.booking_items bi
      where bi.booking_id = p_booking_id
        and bi.service_id = any(p_required_service_ids)
    )
    or exists (
      select 1
      from public.booking_participants bp
      join public.booking_participant_items bpi on bpi.participant_id = bp.id
      where bp.booking_id = p_booking_id
        and bpi.service_id = any(p_required_service_ids)
    );
$function$
;
revoke all on function public.booking_has_required_service_id(p_booking_id uuid, p_required_service_ids uuid[]) from public,anon,authenticated;
grant execute on function public.booking_has_required_service_id(p_booking_id uuid, p_required_service_ids uuid[]) to service_role;
CREATE OR REPLACE FUNCTION public.booking_has_required_service_type(p_booking_id uuid, p_required_service_types text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with booking_service_types as (
    select coalesce(
      nullif(btrim(bi.service_type), ''),
      nullif(btrim(bs.service_type), '')
    ) as service_type
    from public.booking_items bi
    left join public.booking_services bs on bs.id = bi.service_id
    where bi.booking_id = p_booking_id

    union

    select nullif(btrim(bs.service_type), '') as service_type
    from public.booking_participants bp
    join public.booking_participant_items bpi on bpi.participant_id = bp.id
    join public.booking_services bs on bs.id = bpi.service_id
    where bp.booking_id = p_booking_id
  )
  select
    coalesce(cardinality(p_required_service_types), 0) = 0
    or exists (
      select 1
      from booking_service_types bst
      cross join unnest(p_required_service_types) as required(service_type)
      where bst.service_type is not null
        and lower(btrim(bst.service_type)) = lower(btrim(required.service_type))
    );
$function$
;
revoke all on function public.booking_has_required_service_type(p_booking_id uuid, p_required_service_types text[]) from public,anon,authenticated;
grant execute on function public.booking_has_required_service_type(p_booking_id uuid, p_required_service_types text[]) to service_role;
CREATE OR REPLACE FUNCTION public.complete_booking_with_receipt_request(p_receipt_id text, p_member_id uuid, p_actor_line_user_id text, p_expected_booking_updated_at timestamp with time zone, p_actual_mime_type text, p_actual_size_bytes integer, p_sha256_hex text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  return public.finalize_booking_receipt_request(
    p_receipt_id,
    p_member_id,
    p_actor_line_user_id,
    p_expected_booking_updated_at,
    p_actual_mime_type,
    p_actual_size_bytes,
    p_sha256_hex
  );
end;
$function$
;
revoke all on function public.complete_booking_with_receipt_request(p_receipt_id text, p_member_id uuid, p_actor_line_user_id text, p_expected_booking_updated_at timestamp with time zone, p_actual_mime_type text, p_actual_size_bytes integer, p_sha256_hex text) from public,anon,authenticated;
grant execute on function public.complete_booking_with_receipt_request(p_receipt_id text, p_member_id uuid, p_actor_line_user_id text, p_expected_booking_updated_at timestamp with time zone, p_actual_mime_type text, p_actual_size_bytes integer, p_sha256_hex text) to service_role;
CREATE OR REPLACE FUNCTION public.count_today_usable_event_tickets(p_line_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_member public.members%rowtype;
  v_tier text;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_day_start timestamptz := (v_today::timestamp at time zone 'Asia/Taipei');
  v_day_end timestamptz := ((v_today + 1)::timestamp at time zone 'Asia/Taipei');
  v_available_count integer := 0;
  v_used_today_count integer := 0;
  v_max_tickets integer := 1;
  v_remaining_today integer := 0;
begin
  select * into v_member
  from public.members
  where line_user_id=p_line_user_id
    and status='active'
    and membership_status='active';
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  v_tier:=public.current_tier_key(v_member.id);

  select coalesce(max_tickets_per_day, max_tickets_per_redemption, 1)
    into v_max_tickets
  from public.event_ticket_settings
  where id=1;
  v_max_tickets := coalesce(v_max_tickets,1);

  select count(*)::integer into v_used_today_count
  from public.event_ticket_claims c
  where c.member_id=v_member.id
    and c.status='used'
    and c.used_at >= v_day_start
    and c.used_at < v_day_end;

  select count(*)::integer into v_available_count
  from public.event_ticket_claims c
  join public.event_tickets e on e.id=c.event_ticket_id
  where c.member_id=v_member.id
    and c.status='claimed'
    and e.deleted_at is null
    and e.status='active'
    and (e.starts_on is null or e.starts_on<=v_today)
    and (e.ends_on is null or e.ends_on>=v_today)
    and v_tier=any(e.allowed_tier_keys);

  if v_max_tickets = 0 then
    v_remaining_today := v_available_count;
  else
    v_remaining_today := greatest(v_max_tickets - v_used_today_count, 0);
  end if;

  return jsonb_build_object(
    'businessDate',v_today,
    'availableTodayCount',v_available_count,
    'usedTodayCount',v_used_today_count,
    'remainingTodayCount',v_remaining_today,
    'maxTicketsPerDay',v_max_tickets,
    'maxTicketsPerRedemption',v_max_tickets,
    'todayUsableCount',least(v_available_count,v_remaining_today)
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.create_booking_request(p_request_id text, p_service_id uuid, p_member_id uuid, p_booking_date date, p_start_time time without time zone, p_member_note text DEFAULT ''::text)
 RETURNS bookings
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  return public.create_booking_bundle_request(
    p_request_id,
    p_member_id,
    p_booking_date,
    p_start_time,
    jsonb_build_array(
      jsonb_build_object('serviceId', p_service_id, 'quantity', 1),
      jsonb_build_object('serviceId', '00000000-0000-4000-8000-000000000010'::uuid, 'quantity', 1)
    ),
    p_member_note
  );
end;
$function$
;
revoke all on function public.create_booking_request(p_request_id text, p_service_id uuid, p_member_id uuid, p_booking_date date, p_start_time time without time zone, p_member_note text) from public,anon,authenticated;
grant execute on function public.create_booking_request(p_request_id text, p_service_id uuid, p_member_id uuid, p_booking_date date, p_start_time time without time zone, p_member_note text) to service_role;
CREATE OR REPLACE FUNCTION public.issue_birthday_benefits(p_business_date date DEFAULT ((now() AT TIME ZONE 'Asia/Taipei'::text))::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_settings public.birthday_benefit_settings%rowtype;
  v_year integer := extract(year from p_business_date)::integer;
  v_month integer := extract(month from p_business_date)::integer;
  v_month_start date := date_trunc('month', p_business_date)::date;
  v_month_end date := (date_trunc('month', p_business_date) + interval '1 month - 1 day')::date;
  v_ticket public.event_tickets%rowtype;
  v_title text;
  v_grant record;
  v_claim_id text;
  v_issued integer := 0;
  v_queued integer := 0;
  v_reserved integer := 0;
begin
  select * into v_settings from public.birthday_benefit_settings where singleton = true;
  if not found or not v_settings.enabled then
    return jsonb_build_object('enabled', false, 'businessDate', p_business_date, 'issued', 0, 'queued', 0);
  end if;
  if coalesce(array_length(v_settings.allowed_tier_keys,1),0) = 0 then
    raise exception 'BIRTHDAY_BENEFIT_INVALID_TIERS';
  end if;

  v_title := replace(v_settings.title_template, '{month}', v_month::text);

  insert into public.event_tickets(
    event_ticket_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,
    starts_on,ends_on,quota,accent,allowed_tier_keys,created_by,updated_by,activity_url,activity_link_name
  ) values (
    'BIRTHDAY-' || v_year::text || '-' || lpad(v_month::text,2,'0'), v_title, 'coupon',
    v_settings.description, v_settings.usage_method, v_settings.usage_instructions, '[]'::jsonb, 'active',
    v_month_start, v_month_end, 0, lower(v_settings.accent), v_settings.allowed_tier_keys,
    'birthday-automation','birthday-automation','',''
  )
  on conflict(event_ticket_id) do update set
    title=excluded.title, description=excluded.description, usage_method=excluded.usage_method,
    usage_instructions=excluded.usage_instructions, status='active', starts_on=excluded.starts_on,
    ends_on=excluded.ends_on, accent=excluded.accent, allowed_tier_keys=excluded.allowed_tier_keys,
    updated_by='birthday-automation', updated_at=now(), deleted_at=null
  returning * into v_ticket;

  insert into public.birthday_benefit_grants(member_id, benefit_year, benefit_month, status)
  select m.id, v_year, v_month, 'reserved'
  from public.members m
  where m.status='active' and m.membership_status='active' and m.birthday is not null
    and extract(month from m.birthday)::integer = v_month
  on conflict(member_id, benefit_year) do nothing;
  get diagnostics v_reserved = row_count;

  for v_grant in
    select g.id as grant_id, g.member_id, m.line_user_id, m.display_name
    from public.birthday_benefit_grants g
    join public.members m on m.id=g.member_id
    where g.benefit_year=v_year and g.benefit_month=v_month and g.status='reserved'
    order by g.created_at
  loop
    v_claim_id := 'BTC-' || replace(gen_random_uuid()::text,'-','');
    insert into public.event_ticket_claims(
      claim_id,event_ticket_id,member_id,ticket_type,ticket_title,ticket_description,
      usage_method,usage_instructions,prizes,status,claimed_at
    ) values (
      v_claim_id,v_ticket.id,v_grant.member_id,'coupon',v_ticket.title,v_ticket.description,
      v_ticket.usage_method,v_ticket.usage_instructions,'[]'::jsonb,'claimed',now()
    )
    on conflict(event_ticket_id, member_id) do nothing;

    select c.claim_id into v_claim_id
    from public.event_ticket_claims c
    where c.event_ticket_id=v_ticket.id and c.member_id=v_grant.member_id
    limit 1;

    if v_claim_id is null then
      update public.birthday_benefit_grants set status='failed', notification_error='CLAIM_CREATE_FAILED', updated_at=now() where id=v_grant.grant_id;
      continue;
    end if;

    update public.birthday_benefit_grants
    set event_ticket_id=v_ticket.id, claim_id=v_claim_id, status='issued', notification_error='', updated_at=now()
    where id=v_grant.grant_id;
    v_issued := v_issued + 1;

    if v_settings.notify_line then
      insert into public.scheduled_grant_messages(
        schedule_id,request_id,member_id,line_user_id,scheduled_for,message_text,status,created_by
      ) values (
        'BIRTHDAY-' || v_year::text || '-' || v_grant.member_id::text,
        'BIRTHDAY-' || v_year::text || '-' || v_grant.member_id::text,
        v_grant.member_id,v_grant.line_user_id,now(),
        '🎂 ' || coalesce(nullif(v_grant.display_name,''),'會員') || '，生日快樂！' || E'\n\n' ||
        '你已獲得「' || v_ticket.title || '」' || E'\n' || v_ticket.description || E'\n\n' ||
        '使用期限：' || to_char(v_month_start,'YYYY/MM/DD') || ' ～ ' || to_char(v_month_end,'YYYY/MM/DD'),
        'pending','birthday-automation'
      ) on conflict(request_id) do nothing;
      if found then v_queued := v_queued + 1; end if;
    end if;

    insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
    values('AUD-' || replace(gen_random_uuid()::text,'-',''),'system','system','birthday.benefit.issue','member',v_grant.line_user_id,'success',jsonb_build_object('year',v_year,'month',v_month,'eventTicketId',v_ticket.event_ticket_id,'claimId',v_claim_id));
  end loop;

  return jsonb_build_object('enabled', true, 'businessDate', p_business_date, 'year', v_year, 'month', v_month, 'reserved', v_reserved, 'issued', v_issued, 'queued', v_queued, 'eventTicketId', v_ticket.event_ticket_id);
end;
$function$
;
revoke all on function public.issue_birthday_benefits(p_business_date date) from public,anon,authenticated;
grant execute on function public.issue_birthday_benefits(p_business_date date) to service_role;
CREATE OR REPLACE FUNCTION public.prevent_delete_ticket_required_service_type()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if exists (
    select 1
    from public.point_card_rewards r
    cross join unnest(r.required_service_types) as value
    where lower(btrim(value)) = lower(btrim(old.name))
  ) or exists (
    select 1
    from public.event_tickets et
    cross join unnest(et.required_service_types) as value
    where lower(btrim(value)) = lower(btrim(old.name))
  ) then
    raise exception 'BOOKING_SERVICE_TYPE_IN_USE';
  end if;
  return old;
end;
$function$
;
revoke all on function public.prevent_delete_ticket_required_service_type() from public,anon,authenticated;
grant execute on function public.prevent_delete_ticket_required_service_type() to service_role;
CREATE OR REPLACE FUNCTION public.redeem_event_ticket(p_line_user_id text, p_claim_id text, p_location jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_member public.members%rowtype;
  v_claim public.event_ticket_claims%rowtype;
  v_event public.event_tickets%rowtype;
  v_tier text;
  v_result jsonb := null;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_day_start timestamptz := (v_today::timestamp at time zone 'Asia/Taipei');
  v_day_end timestamptz := ((v_today + 1)::timestamp at time zone 'Asia/Taipei');
  v_max_tickets integer := 1;
  v_used_today_count integer := 0;
begin
  select * into v_member
  from public.members
  where line_user_id=p_line_user_id
    and membership_status='active'
    and status='active'
  for update;
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select * into v_claim
  from public.event_ticket_claims
  where claim_id=p_claim_id
    and member_id=v_member.id
  for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if v_claim.status='used' then
    return jsonb_build_object('claimId',v_claim.claim_id,'alreadyUsed',true);
  end if;
  if v_claim.status <> 'claimed' then raise exception 'CLAIM_NOT_AVAILABLE'; end if;

  select coalesce(max_tickets_per_day, max_tickets_per_redemption, 1)
    into v_max_tickets
  from public.event_ticket_settings
  where id=1;
  v_max_tickets := coalesce(v_max_tickets,1);

  select count(*)::integer into v_used_today_count
  from public.event_ticket_claims c
  where c.member_id=v_member.id
    and c.status='used'
    and c.used_at >= v_day_start
    and c.used_at < v_day_end;

  if v_max_tickets > 0 and v_used_today_count >= v_max_tickets then
    raise exception 'EVENT_TICKET_DAILY_LIMIT_REACHED';
  end if;

  select * into v_event
  from public.event_tickets
  where id=v_claim.event_ticket_id
    and deleted_at is null
  for update;
  if not found or v_event.status <> 'active' then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
  if v_event.starts_on is not null and v_today < v_event.starts_on then raise exception 'EVENT_NOT_STARTED'; end if;
  if v_event.ends_on is not null and v_today > v_event.ends_on then raise exception 'EVENT_ENDED'; end if;

  v_tier := public.current_tier_key(v_member.id);
  if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception 'TIER_NOT_ALLOWED'; end if;
  if v_event.requires_location then
    perform public.verify_ticket_redemption_locations(v_event.redemption_locations,p_location);
  end if;

  if v_claim.ticket_type='lottery' then
    v_result := public.pick_lottery_prize(v_claim.prizes);
  end if;

  update public.event_ticket_claims
  set status='used',
      used_at=now(),
      result=v_result,
      updated_at=now()
  where id=v_claim.id
    and status='claimed';
  if not found then raise exception 'CLAIM_NOT_AVAILABLE'; end if;

  insert into public.audit_logs(
    audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
  ) values (
    public.new_public_id('AUD'),
    v_member.line_user_id,
    'member',
    'user.event.ticket.redeem',
    'event_claim',
    v_claim.claim_id,
    'success',
    jsonb_build_object(
      'businessDate',v_today,
      'usedTodayCount',v_used_today_count + 1,
      'maxTicketsPerDay',v_max_tickets
    )
  );

  return jsonb_build_object(
    'claimId',v_claim.claim_id,
    'alreadyUsed',false,
    'businessDate',v_today,
    'usedTodayCount',v_used_today_count + 1,
    'maxTicketsPerDay',v_max_tickets,
    'remainingTodayCount',case when v_max_tickets = 0 then null else greatest(v_max_tickets - (v_used_today_count + 1),0) end
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.redeem_event_tickets_with_location(p_line_user_id text, p_claim_ids text[], p_request_id text, p_location jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_member public.members%rowtype;
  v_claim public.event_ticket_claims%rowtype;
  v_event public.event_tickets%rowtype;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_day_start timestamptz := (v_today::timestamp at time zone 'Asia/Taipei');
  v_day_end timestamptz := ((v_today + 1)::timestamp at time zone 'Asia/Taipei');
  v_tier text;
  v_max_tickets integer := 1;
  v_used_today_count integer := 0;
  v_selected_count integer := 0;
  v_processed integer := 0;
  v_result jsonb := null;
  v_results jsonb := '[]'::jsonb;
  v_existing jsonb;
begin
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_-]{8,120}$' then
    raise exception 'INVALID_REQUEST_ID';
  end if;
  if p_claim_ids is null or cardinality(p_claim_ids) < 1 or cardinality(p_claim_ids) > 50 then
    raise exception 'INVALID_EVENT_TICKET_BATCH';
  end if;
  if exists(
    select 1 from unnest(p_claim_ids) as selected(claim_id)
    where nullif(btrim(selected.claim_id),'') is null
  ) then
    raise exception 'INVALID_EVENT_TICKET_BATCH';
  end if;
  if (select count(distinct selected.claim_id) from unnest(p_claim_ids) as selected(claim_id)) <> cardinality(p_claim_ids) then
    raise exception 'INVALID_EVENT_TICKET_BATCH';
  end if;

  select * into v_member
  from public.members
  where line_user_id=p_line_user_id
    and membership_status='active'
    and status='active'
  for update;
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select detail into v_existing
  from public.audit_logs
  where actor_line_user_id=v_member.line_user_id
    and action='user.event.tickets.redeem'
    and target_type='event_claim_batch'
    and target_id=p_request_id
    and result='success'
  order by created_at desc
  limit 1;
  if found then
    return coalesce(v_existing,'{}'::jsonb)
      || jsonb_build_object('requestId',p_request_id,'alreadyApplied',true);
  end if;

  select coalesce(max_tickets_per_day, max_tickets_per_redemption, 1)
    into v_max_tickets
  from public.event_ticket_settings
  where id=1;
  v_max_tickets := coalesce(v_max_tickets,1);

  select count(*)::integer into v_used_today_count
  from public.event_ticket_claims c
  where c.member_id=v_member.id
    and c.status='used'
    and c.used_at >= v_day_start
    and c.used_at < v_day_end;

  if v_max_tickets > 0 and v_used_today_count + cardinality(p_claim_ids) > v_max_tickets then
    raise exception 'EVENT_TICKET_DAILY_LIMIT_REACHED';
  end if;

  perform 1
  from public.event_ticket_claims c
  where c.member_id=v_member.id
    and c.claim_id=any(p_claim_ids)
  order by c.claim_id
  for update;

  select count(*)::integer into v_selected_count
  from public.event_ticket_claims c
  where c.member_id=v_member.id
    and c.claim_id=any(p_claim_ids);
  if v_selected_count <> cardinality(p_claim_ids) then
    raise exception 'CLAIM_NOT_FOUND';
  end if;

  if exists(
    select 1
    from public.event_ticket_claims c
    where c.member_id=v_member.id
      and c.claim_id=any(p_claim_ids)
      and c.status <> 'claimed'
  ) then
    raise exception 'CLAIM_NOT_AVAILABLE';
  end if;

  perform 1
  from public.event_tickets e
  where e.id in (
    select c.event_ticket_id
    from public.event_ticket_claims c
    where c.member_id=v_member.id
      and c.claim_id=any(p_claim_ids)
  )
  order by e.id
  for update;

  v_tier := public.current_tier_key(v_member.id);

  for v_claim in
    select c.*
    from public.event_ticket_claims c
    where c.member_id=v_member.id
      and c.claim_id=any(p_claim_ids)
    order by c.claim_id
  loop
    select * into v_event
    from public.event_tickets
    where id=v_claim.event_ticket_id
      and deleted_at is null;

    if not found or v_event.status <> 'active' then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
    if v_event.starts_on is not null and v_today < v_event.starts_on then raise exception 'EVENT_NOT_STARTED'; end if;
    if v_event.ends_on is not null and v_today > v_event.ends_on then raise exception 'EVENT_ENDED'; end if;
    if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception 'TIER_NOT_ALLOWED'; end if;
    if v_event.requires_location then
      perform public.verify_ticket_redemption_locations(v_event.redemption_locations,p_location);
    end if;

    v_result := null;
    if v_claim.ticket_type='lottery' then
      v_result := public.pick_lottery_prize(v_claim.prizes);
    end if;

    update public.event_ticket_claims
    set status='used',
        used_at=now(),
        result=v_result,
        updated_at=now()
    where id=v_claim.id
      and status='claimed';
    if not found then raise exception 'CLAIM_NOT_AVAILABLE'; end if;

    v_processed := v_processed + 1;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'claimId',v_claim.claim_id,
      'eventTicketId',v_event.event_ticket_id,
      'ticketTitle',v_claim.ticket_title,
      'ticketType',v_claim.ticket_type,
      'result',v_result
    ));
  end loop;

  v_existing := jsonb_build_object(
    'requestId',p_request_id,
    'claimIds',to_jsonb(p_claim_ids),
    'ticketCount',v_processed,
    'maxTicketsPerDay',v_max_tickets,
    'businessDate',v_today,
    'usedTodayCount',v_used_today_count + v_processed,
    'remainingTodayCount',case when v_max_tickets = 0 then null else greatest(v_max_tickets - (v_used_today_count + v_processed),0) end,
    'tickets',v_results,
    'alreadyApplied',false
  );

  insert into public.audit_logs(
    audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
  ) values (
    public.new_public_id('AUD'),
    v_member.line_user_id,
    'member',
    'user.event.tickets.redeem',
    'event_claim_batch',
    p_request_id,
    'success',
    v_existing
  );

  return v_existing;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.register_accessible_receipt_request(p_receipt_id text, p_expected_receipt_updated_at timestamp with time zone, p_actor text, p_booking_id uuid, p_booking_date date, p_start_time time without time zone, p_items jsonb, p_admin_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r public.booking_receipts%rowtype; b public.bookings%rowtype; m public.members%rowtype;
  s public.booking_services%rowtype; settings public.booking_settings%rowtype;
  item jsonb; minutes integer; quantity integer; total integer:=0; participant uuid;
  store_id constant uuid:='00000000-0000-4000-8000-000000000010';
  store public.booking_services%rowtype; start_at timestamp; settlement jsonb;
begin
  perform 1 from public.admins where line_user_id=p_actor and role='admin' and status='active';
  if not found then raise exception 'ADMIN_REQUIRED'; end if;
  select * into r from public.booking_receipts where receipt_id=p_receipt_id;
  if not found then raise exception 'RECEIPT_NOT_FOUND'; end if;
  select * into m from public.members where id=r.member_id for update;
  if m.status<>'active' or m.membership_status<>'active' then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  select * into r from public.booking_receipts where receipt_id=p_receipt_id for update;
  if r.submission_mode<>'accessible' then raise exception 'RECEIPT_NOT_PENDING'; end if;
  if r.status='bound' then
    select jsonb_build_object('bookingId',booking_id,'serviceMinutes',service_minutes,'rewards',reward_details)
      into settlement from public.booking_completion_settlements where booking_id=r.booking_id;
    return jsonb_build_object('bookingId',r.booking_id,'receiptId',r.receipt_id,'settlement',settlement,'alreadyApplied',true);
  end if;
  if r.status<>'awaiting_review' or r.booking_id is not null then raise exception 'RECEIPT_NOT_PENDING'; end if;
  if p_expected_receipt_updated_at is null or r.updated_at<>p_expected_receipt_updated_at then raise exception 'BOOKING_CONFLICT'; end if;
  if p_booking_id is not null then
    select * into b from public.bookings where id=p_booking_id for update;
    if not found or b.member_id<>r.member_id then raise exception 'BOOKING_NOT_OWNED'; end if;
    if b.status not in ('confirmed','completed') then raise exception 'INVALID_BOOKING_TRANSITION'; end if;
    if b.end_at>(clock_timestamp() at time zone 'Asia/Taipei') then raise exception 'BOOKING_NOT_FINISHED_YET'; end if;
    if exists(select 1 from public.booking_receipts where booking_id=b.id and status in ('pending_upload','awaiting_review','bound')) then
      raise exception 'BOOKING_ALREADY_COMPLETED_WITH_RECEIPT'; end if;
  else
    if p_booking_date is null or p_start_time is null or extract(second from p_start_time)<>0
      then raise exception 'INVALID_BOOKING_SLOT'; end if;
    if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then raise exception 'INVALID_BOOKING_ITEMS'; end if;
    if (select count(distinct x->>'serviceId') from jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items) then raise exception 'INVALID_BOOKING_ITEMS'; end if;
    select * into settings from public.booking_settings where id=1;
    if settings.primary_technician_id is null then raise exception 'BOOKING_PRIMARY_TECHNICIAN_MISSING'; end if;
    perform 1 from public.booking_technicians where id=settings.primary_technician_id and is_active;
    if not found then raise exception 'BOOKING_PRIMARY_TECHNICIAN_MISSING'; end if;
    select * into store from public.booking_services where id=store_id and is_active and deleted_at is null;
    if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
    for item in select value from jsonb_array_elements(p_items) loop
      select * into s from public.booking_services where id=(item->>'serviceId')::uuid and is_active and deleted_at is null and id<>store_id for share;
      if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
      minutes:=(item->>'minutes')::integer; quantity:=(item->>'quantity')::integer;
      if minutes is null or minutes not between 1 and 720 or quantity is null or quantity not between 1 and 20 then raise exception 'INVALID_BOOKING_ITEMS'; end if;
      total:=total+minutes*quantity;
    end loop;
    total:=total+store.duration_minutes;
    if total not between 1 and 1439 then raise exception 'INVALID_BOOKING_DURATION'; end if;
    start_at:=p_booking_date+p_start_time+case when settings.work_end_time<settings.work_start_time and p_start_time<settings.work_end_time then interval '1 day' else interval '0 days' end;
    if start_at+make_interval(mins=>total)>(clock_timestamp() at time zone 'Asia/Taipei') then raise exception 'BOOKING_NOT_FINISHED_YET'; end if;
    -- Do not invent a future reservation for a service that already happened.
    insert into public.bookings(request_id,service_id,member_id,booking_date,start_time,end_time,status,
      total_duration_minutes,technician_id,party_size,confirmed_by,confirmed_at,receipt_submission_id,
      contact_source,contact_surname,contact_salutation,contact_phone)
    values('receipt-register:'||r.id::text,(p_items->0->>'serviceId')::uuid,r.member_id,p_booking_date,p_start_time,
      (p_start_time+make_interval(mins=>total))::time,'confirmed',total,settings.primary_technician_id,1,p_actor,now(),r.receipt_id,
      'member',m.surname,m.salutation,m.phone) returning * into b;
    insert into public.booking_participants(booking_id,position,technician_id)
      values(b.id,1,settings.primary_technician_id) returning id into participant;
    for item in select value from jsonb_array_elements(p_items) loop
      select * into s from public.booking_services where id=(item->>'serviceId')::uuid;
      insert into public.booking_items(booking_id,service_id,service_title,unit_duration_minutes,quantity,unit_price_amount,service_type,counts_toward_membership)
      values(b.id,s.id,s.title,(item->>'minutes')::integer,(item->>'quantity')::integer,s.price_amount,s.service_type,s.counts_toward_membership);
      insert into public.booking_participant_items(participant_id,service_id,service_title,unit_duration_minutes,unit_price_amount,quantity)
      values(participant,s.id,s.title,(item->>'minutes')::integer,s.price_amount,(item->>'quantity')::integer);
    end loop;
    insert into public.booking_items(booking_id,service_id,service_title,unit_duration_minutes,quantity,unit_price_amount,service_type,counts_toward_membership)
    values(b.id,store.id,store.title,store.duration_minutes,1,store.price_amount,store.service_type,false);
    insert into public.booking_participant_items(participant_id,service_id,service_title,unit_duration_minutes,unit_price_amount,quantity)
    values(participant,store.id,store.title,store.duration_minutes,store.price_amount,1);
  end if;
  update public.booking_receipts set booking_id=b.id where id=r.id;
  if b.status='completed' then
    select jsonb_build_object('bookingId',booking_id,'serviceMinutes',service_minutes,'rewards',reward_details)
      into settlement from public.booking_completion_settlements where booking_id=b.id;
    if settlement is null then raise exception 'BOOKING_COMPLETION_REQUIRES_SETTLEMENT'; end if;
    update public.booking_receipts set status='bound',bound_at=now(),updated_at=now() where id=r.id;
  else
    settlement:=public.admin_confirm_booking_receipt_request(b.id,b.updated_at,p_actor,left(coalesce(p_admin_note,''),500))->'settlement';
  end if;
  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
  values(public.new_public_id('AUD'),p_actor,'admin','admin.booking.receipt.register','booking',b.id::text,'success',
    jsonb_build_object('receiptId',r.receipt_id,'linkedExisting',p_booking_id is not null));
  return jsonb_build_object('bookingId',b.id,'receiptId',r.receipt_id,'settlement',settlement,'alreadyApplied',false);
end $function$
;
revoke all on function public.register_accessible_receipt_request(p_receipt_id text, p_expected_receipt_updated_at timestamp with time zone, p_actor text, p_booking_id uuid, p_booking_date date, p_start_time time without time zone, p_items jsonb, p_admin_note text) from public,anon,authenticated;
grant execute on function public.register_accessible_receipt_request(p_receipt_id text, p_expected_receipt_updated_at timestamp with time zone, p_actor text, p_booking_id uuid, p_booking_date date, p_start_time time without time zone, p_items jsonb, p_admin_note text) to service_role;
CREATE OR REPLACE FUNCTION public.rename_booking_service_type(p_type_id uuid, p_name text, p_actor text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_minutes integer;
  v_card uuid;
begin
  select minutes_per_point, point_card_id
    into v_minutes, v_card
  from public.booking_service_type_rewards
  where service_type_id = p_type_id;

  perform public.save_booking_service_type(
    p_type_id,
    p_name,
    v_minutes,
    v_card,
    p_actor
  );
end;
$function$
;
revoke all on function public.rename_booking_service_type(p_type_id uuid, p_name text, p_actor text) from public,anon,authenticated;
grant execute on function public.rename_booking_service_type(p_type_id uuid, p_name text, p_actor text) to service_role;
CREATE OR REPLACE FUNCTION public.save_booking_settings_with_service_types(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_service_types text[], p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_actor text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_current_updated_at timestamptz;
begin
  select updated_at
    into v_current_updated_at
  from public.booking_settings
  where id = 1
  for update;

  if not found then
    raise exception 'BOOKING_SETTINGS_MISSING';
  end if;

  if p_expected_updated_at is not null
     and v_current_updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_SETTINGS_CONFLICT';
  end if;

  if p_work_end_time <= p_work_start_time
     or extract(epoch from (p_work_end_time - p_work_start_time)) < 1800 then
    raise exception 'INVALID_WORK_HOURS';
  end if;

  if p_min_advance_days < 0 or p_min_advance_days > 365 then
    raise exception 'INVALID_ADVANCE_DAYS';
  end if;

  update public.booking_settings
  set work_start_time = p_work_start_time,
      work_end_time = p_work_end_time,
      min_advance_days = p_min_advance_days,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where id = 1;

  perform p_service_types;
end;
$function$
;
revoke all on function public.save_booking_settings_with_service_types(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_service_types text[], p_expected_updated_at timestamp with time zone, p_actor text) from public,anon,authenticated;
grant execute on function public.save_booking_settings_with_service_types(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_service_types text[], p_expected_updated_at timestamp with time zone, p_actor text) to service_role;
CREATE OR REPLACE FUNCTION public.save_booking_shared_settings(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_booking_notice text, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_actor text DEFAULT NULL::text)
 RETURNS booking_settings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_current public.booking_settings%rowtype;
  v_saved public.booking_settings%rowtype;
  v_notice text := coalesce(p_booking_notice, '');
begin
  select * into v_current
  from public.booking_settings
  where id = 1
  for update;

  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  if p_expected_updated_at is not null and v_current.updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_SETTINGS_CONFLICT';
  end if;
  if p_work_start_time is null or p_work_end_time is null
     or p_work_end_time <= p_work_start_time
     or p_work_end_time - p_work_start_time < interval '30 minutes' then
    raise exception 'INVALID_WORK_HOURS';
  end if;
  if p_min_advance_days is null or p_min_advance_days < 0 or p_min_advance_days > 365 then
    raise exception 'INVALID_ADVANCE_DAYS';
  end if;
  if char_length(v_notice) > 2000 then raise exception 'INVALID_BOOKING_NOTICE'; end if;

  update public.booking_settings
  set work_start_time = p_work_start_time,
      work_end_time = p_work_end_time,
      min_advance_days = p_min_advance_days,
      booking_notice = v_notice,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where id = 1
  returning * into v_saved;

  return v_saved;
end;
$function$
;
revoke all on function public.save_booking_shared_settings(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_booking_notice text, p_expected_updated_at timestamp with time zone, p_actor text) from public,anon,authenticated;
grant execute on function public.save_booking_shared_settings(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_booking_notice text, p_expected_updated_at timestamp with time zone, p_actor text) to service_role;
CREATE OR REPLACE FUNCTION public.save_booking_shared_settings(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_max_advance_days integer, p_booking_notice text, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_actor text DEFAULT NULL::text)
 RETURNS booking_settings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_current public.booking_settings%rowtype;
  v_saved public.booking_settings%rowtype;
  v_notice text := coalesce(p_booking_notice, '');
begin
  select * into v_current
  from public.booking_settings
  where id = 1
  for update;

  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  if p_expected_updated_at is not null and v_current.updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_SETTINGS_CONFLICT';
  end if;
  if p_work_start_time is null or p_work_end_time is null
     or p_work_end_time <= p_work_start_time
     or p_work_end_time - p_work_start_time < interval '30 minutes' then
    raise exception 'INVALID_WORK_HOURS';
  end if;
  if p_min_advance_days is null or p_min_advance_days < 0 or p_min_advance_days > 365 then
    raise exception 'INVALID_ADVANCE_DAYS';
  end if;
  if p_max_advance_days is null or p_max_advance_days < 0 or p_max_advance_days > 365 then
    raise exception 'INVALID_MAX_ADVANCE_DAYS';
  end if;
  if p_max_advance_days > 0 and p_max_advance_days < p_min_advance_days then
    raise exception 'INVALID_ADVANCE_WINDOW';
  end if;
  if char_length(v_notice) > 2000 then raise exception 'INVALID_BOOKING_NOTICE'; end if;

  update public.booking_settings
  set work_start_time = p_work_start_time,
      work_end_time = p_work_end_time,
      min_advance_days = p_min_advance_days,
      max_advance_days = p_max_advance_days,
      booking_notice = v_notice,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where id = 1
  returning * into v_saved;

  return v_saved;
end;
$function$
;
revoke all on function public.save_booking_shared_settings(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_max_advance_days integer, p_booking_notice text, p_expected_updated_at timestamp with time zone, p_actor text) from public,anon,authenticated;
grant execute on function public.save_booking_shared_settings(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_max_advance_days integer, p_booking_notice text, p_expected_updated_at timestamp with time zone, p_actor text) to service_role;
CREATE OR REPLACE FUNCTION public.save_booking_shared_settings_v2(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_max_advance_days integer, p_booking_notice text, p_store_service_minutes integer, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_actor text DEFAULT NULL::text)
 RETURNS booking_settings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_current public.booking_settings%rowtype;
  v_saved public.booking_settings%rowtype;
  v_notice text := coalesce(p_booking_notice, '');
  v_store_id constant uuid := '00000000-0000-4000-8000-000000000010'::uuid;
begin
  select * into v_current
  from public.booking_settings
  where id = 1
  for update;

  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  if p_expected_updated_at is not null and v_current.updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_SETTINGS_CONFLICT';
  end if;
  if p_work_start_time is null or p_work_end_time is null
     or p_work_end_time <= p_work_start_time
     or p_work_end_time - p_work_start_time < interval '30 minutes' then
    raise exception 'INVALID_WORK_HOURS';
  end if;
  if p_min_advance_days is null or p_min_advance_days < 0 or p_min_advance_days > 365 then
    raise exception 'INVALID_ADVANCE_DAYS';
  end if;
  if p_max_advance_days is null or p_max_advance_days < 0 or p_max_advance_days > 365 then
    raise exception 'INVALID_MAX_ADVANCE_DAYS';
  end if;
  if p_max_advance_days > 0 and p_max_advance_days < p_min_advance_days then
    raise exception 'INVALID_ADVANCE_WINDOW';
  end if;
  if char_length(v_notice) > 2000 then raise exception 'INVALID_BOOKING_NOTICE'; end if;
  if p_store_service_minutes is null or p_store_service_minutes < 1 or p_store_service_minutes > 720 then
    raise exception 'INVALID_STORE_SERVICE_MINUTES';
  end if;

  perform 1
  from public.booking_services
  where id = v_store_id and deleted_at is null
  for update;
  if not found then raise exception 'BOOKING_STORE_SERVICE_MISSING'; end if;

  update public.booking_settings
  set work_start_time = p_work_start_time,
      work_end_time = p_work_end_time,
      min_advance_days = p_min_advance_days,
      max_advance_days = p_max_advance_days,
      booking_notice = v_notice,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where id = 1
  returning * into v_saved;

  update public.booking_services
  set duration_minutes = p_store_service_minutes,
      updated_at = now()
  where id = v_store_id
    and deleted_at is null;

  return v_saved;
end;
$function$
;
revoke all on function public.save_booking_shared_settings_v2(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_max_advance_days integer, p_booking_notice text, p_store_service_minutes integer, p_expected_updated_at timestamp with time zone, p_actor text) from public,anon,authenticated;
grant execute on function public.save_booking_shared_settings_v2(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_max_advance_days integer, p_booking_notice text, p_store_service_minutes integer, p_expected_updated_at timestamp with time zone, p_actor text) to service_role;
CREATE OR REPLACE FUNCTION public.save_point_card(p_actor_line_user_id text, p_card jsonb, p_expected_updated_at timestamp with time zone)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_card_id text := nullif(trim(p_card->>'cardId'),'');
  v_id uuid;
  v_now timestamptz := now();
  v_reward jsonb;
  v_template_id uuid;
  v_threshold integer;
  v_reward_row_id uuid;
  v_matched_reward_ids uuid[] := array[]::uuid[];
  v_style_key text := lower(trim(coalesce(nullif(p_card->>'pointCardStyleKey',''), nullif(p_card->>'styleKey',''), '')));
  v_required_service_types text[] := '{}'::text[];
  v_requested_service_type_count integer := 0;
begin
  v_style_key := case v_style_key
    when 'forest' then 'lagoon'
    when 'midnight' then 'skyline'
    when 'ocean' then 'denim'
    when 'sunset' then 'coral'
    when 'lavender' then 'violet'
    when 'rose' then 'berry'
    when 'gold' then 'citrus'
    when 'platinum' then 'cocoa'
    when 'mint' then 'lime'
    when 'cherry' then 'peach'
    else v_style_key
  end;

  if v_style_key not in ('citrus','coral','lagoon','skyline','violet','berry','cocoa','lime','denim','peach') then
    raise exception 'INVALID_POINT_CARD_STYLE';
  end if;

  if v_card_id is null then
    v_card_id := public.new_public_id('PC');
    insert into public.point_cards(
      card_id,title,status,accent,style_key,expiry_mode,expires_on,sort_order,usage_method,usage_instructions,benefit_description,
      created_by,updated_by
    ) values(
      v_card_id,trim(p_card->>'title'),p_card->>'status',p_card->>'accent',v_style_key,p_card->>'expiryMode',
      nullif(p_card->>'expiresOn','')::date,coalesce((select max(sort_order)+1 from public.point_cards),0),
      coalesce(p_card->>'usageMethod',''),coalesce(p_card->>'usageInstructions',''),coalesce(p_card->>'benefitDescription',''),
      p_actor_line_user_id,p_actor_line_user_id
    ) returning id into v_id;
  else
    select id into v_id from public.point_cards where card_id=v_card_id for update;
    if not found then raise exception 'POINT_CARD_NOT_FOUND'; end if;
    if p_expected_updated_at is not null and not exists(select 1 from public.point_cards where id=v_id and updated_at=p_expected_updated_at) then
      raise exception 'CONFLICT';
    end if;
    update public.point_cards set
      title=trim(p_card->>'title'),status=p_card->>'status',accent=p_card->>'accent',style_key=v_style_key,
      expiry_mode=p_card->>'expiryMode',expires_on=nullif(p_card->>'expiresOn','')::date,
      usage_method=coalesce(p_card->>'usageMethod',''),usage_instructions=coalesce(p_card->>'usageInstructions',''),
      benefit_description=coalesce(p_card->>'benefitDescription',''),
      updated_by=p_actor_line_user_id,updated_at=v_now
    where id=v_id;
  end if;

  if jsonb_typeof(p_card->'rewards')='array' then
    for v_reward in select value from jsonb_array_elements(p_card->'rewards')
    loop
      begin
        v_threshold := (v_reward->>'thresholdStamps')::integer;
      exception when others then
        raise exception 'INVALID_REWARD_THRESHOLD';
      end;
      if v_threshold < 1 or v_threshold > 100 then raise exception 'INVALID_REWARD_THRESHOLD'; end if;

      select id into v_template_id
      from public.ticket_templates
      where ticket_template_id=v_reward->>'ticketTemplateId';
      if not found then raise exception 'TICKET_TEMPLATE_NOT_FOUND'; end if;

      v_required_service_types := '{}'::text[];
      v_requested_service_type_count := 0;
      if v_reward ? 'requiredServiceTypes' and v_reward->'requiredServiceTypes' is not null then
        if jsonb_typeof(v_reward->'requiredServiceTypes') <> 'array'
           or jsonb_array_length(v_reward->'requiredServiceTypes') > 20 then
          raise exception 'INVALID_REQUIRED_SERVICE_TYPES';
        end if;

        select count(distinct lower(btrim(value)))
          into v_requested_service_type_count
        from jsonb_array_elements_text(v_reward->'requiredServiceTypes')
        where btrim(value) <> '';

        select coalesce(array_agg(t.name order by t.sort_order, t.created_at), '{}'::text[])
          into v_required_service_types
        from public.booking_service_types t
        where exists (
          select 1
          from jsonb_array_elements_text(v_reward->'requiredServiceTypes') requested(value)
          where lower(btrim(requested.value)) = lower(btrim(t.name))
        );

        if cardinality(v_required_service_types) <> v_requested_service_type_count then
          raise exception 'INVALID_REQUIRED_SERVICE_TYPES';
        end if;
      end if;

      v_reward_row_id := null;
      select r.id into v_reward_row_id
      from public.point_card_rewards r
      where r.point_card_id=v_id and r.threshold_stamps=v_threshold and not (r.id = any(v_matched_reward_ids))
      limit 1 for update;

      if v_reward_row_id is null then
        select r.id into v_reward_row_id
        from public.point_card_rewards r
        where r.point_card_id=v_id and r.ticket_template_id=v_template_id and not (r.id = any(v_matched_reward_ids))
        order by r.threshold_stamps limit 1 for update;
      end if;

      if v_reward_row_id is null then
        insert into public.point_card_rewards(
          reward_id,point_card_id,threshold_stamps,ticket_template_id,required_service_types
        )
        values(
          public.new_public_id('RW'),v_id,v_threshold,v_template_id,v_required_service_types
        )
        returning id into v_reward_row_id;
      else
        update public.point_card_rewards
        set threshold_stamps=v_threshold,
            ticket_template_id=v_template_id,
            required_service_types=v_required_service_types,
            updated_at=v_now
        where id=v_reward_row_id;
      end if;
      v_matched_reward_ids := array_append(v_matched_reward_ids,v_reward_row_id);
    end loop;
  end if;

  if cardinality(v_matched_reward_ids)=0 then
    delete from public.point_card_rewards where point_card_id=v_id;
  else
    delete from public.point_card_rewards where point_card_id=v_id and not (id = any(v_matched_reward_ids));
  end if;

  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
  values(public.new_public_id('AUD'),p_actor_line_user_id,'admin','admin.pointcards.save','point_card',v_card_id,'success',
    jsonb_build_object(
      'stableRewardIdentity',true,
      'rewardCount',cardinality(v_matched_reward_ids),
      'styleKey',v_style_key,
      'bookingServiceRuleAtRewardNode',true
    ));
  return v_card_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.sync_legacy_ticket_redemption_location()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not new.requires_location then
    new.redemption_locations := '[]'::jsonb;
  elsif new.redemption_locations = '[]'::jsonb and new.redemption_latitude is not null
    and new.redemption_longitude is not null and new.redemption_radius_meters is not null then
    new.redemption_locations := jsonb_build_array(jsonb_build_object(
      'name', '原核銷地點', 'latitude', new.redemption_latitude,
      'longitude', new.redemption_longitude, 'radiusMeters', new.redemption_radius_meters));
  end if;
  return new;
end;
$function$
;
revoke all on function public.sync_legacy_ticket_redemption_location() from public,anon,authenticated;
grant execute on function public.sync_legacy_ticket_redemption_location() to service_role;
CREATE OR REPLACE FUNCTION public.sync_legacy_ticket_required_service_types_to_ids()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  new.required_service_ids := coalesce((
    select array_agg(bs.id order by bs.created_at, bs.id)
    from public.booking_services bs
    where bs.deleted_at is null
      and exists (
        select 1
        from unnest(coalesce(new.required_service_types, '{}'::text[])) as required(service_type)
        where lower(btrim(required.service_type)) = lower(btrim(bs.service_type))
      )
  ), '{}'::uuid[]);
  return new;
end;
$function$
;
revoke all on function public.sync_legacy_ticket_required_service_types_to_ids() from public,anon,authenticated;
grant execute on function public.sync_legacy_ticket_required_service_types_to_ids() to service_role;
CREATE OR REPLACE FUNCTION public.sync_ticket_required_service_type_name()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if lower(btrim(old.name)) = lower(btrim(new.name)) then
    return new;
  end if;

  update public.point_card_rewards
  set required_service_types = array(
        select case
          when lower(btrim(value)) = lower(btrim(old.name)) then new.name
          else value
        end
        from unnest(required_service_types) as value
      ),
      updated_at = now()
  where exists (
    select 1 from unnest(required_service_types) as value
    where lower(btrim(value)) = lower(btrim(old.name))
  );

  update public.event_tickets
  set required_service_types = array(
        select case
          when lower(btrim(value)) = lower(btrim(old.name)) then new.name
          else value
        end
        from unnest(required_service_types) as value
      ),
      updated_at = now()
  where exists (
    select 1 from unnest(required_service_types) as value
    where lower(btrim(value)) = lower(btrim(old.name))
  );

  return new;
end;
$function$
;
revoke all on function public.sync_ticket_required_service_type_name() from public,anon,authenticated;
grant execute on function public.sync_ticket_required_service_type_name() to service_role;
CREATE OR REPLACE FUNCTION maintenance.ensure_event_ticket_settings_baseline()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  insert into public.event_ticket_settings(
    id,
    max_tickets_per_redemption,
    max_tickets_per_day,
    updated_by
  )
  values (1, 1, 1, 'system')
  on conflict (id) do nothing;

  if not exists (
    select 1
      from public.event_ticket_settings
     where id = 1
       and max_tickets_per_day between 1 and 50
       and max_tickets_per_redemption between 1 and 50
  ) then
    raise exception 'REQUIRED_EVENT_TICKET_SETTINGS_BASELINE_INVALID';
  end if;
end;
$function$
;
CREATE OR REPLACE FUNCTION maintenance.ensure_required_system_baseline()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_primary_technician_id uuid;
begin
  -- Booking service categories must exist before the built-in service is usable
  -- in admin/user booking selectors after a full reset.
  insert into public.booking_service_types(name, sort_order)
  values ('店內招待', 0)
  on conflict do nothing;

  -- A booking cannot be created unless booking_settings points to an active
  -- primary technician. Recreate a deterministic system baseline technician
  -- after one-click clear, while preserving any valid admin-selected primary.
  insert into public.booking_technicians(
    name,
    is_active,
    sort_order,
    created_by
  )
  values ('系統主要技師', true, 0, 'system')
  on conflict do nothing;

  update public.booking_technicians
     set is_active = true,
         sort_order = 0,
         updated_at = clock_timestamp()
   where lower(btrim(name)) = lower(btrim('系統主要技師'));

  select id
    into v_primary_technician_id
    from public.booking_technicians
   where lower(btrim(name)) = lower(btrim('系統主要技師'))
     and is_active = true
   order by created_at
   limit 1;

  if v_primary_technician_id is null then
    raise exception 'SYSTEM_PRIMARY_TECHNICIAN_BASELINE_FAILED';
  end if;

  insert into public.booking_settings(
    id,
    work_start_time,
    work_end_time,
    min_advance_days,
    max_advance_days,
    booking_notice,
    max_party_size,
    primary_technician_id,
    updated_by
  )
  values (
    1,
    '09:00:00',
    '17:00:00',
    0,
    0,
    '',
    1,
    v_primary_technician_id,
    'system'
  )
  on conflict (id) do nothing;

  -- Do not overwrite a valid administrator-selected primary technician.
  -- Repair only a missing or inactive reference.
  update public.booking_settings bs
     set primary_technician_id = v_primary_technician_id,
         updated_by = 'system-baseline',
         updated_at = clock_timestamp()
   where bs.id = 1
     and (
       bs.primary_technician_id is null
       or not exists (
         select 1
           from public.booking_technicians t
          where t.id = bs.primary_technician_id
            and t.is_active = true
       )
     );

  insert into public.membership_tier_settings(
    tier_key,
    tier_label,
    required_service_minutes,
    style_key,
    updated_by
  )
  values
    ('general', '一般會員', 0, 'forest', 'system'),
    ('silver', '銀級會員', 600, 'ocean', 'system'),
    ('gold', '金級會員', 1800, 'gold', 'system'),
    ('platinum', '白金會員', 3600, 'platinum', 'system')
  on conflict (tier_key) do nothing;

  insert into public.point_card_settings(
    id,
    max_tickets_per_redemption,
    updated_by
  )
  values (1, 1, 'system')
  on conflict (id) do nothing;

  insert into public.booking_services(
    id,
    title,
    description,
    service_type,
    work_start_time,
    work_end_time,
    slot_minutes,
    min_advance_days,
    available_weekdays,
    duration_minutes,
    price_amount,
    counts_toward_membership,
    is_active,
    requires_companion_service,
    created_by
  )
  values (
    '00000000-0000-4000-8000-000000000010'::uuid,
    '店內服務（肩頸／龜苓膏／熱茶）',
    '__SYSTEM__:included-store-service',
    '店內招待',
    '09:00:00',
    '17:00:00',
    30,
    0,
    array[0,1,2,3,4,5,6]::smallint[],
    10,
    0,
    false,
    true,
    false,
    'system'
  )
  on conflict (id) do nothing;

  insert into public.birthday_benefit_settings(
    singleton,
    enabled,
    updated_by
  )
  values (true, false, 'system')
  on conflict (singleton) do nothing;

  insert into public.test_mode_settings(
    id,
    enabled,
    allow_admin_user_login,
    maintenance_message,
    updated_by,
    maintenance_enabled,
    allow_pc_test_login,
    allow_mobile_test_login
  )
  values (true, false, false, '', 'system', false, false, false)
  on conflict (id) do nothing;

  insert into booking_notifications.config(id, enabled)
  values (true, true)
  on conflict (id) do update
    set enabled = excluded.enabled;

  -- Postconditions: a one-click clear must be atomic. If any required baseline
  -- cannot be rebuilt, raise so the surrounding TRUNCATE transaction rolls back
  -- instead of leaving a partially-cleared, unusable system.
  if not exists (
    select 1
      from public.booking_settings bs
      join public.booking_technicians t
        on t.id = bs.primary_technician_id
       and t.is_active = true
     where bs.id = 1
  ) then
    raise exception 'REQUIRED_BOOKING_BASELINE_INVALID';
  end if;

  if not exists (
    select 1
      from public.booking_service_types
     where lower(btrim(name)) = lower(btrim('店內招待'))
  ) then
    raise exception 'REQUIRED_BOOKING_SERVICE_TYPE_BASELINE_INVALID';
  end if;

  if not exists (
    select 1
      from public.booking_services
     where id = '00000000-0000-4000-8000-000000000010'::uuid
       and is_active = true
       and lower(btrim(coalesce(service_type, ''))) = lower(btrim('店內招待'))
  ) then
    raise exception 'REQUIRED_BOOKING_SERVICE_BASELINE_INVALID';
  end if;

  if (select count(*) from public.membership_tier_settings
      where tier_key in ('general','silver','gold','platinum')) < 4 then
    raise exception 'REQUIRED_MEMBERSHIP_TIER_BASELINE_INVALID';
  end if;

  if not exists (select 1 from public.point_card_settings where id = 1)
     or not exists (select 1 from public.birthday_benefit_settings where singleton = true)
     or not exists (select 1 from public.test_mode_settings where id = true)
     or not exists (select 1 from booking_notifications.config where id = true) then
    raise exception 'REQUIRED_SYSTEM_SETTINGS_BASELINE_INVALID';
  end if;
end;
$function$
;
CREATE TRIGGER sync_event_ticket_required_service_types_to_ids BEFORE INSERT OR UPDATE OF required_service_types ON public.event_tickets FOR EACH ROW EXECUTE FUNCTION sync_legacy_ticket_required_service_types_to_ids();
CREATE TRIGGER sync_legacy_ticket_redemption_location BEFORE INSERT OR UPDATE ON public.event_tickets FOR EACH ROW EXECUTE FUNCTION sync_legacy_ticket_redemption_location();
CREATE TRIGGER sync_point_reward_required_service_types_to_ids BEFORE INSERT OR UPDATE OF required_service_types ON public.point_card_rewards FOR EACH ROW EXECUTE FUNCTION sync_legacy_ticket_required_service_types_to_ids();
insert into public.birthday_benefit_settings(singleton,enabled) values(true,false) on conflict(singleton) do nothing;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.event_ticket_settings'::regclass and conname='event_ticket_settings_max_tickets_per_redemption_check') then alter table public.event_ticket_settings add constraint event_ticket_settings_max_tickets_per_redemption_check CHECK (((max_tickets_per_redemption >= 0) AND (max_tickets_per_redemption <= 50))); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.point_card_rewards'::regclass and conname='point_card_rewards_required_service_types_limit_check') then alter table public.point_card_rewards add constraint point_card_rewards_required_service_types_limit_check CHECK ((cardinality(required_service_types) <= 20)); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.booking_services'::regclass and conname='booking_services_end_boundary_check') then alter table public.booking_services add constraint booking_services_end_boundary_check CHECK (((EXTRACT(second FROM work_end_time) = (0)::numeric) AND ((EXTRACT(minute FROM work_end_time))::integer = ANY (ARRAY[0, 30])))); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.booking_services'::regclass and conname='booking_services_min_advance_days_check') then alter table public.booking_services add constraint booking_services_min_advance_days_check CHECK (((min_advance_days >= 0) AND (min_advance_days <= 365))); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.booking_services'::regclass and conname='booking_services_slot_minutes_check') then alter table public.booking_services add constraint booking_services_slot_minutes_check CHECK ((slot_minutes = 30)); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.booking_services'::regclass and conname='booking_services_start_boundary_check') then alter table public.booking_services add constraint booking_services_start_boundary_check CHECK (((EXTRACT(second FROM work_start_time) = (0)::numeric) AND ((EXTRACT(minute FROM work_start_time))::integer = ANY (ARRAY[0, 30])))); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.booking_services'::regclass and conname='booking_services_time_range_check') then alter table public.booking_services add constraint booking_services_time_range_check CHECK ((work_end_time > work_start_time)); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.booking_services'::regclass and conname='booking_services_weekdays_check') then alter table public.booking_services add constraint booking_services_weekdays_check CHECK ((((cardinality(available_weekdays) >= 1) AND (cardinality(available_weekdays) <= 7)) AND (available_weekdays <@ ARRAY[(0)::smallint, (1)::smallint, (2)::smallint, (3)::smallint, (4)::smallint, (5)::smallint, (6)::smallint]))); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.event_tickets'::regclass and conname='event_tickets_redemption_location_valid') then alter table public.event_tickets add constraint event_tickets_redemption_location_valid CHECK ((((requires_location = false) AND (redemption_latitude IS NULL) AND (redemption_longitude IS NULL) AND (redemption_radius_meters IS NULL)) OR ((requires_location = true) AND (ticket_type = ANY (ARRAY['coupon'::text, 'membership_join'::text])) AND (redemption_latitude IS NOT NULL) AND (redemption_longitude IS NOT NULL) AND (redemption_radius_meters IS NOT NULL) AND (redemption_latitude >= ('-90'::integer)::numeric) AND (redemption_latitude <= (90)::numeric) AND (redemption_longitude >= ('-180'::integer)::numeric) AND (redemption_longitude <= (180)::numeric) AND (redemption_radius_meters >= 50) AND (redemption_radius_meters <= 2000)))); end if; end $$;
do $$ begin if not exists(select 1 from pg_constraint where conrelid='public.event_tickets'::regclass and conname='event_tickets_required_service_types_limit_check') then alter table public.event_tickets add constraint event_tickets_required_service_types_limit_check CHECK ((cardinality(required_service_types) <= 20)); end if; end $$;
notify pgrst,'reload schema';
commit;
