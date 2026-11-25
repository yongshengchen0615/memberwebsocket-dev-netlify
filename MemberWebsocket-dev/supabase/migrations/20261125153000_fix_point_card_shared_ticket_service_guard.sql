-- The shared ticket-required-service trigger is installed on both
-- event_tickets and point_card_rewards. Only event_tickets has
-- min_booking_service_ids, so that check must be in its own PL/pgSQL IF.
-- Apply to the shared schema and already provisioned merchants.
DO $repair$
DECLARE
  target record;
  original_def text;
  faulty_clause text;
  corrected_clause text;
  inspected integer := 0;
  repaired integer := 0;
BEGIN
  FOR target IN
    SELECT n.nspname AS schema_name, p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'validate_ticket_required_service_ids'
      AND p.pronargs = 0
      AND (n.nspname = 'public' OR n.nspname ~ '^business_[0-9a-f]{32}$')
    ORDER BY n.nspname
  LOOP
    inspected := inspected + 1;
    original_def := pg_get_functiondef(target.oid);
    faulty_clause := format(
      'if TG_TABLE_NAME=''event_tickets'' and exists(select 1 from unnest(coalesce(new.min_booking_service_ids,''{}''::uuid[])) chosen(service_id) left join %I.booking_services bs on bs.id=chosen.service_id where bs.id is null) then raise exception ''INVALID_BOOKING_AMOUNT_RULE''; end if;',
      target.schema_name
    );
    corrected_clause := format(
      E'if TG_TABLE_NAME = ''event_tickets'' then\n    if exists (\n      select 1 from unnest(coalesce(new.min_booking_service_ids, ''{}''::uuid[])) chosen(service_id)\n      left join %I.booking_services bs on bs.id = chosen.service_id\n      where bs.id is null\n    ) then\n      raise exception ''INVALID_BOOKING_AMOUNT_RULE'';\n    end if;\n  end if;',
      target.schema_name
    );
    IF strpos(original_def, faulty_clause) > 0 THEN
      EXECUTE replace(original_def, faulty_clause, corrected_clause);
      repaired := repaired + 1;
    ELSIF strpos(original_def, 'if TG_TABLE_NAME = ''event_tickets'' then') = 0 THEN
      RAISE EXCEPTION 'UNKNOWN_TICKET_SERVICE_GUARD_DEFINITION: %', target.schema_name;
    END IF;
  END LOOP;
  IF inspected = 0 THEN
    RAISE EXCEPTION 'TICKET_SERVICE_GUARD_MISSING';
  END IF;
  RAISE NOTICE 'inspected %, repaired % ticket service guards', inspected, repaired;
END
$repair$;
