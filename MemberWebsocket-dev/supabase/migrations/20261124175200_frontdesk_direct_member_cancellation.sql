-- AC-002..005: tenant-scoped, atomic member cancellation when the super-admin
-- grant AND merchant frontdesk configuration are active. Legacy approval stays.
-- The SQL release runner wraps this migration in its own transaction.
create or replace function public.platform_member_direct_cancel_booking(
  p_tenant_id uuid,
  p_booking_id uuid,
  p_member_id uuid,
  p_actor text,
  p_expected_updated_at timestamptz default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  t platform_private.tenants;
  b record;
  m record;
  updated record;
  cancelled_at timestamptz := clock_timestamp();
begin
  if p_tenant_id is null or p_booking_id is null or p_member_id is null
     or p_actor is null or p_actor !~ '^U[0-9a-f]{32}$' then
    raise exception 'BOOKING_INVALID_INPUT';
  end if;

  -- Uses the platform's tenant/qualification/expiry checks and tenant lock.
  -- Never trust a frontdesk flag or schema name supplied by a caller.
  t := platform_private.frontdesk_tenant(p_tenant_id);
  if t.features->>'booking' is distinct from 'true'
     or t.features->>'frontdesk' is distinct from 'true'
     or t.module_line->'booking'->'frontdesk'->>'enabled' is distinct from 'true' then
    raise exception 'FRONTDESK_DIRECT_CANCELLATION_DISABLED';
  end if;

  execute format(
    'select id from %I.members where id=$1 and line_user_id=$2 and status=''active'' and membership_status=''active''',
    t.runtime_schema
  ) into m using p_member_id,p_actor;
  if m.id is null then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  execute format(
    'select id,member_id,status,start_at,updated_at,cancelled_by,cancellation_requested_by,'||
    'cancellation_requested_at,cancellation_reviewed_at from %I.bookings '||
    'where id=$1 and member_id=$2 for update',
    t.runtime_schema
  ) into b using p_booking_id,p_member_id;
  if b.id is null then raise exception 'BOOKING_NOT_FOUND'; end if;

  -- Retry after a successful response can never duplicate status transitions,
  -- point/ticket releases, audit events or LINE outbox entries.
  if b.status='cancelled' and b.cancelled_by=p_actor
     and b.cancellation_requested_by=p_actor
     and b.cancellation_reviewed_at is not null then
    return jsonb_build_object('bookingId',b.id,'status','cancelled',
                              'alreadyCancelled',true,'updatedAt',b.updated_at);
  end if;
  if b.status not in ('pending','confirmed') then raise exception 'BOOKING_NOT_CANCELLABLE'; end if;
  if b.start_at is null or b.start_at <= (clock_timestamp() at time zone 'Asia/Taipei') then
    raise exception 'BOOKING_TIME_PASSED';
  end if;
  if p_expected_updated_at is not null and b.updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_CONFLICT';
  end if;

  -- Put the actor's audit in the SAME transaction ahead of notice triggers
  -- (which inspect the latest actor). The booking guard sees approved review
  -- metadata in the same UPDATE; there is never a pending-review window.
  execute format(
    'insert into %I.booking_audit_events '||
    '(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata) '||
    'values($1,''member'',''BOOKING_CANCELLED_DIRECT'',''booking'',$2,''success'',$3)',
    t.runtime_schema
  ) using p_actor,p_booking_id,jsonb_build_object('mode','frontdesk','sourceStatus',b.status);

  execute format(
    'update %I.bookings set status=''cancelled'',cancelled_by=$1,cancelled_at=$2,'||
    'cancellation_requested_at=coalesce(cancellation_requested_at,$2),'||
    'cancellation_requested_by=coalesce(cancellation_requested_by,$1),'||
    'cancellation_source_status=$3,cancellation_reviewed_at=$2,'||
    'cancellation_reviewed_by=''system:frontdesk'',cancellation_decision=''approved'' '||
    'where id=$4 and member_id=$5 and status=$3 and updated_at=$6 '||
    'returning id,status,updated_at',
    t.runtime_schema
  ) into updated using p_actor,cancelled_at,b.status,p_booking_id,p_member_id,b.updated_at;

  if updated.id is null then raise exception 'BOOKING_CONFLICT'; end if;
  return jsonb_build_object('bookingId',updated.id,'status',updated.status,
                            'alreadyCancelled',false,'updatedAt',updated.updated_at);
end;
$function$;

revoke all on function public.platform_member_direct_cancel_booking(uuid,uuid,uuid,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.platform_member_direct_cancel_booking(uuid,uuid,uuid,text,timestamptz)
  to service_role;
comment on function public.platform_member_direct_cancel_booking(uuid,uuid,uuid,text,timestamptz) is
  'Service-role-only, tenant-locked member cancellation. Requires frontdesk grant and configured entry; updates booking, audit, notifications and benefit release atomically.';


-- Existing notice_enqueue sends cancelled events to members only. For member
-- direct-cancel events (and *only* those events) also enqueue administrator and
-- authorized frontdesk notifications. Patch the template for future businesses
-- and existing tenant functions in one migration transaction.
do $install_direct_cancel_notices$
declare
  tpl jsonb;
  f jsonb;
  functions jsonb := '[]'::jsonb;
  definition text;
  tenant_definition text;
  tenant_marker text;
  tenant_addition text;
  marker text := E'  end if;\n\n  begin\n    perform public.notice_dispatch(20);';
  addition text := $fanout$  end if;

  -- Legacy manager-reviewed cancellations retain their existing recipients.
  -- Only an authenticated member's atomic frontdesk cancellation has this
  -- system review marker. The member message is already enqueued above.
  if event_kind = 'cancelled'
     and NEW.cancellation_reviewed_by = 'system:frontdesk' then
    admin_message := '【取消預約】' || E'\n' || admin_details;
    insert into public.notice_outbox(
      booking_id,event_key,channel,recipient,message_text
    )
      select NEW.id,event_id,'admin',a.line_user_id,left(admin_message,8000)
      from public.admins a
      where a.status='active' and a.role='admin'
        and a.line_user_id ~ '^U[0-9a-f]{32}$'
      on conflict (event_key,channel,recipient) do nothing;

    insert into public.notice_outbox(
      booking_id,event_key,channel,recipient,message_text
    )
      select NEW.id,event_id,'frontdesk',d.line_user_id,left(admin_message,8000)
      from public.frontdesk_notice_recipients d
      on conflict (event_key,channel,recipient) do nothing;
  end if;

  begin
    perform public.notice_dispatch(20);$fanout$;
  business record;
  affected integer := 0;
begin
  select snapshot into strict tpl from platform_private.business_templates
    where version='business-v1-20261019' for update;
  for f in select value from jsonb_array_elements(tpl->'functions') loop
    if f->>'name' = 'notice_enqueue' then
      definition := f->>'definition';
      if position(marker in definition) = 0
         or position('frontdesk_notice_recipients' in definition) = 0 then
        raise exception 'DIRECT_CANCELLATION_NOTICE_TEMPLATE_DRIFT';
      end if;
      definition := replace(definition,marker,addition);
      f := jsonb_set(f,'{definition}',to_jsonb(definition));
      -- Existing merchants have extra paired-rejection INSERT guards installed
      -- by earlier migrations. Never overwrite their function from the generic
      -- template: patch their current definition while retaining every guard.
      for business in select runtime_schema from platform_private.tenants
                        where runtime_schema is not null loop
        select pg_get_functiondef(
          to_regprocedure(format('%I.notice_enqueue()',business.runtime_schema))
        ) into strict tenant_definition;
        tenant_marker := replace(marker,'public.',format('%I.',business.runtime_schema));
        tenant_addition := replace(addition,'public.',format('%I.',business.runtime_schema));
        if (length(tenant_definition)-length(replace(tenant_definition,tenant_marker,'')))
           <> length(tenant_marker) then
          raise exception 'DIRECT_CANCELLATION_NOTICE_TENANT_DRIFT: %',business.runtime_schema;
        end if;
        execute replace(tenant_definition,tenant_marker,tenant_addition);
      end loop;
      affected := affected + 1;
    end if;
    functions := functions || jsonb_build_array(f);
  end loop;
  if affected <> 1 then
    raise exception 'DIRECT_CANCELLATION_NOTICE_TEMPLATE_MISSING';
  end if;
  update platform_private.business_templates
    set snapshot=jsonb_set(tpl,'{functions}',functions)
    where version='business-v1-20261019';
end $install_direct_cancel_notices$;
