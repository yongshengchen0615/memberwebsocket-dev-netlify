-- Advance only this test member's own UI fixture history to a previous test day.
-- Production redemption limits and formal tickets remain unchanged.
create or replace function public.prepare_e2e_event_redemption_day(p_member_id uuid,p_fixture_tag text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $function$
declare v_day_start timestamptz := ((now() at time zone 'Asia/Taipei')::date::timestamp at time zone 'Asia/Taipei'); v_moved integer;
begin
  if p_fixture_tag is null or p_fixture_tag !~ '^[A-F0-9]{16}$' then raise exception 'INVALID_QA_FIXTURE'; end if;
  perform 1 from public.members where id=p_member_id and is_test_account is true and status='active' and membership_status='active' for update;
  if not found then raise exception 'TEST_ACCOUNT_REQUIRED'; end if;
  if not exists(select 1 from public.event_tickets where created_by='qa-ui:'||p_member_id::text||':'||p_fixture_tag
    and event_ticket_id like 'QA-UI-EVT-%' and deleted_at is null) then raise exception 'QA_FIXTURE_NOT_OWNED'; end if;
  update public.event_ticket_claims c set used_at=v_day_start-interval '1 second',updated_at=now()
  from public.event_tickets e
  where c.event_ticket_id=e.id and c.member_id=p_member_id and c.status='used'
    and c.used_at >= v_day_start
    and c.used_at < v_day_start+interval '1 day'
    and e.event_ticket_id like 'QA-UI-EVT-%'
    and e.created_by ~ ('^qa-ui:'||p_member_id::text||':[A-F0-9]{16}$');
  get diagnostics v_moved=row_count;
  return jsonb_build_object('qaHistoryMoved',v_moved,'fixtureDate',(v_day_start at time zone 'Asia/Taipei')::date,'productionLimitUnchanged',true);
end;
$function$;
revoke all on function public.prepare_e2e_event_redemption_day(uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_e2e_event_redemption_day(uuid,text) to service_role;
