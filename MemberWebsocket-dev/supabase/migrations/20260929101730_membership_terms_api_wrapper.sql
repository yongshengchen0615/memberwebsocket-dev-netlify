-- Stable single-payload PostgREST entrypoint for membership consent and signup.
-- The canonical transaction and validation remain in public.accept_membership_terms.
create or replace function public.accept_membership_terms_api(p_payload jsonb)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_line_user_id text;
  v_terms_id uuid;
  v_version text;
  v_accepted boolean;
  v_birthday date;
  v_phone text;
  v_surname text;
  v_salutation text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'INVALID_PROFILE';
  end if;

  v_line_user_id := nullif(btrim(p_payload->>'lineUserId'), '');
  v_version := nullif(btrim(p_payload->>'termsVersion'), '');
  v_accepted := coalesce((p_payload->>'accepted')::boolean, false);

  begin
    v_terms_id := nullif(p_payload->>'termsId', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'TERMS_VERSION_STALE';
  end;

  if v_line_user_id is null or v_terms_id is null or v_version is null then
    raise exception 'TERMS_VERSION_STALE';
  end if;

  if nullif(p_payload->>'birthday', '') is not null then
    begin
      v_birthday := (p_payload->>'birthday')::date;
    exception when others then
      raise exception 'INVALID_PROFILE';
    end;
  end if;

  v_phone := nullif(p_payload->>'phone', '');
  v_surname := nullif(btrim(p_payload->>'surname'), '');
  v_salutation := nullif(lower(btrim(p_payload->>'salutation')), '');

  return public.accept_membership_terms(
    v_line_user_id,
    v_terms_id,
    v_version,
    v_accepted,
    v_birthday,
    v_phone,
    v_surname,
    v_salutation
  );
end;
$$;

revoke all on function public.accept_membership_terms_api(jsonb) from public, anon, authenticated;
grant execute on function public.accept_membership_terms_api(jsonb) to service_role;

comment on function public.accept_membership_terms_api(jsonb) is
  'Stable single-payload PostgREST wrapper for membership consent and registration.';

notify pgrst, 'reload schema';
