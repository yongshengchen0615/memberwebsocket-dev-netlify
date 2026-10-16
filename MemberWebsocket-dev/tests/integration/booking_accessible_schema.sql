-- Isolated receipt-registration fixture schema; no production data.
create table public.admins (id uuid not null default gen_random_uuid(),line_user_id text not null,display_name text not null default ''::text,role text not null default 'none'::text,status text not null default 'pending'::text,first_seen_at timestamp with time zone not null default now(),updated_at timestamp with time zone not null default now());
create table public.audit_logs (id uuid not null default gen_random_uuid(),audit_id text not null,actor_line_user_id text,actor_role text not null,action text not null,target_type text not null,target_id text,result text not null,detail jsonb,created_at timestamp with time zone not null default now());
create table public.booking_completion_settlements (booking_id uuid not null,member_id uuid not null,service_minutes integer not null,reward_details jsonb not null default '[]'::jsonb,completed_by text not null,created_at timestamp with time zone not null default now());
create table public.booking_items (id uuid not null default gen_random_uuid(),booking_id uuid not null,service_id uuid not null,service_title text not null,unit_duration_minutes integer not null,quantity smallint not null default 1,created_at timestamp with time zone not null default now(),unit_price_amount integer not null default 0,service_type text,counts_toward_membership boolean not null default true);
create table public.booking_participant_items (id uuid not null default gen_random_uuid(),participant_id uuid not null,service_id uuid not null,service_title text not null,unit_duration_minutes integer not null,unit_price_amount integer not null default 0,quantity smallint not null default 1,created_at timestamp with time zone not null default now());
create table public.booking_participants (id uuid not null default gen_random_uuid(),booking_id uuid not null,"position" smallint not null,created_at timestamp with time zone not null default now(),technician_id uuid);
create table public.booking_receipt_cleanup_queue (id bigint not null,object_path text not null,reason text not null default ''::text,enqueued_at timestamp with time zone not null default now(),attempts integer not null default 0,last_error text not null default ''::text);
create table public.booking_receipts (id uuid not null default gen_random_uuid(),receipt_id text not null,booking_id uuid not null,member_id uuid not null,request_id text not null,storage_bucket text not null default 'booking-receipts'::text,object_path text not null,declared_mime_type text not null,declared_size_bytes integer not null,actual_mime_type text,actual_size_bytes integer,sha256_hex text,status text not null default 'pending_upload'::text,failure_reason text not null default ''::text,bound_at timestamp with time zone,created_at timestamp with time zone not null default now(),updated_at timestamp with time zone not null default now());
create table public.booking_service_type_rewards (service_type_id uuid not null,point_card_id uuid not null,minutes_per_point integer not null,created_by text not null default 'system'::text,updated_by text not null default 'system'::text,created_at timestamp with time zone not null default now(),updated_at timestamp with time zone not null default now());
create table public.booking_service_types (id uuid not null default gen_random_uuid(),name text not null,sort_order integer not null default 0,created_at timestamp with time zone not null default now(),updated_at timestamp with time zone not null default now());
create table public.booking_services (id uuid not null default gen_random_uuid(),title text not null,description text not null default ''::text,work_start_time time without time zone not null default '09:00:00'::time without time zone,work_end_time time without time zone not null default '17:00:00'::time without time zone,slot_minutes integer not null default 30,min_advance_days integer not null default 0,available_weekdays smallint[] not null default ARRAY[(0)::smallint, (1)::smallint, (2)::smallint, (3)::smallint, (4)::smallint, (5)::smallint, (6)::smallint],is_active boolean not null default true,created_by text not null,created_at timestamp with time zone not null default now(),updated_at timestamp with time zone not null default now(),duration_minutes integer not null default 30,price_amount integer not null default 0,service_type text,counts_toward_membership boolean not null default true,deleted_at timestamp with time zone,deleted_by text,requires_companion_service boolean not null default false);
create table public.booking_settings (id smallint not null default 1,work_start_time time without time zone not null default '09:00:00'::time without time zone,work_end_time time without time zone not null default '17:00:00'::time without time zone,updated_by text,updated_at timestamp with time zone not null default now(),min_advance_days integer not null default 0,booking_notice text not null default ''::text,max_party_size smallint not null default 1,primary_technician_id uuid,max_advance_days integer not null default 0,slot_interval_minutes integer not null default 30,reminder_enabled boolean not null default false,reminder_time time without time zone not null default '18:00:00'::time without time zone);
create table public.booking_technicians (id uuid not null default gen_random_uuid(),name text not null,is_active boolean not null default true,sort_order integer not null default 0,created_by text,created_at timestamp with time zone not null default now(),updated_at timestamp with time zone not null default now());
create table public.bookings (id uuid not null default gen_random_uuid(),request_id text not null,service_id uuid not null,member_id uuid not null,booking_date date not null,start_time time without time zone not null,end_time time without time zone not null,status text not null default 'pending'::text,member_note text not null default ''::text,admin_note text not null default ''::text,confirmed_by text,confirmed_at timestamp with time zone,rejected_by text,rejected_at timestamp with time zone,cancelled_by text,cancelled_at timestamp with time zone,created_at timestamp with time zone not null default now(),updated_at timestamp with time zone not null default now(),total_duration_minutes integer not null default 30,completed_at timestamp with time zone,completed_by text,cancellation_requested_at timestamp with time zone,cancellation_requested_by text,cancellation_source_status text,cancellation_reviewed_at timestamp with time zone,cancellation_reviewed_by text,cancellation_decision text,contact_source text not null default 'member'::text,contact_surname text,contact_salutation text,contact_phone text,technician_id uuid not null default '00000000-0000-4000-8000-000000000020'::uuid,party_size smallint not null default 1,starts_next_day boolean not null default false,start_at timestamp without time zone generated always as ((booking_date + start_time) +
CASE
    WHEN starts_next_day THEN '1 day'::interval
    ELSE '00:00:00'::interval
END) stored,end_at timestamp without time zone generated always as (((booking_date + start_time) +
CASE
    WHEN starts_next_day THEN '1 day'::interval
    ELSE '00:00:00'::interval
END) + make_interval(mins => total_duration_minutes)) stored);
create table public.members (id uuid not null default gen_random_uuid(),line_user_id text not null,display_name text not null default ''::text,member_code text not null,status text not null default 'active'::text,membership_status text not null default 'pending'::text,birthday date,phone text,joined_at timestamp with time zone,last_login_at timestamp with time zone not null default now(),created_at timestamp with time zone not null default now(),updated_at timestamp with time zone not null default now(),surname text,salutation text,is_test_account boolean not null default false,test_account_sequence bigint,force_logout_after timestamp with time zone,invite_code text);
create table public.point_balances (member_id uuid not null,point_card_id uuid not null,stamps integer not null default 0,updated_at timestamp with time zone not null default now());
create table public.point_cards (id uuid not null default gen_random_uuid(),card_id text not null,title text not null,description text not null default ''::text,status text not null default 'draft'::text,accent text not null default '#e47845'::text,style_key text not null default 'forest'::text,expiry_mode text not null default 'unlimited'::text,expires_on date,sort_order integer not null default 0,usage_method text not null default ''::text,usage_instructions text not null default ''::text,benefit_description text not null default ''::text,created_by text not null,created_at timestamp with time zone not null default now(),updated_by text not null,updated_at timestamp with time zone not null default now());
create table public.point_entries (id uuid not null default gen_random_uuid(),entry_id text not null,member_id uuid not null,point_card_id uuid not null,amount integer not null,note text not null default ''::text,created_by text not null,created_at timestamp with time zone not null default now(),request_id text,entry_type text not null default 'grant'::text,reference_type text,reference_id text);
create table public.service_time_entries (id uuid not null default gen_random_uuid(),entry_id text not null,member_id uuid not null,minutes integer not null,note text not null default ''::text,created_by text not null,created_at timestamp with time zone not null default now(),request_id text);

alter table members add primary key(id);
alter table admins add primary key(id);
alter table booking_services add primary key(id);
alter table bookings add primary key(id);
alter table booking_receipts add primary key(id);
alter table booking_receipts add unique(receipt_id);
alter table booking_receipts add unique(member_id,request_id);
alter table booking_receipts add unique(object_path);
alter table booking_completion_settlements add primary key(booking_id);
alter table booking_receipt_cleanup_queue alter column id add generated always as identity;
alter table booking_receipt_cleanup_queue add unique(object_path);
alter table booking_participants add primary key(id);
alter table point_cards add primary key(id);
alter table point_balances add primary key(member_id,point_card_id);
create unique index service_entries_request on service_time_entries(request_id,member_id) where request_id is not null and request_id<>'';
create unique index point_entries_request on point_entries(request_id,member_id,point_card_id) where request_id is not null and request_id<>'';
create function new_public_id(prefix text) returns text language sql as $$ select prefix||gen_random_uuid()::text $$;
create function issue_eligible_point_tickets(uuid,uuid) returns void language sql as $$ select $$;
create table calendar_items(item_type text,status text,starts_on date,ends_on date);
create function booking_business_date(timestamp,time,time) returns date language sql as $$ select $1::date $$;
CREATE OR REPLACE FUNCTION public.enforce_booking_advance_window()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_settings public.booking_settings%rowtype;
  v_today date;
begin
  if tg_op = 'UPDATE' and new.booking_date is not distinct from old.booking_date then return new; end if;
  select * into v_settings from public.booking_settings where id = 1;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  v_today := public.booking_business_date(clock_timestamp() at time zone 'Asia/Taipei',
    v_settings.work_start_time,v_settings.work_end_time);
  if new.booking_date < v_today + coalesce(v_settings.min_advance_days,0) then raise exception 'BOOKING_TOO_EARLY'; end if;
  if coalesce(v_settings.max_advance_days,0) > 0
     and new.booking_date > v_today + v_settings.max_advance_days then raise exception 'BOOKING_TOO_FAR'; end if;
  return new;
end; $function$
;
CREATE OR REPLACE FUNCTION public.enforce_booking_live_clock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.status in ('pending','confirmed') and
     (new.booking_date + new.start_time + (case when new.starts_next_day then interval '1 day' else interval '0 days' end))
       <= (clock_timestamp() at time zone 'Asia/Taipei') then
    raise exception 'BOOKING_TIME_PASSED';
  end if;
  return new;
end; $function$
;
CREATE OR REPLACE FUNCTION public.prevent_booking_on_active_holiday()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if exists (
    select 1
    from public.calendar_items
    where item_type = 'holiday'
      and status = 'active'
      and starts_on <= new.booking_date
      and coalesce(ends_on, starts_on) >= new.booking_date
  ) then
    raise exception 'BOOKING_HOLIDAY';
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.set_booking_start_day()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v public.booking_settings%rowtype;
begin
  select * into v from public.booking_settings where id = 1;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  new.starts_next_day := v.work_end_time < v.work_start_time and new.start_time < v.work_end_time;
  return new;
end $function$
;

create trigger booking_advance before insert on bookings for each row execute function enforce_booking_advance_window();
create trigger booking_live before insert on bookings for each row execute function enforce_booking_live_clock();
create trigger booking_holiday before insert on bookings for each row execute function prevent_booking_on_active_holiday();
create trigger booking_start before insert on bookings for each row execute function set_booking_start_day();
