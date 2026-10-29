begin;
-- Retire the appeal feature while preserving historical rows and their access controls.
do $retire$
declare definition text;t record;start_at integer;end_at integer;
begin
 definition:=pg_get_functiondef('platform_private.install_booking_risk(text)'::regprocedure);
 if position('create or replace function S.booking_no_show_appeal' in definition)=0
 or position('create or replace function S.admin_booking_no_show' in definition)=0
 or position('''appealEnabled'',c.appeal_enabled,''contactText'',c.contact_text,' in definition)=0
 or position('  ''appeals'',(select' in definition)=0 then
  raise exception 'BOOKING_RISK_APPEAL_RETIRE_SOURCE_MISMATCH';
 end if;
 -- Status no longer publishes the appeal fields.
 start_at:=position('''appealEnabled'',c.appeal_enabled,''contactText'',c.contact_text,' in definition);
 end_at:=position('  from S.booking_restrictions r cross join' in definition);
 if end_at<=start_at then raise exception 'BOOKING_RISK_APPEAL_STATUS_SOURCE_MISMATCH';end if;
 definition:=substring(definition from 1 for start_at-1)||'''contactText'',c.contact_text'||substring(definition from end_at);
 -- Remove creation/grants for member appeal submission.
 start_at:=position('create or replace function S.booking_no_show_appeal' in definition);
 end_at:=position('create or replace function S.admin_booking_no_show' in definition);
 definition:=substring(definition from 1 for start_at-1)||substring(definition from end_at);
 definition:=replace(definition,',S.booking_no_show_appeal(text,text)','');
 -- Reject retired admin resolution, retain revoke and release.
 definition:=replace(definition,'elsif p_action in (''revoke'',''release'',''resolve'') then','elsif p_action in (''revoke'',''release'') then');
 start_at:=position(E'   else\n    update S.booking_restriction_appeals set resolved_at=' in definition);
 end_at:=position(E'   end if;\n   if changed>0' in definition);
 if start_at=0 or end_at<=start_at then raise exception 'BOOKING_RISK_APPEAL_RESOLVE_SOURCE_MISMATCH';end if;
 definition:=substring(definition from 1 for start_at-1)||substring(definition from end_at);
 definition:=replace(definition,'appeal_enabled=coalesce((p_body->>''appeal_enabled'')::boolean,true)','appeal_enabled=false');
 -- Remove appeal feed from the admin payload, but keep the private archive.
 start_at:=position(E',\n  ''appeals'',(select' in definition);
 if start_at=0 then raise exception 'BOOKING_RISK_APPEAL_FEED_SOURCE_MISMATCH';end if;
 end_at:=position('));' in substring(definition from start_at));
 if end_at=0 then raise exception 'BOOKING_RISK_APPEAL_FEED_END_MISMATCH';end if;
 definition:=substring(definition from 1 for start_at-1)||substring(definition from start_at+end_at);
 execute definition;
 for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
  perform platform_private.install_booking_risk(t.runtime_schema);
  execute format('update %I.booking_no_show_policy set appeal_enabled=false where appeal_enabled is distinct from false',t.runtime_schema);
  execute format('drop function if exists %I.booking_no_show_appeal(text,text)',t.runtime_schema);
 end loop;
end $retire$;
notify pgrst,'reload schema';
commit;
