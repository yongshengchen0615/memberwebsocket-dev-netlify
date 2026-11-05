-- An immediate publish uses a transaction clock acquired after statement start.
-- Its successful response must not temporarily call that committed price a
-- future schedule. Patch existing schemas and the installer for future tenants;
-- keep the previously applied migration immutable.
do $status$
declare f record; original text; revised text;
begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='platform_private' and p.proname='install_booking_item_prices')
   or (p.proname='booking_price_event_client' and (n.nspname='public'
    or n.nspname in(select runtime_schema from platform_private.tenants)))
 loop
  original:=pg_get_functiondef(f.oid);
  revised:=replace(original,'when p.publish_at<=statement_timestamp()',
   'when p.publish_mode=''immediate'' or p.publish_at<=statement_timestamp()');
  if revised is distinct from original then execute revised;
  elsif position('when p.publish_mode=''immediate'' or p.publish_at<=statement_timestamp()' in original)=0 then
   raise exception 'BOOKING_PRICE_STATUS_UPGRADE_CONTRACT_MISSING';
  end if;
 end loop;
end $status$;
notify pgrst,'reload schema';
