-- AC-FR-008: Both audit events are created by the same atomic transaction.
-- PG now() used for booking.created_at is the transaction START, but
-- rejected_at uses clock_timestamp(), which is later within that transaction.
-- Comparing those timestamps incorrectly rejects genuine paired bookings.
-- Require audit records from the same transaction timestamp instead.
create or replace function platform_private.frontdesk_paired_phone_source(p_schema text,p_booking jsonb)
returns uuid language plpgsql security definer set search_path='' as $pair$
declare v_id uuid;v_source text;v_valid boolean;
begin
 if p_schema !~ '^business_[0-9a-f]{32}$' or
   not exists(select 1 from platform_private.tenants where runtime_schema=p_schema) then
   return null;
 end if;
 if p_booking->>'status' is distinct from 'pending' then return null;end if;
 v_source:=substring(coalesce(p_booking->>'admin_note','')
   from '^原預約 ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) 拒絕後的現場／電話預約$');
 if v_source is null then return null;end if;
 v_id:=v_source::uuid;
 execute format($q$
  select exists(
    select 1 from %1$I.bookings original
    where original.id=$1 and original.id<>$2
      and original.status='rejected' and original.rejection_reason='unrecorded_phone_booking'
      and original.rejected_by ~ '^U[0-9a-f]{32}$'
      and original.booking_date=$3
      and original.rejected_at is not null
      and exists(select 1 from %1$I.booking_audit_events phone_audit
        join %1$I.booking_audit_events reject_audit
          on reject_audit.created_at=phone_audit.created_at
         and reject_audit.actor_line_user_id=phone_audit.actor_line_user_id
        where phone_audit.target_type='booking'
          and phone_audit.target_id=$2::text
          and phone_audit.action='BOOKING_PHONE_CREATED'
          and phone_audit.actor_role='frontdesk'
          and phone_audit.actor_line_user_id=original.rejected_by
          and reject_audit.target_type='booking'
          and reject_audit.target_id=original.id::text
          and reject_audit.action='BOOKING_REJECTED'
          and reject_audit.actor_role='frontdesk')
  )$q$,p_schema) into v_valid using v_id,(p_booking->>'id')::uuid,
  (p_booking->>'booking_date')::date;
 return case when v_valid then v_id else null end;
end $pair$;

revoke all on function platform_private.frontdesk_paired_phone_source(text,jsonb) from public,anon,authenticated;

-- This helper runs as a trusted private function only; standalone phone.create
-- is still pending. Changes to the evidence gate affect no existing booking
-- state and cannot create or delete any LINE outbox rows.
