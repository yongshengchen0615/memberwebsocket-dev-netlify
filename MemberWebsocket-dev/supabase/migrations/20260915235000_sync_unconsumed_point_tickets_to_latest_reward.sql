create or replace function public.sync_available_point_tickets_for_reward(p_reward_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer := 0;
  v_template_status text;
begin
  select t.status into v_template_status
  from public.point_card_rewards r
  join public.ticket_templates t on t.id=r.ticket_template_id
  where r.id=p_reward_id;

  if not found then
    return 0;
  end if;

  if v_template_status <> 'active' then
    update public.point_tickets pt
    set status='cancelled',
        updated_at=now()
    where pt.reward_id=p_reward_id
      and pt.status='available';
    get diagnostics v_count = row_count;
    return v_count;
  end if;

  update public.point_tickets pt
  set ticket_template_id=t.id,
      threshold_stamps=r.threshold_stamps,
      ticket_type=t.ticket_type,
      ticket_title=t.title,
      ticket_description=t.description,
      usage_method=t.usage_method,
      usage_instructions=t.usage_instructions,
      prizes=t.prizes,
      updated_at=now()
  from public.point_card_rewards r
  join public.ticket_templates t on t.id=r.ticket_template_id
  where r.id=p_reward_id
    and pt.reward_id=r.id
    and pt.status='available';

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.sync_available_point_tickets_for_reward(uuid) from public, anon, authenticated;
grant execute on function public.sync_available_point_tickets_for_reward(uuid) to service_role;

create or replace function public.sync_available_point_tickets_after_reward_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.sync_available_point_tickets_for_reward(new.id);
  return new;
end;
$function$;

revoke all on function public.sync_available_point_tickets_after_reward_update() from public, anon, authenticated;

drop trigger if exists point_card_rewards_sync_available_tickets on public.point_card_rewards;
create trigger point_card_rewards_sync_available_tickets
after update of threshold_stamps, ticket_template_id on public.point_card_rewards
for each row
when (
  old.threshold_stamps is distinct from new.threshold_stamps
  or old.ticket_template_id is distinct from new.ticket_template_id
)
execute function public.sync_available_point_tickets_after_reward_update();

create or replace function public.cancel_available_point_tickets_before_reward_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.point_tickets
  set status='cancelled',
      updated_at=now()
  where reward_id=old.id
    and status='available';
  return old;
end;
$function$;

revoke all on function public.cancel_available_point_tickets_before_reward_delete() from public, anon, authenticated;

drop trigger if exists point_card_rewards_cancel_available_tickets on public.point_card_rewards;
create trigger point_card_rewards_cancel_available_tickets
before delete on public.point_card_rewards
for each row
execute function public.cancel_available_point_tickets_before_reward_delete();

create or replace function public.sync_available_point_tickets_after_template_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_reward record;
begin
  for v_reward in
    select id
    from public.point_card_rewards
    where ticket_template_id=new.id
  loop
    perform public.sync_available_point_tickets_for_reward(v_reward.id);
  end loop;
  return new;
end;
$function$;

revoke all on function public.sync_available_point_tickets_after_template_update() from public, anon, authenticated;

drop trigger if exists ticket_templates_sync_available_tickets on public.ticket_templates;
create trigger ticket_templates_sync_available_tickets
after update of title, ticket_type, description, usage_method, usage_instructions, prizes, status on public.ticket_templates
for each row
when (
  old.title is distinct from new.title
  or old.ticket_type is distinct from new.ticket_type
  or old.description is distinct from new.description
  or old.usage_method is distinct from new.usage_method
  or old.usage_instructions is distinct from new.usage_instructions
  or old.prizes is distinct from new.prizes
  or old.status is distinct from new.status
)
execute function public.sync_available_point_tickets_after_template_update();

with template_match as (
  select pt.id as ticket_db_id, (array_agg(r.id))[1] as reward_id
  from public.point_tickets pt
  join public.point_card_rewards r
    on r.point_card_id=pt.point_card_id
   and r.ticket_template_id=pt.ticket_template_id
  where pt.status='available'
    and pt.reward_id is null
  group by pt.id
  having count(*)=1
),
threshold_match as (
  select pt.id as ticket_db_id, (array_agg(r.id))[1] as reward_id
  from public.point_tickets pt
  join public.point_card_rewards r
    on r.point_card_id=pt.point_card_id
   and r.threshold_stamps=pt.threshold_stamps
  where pt.status='available'
    and pt.reward_id is null
  group by pt.id
  having count(*)=1
),
mapped as (
  select pt.id as ticket_db_id,
         coalesce(tm.reward_id, hm.reward_id) as inferred_reward_id
  from public.point_tickets pt
  left join template_match tm on tm.ticket_db_id=pt.id
  left join threshold_match hm on hm.ticket_db_id=pt.id
  where pt.status='available'
    and pt.reward_id is null
),
effective as (
  select pt.id,
         pt.member_id,
         coalesce(pt.reward_id, m.inferred_reward_id) as effective_reward_id,
         pt.earned_at
  from public.point_tickets pt
  left join mapped m on m.ticket_db_id=pt.id
  where pt.status='available'
),
ranked as (
  select id,
         effective_reward_id,
         row_number() over (
           partition by member_id,effective_reward_id
           order by earned_at asc,id asc
         ) as rn
  from effective
  where effective_reward_id is not null
)
update public.point_tickets pt
set status='cancelled',
    updated_at=now()
from ranked r
where pt.id=r.id
  and r.rn>1;

with template_match as (
  select pt.id as ticket_db_id, (array_agg(r.id))[1] as reward_id
  from public.point_tickets pt
  join public.point_card_rewards r
    on r.point_card_id=pt.point_card_id
   and r.ticket_template_id=pt.ticket_template_id
  where pt.status='available'
    and pt.reward_id is null
  group by pt.id
  having count(*)=1
),
threshold_match as (
  select pt.id as ticket_db_id, (array_agg(r.id))[1] as reward_id
  from public.point_tickets pt
  join public.point_card_rewards r
    on r.point_card_id=pt.point_card_id
   and r.threshold_stamps=pt.threshold_stamps
  where pt.status='available'
    and pt.reward_id is null
  group by pt.id
  having count(*)=1
),
mapped as (
  select pt.id as ticket_db_id,
         coalesce(tm.reward_id, hm.reward_id) as inferred_reward_id
  from public.point_tickets pt
  left join template_match tm on tm.ticket_db_id=pt.id
  left join threshold_match hm on hm.ticket_db_id=pt.id
  where pt.status='available'
    and pt.reward_id is null
)
update public.point_tickets pt
set reward_id=m.inferred_reward_id,
    updated_at=now()
from mapped m
where pt.id=m.ticket_db_id
  and m.inferred_reward_id is not null
  and pt.status='available'
  and pt.reward_id is null;

update public.point_tickets
set status='cancelled',
    updated_at=now()
where status='available'
  and reward_id is null;

select public.sync_available_point_tickets_for_reward(reward_id)
from (
  select distinct reward_id
  from public.point_tickets
  where status='available'
    and reward_id is not null
) rewards;
