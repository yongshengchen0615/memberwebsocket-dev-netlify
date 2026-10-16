alter table public.membership_terms
  add column if not exists scope text not null default 'production';

alter table public.membership_terms
  drop constraint if exists membership_terms_scope_check;
alter table public.membership_terms
  add constraint membership_terms_scope_check
  check (scope in ('production','e2e'));

alter table public.membership_terms
  drop constraint if exists membership_terms_version_key;
drop index if exists public.membership_terms_one_active;
create unique index if not exists membership_terms_scope_version_key
  on public.membership_terms(scope, version);
create unique index if not exists membership_terms_one_active_per_scope
  on public.membership_terms(scope)
  where status = 'active';

create or replace function public.prevent_published_terms_edit()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if tg_op='DELETE' then
    if old.scope='e2e' then return old; end if;
    raise exception 'TERMS_IMMUTABLE';
  end if;
  if old.status <> 'draft' and (
     (old.status='active' and new.status not in ('active','archived'))
     or (old.status='archived' and new.status <> 'archived')
     or new.scope is distinct from old.scope
     or (new.version,new.title,new.summary,new.body,new.required,new.effective_at,
         new.reconsent_existing,new.activated_at,new.created_by,new.created_at)
        is distinct from
        (old.version,old.title,old.summary,old.body,old.required,old.effective_at,
         old.reconsent_existing,old.activated_at,old.created_by,old.created_at)
  ) then raise exception 'TERMS_IMMUTABLE'; end if;
  return new;
end
$function$;

create or replace function public.save_membership_terms_draft(
 p_actor text, p_id uuid, p_version text, p_title text, p_summary text,
 p_body text, p_required boolean, p_effective_at timestamptz,
 p_reconsent_existing boolean
) returns uuid
language plpgsql
set search_path to ''
as $function$
declare v_id uuid; v_before jsonb;
begin
 if not public.membership_terms_admin_ok(p_actor) then raise exception 'ADMIN_REQUIRED'; end if;
 if p_version is null or length(btrim(p_version)) not between 1 and 40
    or p_title is null or length(btrim(p_title)) not between 1 and 120
    or p_body is null or length(btrim(p_body)) not between 1 and 20000
    or length(coalesce(p_summary,'')) > 500 or p_effective_at is null then
   raise exception 'INVALID_TERMS';
 end if;
 if p_id is null then
   insert into public.membership_terms(scope,version,title,summary,body,required,effective_at,reconsent_existing,created_by,updated_by)
   values('production',btrim(p_version),btrim(p_title),coalesce(p_summary,''),p_body,coalesce(p_required,true),p_effective_at,coalesce(p_reconsent_existing,false),p_actor,p_actor)
   returning id into v_id;
 else
   select to_jsonb(t) into v_before
     from public.membership_terms t
    where id=p_id and scope='production' and status='draft'
    for update;
   if v_before is null then raise exception 'TERMS_IMMUTABLE'; end if;
   update public.membership_terms
      set version=btrim(p_version),title=btrim(p_title),summary=coalesce(p_summary,''),
          body=p_body,required=coalesce(p_required,true),effective_at=p_effective_at,
          reconsent_existing=coalesce(p_reconsent_existing,false),updated_by=p_actor,updated_at=now()
    where id=p_id and scope='production'
    returning id into v_id;
 end if;
 insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
 values('AUD-'||replace(gen_random_uuid()::text,'-',''),p_actor,'admin','MEMBERSHIP_TERMS_DRAFT_SAVE','membership_terms',v_id::text,'success',
        jsonb_build_object('scope','production','before',v_before,'after',(select to_jsonb(t) from public.membership_terms t where id=v_id)));
 return v_id;
end
$function$;

create or replace function public.activate_membership_terms(p_actor text, p_id uuid)
returns uuid
language plpgsql
set search_path to ''
as $function$
declare v_terms public.membership_terms%rowtype; v_previous jsonb;
begin
 if not public.membership_terms_admin_ok(p_actor) then raise exception 'ADMIN_REQUIRED'; end if;
 lock table public.membership_terms in share row exclusive mode;
 select * into v_terms
   from public.membership_terms
  where id=p_id and scope='production' and status='draft'
  for update;
 if not found then raise exception 'TERMS_IMMUTABLE'; end if;
 if not v_terms.required or v_terms.effective_at > now() then raise exception 'TERMS_NOT_EFFECTIVE'; end if;
 select to_jsonb(t) into v_previous
   from public.membership_terms t
  where scope='production' and status='active';
 update public.membership_terms
    set status='archived',updated_by=p_actor,updated_at=now()
  where scope='production' and status='active';
 update public.membership_terms
    set status='active',activated_at=now(),updated_by=p_actor,updated_at=now()
  where id=p_id and scope='production';
 insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
 values('AUD-'||replace(gen_random_uuid()::text,'-',''),p_actor,'admin','MEMBERSHIP_TERMS_ACTIVATE','membership_terms',p_id::text,'success',
        jsonb_build_object('scope','production','before',v_previous,'after',(select to_jsonb(t) from public.membership_terms t where id=p_id)));
 return p_id;
end
$function$;

create or replace function public.prepare_e2e_membership_terms_fixture(
  p_member_id uuid,
  p_actor text,
  p_fixture_tag text
) returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_member public.members%rowtype;
  v_terms public.membership_terms%rowtype;
  v_version text := 'E2E-20261005-1';
  v_created boolean := false;
begin
  if not public.is_qa_test_provenance(p_actor)
     or p_fixture_tag is null
     or upper(p_fixture_tag) !~ '^[A-F0-9]{16}$' then
    raise exception 'INVALID_QA_FIXTURE';
  end if;

  perform pg_advisory_xact_lock(2026092803);

  select * into v_member
    from public.members
   where id=p_member_id
   for update;
  if not found or v_member.is_test_account is not true or v_member.status <> 'active' then
    raise exception 'TEST_ACCOUNT_REQUIRED';
  end if;

  select * into v_terms
    from public.membership_terms
   where scope='e2e' and status='active'
   for update;

  if found and v_terms.version <> v_version then
    update public.membership_terms
       set status='archived',updated_by=p_actor,updated_at=clock_timestamp()
     where id=v_terms.id;
    v_terms := null;
  end if;

  if v_terms.id is null then
    insert into public.membership_terms(
      scope,version,title,summary,body,status,required,effective_at,
      reconsent_existing,activated_at,created_by,updated_by
    ) values (
      'e2e',v_version,'E2E 會員申請條款',
      'E2E 測試帳號專用會員申請條款，不影響正式會員。',
      '此條款僅供 MemberWebsocket-dev E2E 驗證會員申請、版本確認、未同意拒絕與同意紀錄生命週期。',
      'active',true,clock_timestamp()-interval '1 minute',
      true,clock_timestamp(),p_actor,p_actor
    )
    returning * into v_terms;
    v_created := true;
  end if;

  delete from public.membership_consents
   where member_id=p_member_id
     and terms_id=v_terms.id;

  return jsonb_build_object(
    'id',v_terms.id,
    'version',v_terms.version,
    'title',v_terms.title,
    'summary',v_terms.summary,
    'body',v_terms.body,
    'required',v_terms.required,
    'scope',v_terms.scope,
    'created',v_created
  );
end
$function$;

revoke all on function public.prepare_e2e_membership_terms_fixture(uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.prepare_e2e_membership_terms_fixture(uuid,text,text)
  to service_role;

create or replace function public.accept_membership_terms(
 p_line_user_id text, p_terms_id uuid, p_version text, p_accepted boolean,
 p_birthday date default null, p_phone text default null, p_surname text default null, p_salutation text default null
) returns boolean
language plpgsql
set search_path to ''
as $function$
declare
  v_member public.members%rowtype;
  v_terms public.membership_terms%rowtype;
  v_join boolean;
  v_scope text := 'production';
begin
 if p_accepted is distinct from true then raise exception 'TERMS_CONSENT_REQUIRED'; end if;
 select * into v_member from public.members where line_user_id=p_line_user_id for update;
 if not found or v_member.status <> 'active' then raise exception 'MEMBER_NOT_FOUND'; end if;

 if v_member.is_test_account is true and exists(
   select 1 from public.membership_terms
    where scope='e2e' and status='active' and required and effective_at<=now()
 ) then
   v_scope := 'e2e';
 end if;

 select * into v_terms
   from public.membership_terms
  where scope=v_scope and status='active'
  for share;
 if not found then raise exception 'TERMS_UNAVAILABLE'; end if;
 if v_terms.id is distinct from p_terms_id or v_terms.version is distinct from p_version
    or not v_terms.required or v_terms.effective_at > now() then
   raise exception 'TERMS_VERSION_STALE';
 end if;

 v_join := v_member.membership_status <> 'active';
 if v_join and (p_birthday is null or p_birthday > current_date or p_birthday < date '1900-01-01'
     or p_phone !~ '^\+[1-9][0-9]{7,14}$'
     or p_phone ~ '([0-9])\1{6,}'
     or (p_phone like '+886%' and p_phone !~ '^\+886(9[0-9]{8}|[2-8][0-9]{7,8})$')
     or length(btrim(coalesce(p_surname,''))) not between 1 and 40
     or p_salutation not in ('mr','ms')) then raise exception 'INVALID_PROFILE'; end if;

 insert into public.membership_consents(member_id,terms_id)
 values(v_member.id,v_terms.id)
 on conflict (member_id,terms_id) do nothing;

 if v_join then
   update public.members
      set birthday=p_birthday,phone=p_phone,surname=btrim(p_surname),salutation=p_salutation,
          membership_status='active',joined_at=coalesce(joined_at,now()),updated_at=now()
    where id=v_member.id;
 end if;

 insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
 values('AUD-'||replace(gen_random_uuid()::text,'-',''),p_line_user_id,'member',
        case when v_join then 'MEMBERSHIP_JOIN_CONSENT' else 'MEMBERSHIP_TERMS_RECONSENT' end,
        'member',v_member.id::text,'success',
        jsonb_build_object('termsId',v_terms.id,'version',v_terms.version,'scope',v_scope));
 return v_join;
end
$function$;

create or replace function public.has_current_membership_terms_consent(p_member_id uuid)
returns boolean
language plpgsql
stable
set search_path to ''
as $function$
declare
  v_member public.members%rowtype;
  v_terms public.membership_terms%rowtype;
  v_scope text := 'production';
begin
  select * into v_member from public.members where id=p_member_id;
  if not found then return true; end if;

  if v_member.is_test_account is true and exists(
    select 1 from public.membership_terms
     where scope='e2e' and status='active' and required and effective_at<=now()
  ) then
    v_scope := 'e2e';
  end if;

  select * into v_terms
    from public.membership_terms
   where scope=v_scope and status='active' and required and effective_at<=now();
  if not found then return true; end if;

  if not v_terms.reconsent_existing then return true; end if;
  if v_member.is_test_account is not true
     and coalesce(v_member.joined_at,v_member.created_at) >= v_terms.activated_at then
    return true;
  end if;

  return exists(
    select 1 from public.membership_consents c
     where c.member_id=v_member.id and c.terms_id=v_terms.id
  );
end
$function$;

create or replace function public.guard_membership_activation_consent()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
 if new.is_test_account is false and new.membership_status='active'
    and (tg_op='INSERT' or old.membership_status <> 'active') then
   if not exists (
     select 1
       from public.membership_consents c
       join public.membership_terms t on t.id=c.terms_id
      where c.member_id=new.id
        and t.scope='production'
        and t.status='active'
        and t.required
        and t.effective_at<=now()
   ) then raise exception 'TERMS_CONSENT_REQUIRED'; end if;
 end if;
 return new;
end
$function$;

create or replace function public.admin_purge_all_test_data_converged()
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_result jsonb := '{}'::jsonb;
  v_pass jsonb := '{}'::jsonb;
  v_pass_deleted integer := 0;
  v_retry_deleted integer := 0;
  v_passes integer := 0;
  v_e2e_consents integer := 0;
  v_e2e_terms integer := 0;
  v_remaining integer := 0;
begin
  v_result := public.admin_purge_all_test_data();

  for v_passes in 1..4 loop
    v_pass := public.admin_purge_extended_qa_artifacts();
    v_pass_deleted := coalesce((v_pass ->> 'deletedExtendedQaArtifacts')::integer, 0);
    v_retry_deleted := v_retry_deleted + v_pass_deleted;
    exit when v_pass_deleted = 0;
  end loop;

  if exists (
    select 1
      from public.membership_consents c
      join public.membership_terms t on t.id=c.terms_id
      join public.members m on m.id=c.member_id
     where t.scope='e2e' and m.is_test_account is not true
  ) then
    raise exception 'E2E_TERMS_CROSS_BOUNDARY';
  end if;

  delete from public.membership_consents c
   using public.membership_terms t, public.members m
   where c.terms_id=t.id
     and c.member_id=m.id
     and t.scope='e2e'
     and m.is_test_account is true;
  get diagnostics v_e2e_consents = row_count;

  delete from public.membership_terms
   where scope='e2e';
  get diagnostics v_e2e_terms = row_count;

  select
      (select count(*) from public.point_cards pc where public.is_qa_test_provenance(pc.created_by))
    + (select count(*) from public.ticket_templates tt where public.is_qa_test_provenance(tt.created_by))
    + (select count(*) from public.fixed_ticket_templates f where public.is_qa_test_provenance(f.created_by))
    + (select count(*) from public.calendar_items c where public.is_qa_test_provenance(c.created_by))
    + (select count(*) from public.event_tickets e
         where public.is_qa_test_provenance(e.created_by)
            or exists (
              select 1 from public.fixed_ticket_templates f
               where f.id=e.fixed_ticket_template_id
                 and public.is_qa_test_provenance(f.created_by)
            ))
    + (select count(*) from public.membership_terms t where t.scope='e2e')
    + (select count(*) from public.membership_consents c
         join public.membership_terms t on t.id=c.terms_id
        where t.scope='e2e')
  into v_remaining;

  return v_result || jsonb_build_object(
    'convergencePasses',v_passes,
    'deletedConvergenceRows',v_retry_deleted,
    'deletedE2eMembershipConsents',v_e2e_consents,
    'deletedE2eMembershipTerms',v_e2e_terms,
    'remainingQaArtifacts',v_remaining,
    'cleanupComplete',v_remaining=0
  );
end
$function$;

revoke all on function public.admin_purge_all_test_data_converged()
  from public,anon,authenticated;
grant execute on function public.admin_purge_all_test_data_converged()
  to service_role;

comment on column public.membership_terms.scope is
  'production terms are legal records for real members; e2e terms are isolated test fixtures visible only to test-account terms selection.';
comment on function public.prepare_e2e_membership_terms_fixture(uuid,text,text) is
  'Creates or reuses the isolated active E2E membership terms and clears only the target test member consent so the lifecycle can be verified again.';

notify pgrst, 'reload schema';
