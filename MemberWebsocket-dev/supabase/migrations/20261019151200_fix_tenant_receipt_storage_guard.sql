-- #187 follow-up: signed receipt upload metadata is scoped as
-- <tenant UUID>/<member UUID>/<accessible|booking UUID>/<file> for productized
-- businesses. Legacy receipts still use <member UUID>/...
-- Storage's permission probe performs an INSERT into storage.objects. The
-- legacy guard treated the tenant ID as a member ID in public.members and
-- failed with MEMBER_REMOVED even when the business member was active.
--
-- Keep the guard SECURITY DEFINER and fail closed. Tenant schema names are
-- taken only from platform_private.tenants and must match the canonical
-- immutable name derived from that tenant's UUID, never user-supplied text.
create or replace function public.member_receipt_upload_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  first_id uuid;
  owner_id uuid;
  active_owner_id uuid;
  tenant_schema text;
  tenant_status text;
  tenant_expires_at timestamptz;
  is_deleting boolean := false;
  first_path_part text;
begin
  if new.bucket_id <> 'booking-receipts' then return new; end if;
  first_path_part := split_part(new.name, '/', 1);
  if first_path_part !~ '^[a-f0-9-]{36}$' then
    raise exception 'RECEIPT_OWNER_REQUIRED';
  end if;
  first_id := first_path_part::uuid;

  select t.runtime_schema, t.status, t.expires_at
    into tenant_schema, tenant_status, tenant_expires_at
    from platform_private.tenants t where t.id = first_id;
  if found then
    -- The prefix is a real tenant. Never fall back to the legacy member
    -- namespace when a tenant is suspended, expired or misconfigured.
    if tenant_status <> 'active' or
       (tenant_expires_at is not null and tenant_expires_at <= now()) then
      raise exception 'TENANT_NOT_ACTIVE';
    end if;
    if tenant_schema is distinct from
       'business_' || replace(first_id::text, '-', '') then
      raise exception 'TENANT_STORAGE_SCOPE_INVALID';
    end if;
    if split_part(new.name, '/', 2) !~ '^[a-f0-9-]{36}$' or
       split_part(new.name, '/', 3) = '' or
       split_part(new.name, '/', 4) = '' then
      raise exception 'RECEIPT_OWNER_REQUIRED';
    end if;
    owner_id := split_part(new.name, '/', 2)::uuid;
    if to_regclass(format('%I.members', tenant_schema)) is null or
       to_regclass(format('%I.member_removal_jobs', tenant_schema)) is null then
      raise exception 'TENANT_STORAGE_SCOPE_INVALID';
    end if;

    execute format(
      'select m.id from %I.members m where m.id=$1 and m.status=''active'' for key share',
      tenant_schema
    ) into active_owner_id using owner_id;
    execute format(
      'select exists(select 1 from %I.member_removal_jobs j where j.member_id=$1 and j.state=''deleting'')',
      tenant_schema
    ) into is_deleting using owner_id;
  else
    -- Retain strict compatibility for pre-productization receipts.
    owner_id := first_id;
    select m.id into active_owner_id from public.members m
      where m.id=owner_id and m.status='active' for key share;
    select exists(select 1 from public.member_removal_jobs j
      where j.member_id=owner_id and j.state='deleting') into is_deleting;
  end if;

  if active_owner_id is null or coalesce(is_deleting, false) then
    raise exception 'MEMBER_REMOVED';
  end if;
  return new;
end; $$;

-- This routine must only run through the storage.objects trigger. Do not
-- expose a privileged entry point to anon/authenticated clients.
revoke all on function public.member_receipt_upload_guard()
  from public, anon, authenticated;
