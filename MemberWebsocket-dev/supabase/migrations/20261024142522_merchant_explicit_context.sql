-- #97 coordinated context/runtime/UI rollout. No browser role can use these RPCs.
begin;

create function platform_private.require_merchant_access(p_actor text,p_tenant_id uuid,p_issued_at timestamptz)
returns platform_private.tenants language plpgsql security invoker set search_path='' as $$
declare q platform_private.admin_qualifications;t platform_private.tenants;
begin
 perform platform_private.require_merchant_qualification(p_actor);
 select * into q from platform_private.admin_qualifications where applicant_line_user_id=p_actor;
 select * into t from platform_private.tenants where id=p_tenant_id and owner_line_user_id=p_actor for update;
 if not found then raise exception 'PLATFORM_TENANT_NOT_FOUND';end if;
 if p_issued_at is null or not isfinite(p_issued_at) or p_issued_at>clock_timestamp()+interval '60 seconds'
  or p_issued_at<=greatest(q.access_revoked_before,t.access_revoked_before) then raise exception 'TENANT_REAUTH_REQUIRED';end if;
 if t.status<>'active' then raise exception 'PLATFORM_TENANT_NOT_FOUND';end if;
 if t.expires_at<=clock_timestamp() then raise exception 'TENANT_EXPIRED';end if;
 if not exists(select 1 from platform_private.applications where tenant_id=t.id and applicant_line_user_id=p_actor and status='approved')
  then raise exception 'PLATFORM_APPLICATION_NOT_APPROVED';end if;
 return t;
end $$;

create function public.platform_my_merchant_context(p_actor text,p_slug text,p_issued_at timestamptz)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a platform_private.applications;
begin
 if p_slug is null or char_length(p_slug) not between 3 and 40 or p_slug !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
  then raise exception 'PLATFORM_INVALID_INPUT';end if;
 perform platform_private.require_merchant_qualification(p_actor);
 select * into a from platform_private.applications where applicant_line_user_id=p_actor and slug=p_slug;
 if not found then raise exception 'PLATFORM_APPLICATION_NOT_FOUND';end if;
 if a.status<>'approved' then raise exception 'PLATFORM_APPLICATION_NOT_APPROVED';end if;
 perform platform_private.require_merchant_access(p_actor,a.tenant_id,p_issued_at);
 return platform_private.merchant_application_json(a);
end $$;

create function public.platform_business_context_v2(p_actor text default null,p_slug text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare choices jsonb;
begin
 -- Metadata is routing, not identity proof. Runtime must verify LINE and owner.
 select jsonb_agg(to_jsonb(t)||jsonb_build_object('owner_qualification_status',q.status,
  'admin_access_revoked_before',q.access_revoked_before)) into choices
 from platform_private.tenants t left join platform_private.admin_qualifications q on q.applicant_line_user_id=t.owner_line_user_id
 where (p_slug is not null and t.slug=p_slug) or (p_slug is null and t.owner_line_user_id=p_actor);
 if jsonb_array_length(choices)>1 then raise exception 'PLATFORM_BUSINESS_SELECTION_REQUIRED';end if;
 return choices->0;
end $$;

-- Preserve tested existing secret encryption, grants, expiry, notification and
-- audit semantics, replacing only the implicit owner lookup with an explicit
-- owner+tenant selector. Fail migration on source contract drift.
do $$
declare item record;definition text;tail integer;guard text;newname text;signature regprocedure;
begin
 guard:=E'if p_payload_hash is null or p_payload_hash !~ ''^[a-f0-9]{64}$'' then raise exception ''PLATFORM_INVALID_INPUT'';end if;\n p_payload_hash:=encode(sha256(convert_to(p_tenant_id::text||'':''||p_payload_hash,''UTF8'')),''hex'');\n perform platform_private.require_merchant_access(p_actor,p_tenant_id,p_issued_at);';
 for item in select * from (values
  ('platform_save_my_line(text,integer,uuid,text,jsonb,jsonb)',
   'platform_save_my_line_for_merchant',
   'p_actor text,p_tenant_id uuid,p_issued_at timestamptz,p_expected_version integer,p_request_id uuid,p_payload_hash text,p_line jsonb,p_secrets jsonb default null'),
  ('platform_save_module_line(text,text,integer,uuid,text,jsonb,jsonb)',
   'platform_save_module_line_for_merchant',
   'p_actor text,p_tenant_id uuid,p_issued_at timestamptz,p_feature text,p_expected_version integer,p_request_id uuid,p_payload_hash text,p_line jsonb,p_secrets jsonb default null'),
  ('platform_save_notification_route(text,text,text,text,integer,uuid,text,text,jsonb)',
   'platform_save_notification_route_for_merchant',
   'p_actor text,p_tenant_id uuid,p_issued_at timestamptz,p_feature text,p_purpose text,p_mode text,p_expected_version integer,p_request_id uuid,p_payload_hash text,p_channel_id text,p_envelope jsonb'),
  ('platform_notification_test(text,text,text,integer,uuid,text,jsonb)',
   'platform_notification_test_for_merchant',
   'p_actor text,p_tenant_id uuid,p_issued_at timestamptz,p_feature text,p_purpose text,p_expected_version integer,p_request_id uuid,p_payload_hash text,p_result jsonb default null')
 )v(old_signature,new_name,args) loop
  signature:=('public.'||item.old_signature)::regprocedure;
  select pg_get_functiondef(signature) into definition;
  tail:=position(E'\n RETURNS' in definition);
  if tail=0 or position('perform platform_private.require_single_merchant_owner(p_actor);' in definition)=0
   then raise exception 'MERCHANT_CONTEXT_DEFINITION_DRIFT: %',item.new_name;end if;
  definition:='CREATE OR REPLACE FUNCTION public.'||item.new_name||'('||item.args||')'||substr(definition,tail);
  definition:=replace(definition,'perform platform_private.require_single_merchant_owner(p_actor);',guard);
  if item.new_name='platform_save_my_line_for_merchant' then
   if position('where applicant_line_user_id=p_actor and status=''approved''' in definition)=0 then raise exception 'MERCHANT_CONTEXT_MY_LINE_DRIFT';end if;
   definition:=replace(definition,'where applicant_line_user_id=p_actor and status=''approved''','where applicant_line_user_id=p_actor and tenant_id=p_tenant_id and status=''approved''');
   definition:=replace(definition,'return v_previous.result;','return (select to_jsonb(t) from platform_private.tenants t where t.id=p_tenant_id);');
  else
   if position('where owner_line_user_id=p_actor for update' in definition)=0 then raise exception 'MERCHANT_CONTEXT_OWNER_DRIFT';end if;
   definition:=replace(definition,'where owner_line_user_id=p_actor for update','where id=p_tenant_id and owner_line_user_id=p_actor for update');
   if item.new_name<>'platform_notification_test_for_merchant' then definition:=replace(definition,'return r.result;','return to_jsonb(t);');end if;
  end if;
  execute definition;
  execute 'revoke all on function public.'||item.new_name||'('||case item.new_name
   when 'platform_save_my_line_for_merchant' then 'text,uuid,timestamptz,integer,uuid,text,jsonb,jsonb'
   when 'platform_save_module_line_for_merchant' then 'text,uuid,timestamptz,text,integer,uuid,text,jsonb,jsonb'
   when 'platform_save_notification_route_for_merchant' then 'text,uuid,timestamptz,text,text,text,integer,uuid,text,text,jsonb'
   else 'text,uuid,timestamptz,text,text,integer,uuid,text,jsonb' end||') from public,anon,authenticated';
  execute 'grant execute on function public.'||item.new_name||'('||case item.new_name
   when 'platform_save_my_line_for_merchant' then 'text,uuid,timestamptz,integer,uuid,text,jsonb,jsonb'
   when 'platform_save_module_line_for_merchant' then 'text,uuid,timestamptz,text,integer,uuid,text,jsonb,jsonb'
   when 'platform_save_notification_route_for_merchant' then 'text,uuid,timestamptz,text,text,text,integer,uuid,text,text,jsonb'
   else 'text,uuid,timestamptz,text,text,integer,uuid,text,jsonb' end||') to service_role';
 end loop;
end $$;

revoke all on function platform_private.require_merchant_access(text,uuid,timestamptz),
 public.platform_my_merchant_context(text,text,timestamptz),public.platform_business_context_v2(text,text)
 from public,anon,authenticated;
grant execute on function platform_private.require_merchant_access(text,uuid,timestamptz),
 public.platform_my_merchant_context(text,text,timestamptz),public.platform_business_context_v2(text,text)
 to service_role;
notify pgrst,'reload schema';
commit;
