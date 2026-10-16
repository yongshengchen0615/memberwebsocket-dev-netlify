-- The LINE identity creates a pending member row on first visit; consent gates
-- the transition to active membership. Published text is immutable.
create table public.membership_terms (
  id uuid primary key default gen_random_uuid(),
  version text not null unique check (length(btrim(version)) between 1 and 40),
  title text not null check (length(btrim(title)) between 1 and 120),
  summary text not null default '',
  body text not null check (length(btrim(body)) between 1 and 20000),
  status text not null default 'draft' check (status in ('draft','active','archived')),
  required boolean not null default true,
  effective_at timestamptz not null default now(),
  reconsent_existing boolean not null default false,
  activated_at timestamptz,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index membership_terms_one_active on public.membership_terms (status) where status = 'active';
create table public.membership_consents (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  terms_id uuid not null references public.membership_terms(id) on delete restrict,
  accepted_at timestamptz not null default now(),
  result text not null default 'accepted' check (result = 'accepted'),
  unique (member_id, terms_id)
);
create index membership_consents_terms_idx on public.membership_consents (terms_id);
alter table public.membership_terms enable row level security;
alter table public.membership_consents enable row level security;
revoke all on public.membership_terms, public.membership_consents from anon, authenticated;
grant select, insert, update on public.membership_terms to service_role;
grant select, insert on public.membership_consents to service_role;

create or replace function public.membership_terms_admin_ok(p_actor text)
returns boolean language sql stable set search_path = '' as $$
  select exists(select 1 from public.admins where line_user_id = p_actor and role = 'admin' and status = 'active');
$$;
revoke all on function public.membership_terms_admin_ok(text) from public, anon, authenticated;
grant execute on function public.membership_terms_admin_ok(text) to service_role;

create function public.save_membership_terms_draft(
 p_actor text, p_id uuid, p_version text, p_title text, p_summary text,
 p_body text, p_required boolean, p_effective_at timestamptz,
 p_reconsent_existing boolean
) returns uuid language plpgsql set search_path = '' as $$
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
   insert into public.membership_terms(version,title,summary,body,required,effective_at,reconsent_existing,created_by,updated_by)
   values(btrim(p_version),btrim(p_title),coalesce(p_summary,''),p_body,coalesce(p_required,true),p_effective_at,coalesce(p_reconsent_existing,false),p_actor,p_actor)
   returning id into v_id;
 else
   select to_jsonb(t) into v_before from public.membership_terms t where id=p_id and status='draft' for update;
   if v_before is null then raise exception 'TERMS_IMMUTABLE'; end if;
   update public.membership_terms set version=btrim(p_version),title=btrim(p_title),summary=coalesce(p_summary,''),
      body=p_body,required=coalesce(p_required,true),effective_at=p_effective_at,
      reconsent_existing=coalesce(p_reconsent_existing,false),updated_by=p_actor,updated_at=now()
    where id=p_id returning id into v_id;
 end if;
 insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
 values('AUD-'||replace(gen_random_uuid()::text,'-',''),p_actor,'admin','MEMBERSHIP_TERMS_DRAFT_SAVE','membership_terms',v_id::text,'success',
        jsonb_build_object('before',v_before,'after',(select to_jsonb(t) from public.membership_terms t where id=v_id)));
 return v_id;
end $$;

create function public.activate_membership_terms(p_actor text, p_id uuid)
returns uuid language plpgsql set search_path = '' as $$
declare v_terms public.membership_terms%rowtype; v_previous jsonb;
begin
 if not public.membership_terms_admin_ok(p_actor) then raise exception 'ADMIN_REQUIRED'; end if;
 -- Serializes competing activations and registration against the terms row.
 lock table public.membership_terms in share row exclusive mode;
 select * into v_terms from public.membership_terms where id=p_id and status='draft' for update;
 if not found then raise exception 'TERMS_IMMUTABLE'; end if;
 if not v_terms.required or v_terms.effective_at > now() then raise exception 'TERMS_NOT_EFFECTIVE'; end if;
 select to_jsonb(t) into v_previous from public.membership_terms t where status='active';
 update public.membership_terms set status='archived',updated_by=p_actor,updated_at=now() where status='active';
 update public.membership_terms set status='active',activated_at=now(),updated_by=p_actor,updated_at=now() where id=p_id;
 insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
 values('AUD-'||replace(gen_random_uuid()::text,'-',''),p_actor,'admin','MEMBERSHIP_TERMS_ACTIVATE','membership_terms',p_id::text,'success',
        jsonb_build_object('before',v_previous,'after',(select to_jsonb(t) from public.membership_terms t where id=p_id)));
 return p_id;
end $$;

create function public.accept_membership_terms(
 p_line_user_id text, p_terms_id uuid, p_version text, p_accepted boolean,
 p_birthday date default null, p_phone text default null, p_surname text default null, p_salutation text default null
) returns boolean language plpgsql set search_path = '' as $$
declare v_member public.members%rowtype; v_terms public.membership_terms%rowtype; v_join boolean;
begin
 if p_accepted is distinct from true then raise exception 'TERMS_CONSENT_REQUIRED'; end if;
 select * into v_member from public.members where line_user_id=p_line_user_id for update;
 if not found or v_member.status <> 'active' then raise exception 'MEMBER_NOT_FOUND'; end if;
 select * into v_terms from public.membership_terms where status='active' for share;
 if not found then raise exception 'TERMS_UNAVAILABLE'; end if;
 if v_terms.id is distinct from p_terms_id or v_terms.version is distinct from p_version or not v_terms.required or v_terms.effective_at > now() then
   raise exception 'TERMS_VERSION_STALE';
 end if;
 v_join := v_member.membership_status <> 'active';
 if v_join and (p_birthday is null or p_birthday > current_date or p_birthday < date '1900-01-01'
     or p_phone !~ '^\+?[0-9]{8,15}$' or length(btrim(coalesce(p_surname,''))) not between 1 and 40
     or p_salutation not in ('mr','ms')) then raise exception 'INVALID_PROFILE'; end if;
 insert into public.membership_consents(member_id,terms_id) values(v_member.id,v_terms.id) on conflict (member_id,terms_id) do nothing;
 if v_join then
   update public.members set birthday=p_birthday,phone=p_phone,surname=btrim(p_surname),salutation=p_salutation,
      membership_status='active',joined_at=coalesce(joined_at,now()),updated_at=now() where id=v_member.id;
 end if;
 insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
 values('AUD-'||replace(gen_random_uuid()::text,'-',''),p_line_user_id,'member',
        case when v_join then 'MEMBERSHIP_JOIN_CONSENT' else 'MEMBERSHIP_TERMS_RECONSENT' end,
        'member',v_member.id::text,'success',jsonb_build_object('termsId',v_terms.id,'version',v_terms.version));
 return v_join;
end $$;

-- Defense against the legacy API and future service-role writes bypassing the RPC.
create function public.guard_membership_activation_consent()
returns trigger language plpgsql set search_path = '' as $$
begin
 if new.is_test_account is false and new.membership_status='active' and (tg_op='INSERT' or old.membership_status <> 'active') then
   if not exists (
     select 1 from public.membership_consents c join public.membership_terms t on t.id=c.terms_id
     where c.member_id=new.id and t.status='active' and t.required and t.effective_at<=now()
   ) then raise exception 'TERMS_CONSENT_REQUIRED'; end if;
 end if;
 return new;
end $$;
create trigger guard_membership_activation_consent before insert or update of membership_status on public.members
for each row execute function public.guard_membership_activation_consent();

revoke all on function public.save_membership_terms_draft(text,uuid,text,text,text,text,boolean,timestamptz,boolean) from public,anon,authenticated;
revoke all on function public.activate_membership_terms(text,uuid) from public,anon,authenticated;
revoke all on function public.accept_membership_terms(text,uuid,text,boolean,date,text,text,text) from public,anon,authenticated;
grant execute on function public.save_membership_terms_draft(text,uuid,text,text,text,text,boolean,timestamptz,boolean) to service_role;
grant execute on function public.activate_membership_terms(text,uuid) to service_role;
grant execute on function public.accept_membership_terms(text,uuid,text,boolean,date,text,text,text) to service_role;

create function public.has_current_membership_terms_consent(p_member_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select coalesce((select
    not t.reconsent_existing
    or m.is_test_account
    or coalesce(m.joined_at,m.created_at) >= t.activated_at
    or exists(select 1 from public.membership_consents c where c.member_id=m.id and c.terms_id=t.id)
  from public.members m cross join public.membership_terms t
  where m.id=p_member_id and t.status='active'),true);
$$;
revoke all on function public.has_current_membership_terms_consent(uuid) from public,anon,authenticated;
grant execute on function public.has_current_membership_terms_consent(uuid) to service_role;

create function public.prevent_published_terms_edit()
returns trigger language plpgsql set search_path = '' as $$
begin
 if tg_op='DELETE' then raise exception 'TERMS_IMMUTABLE'; end if;
 if old.status <> 'draft' and (new.version,new.title,new.summary,new.body,new.required,
    new.effective_at,new.reconsent_existing,new.activated_at,new.created_by,new.created_at)
    is distinct from (old.version,old.title,old.summary,old.body,old.required,
    old.effective_at,old.reconsent_existing,old.activated_at,old.created_by,old.created_at) then
   raise exception 'TERMS_IMMUTABLE';
 end if;
 return new;
end $$;
create trigger prevent_published_terms_update before update on public.membership_terms
for each row execute function public.prevent_published_terms_edit();
create trigger prevent_published_terms_delete before delete on public.membership_terms
for each row execute function public.prevent_published_terms_edit();
create function public.prevent_consent_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'CONSENT_IMMUTABLE'; end $$;
create trigger prevent_consent_update before update on public.membership_consents
for each row execute function public.prevent_consent_mutation();
