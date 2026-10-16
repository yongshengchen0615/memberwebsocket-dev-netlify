create or replace function public.save_point_card(p_actor_line_user_id text, p_card jsonb, p_expected_updated_at timestamp with time zone)
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
        insert into public.point_card_rewards(reward_id,point_card_id,threshold_stamps,ticket_template_id)
        values(public.new_public_id('RW'),v_id,v_threshold,v_template_id)
        returning id into v_reward_row_id;
      else
        update public.point_card_rewards set threshold_stamps=v_threshold,ticket_template_id=v_template_id where id=v_reward_row_id;
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
    jsonb_build_object('stableRewardIdentity',true,'rewardCount',cardinality(v_matched_reward_ids)));
  return v_card_id;
end;
$function$;

alter table public.point_cards drop column if exists max_tickets_per_redemption;
