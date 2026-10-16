do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef('public.create_group_booking_request(text,uuid,date,time without time zone,uuid,jsonb,text,text,text,text,text)'::regprocedure)
    into v_def;

  v_old := '  v_total_duration integer := 0;';
  v_new := '  v_total_duration integer := 0;' || E'\n' || '  v_participant_duration integer := 0;';
  if position(v_old in v_def) = 0 then raise exception 'create_group_booking_request declaration pattern not found'; end if;
  v_def := replace(v_def, v_old, v_new);

  v_old := E'  for v_participant in select value from jsonb_array_elements(p_participants) loop\n    v_position := v_position + 1;\n    if jsonb_typeof(v_participant->''items'') <> ''array''';
  v_new := E'  for v_participant in select value from jsonb_array_elements(p_participants) loop\n    v_position := v_position + 1;\n    v_participant_duration := 0;\n    if jsonb_typeof(v_participant->''items'') <> ''array''';
  if position(v_old in v_def) = 0 then raise exception 'create_group_booking_request participant loop pattern not found'; end if;
  v_def := replace(v_def, v_old, v_new);

  v_old := '      v_total_duration := v_total_duration + (v_service.duration_minutes * v_quantity);';
  v_new := '      v_participant_duration := v_participant_duration + (v_service.duration_minutes * v_quantity);';
  if position(v_old in v_def) = 0 then raise exception 'create_group_booking_request duration accumulation pattern not found'; end if;
  v_def := replace(v_def, v_old, v_new);

  v_old := E'    end loop;\n  end loop;\n\n  select * into v_store';
  v_new := E'    end loop;\n    v_total_duration := greatest(v_total_duration, v_participant_duration);\n  end loop;\n\n  select * into v_store';
  if position(v_old in v_def) = 0 then raise exception 'create_group_booking_request max duration pattern not found'; end if;
  v_def := replace(v_def, v_old, v_new);
  execute v_def;

  select pg_get_functiondef('public.update_group_booking_request(uuid,timestamp with time zone,text,text,uuid,date,time without time zone,uuid,jsonb,text,text,text,text,text)'::regprocedure)
    into v_def;

  v_old := '  v_total_duration integer := 0;';
  v_new := '  v_total_duration integer := 0;' || E'\n' || '  v_participant_duration integer := 0;';
  if position(v_old in v_def) = 0 then raise exception 'update_group_booking_request declaration pattern not found'; end if;
  v_def := replace(v_def, v_old, v_new);

  v_old := E'  for v_participant in select value from jsonb_array_elements(p_participants) loop\n    if jsonb_typeof(v_participant->''items'') <> ''array''';
  v_new := E'  for v_participant in select value from jsonb_array_elements(p_participants) loop\n    v_participant_duration := 0;\n    if jsonb_typeof(v_participant->''items'') <> ''array''';
  if position(v_old in v_def) = 0 then raise exception 'update_group_booking_request participant loop pattern not found'; end if;
  v_def := replace(v_def, v_old, v_new);

  v_old := '      v_total_duration := v_total_duration + (v_service.duration_minutes * v_quantity);';
  v_new := '      v_participant_duration := v_participant_duration + (v_service.duration_minutes * v_quantity);';
  if position(v_old in v_def) = 0 then raise exception 'update_group_booking_request duration accumulation pattern not found'; end if;
  v_def := replace(v_def, v_old, v_new);

  v_old := E'    end loop;\n  end loop;\n\n  select * into v_store';
  v_new := E'    end loop;\n    v_total_duration := greatest(v_total_duration, v_participant_duration);\n  end loop;\n\n  select * into v_store';
  if position(v_old in v_def) = 0 then raise exception 'update_group_booking_request max duration pattern not found'; end if;
  v_def := replace(v_def, v_old, v_new);
  execute v_def;
end
$$;
