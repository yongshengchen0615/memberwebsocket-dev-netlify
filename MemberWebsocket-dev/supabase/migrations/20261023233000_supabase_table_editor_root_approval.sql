-- Supabase Table Editor is the sole activation switch for the first Platform
-- total administrator. LINE verification creates a DISABLED candidate; a
-- Supabase postgres administrator explicitly sets super_admins.enabled=true.
-- No SQL Editor bootstrap command or in-Platform self approval is required.
begin;

-- The live table remains a singleton to preserve the old Platform root contract.
-- All changes to an enabled root must originate from a privileged DB operator.
create or replace function platform_private.enforce_super_admin_dashboard_grant()
returns trigger language plpgsql set search_path=''
as $$
declare
 v_admin_role text;
 v_admin_status text;
begin
 if tg_op='UPDATE' and old.enabled=true and
    (new.admin_id is distinct from old.admin_id
     or new.line_user_id is distinct from old.line_user_id) then
   raise exception 'PLATFORM_DISABLE_ROOT_BEFORE_REASSIGNING_IDENTITY';
 end if;
 if tg_op='UPDATE' and
     (new.enabled is distinct from old.enabled
      or new.admin_id is distinct from old.admin_id
      or new.line_user_id is distinct from old.line_user_id)
    and current_user is distinct from 'postgres' then
   raise exception 'PLATFORM_SUPABASE_OWNER_APPROVAL_REQUIRED' using errcode='42501';
 end if;
 if tg_op='INSERT' and new.enabled and current_user is distinct from 'postgres' then
   raise exception 'PLATFORM_SUPABASE_OWNER_APPROVAL_REQUIRED' using errcode='42501';
 end if;
 if new.enabled then
   select role,status into v_admin_role,v_admin_status
     from public.admins where id=new.admin_id;
   if not found then raise exception 'PLATFORM_ADMIN_RECORD_NOT_FOUND'; end if;
   -- Legacy root grants may predate the new pending-visit table. New grants
   -- must match a verified LINE visit, not an arbitrary typed ID.
   if (tg_op='INSERT' or (tg_op='UPDATE' and old.enabled=false))
     and (v_admin_role <> 'admin' or v_admin_status <> 'active')
     and not exists(
       select 1 from platform_private.platform_access_requests
       where line_user_id=new.line_user_id
     ) then
      raise exception 'PLATFORM_VERIFIED_LINE_VISIT_REQUIRED';
   end if;
   if tg_op='INSERT' or (tg_op='UPDATE' and old.enabled=false) then
     update public.admins set role='admin',status='active'
       where id=new.admin_id;
     -- This is a genuine root grant made in Supabase Table Editor, replacing
     -- the old DBA SQL bootstrap only for the approved test reset epoch.
     if pg_catalog.to_regclass('maintenance.sandbox_reset_epoch') is not null then
       execute 'update maintenance.sandbox_reset_epoch
         set root_bootstrap_required=false,bootstrapped_at=clock_timestamp()
         where singleton=true and root_bootstrap_required=true
           and last_completed_request is not null';
     end if;
   end if;
 end if;
 if tg_op='UPDATE' and new.enabled is distinct from old.enabled then
   insert into platform_private.audit_events(actor,action,detail)
   values('postgres',case when new.enabled
       then 'PLATFORM_ROOT_ENABLED_IN_SUPABASE'
       else 'PLATFORM_ROOT_DISABLED_IN_SUPABASE' end,
     pg_catalog.jsonb_build_object('targetAdminId',new.admin_id,
       'lineUserId',new.line_user_id,'enabled',new.enabled));
 end if;
 return new;
end $$;

drop trigger if exists platform_super_admin_dashboard_grant
 on platform_private.super_admins;
create trigger platform_super_admin_dashboard_grant
 before insert or update of enabled,admin_id,line_user_id
 on platform_private.super_admins
 for each row execute function platform_private.enforce_super_admin_dashboard_grant();

-- RPC is called only AFTER Platform-specific LINE token verification.
-- The first verified candidate after reset becomes a disabled singleton
-- proposal. They cannot use Platform until Supabase Table Editor approval.
create or replace function public.platform_record_access_request(
  p_actor text, p_display_name text
) returns jsonb language plpgsql security invoker set search_path=''
as $$
declare
 v_record platform_private.platform_access_requests%rowtype;
 v_admin_id uuid;
 v_root_candidate_created boolean:=false;
 v_rows integer;
begin
 if p_actor is null or p_actor !~ '^U[0-9a-f]{32}$'
   or p_display_name is null
   or char_length(pg_catalog.btrim(p_display_name)) not between 1 and 120 then
   raise exception 'PLATFORM_INVALID_ACCESS_IDENTITY';
 end if;
 insert into platform_private.platform_access_requests(
   line_user_id,display_name
 ) values(p_actor,pg_catalog.btrim(p_display_name))
 on conflict (line_user_id)
 do update set display_name=excluded.display_name,
               last_seen_at=pg_catalog.clock_timestamp()
 returning * into v_record;

 -- Existing grants cannot be overwritten by LINE visitors. The singleton
 -- PRIMARY KEY serializes concurrent first visits (including in PGlite);
 -- there is no unsupported advisory-lock assumption in the web runtime.
 if not exists(select 1 from platform_private.super_admins) then
   insert into public.admins(line_user_id,display_name,role,status)
   values(p_actor,pg_catalog.btrim(p_display_name),'none','pending')
   on conflict (line_user_id)
   do update set display_name=excluded.display_name
   returning id into v_admin_id;

   insert into platform_private.super_admins(
     singleton,admin_id,enabled,line_user_id
   ) values(true,v_admin_id,false,p_actor)
   on conflict (singleton) do nothing;
   get diagnostics v_rows = row_count;
   v_root_candidate_created := (v_rows=1);
 end if;

 return pg_catalog.jsonb_build_object(
   'registered',true,
   'accessEnabled',v_record.access_enabled,
   'pendingSupabaseApproval',v_root_candidate_created
 );
end $$;

-- service_role may record a disabled candidate but is not allowed to
-- update super_admins: only the Supabase postgres table operator can grant.
revoke update,delete on platform_private.super_admins from service_role;
revoke all on function platform_private.enforce_super_admin_dashboard_grant()
 from public,anon,authenticated,service_role;
revoke all on function public.platform_record_access_request(text,text)
 from public,anon,authenticated;
grant execute on function public.platform_record_access_request(text,text)
 to service_role;
commit;
