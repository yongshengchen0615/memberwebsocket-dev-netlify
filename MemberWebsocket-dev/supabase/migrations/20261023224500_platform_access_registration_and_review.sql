-- #82 follow-up: a verified LINE visit to /platform must persist a pending
-- platform-access identity; never grant privileges as a side effect of login.
-- The original singleton super-admin remains the non-self-approvable owner.
begin;

create table platform_private.platform_access_requests (
  line_user_id text primary key check (line_user_id ~ '^U[0-9a-f]{32}$'),
  display_name text not null check (char_length(display_name) between 1 and 120),
  access_enabled boolean not null default false,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  reviewed_by text,
  constraint platform_access_review_consistency check (
    (reviewed_at is null) = (reviewed_by is null)
  )
);
create index platform_access_requests_seen_idx
  on platform_private.platform_access_requests(last_seen_at desc);
alter table platform_private.platform_access_requests enable row level security;
revoke all on platform_private.platform_access_requests
  from public, anon, authenticated;
grant select, insert, update on platform_private.platform_access_requests
  to service_role;

-- Only the manually bootstrapped owner may grant/revoke other platform users.
create or replace function public.platform_is_root_super_admin(p_actor text)
returns boolean language sql stable security invoker set search_path=''
as $$
  select exists (
    select 1 from platform_private.super_admins s
    join public.admins a on a.id=s.admin_id
    where s.enabled=true and s.line_user_id=p_actor
      and a.line_user_id=p_actor
      and a.role='admin' and a.status='active'
  )
$$;

-- Called by platform-api ONLY AFTER the dedicated platform LINE token is
-- verified. Display name comes from trusted LINE verification, never request.
create or replace function public.platform_record_access_request(
  p_actor text, p_display_name text
) returns jsonb language plpgsql security invoker set search_path=''
as $$
declare v_record platform_private.platform_access_requests%rowtype;
begin
  if p_actor is null or p_actor !~ '^U[0-9a-f]{32}$'
    or p_display_name is null
    or char_length(btrim(p_display_name)) not between 1 and 120 then
    raise exception 'PLATFORM_INVALID_ACCESS_IDENTITY';
  end if;
  insert into platform_private.platform_access_requests(
    line_user_id,display_name
  ) values(p_actor,btrim(p_display_name))
  on conflict (line_user_id)
  do update set display_name=excluded.display_name,
                last_seen_at=clock_timestamp()
  returning * into v_record;
  -- Idempotent sign-in never alters access_enabled or review identity.
  return jsonb_build_object(
    'registered',true,
    'accessEnabled',v_record.access_enabled
  );
end $$;

-- An approved platform operator is not allowed to approve further operators.
-- Existing owner/root grant is unchanged and still requires active admins row.
create or replace function public.platform_is_super_admin(p_actor text)
returns boolean language sql stable security invoker set search_path=''
as $$
  select public.platform_is_root_super_admin(p_actor)
    or exists(
      select 1 from platform_private.platform_access_requests r
      where r.line_user_id=p_actor and r.access_enabled=true
    )
$$;

create or replace function public.platform_list_access_requests(p_actor text)
returns setof jsonb language plpgsql stable security invoker set search_path=''
as $$
begin
  if not public.platform_is_root_super_admin(p_actor) then
    raise exception 'PLATFORM_ROOT_REQUIRED';
  end if;
  return query
    select jsonb_build_object(
      'lineUserId',r.line_user_id,
      'displayName',r.display_name,
      'allowed',r.access_enabled,
      'firstSeenAt',r.first_seen_at,
      'lastSeenAt',r.last_seen_at,
      'reviewedAt',r.reviewed_at,
      'reviewedBy',r.reviewed_by
    )
    from platform_private.platform_access_requests r
    where not exists(
      select 1 from platform_private.super_admins s
      where s.enabled and s.line_user_id=r.line_user_id
    )
    order by r.access_enabled asc,r.first_seen_at asc,r.line_user_id;
end $$;

create or replace function public.platform_review_access_request(
  p_actor text,p_target text,p_allow boolean
) returns jsonb language plpgsql security invoker set search_path=''
as $$
declare v_row platform_private.platform_access_requests%rowtype;
begin
  if not public.platform_is_root_super_admin(p_actor) then
    raise exception 'PLATFORM_ROOT_REQUIRED';
  end if;
  if p_target is null or p_target !~ '^U[0-9a-f]{32}$'
    or p_allow is null then
    raise exception 'PLATFORM_INVALID_ACCESS_REVIEW';
  end if;
  if p_target=p_actor or exists(
    select 1 from platform_private.super_admins s
    where s.line_user_id=p_target
  ) then
    raise exception 'PLATFORM_SELF_OR_ROOT_REVIEW_FORBIDDEN';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('platform:review:'||p_target,0));
  update platform_private.platform_access_requests
  set access_enabled=p_allow,reviewed_at=clock_timestamp(),reviewed_by=p_actor
  where line_user_id=p_target
  returning * into v_row;
  if not found then raise exception 'PLATFORM_ACCESS_REQUEST_NOT_FOUND'; end if;
  insert into platform_private.audit_events(actor,action,detail)
  values(p_actor,case when p_allow then 'PLATFORM_OPERATOR_GRANTED'
    else 'PLATFORM_OPERATOR_REVOKED' end,
    jsonb_build_object('targetLineUserId',p_target,'allowed',p_allow));
  return jsonb_build_object('lineUserId',v_row.line_user_id,
    'displayName',v_row.display_name,'allowed',v_row.access_enabled);
end $$;

revoke all on function public.platform_is_root_super_admin(text),
  public.platform_record_access_request(text,text),
  public.platform_list_access_requests(text),
  public.platform_review_access_request(text,text,boolean)
  from public,anon,authenticated;
revoke all on function public.platform_is_super_admin(text)
  from public,anon,authenticated;
grant execute on function public.platform_is_root_super_admin(text),
  public.platform_record_access_request(text,text),
  public.platform_list_access_requests(text),
  public.platform_review_access_request(text,text,boolean),
  public.platform_is_super_admin(text)
  to service_role;
commit;
