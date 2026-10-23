-- #82: Post-reset, privileged, one-use root bootstrap for the approved test project.
-- Deployment is non-destructive. A reset executor must atomically mark the
-- epoch completed before this function can be used. No public bootstrap route.
begin;
create table if not exists maintenance.sandbox_reset_epoch (
 singleton boolean primary key default true check (singleton=true),
 last_completed_request uuid unique,
 last_completed_at timestamptz,
 root_bootstrap_required boolean not null default false,
 bootstrapped_at timestamptz,
 constraint complete_epoch_before_bootstrap check (
  not root_bootstrap_required or (last_completed_request is not null and last_completed_at is not null)
 )
);
revoke all on maintenance.sandbox_reset_epoch from public,anon,authenticated,service_role;
insert into maintenance.sandbox_reset_epoch(singleton) values(true)
on conflict(singleton) do nothing;

create or replace function maintenance.bootstrap_sandbox_root(
 p_line_user_id text, p_confirmation text)
returns jsonb language plpgsql security invoker set search_path=''
as $function$
declare v_admin_id uuid;
begin
 if current_user is distinct from 'postgres' then
   raise exception 'DBA_ONLY_ROOT_BOOTSTRAP' using errcode='42501';
 end if;
 if p_confirmation is distinct from 'RESTORE ROOT AFTER VERIFIED SANDBOX RESET' then
   raise exception 'ROOT_BOOTSTRAP_CONFIRMATION_REQUIRED';
 end if;
 if p_line_user_id is null or p_line_user_id !~ '^U[0-9a-fA-F]{32}$' then
   raise exception 'INVALID_LINE_ID';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('maintenance:sandbox-reset-epoch',0));
 if not exists(
  select 1 from maintenance.sandbox_reset_target
  where singleton=true and project_ref='dbuquirnaskrwcamdxki' and sandbox_approved=true
 ) then raise exception 'SANDBOX_PROJECT_NOT_APPROVED'; end if;
 if not exists (
  select 1 from maintenance.sandbox_reset_epoch
  where singleton=true and last_completed_request is not null and last_completed_at is not null
    and root_bootstrap_required=true and bootstrapped_at is null
 ) then raise exception 'VERIFIED_RESET_REQUIRED_BEFORE_ROOT_BOOTSTRAP'; end if;
 if exists(select 1 from public.admins)
  or exists(select 1 from platform_private.super_admins)
  or exists(select 1 from platform_private.tenants)
  or exists(select 1 from public.members)
  or exists(select 1 from auth.users)
  or exists(select 1 from storage.objects)
 then raise exception 'SANDBOX_NOT_EMPTY_FOR_ROOT_BOOTSTRAP'; end if;
 insert into public.admins(line_user_id,display_name,role,status)
 values(p_line_user_id,'初始化總管理員','admin','active') returning id into v_admin_id;
 insert into platform_private.super_admins(singleton,admin_id,enabled,line_user_id)
 values(true,v_admin_id,true,p_line_user_id);
 update maintenance.sandbox_reset_epoch
 set root_bootstrap_required=false,bootstrapped_at=pg_catalog.clock_timestamp()
 where singleton=true;
 return pg_catalog.jsonb_build_object('bootstrapped',true,'bootstrapSingleUse',true);
end;
$function$;
revoke all on function maintenance.bootstrap_sandbox_root(text,text)
from public,anon,authenticated,service_role;
commit;
