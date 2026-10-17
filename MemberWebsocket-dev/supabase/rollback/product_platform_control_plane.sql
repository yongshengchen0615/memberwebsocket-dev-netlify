-- Manual rollback: back up platform settings + encrypted credentials before running.
-- This removes ONLY the new control plane; original member/business tables remain.
begin;
drop function public.platform_suspend_tenant(text,uuid,integer,uuid);
drop function public.platform_save_tenant(text,uuid,text,uuid,integer,jsonb,jsonb);
drop function public.platform_list_tenants(text);
drop function public.platform_is_super_admin(text);
drop schema platform_private cascade;
drop function public.platform_features_valid(jsonb);
commit;
