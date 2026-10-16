-- Cover foreign-key lookup paths reported by Supabase Database Advisors.
-- These indexes do not change booking or membership business rules.

create index if not exists booking_participant_items_service_id_idx
  on public.booking_participant_items (service_id);

create index if not exists booking_settings_primary_technician_id_idx
  on public.booking_settings (primary_technician_id);

create index if not exists bookings_service_id_idx
  on public.bookings (service_id);

create index if not exists scheduled_grant_messages_member_id_idx
  on public.scheduled_grant_messages (member_id);
