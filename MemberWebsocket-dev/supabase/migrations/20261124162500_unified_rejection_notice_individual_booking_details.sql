-- AC-REJ-UNIFIED-001..006 and AC-FD-REJ-LINE-001..005:
-- reject notifications read only the immutable per-booking snapshot created
-- from the authorized frontdesk policy, not merchant booking_settings.rejection_message.
-- Other notification types (pending, confirmed, reminders) are unchanged.
do $unify_rejection_notice$
declare d text;old_sql text;new_sql text;replacement text;
begin
 select pg_get_functiondef('platform_private.append_booking_rejection_notice()'::regprocedure) into strict d;
 old_sql:='execute format(''select rejection_message from %I.booking_settings where id=1'',v_schema) into v_custom;';
 if length(d)-length(replace(d,old_sql,''))<>length(old_sql) then raise exception 'REJ_UNIFIED_LEGACY_READ_CONTRACT_CHANGED';end if;
 d:=replace(d,old_sql,'v_custom:=''''; -- retired duplicate merchant text; immutable booking reason snapshot is authoritative.');
 -- Preserve all booking fields of pre-existing notices. Only the injected extra
 -- message is removed; recorded reason label and description remain.
 old_sql:='||case when v_custom<>'''' then E''\\n''||v_custom else '''' end';
 -- pg_get_functiondef SQL language contains E'\n' source (not literal newline).
 if position(old_sql in d)=0 then
   old_sql:='||case when v_custom<>'''' then E''\n''||v_custom else '''' end';
 end if;
 if length(d)-length(replace(d,old_sql,''))<>length(old_sql) then raise exception 'REJ_UNIFIED_SUFFIX_CONTRACT_CHANGED';end if;
 d:=replace(d,old_sql,'');
 -- Alert grouping currently flattens ALL participant services and technician
 -- names into one line. Switch to per-position detail blocks for original and
 -- replacement bookings; preserve event identity, recipient, audit and pairing.
 old_sql:='v_old_services text;v_phone_services text;v_old_tech text;v_phone_tech text;';
 new_sql:=old_sql||'v_old_persons text;v_phone_persons text;';
 if length(d)-length(replace(d,old_sql,''))<>length(old_sql) then raise exception 'REJ_PERSONS_VAR_CONTRACT_CHANGED';end if;
 d:=replace(d,old_sql,new_sql);
 old_sql:='v_old_tech:=coalesce(nullif(v_old_tech,''''),v_old->>''fallbackTechnician'',''現場安排'');';
 new_sql:=old_sql||E'\n'||$persons$
     select string_agg(
        E'\n第'||coalesce(p->>'position','?')||'位預約'
        ||E'\n預約項目：'||coalesce((
          select string_agg(coalesce(s->>'title','預約項目')
            ||case when coalesce((s->>'quantity')::int,1)>1
                then ' × '||(s->>'quantity') else '' end,'、')
          from jsonb_array_elements(coalesce(p->'services','[]'::jsonb)) s
        ),'—')
        ||E'\n預約技師：'||coalesce(nullif(p->>'technician',''),'現場安排')
        ||case when nullif(btrim(coalesce(p->>'note','')),'') is null
           then '' else E'\n個別備註：'||left(btrim(p->>'note'),250) end,
        E'\n' order by (p->>'position')::integer
     ) into v_old_persons
     from jsonb_array_elements(coalesce(v_old->'participants','[]'::jsonb)) p;
$persons$;
 if length(d)-length(replace(d,old_sql,''))<>length(old_sql) then raise exception 'REJ_OLD_PERSONS_CONTRACT_CHANGED';end if;
 d:=replace(d,old_sql,new_sql);
 old_sql:='v_phone_tech:=coalesce(nullif(v_phone_tech,''''),v_phone->>''fallbackTechnician'',''現場安排'');';
 new_sql:=old_sql||E'\n'||$persons$
       select string_agg(
          E'\n第'||coalesce(p->>'position','?')||'位預約'
          ||E'\n預約項目：'||coalesce((
            select string_agg(coalesce(s->>'title','預約項目')
              ||case when coalesce((s->>'quantity')::int,1)>1
                  then ' × '||(s->>'quantity') else '' end,'、')
            from jsonb_array_elements(coalesce(p->'services','[]'::jsonb)) s
          ),'—')
          ||E'\n預約技師：'||coalesce(nullif(p->>'technician',''),'現場安排')
          ||case when nullif(btrim(coalesce(p->>'note','')),'') is null
             then '' else E'\n個別備註：'||left(btrim(p->>'note'),250) end,
          E'\n' order by (p->>'position')::integer
       ) into v_phone_persons
       from jsonb_array_elements(coalesce(v_phone->'participants','[]'::jsonb)) p;
$persons$;
 if length(d)-length(replace(d,old_sql,''))<>length(old_sql) then raise exception 'REJ_PHONE_PERSONS_CONTRACT_CHANGED';end if;
 d:=replace(d,old_sql,new_sql);
 old_sql:='||E''\n預約技師：''||v_old_tech';
 new_sql:=old_sql||E'\n'||'       ||case when nullif(v_old_persons,'''') is null then '''' else E''\n\n【個別預約資料】''||v_old_persons end';
 if length(d)-length(replace(d,old_sql,''))<>length(old_sql) then raise exception 'REJ_OLD_FORMAT_CONTRACT_CHANGED';end if;
 d:=replace(d,old_sql,new_sql);
 old_sql:='||E''\n預約技師：''||v_phone_tech';
 new_sql:=old_sql||E'\n'||'           ||case when nullif(v_phone_persons,'''') is null then '''' else E''\n\n【個別預約資料】''||v_phone_persons end';
 if length(d)-length(replace(d,old_sql,''))<>length(old_sql) then raise exception 'REJ_PHONE_FORMAT_CONTRACT_CHANGED';end if;
 d:=replace(d,old_sql,new_sql);
 execute d;
end $unify_rejection_notice$;
notify pgrst,'reload schema';
