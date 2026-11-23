-- General event coupons and lottery tickets are issued at publication, not claimed by members.
-- Issuance and claim-ledger inventory changes occur in the SAME event-ticket transaction.
-- Quota 0 remains unlimited. Historical claims, fixed tickets, referrals, join gifts and
-- transferred tickets retain their existing semantics.
begin;

create or replace function public.auto_issue_general_event_ticket()
returns trigger
language plpgsql security definer set search_path = ''
as $body$
declare
  v_slots bigint;
  v_member record;
  v_rows integer;
  v_issued integer := 0;
begin
  if new.status <> 'active' or new.deleted_at is not null
    or new.ticket_type not in ('coupon', 'lottery')
    or new.fixed_ticket_template_id is not null
    or new.referral_source_event_ticket_id is not null
    or (tg_op = 'UPDATE' and old.status = 'active')
  then
    return new;
  end if;

  -- Existing claims (including used and transferred claims) consume one slot each.
  -- The event row is already locked by INSERT/UPDATE. claim_event_ticket and
  -- friend transfer serialize on the same row, avoiding oversubscription.
  if new.quota > 0 then
    select greatest(new.quota - count(*), 0) into v_slots
      from public.event_ticket_claims c where c.event_ticket_id = new.id;
    if v_slots = 0 then return new; end if;
  else
    v_slots := null; -- LIMIT NULL means unlimited.
  end if;

  for v_member in
    select m.id from public.members m
    where m.status = 'active'
      and m.membership_status = 'active'
      and coalesce(public.current_tier_key(m.id) = any(new.allowed_tier_keys), false)
      and not exists (
        select 1 from public.event_ticket_claims c
        where c.event_ticket_id = new.id and c.member_id = m.id
      )
      and not exists (
        select 1 from public.event_ticket_transfers t
        where t.event_ticket_id = new.id
          and (t.sender_member_id = m.id or t.receiver_member_id = m.id)
      )
    order by coalesce(m.joined_at, m.created_at), m.id
    limit v_slots
  loop
    insert into public.event_ticket_claims (
      claim_id, event_ticket_id, member_id, ticket_type, ticket_title,
      ticket_description, usage_method, usage_instructions, prizes
    ) values (
      public.new_public_id('EC'), new.id, v_member.id, new.ticket_type,
      new.title, new.description, new.usage_method, new.usage_instructions,
      new.prizes
    )
    on conflict (event_ticket_id, member_id) do nothing;
    get diagnostics v_rows = row_count;
    v_issued := v_issued + v_rows;
  end loop;

  if v_issued > 0 then
    insert into public.audit_logs (
      audit_id, actor_line_user_id, actor_role, action,
      target_type, target_id, result, detail
    ) values (
      public.new_public_id('AUD'), new.updated_by, 'system',
      'admin.event-tickets.auto-issue', 'event_ticket', new.event_ticket_id,
      'success', jsonb_build_object('issuedCount', v_issued, 'quota', new.quota)
    );
  end if;
  return new;
end;
$body$;

drop trigger if exists auto_issue_general_event_ticket on public.event_tickets;
create trigger auto_issue_general_event_ticket
  after insert or update of status on public.event_tickets
  for each row execute function public.auto_issue_general_event_ticket();

-- Compatibility: older booking/member clients can query their ALREADY issued
-- ticket idempotently, but cannot acquire additional inventory with a claim call.
create or replace function public.claim_event_ticket(
  p_line_user_id text, p_event_ticket_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $body$
declare
  v_member public.members%rowtype;
  v_event public.event_tickets%rowtype;
  v_claim_id text;
begin
  select * into v_member from public.members
    where line_user_id = p_line_user_id
      and status = 'active' and membership_status = 'active';
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select * into v_event from public.event_tickets
    where event_ticket_id = p_event_ticket_id for update;
  if not found then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
  if v_event.fixed_ticket_template_id is not null then raise exception 'FIXED_TICKET_AUTO_ONLY'; end if;
  if v_event.ticket_type = 'referral' then raise exception 'REFERRAL_TICKET_AUTO_ONLY'; end if;
  if v_event.ticket_type = 'membership_join' then raise exception 'MEMBERSHIP_JOIN_TICKET_AUTO_ONLY'; end if;

  select claim_id into v_claim_id from public.event_ticket_claims
    where event_ticket_id = v_event.id and member_id = v_member.id;
  if found then
    return jsonb_build_object('claimId', v_claim_id, 'alreadyClaimed', true);
  end if;
  raise exception 'EVENT_TICKET_ISSUANCE_ONLY';
end;
$body$;

revoke all on function public.auto_issue_general_event_ticket() from public, anon, authenticated;
revoke all on function public.claim_event_ticket(text,text) from public, anon, authenticated;
grant execute on function public.claim_event_ticket(text,text) to service_role;

-- Apply the identical contract to existing isolated business schemas.
do $tenants$
declare
  s text;
  fn record;
  ddl text;
  tpl jsonb;
  fns jsonb;
  trgs jsonb;
begin
  for s in select nspname from pg_namespace
           where nspname ~ '^business_[0-9a-f]{32}$' order by nspname
  loop
    if to_regclass(format('%I.event_tickets', s)) is null
      or to_regclass(format('%I.event_ticket_claims', s)) is null
      or to_regclass(format('%I.event_ticket_transfers', s)) is null
    then raise exception 'EVENT_TICKET_TENANT_SCHEMA_INCOMPLETE: %', s; end if;

    for fn in select p.proname, pg_get_functiondef(p.oid) definition
              from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname = 'public'
                and p.proname in ('auto_issue_general_event_ticket', 'claim_event_ticket')
              order by p.proname
    loop
      ddl := replace(fn.definition, 'public.', format('%I.', s));
      execute ddl;
    end loop;
    execute format('drop trigger if exists auto_issue_general_event_ticket on %I.event_tickets', s);
    execute format(
      'create trigger auto_issue_general_event_ticket after insert or update of status on %1$I.event_tickets for each row execute function %1$I.auto_issue_general_event_ticket()',
      s
    );
    execute format('revoke all on function %I.auto_issue_general_event_ticket() from public,anon,authenticated', s);
    execute format('revoke all on function %I.claim_event_ticket(text,text) from public,anon,authenticated', s);
    execute format('grant execute on function %I.claim_event_ticket(text,text) to service_role', s);
  end loop;

  -- Future merchants are provisioned from the frozen JSON blueprint, not public.
  if to_regclass('platform_private.business_templates') is not null then
    select snapshot into tpl from platform_private.business_templates
      where version = 'business-v1-20261019' for update;
    if tpl is null then raise exception 'BUSINESS_TEMPLATE_MISSING'; end if;

    select coalesce(jsonb_agg(f.value order by f.ordinality), '[]'::jsonb) into fns
      from jsonb_array_elements(tpl->'functions') with ordinality f(value, ordinality)
      where f.value->>'name' not in ('auto_issue_general_event_ticket', 'claim_event_ticket');
    select fns || coalesce(jsonb_agg(
      jsonb_build_object('name', p.proname, 'definition', pg_get_functiondef(p.oid))
      order by p.proname
    ), '[]'::jsonb) into fns
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('auto_issue_general_event_ticket', 'claim_event_ticket');
    tpl := jsonb_set(tpl, '{functions}', fns);

    select coalesce(jsonb_agg(t.value order by t.ordinality), '[]'::jsonb) into trgs
      from jsonb_array_elements(tpl->'triggers') with ordinality t(value, ordinality)
      where t.value->>'name' <> 'auto_issue_general_event_ticket';
    select trgs || coalesce(jsonb_agg(jsonb_build_object(
      'name', t.tgname, 'table', 'event_tickets',
      'definition', pg_get_triggerdef(t.oid)
    )), '[]'::jsonb) into trgs
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'event_tickets'
        and t.tgname = 'auto_issue_general_event_ticket'
        and not t.tgisinternal;
    tpl := jsonb_set(tpl, '{triggers}', trgs);

    update platform_private.business_templates
      set snapshot = tpl where version = 'business-v1-20261019';
  end if;
end;
$tenants$;

notify pgrst, 'reload schema';
commit;
