-- Control plane only. This migration never exposes legacy business data to a new tenant.
begin;

create schema platform_private;
revoke all on schema platform_private from public, anon, authenticated;
grant usage on schema platform_private to service_role;

create table platform_private.super_admins (
  singleton boolean primary key default true check (singleton),
  admin_id uuid not null unique references public.admins(id) on delete restrict,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create function public.platform_features_valid(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p) = 'object'
    and p ?& array['membership','points','events','calendar','integrations','booking','testing','usage']
    and (select count(*) from jsonb_object_keys(p)) = 8
    and not exists (select 1 from jsonb_each(p) where jsonb_typeof(value) <> 'boolean'), false)
$$;

create table platform_private.tenants (
  id uuid primary key,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  slug text not null unique check (char_length(slug) between 3 and 40 and slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    and slug not in ('admin','platform','api','www','root','system')),
  owner_line_user_id text not null check (owner_line_user_id ~ '^U[0-9a-f]{32}$'),
  features jsonb not null check (public.platform_features_valid(features)),
  line_config jsonb not null check (jsonb_typeof(line_config) = 'object'),
  status text not null default 'pending_provisioning' check (status in ('pending_provisioning','suspended','active')),
  isolation_verified_at timestamptz,
  isolation_version text,
  credentials_configured boolean not null default false,
  version integer not null default 1 check (version > 0),
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Activation needs a separately verified data plane. Metadata CRUD cannot set these fields.
  constraint platform_tenants_isolation_gate check (status <> 'active' or
    (isolation_verified_at is not null and nullif(isolation_version, '') is not null and credentials_configured))
);
create table platform_private.tenant_secrets (
  tenant_id uuid primary key references platform_private.tenants(id) on delete restrict,
  envelope jsonb not null check (coalesce(jsonb_typeof(envelope) = 'object' and envelope->>'version' = '1'
    and char_length(envelope->>'iv') = 16 and char_length(envelope->>'data') > 40, false)),
  updated_at timestamptz not null default now()
);
create table platform_private.requests (
  request_id uuid primary key,
  actor text not null,
  operation text not null,
  payload_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
create table platform_private.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor text not null,
  tenant_id uuid references platform_private.tenants(id) on delete restrict,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index platform_tenants_updated_idx on platform_private.tenants(updated_at desc, id);
create index platform_audit_tenant_created_idx on platform_private.audit_events(tenant_id, created_at desc);

alter table platform_private.super_admins enable row level security;
alter table platform_private.tenants enable row level security;
alter table platform_private.tenant_secrets enable row level security;
alter table platform_private.requests enable row level security;
alter table platform_private.audit_events enable row level security;
revoke all on platform_private.super_admins, platform_private.tenants, platform_private.tenant_secrets,
  platform_private.requests, platform_private.audit_events from public, anon, authenticated;
grant select, insert, update on platform_private.super_admins, platform_private.tenants, platform_private.tenant_secrets,
  platform_private.requests, platform_private.audit_events to service_role;

create function public.platform_is_super_admin(p_actor text) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from platform_private.super_admins s join public.admins a on a.id=s.admin_id
    where s.enabled and a.line_user_id=p_actor and a.role='admin' and a.status='active')
$$;

create function public.platform_list_tenants(p_actor text) returns setof jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  if not public.platform_is_super_admin(p_actor) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  return query select to_jsonb(t) from platform_private.tenants t order by t.updated_at desc, t.id;
end $$;

create function public.platform_save_tenant(
  p_actor text, p_request_id uuid, p_payload_hash text, p_tenant_id uuid,
  p_expected_version integer, p_tenant jsonb, p_secrets jsonb default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_row platform_private.tenants; v_previous platform_private.tenants; v_request platform_private.requests;
begin
  if not public.platform_is_super_admin(p_actor) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if p_request_id is null or p_tenant_id is null or p_expected_version is null or p_expected_version < 0
    or p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$'
    or p_tenant is null or jsonb_typeof(p_tenant) <> 'object'
    or (select count(*) from jsonb_object_keys(p_tenant)) <> 5
    or not (p_tenant ?& array['name','slug','ownerLineUserId','features','line'])
    or not public.platform_features_valid(p_tenant->'features') then raise exception 'PLATFORM_INVALID_INPUT'; end if;
  -- Serialize retries by request id before inspecting the optimistic row version.
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  select * into v_request from platform_private.requests where request_id=p_request_id;
  if found then
    if v_request.actor<>p_actor or v_request.operation<>'save' or v_request.payload_hash<>p_payload_hash
      then raise exception 'PLATFORM_REQUEST_CONFLICT'; end if;
    return v_request.result;
  end if;
  if p_expected_version=0 then
    if p_secrets is null then raise exception 'PLATFORM_INVALID_INPUT'; end if;
    begin
      insert into platform_private.tenants(id,name,slug,owner_line_user_id,features,line_config,credentials_configured,created_by,updated_by)
      values(p_tenant_id,p_tenant->>'name',p_tenant->>'slug',p_tenant->>'ownerLineUserId',p_tenant->'features',p_tenant->'line',true,p_actor,p_actor)
      returning * into v_row;
    exception when unique_violation then raise exception 'PLATFORM_DUPLICATE_SLUG'; end;
  else
    select * into v_previous from platform_private.tenants where id=p_tenant_id for update;
    if not found then raise exception 'PLATFORM_TENANT_NOT_FOUND'; end if;
    if v_previous.version<>p_expected_version then raise exception 'PLATFORM_CONFLICT'; end if;
    if v_previous.slug<>p_tenant->>'slug' or v_previous.owner_line_user_id<>p_tenant->>'ownerLineUserId'
      then raise exception 'PLATFORM_IMMUTABLE_IDENTITY'; end if;
    update platform_private.tenants set name=p_tenant->>'name',features=p_tenant->'features',line_config=p_tenant->'line',
      version=version+1,updated_by=p_actor,updated_at=clock_timestamp()
    where id=p_tenant_id returning * into v_row;
  end if;
  if p_secrets is not null then
    insert into platform_private.tenant_secrets(tenant_id,envelope) values(p_tenant_id,p_secrets)
    on conflict(tenant_id) do update set envelope=excluded.envelope,updated_at=clock_timestamp();
  end if;
  -- Only operational metadata enters audit/history. Neither ciphertext nor raw credentials are copied here.
  insert into platform_private.audit_events(actor,tenant_id,action,detail)
  values(p_actor,p_tenant_id,case when p_expected_version=0 then 'TENANT_CREATED' else 'TENANT_UPDATED' end,
    jsonb_build_object('version',v_row.version,'features',v_row.features,'previousFeatures',v_previous.features,'credentialsReplaced',p_secrets is not null));
  insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
  values(p_request_id,p_actor,'save',p_payload_hash,to_jsonb(v_row));
  return to_jsonb(v_row);
end $$;

create function public.platform_suspend_tenant(p_actor text, p_tenant_id uuid, p_expected_version integer, p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_row platform_private.tenants; v_request platform_private.requests; v_hash text;
begin
  if not public.platform_is_super_admin(p_actor) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
  if p_request_id is null or p_tenant_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'PLATFORM_INVALID_INPUT'; end if;
  v_hash:=p_tenant_id::text||':'||p_expected_version::text;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
  select * into v_request from platform_private.requests where request_id=p_request_id;
  if found then
    if v_request.actor<>p_actor or v_request.operation<>'suspend' or v_request.payload_hash<>v_hash then raise exception 'PLATFORM_REQUEST_CONFLICT'; end if;
    return v_request.result;
  end if;
  select * into v_row from platform_private.tenants where id=p_tenant_id for update;
  if not found then raise exception 'PLATFORM_TENANT_NOT_FOUND'; end if;
  if v_row.version<>p_expected_version then raise exception 'PLATFORM_CONFLICT'; end if;
  update platform_private.tenants set status='suspended',version=version+1,updated_by=p_actor,updated_at=clock_timestamp()
  where id=p_tenant_id returning * into v_row;
  insert into platform_private.audit_events(actor,tenant_id,action,detail) values(p_actor,p_tenant_id,'TENANT_SUSPENDED',jsonb_build_object('version',v_row.version));
  insert into platform_private.requests(request_id,actor,operation,payload_hash,result) values(p_request_id,p_actor,'suspend',v_hash,to_jsonb(v_row));
  return to_jsonb(v_row);
end $$;

-- SQL functions inherit EXECUTE for PUBLIC unless explicitly revoked.
revoke all on function public.platform_features_valid(jsonb) from public,anon,authenticated;
revoke all on function public.platform_is_super_admin(text) from public,anon,authenticated;
revoke all on function public.platform_list_tenants(text) from public,anon,authenticated;
revoke all on function public.platform_save_tenant(text,uuid,text,uuid,integer,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.platform_suspend_tenant(text,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.platform_features_valid(jsonb),public.platform_is_super_admin(text),public.platform_list_tenants(text),
  public.platform_save_tenant(text,uuid,text,uuid,integer,jsonb,jsonb),public.platform_suspend_tenant(text,uuid,integer,uuid) to service_role;

-- Preserve the only existing active system owner. Ambiguous installations deliberately get no root.
insert into platform_private.super_admins(admin_id)
select id from public.admins where role='admin' and status='active'
  and (select count(*) from public.admins where role='admin' and status='active')=1;

commit;
