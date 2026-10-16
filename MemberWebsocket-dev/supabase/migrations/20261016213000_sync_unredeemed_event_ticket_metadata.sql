-- AC-001/002: Management edits become authoritative for unredeemed tickets.
-- Keep already-used/cancelled/expired ticket snapshots immutable for audit.
-- This trigger executes in the same transaction as event_tickets UPDATE.
create or replace function public.sync_unredeemed_event_claim_metadata()
returns trigger
language plpgsql
set search_path = 'public', 'pg_temp'
as $function$
begin
  update public.event_ticket_claims as c
  set ticket_type = new.ticket_type,
      ticket_title = new.title,
      ticket_description = new.description,
      usage_method = new.usage_method,
      usage_instructions = new.usage_instructions,
      prizes = new.prizes,
      updated_at = now()
  where c.event_ticket_id = new.id
    and c.status = 'claimed'
    and (c.ticket_type,c.ticket_title,c.ticket_description,c.usage_method,c.usage_instructions,c.prizes)
      is distinct from
        (new.ticket_type,new.title,new.description,new.usage_method,new.usage_instructions,new.prizes);
  return new;
end;
$function$;

revoke all on function public.sync_unredeemed_event_claim_metadata() from public, anon, authenticated;

drop trigger if exists sync_unredeemed_event_claim_metadata on public.event_tickets;
create trigger sync_unredeemed_event_claim_metadata
after update of ticket_type,title,description,usage_method,usage_instructions,prizes on public.event_tickets
for each row
when (
  old.ticket_type is distinct from new.ticket_type
  or old.title is distinct from new.title
  or old.description is distinct from new.description
  or old.usage_method is distinct from new.usage_method
  or old.usage_instructions is distinct from new.usage_instructions
  or old.prizes is distinct from new.prizes
)
execute function public.sync_unredeemed_event_claim_metadata();

-- Reconcile pre-existing unredeemed claims once; never touch redeemed history.
update public.event_ticket_claims as c
set ticket_type = e.ticket_type,
    ticket_title = e.title,
    ticket_description = e.description,
    usage_method = e.usage_method,
    usage_instructions = e.usage_instructions,
    prizes = e.prizes,
    updated_at = now()
from public.event_tickets as e
where c.event_ticket_id = e.id
  and c.status = 'claimed'
  and e.status = 'active'
  and e.deleted_at is null
  and (c.ticket_type,c.ticket_title,c.ticket_description,c.usage_method,c.usage_instructions,c.prizes)
    is distinct from
      (e.ticket_type,e.title,e.description,e.usage_method,e.usage_instructions,e.prizes);

-- Fixed-ticket templates were previously broadcast to admin only.
-- Materialized active cycles are refreshed by issue_fixed_tickets after save;
-- the event-only notification also ensures an open member view re-fetches.
create or replace function public.notify_fixed_ticket_template_event_change()
returns trigger
language plpgsql
set search_path = 'public', 'pg_temp'
as $function$
begin
  perform public.emit_realtime_invalidation(
    array['event']::text[],
    'admin.db.fixed_ticket_templates.' || lower(tg_op)
  );
  return null;
end;
$function$;

revoke all on function public.notify_fixed_ticket_template_event_change() from public, anon, authenticated;

drop trigger if exists notify_fixed_ticket_template_event_change on public.fixed_ticket_templates;
create trigger notify_fixed_ticket_template_event_change
after insert or update or delete on public.fixed_ticket_templates
for each statement
execute function public.notify_fixed_ticket_template_event_change();
