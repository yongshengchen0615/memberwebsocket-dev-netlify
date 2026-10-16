alter table public.membership_terms
  add column if not exists e2e_member_id uuid references public.members(id) on delete cascade;

alter table public.membership_terms
  drop constraint if exists membership_terms_scope_target_check;
alter table public.membership_terms
  add constraint membership_terms_scope_target_check
  check (
    (scope='production' and e2e_member_id is null)
    or (scope='e2e' and e2e_member_id is not null)
  );

drop index if exists public.membership_terms_scope_version_key;
drop index if exists public.membership_terms_one_active_per_scope;

create unique index if not exists membership_terms_production_version_key
  on public.membership_terms(version)
  where scope='production';
create unique index if not exists membership_terms_production_one_active
  on public.membership_terms(scope)
  where scope='production' and status='active';
create unique index if not exists membership_terms_e2e_member_version_key
  on public.membership_terms(e2e_member_id,version)
  where scope='e2e';
create unique index if not exists membership_terms_e2e_member_one_active
  on public.membership_terms(e2e_member_id)
  where scope='e2e' and status='active';

create or replace function public.prevent_published_terms_edit()
returns trigger language plpgsql set search_path to '' as $function$
begin
  if tg_op='DELETE' then
    if old.scope='e2e' then return old; end if;
    raise exception 'TERMS_IMMUTABLE';
  end if;
  if old.status <> 'draft' and (
     (old.status='active' and new.status not in ('active','archived'))
     or (old.status='archived' and new.status <> 'archived')
     or new.scope is distinct from old.scope
     or new.e2e_member_id is distinct from old.e2e_member_id
     or (new.version,new.title,new.summary,new.body,new.required,new.effective_at,
         new.reconsent_existing,new.activated_at,new.created_by,new.created_at)
        is distinct from
        (old.version,old.title,old.summary,old.body,old.required,old.effective_at,
         old.reconsent_existing,old.activated_at,old.created_by,old.created_at)
  ) then raise exception 'TERMS_IMMUTABLE'; end if;
  return new;
end
$function$;

create or replace function public.prepare_e2e_membership_terms_fixture(
  p_member_id uuid,p_actor text,p_fixture_tag text
) returns jsonb
language plpgsql security definer set search_path to 'public','pg_temp' as $function$
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
  perform pg_advisory_xact_lock(hashtext(p_member_id::text), 20260928);
  select * into v_member from public.members where id=p_member_id for update;
  if not found or v_member.is_test_account is not true or v_member.status <> 'active' then
    raise exception 'TEST_ACCOUNT_REQUIRED';
  end if;
  select * into v_terms
    from public.membership_terms
   where scope='e2e' and e2e_member_id=p_member_id and status='active'
   for update;
  if found and v_terms.version <> v_version then
    update public.membership_terms
       set status='archived',updated_by=p_actor,updated_at=clock_timestamp()
     where id=v_terms.id;
    v_terms := null;
  end if;
  if v_terms.id is null then
    insert into public.membership_terms(
      scope,e2e_member_id,version,title,summary,body,status,required,effective_at,
      reconsent_existing,activated_at,created_by,updated_by
    ) values (
      'e2e',p_member_id,v_version,'E2E 會員申請條款',
      'E2E 測試帳號專用會員申請條款，不影響正式會員或其他測試帳號。',
      '此條款僅供 MemberWebsocket-dev E2E 驗證會員申請、版本確認、未同意拒絕與同意紀錄生命週期。',
      'active',true,clock_timestamp()-interval '1 minute',
      true,clock_timestamp(),p_actor,p_actor
    )
    returning * into v_terms;
    v_created := true;
  end if;
  delete from public.membership_consents where member_id=p_member_id and terms_id=v_terms.id;
  return jsonb_build_object(
    'id',v_terms.id,'memberId',v_terms.e2e_member_id,'version',v_terms.version,
    'title',v_terms.title,'summary',v_terms.summary,'body',v_terms.body,
    'required',v_terms.required,'scope',v_terms.scope,'created',v_created
  );
end
$function$;

create or replace function public.accept_membership_terms(
 p_line_user_id text,p_terms_id uuid,p_version text,p_accepted boolean,
 p_birthday date default null,p_phone text default null,p_surname text default null,p_salutation text default null
) returns boolean language plpgsql set search_path to '' as $function$
declare
  v_member public.members%rowtype; v_terms public.membership_terms%rowtype;
  v_join boolean; v_scope text := 'production';
begin
 if p_accepted is distinct from true then raise exception 'TERMS_CONSENT_REQUIRED'; end if;
 select * into v_member from public.members where line_user_id=p_line_user_id for update;
 if not found or v_member.status <> 'active' then raise exception 'MEMBER_NOT_FOUND'; end if;
 if v_member.is_test_account is true and exists(
   select 1 from public.membership_terms
    where scope='e2e' and e2e_member_id=v_member.id and status='active'
      and required and effective_at<=now()
 ) then v_scope := 'e2e'; end if;
 select * into v_terms from public.membership_terms
  where scope=v_scope and status='active'
    and (v_scope='production' or e2e_member_id=v_member.id) for share;
 if not found then raise exception 'TERMS_UNAVAILABLE'; end if;
 if v_terms.id is distinct from p_terms_id or v_terms.version is distinct from p_version
    or not v_terms.required or v_terms.effective_at > now() then raise exception 'TERMS_VERSION_STALE'; end if;
 v_join := v_member.membership_status <> 'active';
 if v_join and (p_birthday is null or p_birthday > current_date or p_birthday < date '1900-01-01'
     or p_phone !~ '^\+[1-9][0-9]{7,14}$'
     or p_phone ~ '([0-9])\1{6,}'
     or (p_phone like '+886%' and p_phone !~ '^\+886(9[0-9]{8}|[2-8][0-9]{7,8})$')
     or length(btrim(coalesce(p_surname,''))) not between 1 and 40
     or p_salutation not in ('mr','ms')) then raise exception 'INVALID_PROFILE'; end if;
 insert into public.membership_consents(member_id,terms_id)
 values(v_member.id,v_terms.id) on conflict (member_id,terms_id) do nothing;
 if v_join then
   update public.members set birthday=p_birthday,phone=p_phone,surname=btrim(p_surname),salutation=p_salutation,
      membership_status='active',joined_at=coalesce(joined_at,now()),updated_at=now() where id=v_member.id;
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
returns boolean language plpgsql stable set search_path to '' as $function$
declare
  v_member public.members%rowtype; v_terms public.membership_terms%rowtype; v_scope text := 'production';
begin
  select * into v_member from public.members where id=p_member_id;
  if not found then return true; end if;
  if v_member.is_test_account is true and exists(
    select 1 from public.membership_terms
     where scope='e2e' and e2e_member_id=v_member.id and status='active'
       and required and effective_at<=now()
  ) then v_scope := 'e2e'; end if;
  select * into v_terms from public.membership_terms
   where scope=v_scope and status='active'
     and (v_scope='production' or e2e_member_id=v_member.id)
     and required and effective_at<=now();
  if not found then return true; end if;
  if not v_terms.reconsent_existing then return true; end if;
  if v_member.is_test_account is not true
     and coalesce(v_member.joined_at,v_member.created_at) >= v_terms.activated_at then return true; end if;
  return exists(select 1 from public.membership_consents c where c.member_id=v_member.id and c.terms_id=v_terms.id);
end
$function$;

comment on column public.membership_terms.e2e_member_id is
  'Target test member for E2E-scoped terms. Must be null for production terms and non-null for E2E terms.';

notify pgrst, 'reload schema';
