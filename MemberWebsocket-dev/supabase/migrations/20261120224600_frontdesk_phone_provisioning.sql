-- AC-FR-005b: newly provisioned merchants must inherit the phone registration path.
do $upgrade$
declare d text;
 v_anchor constant text:='  perform platform_private.install_booking_rejection(p_schema);';
 v_call constant text:='  perform platform_private.install_frontdesk_phone(p_schema);';
begin
 select pg_get_functiondef('platform_private.install_booking_reminder(text)'::regprocedure) into strict d;
 if position(v_call in d)=0 then
   if (length(d)-length(replace(d,v_anchor,'')))/length(v_anchor)<>1 then
     raise exception 'PHONE_PROVISIONING_CONTRACT_CHANGED';end if;
   execute replace(d,v_anchor,v_anchor||E'\n'||v_call);
 end if;
end $upgrade$;
notify pgrst,'reload schema';
