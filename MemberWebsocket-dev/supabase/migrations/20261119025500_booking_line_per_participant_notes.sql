-- AC-BPN-001..006: one participant's note must only appear inside that
-- participant's LINE block for all three booking channels.
-- Fail closed when the current tenant function/template differs unexpectedly.
-- Only the development release pipeline may apply this migration by default.
DO $booking_participant_notice$
DECLARE
  v_schema text;
  v_source text;
  v_updated text;
  v_hits integer;
  v_admin_hits integer;
  v_member_hits integer;
  v_template_count integer;
  v_old CONSTANT text := $old$coalesce(nullif(bt.name, ''), '現場安排')$old$;
  v_new CONSTANT text := $new$coalesce(nullif(bt.name, ''), '現場安排') ||
        CASE
          WHEN nullif(btrim(bp.member_note), '') IS NOT NULL
          THEN E'\n個別備註：' ||
               regexp_replace(left(btrim(bp.member_note), 500), E'[\r\n]+', ' ', 'g')
          ELSE ''
        END$new$;
BEGIN
  -- Every tenant owns its own trigger; do not modify an unrelated root schema.
  FOR v_schema IN SELECT runtime_schema FROM platform_private.tenants
    WHERE runtime_schema ~ '^business_[0-9a-f]{32}$' ORDER BY runtime_schema
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_source
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname=v_schema AND p.proname='notice_enqueue'
       AND p.pronargs=0;
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'BOOKING_PARTICIPANT_NOTICE_FUNCTION_MISSING: %', v_schema;
    END IF;
    IF strpos(v_source, '個別備註：') = 0 THEN
      v_hits := (length(v_source)-length(replace(v_source,v_old,'')))/length(v_old);
      IF v_hits<>1 THEN
        RAISE EXCEPTION 'BOOKING_PARTICIPANT_NOTICE_FUNCTION_DRIFT: %, % matches', v_schema,v_hits;
      END IF;
      v_source := replace(v_source,v_old,v_new);
    ELSIF strpos(v_source,'bp.member_note')=0 THEN
      RAISE EXCEPTION 'BOOKING_PARTICIPANT_NOTICE_FUNCTION_UNEXPECTED: %',v_schema;
    END IF;

    -- Existing 2200-char enqueue truncation can silently drop notes from
    -- later participants. The outbox is text; bound per-person notes to 500.
    v_admin_hits := (length(v_source)-length(replace(v_source,'left(admin_message,2200)','')))/
      length('left(admin_message,2200)');
    v_member_hits := (length(v_source)-length(replace(v_source,'left(member_message,2200)','')))/
      length('left(member_message,2200)');
    IF v_admin_hits NOT IN (0,4) OR v_member_hits NOT IN (0,2) THEN
      RAISE EXCEPTION 'BOOKING_PARTICIPANT_NOTICE_LIMIT_DRIFT: %, %, %',v_schema,v_admin_hits,v_member_hits;
    END IF;
    v_updated := replace(
      replace(v_source,'left(admin_message,2200)','left(admin_message,8000)'),
      'left(member_message,2200)','left(member_message,8000)');
    EXECUTE v_updated;
  END LOOP;

  -- Future merchants inherit the exact same behavior from the template.
  SELECT count(*) INTO v_template_count
    FROM platform_private.business_templates t,
         jsonb_array_elements(t.snapshot->'functions') f(value)
   WHERE t.version='business-v1-20261019'
     AND f.value->>'name'='notice_enqueue';
  IF v_template_count<>1 THEN
    RAISE EXCEPTION 'BOOKING_PARTICIPANT_NOTICE_TEMPLATE_MISSING: %',v_template_count;
  END IF;
  SELECT f.value->>'definition' INTO v_source
    FROM platform_private.business_templates t,
         jsonb_array_elements(t.snapshot->'functions') f(value)
   WHERE t.version='business-v1-20261019'
     AND f.value->>'name'='notice_enqueue';

  IF strpos(v_source,'個別備註：')=0 THEN
    v_hits := (length(v_source)-length(replace(v_source,v_old,'')))/length(v_old);
    IF v_hits<>1 THEN
      RAISE EXCEPTION 'BOOKING_PARTICIPANT_NOTICE_TEMPLATE_DRIFT: %',v_hits;
    END IF;
    v_source:=replace(v_source,v_old,v_new);
  ELSIF strpos(v_source,'bp.member_note')=0 THEN
    RAISE EXCEPTION 'BOOKING_PARTICIPANT_NOTICE_TEMPLATE_UNEXPECTED';
  END IF;
  v_admin_hits := (length(v_source)-length(replace(v_source,'left(admin_message,2200)','')))/
      length('left(admin_message,2200)');
  v_member_hits := (length(v_source)-length(replace(v_source,'left(member_message,2200)','')))/
      length('left(member_message,2200)');
  IF v_admin_hits NOT IN (0,4) OR v_member_hits NOT IN (0,2) THEN
    RAISE EXCEPTION 'BOOKING_PARTICIPANT_NOTICE_TEMPLATE_LIMIT_DRIFT: %, %',v_admin_hits,v_member_hits;
  END IF;
  v_updated := replace(
    replace(v_source,'left(admin_message,2200)','left(admin_message,8000)'),
    'left(member_message,2200)','left(member_message,8000)');

  UPDATE platform_private.business_templates t
     SET snapshot=jsonb_set(t.snapshot,'{functions}',(
       SELECT jsonb_agg(
         CASE WHEN f.value->>'name'='notice_enqueue'
           THEN jsonb_set(f.value,'{definition}',to_jsonb(v_updated),true)
           ELSE f.value END ORDER BY f.ordinality)
         FROM jsonb_array_elements(t.snapshot->'functions')
           WITH ORDINALITY f(value,ordinality)),true)
   WHERE t.version='business-v1-20261019';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOOKING_PARTICIPANT_NOTICE_TEMPLATE_UPDATE_FAILED';
  END IF;
END
$booking_participant_notice$;
