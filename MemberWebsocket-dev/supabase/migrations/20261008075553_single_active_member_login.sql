-- One active browser per LINE identity.  A claim accepts only a LINE ID token
-- verified by the Edge Function; hashes are never exposed to browser clients.
CREATE TABLE IF NOT EXISTS public.member_login_sessions (
  line_user_id text PRIMARY KEY,
  browser_hash text,
  latest_token_iat_ms bigint NOT NULL DEFAULT 0,
  generation bigint NOT NULL DEFAULT 1,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_login_browser_hash_format CHECK (browser_hash IS NULL OR browser_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE IF NOT EXISTS public.member_login_token_grants (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  line_user_id text NOT NULL REFERENCES public.member_login_sessions(line_user_id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS member_login_grants_identity_idx ON public.member_login_token_grants(line_user_id);
ALTER TABLE public.member_login_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_login_token_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_login_sessions, public.member_login_token_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_login_sessions, public.member_login_token_grants TO service_role;

-- Serializes competing logins for the same LINE identity.  A replaced browser
-- cannot use an older, still-valid LINE ID token to reclaim the connection.
CREATE OR REPLACE FUNCTION public.member_login_claim(
  p_line_user_id text,
  p_browser_hash text,
  p_token_hash text,
  p_issued_at_ms bigint,
  p_mode text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE current_session public.member_login_sessions%ROWTYPE;
DECLARE outcome text := 'resumed';
BEGIN
  IF length(p_line_user_id) < 2 OR length(p_line_user_id) > 120
    OR p_browser_hash !~ '^[a-f0-9]{64}$'
    OR p_token_hash !~ '^[a-f0-9]{64}$'
    OR p_issued_at_ms IS NULL OR p_issued_at_ms <= 0
    OR p_mode NOT IN ('login', 'resume') THEN
    RAISE EXCEPTION 'invalid login claim';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_line_user_id, 161083));
  SELECT * INTO current_session FROM public.member_login_sessions
    WHERE line_user_id = p_line_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.member_login_sessions (line_user_id,browser_hash,latest_token_iat_ms)
    VALUES (p_line_user_id,p_browser_hash,p_issued_at_ms);
    outcome := 'claimed';
  ELSIF current_session.browser_hash IS DISTINCT FROM p_browser_hash THEN
    IF p_mode <> 'login' OR p_issued_at_ms <= current_session.latest_token_iat_ms THEN
      RETURN 'session_replaced';
    END IF;
    DELETE FROM public.member_login_token_grants WHERE line_user_id = p_line_user_id;
    UPDATE public.member_login_sessions
    SET browser_hash = p_browser_hash, latest_token_iat_ms = p_issued_at_ms,
        generation = generation + 1, claimed_at = now(), updated_at = now()
    WHERE line_user_id = p_line_user_id;
    outcome := 'replaced';
  ELSE
    UPDATE public.member_login_sessions
      SET latest_token_iat_ms = greatest(latest_token_iat_ms,p_issued_at_ms),updated_at=now()
      WHERE line_user_id = p_line_user_id;
  END IF;
  INSERT INTO public.member_login_token_grants(token_hash,line_user_id)
  VALUES (p_token_hash,p_line_user_id)
  ON CONFLICT (token_hash) DO NOTHING;
  RETURN outcome;
END;
$$;
REVOKE ALL ON FUNCTION public.member_login_claim(text,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.member_login_claim(text,text,text,bigint,text) TO service_role;

-- Only the CURRENT registered token may log out that connection. In particular,
-- an old device's delayed logout never invalidates a newer device.
CREATE OR REPLACE FUNCTION public.member_login_logout(p_line_user_id text,p_token_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_line_user_id,161083));
  IF NOT EXISTS (
    SELECT 1 FROM public.member_login_token_grants
    WHERE line_user_id=p_line_user_id AND token_hash=p_token_hash
  ) THEN RETURN false; END IF;
  DELETE FROM public.member_login_token_grants WHERE line_user_id=p_line_user_id;
  UPDATE public.member_login_sessions
    SET browser_hash=NULL,updated_at=now()
    WHERE line_user_id=p_line_user_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.member_login_logout(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.member_login_logout(text,text) TO service_role;
