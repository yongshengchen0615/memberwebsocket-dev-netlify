-- Birthday benefit automation.
-- Reuses event_tickets / event_ticket_claims so redemption keeps the existing security boundary.

create table if not exists public.birthday_benefit_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  title_template text not null default '🎂 {month}月壽星專屬優惠' check (char_length(title_template) between 1 and 100),
  description text not null default '生日快樂！這是你的當月專屬生日優惠。' check (char_length(description) between 1 and 240),
  usage_method text not null default '使用時請出示本活動票券。' check (char_length(usage_method) between 1 and 120),
  usage_instructions text not null default '限本人於生日當月使用一次，逾期失效。' check (char_length(usage_instructions) between 1 and 500),
  accent text not null default '#df6b4d' check (accent ~ '^#[0-9A-Fa-f]{6}$'),
  allowed_tier_keys text[] not null default array['general','silver','gold','platinum']::text[],
  notify_line boolean not null default true,
  updated_by text not null default 'system',
  updated_at timestamptz not null default now()
);

insert into public.birthday_benefit_settings(singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.birthday_benefit_settings enable row level security;
revoke all on public.birthday_benefit_settings from anon, authenticated;

create table if not exists public.birthday_benefit_grants (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete restrict,
  benefit_year integer not null check (benefit_year between 2000 and 2100),
  benefit_month integer not null check (benefit_month between 1 and 12),
  event_ticket_id uuid references public.event_tickets(id) on delete restrict,
  claim_id text,
  status text not null default 'reserved' check (status in ('reserved','issued','failed')),
  notified_at timestamptz,
  notification_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (member_id, benefit_year),
  unique (claim_id)
);

create index if not exists birthday_benefit_grants_year_month_idx
  on public.birthday_benefit_grants(benefit_year, benefit_month, status);

alter table public.birthday_benefit_grants enable row level security;
revoke all on public.birthday_benefit_grants from anon, authenticated;

create or replace function public.issue_birthday_benefits(
  p_business_date date default ((now() at time zone 'Asia/Taipei')::date)
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_settings public.birthday_benefit_settings%rowtype;
  v_year integer := extract(year from p_business_date)::integer;
  v_month integer := extract(month from p_business_date)::integer;
  v_month_start date := date_trunc('month', p_business_date)::date;
  v_month_end date := (date_trunc('month', p_business_date) + interval '1 month - 1 day')::date;
  v_ticket public.event_tickets%rowtype;
  v_title text;
  v_grant record;
  v_claim_id text;
  v_issued integer := 0;
  v_queued integer := 0;
  v_reserved integer := 0;
begin
  select * into v_settings
  from public.birthday_benefit_settings
  where singleton = true;

  if not found or not v_settings.enabled then
    return jsonb_build_object(
      'enabled', false,
      'businessDate', p_business_date,
      'issued', 0,
      'queued', 0
    );
  end if;

  if coalesce(array_length(v_settings.allowed_tier_keys, 1), 0) = 0 then
    raise exception 'BIRTHDAY_BENEFIT_INVALID_TIERS';
  end if;

  v_title := replace(v_settings.title_template, '{month}', v_month::text);

  insert into public.event_tickets(
    event_ticket_id,
    title,
    ticket_type,
    description,
    usage_method,
    usage_instructions,
    prizes,
    status,
    starts_on,
    ends_on,
    quota,
    accent,
    allowed_tier_keys,
    created_by,
    updated_by,
    activity_url,
    activity_link_name
  ) values (
    'BIRTHDAY-' || v_year::text || '-' || lpad(v_month::text, 2, '0'),
    v_title,
    'coupon',
    v_settings.description,
    v_settings.usage_method,
    v_settings.usage_instructions,
    '[]'::jsonb,
    'active',
    v_month_start,
    v_month_end,
    0,
    lower(v_settings.accent),
    v_settings.allowed_tier_keys,
    'birthday-automation',
    'birthday-automation',
    '',
    ''
  )
  on conflict (event_ticket_id) do update set
    title = excluded.title,
    description = excluded.description,
    usage_method = excluded.usage_method,
    usage_instructions = excluded.usage_instructions,
    status = 'active',
    starts_on = excluded.starts_on,
    ends_on = excluded.ends_on,
    accent = excluded.accent,
    allowed_tier_keys = excluded.allowed_tier_keys,
    updated_by = 'birthday-automation',
    updated_at = now(),
    deleted_at = null
  returning * into v_ticket;

  -- Reserve the yearly benefit before creating the claim. The unique key is the
  -- hard idempotency boundary even if birthday data changes later in the year.
  insert into public.birthday_benefit_grants(member_id, benefit_year, benefit_month, status)
  select m.id, v_year, v_month, 'reserved'
  from public.members m
  where m.status = 'active'
    and m.membership_status = 'active'
    and m.birthday is not null
    and extract(month from m.birthday)::integer = v_month
  on conflict (member_id, benefit_year) do nothing;

  get diagnostics v_reserved = row_count;

  for v_grant in
    select g.id as grant_id, g.member_id, m.line_user_id, m.display_name
    from public.birthday_benefit_grants g
    join public.members m on m.id = g.member_id
    where g.benefit_year = v_year
      and g.benefit_month = v_month
      and g.status = 'reserved'
    order by g.created_at
  loop
    v_claim_id := 'BTC-' || replace(gen_random_uuid()::text, '-', '');

    insert into public.event_ticket_claims(
      claim_id,
      event_ticket_id,
      member_id,
      ticket_type,
      ticket_title,
      ticket_description,
      usage_method,
      usage_instructions,
      prizes,
      status,
      claimed_at
    ) values (
      v_claim_id,
      v_ticket.id,
      v_grant.member_id,
      'coupon',
      v_ticket.title,
      v_ticket.description,
      v_ticket.usage_method,
      v_ticket.usage_instructions,
      '[]'::jsonb,
      'claimed',
      now()
    )
    on conflict (event_ticket_id, member_id) do nothing;

    select c.claim_id into v_claim_id
    from public.event_ticket_claims c
    where c.event_ticket_id = v_ticket.id
      and c.member_id = v_grant.member_id
    limit 1;

    if v_claim_id is null then
      update public.birthday_benefit_grants
      set status = 'failed',
          notification_error = 'CLAIM_CREATE_FAILED',
          updated_at = now()
      where id = v_grant.grant_id;
      continue;
    end if;

    update public.birthday_benefit_grants
    set event_ticket_id = v_ticket.id,
        claim_id = v_claim_id,
        status = 'issued',
        notification_error = '',
        updated_at = now()
    where id = v_grant.grant_id;

    v_issued := v_issued + 1;

    if v_settings.notify_line then
      insert into public.scheduled_grant_messages(
        schedule_id,
        request_id,
        member_id,
        line_user_id,
        scheduled_for,
        message_text,
        status,
        created_by
      ) values (
        'BIRTHDAY-' || v_year::text || '-' || v_grant.member_id::text,
        'BIRTHDAY-' || v_year::text || '-' || v_grant.member_id::text,
        v_grant.member_id,
        v_grant.line_user_id,
        now(),
        '🎂 ' || coalesce(nullif(v_grant.display_name, ''), '會員') || '，生日快樂！' || E'\n\n' ||
        '你已獲得「' || v_ticket.title || '」' || E'\n' ||
        v_ticket.description || E'\n\n' ||
        '使用期限：' || to_char(v_month_start, 'YYYY/MM/DD') || ' ～ ' || to_char(v_month_end, 'YYYY/MM/DD'),
        'pending',
        'birthday-automation'
      )
      on conflict (request_id) do nothing;

      if found then
        v_queued := v_queued + 1;
      end if;
    end if;

    insert into public.audit_logs(
      audit_id,
      actor_line_user_id,
      actor_role,
      action,
      target_type,
      target_id,
      result,
      detail
    ) values (
      'AUD-' || replace(gen_random_uuid()::text, '-', ''),
      'system',
      'system',
      'birthday.benefit.issue',
      'member',
      v_grant.line_user_id,
      'success',
      jsonb_build_object(
        'year', v_year,
        'month', v_month,
        'eventTicketId', v_ticket.event_ticket_id,
        'claimId', v_claim_id
      )
    );
  end loop;

  return jsonb_build_object(
    'enabled', true,
    'businessDate', p_business_date,
    'year', v_year,
    'month', v_month,
    'reserved', v_reserved,
    'issued', v_issued,
    'queued', v_queued,
    'eventTicketId', v_ticket.event_ticket_id
  );
end;
$function$;

revoke all on function public.issue_birthday_benefits(date) from public, anon, authenticated;
grant execute on function public.issue_birthday_benefits(date) to service_role;

create extension if not exists pg_cron with schema pg_catalog;

do $schedule$
begin
  if not exists (select 1 from cron.job where jobname = 'issue-birthday-benefits') then
    perform cron.schedule(
      'issue-birthday-benefits',
      '5 16 * * *',
      'select public.issue_birthday_benefits();'
    );
  end if;
end;
$schedule$;
