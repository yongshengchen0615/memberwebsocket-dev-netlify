-- Fixed recurring event tickets: birthday-month, yearly, monthly, weekly.
-- Existing event ticket redemption remains the source of truth; each recurrence cycle
-- materializes one event_tickets row and one claim per eligible member.

create table if not exists public.fixed_ticket_templates (
  id uuid primary key default gen_random_uuid(),
  fixed_ticket_id text not null unique,
  title text not null check (char_length(title) between 1 and 100),
  description text not null default '' check (char_length(description) <= 240),
  usage_method text not null default '' check (char_length(usage_method) <= 120),
  usage_instructions text not null default '' check (char_length(usage_instructions) <= 500),
  status text not null default 'draft' check (status in ('active','draft','archived')),
  schedule_type text not null check (schedule_type in ('birthday_month','yearly','monthly','weekly')),
  schedule_month smallint,
  schedule_day smallint,
  schedule_weekday smallint,
  quota integer not null default 0 check (quota between 0 and 1000000),
  accent text not null default '#df6b4d' check (accent ~ '^#[0-9A-Fa-f]{6}$'),
  allowed_tier_keys text[] not null default array['general','silver','gold','platinum']::text[],
  notify_line boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_by text not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint fixed_ticket_templates_schedule_check check (
    (schedule_type = 'birthday_month' and schedule_month is null and schedule_day is null and schedule_weekday is null)
    or
    (schedule_type = 'yearly' and schedule_month between 1 and 12 and schedule_day between 1 and 31 and schedule_weekday is null)
    or
    (schedule_type = 'monthly' and schedule_month is null and schedule_day between 1 and 31 and schedule_weekday is null)
    or
    (schedule_type = 'weekly' and schedule_month is null and schedule_day is null and schedule_weekday between 1 and 7)
  )
);

alter table public.fixed_ticket_templates enable row level security;
revoke all on public.fixed_ticket_templates from anon, authenticated;
grant all on public.fixed_ticket_templates to service_role;

alter table public.event_tickets
  add column if not exists fixed_ticket_template_id uuid references public.fixed_ticket_templates(id) on delete restrict,
  add column if not exists fixed_cycle_key text;

create unique index if not exists event_tickets_fixed_template_cycle_uidx
  on public.event_tickets(fixed_ticket_template_id, fixed_cycle_key)
  where fixed_ticket_template_id is not null and fixed_cycle_key is not null;

create table if not exists public.fixed_ticket_grants (
  id uuid primary key default gen_random_uuid(),
  fixed_ticket_template_id uuid not null references public.fixed_ticket_templates(id) on delete restrict,
  member_id uuid not null references public.members(id) on delete restrict,
  cycle_key text not null,
  cycle_start date not null,
  cycle_end date not null,
  event_ticket_id uuid references public.event_tickets(id) on delete restrict,
  claim_id text,
  status text not null default 'reserved' check (status in ('reserved','issued','failed')),
  notification_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fixed_ticket_template_id, member_id, cycle_key),
  unique (claim_id)
);

create index if not exists fixed_ticket_grants_member_cycle_idx
  on public.fixed_ticket_grants(member_id, cycle_start desc, cycle_end desc);
create index if not exists fixed_ticket_grants_template_cycle_idx
  on public.fixed_ticket_grants(fixed_ticket_template_id, cycle_key, status);
create index if not exists fixed_ticket_grants_event_ticket_idx
  on public.fixed_ticket_grants(event_ticket_id);

alter table public.fixed_ticket_grants enable row level security;
revoke all on public.fixed_ticket_grants from anon, authenticated;
grant all on public.fixed_ticket_grants to service_role;

create or replace function public.fixed_schedule_date(
  p_year integer,
  p_month integer,
  p_day integer
)
returns date
language plpgsql
immutable
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_first date;
  v_last_day integer;
begin
  v_first := make_date(p_year, p_month, 1);
  v_last_day := extract(day from (v_first + interval '1 month - 1 day'))::integer;
  return make_date(p_year, p_month, least(greatest(p_day, 1), v_last_day));
end;
$function$;

revoke all on function public.fixed_schedule_date(integer,integer,integer) from public, anon, authenticated;
grant execute on function public.fixed_schedule_date(integer,integer,integer) to service_role;

create or replace function public.issue_fixed_tickets(
  p_business_date date default ((now() at time zone 'Asia/Taipei')::date),
  p_member_id uuid default null,
  p_template_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_template public.fixed_ticket_templates%rowtype;
  v_member record;
  v_event public.event_tickets%rowtype;
  v_year integer;
  v_month integer;
  v_prev date;
  v_next date;
  v_candidate date;
  v_cycle_start date;
  v_cycle_end date;
  v_cycle_key text;
  v_title text;
  v_event_public_id text;
  v_grant_id uuid;
  v_claim_id text;
  v_claim_count integer;
  v_issued integer := 0;
  v_queued integer := 0;
  v_templates integer := 0;
begin
  -- Close previous recurring cycles before evaluating the current cycle.
  update public.event_ticket_claims c
  set status = 'expired', updated_at = now()
  from public.event_tickets e
  where c.event_ticket_id = e.id
    and e.fixed_ticket_template_id is not null
    and e.ends_on is not null
    and e.ends_on < p_business_date
    and c.status = 'claimed';

  update public.event_tickets
  set status = 'archived',
      updated_by = 'fixed-ticket-automation',
      updated_at = now()
  where fixed_ticket_template_id is not null
    and ends_on is not null
    and ends_on < p_business_date
    and status = 'active';

  for v_template in
    select *
    from public.fixed_ticket_templates
    where status = 'active'
      and deleted_at is null
      and (p_template_id is null or id = p_template_id)
    order by created_at, id
  loop
    v_templates := v_templates + 1;
    v_year := extract(year from p_business_date)::integer;
    v_month := extract(month from p_business_date)::integer;

    if v_template.schedule_type = 'birthday_month' then
      -- Birthday benefit is issued on the first day of the member's birthday month
      -- and remains valid through month end. Daily checks allow catch-up issuance for
      -- members joining after the first, while the grant unique key prevents duplicates.
      v_cycle_start := date_trunc('month', p_business_date)::date;
      v_cycle_end := (date_trunc('month', p_business_date) + interval '1 month - 1 day')::date;
      v_cycle_key := 'birthday:' || to_char(v_cycle_start, 'YYYY-MM');
    elsif v_template.schedule_type = 'weekly' then
      v_cycle_start := p_business_date - (((extract(isodow from p_business_date)::integer - v_template.schedule_weekday + 7) % 7))::integer;
      v_cycle_end := v_cycle_start + 6;
      v_cycle_key := 'week:' || to_char(v_cycle_start, 'IYYY-IW');
    elsif v_template.schedule_type = 'monthly' then
      v_candidate := public.fixed_schedule_date(v_year, v_month, v_template.schedule_day);
      if p_business_date < v_candidate then
        v_prev := (date_trunc('month', p_business_date) - interval '1 month')::date;
        v_cycle_start := public.fixed_schedule_date(
          extract(year from v_prev)::integer,
          extract(month from v_prev)::integer,
          v_template.schedule_day
        );
      else
        v_cycle_start := v_candidate;
      end if;
      v_next := (date_trunc('month', v_cycle_start) + interval '1 month')::date;
      v_cycle_end := public.fixed_schedule_date(
        extract(year from v_next)::integer,
        extract(month from v_next)::integer,
        v_template.schedule_day
      ) - 1;
      v_cycle_key := 'month:' || to_char(v_cycle_start, 'YYYY-MM');
    else
      v_candidate := public.fixed_schedule_date(v_year, v_template.schedule_month, v_template.schedule_day);
      if p_business_date < v_candidate then
        v_cycle_start := public.fixed_schedule_date(v_year - 1, v_template.schedule_month, v_template.schedule_day);
      else
        v_cycle_start := v_candidate;
      end if;
      v_cycle_end := public.fixed_schedule_date(
        extract(year from v_cycle_start)::integer + 1,
        v_template.schedule_month,
        v_template.schedule_day
      ) - 1;
      v_cycle_key := 'year:' || extract(year from v_cycle_start)::integer::text;
    end if;

    v_title := replace(
      replace(v_template.title, '{year}', extract(year from v_cycle_start)::integer::text),
      '{month}', extract(month from v_cycle_start)::integer::text
    );
    v_event_public_id := 'FIXED-' || v_template.fixed_ticket_id || '-' || replace(replace(v_cycle_key, ':', '-'), '/', '-');

    insert into public.event_tickets(
      event_ticket_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,
      starts_on,ends_on,quota,accent,allowed_tier_keys,created_by,updated_by,activity_url,activity_link_name,
      fixed_ticket_template_id,fixed_cycle_key
    ) values (
      v_event_public_id,v_title,'coupon',v_template.description,v_template.usage_method,v_template.usage_instructions,
      '[]'::jsonb,'active',v_cycle_start,v_cycle_end,v_template.quota,lower(v_template.accent),
      v_template.allowed_tier_keys,'fixed-ticket-automation','fixed-ticket-automation','','',v_template.id,v_cycle_key
    )
    on conflict (fixed_ticket_template_id, fixed_cycle_key)
      where fixed_ticket_template_id is not null and fixed_cycle_key is not null
    do update set
      title = excluded.title,
      description = excluded.description,
      usage_method = excluded.usage_method,
      usage_instructions = excluded.usage_instructions,
      status = 'active',
      starts_on = excluded.starts_on,
      ends_on = excluded.ends_on,
      quota = excluded.quota,
      accent = excluded.accent,
      allowed_tier_keys = excluded.allowed_tier_keys,
      updated_by = 'fixed-ticket-automation',
      updated_at = now(),
      deleted_at = null
    returning * into v_event;

    for v_member in
      select m.id, m.line_user_id, m.display_name, m.birthday
      from public.members m
      where m.status = 'active'
        and m.membership_status = 'active'
        and (p_member_id is null or m.id = p_member_id)
        and (
          v_template.schedule_type <> 'birthday_month'
          or (m.birthday is not null and extract(month from m.birthday)::integer = extract(month from v_cycle_start)::integer)
        )
        and public.current_tier_key(m.id) = any(v_template.allowed_tier_keys)
      order by coalesce(m.joined_at, m.created_at), m.id
    loop
      if v_template.quota > 0 then
        select count(*)::integer into v_claim_count
        from public.event_ticket_claims
        where event_ticket_id = v_event.id;
        exit when v_claim_count >= v_template.quota;
      end if;

      v_grant_id := null;
      insert into public.fixed_ticket_grants(
        fixed_ticket_template_id,member_id,cycle_key,cycle_start,cycle_end,event_ticket_id,status
      ) values (
        v_template.id,v_member.id,v_cycle_key,v_cycle_start,v_cycle_end,v_event.id,'reserved'
      )
      on conflict (fixed_ticket_template_id, member_id, cycle_key) do nothing
      returning id into v_grant_id;

      -- Already received in this cycle, including an unused claim: do not issue again.
      if v_grant_id is null then continue; end if;

      v_claim_id := public.new_public_id('EC');
      insert into public.event_ticket_claims(
        claim_id,event_ticket_id,member_id,ticket_type,ticket_title,ticket_description,
        usage_method,usage_instructions,prizes,status,claimed_at
      ) values (
        v_claim_id,v_event.id,v_member.id,'coupon',v_event.title,v_event.description,
        v_event.usage_method,v_event.usage_instructions,'[]'::jsonb,'claimed',now()
      )
      on conflict (event_ticket_id, member_id) do nothing;

      select c.claim_id into v_claim_id
      from public.event_ticket_claims c
      where c.event_ticket_id = v_event.id
        and c.member_id = v_member.id
      limit 1;

      if v_claim_id is null then
        update public.fixed_ticket_grants
        set status = 'failed',
            notification_error = 'CLAIM_CREATE_FAILED',
            updated_at = now()
        where id = v_grant_id;
        continue;
      end if;

      update public.fixed_ticket_grants
      set claim_id = v_claim_id,
          status = 'issued',
          notification_error = '',
          updated_at = now()
      where id = v_grant_id;
      v_issued := v_issued + 1;

      if v_template.notify_line then
        insert into public.scheduled_grant_messages(
          schedule_id,request_id,member_id,line_user_id,scheduled_for,message_text,status,created_by
        ) values (
          'FIXED-' || v_template.fixed_ticket_id || '-' || replace(v_cycle_key, ':', '-') || '-' || v_member.id::text,
          'FIXED-' || v_template.fixed_ticket_id || '-' || replace(v_cycle_key, ':', '-') || '-' || v_member.id::text,
          v_member.id,
          v_member.line_user_id,
          now(),
          (case when v_template.schedule_type = 'birthday_month' then '🎂 ' else '🎁 ' end) ||
          coalesce(nullif(v_member.display_name, ''), '會員') || '，你已獲得「' || v_event.title || '」' || E'\n\n' ||
          v_event.description || E'\n\n' ||
          '使用期限：' || to_char(v_cycle_start, 'YYYY/MM/DD') || ' ～ ' || to_char(v_cycle_end, 'YYYY/MM/DD'),
          'pending',
          'fixed-ticket-automation'
        )
        on conflict (request_id) do nothing;
        if found then v_queued := v_queued + 1; end if;
      end if;

      insert into public.audit_logs(
        audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
      ) values (
        public.new_public_id('AUD'),
        'system',
        'system',
        'fixed_ticket.issue',
        'member',
        v_member.line_user_id,
        'success',
        jsonb_build_object(
          'fixedTicketId',v_template.fixed_ticket_id,
          'scheduleType',v_template.schedule_type,
          'cycleKey',v_cycle_key,
          'cycleStart',v_cycle_start,
          'cycleEnd',v_cycle_end,
          'eventTicketId',v_event.event_ticket_id,
          'claimId',v_claim_id
        )
      );
    end loop;
  end loop;

  return jsonb_build_object(
    'businessDate',p_business_date,
    'templatesChecked',v_templates,
    'issued',v_issued,
    'queued',v_queued
  );
end;
$function$;

revoke all on function public.issue_fixed_tickets(date,uuid,uuid) from public, anon, authenticated;
grant execute on function public.issue_fixed_tickets(date,uuid,uuid) to service_role;

-- Fixed tickets are system-issued only. Members can still redeem their own issued claim,
-- but cannot call the existing claim endpoint to manufacture a fixed-cycle claim.
create or replace function public.claim_event_ticket(p_line_user_id text, p_event_ticket_id text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_member public.members%rowtype;
  v_event public.event_tickets%rowtype;
  v_tier text;
  v_claim_id text;
  v_today date := (now() at time zone 'Asia/Taipei')::date;
  v_count integer;
begin
  select * into v_member from public.members
  where line_user_id=p_line_user_id and membership_status='active' and status='active';
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select * into v_event from public.event_tickets
  where event_ticket_id=p_event_ticket_id and deleted_at is null for update;
  if not found or v_event.status <> 'active' then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
  if v_event.fixed_ticket_template_id is not null then raise exception 'FIXED_TICKET_AUTO_ONLY'; end if;
  if v_event.starts_on is not null and v_today < v_event.starts_on then raise exception 'EVENT_NOT_STARTED'; end if;
  if v_event.ends_on is not null and v_today > v_event.ends_on then raise exception 'EVENT_ENDED'; end if;

  v_tier := public.current_tier_key(v_member.id);
  if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception 'TIER_NOT_ALLOWED'; end if;

  if v_event.quota > 0 then
    select count(*)::integer into v_count
    from public.event_ticket_claims
    where event_ticket_id=v_event.id;
    if v_count >= v_event.quota then raise exception 'EVENT_QUOTA_REACHED'; end if;
  end if;

  select claim_id into v_claim_id
  from public.event_ticket_claims
  where event_ticket_id=v_event.id and member_id=v_member.id;
  if found then return jsonb_build_object('claimId',v_claim_id,'alreadyClaimed',true); end if;

  v_claim_id := public.new_public_id('EC');
  insert into public.event_ticket_claims(
    claim_id,event_ticket_id,member_id,ticket_type,ticket_title,ticket_description,
    usage_method,usage_instructions,prizes
  ) values(
    v_claim_id,v_event.id,v_member.id,v_event.ticket_type,v_event.title,v_event.description,
    v_event.usage_method,v_event.usage_instructions,v_event.prizes
  );

  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result)
  values(public.new_public_id('AUD'),v_member.line_user_id,'member','user.event.ticket.claim','event_ticket',v_event.event_ticket_id,'success');
  return jsonb_build_object('claimId',v_claim_id);
end;
$function$;

revoke all on function public.claim_event_ticket(text,text) from public, anon, authenticated;
grant execute on function public.claim_event_ticket(text,text) to service_role;

-- Catch up a newly activated member immediately. In birthday month this means a member
-- joining after the first still receives the current birthday benefit if not already issued.
create or replace function public.backfill_fixed_tickets_for_member()
returns trigger
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
begin
  if new.status = 'active'
     and new.membership_status = 'active'
     and new.birthday is not null
     and (
       tg_op = 'INSERT'
       or old.membership_status is distinct from new.membership_status
       or old.status is distinct from new.status
       or old.birthday is distinct from new.birthday
     )
  then
    perform public.issue_fixed_tickets((now() at time zone 'Asia/Taipei')::date,new.id,null);
  end if;
  return new;
end;
$function$;

revoke all on function public.backfill_fixed_tickets_for_member() from public, anon, authenticated;

drop trigger if exists trg_members_backfill_fixed_tickets on public.members;
create trigger trg_members_backfill_fixed_tickets
after insert or update of membership_status, status, birthday on public.members
for each row execute function public.backfill_fixed_tickets_for_member();

-- Retire the previous standalone birthday automation without deleting its historical data.
update public.birthday_benefit_settings
set enabled = false,
    updated_by = 'fixed-ticket-migration',
    updated_at = now()
where singleton = true;

do $cron$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid
  from cron.job
  where jobname = 'issue-birthday-benefits'
  limit 1;
  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;

  select jobid into v_jobid
  from cron.job
  where jobname = 'issue-fixed-tickets'
  limit 1;
  if v_jobid is null then
    perform cron.schedule(
      'issue-fixed-tickets',
      '5 16 * * *',
      'select public.issue_fixed_tickets();'
    );
  end if;
end;
$cron$;
