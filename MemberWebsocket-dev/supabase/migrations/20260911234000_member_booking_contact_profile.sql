-- Add member booking name fields and immutable-per-booking contact snapshots.
-- Existing rows remain readable; new booking writes go through the wrapper RPCs below.

alter table public.members
  add column if not exists surname text,
  add column if not exists salutation text;

alter table public.bookings
  add column if not exists contact_source text not null default 'member',
  add column if not exists contact_surname text,
  add column if not exists contact_salutation text,
  add column if not exists contact_phone text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'members_surname_length_check' and conrelid = 'public.members'::regclass) then
    alter table public.members add constraint members_surname_length_check
      check (surname is null or char_length(btrim(surname)) between 1 and 40);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'members_salutation_check' and conrelid = 'public.members'::regclass) then
    alter table public.members add constraint members_salutation_check
      check (salutation is null or salutation in ('mr','ms'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bookings_contact_source_check' and conrelid = 'public.bookings'::regclass) then
    alter table public.bookings add constraint bookings_contact_source_check
      check (contact_source in ('member','custom'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bookings_contact_salutation_check' and conrelid = 'public.bookings'::regclass) then
    alter table public.bookings add constraint bookings_contact_salutation_check
      check (contact_salutation is null or contact_salutation in ('mr','ms'));
  end if;
end $$;

create or replace function public.create_booking_bundle_with_contact(
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time without time zone,
  p_items jsonb,
  p_member_note text default '',
  p_contact_source text default 'member',
  p_contact_surname text default '',
  p_contact_salutation text default '',
  p_contact_phone text default ''
)
returns public.bookings
language plpgsql
security invoker
set search_path = 'public'
as $$
declare
  v_member public.members%rowtype;
  v_booking public.bookings%rowtype;
  v_source text := lower(btrim(coalesce(p_contact_source, '')));
  v_surname text;
  v_salutation text;
  v_phone text;
begin
  select * into v_member from public.members where id = p_member_id;
  if not found then raise exception 'MEMBER_NOT_FOUND'; end if;

  if v_source = 'member' then
    v_surname := btrim(coalesce(v_member.surname, ''));
    v_salutation := lower(btrim(coalesce(v_member.salutation, '')));
    v_phone := regexp_replace(btrim(coalesce(v_member.phone, '')), '[()[:space:]-]', '', 'g');
  elsif v_source = 'custom' then
    v_surname := btrim(coalesce(p_contact_surname, ''));
    v_salutation := lower(btrim(coalesce(p_contact_salutation, '')));
    v_phone := regexp_replace(btrim(coalesce(p_contact_phone, '')), '[()[:space:]-]', '', 'g');
  else
    raise exception 'INVALID_BOOKING_CONTACT_SOURCE';
  end if;

  if char_length(v_surname) < 1 or char_length(v_surname) > 40 then raise exception 'INVALID_BOOKING_CONTACT_SURNAME'; end if;
  if v_salutation not in ('mr','ms') then raise exception 'INVALID_BOOKING_CONTACT_SALUTATION'; end if;
  if v_phone !~ '^\+?[0-9]{8,15}$' then raise exception 'INVALID_BOOKING_CONTACT_PHONE'; end if;

  v_booking := public.create_booking_bundle_request(
    p_request_id, p_member_id, p_booking_date, p_start_time, p_items, p_member_note
  );

  if v_booking.contact_surname is not null or v_booking.contact_salutation is not null or v_booking.contact_phone is not null then
    if v_booking.contact_source <> v_source
       or coalesce(v_booking.contact_surname, '') <> v_surname
       or coalesce(v_booking.contact_salutation, '') <> v_salutation
       or coalesce(v_booking.contact_phone, '') <> v_phone then
      raise exception 'REQUEST_ID_CONFLICT';
    end if;
    return v_booking;
  end if;

  update public.bookings
  set contact_source = v_source,
      contact_surname = v_surname,
      contact_salutation = v_salutation,
      contact_phone = v_phone
  where id = v_booking.id
  returning * into v_booking;

  return v_booking;
end;
$$;

create or replace function public.update_booking_bundle_with_contact(
  p_booking_id uuid,
  p_expected_updated_at timestamp with time zone,
  p_actor text,
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time without time zone,
  p_items jsonb,
  p_member_note text default '',
  p_contact_source text default 'member',
  p_contact_surname text default '',
  p_contact_salutation text default '',
  p_contact_phone text default ''
)
returns public.bookings
language plpgsql
security invoker
set search_path = 'public'
as $$
declare
  v_member public.members%rowtype;
  v_before public.bookings%rowtype;
  v_booking public.bookings%rowtype;
  v_source text := lower(btrim(coalesce(p_contact_source, '')));
  v_surname text;
  v_salutation text;
  v_phone text;
  v_replay boolean := false;
begin
  select * into v_member from public.members where id = p_member_id;
  if not found then raise exception 'MEMBER_NOT_FOUND'; end if;

  select * into v_before from public.bookings where id = p_booking_id and member_id = p_member_id;
  if not found then raise exception 'BOOKING_NOT_EDITABLE'; end if;
  v_replay := v_before.request_id = p_request_id;

  if v_source = 'member' then
    v_surname := btrim(coalesce(v_member.surname, ''));
    v_salutation := lower(btrim(coalesce(v_member.salutation, '')));
    v_phone := regexp_replace(btrim(coalesce(v_member.phone, '')), '[()[:space:]-]', '', 'g');
  elsif v_source = 'custom' then
    v_surname := btrim(coalesce(p_contact_surname, ''));
    v_salutation := lower(btrim(coalesce(p_contact_salutation, '')));
    v_phone := regexp_replace(btrim(coalesce(p_contact_phone, '')), '[()[:space:]-]', '', 'g');
  else
    raise exception 'INVALID_BOOKING_CONTACT_SOURCE';
  end if;

  if char_length(v_surname) < 1 or char_length(v_surname) > 40 then raise exception 'INVALID_BOOKING_CONTACT_SURNAME'; end if;
  if v_salutation not in ('mr','ms') then raise exception 'INVALID_BOOKING_CONTACT_SALUTATION'; end if;
  if v_phone !~ '^\+?[0-9]{8,15}$' then raise exception 'INVALID_BOOKING_CONTACT_PHONE'; end if;

  v_booking := public.update_booking_bundle_request(
    p_booking_id, p_expected_updated_at, p_actor, p_request_id, p_member_id,
    p_booking_date, p_start_time, p_items, p_member_note
  );

  if v_replay then
    if v_booking.contact_source <> v_source
       or coalesce(v_booking.contact_surname, '') <> v_surname
       or coalesce(v_booking.contact_salutation, '') <> v_salutation
       or coalesce(v_booking.contact_phone, '') <> v_phone then
      raise exception 'REQUEST_ID_CONFLICT';
    end if;
    return v_booking;
  end if;

  update public.bookings
  set contact_source = v_source,
      contact_surname = v_surname,
      contact_salutation = v_salutation,
      contact_phone = v_phone
  where id = v_booking.id
  returning * into v_booking;

  return v_booking;
end;
$$;

revoke all on function public.create_booking_bundle_with_contact(text, uuid, date, time without time zone, jsonb, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_booking_bundle_with_contact(text, uuid, date, time without time zone, jsonb, text, text, text, text, text) to service_role;
revoke all on function public.update_booking_bundle_with_contact(uuid, timestamp with time zone, text, text, uuid, date, time without time zone, jsonb, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.update_booking_bundle_with_contact(uuid, timestamp with time zone, text, text, uuid, date, time without time zone, jsonb, text, text, text, text, text) to service_role;

-- Test reset that intentionally preserves the admin authorization table.
create or replace function maintenance.clear_non_admin_data(confirm_clear boolean default false)
returns table(truncated_table_count integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  table_list text;
  table_count integer;
begin
  if confirm_clear is distinct from true then
    raise exception 'Refusing to clear data: call maintenance.clear_non_admin_data(true) to confirm';
  end if;

  select
    string_agg(format('%I.%I', schemaname, tablename), ', ' order by tablename),
    count(*)::integer
  into table_list, table_count
  from pg_catalog.pg_tables
  where schemaname = 'public'
    and tablename <> 'admins';

  if table_list is not null then
    execute 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY';
  end if;

  insert into public.booking_settings(id, work_start_time, work_end_time, updated_by)
  values (1, '09:00:00', '17:00:00', 'system')
  on conflict (id) do nothing;

  insert into public.membership_tier_settings(tier_key, tier_label, required_service_minutes, style_key, updated_by)
  values
    ('general','一般會員',0,'forest','system'),
    ('silver','銀級會員',600,'ocean','system'),
    ('gold','金級會員',1800,'gold','system'),
    ('platinum','白金會員',3600,'platinum','system')
  on conflict (tier_key) do nothing;

  insert into public.booking_services(
    id,title,description,service_type,work_start_time,work_end_time,slot_minutes,
    min_advance_days,available_weekdays,duration_minutes,price_amount,
    counts_toward_membership,is_active,created_by
  ) values (
    '00000000-0000-4000-8000-000000000010'::uuid,
    '店內服務（肩頸／龜苓膏／熱茶）','__SYSTEM__:included-store-service','店內招待',
    '09:00:00','17:00:00',30,0,array[0,1,2,3,4,5,6]::smallint[],10,0,false,true,'system'
  ) on conflict (id) do nothing;

  return query select coalesce(table_count, 0);
end;
$$;

revoke all on function maintenance.clear_non_admin_data(boolean) from public, anon, authenticated;
grant execute on function maintenance.clear_non_admin_data(boolean) to service_role;
