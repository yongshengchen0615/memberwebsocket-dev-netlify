-- AC-FR-009/010: Repair the observed, undelivered frontdesk rejection event.
-- The last upgrade replaced the paired predicate with its pending-only version;
-- a confirmed replacement must remain eligible for the same-actor audit check.
DO $repair_pair$
DECLARE definition text;
  old_check constant text := $old$if p_booking->>'status' is distinct from 'pending' then return null;end if;$old$;
  new_check constant text := $new$if coalesce(p_booking->>'status','') not in ('pending','confirmed') then return null;end if;$new$;
BEGIN
  SELECT pg_get_functiondef('platform_private.frontdesk_paired_phone_source(text,jsonb)'::regprocedure) INTO STRICT definition;
  IF position(new_check IN definition)>0 THEN RETURN; END IF;
  IF (length(definition)-length(replace(definition,old_check,'')))<>length(old_check)
    THEN RAISE EXCEPTION 'FRONTDESK_PAIRED_SOURCE_CONTRACT_CHANGED'; END IF;
  EXECUTE replace(definition,old_check,new_check);
END $repair_pair$;

-- The booking notification dispatcher discards every event whose key does not
-- match the current lifecycle pattern (<booking id>:rejected:% for rejected).
-- Previously "frontdesk.rejected:<id>:..." was always skipped before delivery.
-- Reuse the canonical event identity but retain the admin-only channel.
DO $repair_notice$
DECLARE definition text;
  old_key constant text := $old$'frontdesk.rejected:'||NEW.id::text||':'||NEW.updated_at::text$old$;
  new_key constant text := $new$v_event$new$;
  old_contact constant text := $old$||E'\n電話：'||coalesce(nullif(v_phone->>'phone',''),'未提供')$old$;
  old_status constant text := $old$||E'\n預約狀態：'||case when v_phone->>'status'='confirmed' then '已確認' else '待管理員確認' end$old$;
BEGIN
  SELECT pg_get_functiondef('platform_private.append_booking_rejection_notice()'::regprocedure) INTO STRICT definition;
  IF position(old_key IN definition)=0 AND position('using NEW.id,v_event,left(v_admin_message' IN definition)>0
    THEN RETURN; END IF;
  IF (length(definition)-length(replace(definition,old_key,'')))<>length(old_key)
     OR (length(definition)-length(replace(definition,old_contact,'')))<>length(old_contact)
     OR (length(definition)-length(replace(definition,old_status,'')))<>length(old_status)
    THEN RAISE EXCEPTION 'FRONTDESK_REJECTION_NOTICE_CONTRACT_CHANGED'; END IF;
  -- The paired replacement has no customer phone. Retain the original member's
  -- contact on the original-booking section; never invent a phone on the new one.
  EXECUTE replace(replace(definition,old_key,new_key),old_contact,'');
END $repair_notice$;

-- No changes to existing bookings, authorization, role grants or previously
-- accepted LINE deliveries. Historical skipped notifications are reconciled
-- separately after inspecting their exact delivery/attempt state.
NOTIFY pgrst, 'reload schema';
