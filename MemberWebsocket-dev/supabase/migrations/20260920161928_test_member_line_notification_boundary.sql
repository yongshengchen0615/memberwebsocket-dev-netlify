create or replace function public.prevent_test_member_scheduled_grant_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.members m
    where m.id = new.member_id
      and m.is_test_account = true
  ) then
    return null;
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_test_member_scheduled_grant_message() from public, anon, authenticated;

drop trigger if exists prevent_test_member_scheduled_grant_message
  on public.scheduled_grant_messages;

create trigger prevent_test_member_scheduled_grant_message
before insert on public.scheduled_grant_messages
for each row
execute function public.prevent_test_member_scheduled_grant_message();

create or replace function booking_notifications.prevent_test_member_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.bookings b
    join public.members m on m.id = b.member_id
    where b.id = new.booking_id
      and m.is_test_account = true
  ) then
    return null;
  end if;
  return new;
end;
$$;

revoke all on function booking_notifications.prevent_test_member_outbox() from public, anon, authenticated;

drop trigger if exists prevent_test_member_outbox
  on booking_notifications.outbox;

create trigger prevent_test_member_outbox
before insert on booking_notifications.outbox
for each row
execute function booking_notifications.prevent_test_member_outbox();
