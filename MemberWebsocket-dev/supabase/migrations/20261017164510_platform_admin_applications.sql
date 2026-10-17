-- Merchant self-registration, root feature approval and owner-managed LINE configuration.
-- The control-plane approval intentionally does not activate a business data plane.
begin;
create table platform_private.applications (
 id uuid primary key default gen_random_uuid(),
 applicant_line_user_id text not null unique check (applicant_line_user_id ~ '^U[0-9a-f]{32}$'),
 business_name text not null check (char_length(btrim(business_name)) between 1 and 100),
 slug text not null unique check (char_length(slug) between 3 and 40 and slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
   and slug not in ('admin','platform','api','www','root','system')),
 status text not null default 'pending' check (status in ('pending','approved','rejected')),
 tenant_id uuid unique references platform_private.tenants(id) on delete restrict,
 reviewed_by text, reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint platform_application_approval_consistent check
  ((status = 'approved') = (tenant_id is not null))
);
create index platform_applications_status_created_idx on platform_private.applications(status,created_at desc);
alter table platform_private.applications enable row level security;
revoke all on platform_private.applications from public,anon,authenticated;
grant select,insert,update on platform_private.applications to service_role;

create function public.platform_my_application(p_actor text) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce((
  select jsonb_build_object('id',a.id,'businessName',a.business_name,'slug',a.slug,
   'status',a.status,'requestedAt',a.created_at,'reviewedAt',a.reviewed_at,
   'tenant',case when t.id is null then null else to_jsonb(t) end)
  from platform_private.applications a
  left join platform_private.tenants t on t.id=a.tenant_id
  where a.applicant_line_user_id=p_actor
 ),'null'::jsonb)
$$;

create function public.platform_submit_application(p_actor text,p_name text,p_slug text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_row platform_private.applications;
begin
 if p_actor is null or p_actor !~ '^U[0-9a-f]{32}$'
  or p_name is null or char_length(btrim(p_name)) not between 1 and 100
  or p_slug is null or char_length(p_slug) not between 3 and 40
  or p_slug !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
  or p_slug in ('admin','platform','api','www','root','system')
 then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 perform pg_advisory_xact_lock(hashtextextended('platform:apply:'||p_actor,0));
 select * into v_row from platform_private.applications where applicant_line_user_id=p_actor for update;
 if found then
  if v_row.status='rejected' then
   begin
    update platform_private.applications set business_name=btrim(p_name),slug=p_slug,
     status='pending',reviewed_by=null,reviewed_at=null,updated_at=clock_timestamp()
    where id=v_row.id returning * into v_row;
   exception when unique_violation then raise exception 'PLATFORM_DUPLICATE_SLUG'; end;
   insert into platform_private.audit_events(actor,action,detail)
    values(p_actor,'APPLICATION_RESUBMITTED',jsonb_build_object('applicationId',v_row.id));
  end if;
 else
  if exists(select 1 from platform_private.tenants where slug=p_slug) then raise exception 'PLATFORM_DUPLICATE_SLUG'; end if;
  begin
   insert into platform_private.applications(applicant_line_user_id,business_name,slug)
   values(p_actor,btrim(p_name),p_slug) returning * into v_row;
  exception when unique_violation then raise exception 'PLATFORM_DUPLICATE_SLUG'; end;
  insert into platform_private.audit_events(actor,action,detail)
   values(p_actor,'APPLICATION_SUBMITTED',jsonb_build_object('applicationId',v_row.id));
 end if;
 return public.platform_my_application(p_actor);
end $$;

create function public.platform_list_applications(p_actor text) returns setof jsonb
language plpgsql stable security invoker set search_path='' as $$
begin
 if not public.platform_is_super_admin(p_actor) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
 return query select jsonb_build_object('id',a.id,'businessName',a.business_name,
  'slug',a.slug,'status',a.status,'requestedAt',a.created_at,
  'reviewedAt',a.reviewed_at,'tenantId',a.tenant_id)
 from platform_private.applications a order by a.created_at desc,a.id;
end $$;

create function public.platform_approve_application(
 p_actor text,p_application_id uuid,p_features jsonb,p_request_id uuid
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_app platform_private.applications;v_tenant platform_private.tenants;
 v_existing platform_private.requests;v_hash text;
begin
 if not public.platform_is_super_admin(p_actor) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
 if p_request_id is null or p_application_id is null or not public.platform_features_valid(p_features)
 then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 v_hash:=md5(p_application_id::text||':'||p_features::text);
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into v_existing from platform_private.requests where request_id=p_request_id;
 if found then
  if v_existing.actor<>p_actor or v_existing.operation<>'approve' or v_existing.payload_hash<>v_hash
  then raise exception 'PLATFORM_REQUEST_CONFLICT'; end if;
  return v_existing.result;
 end if;
 select * into v_app from platform_private.applications where id=p_application_id for update;
 if not found then raise exception 'PLATFORM_APPLICATION_NOT_FOUND'; end if;
 if v_app.status<>'pending' then raise exception 'PLATFORM_APPLICATION_REVIEWED'; end if;
 if exists(select 1 from platform_private.tenants where slug=v_app.slug or owner_line_user_id=v_app.applicant_line_user_id)
 then raise exception 'PLATFORM_DUPLICATE_SLUG'; end if;
 begin
  insert into platform_private.tenants(id,name,slug,owner_line_user_id,features,line_config,
   credentials_configured,created_by,updated_by)
  values(gen_random_uuid(),v_app.business_name,v_app.slug,v_app.applicant_line_user_id,
   p_features,'{}'::jsonb,false,p_actor,p_actor) returning * into v_tenant;
 exception when unique_violation then raise exception 'PLATFORM_DUPLICATE_SLUG'; end;
 update platform_private.applications set status='approved',tenant_id=v_tenant.id,
  reviewed_by=p_actor,reviewed_at=clock_timestamp(),updated_at=clock_timestamp()
 where id=v_app.id;
 insert into platform_private.audit_events(actor,tenant_id,action,detail)
 values(p_actor,v_tenant.id,'APPLICATION_APPROVED',
  jsonb_build_object('applicationId',v_app.id,'features',p_features));
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
 values(p_request_id,p_actor,'approve',v_hash,to_jsonb(v_tenant));
 return to_jsonb(v_tenant);
end $$;

create function public.platform_save_my_line(
 p_actor text,p_expected_version integer,p_request_id uuid,p_payload_hash text,
 p_line jsonb,p_secrets jsonb default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_app platform_private.applications;v_tenant platform_private.tenants;v_previous platform_private.requests;
begin
 if p_actor is null or p_request_id is null or p_expected_version is null or p_expected_version<1
  or p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$'
  or p_line is null or jsonb_typeof(p_line)<>'object' or (select count(*) from jsonb_object_keys(p_line))<>9
  or not (p_line ?& array['adminChannelId','memberChannelId','messagingChannelId',
  'adminLiffId','memberLiffId','pointsLiffId','eventLiffId','calendarLiffId','bookingLiffId'])
 then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into v_previous from platform_private.requests where request_id=p_request_id;
 if found then
  if v_previous.actor<>p_actor or v_previous.operation<>'my_line' or v_previous.payload_hash<>p_payload_hash
  then raise exception 'PLATFORM_REQUEST_CONFLICT'; end if;
  return v_previous.result;
 end if;
 select * into v_app from platform_private.applications
 where applicant_line_user_id=p_actor and status='approved';
 if not found then raise exception 'PLATFORM_APPLICATION_NOT_APPROVED'; end if;
 select * into v_tenant from platform_private.tenants
 where id=v_app.tenant_id and owner_line_user_id=p_actor for update;
 if not found or v_tenant.status='suspended' then raise exception 'PLATFORM_TENANT_NOT_FOUND'; end if;
 if v_tenant.version<>p_expected_version then raise exception 'PLATFORM_CONFLICT'; end if;
 if p_secrets is null and not v_tenant.credentials_configured then raise exception 'PLATFORM_CREDENTIALS_REQUIRED'; end if;
 update platform_private.tenants set line_config=p_line,credentials_configured=(credentials_configured or p_secrets is not null),
  version=version+1,updated_by=p_actor,updated_at=clock_timestamp()
 where id=v_tenant.id returning * into v_tenant;
 if p_secrets is not null then
  insert into platform_private.tenant_secrets(tenant_id,envelope) values(v_tenant.id,p_secrets)
  on conflict(tenant_id) do update set envelope=excluded.envelope,updated_at=clock_timestamp();
 end if;
 insert into platform_private.audit_events(actor,tenant_id,action,detail)
 values(p_actor,v_tenant.id,'MERCHANT_LINE_UPDATED',
  jsonb_build_object('version',v_tenant.version,'credentialsReplaced',p_secrets is not null));
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
 values(p_request_id,p_actor,'my_line',p_payload_hash,to_jsonb(v_tenant));
 return to_jsonb(v_tenant);
end $$;

revoke all on function public.platform_my_application(text),
 public.platform_submit_application(text,text,text),
 public.platform_list_applications(text),
 public.platform_approve_application(text,uuid,jsonb,uuid),
 public.platform_save_my_line(text,integer,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.platform_my_application(text),
 public.platform_submit_application(text,text,text),
 public.platform_list_applications(text),
 public.platform_approve_application(text,uuid,jsonb,uuid),
 public.platform_save_my_line(text,integer,uuid,text,jsonb,jsonb) to service_role;
commit;
