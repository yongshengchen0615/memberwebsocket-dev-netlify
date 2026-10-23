-- Platform LINE verified visits are visible in the Supabase Table Editor
-- and ONLY the Supabase DBA approves by editing super_admins.enabled.
-- Keep the legacy singleton=true root reservation for reset compatibility.
-- Rows with singleton=NULL are pending/approved Platform operators.
BEGIN;

ALTER TABLE platform_private.super_admins
  DROP CONSTRAINT super_admins_pkey;
ALTER TABLE platform_private.super_admins
  ALTER COLUMN singleton DROP NOT NULL,
  ALTER COLUMN admin_id DROP NOT NULL;
ALTER TABLE platform_private.super_admins
  ADD CONSTRAINT super_admins_pkey PRIMARY KEY (line_user_id);
CREATE UNIQUE INDEX super_admins_single_root_idx
  ON platform_private.super_admins(singleton) WHERE singleton IS TRUE;
ALTER TABLE platform_private.super_admins
  ADD CONSTRAINT super_admins_root_shape CHECK (
    (singleton IS TRUE AND admin_id IS NOT NULL)
    OR (singleton IS NULL AND admin_id IS NULL)
  );
ALTER TABLE platform_private.super_admins
  ADD COLUMN display_name text NOT NULL DEFAULT 'LINE 使用者'
    CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  ADD COLUMN first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE platform_private.super_admins
  ALTER COLUMN singleton DROP DEFAULT;
UPDATE platform_private.super_admins s SET display_name =
  coalesce(nullif(btrim(a.display_name),''),'LINE 使用者')
  FROM public.admins a WHERE s.admin_id=a.id AND s.singleton IS TRUE;

-- An existing, previously approved Platform applicant becomes PENDING under
-- the new Supabase-only policy; never silently copy its old approved flag.
INSERT INTO platform_private.super_admins
  (singleton,admin_id,line_user_id,display_name,enabled,first_seen_at,last_seen_at)
SELECT NULL,NULL,r.line_user_id,r.display_name,FALSE,r.first_seen_at,r.last_seen_at
FROM platform_private.platform_access_requests r
WHERE NOT EXISTS(SELECT 1 FROM platform_private.super_admins s WHERE s.line_user_id=r.line_user_id)
ON CONFLICT (line_user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.platform_record_access_request(
  p_actor text,p_display_name text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $body$
DECLARE v_row platform_private.super_admins%rowtype;
BEGIN
 IF p_actor IS NULL OR p_actor !~ '^U[0-9a-f]{32}$'
   OR p_display_name IS NULL
   OR char_length(btrim(p_display_name)) NOT BETWEEN 1 AND 120
 THEN RAISE EXCEPTION 'PLATFORM_INVALID_ACCESS_IDENTITY'; END IF;
 INSERT INTO platform_private.super_admins
   (singleton,admin_id,line_user_id,display_name,enabled)
 VALUES (NULL,NULL,p_actor,btrim(p_display_name),FALSE)
 ON CONFLICT (line_user_id) DO UPDATE
   SET display_name=EXCLUDED.display_name,
       last_seen_at=clock_timestamp()
 RETURNING * INTO v_row;
 -- Never update enabled, admin_id or singleton in this login write path.
 RETURN jsonb_build_object('registered',true,'enabled',v_row.enabled);
END
$body$;

CREATE OR REPLACE FUNCTION public.platform_is_root_super_admin(p_actor text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $body$
 SELECT EXISTS(
  SELECT 1 FROM platform_private.super_admins s
  JOIN public.admins a ON a.id=s.admin_id
  WHERE s.singleton IS TRUE AND s.enabled IS TRUE AND s.line_user_id=p_actor
    AND a.role='admin' AND a.status='active'
 )
$body$;

CREATE OR REPLACE FUNCTION public.platform_is_super_admin(p_actor text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $body$
 SELECT public.platform_is_root_super_admin(p_actor)
   OR EXISTS(
    SELECT 1 FROM platform_private.super_admins s
    WHERE s.singleton IS NULL AND s.line_user_id=p_actor AND s.enabled IS TRUE
   )
$body$;

-- Remove the old in-Platform approval privilege, even from a cached UI.
-- Database administrators can still edit enabled directly in Supabase.
CREATE OR REPLACE FUNCTION public.platform_review_access_request(
  p_actor text,p_target text,p_allow boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $body$
BEGIN
 RAISE EXCEPTION 'PLATFORM_SUPABASE_ONLY_APPROVAL' USING ERRCODE='42501';
END
$body$;

-- Root recovery must not be blocked by pending rows created by LINE visits.
CREATE OR REPLACE FUNCTION maintenance.bootstrap_sandbox_root(
 p_line_user_id text,p_confirmation text
) RETURNS jsonb LANGUAGE plpgsql SET search_path=''
AS $body$
DECLARE v_admin_id uuid;
BEGIN
 IF current_user IS DISTINCT FROM 'postgres'
 THEN RAISE EXCEPTION 'DBA_ONLY_ROOT_BOOTSTRAP' USING ERRCODE='42501'; END IF;
 IF p_confirmation IS DISTINCT FROM 'RESTORE ROOT AFTER VERIFIED SANDBOX RESET'
 THEN RAISE EXCEPTION 'ROOT_BOOTSTRAP_CONFIRMATION_REQUIRED'; END IF;
 IF p_line_user_id IS NULL OR p_line_user_id !~ '^U[0-9a-fA-F]{32}$'
 THEN RAISE EXCEPTION 'INVALID_LINE_ID'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('maintenance:sandbox-reset-epoch',0));
 IF NOT EXISTS (
  SELECT 1 FROM maintenance.sandbox_reset_target
  WHERE singleton=true AND project_ref='dbuquirnaskrwcamdxki' AND sandbox_approved=true
 ) THEN RAISE EXCEPTION 'SANDBOX_PROJECT_NOT_APPROVED'; END IF;
 IF NOT EXISTS(
  SELECT 1 FROM maintenance.sandbox_reset_epoch
  WHERE singleton=true AND last_completed_request IS NOT NULL
    AND last_completed_at IS NOT NULL AND root_bootstrap_required=true AND bootstrapped_at IS NULL
 ) THEN RAISE EXCEPTION 'VERIFIED_RESET_REQUIRED_BEFORE_ROOT_BOOTSTRAP'; END IF;
 IF EXISTS(SELECT 1 FROM public.admins)
  OR EXISTS(SELECT 1 FROM platform_private.super_admins WHERE singleton IS TRUE)
  OR EXISTS(SELECT 1 FROM platform_private.tenants)
  OR EXISTS(SELECT 1 FROM public.members)
  OR EXISTS(SELECT 1 FROM auth.users)
  OR EXISTS(SELECT 1 FROM storage.objects)
 THEN RAISE EXCEPTION 'SANDBOX_NOT_EMPTY_FOR_ROOT_BOOTSTRAP'; END IF;
 INSERT INTO public.admins(line_user_id,display_name,role,status)
 VALUES(p_line_user_id,'初始化總管理員','admin','active') RETURNING id INTO v_admin_id;
 INSERT INTO platform_private.super_admins
  (singleton,admin_id,enabled,line_user_id,display_name)
 VALUES(TRUE,v_admin_id,TRUE,p_line_user_id,'初始化總管理員')
 ON CONFLICT(line_user_id) DO UPDATE
 SET singleton=TRUE,admin_id=EXCLUDED.admin_id,enabled=TRUE,
     display_name=EXCLUDED.display_name,last_seen_at=clock_timestamp();
 UPDATE maintenance.sandbox_reset_epoch
 SET root_bootstrap_required=false,bootstrapped_at=clock_timestamp()
 WHERE singleton=true;
 RETURN pg_catalog.jsonb_build_object('bootstrapped',true,'bootstrapSingleUse',true);
END
$body$;

REVOKE ALL ON FUNCTION public.platform_record_access_request(text,text),
 public.platform_is_root_super_admin(text),public.platform_is_super_admin(text),
 public.platform_review_access_request(text,text,boolean)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.platform_record_access_request(text,text),
 public.platform_is_root_super_admin(text),public.platform_is_super_admin(text)
 TO service_role;
REVOKE EXECUTE ON FUNCTION public.platform_review_access_request(text,text,boolean)
 FROM service_role;
COMMIT;
