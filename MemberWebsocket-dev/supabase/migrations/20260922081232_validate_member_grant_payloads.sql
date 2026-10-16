create or replace function public.grant_member_benefits(
  p_actor_line_user_id text,
  p_member_line_user_id text,
  p_request_id text,
  p_points jsonb,
  p_service_minutes integer,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_member public.members%rowtype;
  v_item jsonb;
  v_card public.point_cards%rowtype;
  v_amount integer;
  v_now timestamptz := now();
  v_rows integer := 0;
  v_point_grant_count integer := 0;
  v_service_grant_applied boolean := false;
begin
  if length(coalesce(p_request_id,'')) < 16 or length(p_request_id) > 100 then
    raise exception 'INVALID_REQUEST_ID';
  end if;

  if p_points is not null and jsonb_typeof(p_points) <> 'array' then
    raise exception 'INVALID_POINT_AMOUNT';
  end if;

  if p_service_minutes is not null
     and (p_service_minutes < 1 or p_service_minutes > 1440) then
    raise exception 'INVALID_SERVICE_MINUTES';
  end if;

  if coalesce(jsonb_array_length(p_points),0) = 0
     and p_service_minutes is null then
    raise exception 'EMPTY_GRANT';
  end if;

  select * into v_member
  from public.members
  where line_user_id=p_member_line_user_id
  for update;

  if not found then
    raise exception 'MEMBER_NOT_FOUND';
  end if;

  if p_points is not null then
    for v_item in select value from jsonb_array_elements(p_points)
    loop
      begin
        v_amount := (v_item->>'amount')::integer;
      exception when others then
        raise exception 'INVALID_POINT_AMOUNT';
      end;
      if v_amount < 1 or v_amount > 100 then
        raise exception 'INVALID_POINT_AMOUNT';
      end if;

      if nullif(btrim(v_item->>'cardId'),'') is null then
        raise exception 'INVALID_POINT_AMOUNT';
      end if;

      select * into v_card
      from public.point_cards
      where card_id=v_item->>'cardId'
        and status='active'
        and (expiry_mode='unlimited' or expires_on >= (clock_timestamp() at time zone 'Asia/Taipei')::date)
      for update;

      if not found then
        raise exception 'POINT_CARD_NOT_AVAILABLE';
      end if;

      insert into public.point_entries(
        entry_id,member_id,point_card_id,amount,note,created_by,request_id,entry_type
      )
      values(
        public.new_public_id('PE'),v_member.id,v_card.id,v_amount,coalesce(p_note,''),
        p_actor_line_user_id,p_request_id,'grant'
      )
      on conflict(request_id,member_id,point_card_id)
      where request_id is not null and request_id <> ''
      do nothing;

      get diagnostics v_rows = row_count;

      if v_rows > 0 then
        v_point_grant_count := v_point_grant_count + 1;

        insert into public.point_balances(member_id,point_card_id,stamps,updated_at)
        values(v_member.id,v_card.id,v_amount,v_now)
        on conflict(member_id,point_card_id)
        do update
          set stamps=public.point_balances.stamps+excluded.stamps,
              updated_at=v_now;

        perform public.issue_eligible_point_tickets(v_member.id,v_card.id);
      end if;
    end loop;
  end if;

  if p_service_minutes is not null then
    insert into public.service_time_entries(
      entry_id,member_id,minutes,note,created_by,request_id
    )
    values(
      public.new_public_id('SE'),v_member.id,p_service_minutes,coalesce(p_note,''),
      p_actor_line_user_id,p_request_id
    )
    on conflict(request_id,member_id)
    where request_id is not null and request_id <> ''
    do nothing;

    get diagnostics v_rows = row_count;
    v_service_grant_applied := v_rows > 0;
  end if;

  insert into public.audit_logs(
    audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
  )
  values(
    public.new_public_id('AUD'),p_actor_line_user_id,'admin','admin.member-grants.add',
    'member',p_member_line_user_id,'success',
    jsonb_build_object(
      'requestId',p_request_id,
      'requestedPointCount',coalesce(jsonb_array_length(p_points),0),
      'appliedPointCount',v_point_grant_count,
      'requestedServiceMinutes',p_service_minutes,
      'serviceGrantApplied',v_service_grant_applied,
      'applied',(v_point_grant_count > 0 or v_service_grant_applied)
    )
  );

  return jsonb_build_object(
    'memberId',v_member.id,
    'lineUserId',v_member.line_user_id,
    'pointGrantCount',v_point_grant_count,
    'serviceGrantApplied',v_service_grant_applied,
    'applied',(v_point_grant_count > 0 or v_service_grant_applied)
  );
end;
$function$;

revoke all on function public.grant_member_benefits(text,text,text,jsonb,integer,text) from public;
revoke all on function public.grant_member_benefits(text,text,text,jsonb,integer,text) from anon;
revoke all on function public.grant_member_benefits(text,text,text,jsonb,integer,text) from authenticated;
grant execute on function public.grant_member_benefits(text,text,text,jsonb,integer,text) to service_role;
