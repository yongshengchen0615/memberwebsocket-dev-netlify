-- One issued ticket is one redemption intent. A single reward may be redeemed
-- multiple times when the same point card holds enough points for every copy.
-- The balance row serializes issuance; booking reservation and redemption keep
-- their own transactional balance guards. Never remove those guards.
drop index if exists public.point_ticket_one_available_per_reward;
create index if not exists point_ticket_available_member_reward_idx
  on public.point_tickets(member_id,reward_id)
  where status='available' and reward_id is not null and snapshot_reservation_copy_of is null;

create or replace function public.issue_eligible_point_tickets(
  p_member_id uuid, p_point_card_id uuid
) returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_balance integer := 0;
  v_reward record;
  v_count integer := 0;
  v_existing integer := 0;
  v_allowed integer := 0;
begin
  -- Serialize competing grants and redemptions for this balance.
  select greatest(stamps,0) into v_balance
  from public.point_balances
  where member_id=p_member_id and point_card_id=p_point_card_id
  for update;
  if not found then return 0; end if;

  for v_reward in
    select r.id,r.threshold_stamps,t.id as template_id,t.ticket_type,t.title,
           t.description,t.usage_method,t.usage_instructions,t.prizes
    from public.point_card_rewards r
    join public.ticket_templates t on t.id=r.ticket_template_id
    where r.point_card_id=p_point_card_id
      and t.status='active'
      and r.threshold_stamps > 0
      and r.threshold_stamps <= v_balance
    order by r.threshold_stamps,r.id
  loop
    -- 20 is the existing booking selection payload limit. It also prevents
    -- unbounded ticket creation when a member has a very large balance.
    v_allowed := least(20, v_balance / v_reward.threshold_stamps);
    select count(*) into v_existing
    from public.point_tickets pt
    where pt.member_id=p_member_id
      and pt.point_card_id=p_point_card_id
      and pt.status='available'
      and pt.snapshot_reservation_copy_of is null
      and (pt.reward_id=v_reward.id or
        (pt.ticket_template_id=v_reward.template_id
          and pt.threshold_stamps=v_reward.threshold_stamps));
    while v_existing < v_allowed loop
      insert into public.point_tickets(
        ticket_id,member_id,point_card_id,reward_id,ticket_template_id,threshold_stamps,
        ticket_type,ticket_title,ticket_description,usage_method,usage_instructions,prizes
      ) values (
        public.new_public_id('PT'),p_member_id,p_point_card_id,v_reward.id,
        v_reward.template_id,v_reward.threshold_stamps,v_reward.ticket_type,v_reward.title,
        v_reward.description,v_reward.usage_method,v_reward.usage_instructions,v_reward.prizes
      );
      v_existing := v_existing + 1;
      v_count := v_count + 1;
    end loop;
  end loop;
  return v_count;
end;
$function$;

-- Existing members may already have enough points but only one ticket.
-- Backfill in-place without changing any balance or consuming any ticket.
do $backfill$
declare v_row record;
begin
  for v_row in
    select b.member_id,b.point_card_id
    from public.point_balances b
    where b.stamps > 0
    order by b.member_id,b.point_card_id
  loop
    perform public.issue_eligible_point_tickets(v_row.member_id,v_row.point_card_id);
  end loop;
end;
$backfill$;
