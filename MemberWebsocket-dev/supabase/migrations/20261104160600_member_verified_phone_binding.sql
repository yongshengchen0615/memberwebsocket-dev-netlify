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
          %1$I.new_public_id('AUD'), p_actor, 'member',
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


-- Merchant provisioning uses an immutable JSON snapshot rather than cloning
-- the live public schema. Extend the snapshot so future merchants get exactly
-- the same verified-phone invariants; a live-schema-only migration is unsafe.
DO $template$
DECLARE
  tpl jsonb;
  t jsonb;
  updated_tables jsonb;
  definition text;
BEGIN
  SELECT snapshot INTO tpl
  FROM platform_private.business_templates
  WHERE version = 'business-v1-20261019' FOR UPDATE;

  IF tpl IS NULL THEN RAISE EXCEPTION 'PHONE_TEMPLATE_NOT_FOUND'; END IF;

  SELECT jsonb_agg(
    CASE WHEN item.value->>'name' = 'members' THEN
      jsonb_set(item.value, '{columns}', item.value->'columns' ||
        (CASE WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(item.value->'columns') col
          WHERE col->>'name' = 'phone_verified_e164'
        ) THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object(
          'name', 'phone_verified_e164', 'type', 'text', 'default', null,
          'notNull', false, 'identity', '', 'generated', ''
        )) END) ||
        (CASE WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(item.value->'columns') col
          WHERE col->>'name' = 'phone_verified_at'
        ) THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object(
          'name', 'phone_verified_at', 'type', 'timestamp with time zone',
          'default', null, 'notNull', false, 'identity', '', 'generated', ''
        )) END))
    ELSE item.value END
    ORDER BY item.ordinality
  ) INTO updated_tables
  FROM jsonb_array_elements(tpl->'tables') WITH ORDINALITY AS item(value,ordinality);
  tpl := jsonb_set(tpl, '{tables}', updated_tables);

  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(tpl->'constraints') c
     WHERE c->>'table' = 'members' AND c->>'name' = 'members_phone_verification_consistent') THEN
    SELECT pg_get_constraintdef(c.oid) INTO definition
    FROM pg_constraint c WHERE c.conrelid='public.members'::regclass
      AND c.conname='members_phone_verification_consistent';
    tpl := jsonb_set(tpl, '{constraints}', tpl->'constraints' || jsonb_build_array(
      jsonb_build_object('table','members','name','members_phone_verification_consistent',
                         'type','c','definition',definition)));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(tpl->'indexes') idx
      WHERE idx->>'name'='members_verified_phone_unique'
         OR idx->>'definition' LIKE 'CREATE UNIQUE INDEX members_verified_phone_unique %') THEN
    tpl := jsonb_set(tpl, '{indexes}', tpl->'indexes' || jsonb_build_array(
      jsonb_build_object('name','members_verified_phone_unique','definition',
        pg_get_indexdef('public.members_verified_phone_unique'::regclass))));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(tpl->'functions') fn
     WHERE fn->>'name'='invalidate_verified_phone_on_edit') THEN
    tpl := jsonb_set(tpl, '{functions}', tpl->'functions' || jsonb_build_array(
      jsonb_build_object('name','invalidate_verified_phone_on_edit','definition',
      pg_get_functiondef('public.invalidate_verified_phone_on_edit()'::regprocedure))));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(tpl->'functions') fn
     WHERE fn->>'name'='member_commit_verified_phone') THEN
    tpl := jsonb_set(tpl, '{functions}', tpl->'functions' || jsonb_build_array(
      jsonb_build_object('name','member_commit_verified_phone','definition',
      pg_get_functiondef('public.member_commit_verified_phone(text,text,timestamptz,jsonb)'::regprocedure))));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(tpl->'triggers') trg
      WHERE trg->>'name'='members_invalidate_verified_phone') THEN
    SELECT pg_get_triggerdef(t.oid) INTO definition
    FROM pg_trigger t WHERE t.tgrelid='public.members'::regclass
      AND t.tgname='members_invalidate_verified_phone';
    tpl := jsonb_set(tpl, '{triggers}', tpl->'triggers' || jsonb_build_array(
      jsonb_build_object('name','members_invalidate_verified_phone','definition',definition)));
  END IF;

  UPDATE platform_private.business_templates
     SET snapshot = tpl
   WHERE version='business-v1-20261019';
END;
$template$;

NOTIFY pgrst, 'reload schema';
