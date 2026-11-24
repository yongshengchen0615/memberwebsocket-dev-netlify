-- AC-FD-REASON-REMOVE: allow authorized managers to delete an obsolete
-- rejection reason, preserving legacy booking snapshots and requestId replay.
-- The existing 1..30 total / >=1 enabled validation remains in force.
do $allow_delete$
declare definition text;start_pos integer;end_pos integer;guard text;
begin
 select pg_get_functiondef('platform_private.validate_frontdesk_rejection_settings(jsonb,jsonb)'::regprocedure)
  into strict definition;
 start_pos:=position('for v_prior in select value from jsonb_array_elements(' in definition);
 end_pos:=position('return jsonb_build_object(''dropdownTitle'',v_title,''reasons'',v_reasons);' in definition);
 if start_pos=0 or end_pos<=start_pos then raise exception 'REJECTION_DELETE_VALIDATOR_CONTRACT_CHANGED';end if;
 guard:=substring(definition from start_pos for end_pos-start_pos);
 if position('REJECTION_REASON_DELETE_FORBIDDEN' in guard)=0
   or position('end loop;' in guard)=0
 then raise exception 'REJECTION_DELETE_VALIDATOR_CONTRACT_CHANGED';end if;
 execute substring(definition from 1 for start_pos-1)||substring(definition from end_pos);
end $allow_delete$;
notify pgrst,'reload schema';
