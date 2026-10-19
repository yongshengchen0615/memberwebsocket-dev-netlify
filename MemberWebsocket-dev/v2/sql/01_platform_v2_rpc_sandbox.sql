-- V2 only. Requires the fresh isolated P1 platform schema (see supabase/plans).
-- This script is NOT an upgrade for the legacy member database.
-- The project owner must approve a NEW Platform Supabase environment first.
-- No root operator is inserted/updated. No legacy data is deleted.
begin;

create table platform_private.tenant_feature_secrets(
  tenant_id uuid not null references platform_private.tenants(id) on delete restrict,
  feature text not null check(feature in ('membership','points','events','calendar','integrations','booking','testing','usage')),
  envelope jsonb not null check(coalesce(
    jsonb_typeof(envelope)='object' and envelope->>'version'='1'
    and char_length(envelope->>'iv')=16 and char_length(envelope->>'data')>40,false)),
  key_version integer not null default 1 check(key_version>0),
  updated_at timestamptz not null default now(),
  primary key(tenant_id,feature)
);
alter table platform_private.tenant_feature_secrets enable row level security;
revoke all on platform_private.tenant_feature_secrets from public,anon,authenticated;
grant select,insert,update on platform_private.tenant_feature_secrets to service_role;

create table platform_private.v2_rate_limits(
  actor_hash text primary key check(actor_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null default now(),
  count integer not null default 0 check(count>=0)
);
alter table platform_private.v2_rate_limits enable row level security;
revoke all on platform_private.v2_rate_limits from public,anon,authenticated;
grant select,insert,update on platform_private.v2_rate_limits to service_role;

create function public.v2_is_root(p_actor text) returns boolean
language sql stable security invoker set search_path='' as $$
  select exists(select 1 from platform_private.platform_operators op
    where op.role='super_admin' and op.enabled=true and op.line_user_id=p_actor)
$$;

create function public.v2_tenant_json(p_id uuid,p_for_merchant boolean)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'id',t.id,'name',t.name,'slug',t.slug,'features',t.features,
    'line',case when p_for_merchant then t.line_config else '{}'::jsonb end,
    'status',t.status,'version',t.version,'credentialsConfigured',t.credentials_configured)
  from platform_private.tenants t where t.id=p_id
$$;

create function public.v2_merchant_bootstrap(p_actor text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'scope','merchant',
    'application',(
      select jsonb_build_object('id',a.id,'businessName',a.business_name,'slug',a.slug,
        'status',a.status,'tenantId',a.tenant_id)
      from platform_private.applications a where a.applicant_line_user_id=p_actor),
    'tenant',(
      select public.v2_tenant_json(a.tenant_id,true)
      from platform_private.applications a where a.applicant_line_user_id=p_actor and a.status='approved')
  )
$$;

create function public.v2_root_bootstrap(p_actor text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
begin
  if not public.v2_is_root(p_actor) then raise exception 'V2_ROOT_REQUIRED'; end if;
  return jsonb_build_object(
    'scope','platform',
    'applications',coalesce((select jsonb_agg(jsonb_build_object(
       'id',a.id,'businessName',a.business_name,'slug',a.slug,'status',a.status,
       'tenantId',a.tenant_id,'createdAt',a.created_at) order by a.created_at desc)
       from platform_private.applications a),'[]'::jsonb),
    'tenants',coalesce((select jsonb_agg(public.v2_tenant_json(t.id,false) order by t.created_at desc)
       from platform_private.tenants t),'[]'::jsonb)
  );
end $$;

create function public.v2_ensure_application(p_actor text,p_name text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_name text;
begin
  if p_actor !~ '^U[0-9a-f]{32}$' then raise exception 'V2_AUTH_REQUIRED'; end if;
  v_name:=left(coalesce(nullif(btrim(p_name),''),'LINE 管理員'),100);
  perform pg_advisory_xact_lock(hashtextextended('v2-app:'||p_actor,0));
  if not exists(select 1 from platform_private.applications where applicant_line_user_id=p_actor) then
    insert into platform_private.applications(applicant_line_user_id,business_name,slug)
      values(p_actor,v_name,'merchant-'||substring(replace(gen_random_uuid()::text,'-','') from 1 for 16));
    insert into platform_private.audit_events(actor,action,result,detail)
      values(p_actor,'APPLICATION_CREATED','success','{}'::jsonb);
  end if;
  return public.v2_merchant_bootstrap(p_actor);
end $$;

create function public.v2_apply(p_actor text,p_name text,p_slug text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_app platform_private.applications;
begin
  if p_actor !~ '^U[0-9a-f]{32}$' or nullif(btrim(p_name),'') is null
    or char_length(btrim(p_name))>100 or p_slug !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    or char_length(p_slug) not between 3 and 40
    or p_slug in ('admin','platform','api','root','system','www')
    then raise exception 'V2_INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('v2-app:'||p_actor,0));
  select * into v_app from platform_private.applications where applicant_line_user_id=p_actor for update;
  if found and v_app.status='approved' then raise exception 'V2_ALREADY_APPROVED'; end if;
  if found then
    update platform_private.applications
       set business_name=btrim(p_name),slug=p_slug,status='pending',
           reviewed_at=null,reviewed_by=null,updated_at=now()
       where id=v_app.id;
  else
    insert into platform_private.applications(applicant_line_user_id,business_name,slug)
      values(p_actor,btrim(p_name),p_slug);
  end if;
  insert into platform_private.audit_events(actor,action,result,detail)
    values(p_actor,'APPLICATION_SUBMITTED','success','{}'::jsonb);
  return public.v2_merchant_bootstrap(p_actor);
end $$;

create function public.v2_approve(p_actor text,p_app_id uuid,p_features jsonb,p_req uuid,p_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_app platform_private.applications; v_prev platform_private.requests; v_tenant uuid; v_response jsonb;
begin
  if not public.v2_is_root(p_actor) then raise exception 'V2_ROOT_REQUIRED'; end if;
  if p_req is null or p_app_id is null or p_hash !~ '^[a-f0-9]{64}$'
    or not coalesce(platform_private.features_valid(p_features),false)
    then raise exception 'V2_INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_req::text,0));
  select * into v_prev from platform_private.requests where request_id=p_req;
  if found then
    if v_prev.actor<>p_actor or v_prev.operation<>'v2-approve' or v_prev.payload_hash<>p_hash
      then raise exception 'V2_REQUEST_CONFLICT'; end if;
    return v_prev.result;
  end if;
  select * into v_app from platform_private.applications where id=p_app_id for update;
  if not found then raise exception 'V2_NOT_FOUND'; end if;
  if v_app.status<>'pending' then raise exception 'V2_ALREADY_REVIEWED'; end if;
  v_tenant:=gen_random_uuid();
  insert into platform_private.tenants(id,name,slug,owner_line_user_id,features,
        created_by,updated_by)
    values(v_tenant,v_app.business_name,v_app.slug,v_app.applicant_line_user_id,
        p_features,p_actor,p_actor);
  update platform_private.applications
      set status='approved',tenant_id=v_tenant,reviewed_by=p_actor,
          reviewed_at=now(),updated_at=now()
    where id=p_app_id;
  insert into platform_private.provisioning_jobs(tenant_id,idempotency_key,operation)
    values(v_tenant,p_req,'create_project');
  -- This job remains queued until a separately authorized, cost-gated worker runs.
  v_response:=public.v2_tenant_json(v_tenant,false);
  insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
    values(p_req,p_actor,'v2-approve',p_hash,v_response);
  insert into platform_private.audit_events(actor,tenant_id,request_id,action,result,
      detail) values(p_actor,v_tenant,p_req,'APPLICATION_APPROVED','success',
      jsonb_build_object('features',p_features));
  return v_response;
end $$;

create function public.v2_update_features(
 p_actor text,p_tenant uuid,p_version integer,p_features jsonb,p_req uuid,p_hash text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_prev platform_private.requests;v_record platform_private.tenants;v_response jsonb;
begin
  if not public.v2_is_root(p_actor) then raise exception 'V2_ROOT_REQUIRED'; end if;
  if p_req is null or p_tenant is null or p_version is null or p_version<1
    or p_hash !~ '^[a-f0-9]{64}$'
    or not coalesce(platform_private.features_valid(p_features),false)
    then raise exception 'V2_INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_req::text,0));
  select * into v_prev from platform_private.requests where request_id=p_req;
  if found then
    if v_prev.actor<>p_actor or v_prev.operation<>'v2-features' or v_prev.payload_hash<>p_hash
      then raise exception 'V2_REQUEST_CONFLICT'; end if;
    return v_prev.result;
  end if;
  select * into v_record from platform_private.tenants where id=p_tenant for update;
  if not found then raise exception 'V2_NOT_FOUND'; end if;
  if v_record.version<>p_version then raise exception 'V2_VERSION_CONFLICT'; end if;
  update platform_private.tenants
    set features=p_features,version=version+1,updated_by=p_actor,updated_at=now()
    where id=p_tenant;
  v_response:=public.v2_tenant_json(p_tenant,false);
  insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
     values(p_req,p_actor,'v2-features',p_hash,v_response);
  insert into platform_private.audit_events(actor,tenant_id,request_id,action,result,detail)
     values(p_actor,p_tenant,p_req,'TENANT_FEATURES_UPDATED','success',
       jsonb_build_object('previous',v_record.features,'features',p_features));
  return v_response;
end $$;

create function public.v2_save_line(
 p_actor text,p_feature text,p_version integer,p_config jsonb,
 p_envelope jsonb,p_req uuid,p_hash text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_app platform_private.applications;v_tenant platform_private.tenants;v_prev platform_private.requests;
 v_response jsonb;v_enabled bigint;v_secret_count bigint;
begin
  if p_req is null or p_version is null or p_version<1
    or p_hash !~ '^[a-f0-9]{64}$'
    or p_feature not in ('membership','points','events','calendar','integrations','booking','testing','usage')
    or jsonb_typeof(p_config)<>'object'
    or (select count(*) from jsonb_object_keys(p_config))<>3
    or not (p_config ?& array['loginChannelId','liffId','messagingChannelId'])
    or (p_config->>'loginChannelId') !~ '^[0-9]{5,30}$'
    or (p_config->>'messagingChannelId') !~ '^[0-9]{5,30}$'
    or (p_config->>'liffId') !~ ('^'||(p_config->>'loginChannelId')||'-[A-Za-z0-9_-]+$')
    then raise exception 'V2_INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_req::text,0));
  select * into v_prev from platform_private.requests where request_id=p_req;
  if found then
    if v_prev.actor<>p_actor or v_prev.operation<>'v2-line' or v_prev.payload_hash<>p_hash
      then raise exception 'V2_REQUEST_CONFLICT'; end if;
    return v_prev.result;
  end if;
  select * into v_app from platform_private.applications
   where applicant_line_user_id=p_actor and status='approved';
  if not found then raise exception 'V2_NOT_APPROVED'; end if;
  select * into v_tenant from platform_private.tenants where id=v_app.tenant_id for update;
  if not found or v_tenant.owner_line_user_id<>p_actor or v_tenant.status='suspended'
     then raise exception 'V2_NOT_APPROVED'; end if;
  if v_tenant.version<>p_version then raise exception 'V2_VERSION_CONFLICT'; end if;
  if v_tenant.features->>p_feature<>'true' then raise exception 'V2_FEATURE_DISABLED'; end if;
  if p_envelope is null and not exists(select 1 from platform_private.tenant_feature_secrets
      where tenant_id=v_tenant.id and feature=p_feature)
    then raise exception 'V2_CREDENTIALS_REQUIRED'; end if;
  if p_envelope is not null then
    insert into platform_private.tenant_feature_secrets(tenant_id,feature,envelope)
      values(v_tenant.id,p_feature,p_envelope)
      on conflict(tenant_id,feature) do update
        set envelope=excluded.envelope,updated_at=now();
  end if;
  select count(*) into v_enabled from jsonb_each_text(v_tenant.features) as f
    where f.value='true';
  select count(*) into v_secret_count from platform_private.tenant_feature_secrets s
    where s.tenant_id=v_tenant.id and v_tenant.features->>s.feature='true';
  update platform_private.tenants
    set line_config=jsonb_set(line_config,array[p_feature],p_config,true),
        credentials_configured=(v_enabled>0 and v_secret_count>=v_enabled),
        version=version+1,updated_at=now(),updated_by=p_actor
    where id=v_tenant.id;
  v_response:=public.v2_tenant_json(v_tenant.id,true);
  insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
    values(p_req,p_actor,'v2-line',p_hash,v_response);
  insert into platform_private.audit_events(actor,tenant_id,request_id,action,result,detail)
    values(p_actor,v_tenant.id,p_req,'TENANT_LINE_CONFIGURED','success',
      jsonb_build_object('feature',p_feature,'secretRotated',p_envelope is not null));
  return v_response;
end $$;

create function public.v2_rate_limit(p_hash text,p_write boolean)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_count integer;v_started timestamptz;v_max integer:=case when p_write then 15 else 60 end;
begin
  if p_hash !~ '^[a-f0-9]{64}$' then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hash,0));
  insert into platform_private.v2_rate_limits(actor_hash,window_started_at,count)
    values(p_hash,now(),0) on conflict(actor_hash) do nothing;
  select count,window_started_at into v_count,v_started from platform_private.v2_rate_limits
    where actor_hash=p_hash for update;
  if v_started < now()-interval '1 minute' then
    update platform_private.v2_rate_limits set window_started_at=now(),count=1
      where actor_hash=p_hash;
    return true;
  end if;
  if v_count>=v_max then return false; end if;
  update platform_private.v2_rate_limits set count=count+1 where actor_hash=p_hash;
  return true;
end $$;

revoke all on function public.v2_is_root(text) from public,anon,authenticated;
revoke all on function public.v2_tenant_json(uuid,boolean) from public,anon,authenticated;
revoke all on function public.v2_merchant_bootstrap(text) from public,anon,authenticated;
revoke all on function public.v2_root_bootstrap(text) from public,anon,authenticated;
revoke all on function public.v2_ensure_application(text,text) from public,anon,authenticated;
revoke all on function public.v2_apply(text,text,text) from public,anon,authenticated;
revoke all on function public.v2_approve(text,uuid,jsonb,uuid,text) from public,anon,authenticated;
revoke all on function public.v2_update_features(text,uuid,integer,jsonb,uuid,text) from public,anon,authenticated;
revoke all on function public.v2_save_line(text,text,integer,jsonb,jsonb,uuid,text) from public,anon,authenticated;
revoke all on function public.v2_rate_limit(text,boolean) from public,anon,authenticated;

grant execute on function public.v2_is_root(text),public.v2_tenant_json(uuid,boolean),
 public.v2_merchant_bootstrap(text),public.v2_root_bootstrap(text),
 public.v2_ensure_application(text,text),public.v2_apply(text,text,text),
 public.v2_approve(text,uuid,jsonb,uuid,text),
 public.v2_update_features(text,uuid,integer,jsonb,uuid,text),
 public.v2_save_line(text,text,integer,jsonb,jsonb,uuid,text),
 public.v2_rate_limit(text,boolean) to service_role;

-- platform_operators remains SELECT-ONLY for service_role.
-- Explicit human DB operator grant is the only way to enable a root.
commit;
