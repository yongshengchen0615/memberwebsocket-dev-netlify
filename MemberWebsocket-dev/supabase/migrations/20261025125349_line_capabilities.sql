-- #124: Login/LIFF configuration is independent of outgoing Messaging setup.
-- Preserve the existing locked, qualified, explicit-merchant transactions and
-- legacy AES associated scope; replace only their credential/readiness blocks.
begin;
do $migration$
declare signature text;definition text;old_block text;new_block text;
begin
 old_block:=$old$ if p_secrets is not null then
  insert into platform_private.module_secrets(tenant_id,feature,envelope,credential_scope)values(t.id,p_feature,p_secrets,'module')
  on conflict(tenant_id,feature)do update set envelope=excluded.envelope,credential_scope='module',updated_at=clock_timestamp();
 elsif not exists(select 1 from platform_private.module_secrets where tenant_id=t.id and feature=p_feature) then
  select * into old_secret from platform_private.tenant_secrets where tenant_id=t.id;
  if found then insert into platform_private.module_secrets(tenant_id,feature,envelope,credential_scope)values(t.id,p_feature,old_secret.envelope,'tenant');
  else raise exception 'PLATFORM_CREDENTIALS_REQUIRED'; end if;
 end if;$old$;
 new_block:=$new$ liff_key:=case p_feature when 'membership' then 'memberLiffId' when 'points' then 'pointsLiffId'
  when 'events' then 'eventLiffId' when 'calendar' then 'calendarLiffId' when 'booking' then 'bookingLiffId' end;
 if exists(select 1 from jsonb_object_keys(p_line) k where k not in ('adminChannelId','adminLiffId','memberChannelId','messagingChannelId',liff_key))
  or not coalesce(p_line->>'adminChannelId' ~ '^[0-9]{5,30}$',false)
  or not coalesce(p_line->>'memberChannelId' ~ '^[0-9]{5,30}$',false)
  or not coalesce(p_line->>'adminLiffId' ~ ('^'||(p_line->>'adminChannelId')||'-[A-Za-z0-9_-]+$'),false)
  or not coalesce(p_line->>liff_key ~ ('^'||(p_line->>'memberChannelId')||'-[A-Za-z0-9_-]+$'),false)
  or (coalesce(p_line->>'messagingChannelId','')<>'' and p_line->>'messagingChannelId' !~ '^[0-9]{5,30}$')
  or (coalesce(t.line_config->>'adminChannelId','')<>'' and p_line->>'adminChannelId' is distinct from t.line_config->>'adminChannelId')
  or (coalesce(t.line_config->>'adminLiffId','')<>'' and p_line->>'adminLiffId' is distinct from t.line_config->>'adminLiffId')
  then raise exception 'PLATFORM_INVALID_INPUT';end if;
 old_line:=coalesce(t.module_line->p_feature->'line',t.line_config,'{}'::jsonb);
 if p_secrets is not null then
  if not coalesce(p_line->>'messagingChannelId' ~ '^[0-9]{5,30}$',false) then raise exception 'PLATFORM_CREDENTIALS_REQUIRED';end if;
  insert into platform_private.module_secrets(tenant_id,feature,envelope,credential_scope)values(t.id,p_feature,p_secrets,'module')
  on conflict(tenant_id,feature)do update set envelope=excluded.envelope,credential_scope='module',updated_at=clock_timestamp();
 elsif exists(select 1 from platform_private.module_secrets where tenant_id=t.id and feature=p_feature) then
  -- A new channel must never inherit the old channel's token or secret.
  if p_line->>'messagingChannelId' is distinct from old_line->>'messagingChannelId'
   then raise exception 'PLATFORM_CREDENTIALS_REQUIRED';end if;
 elsif t.credentials_configured and p_line->>'messagingChannelId'=t.line_config->>'messagingChannelId'
  and p_line->>'messagingChannelId' ~ '^[0-9]{5,30}$' then
  select * into old_secret from platform_private.tenant_secrets where tenant_id=t.id;
  if not found then raise exception 'PLATFORM_CREDENTIALS_REQUIRED';end if;
  insert into platform_private.module_secrets(tenant_id,feature,envelope,credential_scope)values(t.id,p_feature,old_secret.envelope,'tenant');
 end if;
 configured:=exists(select 1 from platform_private.module_secrets where tenant_id=t.id and feature=p_feature);$new$;
 foreach signature in array array[
  'public.platform_save_module_line(text,text,integer,uuid,text,jsonb,jsonb)',
  'public.platform_save_module_line_for_merchant(text,uuid,timestamptz,text,integer,uuid,text,jsonb,jsonb)'
 ] loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  if position(old_block in definition)=0 or position('configured boolean;' in definition)=0
   or position('''credentialsConfigured'',true' in definition)=0
   then raise exception 'LINE_CAPABILITY_DEFINITION_DRIFT: %',signature;end if;
  definition:=replace(definition,'configured boolean;','configured boolean;old_line jsonb;liff_key text;');
  definition:=replace(definition,old_block,new_block);
  definition:=replace(definition,'''credentialsConfigured'',true','''credentialsConfigured'',configured');
  execute definition;
 end loop;
end $migration$;

-- The Edge handler verifies inherited tokens against this exact channel before
-- calling the service-only RPC. Persist the verified channel for its summary.
do $migration$
declare signature text;definition text;guard text;
begin
 guard:=$guard$
 if p_mode='inherit' then
  if not coalesce(p_channel_id ~ '^[0-9]{5,30}$',false)
   or p_channel_id is distinct from coalesce(t.module_line->p_feature->'line',t.line_config)->>'messagingChannelId'
   or not (exists(select 1 from platform_private.module_secrets s where s.tenant_id=t.id and s.feature=p_feature)
    or (not(t.module_line ? p_feature) and t.credentials_configured
     and exists(select 1 from platform_private.tenant_secrets s where s.tenant_id=t.id)))
   then raise exception 'PLATFORM_CREDENTIALS_REQUIRED';end if;
 end if;
$guard$;
 foreach signature in array array[
  'public.platform_save_notification_route(text,text,text,text,integer,uuid,text,text,jsonb)',
  'public.platform_save_notification_route_for_merchant(text,uuid,timestamptz,text,text,text,integer,uuid,text,text,jsonb)'
 ] loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  if position('insert into platform_private.module_notification_routes' in definition)=0
   or position('if t.version<>p_expected_version' in definition)=0
   then raise exception 'LINE_NOTIFICATION_DEFINITION_DRIFT: %',signature;end if;
  definition:=replace(definition,'''membership'',''points'',''events'',''calendar'',''booking''','''membership'',''points'',''events'',''booking''');
  definition:=replace(definition,' insert into platform_private.module_notification_routes',guard||' insert into platform_private.module_notification_routes');
  definition:=replace(definition,'case when p_mode=''custom'' then p_channel_id end','case when p_mode in (''custom'',''inherit'') then p_channel_id end');
  definition:=replace(definition,'case when p_mode=''custom'' then clock_timestamp() end','case when p_mode in (''custom'',''inherit'') then clock_timestamp() end');
  execute definition;
 end loop;
 foreach signature in array array[
  'public.platform_notification_test(text,text,text,integer,uuid,text,jsonb)',
  'public.platform_notification_test_for_merchant(text,uuid,timestamptz,text,text,integer,uuid,text,jsonb)'
 ] loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  if position('if p_purpose is null' in definition)=0 then raise exception 'LINE_NOTIFICATION_TEST_DEFINITION_DRIFT: %',signature;end if;
  definition:=replace(definition,'if p_purpose is null','if p_feature=''calendar'' or p_purpose is null');
  execute definition;
 end loop;
end $migration$;
-- CREATE OR REPLACE retains the existing service-role-only EXECUTE grants.
notify pgrst,'reload schema';
commit;
