-- Allow parallel sessions ONLY for virtual test members, controlled by an admin setting.
-- Default OFF; formal LINE members continue to use their independent single-login contract.
ALTER TABLE public.test_mode_settings
  ADD COLUMN IF NOT EXISTS allow_duplicate_test_login boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.test_mode_settings.allow_duplicate_test_login IS
  'When true, multiple direct test-login sessions may coexist for one virtual member and user surface; never applies to real LINE members.';

-- Wrapper keeps the mature account-creation/maintenance RPC intact and ensures
-- this flag and the other settings save in the SAME database transaction.
CREATE OR REPLACE FUNCTION public.admin_save_maintenance_test_access_v2(
  p_maintenance_enabled boolean,
  p_allow_pc_test_login boolean,
  p_allow_mobile_test_login boolean,
  p_maintenance_message text,
  p_updated_by text,
  p_add_account_count integer DEFAULT 0,
  p_allow_duplicate_test_login boolean DEFAULT false
)
RETURNS TABLE(created_account_count integer, total_test_accounts integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
    SELECT old.created_account_count, old.total_test_accounts
    FROM public.admin_save_maintenance_test_access(
      p_maintenance_enabled,
      p_allow_pc_test_login,
      p_allow_mobile_test_login,
      p_maintenance_message,
      p_updated_by,
      p_add_account_count
    ) AS old;

  UPDATE public.test_mode_settings
     SET allow_duplicate_test_login = COALESCE(p_allow_duplicate_test_login, false)
   WHERE id = true;

  IF NOT COALESCE(p_allow_duplicate_test_login, false) THEN
    -- Turning off coexistence immediately invalidates every older duplicate
    -- while leaving the newest unexpired session in each member/surface intact.
    WITH active_sessions AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY member_id, surface ORDER BY created_at DESC, id DESC
      ) AS position
      FROM public.test_login_sessions
      WHERE revoked_at IS NULL AND expires_at > clock_timestamp()
    )
    UPDATE public.test_login_sessions AS session
       SET revoked_at = clock_timestamp()
      FROM active_sessions AS ranked
     WHERE session.id = ranked.id AND ranked.position > 1;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_save_maintenance_test_access_v2(boolean,boolean,boolean,text,text,integer,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_maintenance_test_access_v2(boolean,boolean,boolean,text,text,integer,boolean)
  TO service_role;

-- The test-login RPC makes the decision with trusted DB settings, never from
-- a client-controlled boolean. Keep the legacy v2 RPC for rollback.
CREATE OR REPLACE FUNCTION public.create_test_login_session_v3(
  p_token_hash text,
  p_member_id uuid,
  p_surface text,
  p_device_class text,
  p_expires_at timestamptz
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_now timestamptz := clock_timestamp();
  v_maintenance boolean;
  v_device_allowed boolean;
  v_allow_duplicate boolean;
BEGIN
  IF p_surface IS NULL OR p_surface <> ALL(ARRAY['member','points','event','calendar','booking']) THEN
    RAISE EXCEPTION 'INVALID_TEST_SURFACE';
  END IF;
  IF p_device_class IS NULL OR p_device_class <> ALL(ARRAY['pc','mobile']) THEN
    RAISE EXCEPTION 'INVALID_TEST_DEVICE_CLASS';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= v_now OR p_expires_at > v_now + interval '2 hours 1 minute' THEN
    RAISE EXCEPTION 'INVALID_TEST_SESSION_EXPIRY';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.members
     WHERE id = p_member_id AND is_test_account IS TRUE
       AND status = 'active' AND membership_status = 'active'
  ) THEN
    RAISE EXCEPTION 'TEST_ACCOUNT_UNAVAILABLE';
  END IF;

  -- Locks settings against a concurrent admin toggle until the claim commits.
  SELECT maintenance_enabled,
         CASE WHEN p_device_class = 'mobile' THEN allow_mobile_test_login ELSE allow_pc_test_login END,
         allow_duplicate_test_login
    INTO v_maintenance, v_device_allowed, v_allow_duplicate
    FROM public.test_mode_settings WHERE id = true FOR SHARE;
  IF NOT FOUND OR NOT COALESCE(v_maintenance,false) OR NOT COALESCE(v_device_allowed,false) THEN
    RAISE EXCEPTION 'TEST_LOGIN_DISABLED';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_member_id::text || ':' || p_surface, 0)
  );
  UPDATE public.test_login_sessions
     SET revoked_at = v_now
   WHERE member_id = p_member_id AND surface = p_surface
     AND revoked_at IS NULL AND expires_at <= v_now;

  IF NOT COALESCE(v_allow_duplicate, false) THEN
    IF EXISTS (
      SELECT 1 FROM public.member_presence_sessions AS presence
       WHERE presence.member_id = p_member_id AND presence.surface = p_surface
         AND presence.offline_at IS NULL
         AND presence.last_seen_at >= v_now - interval '90 seconds'
    ) OR EXISTS (
      SELECT 1 FROM public.test_login_sessions AS prior
       WHERE prior.member_id = p_member_id AND prior.surface = p_surface
         AND prior.revoked_at IS NULL AND prior.expires_at > v_now
         AND prior.created_at >= v_now - interval '15 seconds'
    ) THEN
      RAISE EXCEPTION 'TEST_SURFACE_ALREADY_ACTIVE';
    END IF;

    UPDATE public.test_login_sessions
       SET revoked_at = v_now
     WHERE member_id = p_member_id AND surface = p_surface
       AND revoked_at IS NULL AND expires_at > v_now;
  END IF;

  INSERT INTO public.test_login_sessions(token_hash,member_id,device_class,surface,expires_at)
  VALUES (p_token_hash,p_member_id,p_device_class,p_surface,p_expires_at)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_test_login_session_v3(text,uuid,text,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_test_login_session_v3(text,uuid,text,text,timestamptz)
  TO service_role;
