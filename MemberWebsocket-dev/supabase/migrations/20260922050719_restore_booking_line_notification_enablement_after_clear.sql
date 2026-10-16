-- Preserve booking LINE notification availability after one-click data clears.
-- Test/E2E accounts are still suppressed by the dedicated is_test_account guards.

create or replace function maintenance.ensure_required_system_baseline()
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.booking_settings(
    id,
    work_start_time,
    work_end_time,
    min_advance_days,
    max_advance_days,
    booking_notice,
    max_party_size,
    primary_technician_id,
    updated_by
  )
  values (1, '09:00:00', '17:00:00', 0, 0, '', 1, null, 'system')
  on conflict (id) do nothing;

  insert into public.membership_tier_settings(
    tier_key,
    tier_label,
    required_service_minutes,
    style_key,
    updated_by
  )
  values
    ('general', '一般會員', 0, 'forest', 'system'),
    ('silver', '銀級會員', 600, 'ocean', 'system'),
    ('gold', '金級會員', 1800, 'gold', 'system'),
    ('platinum', '白金會員', 3600, 'platinum', 'system')
  on conflict (tier_key) do nothing;

  insert into public.point_card_settings(
    id,
    max_tickets_per_redemption,
    updated_by
  )
  values (1, 1, 'system')
  on conflict (id) do nothing;

  insert into public.booking_services(
    id,
    title,
    description,
    service_type,
    work_start_time,
    work_end_time,
    slot_minutes,
    min_advance_days,
    available_weekdays,
    duration_minutes,
    price_amount,
    counts_toward_membership,
    is_active,
    requires_companion_service,
    created_by
  )
  values (
    '00000000-0000-4000-8000-000000000010'::uuid,
    '店內服務（肩頸／龜苓膏／熱茶）',
    '__SYSTEM__:included-store-service',
    '店內招待',
    '09:00:00',
    '17:00:00',
    30,
    0,
    array[0,1,2,3,4,5,6]::smallint[],
    10,
    0,
    false,
    true,
    false,
    'system'
  )
  on conflict (id) do nothing;

  insert into public.birthday_benefit_settings(
    singleton,
    enabled,
    updated_by
  )
  values (true, false, 'system')
  on conflict (singleton) do nothing;

  insert into public.test_mode_settings(
    id,
    enabled,
    allow_admin_user_login,
    maintenance_message,
    updated_by,
    maintenance_enabled,
    allow_pc_test_login,
    allow_mobile_test_login
  )
  values (true, false, false, '', 'system', false, false, false)
  on conflict (id) do nothing;

  insert into booking_notifications.config(id, enabled)
  values (true, true)
  on conflict (id) do update
    set enabled = excluded.enabled;
end;
$$;

update booking_notifications.config
set enabled = true
where id = true;
