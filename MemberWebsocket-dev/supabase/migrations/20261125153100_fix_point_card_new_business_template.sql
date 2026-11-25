-- The versioned new-business blueprint stores executable functions as JSON.
-- Repair that single definition too, or newly created merchants regress.
DO $repair_template$
DECLARE
  template_snapshot jsonb;
  source_def text;
  faulty_clause text;
  corrected_clause text;
  corrected_functions jsonb;
  match_count integer;
BEGIN
  SELECT snapshot INTO STRICT template_snapshot
  FROM platform_private.business_templates
  WHERE version = 'business-v1-20261019'
  FOR UPDATE;
  SELECT count(*) INTO match_count
  FROM jsonb_array_elements(template_snapshot->'functions') f
  WHERE f->>'name' = 'validate_ticket_required_service_ids';
  IF match_count <> 1 THEN
    RAISE EXCEPTION 'SHARED_TICKET_GUARD_TEMPLATE_COUNT: %', match_count;
  END IF;
  SELECT f->>'definition' INTO STRICT source_def
  FROM jsonb_array_elements(template_snapshot->'functions') f
  WHERE f->>'name' = 'validate_ticket_required_service_ids';
  faulty_clause :=
    'if TG_TABLE_NAME=''event_tickets'' and exists(select 1 from unnest(coalesce(new.min_booking_service_ids,''{}''::uuid[])) chosen(service_id) left join public.booking_services bs on bs.id=chosen.service_id where bs.id is null) then raise exception ''INVALID_BOOKING_AMOUNT_RULE''; end if;';
  corrected_clause :=
    E'if TG_TABLE_NAME = ''event_tickets'' then\n    if exists (\n      select 1 from unnest(coalesce(new.min_booking_service_ids, ''{}''::uuid[])) chosen(service_id)\n      left join public.booking_services bs on bs.id = chosen.service_id\n      where bs.id is null\n    ) then\n      raise exception ''INVALID_BOOKING_AMOUNT_RULE'';\n    end if;\n  end if;';
  IF strpos(source_def, faulty_clause) = 0 THEN
    IF strpos(source_def, corrected_clause) = 0 THEN
      RAISE EXCEPTION 'SHARED_TICKET_GUARD_TEMPLATE_DEFINITION_CHANGED';
    END IF;
    RETURN;
  END IF;
  SELECT jsonb_agg(
    CASE WHEN f.item->>'name' = 'validate_ticket_required_service_ids'
      THEN jsonb_set(f.item,'{definition}',to_jsonb(replace(source_def,faulty_clause,corrected_clause)))
      ELSE f.item END
    ORDER BY f.ordinality
  ) INTO corrected_functions
  FROM jsonb_array_elements(template_snapshot->'functions') WITH ORDINALITY AS f(item,ordinality);
  UPDATE platform_private.business_templates
  SET snapshot = jsonb_set(template_snapshot,'{functions}',corrected_functions)
  WHERE version = 'business-v1-20261019';
END
$repair_template$;
