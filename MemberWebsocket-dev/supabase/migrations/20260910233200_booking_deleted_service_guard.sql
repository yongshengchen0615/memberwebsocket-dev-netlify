-- Defense in depth for legacy/admin callers: a soft-deleted booking service
-- must never become selectable again unless a future explicit restore feature exists.
create or replace function public.guard_deleted_booking_service()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.deleted_at is not null then
    new.deleted_at := old.deleted_at;
    new.deleted_by := old.deleted_by;
    new.is_active := false;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_deleted_booking_service() from public, anon, authenticated;
grant execute on function public.guard_deleted_booking_service() to service_role;

drop trigger if exists booking_services_guard_deleted on public.booking_services;
create trigger booking_services_guard_deleted
before update on public.booking_services
for each row execute function public.guard_deleted_booking_service();
