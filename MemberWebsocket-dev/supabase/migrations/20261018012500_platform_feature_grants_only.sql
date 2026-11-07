-- Root controls only feature grants on approved tenants. LINE metadata and credentials
-- remain owned by the merchant. No changes to existing business tables.
begin;

create or replace function public.platform_list_applications(p_actor text)
returns setof jsonb language plpgsql stable security invoker set search_path='' as $$
begin
 if not public.platform_is_super_admin(p_actor) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
 return query select jsonb_build_object(
   'id',a.id,'businessName',a.business_name,'slug',a.slug,
   'applicantLineUserId',a.applicant_line_user_id,'status',a.status,
   'requestedAt',a.created_at,'reviewedAt',a.reviewed_at,'tenantId',a.tenant_id)
 from platform_private.applications a
 order by a.created_at desc,a.id;
end $$;

create function public.platform_update_tenant_features(
 p_actor text,p_tenant_id uuid,p_expected_version integer,p_features jsonb,
 p_request_id uuid,p_payload_hash text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 v_previous platform_private.requests;
 v_tenant platform_private.tenants;
begin
 if not public.platform_is_super_admin(p_actor) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
 if p_tenant_id is null or p_request_id is null or p_expected_version is null
  or p_expected_version < 1 or not coalesce(public.platform_features_valid(p_features),false)
  or p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$'
 then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into v_previous from platform_private.requests where request_id=p_request_id;
 if found then
  if v_previous.actor<>p_actor or v_previous.operation<>'features'
   or v_previous.payload_hash<>p_payload_hash
  then raise exception 'PLATFORM_REQUEST_CONFLICT'; end if;
  return v_previous.result;
 end if;
 select * into v_tenant from platform_private.tenants where id=p_tenant_id for update;
 if not found then raise exception 'PLATFORM_TENANT_NOT_FOUND'; end if;
 if v_tenant.version<>p_expected_version then raise exception 'PLATFORM_CONFLICT'; end if;
 -- Only grant booleans change. Do not touch LINE metadata, secrets or readiness.
 update platform_private.tenants
 set features=p_features,version=version+1,updated_by=p_actor,updated_at=clock_timestamp()
 where id=p_tenant_id returning * into v_tenant;
 insert into platform_private.audit_events(actor,tenant_id,action,detail)
 values(p_actor,p_tenant_id,'TENANT_FEATURES_UPDATED',
   jsonb_build_object('version',v_tenant.version,'features',p_features));
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
 values(p_request_id,p_actor,'features',p_payload_hash,to_jsonb(v_tenant));
 return to_jsonb(v_tenant);
end $$;

revoke all on function public.platform_update_tenant_features(text,uuid,integer,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.platform_update_tenant_features(text,uuid,integer,jsonb,uuid,text) to service_role;
commit;
