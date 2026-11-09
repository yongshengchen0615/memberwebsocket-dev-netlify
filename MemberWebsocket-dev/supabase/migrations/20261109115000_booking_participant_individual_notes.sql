-- AC-PNOTE-001..006: persist notes per booked participant, not per group.
-- Backfill legacy booking notes onto participant #1 without deleting bookings.member_note.
-- Patch the existing v2 RPC definitions in place to preserve newer tenant-specific behavior and return types.
DO $participant_notes$
DECLARE
  v_schema text;
  v_function text;
  v_original text;
  v_updated text;
  v_matches integer;
  v_count integer;
  v_old constant text := 'set technician_id = v_technician_id';
  v_new constant text := $replacement$set technician_id = v_technician_id,
        member_note = CASE
          WHEN v_participant ? 'memberNote' THEN btrim(coalesce(v_participant->>'memberNote',''))
          WHEN v_position = 1 THEN btrim(coalesce(p_member_note,''))
          ELSE ''
        END$replacement$;
BEGIN
  FOR v_schema IN
    SELECT 'public'::text
    UNION ALL
    SELECT runtime_schema FROM platform_private.tenants
      WHERE runtime_schema ~ '^business_[0-9a-f]{32}$'
  LOOP
    EXECUTE format($ddl$ALTER TABLE %I.booking_participants
      ADD COLUMN IF NOT EXISTS member_note text NOT NULL DEFAULT ''$ddl$, v_schema);

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = format('%I.booking_participants', v_schema)::regclass
        AND conname = 'booking_participants_member_note_length_check'
    ) THEN
      EXECUTE format($ddl$ALTER TABLE %I.booking_participants
        ADD CONSTRAINT booking_participants_member_note_length_check
        CHECK (char_length(member_note) <= 500)$ddl$, v_schema);
    END IF;

    EXECUTE format($backfill$
      UPDATE %I.booking_participants AS p
         SET member_note = left(btrim(b.member_note), 500)
        FROM %I.bookings AS b
       WHERE p.booking_id = b.id
         AND p.position = 1
         AND p.member_note = ''
         AND b.member_note <> ''
    $backfill$, v_schema, v_schema);

    FOREACH v_function IN ARRAY ARRAY[
      'create_group_booking_request_v2',
      'update_group_booking_request_v2'
    ] LOOP
      SELECT pg_get_functiondef(p.oid) INTO v_original
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = v_schema AND p.proname = v_function;
      IF v_original IS NULL THEN
        RAISE EXCEPTION 'PARTICIPANT_NOTES_FUNCTION_MISSING: %.%', v_schema, v_function;
      END IF;
      v_matches := (length(v_original) - length(replace(v_original, v_old, ''))) / length(v_old);
      IF v_matches <> 1 THEN
        RAISE EXCEPTION 'PARTICIPANT_NOTES_FUNCTION_CHANGED: %.%', v_schema, v_function;
      END IF;
      v_updated := replace(v_original, v_old, v_new);
      EXECUTE v_updated;
    END LOOP;
  END LOOP;

  -- The provisioner takes columns, constraints and function bodies from the
  -- versioned template. Update all three, or new merchants would lose notes.
  SELECT count(*) INTO v_matches
  FROM platform_private.business_templates t,
       jsonb_array_elements(t.snapshot->'functions') AS f(value)
  WHERE t.version = 'business-v1-20261019'
    AND f.value->>'name' IN (
      'create_group_booking_request_v2','update_group_booking_request_v2'
    )
    AND strpos(f.value->>'definition', v_old) > 0;
  IF v_matches <> 2 THEN
    RAISE EXCEPTION 'PARTICIPANT_NOTES_TEMPLATE_FUNCTION_CHANGED: %', v_matches;
  END IF;

  UPDATE platform_private.business_templates AS t
     SET snapshot = jsonb_set(t.snapshot, '{tables}', (
       SELECT jsonb_agg(
         CASE WHEN x.value->>'name' = 'booking_participants'
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(x.value->'columns') AS c(value)
              WHERE c.value->>'name' = 'member_note'
           )
           THEN jsonb_set(x.value, '{columns}', (x.value->'columns') ||
             jsonb_build_array(jsonb_build_object(
               'name','member_note','type','text','default','''''::text',
               'notNull',true,'identity','','generated',''
             )), true)
           ELSE x.value END ORDER BY x.ordinality
       )
       FROM jsonb_array_elements(t.snapshot->'tables')
         WITH ORDINALITY AS x(value, ordinality)
     ), true)
   WHERE t.version = 'business-v1-20261019';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PARTICIPANT_NOTES_TEMPLATE_TABLE_FAILED: %', v_count;
  END IF;

  UPDATE platform_private.business_templates AS t
     SET snapshot = CASE WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(t.snapshot->'constraints') AS c(value)
        WHERE c.value->>'name' = 'booking_participants_member_note_length_check'
     ) THEN t.snapshot ELSE jsonb_set(t.snapshot,'{constraints}',
       (t.snapshot->'constraints') || jsonb_build_array(jsonb_build_object(
         'name','booking_participants_member_note_length_check',
         'type','c','table','booking_participants',
         'definition','CHECK (char_length(member_note) <= 500)'
       )),true) END
   WHERE t.version = 'business-v1-20261019';

  UPDATE platform_private.business_templates AS t
     SET snapshot = jsonb_set(t.snapshot,'{functions}', (
       SELECT jsonb_agg(
         CASE WHEN f.value->>'name' IN (
           'create_group_booking_request_v2','update_group_booking_request_v2'
         ) THEN jsonb_set(f.value,'{definition}',
             to_jsonb(replace(f.value->>'definition',v_old,v_new)),true)
         ELSE f.value END ORDER BY f.ordinality
       )
       FROM jsonb_array_elements(t.snapshot->'functions')
         WITH ORDINALITY AS f(value, ordinality)
     ),true)
   WHERE t.version = 'business-v1-20261019';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PARTICIPANT_NOTES_TEMPLATE_RPC_FAILED: %', v_count;
  END IF;

  PERFORM pg_notify('pgrst','reload schema');
END
$participant_notes$;
