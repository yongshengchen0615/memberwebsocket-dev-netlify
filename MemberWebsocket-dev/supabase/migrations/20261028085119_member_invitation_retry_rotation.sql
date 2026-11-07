begin;
-- Preserve the published installer and existing reward contracts. Patch only
-- the bounded candidate ordering, both for installed tenants and future ones.
-- Old terminal conflicts move to the back after an attempt instead of starving
-- newer retryable activations forever.
do $migration$
declare r record; definition text; previous text := 'order by claimed_at limit 20 loop';
 replacement text := 'order by attempted_at nulls first,claimed_at,invitee_id limit 20 loop';
begin
 for r in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='platform_private' and p.proname='install_member_invitations')
   or (n.nspname~'^business_[a-f0-9]{32}$' and p.proname='member_invitation_retry')
 loop
  definition:=pg_get_functiondef(r.oid);
  if position(previous in definition)=0 then raise exception 'INVITATION_RETRY_DEFINITION_MISMATCH';end if;
  execute replace(definition,previous,replacement);
 end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
