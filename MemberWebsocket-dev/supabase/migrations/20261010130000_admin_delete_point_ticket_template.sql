-- Administrator-only ticket library deletion.
-- Issued point tickets keep their snapshot; point_tickets.ticket_template_id
-- has ON DELETE SET NULL. A template referenced by a reward must be unlinked first.
create or replace function public.delete_point_ticket_template(
  p_actor_line_user_id text,
  p_ticket_template_id text,
  p_expected_updated_at text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_template public.ticket_templates%rowtype;
  v_expected timestamptz;
  v_issued_count bigint;
  v_reward_count bigint;
begin
  if nullif(btrim(p_actor_line_user_id), '') is null then
    raise exception 'ADMIN_REQUIRED';
  end if;

  if nullif(btrim(p_ticket_template_id), '') is null then
    raise exception 'TICKET_TEMPLATE_DELETE_NOT_FOUND';
  end if;

  begin
    v_expected := p_expected_updated_at::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'INVALID_TICKET_TEMPLATE_VERSION';
  end;
  if v_expected is null then
    raise exception 'INVALID_TICKET_TEMPLATE_VERSION';
  end if;

  select * into v_template
  from public.ticket_templates
  where ticket_template_id = p_ticket_template_id
  for update;
  if not found then
    raise exception 'TICKET_TEMPLATE_DELETE_NOT_FOUND';
  end if;
  if v_template.updated_at is distinct from v_expected then
    raise exception 'CONFLICT';
  end if;

  select count(*) into v_reward_count
  from public.point_card_rewards
  where ticket_template_id = v_template.id;
  if v_reward_count > 0 then
    raise exception 'TICKET_TEMPLATE_IN_USE';
  end if;

  select count(*) into v_issued_count
  from public.point_tickets
  where ticket_template_id = v_template.id;

  -- FK RESTRICT also protects against a concurrent reward attachment.
  begin
    delete from public.ticket_templates where id = v_template.id;
  exception when foreign_key_violation then
    raise exception 'TICKET_TEMPLATE_IN_USE';
  end;

  insert into public.audit_logs (
    audit_id, actor_line_user_id, actor_role, action,
    target_type, target_id, result, detail
  ) values (
    'AUD-' || gen_random_uuid()::text, p_actor_line_user_id, 'admin',
    'TICKET_TEMPLATE_DELETED', 'ticket_template', p_ticket_template_id,
    'success', jsonb_build_object(
      'title', v_template.title,
      'preservedTicketCount', v_issued_count
    )
  );

  return jsonb_build_object(
    'deleted', true,
    'ticketTemplateId', p_ticket_template_id,
    'preservedTicketCount', v_issued_count
  );
end;
$function$;

revoke all on function public.delete_point_ticket_template(text,text,text)
from public, anon, authenticated;
grant execute on function public.delete_point_ticket_template(text,text,text)
to service_role;
