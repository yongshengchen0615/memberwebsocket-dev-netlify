-- Ensure merchants provisioned after the retirement inherit the same database guard.
-- The provisioner clones platform_private.business_templates, not live public tables.
DO $template_bonus_retirement$
DECLARE
  v_template jsonb;
  v_constraint jsonb;
  v_matches integer;
BEGIN
  SELECT snapshot INTO STRICT v_template
  FROM platform_private.business_templates
  WHERE version = 'business-v1-20261019'
  FOR UPDATE;

  SELECT COUNT(*) INTO v_matches
  FROM jsonb_array_elements(coalesce(v_template->'constraints','[]'::jsonb)) c
  WHERE c->>'name' = 'calendar_items_event_bonus_retired_check';
  IF v_matches > 1 THEN
    RAISE EXCEPTION 'CALENDAR_BONUS_TEMPLATE_DUPLICATE_CONSTRAINT';
  END IF;

  SELECT jsonb_build_object(
    'table', rel.relname,
    'name', k.conname,
    'type', k.contype,
    'definition', pg_get_constraintdef(k.oid)
  ) INTO STRICT v_constraint
  FROM pg_constraint k
  JOIN pg_class rel ON rel.oid=k.conrelid
  JOIN pg_namespace n ON n.oid=rel.relnamespace
  WHERE n.nspname='public' AND rel.relname='calendar_items'
    AND k.conname='calendar_items_event_bonus_retired_check';

  IF v_matches = 0 THEN
    v_template := jsonb_set(
      v_template,'{constraints}',
      coalesce(v_template->'constraints','[]'::jsonb) || jsonb_build_array(v_constraint)
    );
    UPDATE platform_private.business_templates
    SET snapshot=v_template WHERE version='business-v1-20261019';
  ELSIF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_template->'constraints') c
    WHERE c->>'name'='calendar_items_event_bonus_retired_check'
      AND c->>'table'='calendar_items'
      AND c->>'definition'=v_constraint->>'definition'
  ) THEN
    RAISE EXCEPTION 'CALENDAR_BONUS_TEMPLATE_CONSTRAINT_DRIFT';
  END IF;
END
$template_bonus_retirement$;
