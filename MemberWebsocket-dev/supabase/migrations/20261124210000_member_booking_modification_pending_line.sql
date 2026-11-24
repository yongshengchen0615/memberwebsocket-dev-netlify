-- AC-MOD-002/003: Member LINE acknowledgement of an edited appointment stays
-- pending until a privileged manager or frontdesk review. The existing
-- booking exclusion constraint, reviewer authorization and status transitions
-- remain the final authority. All notices are transactional and tenant-scoped.
--
-- The audited BOOKING_UPDATED event is already recognized by the deferred
-- notice_enqueue trigger as modified_by_member. Extend that same event, rather
-- than sending a second request from the browser. Patch the provisioning
-- template, existing tenant functions and the legacy public function.
do $install_member_booking_modification_notice$
declare
  template_row jsonb;
  function_row jsonb;
  functions jsonb := '[]'::jsonb;
  source text;
  tenant_source text;
  public_source text;
  business record;
  patched integer := 0;
  marker text := '  elsif event_kind in (''confirmed'',''modified_by_admin'',''completed'',''rejected'',''cancelled'',''cancellation_rejected'') then';
  insertion text := $member_notice$
    -- This event is the member's submitted modification, not an approval.
    -- The same transaction has already inserted BOOKING_UPDATED into audit.
    if event_kind = 'modified_by_member'
       and latest.status = 'pending'
       and member_record.line_user_id ~ '^U[0-9a-f]{32}$'
       and member_record.status = 'active'
       and coalesce(member_record.is_test_account,false) = false then
      member_message := '【修改預約】' ||
        E'\n狀態：等待櫃檯或管理端確認修改預約' ||
        E'\n' || member_details;
      insert into public.notice_outbox(
        booking_id,event_key,channel,recipient,message_text,coalesce_key,next_attempt_at
      ) values (
        NEW.id,event_id || ':member-pending','member',member_record.line_user_id,
        left(member_message,8000),NEW.id::text || ':member-modification-pending',now() + interval '15 seconds'
      )
      on conflict (coalesce_key,channel,recipient)
        where status='pending' and attempt_count=0
          and first_attempt_at is null and coalesce_key is not null
      do update set event_key=excluded.event_key,
                    message_text=excluded.message_text,
                    next_attempt_at=excluded.next_attempt_at,last_error=null;
    end if;
$member_notice$;
begin
  -- Management API and CI release keep independent migration ledgers.
  -- Replaying the already-installed patch must never duplicate notices.
  if exists (
    select 1 from platform_private.business_templates t
    cross join lateral jsonb_array_elements(t.snapshot->'functions') f
    where t.version='business-v1-20261019'
      and f->>'name'='notice_enqueue'
      and position('member-modification-pending' in f->>'definition')>0
  ) then
    if position('member-modification-pending' in
         pg_get_functiondef('booking_notifications.enqueue()'::regprocedure))=0
       or exists (
         select 1 from platform_private.tenants t
         where t.runtime_schema like 'business_%'
           and position('member-modification-pending' in
             pg_get_functiondef(to_regprocedure(format('%I.notice_enqueue()',t.runtime_schema))))=0
       ) then
      raise exception 'BOOKING_MODIFICATION_NOTICE_PARTIAL_INSTALL';
    end if;
  else
  select snapshot into strict template_row
  from platform_private.business_templates
  where version = 'business-v1-20261019' for update;
  for function_row in select value from jsonb_array_elements(template_row->'functions') loop
    if function_row->>'name' = 'notice_enqueue' then
      source := function_row->>'definition';
      if length(source)-length(replace(source,marker,'')) <> length(marker)
         or position('modified_by_member' in source)=0 then
        raise exception 'BOOKING_MODIFICATION_NOTICE_TEMPLATE_DRIFT';
      end if;
      source := replace(source,marker,insertion || marker);
      function_row := jsonb_set(function_row,'{definition}',to_jsonb(source));
      for business in
        select runtime_schema from platform_private.tenants
        where runtime_schema ~ '^business_[0-9a-f]{32}$'
      loop
        select pg_get_functiondef(to_regprocedure(format('%I.notice_enqueue()',business.runtime_schema)))
          into tenant_source;
        if tenant_source is null
           or length(tenant_source)-length(replace(tenant_source,marker,'')) <> length(marker) then
          raise exception 'BOOKING_MODIFICATION_NOTICE_TENANT_DRIFT: %',business.runtime_schema;
        end if;
        execute replace(tenant_source,marker,
          replace(insertion,'public.',format('%I.',business.runtime_schema)) || marker);
      end loop;
      patched := patched + 1;
    end if;
    functions := functions || jsonb_build_array(function_row);
  end loop;
  if patched <> 1 then
    raise exception 'BOOKING_MODIFICATION_NOTICE_TEMPLATE_MISSING';
  end if;
  update platform_private.business_templates
    set snapshot=jsonb_set(template_row,'{functions}',functions)
    where version='business-v1-20261019';

  select pg_get_functiondef('booking_notifications.enqueue()'::regprocedure)
    into strict public_source;
  if length(public_source)-length(replace(public_source,marker,'')) <> length(marker) then
    raise exception 'BOOKING_MODIFICATION_NOTICE_PUBLIC_DRIFT';
  end if;
  execute replace(public_source,marker,
    replace(replace(insertion,'public.notice_outbox','booking_notifications.outbox'),
      'left(member_message,8000)','left(member_message,2200)') || marker);
  end if;
end $install_member_booking_modification_notice$;
