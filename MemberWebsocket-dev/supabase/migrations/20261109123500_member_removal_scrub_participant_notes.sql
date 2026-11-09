-- AC-PNOTE-007: deleting a member must scrub the newly persisted participant notes
-- on surviving shared bookings, just as it already clears bookings.member_note.
-- Keep the bookings, participants, services, and receipts belonging to surviving users.
DO $member_removal_participant_note$
DECLARE
  v_schema text;
  v_original text;
  v_updated text;
  v_match_count integer;
  v_count integer;
  v_old constant text := $needle$ update bookings set
   member_note=$needle$;
  v_new constant text := $replacement$ update booking_participants
     set member_note=''
   where booking_id=any(bids);
 update bookings set
   member_note=$replacement$;
BEGIN
  FOR v_schema IN
    SELECT 'public'::text
    UNION ALL
    SELECT runtime_schema
      FROM platform_private.tenants
     WHERE runtime_schema ~ '^business_[0-9a-f]{32}$'
  LOOP
    SELECT pg_get_functiondef(p.oid)
      INTO v_original
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname=v_schema
       AND p.proname='finish_member_removal';
    IF v_original IS NULL THEN
      RAISE EXCEPTION 'MEMBER_REMOVAL_FUNCTION_MISSING: %',v_schema;
    END IF;
    v_match_count:=(length(v_original)-length(replace(v_original,v_old,'')))/length(v_old);
    IF v_match_count<>1 THEN
      RAISE EXCEPTION 'MEMBER_REMOVAL_CONTRACT_CHANGED: %',v_schema;
    END IF;
    v_updated:=replace(v_original,v_old,v_new);
    -- CREATE OR REPLACE preserves the existing function signature, ownership,
    -- SECURITY DEFINER setting, schema search_path and EXECUTE grants.
    EXECUTE v_updated;
  END LOOP;

  SELECT count(*)
    INTO v_match_count
    FROM platform_private.business_templates t
    CROSS JOIN LATERAL jsonb_array_elements(t.snapshot->'functions') f(value)
   WHERE t.version='business-v1-20261019'
     AND f.value->>'name'='finish_member_removal'
     AND strpos(f.value->>'definition',v_old)>0;
  IF v_match_count<>1 THEN
    RAISE EXCEPTION 'MEMBER_REMOVAL_TEMPLATE_CONTRACT_CHANGED: %',v_match_count;
  END IF;

  UPDATE platform_private.business_templates t
     SET snapshot=jsonb_set(t.snapshot,'{functions}',(
       SELECT jsonb_agg(
         CASE WHEN f.value->>'name'='finish_member_removal'
           THEN jsonb_set(f.value,'{definition}',
               to_jsonb(replace(f.value->>'definition',v_old,v_new)),true)
           ELSE f.value END ORDER BY f.ordinality
       )
       FROM jsonb_array_elements(t.snapshot->'functions')
         WITH ORDINALITY f(value,ordinality)
     ),true)
   WHERE t.version='business-v1-20261019';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN
    RAISE EXCEPTION 'MEMBER_REMOVAL_TEMPLATE_UPDATE_FAILED: %',v_count;
  END IF;
END
$member_removal_participant_note$;
