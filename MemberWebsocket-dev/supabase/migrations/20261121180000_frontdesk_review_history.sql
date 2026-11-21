-- Read-only, tenant-scoped frontdesk review history.
-- Audits are the source of truth for who performed an action and when;
-- the booking projection is explicitly the CURRENT booking data.
create or replace function public.platform_frontdesk_history(
  p_actor text,
  p_tenant_id uuid,
  p_issued_at timestamptz,
  p_status text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  t platform_private.tenants;
  records jsonb;
begin
  t := platform_private.require_merchant_access(p_actor,p_tenant_id,p_issued_at);
  if t.features->>'booking' is distinct from 'true'
     or t.features->>'frontdesk' is distinct from 'true' then
    raise exception 'FRONTDESK_UNAVAILABLE';
  end if;
  if p_status is null or p_status not in ('confirmed','rejected') then
    raise exception 'PLATFORM_INVALID_INPUT';
  end if;
  if t.runtime_schema is null
     or t.runtime_schema !~ '^business_[0-9a-f]{32}$' then
    raise exception 'FRONTDESK_UNAVAILABLE';
  end if;
  execute format($query$
    select coalesce(jsonb_agg(jsonb_build_object(
      'eventId', e.id,
      'actionAt', e.created_at,
      'bookingId', e.target_id,
      'actorName', coalesce(
        (select nullif(s.display_name,'') from platform_private.frontdesk_staff s
         where s.tenant_id=$2 and s.line_user_id=e.actor_line_user_id limit 1),
        '櫃檯人員（帳號已移除）'
      ),
      'rejectionReason', coalesce(e.metadata->>'rejectionReason',b.rejection_reason),
      'currentStatus', b.status,
      'booking', platform_private.frontdesk_booking_json($3,b.id),
      'phoneBooking', case when e.metadata->>'rejectionReason'='unrecorded_phone_booking' then (
        select platform_private.frontdesk_booking_json($3,phone.id)
        from %1$I.booking_audit_events paired_audit
        join %1$I.bookings phone on phone.id::text=paired_audit.target_id
        where paired_audit.actor_role='frontdesk'
          and paired_audit.action='BOOKING_PHONE_CREATED'
          and paired_audit.target_type='booking'
          and paired_audit.created_at=e.created_at
          and paired_audit.actor_line_user_id=e.actor_line_user_id
          and platform_private.frontdesk_paired_phone_source($3,to_jsonb(phone))=b.id
        order by paired_audit.id desc
        limit 1
      ) else null end
    ) order by e.id desc), '[]'::jsonb)
    from (
      select id,created_at,target_id,actor_line_user_id,metadata
      from %1$I.booking_audit_events
      where actor_role='frontdesk'
        and target_type='booking'
        and result='success'
        and action=$1
      order by id desc
      limit 50
    ) e
    left join %1$I.bookings b on b.id::text=e.target_id
  $query$, t.runtime_schema)
  into records
  using 'BOOKING_'||upper(p_status), t.id,t.runtime_schema;
  return jsonb_build_object('status',p_status,'limit',50,'items',coalesce(records,'[]'::jsonb));
end
$function$;
revoke all on function public.platform_frontdesk_history(text,uuid,timestamptz,text)
from public, anon, authenticated;
grant execute on function public.platform_frontdesk_history(text,uuid,timestamptz,text)
to service_role;
