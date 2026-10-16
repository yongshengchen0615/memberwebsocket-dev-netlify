create or replace function public.sync_member_profile_to_active_booking_contacts()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
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

  if char_length(v_surname) < 1
     or char_length(v_surname) > 40
     or v_salutation not in ('mr', 'ms')
     or v_phone !~ '^\\+?[0-9]{8,15}$' then
    return new;
  end if;

  update public.bookings
  set contact_surname = v_surname,
      contact_salutation = v_salutation,
      contact_phone = v_phone
  where member_id = new.id
    and contact_source = 'member'
    and status in ('pending', 'confirmed')
    and not (
      cancellation_requested_at is not null
      and cancellation_reviewed_at is null
    )
    and (
      contact_surname is distinct from v_surname
      or contact_salutation is distinct from v_salutation
      or contact_phone is distinct from v_phone
    );

  return new;
end;
$function$;
