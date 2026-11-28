-- AC-001..004: a LINE identity can simultaneously own an admin role and a
-- member card. Erasing the card must remove its MEMBER-role history without
-- destroying independent admin security and merchant operations.
-- Existing completed removals are scrubbed by one-way identity_hash; new
-- re-enrolments keep only their new post-removal activity.
DO $member_role_history_reset$
DECLARE
  v_schema text;
  v_original text;
  v_anchor constant text := 'delete from audit_logs where ((not exists(select 1 from admins where line_user_id=m.line_user_id))';
  v_marker constant text := '-- Member-only activity is erased even for an admin LINE identity.';
  v_injection constant text := $member_only_cleanup$
-- Member-only activity is erased even for an admin LINE identity.
-- The administrator's separate audit trail must remain intact.
delete from audit_logs
 where actor_role='member'
   and (actor_line_user_id=m.line_user_id or (target_type='member' and target_id=m.line_user_id));
delete from audit_logs
 where actor_role='system' and target_type='member' and target_id=m.line_user_id;
delete from booking_audit_events
 where actor_role='member' and actor_line_user_id=m.line_user_id;
delete from idempotency_results
 where actor_line_user_id=m.line_user_id and left(action,5)='user.';
$member_only_cleanup$;
  v_count integer;
BEGIN
  FOR v_schema IN
    SELECT nspname FROM pg_namespace
     WHERE nspname='public' OR nspname ~ '^business_[0-9a-f]{32}$'
     ORDER BY nspname
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_original
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname=v_schema
       AND p.proname='finish_member_removal'
       AND pg_get_function_identity_arguments(p.oid)='p_actor text, p_job_id uuid';
    IF v_original IS NULL THEN
      RAISE EXCEPTION 'MEMBER_REMOVAL_FUNCTION_MISSING: %',v_schema;
    END IF;
    IF strpos(v_original,v_marker)=0 THEN
      v_count:=(length(v_original)-length(replace(v_original,v_anchor,'')))/length(v_anchor);
      IF v_count<>1 THEN
        RAISE EXCEPTION 'MEMBER_REMOVAL_ADMIN_ACTIVITY_CONTRACT_CHANGED: %, %',v_schema,v_count;
      END IF;
      -- CREATE OR REPLACE preserves SECURITY DEFINER and service-role-only ACL.
      EXECUTE replace(v_original,v_anchor,v_injection||v_anchor);
    ELSE
      v_count:=(length(v_original)-length(replace(v_original,v_marker,'')))/length(v_marker);
      IF v_count<>1 THEN
        RAISE EXCEPTION 'MEMBER_REMOVAL_ADMIN_ACTIVITY_PATCH_DUPLICATED: %, %',v_schema,v_count;
      END IF;
    END IF;

    -- Earlier admin self-removals already completed but kept MEMBER-role audit
    -- rows. Match the non-reversible tombstone hash, never retain old PII.
    -- Records after the removal completion timestamp belong to a new account.
    EXECUTE format($retroactive$
      DELETE FROM %1$I.audit_logs a
       WHERE a.actor_role IN ('member','system')
         AND EXISTS (
           SELECT 1 FROM %1$I.member_removal_jobs j
            WHERE j.state='complete' AND j.completed_at IS NOT NULL
              AND a.created_at <= j.completed_at
              AND (
                (a.actor_role='member' AND a.actor_line_user_id IS NOT NULL
                 AND j.identity_hash=encode(extensions.digest(a.actor_line_user_id,'sha256'),'hex'))
                OR (a.target_type='member' AND a.target_id IS NOT NULL
                 AND j.identity_hash=encode(extensions.digest(a.target_id,'sha256'),'hex'))
              )
         );
      DELETE FROM %1$I.booking_audit_events b
       WHERE b.actor_role='member' AND b.actor_line_user_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM %1$I.member_removal_jobs j
            WHERE j.state='complete' AND j.completed_at IS NOT NULL
              AND b.created_at <= j.completed_at
              AND j.identity_hash=encode(extensions.digest(b.actor_line_user_id,'sha256'),'hex')
         );
      DELETE FROM %1$I.idempotency_results i
       WHERE left(i.action,5)='user.' AND i.actor_line_user_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM %1$I.member_removal_jobs j
            WHERE j.state='complete' AND j.completed_at IS NOT NULL
              AND i.created_at <= j.completed_at
              AND j.identity_hash=encode(extensions.digest(i.actor_line_user_id,'sha256'),'hex')
         );
    $retroactive$,v_schema);
  END LOOP;

  -- New merchant schemas inherit the fixed removal function from the template.
  SELECT count(*) INTO v_count
    FROM platform_private.business_templates t
    CROSS JOIN LATERAL jsonb_array_elements(t.snapshot->'functions') f(value)
   WHERE t.version='business-v1-20261019'
     AND f.value->>'name'='finish_member_removal'
     AND (strpos(f.value->>'definition',v_anchor)>0
       OR strpos(f.value->>'definition',v_marker)>0);
  IF v_count<>1 THEN
    RAISE EXCEPTION 'MEMBER_REMOVAL_ADMIN_ACTIVITY_TEMPLATE_CONTRACT_CHANGED: %',v_count;
  END IF;
  UPDATE platform_private.business_templates t
     SET snapshot=jsonb_set(t.snapshot,'{functions}',(
       SELECT jsonb_agg(
         CASE WHEN f.value->>'name'='finish_member_removal'
                   AND strpos(f.value->>'definition',v_marker)=0
              THEN jsonb_set(f.value,'{definition}',
                             to_jsonb(replace(f.value->>'definition',v_anchor,v_injection||v_anchor)),true)
              ELSE f.value END
         ORDER BY f.ordinality
       )
       FROM jsonb_array_elements(t.snapshot->'functions') WITH ORDINALITY f(value,ordinality)
     ),true)
   WHERE t.version='business-v1-20261019';
END
$member_role_history_reset$;
