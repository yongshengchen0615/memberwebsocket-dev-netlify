-- #97 SQL batch only. Deploy only with the complete explicit-context Edge/UI rollout.
begin;

alter table platform_private.admin_qualifications
 add constraint admin_qualifications_id_actor_key unique(id,applicant_line_user_id);
alter table platform_private.applications
 add column qualification_id uuid,
 add column version integer not null default 1 check(version>0),
 add column review_reason text check(review_reason is null or char_length(review_reason) between 1 and 500);
update platform_private.applications a set qualification_id=q.id
 from platform_private.admin_qualifications q where q.applicant_line_user_id=a.applicant_line_user_id;
alter table platform_private.applications
 alter column qualification_id set not null,
 add constraint merchant_application_qualification_owner_fk
 foreign key(qualification_id,applicant_line_user_id)
 references platform_private.admin_qualifications(id,applicant_line_user_id) on delete restrict,
 drop constraint applications_applicant_line_user_id_key;
create index merchant_applications_owner_created_idx
 on platform_private.applications(applicant_line_user_id,created_at,id);
create index merchant_tenants_owner_idx on platform_private.tenants(owner_line_user_id,id);

create function platform_private.require_merchant_qualification(p_actor text) returns uuid
language plpgsql security invoker set search_path='' as $$
declare q platform_private.admin_qualifications;
begin
 if p_actor is null or p_actor !~ '^U[0-9a-f]{32}$' then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 select * into q from platform_private.admin_qualifications where applicant_line_user_id=p_actor for share;
 if not found or q.status<>'approved' then raise exception 'PLATFORM_QUALIFICATION_REQUIRED'; end if;
 return q.id;
end $$;

create function platform_private.merchant_application_json(a platform_private.applications) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',a.id,'qualificationId',a.qualification_id,
  'businessName',a.business_name,'slug',a.slug,'status',a.status,'version',a.version,
  'requestedAt',a.created_at,'updatedAt',a.updated_at,'reviewedAt',a.reviewed_at,
  'reviewReason',a.review_reason,
  'tenant',(select to_jsonb(t) from platform_private.tenants t where t.id=a.tenant_id))
$$;

create function public.platform_my_merchant_applications(p_actor text) returns setof jsonb
language plpgsql security invoker set search_path='' as $$
begin
 perform platform_private.require_merchant_qualification(p_actor);
 return query select platform_private.merchant_application_json(a)
  from platform_private.applications a where a.applicant_line_user_id=p_actor order by a.created_at,a.id;
end $$;

create function public.platform_get_merchant_application(p_actor text,p_application_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a platform_private.applications;
begin
 perform platform_private.require_merchant_qualification(p_actor);
 if p_application_id is null then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 select * into a from platform_private.applications where id=p_application_id and applicant_line_user_id=p_actor;
 if not found then raise exception 'PLATFORM_APPLICATION_NOT_FOUND'; end if;
 return platform_private.merchant_application_json(a);
end $$;

create function public.platform_submit_merchant_application(
 p_actor text,p_name text,p_slug text,p_request_id uuid,
 p_application_id uuid default null,p_expected_version integer default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare a platform_private.applications; q uuid; r platform_private.requests; h text; result jsonb;
begin
 if p_actor is null or p_actor !~ '^U[0-9a-f]{32}$'
  or p_name is null or char_length(btrim(p_name)) not between 1 and 100
  or p_slug is null or char_length(p_slug) not between 3 and 40
  or p_slug !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
  or p_slug in ('admin','platform','api','www','root','system') or p_request_id is null
  or (p_application_id is null and p_expected_version is not null)
  or (p_application_id is not null and (p_expected_version is null or p_expected_version<1))
 then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 h:=encode(sha256(convert_to(jsonb_build_object('name',btrim(p_name),'slug',p_slug,
  'applicationId',p_application_id,'version',p_expected_version)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 q:=platform_private.require_merchant_qualification(p_actor);
 select * into r from platform_private.requests where request_id=p_request_id;
 if found then
  if r.actor<>p_actor or r.operation<>'merchant_submit' or r.payload_hash<>h
   then raise exception 'PLATFORM_REQUEST_CONFLICT'; end if;
  return public.platform_get_merchant_application(p_actor,(r.result->>'id')::uuid);
 end if;
 perform pg_advisory_xact_lock(hashtextextended('platform:merchant-slug:'||p_slug,0));
 if p_application_id is null then
  if exists(select 1 from platform_private.tenants where slug=p_slug)
   then raise exception 'PLATFORM_DUPLICATE_SLUG'; end if;
  begin
   insert into platform_private.applications(applicant_line_user_id,qualification_id,business_name,slug)
    values(p_actor,q,btrim(p_name),p_slug) returning * into a;
  exception when unique_violation then raise exception 'PLATFORM_DUPLICATE_SLUG'; end;
 else
  select * into a from platform_private.applications
   where id=p_application_id and applicant_line_user_id=p_actor for update;
  if not found then raise exception 'PLATFORM_APPLICATION_NOT_FOUND'; end if;
  if a.version<>p_expected_version then raise exception 'PLATFORM_CONFLICT'; end if;
  if a.status<>'rejected' then raise exception 'PLATFORM_APPLICATION_REVIEWED'; end if;
  if exists(select 1 from platform_private.tenants where slug=p_slug)
   then raise exception 'PLATFORM_DUPLICATE_SLUG'; end if;
  begin
   update platform_private.applications set business_name=btrim(p_name),slug=p_slug,status='pending',
    reviewed_by=null,reviewed_at=null,review_reason=null,version=version+1,updated_at=clock_timestamp()
    where id=a.id returning * into a;
  exception when unique_violation then raise exception 'PLATFORM_DUPLICATE_SLUG'; end;
 end if;
 insert into platform_private.audit_events(actor,action,detail)
  values(p_actor,case when p_application_id is null then 'MERCHANT_APPLICATION_SUBMITTED' else 'MERCHANT_APPLICATION_RESUBMITTED' end,
   jsonb_build_object('applicationId',a.id,'qualificationId',q,'version',a.version));
 result:=platform_private.merchant_application_json(a);
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
  values(p_request_id,p_actor,'merchant_submit',h,result);
 return result;
end $$;

create function public.platform_review_merchant_application(
 p_actor text,p_application_id uuid,p_expected_version integer,p_decision text,p_reason text,
 p_features jsonb,p_request_id uuid
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare a platform_private.applications; t platform_private.tenants; r platform_private.requests;
 hint platform_private.applications; h text; q uuid; result jsonb;
begin
 if not public.platform_is_super_admin(p_actor) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
 if p_application_id is null or p_request_id is null or p_expected_version is null or p_expected_version<1
  or p_decision is null or p_decision not in ('approved','rejected')
  or p_reason is null or char_length(btrim(p_reason))>500
  or (p_decision='rejected' and (char_length(btrim(p_reason))=0 or p_features is not null))
  or (p_decision='approved' and not coalesce(public.platform_features_valid(p_features),false))
 then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 h:=encode(sha256(convert_to(jsonb_build_object('id',p_application_id,'version',p_expected_version,
  'decision',p_decision,'reason',btrim(p_reason),'features',p_features)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into hint from platform_private.applications where id=p_application_id;
 if not found then raise exception 'PLATFORM_APPLICATION_NOT_FOUND'; end if;
 q:=platform_private.require_merchant_qualification(hint.applicant_line_user_id);
 perform pg_advisory_xact_lock(hashtextextended('platform:merchant-slug:'||hint.slug,0));
 select * into a from platform_private.applications where id=p_application_id for update;
 if a.qualification_id<>q or a.applicant_line_user_id<>hint.applicant_line_user_id
  then raise exception 'PLATFORM_CONFLICT'; end if;
 -- A waiter must recheck revocation; authorization changes then wait until
 -- this already-authorized transaction commits, including provisioning waits.
 perform platform_private.lock_platform_reviewer(p_actor);
 select * into r from platform_private.requests where request_id=p_request_id;
 if found then
  if r.actor<>p_actor or r.operation<>'merchant_review' or r.payload_hash<>h
   then raise exception 'PLATFORM_REQUEST_CONFLICT'; end if;
  return platform_private.merchant_application_json(a);
 end if;
 if a.version<>p_expected_version then raise exception 'PLATFORM_CONFLICT'; end if;
 if a.status<>'pending' then raise exception 'PLATFORM_APPLICATION_REVIEWED'; end if;
 if p_decision='approved' then
  if exists(select 1 from platform_private.tenants where slug=a.slug)
   then raise exception 'PLATFORM_DUPLICATE_SLUG'; end if;
  begin
   insert into platform_private.tenants(id,name,slug,owner_line_user_id,features,line_config,
    credentials_configured,created_by,updated_by)
    values(gen_random_uuid(),a.business_name,a.slug,a.applicant_line_user_id,
     p_features,'{}'::jsonb,false,p_actor,p_actor) returning * into t;
  exception when unique_violation then raise exception 'PLATFORM_DUPLICATE_SLUG'; end;
  perform public.platform_provision_business(t.id);
  select * into t from platform_private.tenants where id=t.id;
  if t.status<>'active' or t.runtime_schema is null then raise exception 'PLATFORM_PROVISIONING_INCOMPLETE'; end if;
 end if;
 update platform_private.applications set status=p_decision,tenant_id=t.id,
  reviewed_by=p_actor,reviewed_at=clock_timestamp(),review_reason=nullif(btrim(p_reason),''),
  version=version+1,updated_at=clock_timestamp() where id=a.id returning * into a;
 insert into platform_private.audit_events(actor,tenant_id,action,detail)
  values(p_actor,t.id,'MERCHANT_APPLICATION_'||upper(p_decision),
   jsonb_build_object('applicationId',a.id,'version',a.version,'features',p_features));
 result:=platform_private.merchant_application_json(a);
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
  values(p_request_id,p_actor,'merchant_review',h,result);
 return result;
end $$;

-- Legacy readers/settings cannot guess a merchant once there are multiple.
-- An exclusive qualification lock prevents an extra merchant being committed
-- between the ambiguity check and the original settings body's owner query.
create function platform_private.require_single_merchant_owner(p_actor text,p_require_qualification boolean default true) returns void
language plpgsql security invoker set search_path='' as $$
declare q platform_private.admin_qualifications;
begin
 if p_actor is null or p_actor !~ '^U[0-9a-f]{32}$' then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 select * into q from platform_private.admin_qualifications where applicant_line_user_id=p_actor for update;
 if p_require_qualification and (not found or q.status<>'approved') then raise exception 'PLATFORM_QUALIFICATION_REQUIRED'; end if;
 if (select count(*) from platform_private.applications where applicant_line_user_id=p_actor)>1
  or (select count(*) from platform_private.tenants where owner_line_user_id=p_actor)>1
 then raise exception 'PLATFORM_BUSINESS_SELECTION_REQUIRED'; end if;
end $$;

create or replace function public.platform_my_application(p_actor text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a platform_private.applications;
begin
 perform platform_private.require_single_merchant_owner(p_actor,false);
 select * into a from platform_private.applications where applicant_line_user_id=p_actor;
 if not found then return null; end if;
 return platform_private.merchant_application_json(a);
end $$;

create or replace function public.platform_business_context(p_actor text default null,p_slug text default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare choices jsonb;
begin
 -- Routing metadata only; explicit-slug public/member requests still use the
 -- original LINE verifier and server policy later in the request.
 select jsonb_agg(to_jsonb(t)) into choices from platform_private.tenants t
  where (p_slug is not null and t.slug=p_slug) or (p_slug is null and t.owner_line_user_id=p_actor);
 if jsonb_array_length(choices)>1 then raise exception 'PLATFORM_BUSINESS_SELECTION_REQUIRED'; end if;
 return choices->0;
end $$;

create or replace function public.platform_submit_application(p_actor text,p_name text,p_slug text) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin raise exception 'PLATFORM_MERCHANT_API_REQUIRED'; end $$;
create or replace function public.platform_approve_application(p_actor text,p_application_id uuid,p_features jsonb,p_request_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin raise exception 'PLATFORM_MERCHANT_API_REQUIRED'; end $$;

-- Preserve the already-installed expiry, grants, secret handling and notification
-- bodies. Guard every implicit-owner legacy writer before its first read/write;
-- take its request lock first to avoid a request/qualification lock inversion.
do $$ declare signature text; definition text; guard text; begin
 guard:=E'\nbegin\n perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));\n perform platform_private.require_single_merchant_owner(p_actor);\n';
 foreach signature in array array[
  'public.platform_save_my_line(text,integer,uuid,text,jsonb,jsonb)',
  'public.platform_save_module_line(text,text,integer,uuid,text,jsonb,jsonb)',
  'public.platform_save_notification_route(text,text,text,text,integer,uuid,text,text,jsonb)',
  'public.platform_notification_test(text,text,text,integer,uuid,text,jsonb)'
 ] loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  if position(E'\nbegin\n' in definition)=0 or position('require_single_merchant_owner' in definition)>0
   then raise exception 'MERCHANT_LEGACY_SETTINGS_DEFINITION_DRIFT'; end if;
  execute replace(definition,E'\nbegin\n',guard);
 end loop;
end $$;

-- The real provisioner reads and writes one shared authenticator role setting.
-- Lock the catalog-writing base beneath the current risk-installing wrapper,
-- covering both the wrapper and direct base calls without changing installers.
do $$ declare definition text; begin
 select pg_get_functiondef('public.platform_provision_business_base_20261021(uuid)'::regprocedure) into definition;
 if position(E'\nbegin\n' in definition)=0 or position('platform:business-provision' in definition)>0
  then raise exception 'MERCHANT_PROVISIONER_DEFINITION_DRIFT'; end if;
 execute replace(definition,E'\nbegin\n',E'\nbegin\n perform pg_advisory_xact_lock(hashtextextended(''platform:business-provision'',0));\n');
end $$;

create or replace function public.platform_list_applications(p_actor text) returns setof jsonb
language plpgsql security invoker set search_path='' as $$
begin
 if not public.platform_is_super_admin(p_actor) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
 return query select platform_private.merchant_application_json(a)
  ||jsonb_build_object('applicantLineUserId',a.applicant_line_user_id,'tenantId',a.tenant_id)
  from platform_private.applications a order by a.created_at desc,a.id;
end $$;

revoke all on function platform_private.require_merchant_qualification(text),
 platform_private.require_single_merchant_owner(text,boolean),
 platform_private.merchant_application_json(platform_private.applications),
 public.platform_my_merchant_applications(text),public.platform_get_merchant_application(text,uuid),
 public.platform_submit_merchant_application(text,text,text,uuid,uuid,integer),
 public.platform_review_merchant_application(text,uuid,integer,text,text,jsonb,uuid)
 from public,anon,authenticated;
grant execute on function platform_private.require_merchant_qualification(text),
 platform_private.require_single_merchant_owner(text,boolean),
 platform_private.merchant_application_json(platform_private.applications),
 public.platform_my_merchant_applications(text),public.platform_get_merchant_application(text,uuid),
 public.platform_submit_merchant_application(text,text,text,uuid,uuid,integer),
 public.platform_review_merchant_application(text,uuid,integer,text,text,jsonb,uuid) to service_role;
notify pgrst,'reload schema';
commit;
