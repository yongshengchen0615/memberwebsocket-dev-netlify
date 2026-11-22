-- AC-ADM-FD-007: repair clock-domain mismatch in admin-paired LINE outbox
-- suppression. bookings.created_at defaults to transaction-stable now(), while
-- rejection/audit timestamps use later clock_timestamp(). Comparing the two
-- can reject legitimate, atomically audited admin pairs. Instead authenticate
-- on tenant, actor, both audit events, booking date, rejection reason and the
-- exact same audit timestamp. No role, status or normal LINE routing changes.
create or replace function platform_private.admin_paired_walkin_source(
  p_schema text, p_booking jsonb
) returns uuid
language plpgsql security definer set search_path='' as $admin_pair$
declare v_original uuid;v_valid boolean;v_source text;
begin
 if p_schema !~ '^business_[0-9a-f]{32}$'
   or not exists(select 1 from platform_private.tenants where runtime_schema=p_schema)
 then return null;end if;
 if p_booking->>'status' not in ('pending','confirmed') then return null;end if;
 v_source:=substring(coalesce(p_booking->>'admin_note','') from
   '^原預約 ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) 拒絕後的現場／電話預約$');
 if v_source is null then return null;end if;
 v_original:=v_source::uuid;
 execute format($verify$
  select exists(
    select 1 from %1$I.bookings original
    join %1$I.booking_audit_events rejected
      on rejected.target_type='booking' and rejected.target_id=original.id::text
        and rejected.action='BOOKING_REJECTED'
        and rejected.actor_role='admin' and rejected.result='success'
        and rejected.actor_line_user_id=original.rejected_by
        and rejected.metadata->>'rejectionReason'='unrecorded_phone_booking'
    join %1$I.booking_audit_events replacement
      on replacement.target_type='booking' and replacement.target_id=$2::text
        and replacement.action='BOOKING_PHONE_CREATED'
        and replacement.actor_role='admin' and replacement.result='success'
        and replacement.actor_line_user_id=rejected.actor_line_user_id
        and replacement.created_at=rejected.created_at
    where original.id=$1 and original.id<>$2
      and original.status='rejected'
      and original.rejection_reason='unrecorded_phone_booking'
      and original.booking_date=$3
      and original.rejected_at=rejected.created_at
  )$verify$,p_schema)
 into v_valid using v_original,(p_booking->>'id')::uuid,
    (p_booking->>'booking_date')::date;
 return case when v_valid then v_original else null end;
end $admin_pair$;
revoke all on function platform_private.admin_paired_walkin_source(text,jsonb)
  from public,anon,authenticated;

-- Skip only unclaimed, never-attempted previously queued notices. Already
-- attempted or sent LINE messages cannot be recalled.
do $cleanup$
declare t record;
begin
 for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
  execute format($q$
   update %1$I.notice_outbox o
   set status='skipped',last_error='ADMIN_WALKIN_FRONTDESK_NOTICE_SUPPRESSED'
   from %1$I.bookings b
   where o.booking_id=b.id and o.channel='frontdesk'
     and o.event_key=b.id::text||':created'
     and o.status='pending' and o.attempt_count=0 and o.first_attempt_at is null
     and platform_private.admin_paired_walkin_source(%2$L,to_jsonb(b)) is not null
  $q$,t.runtime_schema,t.runtime_schema);
 end loop;
end $cleanup$;
