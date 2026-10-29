-- AC-001..003: a merchant's active administrator may record a telephone booking
-- at an occupied time without weakening any member booking exclusion constraints.
-- This is an unassigned, confirmed, non-member appointment (not a member reward).
create or replace function public.admin_create_phone_booking_request(
  p_request_id text,
  p_actor text,
  p_booking_date date,
  p_start_time time without time zone,
  p_contact_surname text,
  p_contact_salutation text,
  p_contact_phone text,
  p_items jsonb,
  p_admin_note text default '',
  p_allow_overlap boolean default false
) returns public.bookings
language plpgsql
security definer
set search_path to ''
as $phone$
declare
  v_settings public.booking_settings%rowtype;
  v_service public.booking_services%rowtype;
  v_store public.booking_services%rowtype;
  v_saved public.bookings%rowtype;
  v_booking public.bookings%rowtype;
  v_item jsonb;
  v_service_id uuid;
  v_first_service uuid;
  v_seen uuid[] := '{}'::uuid[];
  v_quantity integer;
  v_total integer := 0;
  v_start timestamp without time zone;
  v_surname text := btrim(coalesce(p_contact_surname,''));
  v_salutation text := lower(btrim(coalesce(p_contact_salutation,'')));
  v_phone text := regexp_replace(btrim(coalesce(p_contact_phone,'')),'[()[:space:]-]','','g');
  v_note text := coalesce(p_admin_note,'');
  v_participant uuid;
  v_request_items jsonb;
  v_saved_items jsonb;
begin
  if not exists (
    select 1 from public.admins
    where line_user_id = p_actor and role = 'admin' and status = 'active'
  ) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_allow_overlap is distinct from true then raise exception 'BOOKING_OVERLAP_ACK_REQUIRED'; end if;
  if p_request_id !~ '^PHONE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then raise exception 'INVALID_REQUEST_ID'; end if;
  if char_length(v_surname) not between 1 and 40
    or v_salutation not in ('mr','ms')
    or v_phone !~ '^\+?[0-9]{8,15}$'
    then raise exception 'INVALID_BOOKING_CONTACT'; end if;
  if char_length(v_note) > 500 then raise exception 'INVALID_BOOKING_NOTE'; end if;
  if p_booking_date is null or p_start_time is null then raise exception 'INVALID_BOOKING_SLOT'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) not between 1 and 20
    then raise exception 'INVALID_BOOKING_ITEMS'; end if;

  select * into v_settings from public.booking_settings where id=1 for share;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  select * into v_store from public.booking_services
    where id='00000000-0000-4000-8000-000000000010'::uuid
      and is_active and deleted_at is null for share;
  if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
  v_total := v_store.duration_minutes;

  for v_item in select value from jsonb_array_elements(p_items) loop
    begin
      v_service_id := (v_item->>'serviceId')::uuid;
      v_quantity := coalesce((v_item->>'quantity')::integer,1);
    exception when others then raise exception 'INVALID_BOOKING_ITEMS';
    end;
    if v_service_id is null or v_service_id = v_store.id or v_service_id = any(v_seen)
      then raise exception 'INVALID_BOOKING_ITEMS'; end if;
    if v_quantity not between 1 and 2 then raise exception 'INVALID_BOOKING_QUANTITY'; end if;
    v_seen := array_append(v_seen,v_service_id);
    select * into v_service from public.booking_services
      where id=v_service_id and is_active and deleted_at is null for share;
    if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
    if v_service.requires_companion_service and jsonb_array_length(p_items)=1
      then raise exception 'BOOKING_ADD_ON_REQUIRES_COMPANION'; end if;
    if v_first_service is null then v_first_service := v_service_id; end if;
    v_total := v_total + v_service.duration_minutes * v_quantity;
  end loop;
  if v_total not between 1 and 1439 then raise exception 'INVALID_BOOKING_DURATION'; end if;
  if not public.booking_slot_fits(
    p_booking_date,p_start_time,v_total,
    v_settings.work_start_time,v_settings.work_end_time,v_settings.slot_interval_minutes
  ) then raise exception 'INVALID_BOOKING_SLOT'; end if;
  v_start := public.booking_slot_start_at(p_booking_date,p_start_time,v_settings.work_start_time,v_settings.work_end_time);
  if v_start <= (clock_timestamp() at time zone 'Asia/Taipei')
    then raise exception 'BOOKING_TIME_PASSED'; end if;

  select coalesce(jsonb_agg(
    jsonb_build_object('serviceId', x.service_id, 'quantity', x.quantity)
    order by x.service_id
  ),'[]'::jsonb) into v_request_items
  from (
    select (value->>'serviceId')::uuid as service_id,
           coalesce((value->>'quantity')::integer,1) as quantity
    from jsonb_array_elements(p_items)
  ) x;

  perform pg_advisory_xact_lock(hashtextextended(p_request_id,0));
  select * into v_saved from public.bookings where request_id=p_request_id;
  if found then
    select coalesce(jsonb_agg(
      jsonb_build_object('serviceId',bi.service_id,'quantity',bi.quantity) order by bi.service_id
    ),'[]'::jsonb) into v_saved_items
    from public.booking_items bi
    where bi.booking_id=v_saved.id and bi.service_id<>v_store.id;
    if v_saved.member_id is not null
      or v_saved.confirmed_by is distinct from p_actor
      or v_saved.booking_date is distinct from p_booking_date
      or v_saved.start_time is distinct from p_start_time
      or v_saved.contact_surname is distinct from v_surname
      or v_saved.contact_salutation is distinct from v_salutation
      or v_saved.contact_phone is distinct from v_phone
      or v_saved.admin_note is distinct from v_note
      or v_saved_items is distinct from v_request_items
      then raise exception 'REQUEST_ID_CONFLICT'; end if;
    return v_saved;
  end if;

  -- Unassigned technician intentionally permits concurrent telephone clients at
  -- the same time. Member-side GIST exclusions and capacity checks are unchanged.
  insert into public.bookings (
    request_id,service_id,member_id,booking_date,start_time,end_time,
    total_duration_minutes,status,member_note,admin_note,
    contact_source,contact_surname,contact_salutation,contact_phone,
    technician_id,confirmed_by,confirmed_at
  ) values (
    p_request_id,v_first_service,null,p_booking_date,p_start_time,
    (p_start_time+make_interval(mins=>v_total))::time,
    v_total,'confirmed','',v_note,
    'custom',v_surname,v_salutation,v_phone,
    null,p_actor,clock_timestamp()
  ) returning * into v_booking;

  insert into public.booking_participants(booking_id,position,technician_id)
  values(v_booking.id,1,null) returning id into v_participant;

  insert into public.booking_items(
    booking_id,service_id,service_title,unit_duration_minutes,
    unit_price_amount,quantity,service_type,counts_toward_membership
  ) values(
    v_booking.id,v_store.id,v_store.title,v_store.duration_minutes,
    v_store.price_amount,1,v_store.service_type,v_store.counts_toward_membership
  );
  insert into public.booking_participant_items(
    participant_id,service_id,service_title,unit_duration_minutes,unit_price_amount,quantity
  ) values(
    v_participant,v_store.id,v_store.title,v_store.duration_minutes,v_store.price_amount,1
  );

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_service_id := (v_item->>'serviceId')::uuid;
    v_quantity := coalesce((v_item->>'quantity')::integer,1);
    select * into v_service from public.booking_services where id=v_service_id;
    insert into public.booking_items(
      booking_id,service_id,service_title,unit_duration_minutes,
      unit_price_amount,quantity,service_type,counts_toward_membership
    ) values (
      v_booking.id,v_service.id,v_service.title,v_service.duration_minutes,
      v_service.price_amount,v_quantity,v_service.service_type,v_service.counts_toward_membership
    );
    insert into public.booking_participant_items(
      participant_id,service_id,service_title,unit_duration_minutes,unit_price_amount,quantity
    ) values (
      v_participant,v_service.id,v_service.title,v_service.duration_minutes,v_service.price_amount,v_quantity
    );
  end loop;

  insert into public.booking_audit_events(
    actor_line_user_id,actor_role,action,target_type,target_id,result,metadata
  ) values (
    p_actor,'admin','BOOKING_PHONE_CREATED','booking',v_booking.id::text,'success',
    jsonb_build_object('source','phone','allowOverlap',true,'partySize',1)
  );

  return v_booking;
exception
  when exclusion_violation then raise exception 'BOOKING_SLOT_TAKEN';
end;
$phone$;

revoke all on function public.admin_create_phone_booking_request(
  text,text,date,time without time zone,text,text,text,jsonb,text,boolean
) from public,anon,authenticated;
grant execute on function public.admin_create_phone_booking_request(
  text,text,date,time without time zone,text,text,text,jsonb,text,boolean
) to service_role;

-- Existing merchant schemas are isolated; install identical logic in each one.
-- The immutable template also needs the function so newly approved merchants
-- receive the capability without additional provisioner changes.
do $install$
declare
  v_schema text;
  v_definition text;
  v_signature text := '(text,text,date,time without time zone,text,text,text,jsonb,text,boolean)';
begin
  v_definition := pg_get_functiondef('public.admin_create_phone_booking_request(text,text,date,time without time zone,text,text,text,jsonb,text,boolean)'::regprocedure);

  update platform_private.business_templates
  set snapshot=jsonb_set(
    snapshot,'{functions}',
    coalesce(snapshot->'functions','[]'::jsonb)
      || jsonb_build_array(jsonb_build_object(
        'name','admin_create_phone_booking_request','definition',v_definition
      ))
  )
  where version='business-v1-20261019'
    and not exists (
      select 1 from jsonb_array_elements(coalesce(snapshot->'functions','[]'::jsonb)) f
      where f->>'name'='admin_create_phone_booking_request'
    );
  if not exists (select 1 from platform_private.business_templates where version='business-v1-20261019')
    then raise exception 'BUSINESS_TEMPLATE_MISSING'; end if;

  for v_schema in
    select runtime_schema from platform_private.tenants
    where runtime_schema ~ '^business_[0-9a-f]{32}$'
  loop
    execute platform_private.business_sql(v_definition,v_schema);
    execute format(
      'revoke all on function %I.admin_create_phone_booking_request%s from public,anon,authenticated',
      v_schema,v_signature
    );
    execute format(
      'grant execute on function %I.admin_create_phone_booking_request%s to service_role',
      v_schema,v_signature
    );
  end loop;
  perform pg_notify('pgrst','reload schema');
end;
$install$;
