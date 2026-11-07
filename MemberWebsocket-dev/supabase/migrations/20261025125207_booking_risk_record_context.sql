begin;
-- Display-only projection: preserve policy, history, expiry and transaction logic.
-- Apply the same private-schema joins to existing and future merchants.
do $context$
declare definition text;t record;
begin
 definition:=pg_get_functiondef('platform_private.install_booking_risk(text)'::regprocedure);
 if position('select * from S.booking_restrictions order by starts_at desc limit 100' in definition)=0
  or position('select * from S.booking_restriction_appeals order by created_at desc limit 100' in definition)=0 then
  raise exception 'BOOKING_RISK_CONTEXT_SOURCE_MISMATCH';
 end if;
 definition:=replace(definition,'select * from S.booking_restrictions order by starts_at desc limit 100',
  'select restriction_row.*,member_row.member_code from S.booking_restrictions restriction_row join S.members member_row on member_row.id=restriction_row.member_id order by restriction_row.starts_at desc limit 100');
 definition:=replace(definition,'select * from S.booking_restriction_appeals order by created_at desc limit 100',
  'select appeal_row.*,member_row.member_code,restriction_row.source_booking_id from S.booking_restriction_appeals appeal_row join S.members member_row on member_row.id=appeal_row.member_id join S.booking_restrictions restriction_row on restriction_row.id=appeal_row.restriction_id order by appeal_row.created_at desc limit 100');
 execute definition;
 for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
  perform platform_private.install_booking_risk(t.runtime_schema);
 end loop;
end $context$;
notify pgrst,'reload schema';
commit;
