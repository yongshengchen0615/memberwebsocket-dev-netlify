-- Event ticket relative validity: each issued claim has its own immutable deadline.
-- Fixed mode preserves all legacy behaviour, including ends_on in Asia/Taipei.
alter table public.event_tickets
  add column if not exists validity_mode text not null default 'fixed',
  add column if not exists validity_days integer;
alter table public.event_ticket_claims
  add column if not exists expires_at timestamptz;
alter table public.event_tickets
  add constraint event_ticket_validity_check check (
    (validity_mode = 'fixed' and validity_days is null)
    or (validity_mode in ('relative','both') and validity_days between 1 and 3650
      and (validity_mode <> 'both' or ends_on is not null))
  );

-- Referral reward children inherit the source campaign's lifetime semantics.
create or replace function public.inherit_referral_event_ticket_validity()
returns trigger language plpgsql security definer set search_path = ''
as $body$
begin
  if new.referral_source_event_ticket_id is not null then
    select p.validity_mode,p.validity_days
      into new.validity_mode,new.validity_days
      from public.event_tickets p where p.id=new.referral_source_event_ticket_id;
    if not found then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
  end if;
  return new;
end;
$body$;
drop trigger if exists inherit_referral_event_ticket_validity on public.event_tickets;
create trigger inherit_referral_event_ticket_validity
  before insert on public.event_tickets
  for each row execute function public.inherit_referral_event_ticket_validity();

create or replace function public.guard_event_ticket_validity_change()
returns trigger language plpgsql security definer set search_path = ''
as $body$
begin
  if (old.validity_mode is distinct from new.validity_mode
      or old.validity_days is distinct from new.validity_days
      or (old.validity_mode='both' and old.ends_on is distinct from new.ends_on))
    and exists (select 1 from public.event_ticket_claims
                where event_ticket_id=old.id limit 1) then
    raise exception 'EVENT_VALIDITY_LOCKED';
  end if;
  return new;
end;
$body$;

drop trigger if exists guard_event_ticket_validity_change on public.event_tickets;
create trigger guard_event_ticket_validity_change
  before update of validity_mode,validity_days,ends_on on public.event_tickets
  for each row execute function public.guard_event_ticket_validity_change();

create or replace function public.set_event_ticket_claim_expiry()
returns trigger language plpgsql security definer set search_path = ''
as $body$
declare
  v_mode text;
  v_days integer;
  v_end date;
begin
  select validity_mode, validity_days, ends_on into v_mode,v_days,v_end
    from public.event_tickets where id=new.event_ticket_id;
  if not found then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
  if v_mode='fixed' then
    new.expires_at := null;
  else
    new.expires_at := new.claimed_at + make_interval(days => v_days);
    if v_mode='both' and v_end is not null then
      new.expires_at := least(new.expires_at,
        ((v_end + 1)::timestamp at time zone 'Asia/Taipei'));
    end if;
  end if;
  return new;
end;
$body$;

drop trigger if exists set_event_ticket_claim_expiry on public.event_ticket_claims;
create trigger set_event_ticket_claim_expiry
  before insert on public.event_ticket_claims
  for each row execute function public.set_event_ticket_claim_expiry();

create or replace function public.guard_event_ticket_claim_expiry()
returns trigger language plpgsql security definer set search_path = ''
as $body$
begin
  if old.claimed_at is distinct from new.claimed_at
    or old.expires_at is distinct from new.expires_at
    or old.event_ticket_id is distinct from new.event_ticket_id then
    raise exception 'EVENT_TICKET_EXPIRY_IMMUTABLE';
  end if;
  if old.member_id is distinct from new.member_id
     and old.expires_at is not null and clock_timestamp() >= old.expires_at then
    raise exception 'EVENT_TICKET_EXPIRED';
  end if;
  return new;
end;
$body$;
drop trigger if exists guard_event_ticket_claim_expiry on public.event_ticket_claims;
create trigger guard_event_ticket_claim_expiry
  before update of expires_at,claimed_at,event_ticket_id,member_id on public.event_ticket_claims
  for each row execute function public.guard_event_ticket_claim_expiry();

create or replace function public.guard_event_ticket_expiry()
returns trigger language plpgsql security definer set search_path = ''
as $body$
begin
  if new.status='used' and old.status is distinct from 'used'
     and old.expires_at is not null and clock_timestamp() >= old.expires_at then
    raise exception 'EVENT_TICKET_EXPIRED';
  end if;
  return new;
end;
$body$;
drop trigger if exists guard_event_ticket_expiry on public.event_ticket_claims;
create trigger guard_event_ticket_expiry
  before update of status on public.event_ticket_claims
  for each row execute function public.guard_event_ticket_expiry();

create or replace function public.guard_booking_event_ticket_expiry()
returns trigger language plpgsql security definer set search_path = ''
as $body$
declare v_expires timestamptz;
begin
  if new.benefit_kind='event' and new.status='pending'
     and (tg_op='INSERT' or old.status is distinct from 'pending'
          or old.benefit_kind is distinct from new.benefit_kind
          or old.benefit_ref is distinct from new.benefit_ref) then
    select expires_at into v_expires from public.event_ticket_claims
      where claim_id=new.benefit_ref and member_id=new.member_id and status='claimed';
    if not found then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
    if v_expires is not null and clock_timestamp() >= v_expires then
      raise exception 'EVENT_TICKET_EXPIRED';
    end if;
  end if;
  return new;
end;
$body$;
drop trigger if exists guard_booking_event_ticket_expiry on public.booking_benefit_selections;
create trigger guard_booking_event_ticket_expiry
  before insert or update on public.booking_benefit_selections
  for each row execute function public.guard_booking_event_ticket_expiry();

-- Existing merchant isolation: keep the same constraints and guards in every schema.
do $tenants$
declare
  s text;
  f record;
  tpl jsonb;
  cols jsonb;
  cons jsonb;
  fns jsonb;
  trgs jsonb;
begin
  for s in select nspname from pg_namespace where nspname ~ '^business_[0-9a-f]{32}$'
  loop
    execute format('alter table %I.event_tickets add column if not exists validity_mode text not null default ''fixed'', add column if not exists validity_days integer',s);
    execute format('alter table %I.event_ticket_claims add column if not exists expires_at timestamptz',s);
    execute format('alter table %I.event_tickets add constraint event_ticket_validity_check check ((validity_mode=''fixed'' and validity_days is null) or (validity_mode in (''relative'',''both'') and validity_days between 1 and 3650 and (validity_mode<>''both'' or ends_on is not null)))',s);
    for f in
      select pg_get_functiondef(p.oid) definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in
        ('inherit_referral_event_ticket_validity','guard_event_ticket_validity_change','set_event_ticket_claim_expiry',
         'guard_event_ticket_claim_expiry','guard_event_ticket_expiry','guard_booking_event_ticket_expiry')
    loop
      execute replace(f.definition,'public.',format('%I.',s));
    end loop;
    execute format('create trigger inherit_referral_event_ticket_validity before insert on %1$I.event_tickets for each row execute function %1$I.inherit_referral_event_ticket_validity()',s);
    execute format('create trigger guard_event_ticket_validity_change before update of validity_mode,validity_days,ends_on on %1$I.event_tickets for each row execute function %1$I.guard_event_ticket_validity_change()',s);
    execute format('create trigger set_event_ticket_claim_expiry before insert on %1$I.event_ticket_claims for each row execute function %1$I.set_event_ticket_claim_expiry()',s);
    execute format('create trigger guard_event_ticket_claim_expiry before update of expires_at,claimed_at,event_ticket_id,member_id on %1$I.event_ticket_claims for each row execute function %1$I.guard_event_ticket_claim_expiry()',s);
    execute format('create trigger guard_event_ticket_expiry before update of status on %1$I.event_ticket_claims for each row execute function %1$I.guard_event_ticket_expiry()',s);
    execute format('create trigger guard_booking_event_ticket_expiry before insert or update on %1$I.booking_benefit_selections for each row execute function %1$I.guard_booking_event_ticket_expiry()',s);
  end loop;

  -- Provisioning blueprint for future isolated merchants.
  if to_regclass('platform_private.business_templates') is not null then
    select snapshot into tpl from platform_private.business_templates
      where version='business-v1-20261019' for update;
    if tpl is null then raise exception 'BUSINESS_TEMPLATE_MISSING'; end if;
    select jsonb_agg(
      case value->>'name'
        when 'event_tickets' then jsonb_set(value,'{columns}',
          (value->'columns') || jsonb_build_array(
            jsonb_build_object('name','validity_mode','type','text','default','''fixed''::text','notNull',true,'identity','','generated',''),
            jsonb_build_object('name','validity_days','type','integer','default',null,'notNull',false,'identity','','generated','')))
        when 'event_ticket_claims' then jsonb_set(value,'{columns}',
          (value->'columns') || jsonb_build_array(
            jsonb_build_object('name','expires_at','type','timestamp with time zone','default',null,'notNull',false,'identity','','generated','')))
        else value
      end order by ordinality) into cols
      from jsonb_array_elements(tpl->'tables') with ordinality t(value,ordinality);
    tpl := jsonb_set(tpl,'{tables}',cols);
    select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb) into cons
      from jsonb_array_elements(tpl->'constraints') with ordinality c(value,ordinality)
      where value->>'name' <> 'event_ticket_validity_check';
    select cons || jsonb_agg(jsonb_build_object(
      'name',con.conname,'table','event_tickets','type','c',
      'definition',pg_get_constraintdef(con.oid))) into cons
      from pg_constraint con join pg_class c on c.oid=con.conrelid
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname='event_tickets'
        and con.conname='event_ticket_validity_check';
    tpl := jsonb_set(tpl,'{constraints}',cons);
    select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb) into fns
      from jsonb_array_elements(tpl->'functions') with ordinality x(value,ordinality)
      where value->>'name' not in
        ('inherit_referral_event_ticket_validity','guard_event_ticket_validity_change','set_event_ticket_claim_expiry',
         'guard_event_ticket_claim_expiry','guard_event_ticket_expiry','guard_booking_event_ticket_expiry');
    select fns || coalesce(jsonb_agg(jsonb_build_object(
      'name',p.proname,'definition',pg_get_functiondef(p.oid)) order by p.proname),'[]'::jsonb) into fns
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in
        ('inherit_referral_event_ticket_validity','guard_event_ticket_validity_change','set_event_ticket_claim_expiry',
         'guard_event_ticket_claim_expiry','guard_event_ticket_expiry','guard_booking_event_ticket_expiry');
    tpl := jsonb_set(tpl,'{functions}',fns);
    select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb) into trgs
      from jsonb_array_elements(tpl->'triggers') with ordinality x(value,ordinality)
      where value->>'name' not in
        ('inherit_referral_event_ticket_validity','guard_event_ticket_validity_change','set_event_ticket_claim_expiry',
         'guard_event_ticket_claim_expiry','guard_event_ticket_expiry','guard_booking_event_ticket_expiry');
    select trgs || coalesce(jsonb_agg(jsonb_build_object(
      'name',t.tgname,'table',c.relname,'definition',pg_get_triggerdef(t.oid))
      order by t.tgname),'[]'::jsonb) into trgs
      from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and not t.tgisinternal and t.tgname in
        ('inherit_referral_event_ticket_validity','guard_event_ticket_validity_change','set_event_ticket_claim_expiry',
         'guard_event_ticket_claim_expiry','guard_event_ticket_expiry','guard_booking_event_ticket_expiry');
    tpl := jsonb_set(tpl,'{triggers}',trgs);
    update platform_private.business_templates set snapshot=tpl
      where version='business-v1-20261019';
  end if;
end;
$tenants$;
-- Guard the canonical accessible-snapshot validator. Unlike a normal booking,
-- receipt registration can submit a claim without touching booking_benefit_selections.
-- Patch the EXISTING verified function body rather than replacing later workflow,
-- location, price, or tenant-specific protections with an outdated definition.
do $snapshot_expiry$
declare
  schema_name text;
  v_definition text;
  v_before constant text := 'c.status=''claimed''';
  v_after constant text := 'c.status=''claimed'' and (c.expires_at is null or c.expires_at > clock_timestamp())';
  v_template jsonb;
  v_functions jsonb;
begin
  for schema_name in
    select nspname from pg_namespace
    where nspname='public' or nspname ~ '^business_[0-9a-f]{32}

  loop
    select pg_get_functiondef(p.oid) into v_definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=schema_name and p.proname='validate_snapshot_ticket_selection'
      and pg_get_function_identity_arguments(p.oid) =
        'p_member uuid, p_booking uuid, p_benefits jsonb, p_receipt_id text'
    limit 1;

    -- Reduced isolated PG fixtures may omit the snapshot subsystem entirely.
    if v_definition is null then
      if to_regclass(format('%I.booking_receipts',schema_name)) is not null then
        raise exception 'SNAPSHOT_VALIDATOR_MISSING for schema %', schema_name;
      end if;
      continue;
    end if;

    if strpos(v_definition,v_after)>0 then continue; end if;
    if (length(v_definition)-length(replace(v_definition,v_before,''))) <> length(v_before) then
      raise exception 'SNAPSHOT_EXPIRY_GUARD_SHAPE_CHANGED for schema %',schema_name;
    end if;
    execute replace(v_definition,v_before,v_after);
  end loop;

  if to_regclass('platform_private.business_templates') is not null then
    select snapshot into v_template from platform_private.business_templates
    where version='business-v1-20261019' for update;
    if v_template is null then raise exception 'BUSINESS_TEMPLATE_MISSING'; end if;
    if not exists (
      select 1 from jsonb_array_elements(v_template->'functions') f
      where f->>'name'='validate_snapshot_ticket_selection'
        and f->>'identityArgs'='p_member uuid, p_booking uuid, p_benefits jsonb, p_receipt_id text'
        and strpos(f->>'definition',v_before)>0
    ) then raise exception 'SNAPSHOT_EXPIRY_GUARD_SHAPE_CHANGED for business template'; end if;

    select jsonb_agg(
      case when f->>'name'='validate_snapshot_ticket_selection'
           and f->>'identityArgs'='p_member uuid, p_booking uuid, p_benefits jsonb, p_receipt_id text'
      then jsonb_set(f,'{definition}',to_jsonb(replace(f->>'definition',v_before,v_after)))
      else f end order by ordinality
    ) into v_functions
    from jsonb_array_elements(v_template->'functions') with ordinality x(f,ordinality);
    v_template:=jsonb_set(v_template,'{functions}',v_functions);
    update platform_private.business_templates set snapshot=v_template
    where version='business-v1-20261019';
  end if;
end;
$snapshot_expiry$;

notify pgrst, 'reload schema';
