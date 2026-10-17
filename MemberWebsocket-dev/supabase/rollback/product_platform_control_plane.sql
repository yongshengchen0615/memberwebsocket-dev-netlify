-- Manual rollback: back up platform settings + encrypted credentials before running.
-- This removes ONLY the new control plane; original member/business tables remain.
begin;
drop function if exists public.platform_credential_key();
drop function if exists public.platform_save_my_line(text,integer,uuid,text,jsonb,jsonb);
drop function if exists public.platform_approve_application(text,uuid,jsonb,uuid);
drop function if exists public.platform_list_applications(text);
drop function if exists public.platform_submit_application(text,text,text);
drop function if exists public.platform_my_application(text);
drop function public.platform_suspend_tenant(text,uuid,integer,uuid);
drop function public.platform_save_tenant(text,uuid,text,uuid,integer,jsonb,jsonb);
drop function public.platform_list_tenants(text);
drop function public.platform_is_super_admin(text);
drop schema platform_private cascade;
drop function public.platform_features_valid(jsonb);
commit;
