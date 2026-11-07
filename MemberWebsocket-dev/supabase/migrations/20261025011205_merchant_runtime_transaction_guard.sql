-- #97: authorize each scoped admin PostgREST statement in its own transaction.
-- No identity is accepted from a browser; Edge creates these headers only after
-- LINE verification and PostgREST must already be impersonating service_role.
begin;

create function public.platform_business_pre_request() returns void
language plpgsql security invoker set search_path='' as $$
declare
 headers jsonb:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}'::jsonb);
 actor text;tenant_id uuid;issued_at timestamptz;profile text;
 q platform_private.admin_qualifications;t platform_private.tenants;
 readonly boolean:=current_setting('transaction_read_only')='on';
begin
 if not (headers ?| array['x-platform-admin-actor','x-platform-admin-tenant','x-platform-admin-issued-at']) then return;end if;
 if current_user<>'service_role' then raise sqlstate 'PT403' using message='PLATFORM_RUNTIME_CONTEXT_INVALID';end if;
 actor:=headers->>'x-platform-admin-actor';
 profile:=coalesce(headers->>'content-profile',headers->>'accept-profile');
 if actor is null or actor !~ '^U[0-9a-f]{32}$' or profile is null
  or profile !~ '^business_[a-f0-9]{32}$' then
  raise sqlstate 'PT403' using message='PLATFORM_RUNTIME_CONTEXT_INVALID';
 end if;
 begin
  tenant_id:=(headers->>'x-platform-admin-tenant')::uuid;
  issued_at:=(headers->>'x-platform-admin-issued-at')::timestamptz;
 exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
  raise sqlstate 'PT403' using message='PLATFORM_RUNTIME_CONTEXT_INVALID';
 end;
 if tenant_id is null then raise sqlstate 'PT403' using message='PLATFORM_RUNTIME_CONTEXT_INVALID';end if;
 -- GET/HEAD and STABLE RPCs use read-only transactions, which cannot lock rows.
 -- Writes lock both authority rows through the actual table/RPC commit; revoke
 -- either commits first and denies this write, or waits for this write to finish.
 if readonly then
  select * into q from platform_private.admin_qualifications where applicant_line_user_id=actor;
 else
  select * into q from platform_private.admin_qualifications where applicant_line_user_id=actor for share;
 end if;
 if not found or q.status<>'approved' then raise sqlstate 'PT403' using message='PLATFORM_QUALIFICATION_REQUIRED';end if;
 if readonly then
  select * into t from platform_private.tenants where id=tenant_id and owner_line_user_id=actor;
 else
  select * into t from platform_private.tenants where id=tenant_id and owner_line_user_id=actor for share;
 end if;
 if not found or t.runtime_schema is distinct from profile or t.status<>'active' then
  raise sqlstate 'PT403' using message='PLATFORM_TENANT_NOT_FOUND';
 end if;
 if issued_at is null or not isfinite(issued_at) or issued_at>clock_timestamp()+interval '60 seconds'
  or issued_at<=greatest(q.access_revoked_before,t.access_revoked_before) then
  raise sqlstate 'PT401' using message='TENANT_REAUTH_REQUIRED';
 end if;
 if t.expires_at<=clock_timestamp() then raise sqlstate 'PT403' using message='TENANT_EXPIRED';end if;
 if not exists(select 1 from platform_private.applications a where a.tenant_id=t.id and a.applicant_line_user_id=actor and a.status='approved')
  then raise sqlstate 'PT403' using message='PLATFORM_APPLICATION_NOT_APPROVED';end if;
end $$;

-- PostgREST invokes the hook for every role. Unmarked requests do nothing;
-- marked browser requests reject before accessing any private object.
revoke all on function public.platform_business_pre_request() from public;
grant execute on function public.platform_business_pre_request() to anon,authenticated,service_role;
do $$ declare setting text;begin
 select v into setting from pg_roles r cross join lateral unnest(r.rolconfig) v
  where r.rolname='authenticator' and v like 'pgrst.db_pre_request=%';
 if setting is not null and setting not in ('pgrst.db_pre_request=','pgrst.db_pre_request=public.platform_business_pre_request')
  then raise exception 'MERCHANT_RUNTIME_PRE_REQUEST_CONFLICT';end if;
end $$;
alter role authenticator set pgrst.db_pre_request='public.platform_business_pre_request';
notify pgrst,'reload config';
notify pgrst,'reload schema';
commit;
