create or replace function public.sync_ticket_required_service_type_name()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if lower(btrim(old.name)) = lower(btrim(new.name)) then
    return new;
  end if;

  update public.ticket_templates
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
$$;

create or replace function public.prevent_delete_ticket_required_service_type()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.ticket_templates tt
    cross join unnest(tt.required_service_types) as value
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
$$;

drop trigger if exists sync_ticket_required_service_type_name_trigger
  on public.booking_service_types;
create trigger sync_ticket_required_service_type_name_trigger
after update of name on public.booking_service_types
for each row
execute function public.sync_ticket_required_service_type_name();

drop trigger if exists prevent_delete_ticket_required_service_type_trigger
  on public.booking_service_types;
create trigger prevent_delete_ticket_required_service_type_trigger
before delete on public.booking_service_types
for each row
execute function public.prevent_delete_ticket_required_service_type();

revoke all on function public.sync_ticket_required_service_type_name() from public, anon, authenticated;
revoke all on function public.prevent_delete_ticket_required_service_type() from public, anon, authenticated;
