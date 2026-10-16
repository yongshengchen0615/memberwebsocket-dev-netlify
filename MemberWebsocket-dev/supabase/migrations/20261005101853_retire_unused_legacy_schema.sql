-- Deploy only after the updated Edge Functions. Every drop uses RESTRICT.
set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $$
begin
  if exists (select 1 from public.test_execution_leases where expires_at > clock_timestamp()) then
    raise exception 'LEGACY_CLEANUP_ACTIVE_TEST_RUN';
  end if;
  if exists (select 1 from public.birthday_benefit_grants)
     or exists (select 1 from public.birthday_benefit_settings where enabled) then
    raise exception 'LEGACY_BIRTHDAY_DATA_REQUIRES_MIGRATION';
  end if;
  if exists (select 1 from public.point_card_rewards where cardinality(required_service_types)>0 and cardinality(required_service_ids)=0)
     or exists (select 1 from public.event_tickets where cardinality(required_service_types)>0 and cardinality(required_service_ids)=0) then
    raise exception 'LEGACY_SERVICE_REQUIREMENTS_NOT_MIGRATED';
  end if;
  if exists (select 1 from public.event_tickets where requires_location and not public.event_ticket_locations_valid(redemption_locations)) then
    raise exception 'LEGACY_LOCATIONS_NOT_MIGRATED';
  end if;
  if exists (select 1 from public.event_ticket_settings where max_tickets_per_day is distinct from max_tickets_per_redemption) then
    raise exception 'LEGACY_EVENT_LIMITS_CONFLICT';
  end if;
end;
$$;

-- RESTRICT makes an unexpected catalog dependency abort the transaction.
drop function if exists public.admin_save_test_mode(p_enabled boolean, p_allow_admin_user_login boolean, p_maintenance_message text, p_updated_by text, p_add_account_count integer) restrict;
drop function if exists public.admin_save_test_mode_v2(p_test_mode_enabled boolean, p_maintenance_enabled boolean, p_maintenance_message text, p_updated_by text, p_add_account_count integer) restrict;
drop function if exists public.admin_save_test_mode_v3(p_test_mode_enabled boolean, p_maintenance_enabled boolean, p_allow_pc_test_login boolean, p_allow_mobile_test_login boolean, p_maintenance_message text, p_updated_by text, p_add_account_count integer) restrict;
drop function if exists public.booking_has_required_service_id(p_booking_id uuid, p_required_service_ids uuid[]) restrict;
drop function if exists public.booking_has_required_service_type(p_booking_id uuid, p_required_service_types text[]) restrict;
drop function if exists public.complete_booking_with_receipt_request(p_receipt_id text, p_member_id uuid, p_actor_line_user_id text, p_expected_booking_updated_at timestamp with time zone, p_actual_mime_type text, p_actual_size_bytes integer, p_sha256_hex text) restrict;
drop function if exists public.create_booking_request(p_request_id text, p_service_id uuid, p_member_id uuid, p_booking_date date, p_start_time time without time zone, p_member_note text) restrict;
drop function if exists public.issue_birthday_benefits(p_business_date date) restrict;
drop function if exists public.prevent_delete_ticket_required_service_type() restrict;
drop function if exists public.register_accessible_receipt_request(p_receipt_id text, p_expected_receipt_updated_at timestamp with time zone, p_actor text, p_booking_id uuid, p_booking_date date, p_start_time time without time zone, p_items jsonb, p_admin_note text) restrict;
drop function if exists public.rename_booking_service_type(p_type_id uuid, p_name text, p_actor text) restrict;
drop function if exists public.save_booking_settings_with_service_types(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_service_types text[], p_expected_updated_at timestamp with time zone, p_actor text) restrict;
drop function if exists public.save_booking_shared_settings(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_booking_notice text, p_expected_updated_at timestamp with time zone, p_actor text) restrict;
drop function if exists public.save_booking_shared_settings(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_max_advance_days integer, p_booking_notice text, p_expected_updated_at timestamp with time zone, p_actor text) restrict;
drop function if exists public.save_booking_shared_settings_v2(p_work_start_time time without time zone, p_work_end_time time without time zone, p_min_advance_days integer, p_max_advance_days integer, p_booking_notice text, p_store_service_minutes integer, p_expected_updated_at timestamp with time zone, p_actor text) restrict;
drop function if exists public.sync_legacy_ticket_redemption_location() restrict;
drop function if exists public.sync_legacy_ticket_required_service_types_to_ids() restrict;
drop function if exists public.sync_ticket_required_service_type_name() restrict;
drop table public.birthday_benefit_grants restrict;
drop table public.birthday_benefit_settings restrict;
alter table public.event_tickets drop column required_service_types restrict, drop column redemption_latitude restrict, drop column redemption_longitude restrict, drop column redemption_radius_meters restrict;
alter table public.point_card_rewards drop column required_service_types restrict;
alter table public.event_ticket_settings drop column max_tickets_per_redemption restrict;
alter table public.test_mode_settings drop column enabled restrict, drop column allow_admin_user_login restrict;
alter table public.booking_services drop column work_start_time restrict, drop column work_end_time restrict, drop column slot_minutes restrict, drop column min_advance_days restrict, drop column available_weekdays restrict;
notify pgrst, 'reload schema';
