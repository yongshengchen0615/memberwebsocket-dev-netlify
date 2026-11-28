-- AC-001..004: remove late-added no-show/restriction history atomically with
-- member deletion and apply the deletion barrier to its newer member FKs.
-- Public schema, existing merchants and future merchant provisioning stay aligned.
DO $member_removal_booking_risk$
DECLARE
  v_schema text;
  v_table text;
  v_original text;
  v_needle constant text := 'delete from booking_ticket_usage_requests where member_id=m.id;';
  v_marker constant text := '-- A member''s archived booking-risk records must not block deletion.';
  v_replacement constant text := $cleanup$
-- A member's archived booking-risk records must not block deletion.
-- No-show tables are tenant-only in earlier installations.
if to_regclass('booking_no_show_events') is not null then
  delete from booking_restriction_appeals
   where member_id=m.id
      or restriction_id in (
        select id from booking_restrictions
         where member_id=m.id
            or source_booking_id in (
              select booking_id from booking_no_show_events where member_id=m.id
            )
      );
  delete from booking_restrictions
   where member_id=m.id
      or source_booking_id in (
        select booking_id from booking_no_show_events where member_id=m.id
      );
  delete from booking_no_show_events where member_id=m.id;
end if;
delete from booking_ticket_usage_requests where member_id=m.id;$cleanup$;
  v_installer_anchor constant text := 'grant select,insert,update,delete on S.booking_no_show_policy,S.booking_no_show_events,S.booking_restrictions,S.booking_restriction_appeals to service_role;';
  v_installer_marker constant text := 'create trigger member_removal_write_guard before insert or update on S.booking_no_show_events';
  v_installer_guards constant text := $guards$
drop trigger if exists member_removal_write_guard on S.booking_no_show_events;
create trigger member_removal_write_guard before insert or update on S.booking_no_show_events
  for each row execute function S.member_removal_guard('member_id');
drop trigger if exists member_removal_write_guard on S.booking_restrictions;
create trigger member_removal_write_guard before insert or update on S.booking_restrictions
  for each row execute function S.member_removal_guard('member_id');
drop trigger if exists member_removal_write_guard on S.booking_restriction_appeals;
create trigger member_removal_write_guard before insert or update on S.booking_restriction_appeals
  for each row execute function S.member_removal_guard('member_id');
$guards$;
  v_matches integer;
BEGIN
  FOR v_schema IN
    SELECT nspname FROM pg_namespace
    WHERE nspname='public' OR nspname ~ '^business_[0-9a-f]{32}$'
    ORDER BY nspname
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_original
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname=v_schema AND p.proname='finish_member_removal'
       AND pg_get_function_identity_arguments(p.oid)='p_actor text, p_job_id uuid';
    IF v_original IS NULL THEN
      RAISE EXCEPTION 'MEMBER_REMOVAL_FUNCTION_MISSING: %',v_schema;
    END IF;
    IF strpos(v_original,v_marker)=0 THEN
      v_matches:=(length(v_original)-length(replace(v_original,v_needle,'')))/length(v_needle);
      IF v_matches<>1 THEN
        RAISE EXCEPTION 'MEMBER_REMOVAL_CONTRACT_CHANGED: %, %',v_schema,v_matches;
      END IF;
      -- CREATE OR REPLACE retains SECURITY DEFINER, search_path and EXECUTE grants.
      EXECUTE replace(v_original,v_needle,v_replacement);
    ELSE
      v_matches:=(length(v_original)-length(replace(v_original,v_marker,'')))/length(v_marker);
      IF v_matches<>1 THEN
        RAISE EXCEPTION 'MEMBER_REMOVAL_DUPLICATE_PATCH: %, %',v_schema,v_matches;
      END IF;
    END IF;

    -- These three FK tables appeared after the original guard installation.
    -- The trigger blocks late writers while Storage deletion is in progress.
    IF to_regclass(format('%I.booking_no_show_events',v_schema)) IS NOT NULL THEN
      FOREACH v_table IN ARRAY ARRAY[
        'booking_no_show_events','booking_restrictions','booking_restriction_appeals'
      ] LOOP
        IF to_regclass(format('%I.%I',v_schema,v_table)) IS NULL THEN
          RAISE EXCEPTION 'MEMBER_REMOVAL_RISK_TABLE_MISSING: %.%',v_schema,v_table;
        END IF;
        EXECUTE format('drop trigger if exists member_removal_write_guard on %I.%I',v_schema,v_table);
        EXECUTE format(
          'create trigger member_removal_write_guard before insert or update on %I.%I for each row execute function %I.member_removal_guard(%L)',
          v_schema,v_table,v_schema,'member_id'
        );
      END LOOP;
    END IF;
  END LOOP;

  -- New merchants are created from this versioned template, not public alone.
  SELECT count(*) INTO v_matches
    FROM platform_private.business_templates t
    CROSS JOIN LATERAL jsonb_array_elements(t.snapshot->'functions') f(value)
   WHERE t.version='business-v1-20261019'
     AND f.value->>'name'='finish_member_removal'
     AND (strpos(f.value->>'definition',v_needle)>0 OR strpos(f.value->>'definition',v_marker)>0);
  IF v_matches<>1 THEN
    RAISE EXCEPTION 'MEMBER_REMOVAL_TEMPLATE_CONTRACT_CHANGED: %',v_matches;
  END IF;
  UPDATE platform_private.business_templates t
     SET snapshot=jsonb_set(t.snapshot,'{functions}',(
       SELECT jsonb_agg(
         CASE WHEN f.value->>'name'='finish_member_removal'
                AND strpos(f.value->>'definition',v_marker)=0
           THEN jsonb_set(f.value,'{definition}',to_jsonb(replace(f.value->>'definition',v_needle,v_replacement)),true)
           ELSE f.value END ORDER BY f.ordinality
       )
       FROM jsonb_array_elements(t.snapshot->'functions') WITH ORDINALITY f(value,ordinality)
     ),true)
   WHERE t.version='business-v1-20261019';

  -- The separately installed booking risk feature must attach guards on
  -- future merchant schemas too, even when installed after provisioning.
  IF to_regprocedure('platform_private.install_booking_risk(text)') IS NOT NULL THEN
    SELECT pg_get_functiondef('platform_private.install_booking_risk(text)'::regprocedure)
      INTO v_original;
    IF strpos(v_original,v_installer_marker)=0 THEN
      v_matches:=(length(v_original)-length(replace(v_original,v_installer_anchor,'')))/length(v_installer_anchor);
      IF v_matches<>1 THEN
        RAISE EXCEPTION 'BOOKING_RISK_INSTALLER_CONTRACT_CHANGED: %',v_matches;
      END IF;
      EXECUTE replace(v_original,v_installer_anchor,v_installer_anchor||E'\n'||v_installer_guards);
    END IF;
  END IF;
END
$member_removal_booking_risk$;
