-- Allow a member to withdraw one point-ticket intent from an unreviewed
-- snapshot without cancelling the receipt or changing any point balance.
-- The receipt row lock serializes this mutation with administrator review.
create or replace function public.member_cancel_snapshot_point_ticket_request(
  p_line_user_id text,
  p_receipt_id text,
  p_ticket_id text,
  p_expected_updated_at timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_member_id uuid;
  v_receipt public.booking_receipts%rowtype;
  v_benefits jsonb;
  v_verified jsonb;
  v_updated_at timestamptz;
begin
  if p_receipt_id is null or p_receipt_id !~ '^BR-[a-fA-F0-9]{32}$'
     or p_ticket_id is null or p_ticket_id !~ '^PT-[a-fA-F0-9]{32}$'
     or p_expected_updated_at is null then
    raise exception 'INVALID_INPUT';
  end if;
  -- Match the member -> receipt lock ordering of the review workflow.
  select id into v_member_id
    from public.members
    where line_user_id = p_line_user_id and status = 'active'
      and membership_status = 'active'
    for update;
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select * into v_receipt from public.booking_receipts
    where receipt_id = p_receipt_id and member_id = v_member_id
      and submission_mode = 'accessible'
    for update;
  if not found then raise exception 'RECEIPT_NOT_OWNED'; end if;
  if v_receipt.status <> 'awaiting_review' then
    raise exception 'RECEIPT_NOT_PENDING';
  end if;

  -- Repeated clicks may safely return a no-op, without ever restoring a ticket.
  if not exists (
    select 1 from jsonb_array_elements(v_receipt.requested_benefits) item
    where item->>'kind' = 'points' and item->>'id' = p_ticket_id
  ) then
    return jsonb_build_object('receiptId',p_receipt_id,'ticketId',p_ticket_id,
      'updatedAt',v_receipt.updated_at,'alreadyApplied',true);
  end if;
  if v_receipt.updated_at is distinct from p_expected_updated_at then
    raise exception 'BOOKING_CONFLICT';
  end if;

  select coalesce(jsonb_agg(entry.item order by entry.ordinality),'[]'::jsonb)
    into v_benefits
    from jsonb_array_elements(v_receipt.requested_benefits) with ordinality as entry(item,ordinality)
    where not (entry.item->>'kind' = 'points' and entry.item->>'id' = p_ticket_id);
  select coalesce(jsonb_agg(entry.item order by entry.ordinality),'[]'::jsonb)
    into v_verified
    from jsonb_array_elements(v_receipt.snapshot_location_verified_tickets)
      with ordinality as entry(item,ordinality)
    where not (entry.item->>'kind' = 'points' and entry.item->>'id' = p_ticket_id);

  update public.booking_receipts
    set requested_benefits = v_benefits,
        snapshot_location_verified_tickets = v_verified,
        updated_at = clock_timestamp()
    where id = v_receipt.id and status = 'awaiting_review'
    returning updated_at into v_updated_at;
  if not found then raise exception 'RECEIPT_NOT_PENDING'; end if;

  insert into public.audit_logs(
    audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
  ) values (
    public.new_public_id('AUD'),p_line_user_id,'member',
    'SNAPSHOT_POINT_TICKET_CANCELLED','receipt',p_receipt_id,'success',
    jsonb_build_object('ticketId',p_ticket_id)
  );
  insert into public.realtime_events(scope,event_type)
    values ('points','user.pointcard.snapshot-ticket.cancel'),
           ('member','user.pointcard.snapshot-ticket.cancel'),
           ('admin','user.pointcard.snapshot-ticket.cancel');

  return jsonb_build_object('receiptId',p_receipt_id,'ticketId',p_ticket_id,
    'updatedAt',v_updated_at,'cancelled',true,'alreadyApplied',false);
end;
$function$;

revoke all on function public.member_cancel_snapshot_point_ticket_request(text,text,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.member_cancel_snapshot_point_ticket_request(text,text,text,timestamptz)
  to service_role;
