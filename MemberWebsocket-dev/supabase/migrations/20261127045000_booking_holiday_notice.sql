-- Member-visible holiday notice; existing bookings and availability rules remain unchanged.
alter table public.booking_settings
  add column if not exists holiday_notice text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'booking_settings_holiday_notice_length'
      and conrelid = 'public.booking_settings'::regclass
  ) then
    alter table public.booking_settings
      add constraint booking_settings_holiday_notice_length
      check (char_length(holiday_notice) <= 400);
  end if;
end $$;

comment on column public.booking_settings.holiday_notice is
  'Optional admin-authored member holiday warning (max 400 chars). Empty uses the existing title-sensitive fallback; no LINE delivery.';
