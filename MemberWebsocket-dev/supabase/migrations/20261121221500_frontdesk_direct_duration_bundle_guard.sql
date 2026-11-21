-- AC-FR-DURATION-003: allow only verified, already paired/confirmed frontdesk
-- duration-only slot snapshots through the existing deferred bundle invariant.
-- Standard phone/member/admin bookings still require the real service bundle.
-- This migration is additive and idempotent across tenant runtime schemas.
do $patch$
declare
 t record;
 d text;
 v_old constant text:=$old$  if v_store_count <> 1 or v_visible_count < 1 or v_invalid_store_count <> 0 then$old$;
 v_extra text;
begin
 for t in select runtime_schema from platform_private.tenants loop
  if t.runtime_schema !~ '^business_[0-9a-f]{32}$' then
   raise exception 'FRONTDESK_BUNDLE_INVALID_TENANT';
  end if;
  select pg_get_functiondef((format('%I.assert_booking_item_bundle()',t.runtime_schema))::regprocedure)
   into strict d;
  if position('frontdesk_paired_phone_source' in d)>0 then
   if position('FRONTDESK_DIRECT_DURATION_VERIFIED' in d)=0 then
    raise exception 'FRONTDESK_BUNDLE_UNVERIFIED_EXISTING_PATCH';
   end if;
   continue;
  end if;
  if (length(d)-length(replace(d,v_old,'')))<>length(v_old) then
   raise exception 'FRONTDESK_BUNDLE_CONTRACT_CHANGED';
  end if;
  v_extra:=format($snippet$
  -- FRONTDESK_DIRECT_DURATION_VERIFIED: this exception is limited to
  -- the exact direct-duration snapshot created by the paired frontdesk RPC.
  if v_store_count = 1 and v_visible_count = 0 and exists(
   select 1
   from %1$I.bookings b
   join %1$I.booking_items bi on bi.booking_id=b.id
   join %1$I.booking_participants bp on bp.booking_id=b.id
   join %1$I.booking_participant_items pi on pi.participant_id=bp.id
   where b.id=v_booking_id
     and b.status='confirmed'
     and b.service_id='00000000-0000-4000-8000-000000000010'::uuid
     and b.request_id like 'PHONE-%%'
     and b.contact_source='custom' and b.contact_surname='櫃檯人員'
     and b.total_duration_minutes between 1 and 1439
     and b.confirmed_by is not null
     and bi.service_id=b.service_id
     and bi.service_title='現場預約時段'
     and bi.unit_duration_minutes=b.total_duration_minutes
     and bi.unit_price_amount=0
     and bi.quantity=1
     and bi.counts_toward_membership=false
     and bp.position=1
     and pi.service_id=b.service_id
     and pi.service_title='現場預約時段'
     and pi.unit_duration_minutes=b.total_duration_minutes
     and pi.unit_price_amount=0
     and pi.quantity=1
     and (select count(*) from %1$I.booking_participants x where x.booking_id=b.id)=1
     and (select count(*) from %1$I.booking_participant_items x where x.participant_id=bp.id)=1
     and platform_private.frontdesk_paired_phone_source(%2$L,to_jsonb(b)) is not null
  ) then
   return coalesce(new,old);
  end if;

$snippet$,t.runtime_schema,t.runtime_schema);
  execute replace(d,v_old,v_extra||v_old);
 end loop;
end $patch$;
