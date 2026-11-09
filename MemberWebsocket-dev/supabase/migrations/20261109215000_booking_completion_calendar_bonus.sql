-- Award calendar event bonus points during canonical normal/snapshot booking settlement.
-- Keep promotions outside service reward_details so completion corrections never deduct them.
DO $migration$
DECLARE scope_name text;
BEGIN
 FOR scope_name IN
  SELECT n.nspname FROM pg_namespace n
  WHERE (n.nspname='public' OR left(n.nspname,9)='business_')
   AND to_regprocedure(format('%I.complete_booking_with_rewards_base(uuid,timestamptz,text,text)',n.nspname)) IS NOT NULL
  ORDER BY n.nspname
 LOOP
  EXECUTE format(
   'ALTER TABLE %I.booking_completion_settlements ADD COLUMN IF NOT EXISTS calendar_bonus_details jsonb NOT NULL DEFAULT ''[]''::jsonb',
   scope_name);
  EXECUTE format($new_function$
   CREATE OR REPLACE FUNCTION %1$I.complete_booking_with_rewards_request(
    p_booking_id uuid,p_expected_updated_at timestamptz,p_actor text,p_admin_note text DEFAULT ''
   ) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $body$
   DECLARE
    result jsonb;
    recipient uuid;
    service_date date;
    prior_minutes integer:=0;
    prior_tier text:='general';
    bonus_per_card integer:=0;
    bonus_events jsonb:='[]'::jsonb;
    bonus_note text;
    applied_bonuses jsonb:='[]'::jsonb;
    card record;
    affected integer;
   BEGIN
    PERFORM %1$I.booking_price_context_time();
    PERFORM 1 FROM %1$I.booking_settings WHERE id=1 FOR SHARE;
    PERFORM 1 FROM %1$I.booking_service_type_rewards ORDER BY service_type_id FOR SHARE;
    result:=%1$I.complete_booking_with_rewards_base(p_booking_id,p_expected_updated_at,p_actor,p_admin_note);
    recipient:=(result->>'serviceRecipientMemberId')::uuid;
    SELECT booking_date INTO service_date FROM %1$I.bookings WHERE id=p_booking_id;

    -- Match the same pre-grant tier calculation as manual point grants.
    -- Base settlement just added result.serviceMinutes to this member's ledger.
    SELECT greatest(0,coalesce(sum(minutes),0)::integer-coalesce((result->>'serviceMinutes')::integer,0))
    INTO prior_minutes FROM %1$I.service_time_entries WHERE member_id=recipient;
    SELECT tier_key INTO prior_tier FROM %1$I.membership_tier_settings
    WHERE required_service_minutes<=prior_minutes
    ORDER BY required_service_minutes DESC LIMIT 1;
    prior_tier:=coalesce(prior_tier,'general');

    -- Retrospective snapshots must use service date rather than review date.
    SELECT coalesce(sum(bonus_points),0)::integer,
     coalesce(jsonb_agg(jsonb_build_object(
      'calendarItemId',calendar_item_id,'title',title,'bonusPoints',bonus_points
     ) ORDER BY starts_on,created_at),'[]'::jsonb)
    INTO bonus_per_card,bonus_events
    FROM %1$I.calendar_items
    WHERE item_type='event' AND status='active'
     AND bonus_points_enabled=true AND bonus_points>0
     AND starts_on<=service_date AND coalesce(ends_on,starts_on)>=service_date
     AND (coalesce(cardinality(allowed_tier_keys),0)=0 OR prior_tier=ANY(allowed_tier_keys));

    IF bonus_per_card>0 THEN
     SELECT '活動加贈：'||string_agg(
      coalesce(value->>'title','活動')||' +'||coalesce(value->>'bonusPoints','0')||' 點','、')
     INTO bonus_note FROM jsonb_array_elements(bonus_events);
     -- One activity bonus per card, even when multiple service types earn that card's points.
     FOR card IN
      SELECT pc.id,pc.title FROM %1$I.point_cards pc
      WHERE EXISTS (
       SELECT 1 FROM jsonb_array_elements(coalesce(result->'rewards','[]'::jsonb)) r
       WHERE r->>'pointCardId'=pc.id::text AND coalesce((r->>'points')::integer,0)>0
      ) ORDER BY pc.id
     LOOP
      INSERT INTO %1$I.point_entries(
       entry_id,member_id,point_card_id,amount,note,created_by,
       request_id,entry_type,reference_type,reference_id
      ) VALUES (
       %1$I.new_public_id('PE'),recipient,card.id,bonus_per_card,bonus_note,p_actor,
       'booking-calendar-bonus:'||p_booking_id::text,'grant','calendar_bonus',p_booking_id::text
      ) ON CONFLICT (request_id,member_id,point_card_id)
        WHERE request_id IS NOT NULL AND request_id<>'' DO NOTHING;
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected<>1 THEN RAISE EXCEPTION 'BOOKING_CALENDAR_BONUS_CONFLICT'; END IF;
      INSERT INTO %1$I.point_balances(member_id,point_card_id,stamps,updated_at)
      VALUES(recipient,card.id,bonus_per_card,now())
      ON CONFLICT (member_id,point_card_id) DO UPDATE
      SET stamps=%1$I.point_balances.stamps+excluded.stamps,updated_at=now();
      PERFORM %1$I.issue_eligible_point_tickets(recipient,card.id);
      applied_bonuses:=applied_bonuses||jsonb_build_array(jsonb_build_object(
       'pointCardId',card.id,'pointCardTitle',card.title,
       'bonusPoints',bonus_per_card,'events',bonus_events
      ));
     END LOOP;
    END IF;
    IF jsonb_array_length(applied_bonuses)=0 THEN
     bonus_per_card:=0; bonus_events:='[]'::jsonb;
    END IF;
    UPDATE %1$I.booking_completion_settlements
    SET correction_context=%1$I.booking_reward_context((result->>'primaryTechnicianId')::uuid),
        calendar_bonus_details=applied_bonuses
    WHERE booking_id=p_booking_id;
    RETURN result||jsonb_build_object(
     'calendarBonusTotalPerCard',bonus_per_card,
     'calendarBonusEvents',bonus_events,
     'calendarBonusDetails',applied_bonuses
    );
   END;
   $body$;
  $new_function$,scope_name);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.complete_booking_with_rewards_request(uuid,timestamptz,text,text) FROM PUBLIC,anon,authenticated',scope_name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.complete_booking_with_rewards_request(uuid,timestamptz,text,text) TO service_role',scope_name);
 END LOOP;
END;
$migration$;