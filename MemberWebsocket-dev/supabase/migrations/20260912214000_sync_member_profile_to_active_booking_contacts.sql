-- Keep active bookings that explicitly use member profile contact data in sync.
-- Custom booking contacts and terminal booking history remain immutable snapshots.
begin;

create or replace function public.sync_member_profile_to_active_booking_contacts()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_surname text := btrim(coalesce(new.surname, ''));
  v_salutation text := lower(btrim(coalesce(new.salutation, '')));
  v_phone text := regexp_replace(btrim(coalesce(new.phone, '')), '[()[:space:]-]', '', 'g');
begin
  if new.surname is not distinct from old.surname
     and new.salutation is not distinct from old.salutation
     and new.phone is not distinct from old.phone then
    return new;
  end if;

  -- Only propagate a complete, valid member booking profile. This prevents
  -- another administrative flow from temporarily writing incomplete values
  -- into active booking contacts.
  if char_length(v_surname) < 1
     or char_length(v_surname) > 40
     or v_salutation not in ('mr', 'ms')
     or v_phone !~ '^\+?[0-9]{8,15}$' then
    return new;
  end if;

  update public.bookings
  set contact_surname = v_surname,
      contact_salutation = v_salutation,
      contact_phone = v_phone
  where member_id = new.id
    and contact_source = 'member'
    and status in ('pending', 'confirmed')
    and (
      contact_surname is distinct from v_surname
      or contact_salutation is distinct from v_salutation
      or contact_phone is distinct from v_phone
    );

  return new;
end;
$$;

drop trigger if exists members_sync_active_booking_contacts on public.members;
create trigger members_sync_active_booking_contacts
after update of surname, salutation, phone on public.members
for each row execute function public.sync_member_profile_to_active_booking_contacts();

-- Backfill existing active member-source bookings so the admin immediately
-- sees the member's current booking name and phone after this migration.
update public.bookings b
set contact_surname = btrim(m.surname),
    contact_salutation = lower(btrim(m.salutation)),
    contact_phone = regexp_replace(btrim(m.phone), '[()[:space:]-]', '', 'g')
from public.members m
where b.member_id = m.id
  and b.contact_source = 'member'
  and b.status in ('pending', 'confirmed')
  and m.surname is not null
  and char_length(btrim(m.surname)) between 1 and 40
  and lower(btrim(coalesce(m.salutation, ''))) in ('mr', 'ms')
  and regexp_replace(btrim(coalesce(m.phone, '')), '[()[:space:]-]', '', 'g') ~ '^\+?[0-9]{8,15}$'
  and (
    b.contact_surname is distinct from btrim(m.surname)
    or b.contact_salutation is distinct from lower(btrim(m.salutation))
    or b.contact_phone is distinct from regexp_replace(btrim(m.phone), '[()[:space:]-]', '', 'g')
  );

commit;
