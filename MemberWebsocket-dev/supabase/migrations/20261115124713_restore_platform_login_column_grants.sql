-- Restore the existing Supabase-managed Platform login contract after ACL drift.
-- LINE-verified visits may record identity/display metadata only. Access grants
-- (enabled/admin_id/singleton) remain unavailable to service_role.
BEGIN;
GRANT INSERT(line_user_id,display_name)
  ON platform_private.super_admins TO service_role;
GRANT UPDATE(display_name,last_seen_at)
  ON platform_private.super_admins TO service_role;
COMMIT;
