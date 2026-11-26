-- AC-001: a member may own multiple distinct claim_ids for one campaign.
-- AC-002: a physical claim can still be transferred only once (ledger + RPC).
-- Apply to public, existing merchant schemas, and future merchant blueprint.
do $repeat$
declare
  s text;
  fn_name text;
  definition text;
  rewritten text;
  old_guard text;
  template jsonb;
  template_functions jsonb;
  template_indexes jsonb;
  rec record;
begin
  for s in
    select nspname from pg_namespace
    where nspname = 'public' or nspname ~ '^business_[0-9a-f]{32}$'
    order by nspname
  loop
    if to_regclass(format('%I.event_ticket_claims',s)) is null
       or to_regclass(format('%I.event_ticket_transfers',s)) is null then
      continue;
    end if;

    -- Keep the globally unique claim_id; only release campaign/member exclusivity.
    execute format('alter table %I.event_ticket_claims drop constraint if exists event_ticket_claims_event_ticket_id_member_id_key',s);
    execute format('create index if not exists event_claims_campaign_member_idx on %I.event_ticket_claims(event_ticket_id,member_id,created_at desc)',s);

    -- Deny re-creating the *same physical claim* after transfer, not future
    -- claims for any prior sender or recipient of the same campaign.
    if to_regprocedure(format('%I.prevent_event_ticket_reclaim_after_transfer()',s)) is not null then
      execute format($create$
        create or replace function %1$I.prevent_event_ticket_reclaim_after_transfer()
        returns trigger language plpgsql security definer set search_path = ''
        as $body$
        begin
          if exists (
            select 1 from %1$I.event_ticket_transfers t
            where t.claim_id = new.claim_id
          ) then
            raise exception 'EVENT_TICKET_ALREADY_TRANSFERRED';
          end if;
          return new;
        end;
        $body$;
      $create$,s);
    end if;

    -- The original RPC enforces friendship, active membership, unredeemed
    -- ownership, reservations, campaign lock and one-time physical gifting.
    -- Remove ONLY its historic-recipient / already-owns-campaign rejection.
    if to_regprocedure(format('%I.transfer_event_ticket_to_friend(text,text,text,text)',s)) is not null then
      select pg_get_functiondef(to_regprocedure(format('%I.transfer_event_ticket_to_friend(text,text,text,text)',s)))
        into definition;
      old_guard := format($guard$  if exists (
    select 1 from %1$I.event_ticket_claims c
      where c.event_ticket_id = v_ticket.id and c.member_id = v_receiver.id
  ) or exists (
    select 1 from %1$I.event_ticket_transfers t
      where t.event_ticket_id = v_ticket.id
        and (t.sender_member_id = v_receiver.id or t.receiver_member_id = v_receiver.id)
  ) then
    raise exception 'EVENT_TICKET_RECEIVER_ALREADY_OWNED';
  end if;$guard$,s);
      if position(old_guard in definition) = 0 then
        raise exception 'REPEAT_GIFT_TRANSFER_GUARD_NOT_FOUND_IN_SCHEMA: %',s;
      end if;
      execute replace(definition,old_guard,'');
    end if;

    -- These server-only issuers already check eligibility and previous issuance.
    -- Without the removed unique key their conflict *target* would be invalid.
    for fn_name in select unnest(array[
      'issue_eligible_general_event_ticket',
      'issue_fixed_tickets',
      'auto_issue_general_event_ticket'
    ])
    loop
      for rec in
        select p.oid,pg_get_functiondef(p.oid) definition
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname=s and p.proname=fn_name
      loop
        rewritten := regexp_replace(
          rec.definition,
          'on conflict[[:space:]]*\([[:space:]]*event_ticket_id[[:space:]]*,[[:space:]]*member_id[[:space:]]*\)[[:space:]]*do nothing',
          'on conflict do nothing','gi'
        );
        if rewritten <> rec.definition then execute rewritten; end if;
      end loop;
    end loop;
  end loop;

  -- Provisioned businesses must inherit identical rules. Update the existing
  -- blueprint in-place, preserving unrelated table definitions and functions.
  if to_regclass('platform_private.business_templates') is not null then
    for rec in select version,snapshot from platform_private.business_templates
      where version='business-v1-20261019'
    loop
      template := rec.snapshot;
      template := jsonb_set(template,'{constraints}',(
        select coalesce(jsonb_agg(c order by ord),'[]'::jsonb)
        from jsonb_array_elements(template->'constraints') with ordinality x(c,ord)
        where not (c->>'table'='event_ticket_claims'
          and c->>'name'='event_ticket_claims_event_ticket_id_member_id_key')
      ));
      select coalesce(jsonb_agg(
        case when f->>'name' in (
          'prevent_event_ticket_reclaim_after_transfer',
          'transfer_event_ticket_to_friend',
          'issue_eligible_general_event_ticket',
          'issue_fixed_tickets',
          'auto_issue_general_event_ticket'
        ) then jsonb_set(f,'{definition}',to_jsonb(pg_get_functiondef((
          select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname=f->>'name'
          order by p.oid limit 1
        ))))
        else f end order by ord
      ),'[]'::jsonb) into template_functions
      from jsonb_array_elements(template->'functions') with ordinality x(f,ord);
      template := jsonb_set(template,'{functions}',template_functions);
      if not exists (
        select 1 from jsonb_array_elements(template->'indexes') i
        where i->>'table'='event_ticket_claims'
          and i->>'definition' ilike '%event_claims_campaign_member_idx%'
      ) then
        select pg_get_indexdef(indexrelid) into definition
        from pg_index i join pg_class c on c.oid=i.indrelid
        join pg_namespace n on n.oid=c.relnamespace
        join pg_class idx on idx.oid=i.indexrelid
        where n.nspname='public' and c.relname='event_ticket_claims'
          and idx.relname='event_claims_campaign_member_idx';
        if definition is not null then
          template := jsonb_set(template,'{indexes}',
            template->'indexes' || jsonb_build_array(jsonb_build_object(
              'table','event_ticket_claims','definition',definition)));
        end if;
      end if;
      update platform_private.business_templates set snapshot=template
      where version=rec.version;
    end loop;
  end if;
end;
$repeat$;
notify pgrst,'reload schema';
