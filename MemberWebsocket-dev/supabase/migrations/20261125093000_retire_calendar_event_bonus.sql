-- Retire automatic calendar event bonus points without undoing any issued points.
-- Leave booking holiday rules, normal service rewards, and historical point ledgers intact.
-- Apply to both legacy public and all currently provisioned business schemas.
DO $migration$
DECLARE
  v_scope text;
BEGIN
  FOR v_scope IN
    SELECT nspname FROM pg_namespace
    WHERE nspname = 'public' OR left(nspname, 9) = 'business_'
    ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.calendar_items', v_scope)) IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = v_scope AND table_name = 'calendar_items'
          AND column_name = 'bonus_points_enabled'
      )
      OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = v_scope AND table_name = 'calendar_items'
          AND column_name = 'bonus_points'
      ) THEN
      CONTINUE;
    END IF;

    -- Disarm previously configured offers before adding the database guard.
    EXECUTE format(
      'UPDATE %I.calendar_items
          SET bonus_points_enabled = false, bonus_points = 0
        WHERE bonus_points_enabled IS DISTINCT FROM false OR bonus_points IS DISTINCT FROM 0',
      v_scope
    );

    -- Old/stale clients must not be able to re-enable this retired feature.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = v_scope AND t.relname = 'calendar_items'
        AND c.conname = 'calendar_items_event_bonus_retired_check'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.calendar_items
           ADD CONSTRAINT calendar_items_event_bonus_retired_check
           CHECK (bonus_points_enabled IS FALSE AND bonus_points = 0)',
        v_scope
      );
    END IF;
  END LOOP;
END;
$migration$;
