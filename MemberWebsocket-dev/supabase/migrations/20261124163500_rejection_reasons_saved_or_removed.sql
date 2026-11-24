-- AC-FD-REASONS-SIMPLE-001..006:
-- Every reason present after saving is active. Deleting removes it only from
-- future choices. Existing booking snapshots and request replay remain intact.
-- A manager may save an empty list: the clerk then cannot submit a rejection.
-- Keep the legacy 'enabled' boolean on the wire and in stored policies for
-- rollback/old-client compatibility, but normalize saved values to TRUE.
do $simplify_policy$
declare d text;old_sql text;new_sql text;
begin
 select pg_get_functiondef('platform_private.validate_frontdesk_rejection_settings(jsonb,jsonb)'::regprocedure) into strict d;
 old_sql:='if jsonb_array_length(v_reasons)<1 or jsonb_array_length(v_reasons)>30 then';
 new_sql:='if jsonb_array_length(v_reasons)>30 then';
 if length(d)-length(replace(d,old_sql,''))<>length(old_sql) then raise exception 'REJECTION_LIST_SIZE_CONTRACT_CHANGED';end if;
 d:=replace(d,old_sql,new_sql);
 old_sql:=$block$
   if (v_item->>'enabled')::boolean then
    v_enabled:=v_enabled+1;
    if v_label=any(v_labels) then raise exception 'PLATFORM_INVALID_INPUT';end if;
    v_labels:=array_append(v_labels,v_label);
   end if;
$block$;
 new_sql:=$block$
   if v_label=any(v_labels) then raise exception 'PLATFORM_INVALID_INPUT';end if;
   v_labels:=array_append(v_labels,v_label);
$block$;
 if length(d)-length(replace(d,old_sql,''))<>length(old_sql) then raise exception 'REJECTION_LABELS_CONTRACT_CHANGED';end if;
 d:=replace(d,old_sql,new_sql);
 old_sql:='if v_enabled=0 then raise exception ''PLATFORM_INVALID_INPUT'';end if;';
 new_sql:='-- An empty saved reason list is valid and blocks new rejections.';
 if length(d)-length(replace(d,old_sql,''))<>length(old_sql) then raise exception 'REJECTION_ENABLED_COUNT_CONTRACT_CHANGED';end if;
 d:=replace(d,old_sql,new_sql);
 old_sql:='return jsonb_build_object(''dropdownTitle'',v_title,''reasons'',v_reasons);';
 new_sql:=$result$
 v_reasons:=coalesce((
  select jsonb_agg(jsonb_set(item,'{enabled}','true'::jsonb,true) order by ordinality)
  from jsonb_array_elements(v_reasons) with ordinality as r(item,ordinality)
 ),'[]'::jsonb);
 return jsonb_build_object('dropdownTitle',v_title,'reasons',v_reasons);
$result$;
 if length(d)-length(replace(d,old_sql,''))<>length(old_sql) then raise exception 'REJECTION_POLICY_RESULT_CONTRACT_CHANGED';end if;
 execute replace(d,old_sql,new_sql);
end $simplify_policy$;

do $simplify_rejection_selection$
declare d text;old_sql text;new_sql text;
begin
 select pg_get_functiondef('public.platform_frontdesk_rejection_request(uuid,text,text,timestamptz,text,jsonb)'::regprocedure) into strict d;
 old_sql:='where value->>''id''=v_id and value->>''enabled''=''true'';';
 new_sql:='where value->>''id''=v_id;';
 if length(d)-length(replace(d,old_sql,''))<>length(old_sql) then raise exception 'REJECTION_SELECTION_CONTRACT_CHANGED';end if;
 execute replace(d,old_sql,new_sql);
end $simplify_rejection_selection$;
notify pgrst,'reload schema';
