-- AC-FD-REASON-REMOVE: allow authorized managers to delete an obsolete
-- rejection reason, preserving legacy booking snapshots and requestId replay.
-- The existing 1..30 total / >=1 enabled validation remains in force.
do $allow_delete$
declare definition text;needle text;
begin
 select pg_get_functiondef('platform_private.validate_frontdesk_rejection_settings(jsonb,jsonb)'::regprocedure)
  into strict definition;
 needle:=$guard$
  for v_prior in select value from jsonb_array_elements(
    coalesce(p_previous,platform_private.frontdesk_rejection_defaults())->'reasons'
  ) loop
   if not(v_prior->>'id'=any(v_ids)) then
    raise exception 'REJECTION_REASON_DELETE_FORBIDDEN';end if;
  end loop;
$guard$;
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then
   raise exception 'REJECTION_DELETE_VALIDATOR_CONTRACT_CHANGED';
 end if;
 execute replace(definition,needle,'');
end $allow_delete$;
notify pgrst,'reload schema';
