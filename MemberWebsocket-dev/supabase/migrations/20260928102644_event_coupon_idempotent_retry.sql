-- Return the original claim on retries even after the campaign ends or is archived.
create or replace function public.claim_event_ticket(p_line_user_id text, p_event_ticket_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $function$
declare
  v_member public.members%rowtype;
  v_event public.event_tickets%rowtype;
  v_tier text;
  v_claim_id text;
  v_today date;
  v_count integer;
begin
  select * into v_member from public.members
    where line_user_id=p_line_user_id and membership_status='active' and status='active';
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  select * into v_event from public.event_tickets
    where event_ticket_id=p_event_ticket_id for update;
  if not found then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
  if v_event.fixed_ticket_template_id is not null then raise exception 'FIXED_TICKET_AUTO_ONLY'; end if;
  select claim_id into v_claim_id from public.event_ticket_claims
    where event_ticket_id=v_event.id and member_id=v_member.id;
  if found then return jsonb_build_object('claimId',v_claim_id,'alreadyClaimed',true); end if;
  if v_event.deleted_at is not null or v_event.status <> 'active' then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
  v_today := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  if v_event.starts_on is not null and v_today < v_event.starts_on then raise exception 'EVENT_NOT_STARTED'; end if;
  if v_event.ends_on is not null and v_today > v_event.ends_on then raise exception 'EVENT_ENDED'; end if;
  v_tier := public.current_tier_key(v_member.id);
  if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception 'TIER_NOT_ALLOWED'; end if;

  if v_event.quota > 0 then
    select count(*)::integer into v_count from public.event_ticket_claims where event_ticket_id=v_event.id;
    if v_count >= v_event.quota then raise exception 'EVENT_QUOTA_REACHED'; end if;
  end if;
  v_claim_id := public.new_public_id('EC');
  insert into public.event_ticket_claims(
    claim_id,event_ticket_id,member_id,ticket_type,ticket_title,ticket_description,usage_method,usage_instructions,prizes
  ) values (
    v_claim_id,v_event.id,v_member.id,v_event.ticket_type,v_event.title,v_event.description,v_event.usage_method,v_event.usage_instructions,v_event.prizes
  );
  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result)
    values(public.new_public_id('AUD'),v_member.line_user_id,'member','user.event.ticket.claim','event_ticket',v_event.event_ticket_id,'success');
  return jsonb_build_object('claimId',v_claim_id,'alreadyClaimed',false);
end;
$function$;
revoke all on function public.claim_event_ticket(text,text) from public, anon, authenticated;
grant execute on function public.claim_event_ticket(text,text) to service_role;

