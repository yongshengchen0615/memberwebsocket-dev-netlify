-- Record the display name returned by a verified LINE login.
-- Names are presentation metadata, never an authorization principal.
begin;

alter table platform_private.applications
  add column applicant_display_name text
  check (applicant_display_name is null
    or char_length(btrim(applicant_display_name)) between 1 and 100);

-- The Edge Function supplies p_actor from LINE verification, never client JSON.
-- Keep this privileged RPC inaccessible to anonymous/authenticated Data API roles.
create function public.platform_record_applicant_name(p_actor text,p_display_name text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  if p_actor is null or p_actor !~ '^U[0-9a-f]{32}$'
    or p_display_name is null
    or char_length(btrim(p_display_name)) not between 1 and 100
  then raise exception 'PLATFORM_INVALID_INPUT'; end if;

  update platform_private.applications
     set applicant_display_name=btrim(p_display_name)
   where applicant_line_user_id=p_actor
     and applicant_display_name is distinct from btrim(p_display_name);
  return found;
end $$;

-- Only the verified super-admin may read merchant owner names.
-- Legacy admin profiles are a fallback, not an identity/permission source.
create function public.platform_list_applicant_names(p_actor text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if not public.platform_is_super_admin(p_actor)
  then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;

  with identities as (
    select applicant_line_user_id as line_user_id from platform_private.applications
    union
    select owner_line_user_id from platform_private.tenants
  ), names as (
    select identities.line_user_id,
      coalesce(nullif(btrim(app.applicant_display_name),''),
               nullif(btrim(ad.display_name),'')) as display_name
    from identities
    left join platform_private.applications app
      on app.applicant_line_user_id=identities.line_user_id
    left join public.admins ad
      on ad.line_user_id=identities.line_user_id
  )
  select coalesce(jsonb_object_agg(line_user_id,display_name)
      filter (where display_name is not null),'{}'::jsonb)
    into result from names;
  return result;
end $$;

revoke all on function public.platform_record_applicant_name(text,text),
  public.platform_list_applicant_names(text) from public,anon,authenticated;
grant execute on function public.platform_record_applicant_name(text,text),
  public.platform_list_applicant_names(text) to service_role;

commit;
