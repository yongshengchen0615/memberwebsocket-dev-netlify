begin;
-- Retain only a hash and timestamp after cleanup to reject pre-removal tokens.
-- No deleted member identity, name, phone, token or file list survives completion.
create table public.member_removal_jobs (
  id uuid primary key default gen_random_uuid(),
  identity_hash text not null unique check(identity_hash ~ '^[a-f0-9]{64}$'),
  member_id uuid,
  run_ids uuid[] not null default '{}',
  artifact_paths text[] not null default '{}',
  state text not null default 'deleting' check(state in ('deleting','complete')),
  revoked_before timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);
alter table public.member_removal_jobs enable row level security;
revoke all on public.member_removal_jobs from public,anon,authenticated;
grant select,insert,update,delete on public.member_removal_jobs to service_role;
alter table public.bookings alter column member_id drop not null;
alter table public.friend_booking_rewards alter column actor_member_id drop not null;
alter table public.friend_booking_rewards alter column recipient_member_id drop not null;
alter table public.point_transfers alter column sender_member_id drop not null;
alter table public.point_transfers alter column receiver_member_id drop not null;

create function public.member_removal_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare value uuid; col text; record_json jsonb:=to_jsonb(new); j uuid;
begin
  foreach col in array tg_argv loop
    value := nullif(record_json->>col,'')::uuid;
    if value is null then continue; end if;
    perform 1 from members where id=value for key share;
    select id into j from member_removal_jobs where member_id=value and state='deleting';
    if j is not null and coalesce(current_setting('membership.removal_job',true),'')<>j::text then
      raise exception 'MEMBER_REMOVED';
    end if;
  end loop;
  return new;
end; $$;
-- Every actual member FK participates in the barrier, including future writes by
-- receipt finalization, grants, background jobs, friendship and transfer RPCs.
do $$ declare r record; args text; begin
 for r in select c.relname, array_agg(distinct a.attname) cols
   from pg_constraint k join pg_class c on c.oid=k.conrelid
   join pg_attribute a on a.attrelid=k.conrelid and a.attnum=any(k.conkey)
   where k.contype='f' and k.confrelid='public.members'::regclass group by c.relname loop
   select string_agg(quote_literal(x),',') into args from unnest(r.cols) x;
   execute format('create trigger member_removal_write_guard before insert or update on public.%I for each row execute function public.member_removal_guard(%s)',r.relname,args);
 end loop;
end $$;
create function public.member_removal_identity_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare j uuid; removed_before timestamptz; job_state text;
begin
 perform pg_advisory_xact_lock(hashtextextended('member-removal:'||encode(extensions.digest(new.line_user_id,'sha256'),'hex'),0));
 select id,revoked_before,state into j,removed_before,job_state from member_removal_jobs where identity_hash=encode(extensions.digest(new.line_user_id,'sha256'),'hex');
 if j is not null and coalesce(current_setting('membership.removal_job',true),'')<>j::text then
  if job_state='deleting' or not exists(select 1 from member_login_sessions where line_user_id=new.line_user_id and latest_token_iat_ms > extract(epoch from removed_before)*1000) then raise exception 'MEMBER_REMOVED'; end if;
 end if;
 return new;
end; $$;
create trigger member_removal_identity_guard before insert or update on public.members for each row execute function public.member_removal_identity_guard();

-- Storage API inserts metadata even for an already-issued signed upload URL.
-- A completed removal has no member row, so old upload URLs cannot resurrect files.
create function public.member_receipt_upload_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare owner_id uuid;
begin
 if new.bucket_id<>'booking-receipts' then return new; end if;
 if split_part(new.name,'/',1) !~ '^[a-f0-9-]{36}$' then raise exception 'RECEIPT_OWNER_REQUIRED'; end if;
 owner_id:=split_part(new.name,'/',1)::uuid;
 perform 1 from members where id=owner_id and status='active' for key share;
 if not found or exists(select 1 from member_removal_jobs where member_id=owner_id and state='deleting') then raise exception 'MEMBER_REMOVED'; end if;
 return new;
end; $$;
create trigger member_receipt_upload_guard before insert or update of name,bucket_id on storage.objects for each row execute function public.member_receipt_upload_guard();

create function public.member_login_removal_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from member_removal_jobs where identity_hash=encode(extensions.digest(new.line_user_id,'sha256'),'hex') and (state<>'complete' or new.latest_token_iat_ms <= extract(epoch from revoked_before)*1000)) then raise exception 'MEMBER_REMOVED'; end if;
 return new;
end; $$;
create trigger member_login_removal_guard before insert or update on public.member_login_sessions for each row execute function public.member_login_removal_guard();

create function public.begin_member_removal(p_actor text,p_target text,p_confirm_code text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare m members%rowtype; j member_removal_jobs%rowtype; h text:=encode(extensions.digest(p_target,'sha256'),'hex');
begin
 if not exists(select 1 from admins where line_user_id=p_actor and role='admin' and status='active') then raise exception 'ADMIN_REQUIRED'; end if;
 if p_actor=p_target or exists(select 1 from admins where line_user_id=p_target) then raise exception 'ADMIN_PROTECTED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('member-removal:'||h,0));
 select * into m from members where line_user_id=p_target for update;
 select * into j from member_removal_jobs where identity_hash=h for update;
 if m.id is null then
   if j.state='complete' then return jsonb_build_object('jobId',j.id,'state','complete'); end if;
   raise exception 'MEMBER_NOT_FOUND';
 end if;
 if exists(select 1 from test_execution_leases where expires_at>clock_timestamp()) and m.is_test_account then raise exception 'E2E_ACTIVE'; end if;
 if m.member_code is distinct from p_confirm_code then raise exception 'CONFIRMATION_MISMATCH'; end if;
 if j.id is not null and j.state='deleting' then return jsonb_build_object('jobId',j.id,'state',j.state,'memberId',j.member_id); end if;
 insert into member_removal_jobs(identity_hash,member_id,state,revoked_before,completed_at)
 values(h,m.id,'deleting',clock_timestamp(),null)
 on conflict(identity_hash) do update set member_id=excluded.member_id,state='deleting',revoked_before=excluded.revoked_before,completed_at=null returning * into j;
 update member_removal_jobs set run_ids=coalesce((select array_agg(distinct run_id) from automation_test_cases where member_id=m.id),'{}'::uuid[]) where id=j.id;
 update member_removal_jobs set artifact_paths=coalesce((select array_agg(distinct o.name) from storage.objects o join automation_test_runs r on r.id=any((select run_ids from member_removal_jobs where id=j.id)::uuid[]) where o.bucket_id='e2e-failure-artifacts' and (o.name like 'runs/'||r.run_code||'--%' or (nullif(r.summary->>'rootRunId','') is not null and o.name like 'runs/'||(r.summary->>'rootRunId')||'--%') or exists(select 1 from jsonb_path_query(r.summary,'$.**.path') path where path#>>'{}'=o.name))),'{}'::text[]) where id=j.id;
 perform set_config('membership.removal_job',j.id::text,true);
 update members set status='disabled',force_logout_after=j.revoked_before,updated_at=now() where id=m.id;
 delete from member_login_token_grants where line_user_id=p_target;
 delete from member_login_sessions where line_user_id=p_target;
 update test_login_sessions set revoked_at=clock_timestamp(),revoked_reason='member_removed' where member_id=m.id;
 update member_presence_sessions set offline_at=clock_timestamp(),offline_reason='member_removed' where member_id=m.id;
 insert into realtime_events(scope,event_type) values('all','member.removal.started');
 return jsonb_build_object('jobId',j.id,'state',j.state,'memberId',m.id);
end; $$;

create function public.member_removal_storage_paths(p_actor text,p_job_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare mid uuid; paths text[];
begin
 if not exists(select 1 from admins where line_user_id=p_actor and role='admin' and status='active') then raise exception 'ADMIN_REQUIRED'; end if;
 select member_id,artifact_paths into mid,paths from member_removal_jobs where id=p_job_id and state='deleting';
 if mid is null then return '[]'::jsonb; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('bucket',bucket_id,'path',name)) from (select bucket_id,name from storage.objects where (bucket_id='booking-receipts' and name like mid::text||'/%') or (bucket_id='e2e-failure-artifacts' and name=any(paths)) limit 100) s),'[]'::jsonb);
end; $$;

create function public.finish_member_removal(p_actor text,p_job_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare j member_removal_jobs%rowtype; m members%rowtype; bids uuid[]; r record;
begin
 if not exists(select 1 from admins where line_user_id=p_actor and role='admin' and status='active') then raise exception 'ADMIN_REQUIRED'; end if;
 select * into j from member_removal_jobs where id=p_job_id;
 if not found then raise exception 'REMOVAL_JOB_NOT_FOUND'; end if;
 perform pg_advisory_xact_lock(hashtextextended('member-removal:'||j.identity_hash,0));
 select * into j from member_removal_jobs where id=p_job_id for update;
 if not found then raise exception 'REMOVAL_JOB_NOT_FOUND'; end if;
 if j.state='complete' then return jsonb_build_object('jobId',j.id,'state','complete','alreadyApplied',true); end if;
 select * into m from members where id=j.member_id for update;
 if not found then raise exception 'REMOVAL_MEMBER_MISSING'; end if;
 if exists(select 1 from storage.objects where (bucket_id='booking-receipts' and name like m.id::text||'/%') or (bucket_id='e2e-failure-artifacts' and name=any(j.artifact_paths))) then raise exception 'REMOVAL_STORAGE_PENDING'; end if;
 perform set_config('membership.removal_job',j.id::text,true);
 select coalesce(array_agg(id),'{}'::uuid[]) into bids from bookings where member_id=m.id or service_recipient_member_id=m.id;
 -- The surviving side retains its asset and transaction reference, not deleted PII.
 update point_transfers set sender_member_id=null,request_id='removed-'||id::text where sender_member_id=m.id;
 update point_transfers set receiver_member_id=null where receiver_member_id=m.id;
 delete from point_transfers where sender_member_id is null and receiver_member_id is null;
 update friend_booking_rewards set actor_member_id=null where actor_member_id=m.id;
 update friend_booking_rewards set recipient_member_id=null where recipient_member_id=m.id;
 delete from friend_booking_rewards where actor_member_id is null and recipient_member_id is null;
 update point_entries set created_by='removed-member',note='會員關聯已移除',request_id=null where member_id<>m.id and (created_by=m.line_user_id or reference_id in (select transfer_id from point_transfers where sender_member_id is null or receiver_member_id is null));
 update service_time_entries set created_by='removed-member',note='會員關聯已移除',request_id=null where member_id<>m.id and created_by=m.line_user_id;
 delete from booking_ticket_usage_requests where member_id=m.id;
 delete from booking_benefit_selections where member_id=m.id;
 delete from scheduled_grant_messages where member_id=m.id;
 delete from booking_receipts where member_id=m.id;
 delete from booking_receipt_cleanup_queue where object_path like m.id::text||'/%';
 delete from fixed_ticket_grants where member_id=m.id;
 delete from event_ticket_claims where member_id=m.id;
 delete from point_tickets where member_id=m.id;
 delete from point_entries where member_id=m.id;
 delete from point_balances where member_id=m.id;
 delete from service_time_entries where member_id=m.id;
 delete from service_grant_requests where member_id=m.id;
 delete from booking_completion_settlements where member_id=m.id;
 delete from member_referrals where inviter_member_id=m.id or invitee_member_id=m.id;
 delete from member_friendships where member_a=m.id or member_b=m.id or requested_by=m.id;
 delete from test_login_sessions where member_id=m.id;
 delete from member_presence_sessions where member_id=m.id;
 delete from membership_consents where member_id=m.id;
 delete from membership_terms where e2e_member_id=m.id;
 -- Single-owner bookings disappear. Shared bookings survive without the removed
 -- side. Pending bookings for a removed service recipient are cancelled to prevent
 -- awarding that recipient's service to the surviving booker.
 delete from bookings where (member_id=m.id and (service_recipient_member_id is null or service_recipient_member_id=m.id)) or (member_id is null and service_recipient_member_id=m.id);
 update bookings set status='cancelled',cancellation_requested_at=coalesce(cancellation_requested_at,clock_timestamp()),
   cancellation_requested_by=coalesce(cancellation_requested_by,p_actor),cancellation_source_status=coalesce(cancellation_source_status,status),cancellation_reviewed_at=clock_timestamp(),
   cancellation_reviewed_by=p_actor,cancellation_decision='approved',cancelled_at=clock_timestamp(),cancelled_by=p_actor
 where id=any(bids) and status in ('pending','confirmed') and (service_recipient_member_id=m.id or (cancellation_requested_at is not null and cancellation_reviewed_at is null));
 update bookings set
   member_note='',admin_note='',contact_source='custom',contact_surname=null,contact_salutation=null,contact_phone=null,
   member_id=case when member_id=m.id then null else member_id end,
   service_recipient_member_id=case when service_recipient_member_id=m.id then null else service_recipient_member_id end
 where id=any(bids);
 -- Remove identity-bearing diagnostic payloads and deduplication responses.
 delete from idempotency_results where actor_line_user_id=m.line_user_id or result::text like '%'||m.line_user_id||'%' or result::text like '%'||m.id::text||'%';
 delete from audit_logs where actor_line_user_id=m.line_user_id or target_id in (m.line_user_id,m.id::text,m.member_code) or detail::text like '%'||m.line_user_id||'%' or detail::text like '%'||m.id::text||'%' or detail::text like '%'||m.member_code||'%';
 delete from booking_audit_events where actor_line_user_id=m.line_user_id or target_id=m.id::text or target_id=any(bids::text[]) or metadata::text like '%'||m.line_user_id||'%' or metadata::text like '%'||m.id::text||'%';
 delete from idempotency_results i where exists(select 1 from unnest(bids) bid where i.result::text like '%'||bid::text||'%');
 delete from api_rate_limits where principal_hash=encode(extensions.digest(m.line_user_id,'sha256'),'hex');
 -- Clear actor fields wherever schema inspection found member identity text. The
 -- target cannot be an administrator, so these are user-originated references.
 for r in select table_name,column_name from information_schema.columns where table_schema='public' and data_type='text' and column_name in ('created_by','updated_by','completed_by','confirmed_by','rejected_by','cancelled_by','redeemed_by','cancellation_requested_by','cancellation_reviewed_by') loop
   execute format('update public.%I set %I=$1 where %I=$2',r.table_name,r.column_name,r.column_name) using 'removed-member',m.line_user_id;
 end loop;
 delete from automation_test_runs where id=any(j.run_ids);
 delete from members where id=m.id;
 -- A missed RESTRICT relation aborts the transaction instead of partial success.
 update member_removal_jobs set member_id=null,run_ids='{}',artifact_paths='{}',state='complete',completed_at=clock_timestamp() where id=j.id;
 insert into audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
 values(new_public_id('AUD'),p_actor,'admin','MEMBER_REMOVAL_COMPLETE','removal_job',j.id::text,'success',jsonb_build_object('state','complete'));
 insert into realtime_events(scope,event_type) values('all','member.removal.complete');
 return jsonb_build_object('jobId',j.id,'state','complete','alreadyApplied',false);
end; $$;
revoke all on function public.member_removal_guard(),public.member_removal_identity_guard(),public.member_receipt_upload_guard(),public.member_login_removal_guard(),public.begin_member_removal(text,text,text),public.member_removal_storage_paths(text,uuid),public.finish_member_removal(text,uuid) from public,anon,authenticated;
grant execute on function public.begin_member_removal(text,text,text),public.member_removal_storage_paths(text,uuid),public.finish_member_removal(text,uuid) to service_role;
CREATE OR REPLACE FUNCTION public.member_login_claim(
  p_line_user_id text,
  p_browser_hash text,
  p_token_hash text,
  p_issued_at_ms bigint,
  p_mode text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE current_session public.member_login_sessions%ROWTYPE;
DECLARE outcome text := 'resumed';
BEGIN
  IF length(p_line_user_id) < 2 OR length(p_line_user_id) > 120
    OR p_browser_hash !~ '^[a-f0-9]{64}$'
    OR p_token_hash !~ '^[a-f0-9]{64}$'
    OR p_issued_at_ms IS NULL OR p_issued_at_ms <= 0
    OR p_mode NOT IN ('login', 'resume') THEN
    RAISE EXCEPTION 'invalid login claim';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-removal:'||pg_catalog.encode(extensions.digest(p_line_user_id,'sha256'),'hex'),0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_line_user_id, 161083));
  SELECT * INTO current_session FROM public.member_login_sessions
    WHERE line_user_id = p_line_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.member_login_sessions (line_user_id,browser_hash,latest_token_iat_ms)
    VALUES (p_line_user_id,p_browser_hash,p_issued_at_ms);
    outcome := 'claimed';
  ELSIF current_session.browser_hash IS DISTINCT FROM p_browser_hash THEN
    IF p_mode <> 'login' OR p_issued_at_ms <= current_session.latest_token_iat_ms THEN
      RETURN 'session_replaced';
    END IF;
    DELETE FROM public.member_login_token_grants WHERE line_user_id = p_line_user_id;
    UPDATE public.member_login_sessions
    SET browser_hash = p_browser_hash, latest_token_iat_ms = p_issued_at_ms,
        generation = generation + 1, claimed_at = now(), updated_at = now()
    WHERE line_user_id = p_line_user_id;
    outcome := 'replaced';
  ELSE
    UPDATE public.member_login_sessions
      SET latest_token_iat_ms = greatest(latest_token_iat_ms,p_issued_at_ms),updated_at=now()
      WHERE line_user_id = p_line_user_id;
  END IF;
  INSERT INTO public.member_login_token_grants(token_hash,line_user_id)
  VALUES (p_token_hash,p_line_user_id)
  ON CONFLICT (token_hash) DO NOTHING;
  IF outcome = 'replaced' THEN
    INSERT INTO public.realtime_events(scope,event_type) VALUES('all','member.login.replaced');
  END IF;
  RETURN outcome;
END;
$$;
REVOKE ALL ON FUNCTION public.member_login_claim(text,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.member_login_claim(text,text,text,bigint,text) TO service_role;


commit;
