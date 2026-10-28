begin;
-- Additive, tenant-local invitation attribution. The legacy referral transaction
-- remains unchanged and is the sole issuer of referral rewards.
create function platform_private.install_member_invitations(p_schema text) returns void
language plpgsql security definer set search_path='' as $install$
begin
 if p_schema is null or p_schema!~'^business_[a-f0-9]{32}$'
 or to_regnamespace(p_schema) is null
 or not exists(select 1 from platform_private.tenants where runtime_schema=p_schema) then
  raise exception 'INVALID_BUSINESS_SCHEMA';
 end if;
 execute replace(replace($ddl$
create table if not exists S.member_invitation_tokens (
 id uuid primary key default gen_random_uuid(),
 token_hash text not null unique check(token_hash~'^[a-f0-9]{64}$'),
 inviter_id uuid not null references S.members(id) on delete cascade,
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '7 days'
);
create index if not exists member_invitation_tokens_inviter on S.member_invitation_tokens(inviter_id);
create table if not exists S.member_invitation_attributions (
 invitee_id uuid primary key references S.members(id) on delete cascade,
 inviter_id uuid not null references S.members(id) on delete cascade,
 token_id uuid not null references S.member_invitation_tokens(id) on delete cascade,
 claimed_at timestamptz not null default clock_timestamp(),
 activated_at timestamptz,
 request_id text not null unique default ('inv_'||replace(gen_random_uuid()::text,'-','')),
 reward_status text not null default 'awaiting_activation' check(reward_status in ('awaiting_activation','pending','issued')),
 referral_id text, last_error text, attempted_at timestamptz,
 check(invitee_id<>inviter_id),
 check((activated_at is null and reward_status='awaiting_activation') or (activated_at is not null and reward_status in ('pending','issued'))),
 check(reward_status<>'issued' or referral_id is not null)
);
create index if not exists member_invitation_attributions_inviter on S.member_invitation_attributions(inviter_id,claimed_at);
alter table S.member_invitation_tokens enable row level security;
alter table S.member_invitation_attributions enable row level security;
revoke all on S.member_invitation_tokens,S.member_invitation_attributions from public,anon,authenticated;
grant select,insert,update on S.member_invitation_tokens,S.member_invitation_attributions to service_role;

create or replace function S.invitation_tenant_ready() returns void
language plpgsql security invoker set search_path='' as $$
begin
 perform 1 from platform_private.tenants where runtime_schema='SCHEMA_NAME'
  and status='active' and (expires_at is null or expires_at>clock_timestamp())
  and features->'membership'='true'::jsonb for share nowait;
 if not found then raise exception 'INVITATION_TENANT_UNAVAILABLE';end if;
end $$;
create or replace function S.invitation_actor(p_actor text) returns S.members
language plpgsql security invoker set search_path='' as $$
declare m S.members;
begin
 perform S.invitation_tenant_ready();
 select * into m from S.members where line_user_id=p_actor for share nowait;
 if not found or m.status<>'active' or m.membership_status<>'active' then raise exception 'MEMBERSHIP_REQUIRED';end if;
 if not S.has_current_membership_terms_consent(m.id) then raise exception 'TERMS_RECONSENT_REQUIRED';end if;
 return m;
end $$;
create or replace function S.member_invitation_create(p_actor text,p_token_hash text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare m S.members; t S.member_invitation_tokens;campaign jsonb;
begin
 if p_token_hash is null or p_token_hash!~'^[a-f0-9]{64}$' then raise exception 'INVITATION_TOKEN_INVALID';end if;
 m:=S.invitation_actor(p_actor);
 insert into S.member_invitation_tokens(token_hash,inviter_id)values(p_token_hash,m.id) returning * into t;
 select jsonb_build_object('title',e.title,'expiresOn',e.ends_on,'settlementPolicy','current_at_activation_or_retry') into campaign
 from S.event_tickets e where ticket_type='referral' and referral_source_event_ticket_id is null and status='active' and deleted_at is null
 and (starts_on is null or starts_on<=(clock_timestamp() at time zone 'Asia/Taipei')::date)
 and (ends_on is null or ends_on>=(clock_timestamp() at time zone 'Asia/Taipei')::date)
 order by created_at desc limit 1;
 return jsonb_build_object('expiresAt',t.expires_at,'campaign',campaign);
end $$;
create or replace function S.member_invitation_claim(p_actor text,p_token_hash text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare m S.members;inviter S.members;t S.member_invitation_tokens;a S.member_invitation_attributions;
begin
 if p_token_hash is null or p_token_hash!~'^[a-f0-9]{64}$' then raise exception 'INVITATION_TOKEN_INVALID';end if;
 perform S.invitation_tenant_ready();
 -- Same member lock as first activation: claim cannot slip in after activation.
 select * into m from S.members where line_user_id=p_actor for update;
 if not found or m.status<>'active' then raise exception 'MEMBERSHIP_REQUIRED';end if;
 if m.membership_status<>'pending' or m.joined_at is not null then raise exception 'INVITATION_ACTIVE_MEMBER';end if;
 select * into t from S.member_invitation_tokens where token_hash=p_token_hash;
 if not found then raise exception 'INVITATION_TOKEN_INVALID';end if;
 if t.expires_at<=clock_timestamp() then raise exception 'INVITATION_TOKEN_EXPIRED';end if;
 if t.inviter_id=m.id then raise exception 'INVITATION_SELF_NOT_ALLOWED';end if;
 select * into inviter from S.members where id=t.inviter_id for share nowait;
 if not found or inviter.status<>'active' or inviter.membership_status<>'active'
 or inviter.is_test_account is distinct from m.is_test_account
 or not S.has_current_membership_terms_consent(inviter.id) then raise exception 'INVITATION_SOURCE_UNAVAILABLE';end if;
 select * into a from S.member_invitation_attributions where invitee_id=m.id;
 if found then
  if a.token_id<>t.id then raise exception 'INVITATION_ALREADY_CLAIMED';end if;
  return jsonb_build_object('claimed',true,'alreadyClaimed',true,'rewardStatus','awaiting_activation');
 end if;
 insert into S.member_invitation_attributions(invitee_id,inviter_id,token_id)values(m.id,inviter.id,t.id);
 return jsonb_build_object('claimed',true,'alreadyClaimed',false,'rewardStatus','awaiting_activation');
end $$;

create or replace function S.settle_member_invitation(p_invitee uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare a S.member_invitation_attributions;invitee S.members;inviter S.members;result jsonb;err text;
begin
 -- Consistent member -> attribution order. Never wait for an inviter held by
 -- legacy bind (which locks inviter first): registration stays successful and
 -- this attribution remains explicitly retryable instead of forming a cycle.
 select * into invitee from S.members where id=p_invitee for update nowait;
 select * into a from S.member_invitation_attributions where invitee_id=p_invitee for update;
 if not found or a.activated_at is null or a.reward_status='issued' then return;end if;
 begin
  perform S.invitation_tenant_ready();
  select * into inviter from S.members where id=a.inviter_id for update nowait;
  if not found or inviter.status<>'active' or inviter.membership_status<>'active'
   or invitee.status<>'active' or invitee.membership_status<>'active'
   or inviter.is_test_account is distinct from invitee.is_test_account
   or not S.has_current_membership_terms_consent(inviter.id)
   or not S.has_current_membership_terms_consent(invitee.id) then raise exception 'INVITATION_SOURCE_UNAVAILABLE';end if;
  result:=S.bind_member_referral(inviter.line_user_id,invitee.invite_code,a.request_id);
  if result->>'rewardStatus' is distinct from 'issued' or not exists(
   select 1 from S.member_referrals r where r.referral_id=result->>'referralId'
    and r.inviter_member_id=inviter.id and r.invitee_member_id=invitee.id and r.reward_status='issued'
  ) then raise exception 'REFERRAL_REWARD_UNAVAILABLE';end if;
  update S.member_invitation_attributions set reward_status='issued',referral_id=result->>'referralId',last_error=null,attempted_at=clock_timestamp() where invitee_id=p_invitee;
 exception when others then
  -- Subtransaction rolls back every reward side effect on any failure. Keep
  -- only allowlisted outcome codes; provider/SQL diagnostics are never stored.
  err:=case when sqlerrm in ('INVITATION_TENANT_UNAVAILABLE','INVITATION_SOURCE_UNAVAILABLE','REFERRAL_ALREADY_BOUND',
   'REFERRAL_CYCLE_NOT_ALLOWED','REFERRAL_REWARD_UNAVAILABLE','REFERRAL_REWARD_SOLD_OUT','REFERRAL_REWARD_NOT_ELIGIBLE') then sqlerrm
   when sqlstate in ('55P03','40P01','40001','23505') then 'INVITATION_RETRY_REQUIRED' else 'INVITATION_SETTLEMENT_UNAVAILABLE' end;
  update S.member_invitation_attributions set reward_status='pending',last_error=err,attempted_at=clock_timestamp() where invitee_id=p_invitee;
 end;
end $$;
create or replace function S.activate_member_invitation() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if old.membership_status='pending' and old.joined_at is null and new.membership_status='active' and new.joined_at is not null then
  update S.member_invitation_attributions set activated_at=clock_timestamp(),reward_status='pending'
   where invitee_id=new.id and activated_at is null;
  if found then perform S.settle_member_invitation(new.id);end if;
 end if;
 return null;
end $$;
drop trigger if exists members_activate_invitation on S.members;
create trigger members_activate_invitation after update of membership_status on S.members
 for each row execute function S.activate_member_invitation();

create or replace function S.member_invitation_summary(p_actor text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare m S.members;result jsonb;
begin
 m:=S.invitation_actor(p_actor);
 select jsonb_build_object('joinedCount',count(*) filter(where a.activated_at is not null),
  'rewardedCount',count(*) filter(where a.reward_status='issued'),
  'pendingCount',count(*) filter(where a.activated_at is not null and a.reward_status<>'issued'),
  'rewards',coalesce((select jsonb_agg(jsonb_build_object('title',r.title,'expiresOn',r.ends_on,'ticketId',r.event_ticket_id,'status',r.status) order by r.created_at desc)
    from (select e.title,e.ends_on,e.event_ticket_id,e.status,e.created_at from S.member_invitation_attributions x
      join S.member_referrals f on f.referral_id=x.referral_id and f.inviter_member_id=m.id
      join S.event_tickets e on e.id=f.reward_event_ticket_id
      where x.inviter_id=m.id and x.reward_status='issued' order by e.created_at desc limit 100) r),'[]'::jsonb))
 into result from S.member_invitation_attributions a where a.inviter_id=m.id;
 return result;
end $$;
create or replace function S.member_invitation_retry(p_actor text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare m S.members;a record;
begin
 -- Do not hold inviter SHARE while waiting for an invitee locked by activation.
 -- Each invitee is acquired NOWAIT and skipped when busy; settlement rechecks
 -- all eligibility under locks. Retry is bounded and actor scoped.
 m:=S.invitation_actor(p_actor);
 for a in select invitee_id from S.member_invitation_attributions where inviter_id=m.id and activated_at is not null and reward_status='pending' order by claimed_at limit 20 loop
  begin
   perform S.settle_member_invitation(a.invitee_id);
  exception when lock_not_available then null;
  end;
 end loop;
 return S.member_invitation_summary(p_actor);
end $$;
revoke all on function S.invitation_tenant_ready(),S.invitation_actor(text),S.member_invitation_create(text,text),S.member_invitation_claim(text,text),S.settle_member_invitation(uuid),S.activate_member_invitation(),S.member_invitation_summary(text),S.member_invitation_retry(text) from public,anon,authenticated;
grant execute on function S.invitation_tenant_ready(),S.invitation_actor(text),S.member_invitation_create(text,text),S.member_invitation_claim(text,text),S.settle_member_invitation(uuid),S.activate_member_invitation(),S.member_invitation_summary(text),S.member_invitation_retry(text) to service_role;
$ddl$,'S.',quote_ident(p_schema)||'.'),'SCHEMA_NAME',p_schema);
end $install$;
revoke all on function platform_private.install_member_invitations(text) from public,anon,authenticated,service_role;
do $$declare t record;begin
 for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop perform platform_private.install_member_invitations(t.runtime_schema);end loop;
end $$;
alter function public.platform_provision_business(uuid) rename to platform_provision_business_base_20261028_invitation;
revoke all on function public.platform_provision_business_base_20261028_invitation(uuid) from public,anon,authenticated,service_role;
create function public.platform_provision_business(p_tenant_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s text;begin
 perform public.platform_provision_business_base_20261028_invitation(p_tenant_id);
 select runtime_schema into strict s from platform_private.tenants where id=p_tenant_id;
 perform platform_private.install_member_invitations(s);
end $$;
revoke all on function public.platform_provision_business(uuid) from public,anon,authenticated;
grant execute on function public.platform_provision_business(uuid) to service_role;
notify pgrst,'reload schema';
commit;
