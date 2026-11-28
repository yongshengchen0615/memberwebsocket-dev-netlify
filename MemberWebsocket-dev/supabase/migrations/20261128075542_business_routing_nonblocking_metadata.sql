-- Routing metadata is read before identity verification. It does not authorize
-- a mutation. The historical price migration injected an exclusive lock on
-- every tenant's prices here, making unrelated requests wait for price writes.
-- Restore the original metadata query; retain all transaction/pre-request,
-- price publication and authority-revocation locks in their owning functions.
-- CREATE OR REPLACE preserves this existing RPC's service-role-only ACL.
create or replace function public.platform_business_context_v2(p_actor text default null,p_slug text default null)
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
notify pgrst,'reload schema';
