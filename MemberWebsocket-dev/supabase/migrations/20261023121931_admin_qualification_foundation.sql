-- #97 phase 1 only: qualification persistence, not an active merchant access gate.
-- Do not deploy independently of the remaining Edge/UI/tenant-context rollout.
begin;
create table platform_private.admin_qualifications (
 id uuid primary key default gen_random_uuid(),
 applicant_line_user_id text not null unique check(applicant_line_user_id ~ '^U[0-9a-f]{32}$'),
 display_name text not null check(char_length(btrim(display_name)) between 1 and 100),
 status text not null default 'pending' check(status in ('pending','approved','rejected','suspended')),
 version integer not null default 1 check(version>0),
 origin text not null default 'explicit' check(origin in ('explicit','legacy_application')),
 reviewed_by text, reviewed_at timestamptz,
 review_reason text check(review_reason is null or char_length(review_reason) between 1 and 500),
 access_revoked_before timestamptz,
 requested_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp()
);
create index admin_qualifications_status_requested_idx
 on platform_private.admin_qualifications(status,requested_at,id);
alter table platform_private.admin_qualifications enable row level security;
revoke all on platform_private.admin_qualifications from public,anon,authenticated;
grant select,insert,update on platform_private.admin_qualifications to service_role;

-- Preserve the meaning of the old review; an admins row or root grant alone
-- does not qualify anyone. No source application, tenant or business row changes.
insert into platform_private.admin_qualifications(applicant_line_user_id,display_name,
 status,origin,reviewed_by,reviewed_at,requested_at,updated_at)
 select applicant_line_user_id,business_name,status,'legacy_application',
 reviewed_by,reviewed_at,created_at,updated_at from platform_private.applications;

create function platform_private.admin_qualification_json(q platform_private.admin_qualifications)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',q.id,'displayName',q.display_name,'status',q.status,
  'version',q.version,'requestedAt',q.requested_at,'updatedAt',q.updated_at,
  'reviewedAt',q.reviewed_at,'reviewReason',q.review_reason,
  'accessRevokedBefore',q.access_revoked_before)
$$;

create function public.platform_my_admin_qualification(p_actor text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 if p_actor is null or p_actor !~ '^U[0-9a-f]{32}$' then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 select platform_private.admin_qualification_json(q) into result
 from platform_private.admin_qualifications q where applicant_line_user_id=p_actor;
 return result;
end $$;

create function public.platform_submit_admin_qualification(p_actor text,p_name text,p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare q platform_private.admin_qualifications; previous platform_private.requests; h text;
begin
 if p_actor is null or p_actor !~ '^U[0-9a-f]{32}$' or p_name is null
  or char_length(btrim(p_name)) not between 1 and 100 or p_request_id is null
 then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 h:=encode(sha256(convert_to(jsonb_build_object('actor',p_actor,'name',btrim(p_name))::text,'UTF8')),'hex');
 -- Request lock comes first in all writers, then the applicant lock/row lock.
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('platform:qualification:'||p_actor,0));
 select * into previous from platform_private.requests where request_id=p_request_id;
 if found then
  if previous.actor<>p_actor or previous.operation<>'qualification_submit' or previous.payload_hash<>h
   then raise exception 'PLATFORM_REQUEST_CONFLICT'; end if;
  -- Never resurrect a historical approved response after a later suspension.
  return public.platform_my_admin_qualification(p_actor);
 end if;
 select * into q from platform_private.admin_qualifications where applicant_line_user_id=p_actor for update;
 if not found then
  insert into platform_private.admin_qualifications(applicant_line_user_id,display_name)
   values(p_actor,btrim(p_name)) returning * into q;
  insert into platform_private.audit_events(actor,action,detail)
   values(p_actor,'ADMIN_QUALIFICATION_SUBMITTED',jsonb_build_object('qualificationId',q.id,'version',q.version));
 elsif q.status='suspended' then raise exception 'PLATFORM_QUALIFICATION_SUSPENDED';
 elsif q.status='rejected' then
  update platform_private.admin_qualifications set display_name=btrim(p_name),status='pending',
   reviewed_by=null,reviewed_at=null,review_reason=null,requested_at=clock_timestamp(),
   updated_at=clock_timestamp(),version=version+1 where id=q.id returning * into q;
  insert into platform_private.audit_events(actor,action,detail)
   values(p_actor,'ADMIN_QUALIFICATION_RESUBMITTED',jsonb_build_object('qualificationId',q.id,'version',q.version));
 end if;
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
  values(p_request_id,p_actor,'qualification_submit',h,platform_private.admin_qualification_json(q));
 return platform_private.admin_qualification_json(q);
end $$;

create function public.platform_list_admin_qualifications(p_actor text) returns setof jsonb
language plpgsql stable security invoker set search_path='' as $$
begin
 if not public.platform_is_super_admin(p_actor) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
 return query select platform_private.admin_qualification_json(q)
  ||jsonb_build_object('applicantLineUserId',q.applicant_line_user_id)
 from platform_private.admin_qualifications q order by q.requested_at,q.id;
end $$;

-- Serialize actual authorization changes with already-authorized reviews.
-- Advisory locks avoid granting UPDATE on public.admins merely to take a row
-- lock. Every relevant INSERT/UPDATE/DELETE uses the same per-actor mutex.
create function platform_private.lock_platform_authorization_change() returns trigger
language plpgsql security invoker set search_path='' as $$
declare identities text[]; actor text; referenced_id uuid;
begin
 identities:=array[case when tg_op<>'INSERT' then old.line_user_id end,
  case when tg_op<>'DELETE' then new.line_user_id end];
 if tg_table_schema='public' then
  referenced_id:=case when tg_op='INSERT' then new.id else old.id end;
  select identities||coalesce(array_agg(s.line_user_id),'{}'::text[]) into identities
   from platform_private.super_admins s where s.admin_id=referenced_id;
 end if;
 for actor in select distinct value from unnest(identities) value where value is not null order by value loop
  perform pg_advisory_xact_lock(hashtextextended('platform:reviewer:'||actor,0));
 end loop;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger platform_review_auth_lock
 before insert or delete or update of line_user_id,role,status,id on public.admins
 for each row execute function platform_private.lock_platform_authorization_change();
create trigger platform_review_auth_lock
 before insert or delete or update of line_user_id,enabled,admin_id,singleton on platform_private.super_admins
 for each row execute function platform_private.lock_platform_authorization_change();

create function platform_private.lock_platform_reviewer(p_actor text) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if p_actor is null or p_actor !~ '^U[0-9a-f]{32}$' then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('platform:reviewer:'||p_actor,0));
 if not public.platform_is_super_admin(p_actor) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
end $$;

create function public.platform_review_admin_qualification(p_actor text,p_qualification_id uuid,
 p_expected_version integer,p_decision text,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare q platform_private.admin_qualifications; previous platform_private.requests; h text; before_status text;
begin
 -- Recheck root even on retries; an old request is not a permission grant.
 if not public.platform_is_super_admin(p_actor) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
 if p_qualification_id is null or p_request_id is null or p_expected_version is null or p_expected_version<1
  or p_decision is null or p_decision not in ('approved','rejected','suspended')
  or p_reason is null or char_length(btrim(p_reason))>500
  or (p_decision in ('rejected','suspended') and char_length(btrim(p_reason))=0)
 then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 h:=encode(sha256(convert_to(jsonb_build_object('id',p_qualification_id,'version',p_expected_version,
  'decision',p_decision,'reason',btrim(p_reason))::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into previous from platform_private.requests where request_id=p_request_id;
 if found then
  if previous.actor<>p_actor or previous.operation<>'qualification_review' or previous.payload_hash<>h
   then raise exception 'PLATFORM_REQUEST_CONFLICT'; end if;
  select * into q from platform_private.admin_qualifications where id=p_qualification_id;
  if not found then raise exception 'PLATFORM_QUALIFICATION_NOT_FOUND'; end if;
  perform platform_private.lock_platform_reviewer(p_actor);
  return platform_private.admin_qualification_json(q);
 end if;
 select * into q from platform_private.admin_qualifications where id=p_qualification_id for update;
 if not found then raise exception 'PLATFORM_QUALIFICATION_NOT_FOUND'; end if;
 perform platform_private.lock_platform_reviewer(p_actor);
 if q.version<>p_expected_version then raise exception 'PLATFORM_CONFLICT'; end if;
 if not ((q.status='pending' and p_decision in ('approved','rejected'))
  or (q.status='approved' and p_decision='suspended') or (q.status='suspended' and p_decision='approved'))
 then raise exception 'PLATFORM_QUALIFICATION_TRANSITION'; end if;
 before_status:=q.status;
 update platform_private.admin_qualifications set status=p_decision,reviewed_by=p_actor,
  reviewed_at=clock_timestamp(),review_reason=nullif(btrim(p_reason),''),version=version+1,
  access_revoked_before=case when p_decision='suspended' then clock_timestamp() else access_revoked_before end,
  updated_at=clock_timestamp() where id=q.id returning * into q;
 insert into platform_private.audit_events(actor,action,detail)
  values(p_actor,'ADMIN_QUALIFICATION_'||upper(p_decision),
   jsonb_build_object('qualificationId',q.id,'before',before_status,'after',q.status,'version',q.version));
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
  values(p_request_id,p_actor,'qualification_review',h,platform_private.admin_qualification_json(q));
 return platform_private.admin_qualification_json(q);
end $$;

revoke all on function platform_private.admin_qualification_json(platform_private.admin_qualifications),
 platform_private.lock_platform_authorization_change(),platform_private.lock_platform_reviewer(text),
 public.platform_my_admin_qualification(text),public.platform_submit_admin_qualification(text,text,uuid),
 public.platform_list_admin_qualifications(text),public.platform_review_admin_qualification(text,uuid,integer,text,text,uuid)
 from public,anon,authenticated;
grant execute on function platform_private.admin_qualification_json(platform_private.admin_qualifications),
 platform_private.lock_platform_authorization_change(),platform_private.lock_platform_reviewer(text),
 public.platform_my_admin_qualification(text),public.platform_submit_admin_qualification(text,text,uuid),
 public.platform_list_admin_qualifications(text),public.platform_review_admin_qualification(text,uuid,integer,text,text,uuid)
 to service_role;
notify pgrst,'reload schema';
commit;
