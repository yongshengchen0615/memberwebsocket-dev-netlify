-- The participant item snapshot already contains store service minutes for new/snapshot bookings.
-- The LINE outbox trigger must not append the store minutes a second time.
-- Keep legacy bookings (whose participant rows omit store service) compatible.
DO $migration$
DECLARE
  function_definition text;
  old_items_anchor text := '      ) as items,' || E'\n' || '      coalesce(sum(';
  new_items_anchor text := '      ) as items,' || E'\n'
    || '      coalesce(bool_or(bpi.service_id = ''00000000-0000-4000-8000-000000000010''::uuid), false) as has_store_service,' || E'\n'
    || '      coalesce(sum(';
  old_duration text := '(coalesce(participant_items.service_minutes, 0) + store_service_minutes)::text';
  new_duration text := '(coalesce(participant_items.service_minutes, 0) + case when coalesce(participant_items.has_store_service, false) then 0 else store_service_minutes end)::text';
BEGIN
  SELECT pg_get_functiondef('booking_notifications.enqueue()'::regprocedure) INTO function_definition;
  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'booking_notifications.enqueue() is missing';
  END IF;

  IF position(new_duration IN function_definition) > 0 THEN
    -- Idempotent when reapplied after a successful migration.
    RETURN;
  END IF;

  IF (length(function_definition) - length(replace(function_definition, old_items_anchor, ''))) <> length(old_items_anchor)
    OR (length(function_definition) - length(replace(function_definition, old_duration, ''))) <> length(old_duration) THEN
    RAISE EXCEPTION 'Booking LINE notification function changed; review double-count patch before applying';
  END IF;

  function_definition := replace(function_definition, old_items_anchor, new_items_anchor);
  function_definition := replace(function_definition, old_duration, new_duration);
  EXECUTE function_definition;
END
$migration$;
