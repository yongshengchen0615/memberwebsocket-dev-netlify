-- Presentation-only rename: general stays the lowest entitlement tier.
-- Preserve every existing member record, minutes threshold, tier key and custom title.
-- Update existing public and tenant settings without touching a customized tier_label.
UPDATE public.membership_tier_settings
SET tier_label = '銅級會員'
WHERE tier_key = 'general'
  AND tier_label = '一般會員';

DO $bronze_tier$
DECLARE
  item record;
  definition text;
  old_occurrences integer;
BEGIN
  -- A tenant owns its own membership_tier_settings rows.
  FOR item IN
    SELECT table_schema
      FROM information_schema.tables
     WHERE table_name = 'membership_tier_settings'
       AND table_type = 'BASE TABLE'
       AND left(table_schema, 9) = 'business_'
  LOOP
    EXECUTE format(
      'UPDATE %I.membership_tier_settings SET tier_label = %L WHERE tier_key = %L AND tier_label = %L',
      item.table_schema, '銅級會員', 'general', '一般會員'
    );
  END LOOP;

  -- Existing stored procedures otherwise seed/rewrite the retired label on save,
  -- merchant provisioning and test baseline repair. Keep the same signatures,
  -- SECURITY DEFINER attributes and privileges; only change that literal.
  FOR item IN
    SELECT p.oid, n.nspname AS schema_name, p.proname AS function_name
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prokind = 'f'
       AND (
         (n.nspname = 'public' AND p.proname IN ('save_tier_settings', 'platform_provision_business_base_20261021'))
         OR (n.nspname = 'maintenance' AND p.proname = 'ensure_required_system_baseline')
         OR (left(n.nspname, 9) = 'business_' AND p.proname = 'save_tier_settings')
       )
  LOOP
    definition := pg_get_functiondef(item.oid);
    old_occurrences := (length(definition) - length(replace(definition, '一般會員', ''))) / length('一般會員');
    IF old_occurrences > 1 THEN
      RAISE EXCEPTION 'BRONZE_TIER_UNEXPECTED_DEFINITION: %.%', item.schema_name, item.function_name;
    END IF;
    IF old_occurrences = 1 THEN
      EXECUTE replace(definition, '一般會員', '銅級會員');
    END IF;
  END LOOP;
END
$bronze_tier$;
