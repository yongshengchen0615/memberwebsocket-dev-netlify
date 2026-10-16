-- Correction: "allow_duplicate_test_login" permits a replacement login, NOT concurrent sessions.
-- Legacy column / RPC arguments retained for backwards compatibility.
ALTER TABLE public.test_login_sessions
  ADD COLUMN IF NOT EXISTS revoked_reason text;
COMMENT ON COLUMN public.test_login_sessions.revoked_reason IS
  'Server-side session revocation cause; replaced_by_new_login distinguishes login takeover from admin revocation.';
COMMENT ON COLUMN public.test_mode_settings.allow_duplicate_test_login IS
  'Legacy name. True permits a new test login to replace/revoke the existing session on the same user surface. Never allows simultaneous valid sessions. False blocks an already active surface.';

-- Heal historical duplicate sessions created while the former setting enabled coexistence.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY member_id, surface ORDER BY created_at DESC, id DESC
  ) AS position
  FROM public.test_login_sessions
  WHERE revoked_at IS NULL AND expires_at > clock_timestamp()
)
UPDATE public.test_login_sessions AS session
   SET revoked_at = clock_timestamp(), revoked_reason = 'replaced_by_new_login'
  FROM ranked
 WHERE session.id = ranked.id AND ranked.position > 1;

-- Atomic test login takeover. The original security boundary and grants are preserved.
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

  END IF;

  -- A successful replacement login must never coexist with a previous session.
  -- This stays in the same transaction as the INSERT, so a failed INSERT rolls back revocation.
  UPDATE public.test_login_sessions
     SET revoked_at = v_now, revoked_reason = 'replaced_by_new_login'
   WHERE member_id = p_member_id AND surface = p_surface
     AND revoked_at IS NULL AND expires_at > v_now;

  UPDATE public.member_presence_sessions
     SET offline_at = v_now, last_seen_at = v_now,
         offline_reason = 'replaced_by_new_login', updated_at = v_now
   WHERE member_id = p_member_id AND surface = p_surface AND offline_at IS NULL;

  INSERT INTO public.test_login_sessions(token_hash,member_id,device_class,surface,expires_at)
  VALUES (p_token_hash,p_member_id,p_device_class,p_surface,p_expires_at)
  RETURNING id INTO v_id;

  -- Notify only after a committed successful takeover. Failure to publish
  -- rolls back both the new session and revocations atomically.
  INSERT INTO public.realtime_events(scope,event_type)
  VALUES ('all','test_mode.session.started');

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_test_login_session_v3(text,uuid,text,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_test_login_session_v3(text,uuid,text,text,timestamptz)
  TO service_role;
