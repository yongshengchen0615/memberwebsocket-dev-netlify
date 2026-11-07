-- The platform grant is not implied by LINE login or legacy admin role.
-- The previous one-time legacy auto-seeded grant is deliberately disabled.
begin;
alter table platform_private.super_admins alter column enabled set default false;
update platform_private.super_admins set enabled=false where enabled=true;
commit;
