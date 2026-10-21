begin;
-- New records only: historical no-show rows are never backfilled or penalized.
create function platform_private.install_booking_risk(p_schema text) returns void
language plpgsql security definer set search_path='' as $install$
begin
 if p_schema!~'^business_[a-f0-9]{32}$' or not exists(select 1 from platform_private.tenants where runtime_schema=p_schema) then raise exception 'INVALID_BUSINESS_SCHEMA';end if;
 execute replace($ddl$
create table if not exists S.booking_no_show_policy (
 id boolean primary key default true check(id),enabled boolean not null default false,
 threshold_count integer check(threshold_count between 1 and 100),lookback_days integer check(lookback_days between 1 and 3650),
 duration_count integer check(duration_count between 1 and 120),duration_unit text check(duration_unit in ('weeks','months')),
 grace_minutes integer check(grace_minutes between 0 and 1440),appeal_enabled boolean not null default true,
 contact_text text not null default '' check(length(contact_text)<=500),version integer not null default 1,
 updated_at timestamptz not null default now(),updated_by text,recording_since timestamptz not null default now(),
 check(not enabled or (threshold_count is not null and lookback_days is not null and duration_count is not null and duration_unit is not null and grace_minutes is not null and length(btrim(contact_text))>0))
);
insert into S.booking_no_show_policy(id)values(true) on conflict do nothing;
create table if not exists S.booking_no_show_events (
 booking_id uuid primary key references S.bookings(id),member_id uuid not null references S.members(id),
 occurred_at timestamptz not null,marked_at timestamptz not null default now(),marked_by text not null,
 revoked_at timestamptz,revoked_by text,revoke_reason text,
 check((revoked_at is null and revoked_by is null and revoke_reason is null) or (revoked_at is not null and revoked_by is not null and length(btrim(revoke_reason)) between 1 and 500))
);
create index if not exists booking_no_show_member_time on S.booking_no_show_events(member_id,occurred_at) where revoked_at is null;
create table if not exists S.booking_restrictions (
 id uuid primary key default gen_random_uuid(),member_id uuid not null references S.members(id),
 source_booking_id uuid not null unique references S.booking_no_show_events(booking_id),
 starts_at timestamptz not null,ends_at timestamptz not null check(ends_at>starts_at),policy_snapshot jsonb not null,
 revoked_at timestamptz,revoked_by text,revoke_reason text
);
create index if not exists booking_restrictions_member_end on S.booking_restrictions(member_id,ends_at) where revoked_at is null;
create table if not exists S.booking_restriction_appeals (
 id uuid primary key default gen_random_uuid(),restriction_id uuid not null unique references S.booking_restrictions(id),
 member_id uuid not null references S.members(id),reason text not null check(length(btrim(reason)) between 1 and 500),
 created_at timestamptz not null default now(),resolved_at timestamptz,resolved_by text,resolution text
);
alter table S.booking_no_show_policy enable row level security;
alter table S.booking_no_show_events enable row level security;
alter table S.booking_restrictions enable row level security;
alter table S.booking_restriction_appeals enable row level security;
revoke all on S.booking_no_show_policy,S.booking_no_show_events,S.booking_restrictions,S.booking_restriction_appeals from public,anon,authenticated;
grant select,insert,update,delete on S.booking_no_show_policy,S.booking_no_show_events,S.booking_restrictions,S.booking_restriction_appeals to service_role;

create or replace function S.booking_active_restriction(p_member uuid,p_now timestamptz) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('restricted',true,'restrictionId',r.id,'expiresAt',r.ends_at,'appealEnabled',c.appeal_enabled,'contactText',c.contact_text,
 'appealSubmitted',exists(select 1 from S.booking_restriction_appeals a where a.restriction_id=r.id),'appealResolved',exists(select 1 from S.booking_restriction_appeals a where a.restriction_id=r.id and a.resolved_at is not null),'appealResolution',(select a.resolution from S.booking_restriction_appeals a where a.restriction_id=r.id))
 from S.booking_restrictions r cross join S.booking_no_show_policy c
 where c.enabled and r.member_id=p_member and r.revoked_at is null and r.starts_at<=p_now and r.ends_at>p_now order by r.ends_at desc limit 1;
$$;
create or replace function S.booking_enforce_restriction() returns trigger
language plpgsql set search_path='' as $$
declare restriction jsonb;
begin
 -- Receipt registration and existing appointment changes retain their contract.
 if new.status<>'pending' or new.request_id like 'receipt-register:%' then return new;end if;
 perform 1 from S.members where id=new.member_id for update;
 restriction:=S.booking_active_restriction(new.member_id,clock_timestamp());
 if restriction is not null then raise exception 'BOOKING_RESTRICTED' using detail=restriction::text;end if;
 return new;
end $$;
drop trigger if exists booking_enforce_no_show_restriction on S.bookings;
create trigger booking_enforce_no_show_restriction before insert on S.bookings for each row execute function S.booking_enforce_restriction();

create or replace function S.booking_record_no_show() returns trigger
language plpgsql set search_path='' as $$
declare cfg S.booking_no_show_policy;counted integer;inserted integer;
begin
 if new.status<>'no_show' or old.status='no_show' then return null;end if;
 perform 1 from S.members where id=new.member_id for update;
 select * into strict cfg from S.booking_no_show_policy where id for share;
 if new.end_at is null or (new.end_at at time zone 'Asia/Taipei')+make_interval(mins=>case when cfg.enabled then coalesce(cfg.grace_minutes,0) else 0 end)>=clock_timestamp() then raise exception 'BOOKING_NO_SHOW_TOO_EARLY';end if;
 insert into S.booking_no_show_events(booking_id,member_id,occurred_at,marked_by)
 values(new.id,new.member_id,new.end_at at time zone 'Asia/Taipei',coalesce(new.no_show_by,'system')) on conflict do nothing;
 get diagnostics inserted=row_count;
 if not cfg.enabled or inserted=0 then return null;end if;
 select count(*) into counted from S.booking_no_show_events where member_id=new.member_id and revoked_at is null
  and marked_at>=cfg.recording_since and occurred_at>=now()-make_interval(days=>cfg.lookback_days) and occurred_at<=now();
 if counted>=cfg.threshold_count and S.booking_active_restriction(new.member_id,now()) is null then
  insert into S.booking_restrictions(member_id,source_booking_id,starts_at,ends_at,policy_snapshot)
  values(new.member_id,new.id,now(),now()+case cfg.duration_unit when 'months' then make_interval(months=>cfg.duration_count) else make_interval(weeks=>cfg.duration_count) end,to_jsonb(cfg));
 end if;
 return null;
end $$;
drop trigger if exists booking_record_no_show_policy on S.bookings;
create trigger booking_record_no_show_policy after update of status on S.bookings for each row execute function S.booking_record_no_show();

create or replace function S.booking_no_show_status(p_actor text) returns jsonb
language plpgsql set search_path='' as $$
declare m uuid;
begin
 select id into m from S.members where line_user_id=p_actor and status='active';
 if m is null then raise exception 'MEMBER_REQUIRED';end if;
 return coalesce(S.booking_active_restriction(m,clock_timestamp()),'{"restricted":false}'::jsonb);
end $$;
create or replace function S.booking_no_show_appeal(p_actor text,p_reason text) returns jsonb
language plpgsql set search_path='' as $$
declare m uuid;restriction jsonb;
begin
 if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then raise exception 'INVALID_APPEAL_REASON';end if;
 select id into m from S.members where line_user_id=p_actor and status='active' for update;
 if m is null then raise exception 'MEMBER_REQUIRED';end if;
 restriction:=S.booking_active_restriction(m,clock_timestamp());
 if restriction is null or restriction->>'appealEnabled'<>'true' then raise exception 'BOOKING_APPEAL_UNAVAILABLE';end if;
 insert into S.booking_restriction_appeals(restriction_id,member_id,reason)values((restriction->>'restrictionId')::uuid,m,btrim(p_reason)) on conflict(restriction_id)do nothing;
 return S.booking_no_show_status(p_actor);
end $$;
create or replace function S.admin_booking_no_show(p_actor text,p_action text,p_body jsonb default '{}') returns jsonb
language plpgsql set search_path='' as $$
declare cfg S.booking_no_show_policy;event S.booking_no_show_events;r S.booking_restrictions;reason text;changed integer;
begin
 perform 1 from S.admins where line_user_id=p_actor and role='admin' and status='active' for share;
 if not found then raise exception 'ADMIN_REQUIRED';end if;
 if p_action='save' then
  select * into strict cfg from S.booking_no_show_policy where id for update;
  if (p_body->>'version')::integer is distinct from cfg.version then raise exception 'BOOKING_CONFLICT';end if;
  update S.booking_no_show_policy set enabled=(p_body->>'enabled')::boolean,threshold_count=nullif(p_body->>'threshold_count','')::integer,
   lookback_days=nullif(p_body->>'lookback_days','')::integer,duration_count=nullif(p_body->>'duration_count','')::integer,duration_unit=nullif(p_body->>'duration_unit',''),
   grace_minutes=nullif(p_body->>'grace_minutes','')::integer,appeal_enabled=coalesce((p_body->>'appeal_enabled')::boolean,true),contact_text=coalesce(p_body->>'contact_text',''),
   recording_since=case when not enabled and (p_body->>'enabled')::boolean then now() else recording_since end,version=version+1,updated_at=clock_timestamp(),updated_by=p_actor where id;
  insert into S.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
   values(p_actor,'admin','BOOKING_RISK_POLICY_UPDATED','booking_policy','no_show','success',jsonb_build_object('before',to_jsonb(cfg),'after',p_body));
 elsif p_action in ('revoke','release','resolve') then
  reason:=btrim(p_body->>'reason');if reason is null or length(reason) not between 1 and 500 then raise exception 'INVALID_APPEAL_REASON';end if;
  if p_action='revoke' then
   select * into event from S.booking_no_show_events where booking_id=(p_body->>'bookingId')::uuid;
   if not found then raise exception 'BOOKING_NOT_FOUND';end if;
   perform 1 from S.members where id=event.member_id for update;
   update S.booking_no_show_events set revoked_at=clock_timestamp(),revoked_by=p_actor,revoke_reason=reason where booking_id=event.booking_id and revoked_at is null;
   get diagnostics changed=row_count;
   if changed>0 then
    for r in select * from S.booking_restrictions where member_id=event.member_id and revoked_at is null and ends_at>clock_timestamp() for update loop
     if (select count(*) from S.booking_no_show_events e where e.member_id=r.member_id and e.revoked_at is null and e.marked_at>=(r.policy_snapshot->>'recording_since')::timestamptz
      and e.occurred_at between r.starts_at-make_interval(days=>(r.policy_snapshot->>'lookback_days')::integer) and r.starts_at)<(r.policy_snapshot->>'threshold_count')::integer then
      update S.booking_restrictions set revoked_at=clock_timestamp(),revoked_by=p_actor,revoke_reason=reason where id=r.id;
     end if;
    end loop;
   end if;
  elsif p_action='release' then
   select * into r from S.booking_restrictions where id=(p_body->>'restrictionId')::uuid;
   if not found then raise exception 'BOOKING_NOT_FOUND';end if;
   perform 1 from S.members where id=r.member_id for update;
   update S.booking_restrictions set revoked_at=clock_timestamp(),revoked_by=p_actor,revoke_reason=reason where id=r.id and revoked_at is null;
   get diagnostics changed=row_count;
  else
   update S.booking_restriction_appeals set resolved_at=clock_timestamp(),resolved_by=p_actor,resolution=reason where id=(p_body->>'appealId')::uuid and resolved_at is null;
   get diagnostics changed=row_count;
  end if;
  if changed>0 then insert into S.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
   values(p_actor,'admin','BOOKING_RISK_'||upper(p_action),'booking_risk',coalesce(p_body->>'bookingId',p_body->>'restrictionId',p_body->>'appealId'),'success',jsonb_build_object('reason',reason));end if;
 elsif p_action<>'get' then raise exception 'INVALID_INPUT';end if;
 return jsonb_build_object('policy',(select to_jsonb(p) from S.booking_no_show_policy p where id),
 'events',(select coalesce(jsonb_agg(to_jsonb(e)),'[]') from (select e.*,m.member_code,m.display_name from S.booking_no_show_events e join S.members m on m.id=e.member_id order by marked_at desc limit 100)e),
 'restrictions',(select coalesce(jsonb_agg(to_jsonb(rs)),'[]') from (select * from S.booking_restrictions order by starts_at desc limit 100)rs),
 'appeals',(select coalesce(jsonb_agg(to_jsonb(a)),'[]') from (select * from S.booking_restriction_appeals order by created_at desc limit 100)a));
end $$;
revoke all on function S.booking_active_restriction(uuid,timestamptz),S.booking_enforce_restriction(),S.booking_record_no_show(),S.booking_no_show_status(text),S.booking_no_show_appeal(text,text),S.admin_booking_no_show(text,text,jsonb) from public,anon,authenticated;
grant execute on function S.booking_active_restriction(uuid,timestamptz),S.booking_enforce_restriction(),S.booking_record_no_show(),S.booking_no_show_status(text),S.booking_no_show_appeal(text,text),S.admin_booking_no_show(text,text,jsonb) to service_role;
$ddl$,'S.',quote_ident(p_schema)||'.');
end $install$;
revoke all on function platform_private.install_booking_risk(text) from public,anon,authenticated,service_role;
do $$declare t record;begin
 for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop perform platform_private.install_booking_risk(t.runtime_schema);end loop;
end $$;
-- Apply exactly the same additive migration to newly approved businesses.
alter function public.platform_provision_business(uuid) rename to platform_provision_business_base_20261021;
revoke all on function public.platform_provision_business_base_20261021(uuid) from public,anon,authenticated,service_role;
create function public.platform_provision_business(p_tenant_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s text;begin
 perform public.platform_provision_business_base_20261021(p_tenant_id);
 select runtime_schema into strict s from platform_private.tenants where id=p_tenant_id;
 perform platform_private.install_booking_risk(s);
end $$;
revoke all on function public.platform_provision_business(uuid) from public,anon,authenticated;
grant execute on function public.platform_provision_business(uuid) to service_role;
notify pgrst,'reload schema';
commit;
