-- AC-RM-001/002: each merchant owns its reminder prose.  Actual booking details
-- are loaded at send time and are never stored as editable template text.
ALTER TABLE public.booking_settings
  ADD COLUMN IF NOT EXISTS reminder_message text NOT NULL
  DEFAULT '請準時到場；如需調整請至預約頁操作。';

DO $reminder_template$
DECLARE v_schema text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.booking_settings'::regclass
      AND conname = 'booking_reminder_message_length_check'
  ) THEN
    ALTER TABLE public.booking_settings
      ADD CONSTRAINT booking_reminder_message_length_check
      CHECK (char_length(reminder_message) BETWEEN 1 AND 400);
  END IF;

  FOR v_schema IN
    SELECT t.runtime_schema FROM platform_private.tenants t
    WHERE t.runtime_schema ~ '^business_[0-9a-f]{32}$'
  LOOP
    IF pg_catalog.to_regclass(format('%I.booking_settings', v_schema)) IS NULL THEN
      RAISE EXCEPTION 'BOOKING_SETTINGS_MISSING_IN_BUSINESS_SCHEMA';
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.booking_settings ADD COLUMN IF NOT EXISTS reminder_message text NOT NULL DEFAULT %L',
      v_schema, '請準時到場；如需調整請至預約頁操作.'
    );
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass(format('%I.booking_settings', v_schema))
        AND conname = 'booking_reminder_message_length_check'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.booking_settings ADD CONSTRAINT booking_reminder_message_length_check CHECK (char_length(reminder_message) BETWEEN 1 AND 400)',
        v_schema
      );
    END IF;
  END LOOP;
END $reminder_template$;

-- Booking reminder content is written only via the existing authenticated,
-- rate-limited admin Edge API. Do not grant public/anon/authenticated writes.
