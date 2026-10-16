alter table public.fixed_ticket_templates
  add column if not exists expiry_mode text not null default 'month_end',
  add column if not exists expiry_date date;

alter table public.fixed_ticket_templates
  drop constraint if exists fixed_ticket_templates_expiry_check;

alter table public.fixed_ticket_templates
  add constraint fixed_ticket_templates_expiry_check check (
    (expiry_mode = 'month_end' and expiry_date is null)
    or
    (expiry_mode = 'fixed_date' and expiry_date is not null)
  );

comment on column public.fixed_ticket_templates.expiry_mode is
  'Fixed ticket validity mode: month_end or fixed_date.';
comment on column public.fixed_ticket_templates.expiry_date is
  'Absolute valid-through date when expiry_mode = fixed_date.';

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
  v_valid_until date;
  v_cycle_key text;
  v_event_cycle_key text;
  v_title text;
  v_event_public_id text;
  v_grant_id uuid;
  v_claim_id text;
  v_claim_count integer;
  v_issued integer := 0;
  v_queued integer := 0;
  v_templates integer := 0;
begin
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
      v_cycle_start := date_trunc('month', p_business_date)::date;
      v_cycle_end := (date_trunc('month', p_business_date) + interval '1 month - 1 day')::date;
      v_event_cycle_key := 'birthday-month:' || to_char(v_cycle_start, 'YYYY-MM');
      v_cycle_key := 'birthday:' || extract(year from p_business_date)::integer::text;
    elsif v_template.schedule_type = 'weekly' then
      v_cycle_start := p_business_date - (((extract(isodow from p_business_date)::integer - v_template.schedule_weekday + 7) % 7))::integer;
      v_cycle_end := v_cycle_start + 6;
      v_cycle_key := 'week:' || to_char(v_cycle_start, 'IYYY-IW');
      v_event_cycle_key := v_cycle_key;
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
      v_event_cycle_key := v_cycle_key;
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
      v_event_cycle_key := v_cycle_key;
    end if;

    if v_template.expiry_mode = 'fixed_date' then
      v_valid_until := v_template.expiry_date;
    else
      v_valid_until := (date_trunc('month', v_cycle_start) + interval '1 month - 1 day')::date;
    end if;

    -- Never materialize or reactivate a ticket that is already expired.
    if v_valid_until is null or v_valid_until < p_business_date then
      continue;
    end if;

    v_title := replace(
      replace(v_template.title, '{year}', extract(year from v_cycle_start)::integer::text),
      '{month}', extract(month from v_cycle_start)::integer::text
    );
    v_event_public_id := 'FIXED-' || v_template.fixed_ticket_id || '-' || replace(replace(v_event_cycle_key, ':', '-'), '/', '-');

    insert into public.event_tickets(
      event_ticket_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,
      starts_on,ends_on,quota,accent,allowed_tier_keys,created_by,updated_by,activity_url,activity_link_name,
      fixed_ticket_template_id,fixed_cycle_key
    ) values (
      v_event_public_id,v_title,'coupon',v_template.description,v_template.usage_method,v_template.usage_instructions,
      '[]'::jsonb,'active',v_cycle_start,v_valid_until,v_template.quota,lower(v_template.accent),
      v_template.allowed_tier_keys,'fixed-ticket-automation','fixed-ticket-automation','','',v_template.id,v_event_cycle_key
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
          '使用期限：' || to_char(v_cycle_start, 'YYYY/MM/DD') || ' ～ ' || to_char(v_valid_until, 'YYYY/MM/DD'),
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
          'expiryMode',v_template.expiry_mode,
          'cycleKey',v_cycle_key,
          'eventCycleKey',v_event_cycle_key,
          'cycleStart',v_cycle_start,
          'cycleEnd',v_cycle_end,
          'validUntil',v_valid_until,
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
