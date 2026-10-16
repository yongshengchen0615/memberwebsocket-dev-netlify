-- Keep retained QA fixture history from contaminating the next paired E2E run.
-- The newest paired fixture owns booking_settings.primary_technician_id.
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
