-- Revoke unused member benefits when an admin deletes a fixed ticket template.
-- Used claims remain as immutable history; active claims disappear from the member UI.

create or replace function public.revoke_deleted_fixed_ticket_benefits()
returns trigger
language plpgsql
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_now timestamptz := coalesce(new.deleted_at, now());
  v_cancelled_claims integer := 0;
  v_archived_events integer := 0;
  v_cancelled_messages integer := 0;
  v_prefix text := 'FIXED-' || new.fixed_ticket_id || '-';
begin
  if old.deleted_at is not null or new.deleted_at is null then
    return new;
  end if;

  update public.event_ticket_claims as claim
  set status = 'cancelled',
      updated_at = v_now
  from public.event_tickets as ticket
  where claim.event_ticket_id = ticket.id
    and ticket.fixed_ticket_template_id = new.id
    and claim.status = 'claimed';
  get diagnostics v_cancelled_claims = row_count;

  update public.scheduled_grant_messages
  set status = 'cancelled',
      last_error = 'fixed_ticket_deleted',
      updated_at = v_now
  where created_by = 'fixed-ticket-automation'
    and status in ('pending', 'failed')
    and left(request_id, char_length(v_prefix)) = v_prefix;
  get diagnostics v_cancelled_messages = row_count;

  update public.event_tickets
  set status = 'archived',
      deleted_at = coalesce(deleted_at, v_now),
      updated_by = coalesce(nullif(new.updated_by, ''), 'fixed-ticket-automation'),
      updated_at = v_now
  where fixed_ticket_template_id = new.id
    and deleted_at is null;
  get diagnostics v_archived_events = row_count;

  insert into public.audit_logs(
    audit_id, actor_line_user_id, actor_role, action, target_type, target_id, result, detail
  ) values (
    public.new_public_id('AUD'),
    coalesce(nullif(new.updated_by, ''), 'system'),
    case when coalesce(new.updated_by, '') = 'fixed-ticket-automation' then 'system' else 'admin' end,
    'fixed_ticket.delete.revoke_benefits',
    'fixed_ticket_template',
    new.fixed_ticket_id,
    'success',
    jsonb_build_object(
      'cancelledClaims', v_cancelled_claims,
      'archivedEventTickets', v_archived_events,
      'cancelledMessages', v_cancelled_messages
    )
  );

  return new;
end;
$function$;

revoke all on function public.revoke_deleted_fixed_ticket_benefits() from public, anon, authenticated;
grant execute on function public.revoke_deleted_fixed_ticket_benefits() to service_role;

drop trigger if exists revoke_deleted_fixed_ticket_benefits on public.fixed_ticket_templates;
create trigger revoke_deleted_fixed_ticket_benefits
after update of deleted_at on public.fixed_ticket_templates
for each row
when (old.deleted_at is null and new.deleted_at is not null)
execute function public.revoke_deleted_fixed_ticket_benefits();
