alter table public.point_card_rewards
  add column if not exists required_service_types text[] not null default '{}'::text[];

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.point_card_rewards'::regclass
      and conname='point_card_rewards_required_service_types_limit_check'
  ) then
    alter table public.point_card_rewards
      add constraint point_card_rewards_required_service_types_limit_check
      check (cardinality(required_service_types) <= 20);
  end if;
end
$$;

update public.point_card_rewards r
set required_service_types = coalesce(t.required_service_types, '{}'::text[]),
    updated_at = now()
from public.ticket_templates t
where t.id = r.ticket_template_id
  and coalesce(cardinality(r.required_service_types), 0) = 0
  and coalesce(cardinality(t.required_service_types), 0) > 0;

create or replace function public.save_point_card(
  p_actor_line_user_id text,
  p_card jsonb,
  p_expected_updated_at timestamp with time zone
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_card_id text := nullif(trim(p_card->>'cardId'),'');
  v_id uuid;
  v_now timestamptz := now();
  v_reward jsonb;
  v_template_id uuid;
  v_threshold integer;
  v_reward_row_id uuid;
  v_matched_reward_ids uuid[] := array[]::uuid[];
  v_style_key text := lower(trim(coalesce(nullif(p_card->>'pointCardStyleKey',''), nullif(p_card->>'styleKey',''), '')));
  v_required_service_types text[] := '{}'::text[];
  v_requested_service_type_count integer := 0;
begin
  v_style_key := case v_style_key
    when 'forest' then 'lagoon'
    when 'midnight' then 'skyline'
    when 'ocean' then 'denim'
    when 'sunset' then 'coral'
    when 'lavender' then 'violet'
    when 'rose' then 'berry'
    when 'gold' then 'citrus'
    when 'platinum' then 'cocoa'
    when 'mint' then 'lime'
    when 'cherry' then 'peach'
    else v_style_key
  end;

  if v_style_key not in ('citrus','coral','lagoon','skyline','violet','berry','cocoa','lime','denim','peach') then
    raise exception 'INVALID_POINT_CARD_STYLE';
  end if;

  if v_card_id is null then
    v_card_id := public.new_public_id('PC');
    insert into public.point_cards(
      card_id,title,status,accent,style_key,expiry_mode,expires_on,sort_order,usage_method,usage_instructions,benefit_description,
      created_by,updated_by
    ) values(
      v_card_id,trim(p_card->>'title'),p_card->>'status',p_card->>'accent',v_style_key,p_card->>'expiryMode',
      nullif(p_card->>'expiresOn','')::date,coalesce((select max(sort_order)+1 from public.point_cards),0),
      coalesce(p_card->>'usageMethod',''),coalesce(p_card->>'usageInstructions',''),coalesce(p_card->>'benefitDescription',''),
      p_actor_line_user_id,p_actor_line_user_id
    ) returning id into v_id;
  else
    select id into v_id from public.point_cards where card_id=v_card_id for update;
    if not found then raise exception 'POINT_CARD_NOT_FOUND'; end if;
    if p_expected_updated_at is not null and not exists(select 1 from public.point_cards where id=v_id and updated_at=p_expected_updated_at) then
      raise exception 'CONFLICT';
    end if;
    update public.point_cards set
      title=trim(p_card->>'title'),status=p_card->>'status',accent=p_card->>'accent',style_key=v_style_key,
      expiry_mode=p_card->>'expiryMode',expires_on=nullif(p_card->>'expiresOn','')::date,
      usage_method=coalesce(p_card->>'usageMethod',''),usage_instructions=coalesce(p_card->>'usageInstructions',''),
      benefit_description=coalesce(p_card->>'benefitDescription',''),
      updated_by=p_actor_line_user_id,updated_at=v_now
    where id=v_id;
  end if;

  if jsonb_typeof(p_card->'rewards')='array' then
    for v_reward in select value from jsonb_array_elements(p_card->'rewards')
    loop
      begin
        v_threshold := (v_reward->>'thresholdStamps')::integer;
      exception when others then
        raise exception 'INVALID_REWARD_THRESHOLD';
      end;
      if v_threshold < 1 or v_threshold > 100 then raise exception 'INVALID_REWARD_THRESHOLD'; end if;

      select id into v_template_id
      from public.ticket_templates
      where ticket_template_id=v_reward->>'ticketTemplateId';
      if not found then raise exception 'TICKET_TEMPLATE_NOT_FOUND'; end if;

      v_required_service_types := '{}'::text[];
      v_requested_service_type_count := 0;
      if v_reward ? 'requiredServiceTypes' and v_reward->'requiredServiceTypes' is not null then
        if jsonb_typeof(v_reward->'requiredServiceTypes') <> 'array'
           or jsonb_array_length(v_reward->'requiredServiceTypes') > 20 then
          raise exception 'INVALID_REQUIRED_SERVICE_TYPES';
        end if;

        select count(distinct lower(btrim(value)))
          into v_requested_service_type_count
        from jsonb_array_elements_text(v_reward->'requiredServiceTypes')
        where btrim(value) <> '';

        select coalesce(array_agg(t.name order by t.sort_order, t.created_at), '{}'::text[])
          into v_required_service_types
        from public.booking_service_types t
        where exists (
          select 1
          from jsonb_array_elements_text(v_reward->'requiredServiceTypes') requested(value)
          where lower(btrim(requested.value)) = lower(btrim(t.name))
        );

        if cardinality(v_required_service_types) <> v_requested_service_type_count then
          raise exception 'INVALID_REQUIRED_SERVICE_TYPES';
        end if;
      end if;

      v_reward_row_id := null;
      select r.id into v_reward_row_id
      from public.point_card_rewards r
      where r.point_card_id=v_id and r.threshold_stamps=v_threshold and not (r.id = any(v_matched_reward_ids))
      limit 1 for update;

      if v_reward_row_id is null then
        select r.id into v_reward_row_id
        from public.point_card_rewards r
        where r.point_card_id=v_id and r.ticket_template_id=v_template_id and not (r.id = any(v_matched_reward_ids))
        order by r.threshold_stamps limit 1 for update;
      end if;

      if v_reward_row_id is null then
        insert into public.point_card_rewards(
          reward_id,point_card_id,threshold_stamps,ticket_template_id,required_service_types
        )
        values(
          public.new_public_id('RW'),v_id,v_threshold,v_template_id,v_required_service_types
        )
        returning id into v_reward_row_id;
      else
        update public.point_card_rewards
        set threshold_stamps=v_threshold,
            ticket_template_id=v_template_id,
            required_service_types=v_required_service_types,
            updated_at=v_now
        where id=v_reward_row_id;
      end if;
      v_matched_reward_ids := array_append(v_matched_reward_ids,v_reward_row_id);
    end loop;
  end if;

  if cardinality(v_matched_reward_ids)=0 then
    delete from public.point_card_rewards where point_card_id=v_id;
  else
    delete from public.point_card_rewards where point_card_id=v_id and not (id = any(v_matched_reward_ids));
  end if;

  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
  values(public.new_public_id('AUD'),p_actor_line_user_id,'admin','admin.pointcards.save','point_card',v_card_id,'success',
    jsonb_build_object(
      'stableRewardIdentity',true,
      'rewardCount',cardinality(v_matched_reward_ids),
      'styleKey',v_style_key,
      'bookingServiceRuleAtRewardNode',true
    ));
  return v_card_id;
end;
$function$;

create or replace function public.validate_booking_benefit_service_requirement_row()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_required text[] := '{}'::text[];
begin
  if new.status = 'cancelled' or new.benefit_kind = 'calendar' then
    return new;
  end if;

  if new.benefit_kind = 'points' then
    select coalesce(r.required_service_types, '{}'::text[])
      into v_required
    from public.point_tickets pt
    join public.point_card_rewards r on r.id = pt.reward_id
    where pt.ticket_id = new.benefit_ref;
  elsif new.benefit_kind = 'event' then
    select coalesce(et.required_service_types, '{}'::text[])
      into v_required
    from public.event_ticket_claims ec
    join public.event_tickets et on et.id = ec.event_ticket_id
    where ec.claim_id = new.benefit_ref;
  end if;

  v_required := coalesce(v_required, '{}'::text[]);
  if cardinality(v_required) > 0
     and not public.booking_has_required_service_type(new.booking_id, v_required) then
    raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED'
      using detail = format(
        '票券「%s」需預約以下任一項目類型：%s',
        coalesce(nullif(new.title_snapshot, ''), new.benefit_ref),
        array_to_string(v_required, '、')
      );
  end if;

  return new;
end;
$$;

create or replace function public.validate_booking_service_requirements_on_completion()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_selection record;
  v_required text[];
begin
  if new.status <> 'completed' or old.status = 'completed' then
    return new;
  end if;

  for v_selection in
    select benefit_kind, benefit_ref, title_snapshot
    from public.booking_benefit_selections
    where booking_id = new.id
      and status in ('pending', 'redeemed', 'applied')
      and benefit_kind in ('points', 'event')
  loop
    v_required := '{}'::text[];

    if v_selection.benefit_kind = 'points' then
      select coalesce(r.required_service_types, '{}'::text[])
        into v_required
      from public.point_tickets pt
      join public.point_card_rewards r on r.id = pt.reward_id
      where pt.ticket_id = v_selection.benefit_ref;
    else
      select coalesce(et.required_service_types, '{}'::text[])
        into v_required
      from public.event_ticket_claims ec
      join public.event_tickets et on et.id = ec.event_ticket_id
      where ec.claim_id = v_selection.benefit_ref;
    end if;

    v_required := coalesce(v_required, '{}'::text[]);
    if cardinality(v_required) > 0
       and not public.booking_has_required_service_type(new.id, v_required) then
      raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED'
        using detail = format(
          '票券「%s」需預約以下任一項目類型：%s',
          coalesce(nullif(v_selection.title_snapshot, ''), v_selection.benefit_ref),
          array_to_string(v_required, '、')
        );
    end if;
  end loop;

  return new;
end;
$$;

create or replace function public.sync_ticket_required_service_type_name()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if lower(btrim(old.name)) = lower(btrim(new.name)) then
    return new;
  end if;

  update public.point_card_rewards
  set required_service_types = array(
        select case
          when lower(btrim(value)) = lower(btrim(old.name)) then new.name
          else value
        end
        from unnest(required_service_types) as value
      ),
      updated_at = now()
  where exists (
    select 1 from unnest(required_service_types) as value
    where lower(btrim(value)) = lower(btrim(old.name))
  );

  update public.event_tickets
  set required_service_types = array(
        select case
          when lower(btrim(value)) = lower(btrim(old.name)) then new.name
          else value
        end
        from unnest(required_service_types) as value
      ),
      updated_at = now()
  where exists (
    select 1 from unnest(required_service_types) as value
    where lower(btrim(value)) = lower(btrim(old.name))
  );

  return new;
end;
$$;

create or replace function public.prevent_delete_ticket_required_service_type()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.point_card_rewards r
    cross join unnest(r.required_service_types) as value
    where lower(btrim(value)) = lower(btrim(old.name))
  ) or exists (
    select 1
    from public.event_tickets et
    cross join unnest(et.required_service_types) as value
    where lower(btrim(value)) = lower(btrim(old.name))
  ) then
    raise exception 'BOOKING_SERVICE_TYPE_IN_USE';
  end if;
  return old;
end;
$$;

comment on column public.point_card_rewards.required_service_types is
  'Booking service type names required for this point-card reward node. Empty array means unrestricted; any one matching type is sufficient.';

alter table public.ticket_templates
  drop column if exists required_service_types;
