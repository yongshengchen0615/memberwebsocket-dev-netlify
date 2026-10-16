create or replace function public.save_point_card(
  p_actor_line_user_id text,
  p_card jsonb,
  p_expected_updated_at timestamptz
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
begin
  if v_card_id is null then
    v_card_id := public.new_public_id('PC');
    insert into public.point_cards(
      card_id,title,status,accent,style_key,expiry_mode,expires_on,sort_order,usage_method,usage_instructions,benefit_description,
      created_by,updated_by
    ) values(
      v_card_id,trim(p_card->>'title'),p_card->>'status',p_card->>'accent',p_card->>'styleKey',p_card->>'expiryMode',
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
      title=trim(p_card->>'title'),status=p_card->>'status',accent=p_card->>'accent',style_key=p_card->>'styleKey',
      expiry_mode=p_card->>'expiryMode',expires_on=nullif(p_card->>'expiresOn','')::date,
      usage_method=coalesce(p_card->>'usageMethod',''),usage_instructions=coalesce(p_card->>'usageInstructions',''),
      benefit_description=coalesce(p_card->>'benefitDescription',''),updated_by=p_actor_line_user_id,updated_at=v_now
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

      v_reward_row_id := null;

      -- Prefer the existing threshold slot. This preserves identity when an admin
      -- changes the template assigned to an existing reward position.
      select r.id into v_reward_row_id
      from public.point_card_rewards r
      where r.point_card_id=v_id
        and r.threshold_stamps=v_threshold
        and not (r.id = any(v_matched_reward_ids))
      limit 1
      for update;

      -- If the threshold itself changed, preserve identity by matching the same
      -- ticket template when it is still present on this card.
      if v_reward_row_id is null then
        select r.id into v_reward_row_id
        from public.point_card_rewards r
        where r.point_card_id=v_id
          and r.ticket_template_id=v_template_id
          and not (r.id = any(v_matched_reward_ids))
        order by r.threshold_stamps
        limit 1
        for update;
      end if;

      if v_reward_row_id is null then
        insert into public.point_card_rewards(reward_id,point_card_id,threshold_stamps,ticket_template_id)
        values(public.new_public_id('RW'),v_id,v_threshold,v_template_id)
        returning id into v_reward_row_id;
      else
        update public.point_card_rewards
        set threshold_stamps=v_threshold,
            ticket_template_id=v_template_id
        where id=v_reward_row_id;
      end if;

      v_matched_reward_ids := array_append(v_matched_reward_ids,v_reward_row_id);
    end loop;
  end if;

  if cardinality(v_matched_reward_ids)=0 then
    delete from public.point_card_rewards where point_card_id=v_id;
  else
    delete from public.point_card_rewards
    where point_card_id=v_id
      and not (id = any(v_matched_reward_ids));
  end if;

  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
  values(
    public.new_public_id('AUD'),p_actor_line_user_id,'admin','admin.pointcards.save','point_card',v_card_id,'success',
    jsonb_build_object('stableRewardIdentity',true,'rewardCount',cardinality(v_matched_reward_ids))
  );
  return v_card_id;
end;
$function$;

revoke all on function public.save_point_card(text,jsonb,timestamptz) from public, anon, authenticated;
grant execute on function public.save_point_card(text,jsonb,timestamptz) to service_role;

create or replace function public.issue_eligible_point_tickets(p_member_id uuid, p_point_card_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_balance integer := 0;
  v_reward record;
  v_count integer := 0;
begin
  select coalesce(stamps,0) into v_balance
  from public.point_balances
  where member_id=p_member_id and point_card_id=p_point_card_id;

  for v_reward in
    select r.id,r.threshold_stamps,t.id as template_id,t.ticket_type,t.title,t.description,t.usage_method,t.usage_instructions,t.prizes
    from public.point_card_rewards r
    join public.ticket_templates t on t.id=r.ticket_template_id
    where r.point_card_id=p_point_card_id
      and t.status='active'
      and r.threshold_stamps <= v_balance
    order by r.threshold_stamps
  loop
    if not exists (
      select 1 from public.point_tickets pt
      where pt.member_id=p_member_id
        and pt.point_card_id=p_point_card_id
        and pt.status='available'
        and (
          pt.reward_id=v_reward.id
          or (
            pt.ticket_template_id=v_reward.template_id
            and pt.threshold_stamps=v_reward.threshold_stamps
          )
        )
    ) then
      insert into public.point_tickets(
        ticket_id,member_id,point_card_id,reward_id,ticket_template_id,threshold_stamps,
        ticket_type,ticket_title,ticket_description,usage_method,usage_instructions,prizes
      ) values (
        public.new_public_id('PT'),p_member_id,p_point_card_id,v_reward.id,v_reward.template_id,v_reward.threshold_stamps,
        v_reward.ticket_type,v_reward.title,v_reward.description,v_reward.usage_method,v_reward.usage_instructions,v_reward.prizes
      );
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$function$;

revoke all on function public.issue_eligible_point_tickets(uuid,uuid) from public, anon, authenticated;
grant execute on function public.issue_eligible_point_tickets(uuid,uuid) to service_role;

-- Repair only orphaned available tickets that have one exact current reward match
-- and only when that member does not already hold another available ticket linked
-- to the same reward. This avoids rewriting or deleting existing member rights.
update public.point_tickets pt
set reward_id=r.id,
    updated_at=now()
from public.point_card_rewards r
where pt.status='available'
  and pt.reward_id is null
  and pt.point_card_id=r.point_card_id
  and pt.ticket_template_id=r.ticket_template_id
  and pt.threshold_stamps=r.threshold_stamps
  and not exists (
    select 1
    from public.point_tickets existing
    where existing.member_id=pt.member_id
      and existing.reward_id=r.id
      and existing.status='available'
  );
