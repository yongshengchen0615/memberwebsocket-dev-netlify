begin;
-- #194: existing member-removal/FK guards use KEY SHARE. Two bookings can
-- already hold that lock when their AFTER no-show triggers run. FOR UPDATE
-- then deadlocks on lock upgrades. No key is changed by the risk mutex, so
-- NO KEY UPDATE serializes risk operations while remaining KEY SHARE-compatible.
do $repair$
declare definition text;target text;t record;
begin
 definition:=pg_get_functiondef('platform_private.install_booking_risk(text)'::regprocedure);
 foreach target in array array[
  'S.members where id=new.member_id',
  'S.members where id=event.member_id',
  'S.members where id=r.member_id',
  'S.members where line_user_id=p_actor and status=''active'''
 ] loop
  if position(target||' for update;' in definition)=0 then raise exception 'BOOKING_RISK_LOCK_SOURCE_MISMATCH';end if;
  definition:=replace(definition,target||' for update;',target||' for no key update;');
 end loop;
 execute definition;
 for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
  perform platform_private.install_booking_risk(t.runtime_schema);
 end loop;
end $repair$;
notify pgrst,'reload schema';
commit;
