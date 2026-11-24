-- AC-001..AC-007: Optional per-claim rolling expiry for event tickets.
-- Existing fixed starts_on/ends_on and pre-existing claims remain unchanged.
-- Each claim receives its own immutable timestamp at issuance.
create or replace function platform_private.install_event_ticket_relative_expiry(p_schema text)
returns void
language plpgsql
set search_path = ''
as $install$
begin
  if p_schema <> 'public' and p_schema !~ '^business_[0-9a-f]{32}$' then
    raise exception 'INVALID_BUSINESS_SCHEMA';
  end if;
  if to_regclass(format('%I.event_tickets', p_schema)) is null
     or to_regclass(format('%I.event_ticket_claims', p_schema)) is null then
    raise exception 'EVENT_TICKET_TABLES_MISSING';
  end if;

  execute format('alter table %I.event_tickets add column if not exists validity_days_after_claim integer', p_schema);
  execute format('alter table %I.event_ticket_claims add column if not exists expires_at timestamptz', p_schema);
  if not exists (
    select 1 from pg_constraint
    where conrelid = format('%I.event_tickets', p_schema)::regclass
      and conname = 'event_ticket_validity_days_after_claim_check'
  ) then
    execute format('alter table %I.event_tickets add constraint event_ticket_validity_days_after_claim_check check (validity_days_after_claim between 1 and 3650)', p_schema);
  end if;

  execute format($definition$
    create or replace function %1$I.set_event_ticket_claim_expiry()
    returns trigger language plpgsql set search_path = '' as $body$
    declare v_days integer;
    begin
      select validity_days_after_claim into v_days
      from %1$I.event_tickets where id = new.event_ticket_id;
      -- Neither the caller nor a later change to the campaign can extend an issued claim.
      new.expires_at := case when v_days is null then null
                            else new.claimed_at + make_interval(days => v_days) end;
      return new;
    end;
    $body$;
  $definition$, p_schema);
  execute format('revoke all on function %I.set_event_ticket_claim_expiry() from public, anon, authenticated', p_schema);
  execute format('drop trigger if exists set_event_ticket_claim_expiry on %I.event_ticket_claims', p_schema);
  execute format('create trigger set_event_ticket_claim_expiry before insert on %I.event_ticket_claims for each row execute function %I.set_event_ticket_claim_expiry()', p_schema, p_schema);

  execute format($definition$
    create or replace function %1$I.guard_event_ticket_claim_expiry()
    returns trigger language plpgsql set search_path = '' as $body$
    begin
      if new.expires_at is distinct from old.expires_at then
        raise exception 'EVENT_TICKET_EXPIRY_IMMUTABLE';
      end if;
      if new.status = 'used' and old.status is distinct from 'used'
         and old.expires_at is not null and clock_timestamp() >= old.expires_at then
        raise exception 'EVENT_TICKET_CLAIM_EXPIRED';
      end if;
      return new;
    end;
    $body$;
  $definition$, p_schema);
  execute format('revoke all on function %I.guard_event_ticket_claim_expiry() from public, anon, authenticated', p_schema);
  execute format('drop trigger if exists guard_event_ticket_claim_expiry on %I.event_ticket_claims', p_schema);
  execute format('create trigger guard_event_ticket_claim_expiry before update on %I.event_ticket_claims for each row execute function %I.guard_event_ticket_claim_expiry()', p_schema, p_schema);

  -- A stale UI or forged booking request must not reserve an already-expired claim.
  if to_regclass(format('%I.booking_benefit_selections', p_schema)) is not null then
    execute format($definition$
      create or replace function %1$I.guard_booking_event_ticket_expiry()
      returns trigger language plpgsql set search_path = '' as $body$
      declare v_expires timestamptz;
      begin
        if new.benefit_kind = 'event' and new.status = 'pending' then
          select c.expires_at into v_expires
          from %1$I.event_ticket_claims c
          where c.claim_id = new.benefit_ref and c.member_id = new.member_id;
          if v_expires is not null and clock_timestamp() >= v_expires then
            raise exception 'EVENT_TICKET_CLAIM_EXPIRED';
          end if;
        end if;
        return new;
      end;
      $body$;
    $definition$, p_schema);
    execute format('revoke all on function %I.guard_booking_event_ticket_expiry() from public, anon, authenticated', p_schema);
    execute format('drop trigger if exists guard_booking_event_ticket_expiry on %I.booking_benefit_selections', p_schema);
    execute format('create trigger guard_booking_event_ticket_expiry before insert or update of member_id,benefit_kind,benefit_ref,status on %I.booking_benefit_selections for each row execute function %I.guard_booking_event_ticket_expiry()', p_schema, p_schema);
  end if;
end
$install$;
revoke all on function platform_private.install_event_ticket_relative_expiry(text) from public, anon, authenticated, service_role;

-- Preserve all previous tenant provisioning wrappers and append the new installer.
alter function public.platform_provision_business(uuid)
  rename to platform_provision_business_before_event_ticket_relative_expiry;

create function public.platform_provision_business(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = '' as $body$
declare v_schema text;
begin
  perform public.platform_provision_business_before_event_ticket_relative_expiry(p_tenant_id);
  select runtime_schema into strict v_schema from platform_private.tenants where id = p_tenant_id;
  perform platform_private.install_event_ticket_relative_expiry(v_schema);
end
$body$;
revoke all on function public.platform_provision_business(uuid) from public, anon, authenticated;
grant execute on function public.platform_provision_business(uuid) to service_role;

select platform_private.install_event_ticket_relative_expiry('public');
do $existing$
declare v record;
begin
  for v in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
    perform platform_private.install_event_ticket_relative_expiry(v.runtime_schema);
  end loop;
end
$existing$;

comment on column public.event_tickets.validity_days_after_claim is
  'Optional 1..3650 elapsed 24-hour days since each member claim, independent of fixed campaign dates.';
comment on column public.event_ticket_claims.expires_at is
  'Immutable per-claim deadline (exclusive); null preserves legacy unlimited rolling validity.';
notify pgrst, 'reload schema';
