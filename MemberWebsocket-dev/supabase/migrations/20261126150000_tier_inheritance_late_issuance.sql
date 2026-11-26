-- Tier inheritance + late entitlement issuance. Apply only to isolated testing DB first.
-- The allowed-tier array is a set of MINIMUM ranks, not an exact-match allowlist.
-- General tickets are issued once per member/campaign, never reissued after a transfer.
create or replace function public.tier_allows(p_current text,p_allowed text[])
returns boolean language sql immutable set search_path=''
as $fn$
  select coalesce(
    array_position(array['general','silver','gold','platinum'],p_current)
      >= (select min(array_position(array['general','silver','gold','platinum'],t))
          from unnest(p_allowed) t
          where t=any(array['general','silver','gold','platinum'])),
    false);
$fn$;

create or replace function public.issue_member_tier_event_tickets(p_member_id uuid)
returns integer language plpgsql security definer set search_path=''
as $fn$
declare
  v_tier text;
  v_event public.event_tickets%rowtype;
  v_rows integer;
  v_issued integer := 0;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
begin
  -- Serialize all reconciliation attempts for this member without locking any other member.
  perform pg_advisory_xact_lock(hashtext('public:member-tier-issue'),hashtext(p_member_id::text));
  if not exists(select 1 from public.members m where m.id=p_member_id
                and m.status='active' and m.membership_status='active') then return 0; end if;
  v_tier := public.current_tier_key(p_member_id);
  if v_tier is null then return 0; end if;
  for v_event in
    select * from public.event_tickets e
     where e.status='active' and e.deleted_at is null
       and e.ticket_type in ('coupon','lottery')
       and e.fixed_ticket_template_id is null
       and e.referral_source_event_ticket_id is null
       and (e.ends_on is null or e.ends_on>=v_today)
       and public.tier_allows(v_tier,e.allowed_tier_keys)
       -- Read operations are frequent: lock only campaigns for which this member
       -- still has no entitlement. Do not serialize every viewer on every ticket.
       and not exists (select 1 from public.event_ticket_claims c
                       where c.event_ticket_id=e.id and c.member_id=p_member_id)
       and not exists (select 1 from public.event_ticket_transfers t
                       where t.event_ticket_id=e.id
                         and (t.sender_member_id=p_member_id or t.receiver_member_id=p_member_id))
     order by e.id
  loop
    -- Also serializes with the campaign-activation issuer and gift transfer RPCs.
    perform 1 from public.event_tickets where id=v_event.id for update;
    insert into public.event_ticket_claims
      (claim_id,event_ticket_id,member_id,ticket_type,ticket_title,
       ticket_description,usage_method,usage_instructions,prizes)
    select public.new_public_id('EC'),v_event.id,p_member_id,v_event.ticket_type,
           v_event.title,v_event.description,v_event.usage_method,
           v_event.usage_instructions,v_event.prizes
     where not exists (select 1 from public.event_ticket_claims c
                       where c.event_ticket_id=v_event.id and c.member_id=p_member_id)
       and not exists (select 1 from public.event_ticket_transfers t
                       where t.event_ticket_id=v_event.id
                         and (t.sender_member_id=p_member_id or t.receiver_member_id=p_member_id))
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    v_issued := v_issued + v_rows;
  end loop;
  if v_issued>0 then
    insert into public.audit_logs
      (audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
    values(public.new_public_id('AUD'),'tier-automation','system',
           'member.tier-ticket-backfill','member',p_member_id::text,'success',
           jsonb_build_object('issuedCount',v_issued,'tier',v_tier));
  end if;
  return v_issued;
end;
$fn$;

create or replace function public.refresh_member_tier_event_tickets()
returns trigger language plpgsql security definer set search_path=''
as $fn$
begin
  if tg_table_name='members' then
    if new.status='active' and new.membership_status='active' then
      perform public.issue_member_tier_event_tickets(new.id);
    end if;
    return new;
  end if;
  if tg_op='DELETE' then
    perform public.issue_member_tier_event_tickets(old.member_id);
    return old;
  end if;
  perform public.issue_member_tier_event_tickets(new.member_id);
  if tg_op='UPDATE' and old.member_id is distinct from new.member_id then
    perform public.issue_member_tier_event_tickets(old.member_id);
  end if;
  return new;
end;
$fn$;

create or replace function public.auto_issue_general_event_ticket()
returns trigger language plpgsql security definer set search_path=''
as $fn$
begin
  if new.status='active' and new.deleted_at is null
    and (tg_op='INSERT' or old.status is distinct from 'active'
      or old.allowed_tier_keys is distinct from new.allowed_tier_keys
      or old.ends_on is distinct from new.ends_on) then
    perform public.issue_eligible_general_event_ticket(new.id);
  end if;
  return new;
end;
$fn$;

-- Apply the helper and refresh functions to existing merchant schemas.
-- Their function bodies must not point to public/member data.
do $tenants$
declare s text; fn record; ddl text;
begin
  for s in select nspname from pg_namespace where nspname ~ '^business_[0-9a-f]{32}$' order by nspname loop
    if to_regclass(format('%I.members',s)) is null or to_regclass(format('%I.event_tickets',s)) is null
      or to_regclass(format('%I.service_time_entries',s)) is null then
      raise exception 'INCOMPLETE_TIER_TENANT: %',s;
    end if;
    for fn in select p.proname,pg_get_functiondef(p.oid) definition
                from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname in
                  ('tier_allows','issue_member_tier_event_tickets',
                   'refresh_member_tier_event_tickets','auto_issue_general_event_ticket')
    loop
      ddl:=replace(fn.definition,'public.',format('%I.',s));
      ddl:=replace(ddl,'''public:member-tier-issue''',quote_literal(s||':member-tier-issue'));
      execute ddl;
    end loop;
  end loop;
end;
$tenants$;

-- Rewrite only the tier-specific array comparisons; other ANY checks (e.g. claim IDs) must be preserved.\n-- Rewrite server-side eligibility gates (claim, redemption, booking, notification,
-- recurring templates and activities), preserving signatures, grants and business logic.
do $rewrite$
declare s text; fn record; original text; rewritten text; total integer;
begin
  for s in select 'public' union all
           select nspname from pg_namespace where nspname ~ '^business_[0-9a-f]{32}$'
  loop
    total := 0;
    for fn in
      select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname=s and p.prokind='f' and p.proname=any(array[
         'issue_eligible_general_event_ticket','issue_fixed_tickets',
         'bind_member_referral','issue_membership_join_ticket',
         'redeem_event_ticket','redeem_event_tickets_with_location',
         'redeem_event_tickets_for_booking_request','count_today_usable_event_tickets',
         'fixed_ticket_notification_delivery','replace_booking_benefit_selections_request',
         'validate_snapshot_ticket_selection','complete_booking_with_benefits_request',
         'complete_booking_with_rewards_request','grant_member_benefits_with_event_bonus'
       ])
    loop
      original:=pg_get_functiondef(fn.oid);
      -- Parenthesized current_tier_key(...) cannot be handled by the scalar rule.
      rewritten:=regexp_replace(original,
        '(public|business_[0-9a-f]{32})\.current_tier_key\(([^()]*)\)[[:space:]]*=[[:space:]]*any\(([^()]*)\)',
        format('%I.tier_allows(%I.current_tier_key(\2),\3)',s,s),'gi');
      rewritten:=regexp_replace(rewritten,
        '([a-z_][a-z0-9_]*)[[:space:]]*=[[:space:]]*any\((([a-z_][a-z0-9_]*\.)?allowed_tier_keys)\)',
        format('%I.tier_allows(\1,\2)',s),'gi');
      if rewritten<>original then
        execute rewritten;
        total:=total+1;
      end if;
    end loop;
    if total<10 then raise exception 'TIER_GATE_REWRITE_MISSING: % (% functions)',s,total; end if;
  end loop;
end;
$rewrite$;

do $triggers$
declare s text; m record;
begin
  for s in select 'public' union all
           select nspname from pg_namespace where nspname ~ '^business_[0-9a-f]{32}$'
  loop
    execute format('drop trigger if exists refresh_member_tier_ticket_members on %I.members',s);
    execute format('create trigger refresh_member_tier_ticket_members after insert or update of membership_status,status on %1$I.members for each row execute function %1$I.refresh_member_tier_event_tickets()',s);
    execute format('drop trigger if exists refresh_member_tier_ticket_minutes on %I.service_time_entries',s);
    execute format('create trigger refresh_member_tier_ticket_minutes after insert or delete or update of member_id,minutes on %1$I.service_time_entries for each row execute function %1$I.refresh_member_tier_event_tickets()',s);
    execute format('drop trigger if exists auto_issue_general_event_ticket on %I.event_tickets',s);
    execute format('create trigger auto_issue_general_event_ticket after insert or update of status,allowed_tier_keys,ends_on on %1$I.event_tickets for each row execute function %1$I.auto_issue_general_event_ticket()',s);
    execute format('revoke all on function %I.tier_allows(text,text[]) from public,anon,authenticated',s);
    execute format('revoke all on function %I.issue_member_tier_event_tickets(uuid) from public,anon,authenticated',s);
    execute format('revoke all on function %I.refresh_member_tier_event_tickets() from public,anon,authenticated',s);
    execute format('grant execute on function %I.tier_allows(text,text[]) to service_role',s);
    execute format('grant execute on function %I.issue_member_tier_event_tickets(uuid) to service_role',s);
    -- Backfill existing active campaigns for any already-qualified members.
    for m in execute format('select id from %I.members where status=''active'' and membership_status=''active'' order by id',s)
    loop
      execute format('select %I.issue_member_tier_event_tickets($1)',s) using m.id;
    end loop;
  end loop;
end;
$triggers$;

-- Ensure future merchants inherit precisely these functions and triggers.
do $template$
declare tpl jsonb; funcs jsonb; trgs jsonb;
begin
  if to_regclass('platform_private.business_templates') is null then return; end if;
  select snapshot into tpl from platform_private.business_templates
   where version='business-v1-20261019' for update;
  if tpl is null then raise exception 'BUSINESS_TEMPLATE_MISSING'; end if;
  select coalesce(jsonb_agg(f.value order by f.ordinality),'[]'::jsonb) into funcs
  from jsonb_array_elements(tpl->'functions') with ordinality f(value,ordinality)
  where f.value->>'name' not in
    (select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=any(array[
        'tier_allows','issue_member_tier_event_tickets','refresh_member_tier_event_tickets',
        'auto_issue_general_event_ticket','issue_eligible_general_event_ticket',
        'issue_fixed_tickets','bind_member_referral','issue_membership_join_ticket',
        'redeem_event_ticket','redeem_event_tickets_with_location',
        'redeem_event_tickets_for_booking_request','count_today_usable_event_tickets',
        'fixed_ticket_notification_delivery','replace_booking_benefit_selections_request',
        'validate_snapshot_ticket_selection','complete_booking_with_benefits_request',
        'complete_booking_with_rewards_request','grant_member_benefits_with_event_bonus']));
  select funcs || coalesce(jsonb_agg(jsonb_build_object('name',p.proname,
                              'definition',pg_get_functiondef(p.oid)) order by p.proname),'[]'::jsonb)
  into funcs from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any(array[
      'tier_allows','issue_member_tier_event_tickets','refresh_member_tier_event_tickets',
      'auto_issue_general_event_ticket','issue_eligible_general_event_ticket',
      'issue_fixed_tickets','bind_member_referral','issue_membership_join_ticket',
      'redeem_event_ticket','redeem_event_tickets_with_location',
      'redeem_event_tickets_for_booking_request','count_today_usable_event_tickets',
      'fixed_ticket_notification_delivery','replace_booking_benefit_selections_request',
      'validate_snapshot_ticket_selection','complete_booking_with_benefits_request',
      'complete_booking_with_rewards_request','grant_member_benefits_with_event_bonus']);
  select coalesce(jsonb_agg(t.value order by t.ordinality),'[]'::jsonb) into trgs
  from jsonb_array_elements(tpl->'triggers') with ordinality t(value,ordinality)
  where t.value->>'name' not in
    ('auto_issue_general_event_ticket','refresh_member_tier_ticket_members','refresh_member_tier_ticket_minutes');
  select trgs || coalesce(jsonb_agg(jsonb_build_object('name',t.tgname,
             'table',c.relname,'definition',pg_get_triggerdef(t.oid)) order by t.tgname),'[]'::jsonb)
  into trgs from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and t.tgname in
      ('auto_issue_general_event_ticket','refresh_member_tier_ticket_members','refresh_member_tier_ticket_minutes')
      and not t.tgisinternal;
  update platform_private.business_templates
    set snapshot=jsonb_set(jsonb_set(tpl,'{functions}',funcs),'{triggers}',trgs)
    where version='business-v1-20261019';
end;
$template$;
notify pgrst,'reload schema';
