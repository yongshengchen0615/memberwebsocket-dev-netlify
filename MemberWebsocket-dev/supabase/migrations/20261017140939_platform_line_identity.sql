-- Separate the platform LINE Provider identity from the legacy owner's admin row.
-- Existing same-Provider owners retain their UID; different-Provider binding is
-- an explicit owner operation, never a first-login promotion.
begin;
alter table platform_private.super_admins add column line_user_id text;
update platform_private.super_admins s set line_user_id=a.line_user_id
from public.admins a where a.id=s.admin_id;
alter table platform_private.super_admins alter column line_user_id set not null;
alter table platform_private.super_admins add constraint platform_super_admin_line_identity
  check (line_user_id ~ '^U[0-9a-f]{32}$');

create or replace function public.platform_is_super_admin(p_actor text) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from platform_private.super_admins s join public.admins a on a.id=s.admin_id
    where s.enabled and s.line_user_id=p_actor and a.role='admin' and a.status='active')
$$;
revoke all on function public.platform_is_super_admin(text) from public,anon,authenticated;
grant execute on function public.platform_is_super_admin(text) to service_role;
commit;
