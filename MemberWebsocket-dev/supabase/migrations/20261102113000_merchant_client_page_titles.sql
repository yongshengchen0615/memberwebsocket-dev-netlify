-- A tenant-scoped display title. NULL means the established business name.
-- No existing merchant name, LINE credential or customer data is rewritten.
alter table platform_private.tenants
  add column if not exists site_title text;

alter table platform_private.tenants
  add constraint tenants_site_title_valid
  check (
    site_title is null or (
      site_title = btrim(site_title)
      and char_length(site_title) between 1 and 60
      and site_title !~ '[[:cntrl:]]'
    )
  );

create function public.platform_save_title_for_merchant(
  p_actor text,
  p_tenant_id uuid,
  p_issued_at timestamptz,
  p_expected_version integer,
  p_request_id uuid,
  p_payload_hash text,
  p_title text
) returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_tenant platform_private.tenants;
  v_previous platform_private.requests;
  v_hash text;
begin
  if p_actor is null or p_tenant_id is null or p_request_id is null
    or p_expected_version is null or p_expected_version < 1
    or p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$'
    or (p_title is not null and
       (p_title <> btrim(p_title) or char_length(p_title) not between 1 and 60
        or p_title ~ '[[:cntrl:]]'))
  then raise exception 'PLATFORM_INVALID_INPUT'; end if;

  -- The authenticated LINE actor is supplied only by the trusted Edge handler.
  -- This predicate locks the tenant and rejects revoked credentials, expired
  -- accounts, unapproved merchants and other businesses before any write.
  v_tenant := platform_private.require_merchant_access(p_actor, p_tenant_id, p_issued_at);
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  v_hash := encode(sha256(convert_to(p_tenant_id::text || ':' || p_payload_hash, 'UTF8')), 'hex');

  select * into v_previous from platform_private.requests
    where request_id = p_request_id;
  if found then
    if v_previous.actor <> p_actor or v_previous.operation <> 'merchant_title'
      or v_previous.payload_hash <> v_hash
    then raise exception 'PLATFORM_REQUEST_CONFLICT'; end if;
    return (select to_jsonb(t) from platform_private.tenants t where t.id = p_tenant_id);
  end if;

  if v_tenant.version <> p_expected_version then
    raise exception 'PLATFORM_CONFLICT';
  end if;

  update platform_private.tenants
    set site_title = p_title, version = version + 1,
        updated_by = p_actor, updated_at = clock_timestamp()
    where id = p_tenant_id
    returning * into v_tenant;

  insert into platform_private.audit_events(actor, tenant_id, action, detail)
    values(p_actor, p_tenant_id, 'MERCHANT_SITE_TITLE_UPDATED',
           jsonb_build_object('version', v_tenant.version, 'titleCustomized', p_title is not null));

  insert into platform_private.requests(request_id, actor, operation, payload_hash, result)
    values(p_request_id, p_actor, 'merchant_title', v_hash, to_jsonb(v_tenant));
  return to_jsonb(v_tenant);
end
$function$;

-- Only the server service role may call the RPC. Never trust client-supplied actor IDs.
revoke all on function public.platform_save_title_for_merchant(
  text, uuid, timestamptz, integer, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.platform_save_title_for_merchant(
  text, uuid, timestamptz, integer, uuid, text, text
) to service_role;
