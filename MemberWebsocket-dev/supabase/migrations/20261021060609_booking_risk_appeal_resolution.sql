begin;
-- #193: appeals.reason shadows the PL/pgSQL variable named reason. Keep the
-- existing validated payload and use its trimmed value explicitly in UPDATE.
-- Patch the installer so current and newly approved businesses stay identical.
do $repair$
declare definition text;t record;
begin
 definition:=pg_get_functiondef('platform_private.install_booking_risk(text)'::regprocedure);
 if position('resolution=reason where id=' in definition)=0 then
  raise exception 'BOOKING_RISK_INSTALLER_SOURCE_MISMATCH';
 end if;
 execute replace(definition,'resolution=reason where id=','resolution=btrim(p_body->>''reason'') where id=');
 for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
  perform platform_private.install_booking_risk(t.runtime_schema);
 end loop;
end $repair$;
notify pgrst,'reload schema';
commit;
