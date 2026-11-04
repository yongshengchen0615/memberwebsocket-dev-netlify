-- Track Twilio-approved telephone ownership per member, without grandfathering
-- pre-existing phone values as verified. Install in public and each merchant schema.
-- The unique index is the final concurrency authority; no check-then-insert races.
CREATE OR REPLACE FUNCTION public.invalidate_verified_phone_on_edit()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $body$
BEGIN
  IF NEW.phone IS DISTINCT FROM OLD.phone
     AND NEW.phone IS DISTINCT FROM NEW.phone_verified_e164 THEN
    NEW.phone_verified_e164 := NULL;
    NEW.phone_verified_at := NULL;
  END IF;
  RETURN NEW;
END;
$body$;

REVOKE ALL ON FUNCTION public.invalidate_verified_phone_on_edit() FROM PUBLIC, anon, authenticated;

DO $migration$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname FROM pg_namespace
    WHERE nspname = 'public' OR nspname ~ '^business_[a-f0-9]{32}$'
    ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.members', tenant_schema)) IS NULL THEN CONTINUE; END IF;

    EXECUTE format('ALTER TABLE %I.members ADD COLUMN IF NOT EXISTS phone_verified_e164 text', tenant_schema);
    EXECUTE format('ALTER TABLE %I.members ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz', tenant_schema);
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = tenant_schema AND t.relname = 'members'
        AND c.conname = 'members_phone_verification_consistent'
    ) THEN
      EXECUTE format($check$
        ALTER TABLE %I.members
        ADD CONSTRAINT members_phone_verification_consistent CHECK (
          (phone_verified_e164 IS NULL) = (phone_verified_at IS NULL)
          AND (phone_verified_e164 IS NULL OR phone_verified_e164 = phone)
        )
      $check$, tenant_schema);
    END IF;

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS members_verified_phone_unique ON %I.members (phone_verified_e164) WHERE phone_verified_e164 IS NOT NULL',
      tenant_schema
    );
    EXECUTE format('DROP TRIGGER IF EXISTS members_invalidate_verified_phone ON %I.members', tenant_schema);
    EXECUTE format(
      'CREATE TRIGGER members_invalidate_verified_phone BEFORE UPDATE OF phone ON %I.members FOR EACH ROW EXECUTE FUNCTION public.invalidate_verified_phone_on_edit()',
      tenant_schema
    );

    -- Called solely by the LINE-token-authenticated Edge Function, after Twilio
    -- returns approved. Pending enrollment and active phone change commit atomically.
    EXECUTE format($function$
      CREATE OR REPLACE FUNCTION %1$I.member_commit_verified_phone(
        p_actor text,
        p_phone text,
        p_expected_updated_at timestamptz DEFAULT NULL,
        p_join_payload jsonb DEFAULT NULL
      ) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
      AS $body$
      DECLARE
        m %1$I.members%%ROWTYPE;
        was_pending boolean;
        joined boolean;
      BEGIN
        IF p_actor IS NULL OR p_phone IS NULL
          OR p_phone !~ '^\+[1-9][0-9]{7,14}$'
          OR p_phone ~ '([0-9])\1{6,}'
        THEN RAISE EXCEPTION 'INVALID_PHONE'; END IF;

        SELECT * INTO m FROM %1$I.members
        WHERE line_user_id = p_actor FOR UPDATE;
        IF NOT FOUND OR m.status <> 'active' OR m.is_test_account IS TRUE THEN
          RAISE EXCEPTION 'MEMBERSHIP_REQUIRED';
        END IF;

        was_pending := m.membership_status <> 'active';
        IF was_pending THEN
          IF p_join_payload IS NULL OR jsonb_typeof(p_join_payload) <> 'object'
             OR p_join_payload->>'lineUserId' IS DISTINCT FROM p_actor
             OR p_join_payload->>'phone' IS DISTINCT FROM p_phone
          THEN RAISE EXCEPTION 'PHONE_JOIN_PAYLOAD_INVALID'; END IF;
          SELECT %1$I.accept_membership_terms_api(p_join_payload) INTO joined;
          IF joined IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'MEMBERSHIP_JOIN_FAILED'; END IF;
        ELSE
          IF p_join_payload IS NOT NULL THEN RAISE EXCEPTION 'PHONE_JOIN_PAYLOAD_INVALID'; END IF;
          IF m.phone = p_phone AND m.phone_verified_e164 = p_phone THEN
            RETURN to_jsonb(m);
          END IF;
          IF p_expected_updated_at IS NULL OR m.updated_at <> p_expected_updated_at THEN
            RAISE EXCEPTION 'PROFILE_CONFLICT';
          END IF;
        END IF;

        UPDATE %1$I.members
           SET phone = p_phone,
               phone_verified_e164 = p_phone,
               phone_verified_at = clock_timestamp(),
               updated_at = clock_timestamp()
         WHERE id = m.id RETURNING * INTO m;

        INSERT INTO %1$I.audit_logs (
          audit_id, actor_line_user_id, actor_role, action,
          target_type, target_id, result, detail
        ) VALUES (
          public.new_public_id('AUD'), p_actor, 'member',
          'MEMBER_PHONE_VERIFIED', 'member', m.id::text,
          'success', jsonb_build_object('initialEnrollment', was_pending)
        );
        RETURN to_jsonb(m);
      END;
      $body$;
    $function$, tenant_schema);

    EXECUTE format(
      'REVOKE ALL ON FUNCTION %I.member_commit_verified_phone(text,text,timestamptz,jsonb) FROM PUBLIC, anon, authenticated',
      tenant_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.member_commit_verified_phone(text,text,timestamptz,jsonb) TO service_role',
      tenant_schema
    );
  END LOOP;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
