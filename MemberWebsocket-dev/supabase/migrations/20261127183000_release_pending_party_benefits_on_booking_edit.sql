-- AC-007: changing party size may release incompatible PENDING benefits atomically,
-- but MUST reject edits that invalidate REDEEMED benefits.
-- Additive migration: never rewrite the installed 20261127180000 / 181500 SQL.
DO $party_edit$
DECLARE
  v_schema text;
  v_guard text;
  v_template jsonb;
  v_new_functions jsonb;
  v_new_trigger jsonb;
  v_guard_trigger jsonb;
BEGIN
  FOR v_schema IN
    SELECT n.nspname FROM pg_namespace n
    WHERE n.nspname='public'
      OR n.nspname IN (SELECT runtime_schema FROM platform_private.tenants
                       WHERE runtime_schema ~ '^business_[0-9a-f]{32}$')
    ORDER BY n.nspname
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO STRICT v_guard
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=v_schema AND p.proname='guard_booking_party_size_benefits' AND p.prokind='f';
    IF strpos(v_guard, 's.status IN (''pending'',''redeemed'')')=0 THEN
      RAISE EXCEPTION 'BOOKING_PARTY_GUARD_SOURCE_CHANGED: %',v_schema;
    END IF;
    v_guard:=replace(v_guard, 's.status IN (''pending'',''redeemed'')', 's.status = ''redeemed''');
    EXECUTE v_guard;

    -- The previous tenant trigger was generated with an unqualified function
    -- name, which can bind merchant bookings to the PUBLIC guard. Rebind the
    -- trigger atomically to this schema's own guard function.
    EXECUTE format('DROP TRIGGER booking_party_size_benefits_guard ON %I.bookings',v_schema);
    EXECUTE format('CREATE TRIGGER booking_party_size_benefits_guard BEFORE UPDATE OF party_size ON %1$I.bookings FOR EACH ROW WHEN (OLD.party_size IS DISTINCT FROM NEW.party_size) EXECUTE FUNCTION %1$I.guard_booking_party_size_benefits()',v_schema);

    EXECUTE format($function$
      CREATE OR REPLACE FUNCTION %1$I.release_pending_booking_party_benefits()
      RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $body$
      BEGIN
        -- The BEFORE guard has already protected redeemed benefits.
        -- Pending selections must be removable during the same edit even when
        -- the group-booking API changes party_size before replacing benefits.
        UPDATE %1$I.booking_benefit_selections s
        SET status='cancelled', result=jsonb_build_object('cancellationReason','booking_party_size_changed')
        WHERE s.booking_id=NEW.id AND s.status='pending' AND (
          (s.benefit_kind='event' AND NOT EXISTS (
            SELECT 1 FROM %1$I.event_ticket_claims c JOIN %1$I.event_tickets et ON et.id=c.event_ticket_id
            WHERE c.claim_id=s.benefit_ref AND c.member_id=s.member_id
              AND (et.min_booking_party_size=0 OR NEW.party_size>=et.min_booking_party_size)
              AND (et.max_booking_party_size=0 OR NEW.party_size<=et.max_booking_party_size)
          ))
          OR
          (s.benefit_kind='calendar' AND NOT EXISTS (
            SELECT 1 FROM %1$I.calendar_items ci
            WHERE ci.calendar_item_id=s.benefit_ref
              AND (ci.min_booking_party_size=0 OR NEW.party_size>=ci.min_booking_party_size)
              AND (ci.max_booking_party_size=0 OR NEW.party_size<=ci.max_booking_party_size)
          ))
        );
        RETURN NEW;
      END $body$;
    $function$,v_schema);
    EXECUTE format('CREATE TRIGGER booking_party_pending_benefits_release AFTER UPDATE OF party_size ON %I.bookings FOR EACH ROW WHEN (OLD.party_size IS DISTINCT FROM NEW.party_size) EXECUTE FUNCTION %I.release_pending_booking_party_benefits()',v_schema,v_schema);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %I.release_pending_booking_party_benefits() FROM PUBLIC,anon,authenticated',v_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.release_pending_booking_party_benefits() TO service_role',v_schema);
  END LOOP;

  SELECT snapshot INTO STRICT v_template
    FROM platform_private.business_templates WHERE version='business-v1-20261019' FOR UPDATE;

  SELECT jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid)) ORDER BY p.proname)
    INTO STRICT v_new_functions FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('guard_booking_party_size_benefits','release_pending_booking_party_benefits') AND p.prokind='f';
  IF jsonb_array_length(v_new_functions)<>2 THEN RAISE EXCEPTION 'BOOKING_PARTY_TEMPLATE_FUNCTION_MISSING'; END IF;
  v_template:=jsonb_set(v_template,'{functions}',
    COALESCE((SELECT jsonb_agg(f ORDER BY ordinal)
      FROM jsonb_array_elements(v_template->'functions') WITH ORDINALITY a(f,ordinal)
      WHERE f->>'name' NOT IN ('guard_booking_party_size_benefits','release_pending_booking_party_benefits')),'[]'::jsonb)
    || v_new_functions);
  SELECT jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid))
    INTO STRICT v_new_trigger FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='bookings' AND t.tgname='booking_party_pending_benefits_release';
  -- pg_get_triggerdef omits the function's public prefix when public is on
  -- search_path. Keep that prefix in the template so new-tenant provisioning
  -- replaces it with the tenant schema instead of binding back to public.
  SELECT jsonb_build_object('name',t.tgname,'definition',
      replace(pg_get_triggerdef(t.oid),
        'EXECUTE FUNCTION guard_booking_party_size_benefits()',
        'EXECUTE FUNCTION public.guard_booking_party_size_benefits()'))
    INTO STRICT v_guard_trigger
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='bookings'
      AND t.tgname='booking_party_size_benefits_guard';
  IF strpos(v_guard_trigger->>'definition',
    'EXECUTE FUNCTION public.guard_booking_party_size_benefits()')=0 THEN
    RAISE EXCEPTION 'BOOKING_PARTY_TEMPLATE_GUARD_BINDING_INVALID';
  END IF;
  v_template:=jsonb_set(v_template,'{triggers}',
    COALESCE((SELECT jsonb_agg(t ORDER BY ordinal)
      FROM jsonb_array_elements(v_template->'triggers') WITH ORDINALITY a(t,ordinal)
      WHERE t->>'name' NOT IN ('booking_party_pending_benefits_release','booking_party_size_benefits_guard')),'[]'::jsonb)
    || jsonb_build_array(v_guard_trigger,v_new_trigger));
  UPDATE platform_private.business_templates SET snapshot=v_template WHERE version='business-v1-20261019';
END;
$party_edit$;
NOTIFY pgrst,'reload schema';
