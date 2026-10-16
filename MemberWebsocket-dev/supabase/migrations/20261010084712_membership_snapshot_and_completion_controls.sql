begin;

alter table public.booking_settings add column ticket_booking_required boolean not null default true;
alter table public.booking_receipts add column requested_benefits jsonb not null default '[]'::jsonb,
  add column requested_booking_id uuid references public.bookings(id) on delete set null;
alter table public.booking_ticket_usage_requests alter column booking_id drop not null;

create function public.ticket_has_service_requirement(p_member uuid,p_kind text,p_ref text)
returns boolean language sql stable security invoker set search_path='' as $$
 select coalesce((select cardinality(coalesce(r.required_service_ids,'{}'::uuid[]))>0
 from public.point_tickets t left join public.point_card_rewards r on r.id=t.reward_id
 where p_kind='points' and t.member_id=p_member and t.ticket_id=p_ref
 union all select cardinality(e.required_service_ids)>0 from public.event_ticket_claims c
 join public.event_tickets e on e.id=c.event_ticket_id
 where p_kind='event' and c.member_id=p_member and c.claim_id=p_ref),true);
$$;

create function public.save_booking_shared_settings_v6(
 p_work_start_time time,p_work_end_time time,p_slot_interval_minutes integer,
 p_min_advance_days integer,p_max_advance_days integer,p_booking_notice text,p_store_service_minutes integer,
 p_reminder_enabled boolean,p_reminder_time time,p_expected_updated_at timestamptz,p_actor text,
 p_snapshot_location_required boolean,p_ticket_booking_required boolean
) returns public.booking_settings language plpgsql security invoker set search_path='' as $$
declare old_value boolean; result public.booking_settings%rowtype;
begin
 select ticket_booking_required into old_value from public.booking_settings where id=1 for update;
 perform public.save_booking_shared_settings_v5(p_work_start_time,p_work_end_time,p_slot_interval_minutes,
 p_min_advance_days,p_max_advance_days,p_booking_notice,p_store_service_minutes,p_reminder_enabled,
 p_reminder_time,p_expected_updated_at,p_actor,p_snapshot_location_required);
 update public.booking_settings set ticket_booking_required=coalesce(p_ticket_booking_required,old_value)
 where id=1 returning * into result;
 if old_value is distinct from result.ticket_booking_required then
 insert into public.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
 values(p_actor,'admin','TICKET_BOOKING_POLICY_UPDATED','booking_settings','1','success',
 jsonb_build_object('before',old_value,'after',result.ticket_booking_required));
 end if;
 return result;
end $$;

-- Existing callers keep the same RPC. The UI's explicit no-booking choice maps to NULL;
-- only the current server policy may authorize it. Service-restricted tickets still need a booking.
do $patch$
declare def text;
begin
 select pg_get_functiondef('public.redeem_member_tickets_for_booking_request(text,uuid,text,text[],text,jsonb)'::regprocedure) into def;
 def:=replace(def,'begin',E'begin\n  perform 1 from public.booking_settings where id=1 for share;');
 def:=replace(def,'if v_booking.id is null or v_booking.member_id<>v_member.id then',
 'if p_booking_id is not null and (v_booking.id is null or v_booking.member_id<>v_member.id) then');
 def:=replace(def,'v_previous.booking_id<>p_booking_id','v_previous.booking_id is distinct from p_booking_id');
 def:=replace(def,'if v_booking.status<>''confirmed'' or v_booking.completed_at is not null then',
 'if p_booking_id is not null and (v_booking.status<>''confirmed'' or v_booking.completed_at is not null) then');
 def:=replace(def,'  if p_kind=''points'' then',
 '  if p_booking_id is null and (select ticket_booking_required from public.booking_settings where id=1) then raise exception ''BOOKING_TICKET_CONFIRMATION_REQUIRED''; end if;
  if p_kind=''points'' then');
 def:=replace(def,'if not public.booking_ticket_matches_services(p_booking_id,v_member.id,p_kind,v_ref) then',
 'if (p_booking_id is not null and not public.booking_ticket_matches_services(p_booking_id,v_member.id,p_kind,v_ref))
 or (p_booking_id is null and public.ticket_has_service_requirement(v_member.id,p_kind,v_ref)) then');
 def:=replace(def,'    insert into public.booking_benefit_selections(',
 '    if p_booking_id is null then continue; end if;
    insert into public.booking_benefit_selections(');
 def:=replace(def,'''booking'',p_booking_id::text,''success'',jsonb_build_object(''kind''',
 'case when p_booking_id is null then ''ticket_batch'' else ''booking'' end,coalesce(p_booking_id::text,p_request_id),''success'',jsonb_build_object(''kind''');
 execute def;
end $patch$;

alter function public.member_ticket_booking_options(uuid) rename to member_ticket_booking_options_with_booking;
create function public.member_ticket_booking_options(p_member_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb; t record;
begin
 result:=public.member_ticket_booking_options_with_booking(p_member_id);
 if (select ticket_booking_required from public.booking_settings where id=1) is false
 and exists(select 1 from public.members where id=p_member_id and status='active' and membership_status='active') then
 for t in select 'points'::text kind,ticket_id ref from public.point_tickets where member_id=p_member_id and status='available'
 union all select 'event',claim_id from public.event_ticket_claims where member_id=p_member_id and status='claimed' loop
 if not public.ticket_has_service_requirement(p_member_id,t.kind,t.ref)
 and not exists(select 1 from public.booking_benefit_selections s where s.member_id=p_member_id and s.benefit_kind=t.kind and s.benefit_ref=t.ref and s.status='pending') then
 result:=jsonb_set(result,array[t.kind,t.ref],coalesce(result#>array[t.kind,t.ref],'[]'::jsonb)||
 jsonb_build_array(jsonb_build_object('bookingId','no-booking','bookingDate','','startTime','','title','不綁定預約，直接使用票券')));
 end if;
 end loop;
 end if;
 return result;
end $$;

create function public.validate_snapshot_ticket_selection(p_member uuid,p_booking uuid,p_benefits jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare item jsonb; kind text; ref text; title text; selections jsonb:='[]'; b public.bookings%rowtype;
 required boolean; cost integer; card uuid; budget record;
begin
 if p_booking is not null then
 select * into b from public.bookings where id=p_booking for update;
 if not found or b.member_id<>p_member then raise exception 'BOOKING_NOT_OWNED'; end if;
 if b.status<>'confirmed' or b.completed_at is not null then raise exception 'BOOKING_TICKET_CONFIRMATION_REQUIRED'; end if;
 if b.cancellation_requested_at is not null and b.cancellation_reviewed_at is null then raise exception 'BOOKING_CANCELLATION_PENDING'; end if;
 end if;
 perform 1 from public.members where id=p_member and status='active' and membership_status='active' for update;
 if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
 select ticket_booking_required into required from public.booking_settings where id=1 for share;
 if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
 if jsonb_typeof(p_benefits) is distinct from 'array' or jsonb_array_length(p_benefits)>20 then raise exception 'INVALID_BOOKING_BENEFITS'; end if;
 if jsonb_array_length(p_benefits)>0 and required and p_booking is null then raise exception 'BOOKING_TICKET_CONFIRMATION_REQUIRED'; end if;
 for item in select value from jsonb_array_elements(p_benefits) loop
 kind:=item->>'kind'; ref:=item->>'id';
 if kind not in ('points','event') or kind is null or coalesce(ref,'')='' or length(ref)>160
 or exists(select 1 from jsonb_array_elements(selections) s where s->>'kind'=kind and s->>'id'=ref) then raise exception 'INVALID_BOOKING_BENEFITS'; end if;
 if exists(select 1 from public.booking_benefit_selections s where s.member_id=p_member and s.benefit_kind=kind and s.benefit_ref=ref and s.status='pending' and s.booking_id is distinct from p_booking) then raise exception 'BOOKING_BENEFIT_RESERVED'; end if;
 if kind='points' then
 select t.ticket_title,t.threshold_stamps,t.point_card_id into title,cost,card from public.point_tickets t
 join public.point_cards pc on pc.id=t.point_card_id where t.ticket_id=ref and t.member_id=p_member
 and t.status='available' and pc.status='active' and (pc.expiry_mode='unlimited' or pc.expires_on>=(clock_timestamp() at time zone 'Asia/Taipei')::date)
 and not t.requires_location for update of t;
 else
 select c.ticket_title into title from public.event_ticket_claims c join public.event_tickets e on e.id=c.event_ticket_id
 where c.claim_id=ref and c.member_id=p_member and c.status='claimed' and e.status='active' and e.deleted_at is null
 and e.starts_on<=(clock_timestamp() at time zone 'Asia/Taipei')::date and e.ends_on>=(clock_timestamp() at time zone 'Asia/Taipei')::date
 and (cardinality(e.allowed_tier_keys)=0 or public.current_tier_key(p_member)=any(e.allowed_tier_keys))
 and not e.requires_location for update of c;
 end if;
 if not found then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;
 if p_booking is not null and not public.booking_ticket_matches_services(p_booking,p_member,kind,ref) then raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED'; end if;
 selections:=selections||jsonb_build_array(jsonb_build_object('kind',kind,'id',ref,'title',title));
 end loop;
 for budget in select t.point_card_id,sum(t.threshold_stamps)::integer amount
 from jsonb_array_elements(selections) s join public.point_tickets t on t.ticket_id=s->>'id' and t.member_id=p_member where s->>'kind'='points' group by t.point_card_id loop
 if budget.amount>coalesce((select stamps from public.point_balances where member_id=p_member and point_card_id=budget.point_card_id),0) then raise exception 'POINT_TICKET_INSUFFICIENT_POINTS'; end if;
 end loop;
 if (select count(*) from jsonb_array_elements(selections) s where s->>'kind'='points')>
 nullif((select max_tickets_per_redemption from public.point_card_settings where id=1),0) then raise exception 'TICKET_BATCH_LIMIT_EXCEEDED'; end if;
 if (select count(*) from jsonb_array_elements(selections) s where s->>'kind'='event')>
 nullif((select max_tickets_per_day from public.event_ticket_settings where id=1),0) then raise exception 'EVENT_TICKET_DAILY_LIMIT_REACHED'; end if;
 return selections;
end $$;

create function public.prepare_snapshot_receipt_v2(p_member_id uuid,p_request_id text,p_object_path text,p_mime_type text,p_size_bytes integer,p_location jsonb,p_benefits jsonb,p_booking_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; requested jsonb; r public.booking_receipts%rowtype;
begin
 perform public.require_snapshot_location(p_location);
 requested:=public.validate_snapshot_ticket_selection(p_member_id,p_booking_id,p_benefits);
 result:=public.prepare_accessible_receipt_request(p_member_id,p_request_id,p_object_path,p_mime_type,p_size_bytes);
 select * into r from public.booking_receipts where receipt_id=result->>'receiptId' for update;
 if coalesce((result->>'alreadyPrepared')::boolean,false) then
 if r.requested_benefits<>requested or r.requested_booking_id is distinct from p_booking_id then raise exception 'REQUEST_ID_CONFLICT'; end if;
 else update public.booking_receipts set requested_benefits=requested,requested_booking_id=p_booking_id where id=r.id; end if;
 return result;
end $$;

create function public.finalize_snapshot_receipt_v2(p_receipt_id text,p_member_id uuid,p_actor_line_user_id text,p_actual_mime_type text,p_actual_size_bytes integer,p_sha256_hex text,p_location jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.booking_receipts%rowtype; result jsonb;
begin
 select * into r from public.booking_receipts where receipt_id=p_receipt_id;
 if not found or r.member_id<>p_member_id then raise exception 'RECEIPT_NOT_OWNED'; end if;
 if r.status not in ('awaiting_review','bound') then
 perform public.validate_snapshot_ticket_selection(p_member_id,r.requested_booking_id,r.requested_benefits);
 end if;
 return public.finalize_snapshot_receipt_request(p_receipt_id,p_member_id,p_actor_line_user_id,p_actual_mime_type,p_actual_size_bytes,p_sha256_hex,p_location);
end $$;

create function public.register_snapshot_receipt_v2(p_receipt_id text,p_expected_receipt_updated_at timestamptz,p_actor text,p_booking_id uuid,p_booking_date date,p_start_time time,p_items jsonb,p_benefits jsonb,p_admin_note text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.booking_receipts%rowtype;
begin
 if not exists(select 1 from public.admins where line_user_id=p_actor and role='admin' and status='active') then raise exception 'ADMIN_REQUIRED'; end if;
 if p_booking_id is not null then perform 1 from public.bookings where id=p_booking_id for update; end if;
 select * into r from public.booking_receipts where receipt_id=p_receipt_id;
 perform 1 from public.members where id=r.member_id for update;
 select * into r from public.booking_receipts where receipt_id=p_receipt_id for update;
 perform 1 from public.booking_settings where id=1 for share;
 if r.status='awaiting_review' and jsonb_array_length(coalesce(p_benefits,'[]'))>0 then
 if (select ticket_booking_required from public.booking_settings where id=1) then
 if p_booking_id is null then raise exception 'BOOKING_TICKET_CONFIRMATION_REQUIRED'; end if;
 perform public.validate_snapshot_ticket_selection(r.member_id,p_booking_id,p_benefits);
 end if;
 end if;
 return public.register_accessible_receipt_with_benefits_request(p_receipt_id,p_expected_receipt_updated_at,p_actor,p_booking_id,p_booking_date,p_start_time,p_items,p_benefits,p_admin_note);
end $$;

create function public.cancel_snapshot_receipt_request(p_receipt_id text,p_member_id uuid,p_actor text,p_expected_updated_at timestamptz)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.booking_receipts%rowtype;
begin
 perform 1 from public.members where id=p_member_id and line_user_id=p_actor and status='active' and membership_status='active' for update;
 if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
 select * into r from public.booking_receipts where receipt_id=p_receipt_id and member_id=p_member_id and submission_mode='accessible' for update;
 if not found then raise exception 'RECEIPT_NOT_OWNED'; end if;
 if r.status='failed' and r.failure_reason='member-cancelled' then return jsonb_build_object('cancelled',true,'alreadyApplied',true); end if;
 if r.status not in ('pending_upload','awaiting_review') then raise exception 'RECEIPT_NOT_PENDING'; end if;
 if r.updated_at is distinct from p_expected_updated_at then raise exception 'BOOKING_CONFLICT'; end if;
 update public.booking_receipts set status='failed',failure_reason='member-cancelled',updated_at=now() where id=r.id;
 insert into public.booking_receipt_cleanup_queue(object_path,reason) values(r.object_path,'member-cancelled') on conflict(object_path) do nothing;
 insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
 values(public.new_public_id('AUD'),p_actor,'member','SNAPSHOT_CANCELLED','receipt',p_receipt_id,'success','{}');
 return jsonb_build_object('cancelled',true);
end $$;

-- All new SQL entrypoints inherit the existing service-only API boundary.
do $$ declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace
 and proname in ('ticket_has_service_requirement','save_booking_shared_settings_v6','member_ticket_booking_options',
 'validate_snapshot_ticket_selection','prepare_snapshot_receipt_v2','finalize_snapshot_receipt_v2','register_snapshot_receipt_v2','cancel_snapshot_receipt_request') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
-- A completion's original ledger stays immutable; corrections append deltas.
alter table public.booking_completion_settlements add column correction_context jsonb;
alter table public.service_time_entries add column entry_kind text not null default 'grant';
alter table public.service_time_entries drop constraint service_time_entries_minutes_check;
alter table public.service_time_entries add constraint service_time_entries_minutes_check
 check ((entry_kind='grant' and minutes>0) or (entry_kind='adjustment' and minutes<>0));
create table public.booking_completion_adjustments(
 id uuid primary key default pg_catalog.gen_random_uuid(),booking_id uuid not null references public.bookings(id) on delete cascade,
 request_id text not null,actor text not null,reason text not null,participants jsonb not null,
 before_items jsonb not null,before_settlement jsonb not null,after_settlement jsonb not null,
 result jsonb not null,created_at timestamptz not null default now(),unique(booking_id,request_id)
);
alter table public.booking_completion_adjustments enable row level security;
revoke all on public.booking_completion_adjustments from public,anon,authenticated;
grant all on public.booking_completion_adjustments to service_role;
create index booking_completion_adjustments_latest on public.booking_completion_adjustments(booking_id,created_at desc,id);
create index booking_receipts_requested_booking_idx on public.booking_receipts(requested_booking_id) where requested_booking_id is not null;

create function public.booking_reward_context(p_primary uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('primaryTechnicianId',p_primary,'rules',coalesce(jsonb_agg(jsonb_build_object(
 'serviceTypeId',t.id,'serviceTypeName',t.name,'pointCardId',r.point_card_id,'minutesPerPoint',r.minutes_per_point,
 'pointCardPublicId',pc.card_id,'pointCardTitle',pc.title)),'[]'::jsonb))
 from public.booking_service_type_rewards r join public.booking_service_types t on t.id=r.service_type_id
 join public.point_cards pc on pc.id=r.point_card_id;
$$;

alter function public.complete_booking_with_rewards_request(uuid,timestamptz,text,text) rename to complete_booking_with_rewards_base;
create function public.complete_booking_with_rewards_request(p_booking_id uuid,p_expected_updated_at timestamptz,p_actor text,p_admin_note text default '')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 perform 1 from public.booking_settings where id=1 for share;
 perform 1 from public.booking_service_type_rewards order by service_type_id for share;
 result:=public.complete_booking_with_rewards_base(p_booking_id,p_expected_updated_at,p_actor,p_admin_note);
 update public.booking_completion_settlements set correction_context=public.booking_reward_context((result->>'primaryTechnicianId')::uuid) where booking_id=p_booking_id;
 return result;
end $$;

-- Keep the existing participant validation and aggregation. Completed orders do
-- not reopen reservations or depend on today's business hours.
do $patch$ declare def text; begin
 select pg_get_functiondef('public.admin_update_booking_participant_items_request(uuid,timestamptz,text,jsonb)'::regprocedure) into def;
 def:=replace(def,'public.admin_update_booking_participant_items_request(', 'public.replace_completed_booking_items(');
 def:=replace(def,'before_items jsonb;', 'before_items jsonb; before_booking_items jsonb;');
 def:=replace(def,'  select sum(bi_store.unit_duration_minutes',E'  select jsonb_agg(to_jsonb(i)) into before_booking_items from public.booking_items i where i.booking_id=b.id;\n  select sum(bi_store.unit_duration_minutes');
 def:=replace(def,'where bs.id = v_service_id and bs.deleted_at is null','where bs.id = v_service_id and (bs.deleted_at is null or exists(select 1 from jsonb_array_elements(before_items) old where old->>''service_id''=v_service_id::text))');
 def:=replace(def,'if b.status not in (''pending'',''confirmed'') then','if b.status<>''completed'' then');
 def:=replace(def,'not between 1 and 20','not between 0 and 20');
 def:=replace(def,'if minutes < 1 or minutes >= 1440','if minutes < 0 or minutes >= 1440');
 def:=replace(def,'if participant.technician_id is not null then','if false then');
 def:=replace(def,'if not public.booking_slot_fits(', 'if false and not public.booking_slot_fits(');
 def:=replace(def,'set service_id = primary_service_id,','set service_id = coalesce(primary_service_id,b.service_id),');
 def:=replace(def,'minutes := minutes + service.duration_minutes * v_quantity;',
 'if item ? ''minutes'' and (jsonb_typeof(item->''minutes'')<>''number'' or (item->>''minutes'')!~''^[1-9][0-9]*$'' or (item->>''minutes'')::integer>720) then raise exception ''INVALID_BOOKING_ITEMS''; end if;
      select coalesce((old->>''unit_price_amount'')::integer,service.price_amount),coalesce(old->>''service_title'',service.title) into service.price_amount,service.title from (select (select value from jsonb_array_elements(before_items) where value->>''participant_id''=participant.id::text and value->>''service_id''=service.id::text limit 1) old) snapshot;
      service.duration_minutes:=coalesce((item->>''minutes'')::integer,service.duration_minutes);
      minutes := minutes + service.duration_minutes * v_quantity;');
 def:=replace(def,'bs.service_type,bs.counts_toward_membership',
 'coalesce((select old->>''service_type'' from jsonb_array_elements(before_booking_items) old where old->>''service_id''=bpi.service_id::text limit 1),bs.service_type),coalesce((select (old->>''counts_toward_membership'')::boolean from jsonb_array_elements(before_booking_items) old where old->>''service_id''=bpi.service_id::text limit 1),bs.counts_toward_membership)');
 -- The replacement also affects GROUP BY; snapshots and current metadata remain deterministic.
 execute def;
end $patch$;

create function public.calculate_corrected_booking_settlement(p_booking_id uuid,p_context jsonb)
returns jsonb language sql stable security invoker set search_path='' as $$
 with eligible as (
 select bi.service_type,bpi.unit_duration_minutes*bpi.quantity minutes
 from public.booking_participant_items bpi join public.booking_participants bp on bp.id=bpi.participant_id
 join public.booking_items bi on bi.booking_id=bp.booking_id and bi.service_id=bpi.service_id
 where bp.booking_id=p_booking_id and bp.technician_id=(p_context->>'primaryTechnicianId')::uuid
 and bi.counts_toward_membership and bpi.service_id<>'00000000-0000-4000-8000-000000000010'::uuid
 ), typed as (select lower(btrim(service_type)) type_key,sum(minutes)::integer minutes from eligible group by 1),
 rewards as (select r||jsonb_build_object('serviceMinutes',t.minutes,'points',floor(t.minutes::numeric/(r->>'minutesPerPoint')::integer)::integer) reward
 from typed t join lateral jsonb_array_elements(p_context->'rules') r on lower(btrim(r->>'serviceTypeName'))=t.type_key),
 friend as (select jsonb_build_object('pointCardId',reward->>'pointCardId','pointCardTitle',max(reward->>'pointCardTitle'),'points',count(*)::integer) reward
 from rewards group by reward->>'pointCardId')
 select jsonb_build_object('serviceMinutes',coalesce((select sum(minutes) from eligible),0),'rewards',coalesce((select jsonb_agg(reward order by reward->>'serviceTypeId') from rewards),'[]'),
 'friendRewardMinutes',coalesce((select sum(minutes) from eligible),0)::integer/2,'friendRewards',coalesce((select jsonb_agg(reward order by reward->>'pointCardId') from friend),'[]'));
$$;

create function public.correct_completed_booking_request(p_booking_id uuid,p_expected_updated_at timestamptz,p_actor text,p_request_id text,p_reason text,p_participants jsonb,p_apply boolean,p_expected_preview jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare b public.bookings%rowtype; original public.booking_completion_settlements%rowtype;
 previous public.booking_completion_adjustments%rowtype; context jsonb; before_value jsonb; after_value jsonb;
 before_items jsonb; result jsonb; old_minutes integer; new_minutes integer; delta integer;
 recipient uuid; primary_id uuid; candidates uuid[]; line record; card public.point_cards%rowtype; balance integer;
 reward_member uuid; reward_key text; old_points jsonb; new_points jsonb; old_total integer; new_total integer;
 entry_request text; delegated boolean;
begin
 if not exists(select 1 from public.admins where line_user_id=p_actor and role='admin' and status='active') then raise exception 'ADMIN_REQUIRED'; end if;
 if p_request_id is null or p_request_id!~'^[A-Za-z0-9_-]{8,120}$' then raise exception 'INVALID_REQUEST_ID'; end if;
 if length(btrim(coalesce(p_reason,''))) not between 1 and 500 then raise exception 'CORRECTION_REASON_REQUIRED'; end if;
 select * into b from public.bookings where id=p_booking_id for update;
 if not found or b.status<>'completed' then raise exception 'BOOKING_NOT_EDITABLE'; end if;
 select * into previous from public.booking_completion_adjustments where booking_id=p_booking_id and request_id=p_request_id;
 if found then
 if previous.participants<>p_participants or previous.reason<>p_reason then raise exception 'REQUEST_ID_CONFLICT'; end if;
 return previous.result||jsonb_build_object('alreadyApplied',true);
 end if;
 if b.updated_at is distinct from p_expected_updated_at then raise exception 'BOOKING_CONFLICT'; end if;
 select * into original from public.booking_completion_settlements where booking_id=p_booking_id for update;
 if not found then raise exception 'BOOKING_COMPLETION_REQUIRES_SETTLEMENT'; end if;
 recipient:=original.member_id; delegated:=recipient<>b.member_id;
 perform 1 from public.members where id in(recipient,b.member_id) order by id for update;
 before_value:=jsonb_build_object('serviceMinutes',original.service_minutes,'rewards',original.reward_details,
 'friendRewardMinutes',coalesce((select service_minutes from public.friend_booking_rewards where booking_id=b.id),0),
 'friendRewards',coalesce((select reward_details from public.friend_booking_rewards where booking_id=b.id),'[]'));
 select after_settlement into after_value from public.booking_completion_adjustments where booking_id=b.id order by created_at desc,id desc limit 1;
 if found then before_value:=after_value; end if;
 context:=original.correction_context;
 if context is null then
 -- Historical records are editable only when the original reward recipient can be identified.
 select array_agg(x.technician_id) into candidates from (
 select bp.technician_id from public.booking_participants bp left join public.booking_participant_items pi on pi.participant_id=bp.id
 left join public.booking_items bi on bi.booking_id=bp.booking_id and bi.service_id=pi.service_id
 where bp.booking_id=b.id and bp.technician_id is not null group by bp.technician_id
 having coalesce(sum(pi.unit_duration_minutes*pi.quantity) filter(where bi.counts_toward_membership and pi.service_id<>'00000000-0000-4000-8000-000000000010'::uuid),0)=original.service_minutes
 ) x;
 if cardinality(candidates) is distinct from 1 then raise exception 'CORRECTION_CONTEXT_REQUIRED'; end if;
 context:=jsonb_build_object('primaryTechnicianId',candidates[1],'rules',original.reward_details);
 -- Historical orders contain rates only for their original service types.
 -- Never invent a historical rate for a newly added rewarded type.
 if exists(select 1 from jsonb_array_elements(p_participants) person cross join lateral jsonb_array_elements(person->'items') item
 join public.booking_services bs on bs.id=(item->>'serviceId')::uuid join public.booking_service_types st on lower(btrim(st.name))=lower(btrim(bs.service_type))
 join public.booking_service_type_rewards rw on rw.service_type_id=st.id where not exists(select 1 from jsonb_array_elements(original.reward_details) r where r->>'serviceTypeId'=st.id::text)) then raise exception 'CORRECTION_CONTEXT_REQUIRED'; end if;
 end if;
 select coalesce(jsonb_agg(to_jsonb(i) order by bp.position,i.service_id),'[]') into before_items from public.booking_participant_items i join public.booking_participants bp on bp.id=i.participant_id where bp.booking_id=b.id;
 begin
 perform public.replace_completed_booking_items(p_booking_id,p_expected_updated_at,p_actor,p_participants);
 -- A redeemed ticket's service requirement cannot be invalidated by a correction.
 if exists(select 1 from public.booking_benefit_selections s where s.booking_id=b.id and s.status='redeemed' and s.benefit_kind in('points','event') and not public.booking_ticket_matches_services(b.id,s.member_id,s.benefit_kind,s.benefit_ref)) then raise exception 'BOOKING_REDEEMED_BENEFIT_SERVICE_REQUIRED'; end if;
 after_value:=public.calculate_corrected_booking_settlement(b.id,context);
 if not delegated then after_value:=after_value||jsonb_build_object('friendRewardMinutes',0,'friendRewards','[]'::jsonb); end if;
 entry_request:='booking-adjust:'||b.id::text||':'||p_request_id;
 result:=jsonb_build_object('before',before_value,'after',after_value,'serviceMinutesDelta',(after_value->>'serviceMinutes')::integer-(before_value->>'serviceMinutes')::integer,'pointDeltas','[]'::jsonb);
 for line in select * from (values(recipient,'rewards'::text),(b.member_id,'friendRewards'::text)) as targets(member_id,reward_key) loop
 if line.reward_key='friendRewards' and not delegated then continue; end if;
 reward_member:=line.member_id; reward_key:=line.reward_key;
 old_points:=before_value->reward_key; new_points:=after_value->reward_key;
 for card in select pc.* from public.point_cards pc where pc.id in(
 select (r->>'pointCardId')::uuid from jsonb_array_elements(old_points||new_points) r) order by pc.id for update loop
 select coalesce(sum((r->>'points')::integer),0)::integer into old_total from jsonb_array_elements(old_points) r where r->>'pointCardId'=card.id::text;
 select coalesce(sum((r->>'points')::integer),0)::integer into new_total from jsonb_array_elements(new_points) r where r->>'pointCardId'=card.id::text;
 delta:=new_total-old_total;
 if delta=0 then continue; end if;
 if delta>0 and (card.status<>'active' or (card.expiry_mode<>'unlimited' and card.expires_on<(clock_timestamp() at time zone 'Asia/Taipei')::date)) then raise exception 'BOOKING_REWARD_POINT_CARD_UNAVAILABLE'; end if;
 select stamps into balance from public.point_balances where member_id=reward_member and point_card_id=card.id for update;
 if coalesce(balance,0)+delta<0 then raise exception 'INSUFFICIENT_POINTS'; end if;
 entry_request:='booking-adjust:'||b.id::text||':'||p_request_id;
 insert into public.point_entries(entry_id,member_id,point_card_id,amount,note,created_by,request_id,entry_type,reference_type,reference_id)
 values(public.new_public_id('PE'),reward_member,card.id,delta,p_reason,p_actor,entry_request,'adjustment','booking',b.id::text);
 insert into public.point_balances(member_id,point_card_id,stamps) values(reward_member,card.id,coalesce(balance,0)+delta)
 on conflict(member_id,point_card_id) do update set stamps=excluded.stamps,updated_at=now();
 if delta>0 then perform public.issue_eligible_point_tickets(reward_member,card.id); end if;
 result:=jsonb_set(result,'{pointDeltas}',result->'pointDeltas'||jsonb_build_array(jsonb_build_object('memberId',reward_member,'pointCardId',card.id,'cardTitle',card.title,'delta',delta)));
 end loop;
 old_minutes:=(before_value->>case when reward_key='rewards' then 'serviceMinutes' else 'friendRewardMinutes' end)::integer;
 new_minutes:=(after_value->>case when reward_key='rewards' then 'serviceMinutes' else 'friendRewardMinutes' end)::integer;
 delta:=new_minutes-old_minutes;
 if delta<>0 then
 if coalesce((select sum(minutes) from public.service_time_entries where member_id=reward_member),0)+delta<0 then raise exception 'INVALID_SERVICE_TIME_BALANCE'; end if;
 insert into public.service_time_entries(entry_id,member_id,minutes,note,created_by,request_id,entry_kind)
 values(public.new_public_id('SE'),reward_member,delta,p_reason,p_actor,entry_request,'adjustment');
 end if;
 end loop;
 if not p_apply then raise sqlstate 'ZX001'; end if;
 if p_expected_preview is null or p_expected_preview<>result then raise exception 'CORRECTION_PREVIEW_STALE'; end if;
 update public.booking_completion_settlements set correction_context=context where booking_id=b.id;
 insert into public.booking_completion_adjustments(booking_id,request_id,actor,reason,participants,before_items,before_settlement,after_settlement,result)
 values(b.id,p_request_id,p_actor,p_reason,p_participants,before_items,before_value,after_value,result);
 insert into public.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
 values(p_actor,'admin','COMPLETED_BOOKING_CORRECTED','booking',b.id::text,'success',result||jsonb_build_object('reason',p_reason,'requestId',p_request_id));
 return result;
 exception when sqlstate 'ZX001' then return result; end;
end $$;

do $$ declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('booking_reward_context','complete_booking_with_rewards_request','complete_booking_with_rewards_base','replace_completed_booking_items','calculate_corrected_booking_settlement','correct_completed_booking_request') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;

notify pgrst,'reload schema';
commit;
