create table platform_private.frontdesk_staff (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references platform_private.tenants(id),
 login_channel_id text not null check(login_channel_id ~ '^[0-9]{5,30}$'),
 line_user_id text not null check(line_user_id ~ '^U[0-9a-f]{32}$'),display_name text not null check(char_length(display_name) between 1 and 120),
 status text not null default 'pending' check(status in ('pending','approved','rejected','suspended')),
 permission_mode text not null default 'notify_only' check(permission_mode in ('notify_only','review')),
 version integer not null default 1,access_revoked_before timestamptz,oa_verified_at timestamptz,
 requested_at timestamptz not null default clock_timestamp(),reviewed_at timestamptz,reviewed_by text,updated_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,login_channel_id,line_user_id)
);
alter table platform_private.frontdesk_staff enable row level security;
revoke all on platform_private.frontdesk_staff from public,anon,authenticated;
grant select,insert,update on platform_private.frontdesk_staff to service_role;
create index frontdesk_staff_recipient on platform_private.frontdesk_staff(tenant_id,line_user_id) where status='approved';
-- Keep credentials in the existing purpose-bound encrypted store.
alter table platform_private.module_notification_routes drop constraint module_notification_routes_purpose_check;
alter table platform_private.module_notification_routes add constraint module_notification_routes_purpose_check check(purpose in ('admin','member','frontdesk'));
alter table platform_private.module_notification_routes drop constraint module_notification_routes_check;
alter table platform_private.module_notification_routes add constraint module_notification_routes_check check(purpose='member' or feature='booking');

create function platform_private.frontdesk_tenant(p_id uuid) returns platform_private.tenants
language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants;q platform_private.admin_qualifications;
begin
 -- Match the existing global lock order: qualification -> tenant -> staff -> booking.
 select * into t from platform_private.tenants where id=p_id;
 if not found then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 select * into q from platform_private.admin_qualifications where applicant_line_user_id=t.owner_line_user_id for share;
 if not found or q.status<>'approved' then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 select * into t from platform_private.tenants where id=p_id and owner_line_user_id=q.applicant_line_user_id for share;
 if not found or t.status<>'active' or t.runtime_schema is null or t.features->>'booking' is distinct from 'true'
  or t.expires_at<=clock_timestamp() then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 return t;
end $$;
create function platform_private.frontdesk_staff_json(s platform_private.frontdesk_staff) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('id',s.id,'displayName',s.display_name,'status',s.status,'permissionMode',s.permission_mode,
 'version',s.version,'requestedAt',s.requested_at,'reviewedAt',s.reviewed_at);
$$;
create function public.platform_frontdesk_context(p_slug text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants;begin
 select * into t from platform_private.tenants where slug=p_slug;
 t:=platform_private.frontdesk_tenant(t.id);
 return jsonb_build_object('id',t.id,'slug',t.slug,'name',t.name,'frontdesk',coalesce(t.module_line->'booking'->'frontdesk','{}'));
end $$;
create function public.platform_frontdesk_admin(p_actor text,p_tenant_id uuid,p_issued_at timestamptz,p_action text,p_body jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants;s platform_private.frontdesk_staff;r platform_private.requests;v jsonb;hash text;rid uuid;cfg jsonb;
begin
 t:=platform_private.require_merchant_access(p_actor,p_tenant_id,p_issued_at);
 if t.features->>'booking' is distinct from 'true' then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 if p_action not in ('get','settings.save','staff.save') or p_action is null then raise exception 'PLATFORM_INVALID_INPUT';end if;
 if p_action<>'get' then
  rid:=(p_body->>'requestId')::uuid;hash:=p_body->>'payloadHash';
  if rid is null or hash is null or hash!~'^[a-f0-9]{64}$' then raise exception 'PLATFORM_INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended(rid::text,0));
  select * into r from platform_private.requests where request_id=rid;
  if found then
   if r.actor<>p_actor or r.operation<>'frontdesk:'||t.id||':'||p_action or r.payload_hash<>hash then raise exception 'FRONTDESK_REQUEST_CONFLICT';end if;
   return r.result;
  end if;
 end if;
 if p_action='settings.save' then
  if (p_body->>'expectedVersion')::integer is distinct from t.version then raise exception 'PLATFORM_CONFLICT';end if;
  cfg:=t.module_line->'booking'->'frontdesk';
  if cfg->>'loginChannelId' is not null and (cfg->>'loginChannelId' is distinct from p_body->>'loginChannelId' or cfg->>'liffId' is distinct from p_body->>'liffId') then raise exception 'PLATFORM_IMMUTABLE_IDENTITY';end if;
  if coalesce(p_body->>'loginChannelId','')!~'^[0-9]{5,30}$' or coalesce(p_body->>'liffId','')!~'^[0-9]{5,30}-[A-Za-z0-9_-]+$'
   or split_part(p_body->>'liffId','-',1)<>p_body->>'loginChannelId' or jsonb_typeof(p_body->'enabled') is distinct from 'boolean'
   then raise exception 'PLATFORM_INVALID_INPUT';end if;
  if cfg->>'messagingChannelId' is not null and cfg->>'messagingChannelId' is distinct from p_body->>'messagingChannelId'
   and exists(select 1 from platform_private.frontdesk_staff where tenant_id=t.id) then raise exception 'PLATFORM_IMMUTABLE_IDENTITY';end if;
  -- Every Messaging Channel has exactly one merchant owner, including custom routes.
  if exists(select 1 from platform_private.line_channel_owners where channel_id=p_body->>'messagingChannelId' and tenant_id<>t.id) then raise exception 'FRONTDESK_CHANNEL_CONFLICT';end if;
  cfg:=jsonb_build_object('loginChannelId',p_body->>'loginChannelId','liffId',p_body->>'liffId','messagingChannelId',p_body->>'messagingChannelId','oaId',coalesce(p_body->>'oaId',cfg->>'oaId'),'revision',t.version+1,'enabled',(p_body->>'enabled')::boolean);
  if not(t.module_line ? 'booking') and t.credentials_configured then
   insert into platform_private.module_secrets(tenant_id,feature,envelope,credential_scope)
    select t.id,'booking',x.envelope,'tenant' from platform_private.tenant_secrets x where x.tenant_id=t.id
    on conflict(tenant_id,feature) do nothing;
  end if;
  insert into platform_private.module_notification_routes(tenant_id,feature,purpose,mode,channel_id,envelope,verified_at)
   values(t.id,'booking','frontdesk',case when (p_body->>'enabled')::boolean then 'custom' else 'disabled' end,p_body->>'messagingChannelId',p_body->'envelope',clock_timestamp())
   on conflict(tenant_id,feature,purpose) do update set mode=excluded.mode,channel_id=excluded.channel_id,envelope=coalesce(nullif(excluded.envelope,'null'),module_notification_routes.envelope),verified_at=excluded.verified_at,updated_at=clock_timestamp();
  update platform_private.tenants set module_line=jsonb_set(module_line,'{booking}',coalesce(module_line->'booking',jsonb_build_object('line',line_config,'credentialsConfigured',credentials_configured))||jsonb_build_object('frontdesk',cfg,'notifications',coalesce(module_line->'booking'->'notifications','{}')||jsonb_build_object('frontdesk',jsonb_build_object('mode',case when (p_body->>'enabled')::boolean then 'custom' else 'disabled' end,'channelId',p_body->>'messagingChannelId','verifiedAt',clock_timestamp())))),version=version+1,updated_at=clock_timestamp(),updated_by=p_actor where id=t.id returning * into t;
 elsif p_action='staff.save' then
  select * into s from platform_private.frontdesk_staff where id=(p_body->>'staffId')::uuid and tenant_id=t.id for update;
  if not found then raise exception 'FRONTDESK_NOT_FOUND';end if;
  if s.version is distinct from (p_body->>'expectedVersion')::integer then raise exception 'PLATFORM_CONFLICT';end if;
  if coalesce(p_body->>'status','') not in ('approved','rejected','suspended') or coalesce(p_body->>'permissionMode','') not in ('notify_only','review') then raise exception 'PLATFORM_INVALID_INPUT';end if;
  if p_body->>'status'='approved' and s.oa_verified_at is null then raise exception 'FRONTDESK_OA_REQUIRED';end if;
  update platform_private.frontdesk_staff set status=p_body->>'status',permission_mode=p_body->>'permissionMode',version=version+1,
   access_revoked_before=case when p_body->>'status'<>'approved' then clock_timestamp() else access_revoked_before end,
   reviewed_by=p_actor,reviewed_at=clock_timestamp(),updated_at=clock_timestamp() where id=s.id;
 end if;
 if p_action='settings.save' and t.module_line->'booking'->'frontdesk'->>'enabled'='false' then
  execute format('update %I.notice_outbox set status=''skipped'',last_error=''FRONTDESK_CONFIGURATION_DISABLED'' where channel=''frontdesk'' and status in (''pending'',''sending'')',t.runtime_schema);
 elsif p_action='staff.save' and p_body->>'status'<>'approved' then
  execute format('update %I.notice_outbox set status=''skipped'',last_error=''FRONTDESK_ACCESS_REVOKED'' where channel=''frontdesk'' and recipient=$1 and status in (''pending'',''sending'')',t.runtime_schema) using s.line_user_id;
 end if;
 if p_action<>'get' then
  execute format('delete from %I.frontdesk_notice_recipients',t.runtime_schema);
  if t.module_line->'booking'->'frontdesk'->>'enabled'='true' then
   execute format('insert into %I.frontdesk_notice_recipients(line_user_id) select line_user_id from platform_private.frontdesk_staff where tenant_id=$1 and login_channel_id=$2 and status=''approved'' and oa_verified_at is not null',t.runtime_schema) using t.id,t.module_line->'booking'->'frontdesk'->>'loginChannelId';
  end if;
 end if;
 v:=jsonb_build_object('version',t.version,'frontdesk',coalesce(t.module_line->'booking'->'frontdesk','{}'),'staff',
  coalesce((select jsonb_agg(platform_private.frontdesk_staff_json(x) order by x.requested_at) from platform_private.frontdesk_staff x where x.tenant_id=t.id),'[]'));
 if p_action<>'get' then
  insert into platform_private.requests(request_id,actor,operation,payload_hash,result)values(rid,p_actor,'frontdesk:'||t.id||':'||p_action,hash,v);
  insert into platform_private.audit_events(actor,tenant_id,action,detail)values(p_actor,t.id,'FRONTDESK_'||upper(replace(p_action,'.','_')),jsonb_build_object('staffId',s.id,'status',p_body->>'status','permissionMode',p_body->>'permissionMode','result','success'));
 end if;return v;
end $$;
create function platform_private.frontdesk_booking_json(p_schema text,p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v jsonb;begin
 execute format($q$select jsonb_build_object('id',b.id,'status',b.status,'updatedAt',b.updated_at,'bookingDate',b.booking_date,'startAt',b.start_at,'endAt',b.end_at,'name',coalesce(nullif(b.contact_surname,''),m.surname,'會員'),'phone',coalesce(nullif(b.contact_phone,''),m.phone,''),'partySize',b.party_size,'note',b.member_note,'cancellationPending',b.cancellation_requested_at is not null and b.cancellation_reviewed_at is null,'services',coalesce((select jsonb_agg(jsonb_build_object('title',i.service_title,'quantity',i.quantity)) from %I.booking_items i where i.booking_id=b.id),'[]')) from %I.bookings b left join %I.members m on m.id=b.member_id where b.id=$1$q$,p_schema,p_schema,p_schema) into v using p_id;return v;
end $$;
create function public.platform_frontdesk_request(p_tenant_id uuid,p_actor text,p_channel_id text,p_issued_at timestamptz,p_action text,p_body jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants;s platform_private.frontdesk_staff;cfg jsonb;v jsonb;b jsonb;bid uuid;rid uuid;hash text;r platform_private.requests;
begin
 t:=platform_private.frontdesk_tenant(p_tenant_id);cfg:=t.module_line->'booking'->'frontdesk';
 if cfg->>'enabled' is distinct from 'true' then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 if p_actor is null or p_actor!~'^U[0-9a-f]{32}$' or p_channel_id is distinct from cfg->>'loginChannelId' or p_issued_at is null or not isfinite(p_issued_at) or p_issued_at>clock_timestamp()+interval '60 seconds' or p_issued_at<=coalesce(t.access_revoked_before,'-infinity') then raise exception 'FRONTDESK_AUTH_INVALID';end if;
 select * into s from platform_private.frontdesk_staff where tenant_id=t.id and login_channel_id=p_channel_id and line_user_id=p_actor for share;
 if p_action='apply' then
  if p_body->>'oaVerified' is distinct from 'true' then raise exception 'FRONTDESK_OA_REQUIRED';end if;
  if p_body->>'verifiedMessagingChannelId' is distinct from cfg->>'messagingChannelId' or p_body->'verifiedConfigRevision' is distinct from cfg->'revision' then raise exception 'FRONTDESK_OA_STALE';end if;
  insert into platform_private.frontdesk_staff(tenant_id,login_channel_id,line_user_id,display_name,oa_verified_at)
   values(t.id,p_channel_id,p_actor,left(coalesce(nullif(p_body->>'displayName',''),'櫃檯人員'),120),clock_timestamp()) on conflict(tenant_id,login_channel_id,line_user_id) do nothing;
  select * into s from platform_private.frontdesk_staff where tenant_id=t.id and login_channel_id=p_channel_id and line_user_id=p_actor;
  return jsonb_build_object('staff',platform_private.frontdesk_staff_json(s));
 end if;
 if p_action='bootstrap' then return jsonb_build_object('staff',case when s.id is null then null else platform_private.frontdesk_staff_json(s) end);end if;
 if s.id is null or s.status<>'approved' or s.permission_mode<>'review' or s.oa_verified_at is null then raise exception 'FRONTDESK_REVIEW_REQUIRED';end if;
 if p_issued_at<=coalesce(s.access_revoked_before,'-infinity') then raise exception 'FRONTDESK_AUTH_INVALID';end if;
 if p_action='bookings' then
  bid:=nullif(p_body->>'bookingId','')::uuid;
  execute format('select coalesce(jsonb_agg(platform_private.frontdesk_booking_json($1,x.id) order by x.start_at),''[]'') from (select id,start_at from %I.bookings where ($2::uuid is null and status=''pending'') or id=$2 order by start_at,id limit 50) x',t.runtime_schema) into v using t.runtime_schema,bid;
  return jsonb_build_object('bookings',v);
 end if;
 if p_action is distinct from 'booking.update' or coalesce(p_body->>'status','') not in ('confirmed','rejected') then raise exception 'PLATFORM_INVALID_INPUT';end if;
 bid:=(p_body->>'bookingId')::uuid;rid:=(p_body->>'requestId')::uuid;
 if bid is null or rid is null or nullif(p_body->>'expectedUpdatedAt','') is null then raise exception 'PLATFORM_INVALID_INPUT';end if;
 hash:=encode(sha256(convert_to((p_body-'requestId')::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(rid::text,0));
 select * into r from platform_private.requests where request_id=rid;
 if found then
  if r.actor<>p_actor or r.operation<>'frontdesk:booking:'||t.id or r.payload_hash<>hash then raise exception 'FRONTDESK_REQUEST_CONFLICT';end if;
  return r.result||'{"alreadyApplied":true}';
 end if;
 execute format('select to_jsonb(b) from %I.bookings b where id=$1 for update',t.runtime_schema) into b using bid;
 if b is null then raise exception 'FRONTDESK_NOT_FOUND';end if;
 if b->>'status'<>'pending' or (b->>'updated_at')::timestamptz is distinct from (p_body->>'expectedUpdatedAt')::timestamptz then raise exception 'BOOKING_CONFLICT';end if;
 if b->>'cancellation_requested_at' is not null and b->>'cancellation_reviewed_at' is null then raise exception 'BOOKING_CANCELLATION_PENDING';end if;
 execute format('update %I.bookings set status=$2,admin_note=coalesce($3,admin_note),%I=$4,%I=clock_timestamp() where id=$1',t.runtime_schema,case when p_body->>'status'='confirmed' then 'confirmed_by' else 'rejected_by' end,case when p_body->>'status'='confirmed' then 'confirmed_at' else 'rejected_at' end) using bid,p_body->>'status',left(p_body->>'note',500),p_actor;
 execute format('insert into %I.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata) values($1,''frontdesk'',$2,''booking'',$3,''success'',$4)',t.runtime_schema) using p_actor,'BOOKING_'||upper(p_body->>'status'),bid::text,jsonb_build_object('previousStatus','pending');
 v:=jsonb_build_object('booking',platform_private.frontdesk_booking_json(t.runtime_schema,bid),'alreadyApplied',false);
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)values(rid,p_actor,'frontdesk:booking:'||t.id,hash,v);
 return v;
end $$;
create function public.platform_frontdesk_delivery(p_tenant_id uuid,p_actor text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants;s platform_private.frontdesk_staff;begin
 begin t:=platform_private.frontdesk_tenant(p_tenant_id);exception when others then return '{"allowed":false}';end;
 select * into s from platform_private.frontdesk_staff where tenant_id=t.id and line_user_id=p_actor and login_channel_id=t.module_line->'booking'->'frontdesk'->>'loginChannelId' and status='approved' and oa_verified_at is not null;
 return jsonb_build_object('allowed',s.id is not null and t.module_line->'booking'->'frontdesk'->>'enabled'='true','permissionMode',s.permission_mode,'business',t.slug,'liffId',t.module_line->'booking'->'frontdesk'->>'liffId');
end $$;
-- Amend the source template once; business_sql installs the same definition in existing and newly provisioned schemas.
do $install$
declare tpl jsonb;f jsonb;items jsonb:='[]';def text;t record;oldsource text;c jsonb;constraints jsonb:='[]';begin
 select snapshot into strict tpl from platform_private.business_templates where version='business-v1-20261019' for update;
 -- This tenant-local subscription projection keeps provisioning's private-schema
 -- prohibition intact. Its contents are replaced in the same owner transaction.
 tpl:=jsonb_set(tpl,'{tables}',(tpl->'tables')||jsonb_build_array(jsonb_build_object('name','frontdesk_notice_recipients','columns',jsonb_build_array(jsonb_build_object('name','line_user_id','type','text','default',null,'notNull',true,'identity','','generated','')))));
 tpl:=jsonb_set(tpl,'{constraints}',(tpl->'constraints')||jsonb_build_array(jsonb_build_object('table','frontdesk_notice_recipients','name','frontdesk_notice_recipients_pkey','type','p','definition','PRIMARY KEY (line_user_id)')));
 for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
  execute format('create table %I.frontdesk_notice_recipients(line_user_id text primary key)',t.runtime_schema);
  execute format('alter table %I.frontdesk_notice_recipients enable row level security',t.runtime_schema);
  execute format('revoke all on %I.frontdesk_notice_recipients from public,anon,authenticated',t.runtime_schema);
  execute format('grant select,insert,delete on %I.frontdesk_notice_recipients to service_role',t.runtime_schema);
 end loop;
 oldsource:=E'from public.admins\n        where status=''active'' and role=''admin'' and line_user_id ~ ''^U[0-9a-f]{32}$''';
 for f in select value from jsonb_array_elements(tpl->'functions') loop
  if f->>'name'='notice_enqueue' then
   def:=f->>'definition';if position(oldsource in def)=0 then raise exception 'FRONTDESK_NOTIFICATION_DEFINITION_DRIFT';end if;
   -- Leave the established admin SELECT unchanged. No configured recipients
   -- means only an indexed existence check, without changing its query plan.
   def:=replace(def,$marker$  elsif event_kind in ('confirmed','modified_by_admin','completed','rejected','cancelled','cancellation_rejected') then$marker$,
   $fanout$    if exists(select 1 from public.frontdesk_notice_recipients) then
      if event_kind='modified_by_member' then
        insert into public.notice_outbox(booking_id,event_key,channel,recipient,message_text,coalesce_key,next_attempt_at)
          select NEW.id,event_id,'frontdesk',line_user_id,left(admin_message,2200),notification_coalesce_key,now()+interval '15 seconds' from public.frontdesk_notice_recipients
          on conflict (coalesce_key,channel,recipient) where status='pending' and attempt_count=0 and first_attempt_at is null and coalesce_key is not null
          do update set event_key=excluded.event_key,message_text=excluded.message_text,next_attempt_at=excluded.next_attempt_at,last_error=null;
      else
        insert into public.notice_outbox(booking_id,event_key,channel,recipient,message_text)
          select NEW.id,event_id,'frontdesk',line_user_id,left(admin_message,2200) from public.frontdesk_notice_recipients on conflict(event_key,channel,recipient) do nothing;
      end if;
    end if;
  elsif event_kind in ('confirmed','modified_by_admin','completed','rejected','cancelled','cancellation_rejected') then$fanout$);
   f:=jsonb_set(f,'{definition}',to_jsonb(def));
   for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop execute platform_private.business_sql(def,t.runtime_schema);end loop;
  elsif f->>'name'='claim_booking_notifications' then
   def:=replace(f->>'definition',E'  return query\n',E'  update public.notice_outbox q set status=''skipped'',last_error=''Frontdesk access revoked'' where q.channel=''frontdesk'' and q.status in (''pending'',''sending'') and not exists(select 1 from public.frontdesk_notice_recipients s where s.line_user_id=q.recipient);\n  return query\n');
   f:=jsonb_set(f,'{definition}',to_jsonb(def));
   for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop execute platform_private.business_sql(def,t.runtime_schema);end loop;
  end if;items:=items||jsonb_build_array(f);
 end loop;
 for c in select value from jsonb_array_elements(tpl->'constraints') loop
  if c->>'table'='notice_outbox' and c->>'name'='notice_outbox_channel_check' then c:=jsonb_set(c,'{definition}',to_jsonb('CHECK (channel IN (''admin'',''member'',''frontdesk''))'::text));end if;
  if c->>'table'='booking_audit_events' and c->>'name'='booking_audit_events_actor_role_check' then c:=jsonb_set(c,'{definition}',to_jsonb('CHECK (actor_role IN (''member'',''admin'',''system'',''frontdesk''))'::text));end if;
  constraints:=constraints||jsonb_build_array(c);
 end loop;
 update platform_private.business_templates set snapshot=jsonb_set(jsonb_set(tpl,'{functions}',items),'{constraints}',constraints) where version='business-v1-20261019';
 for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
  execute format('alter table %I.notice_outbox drop constraint notice_outbox_channel_check',t.runtime_schema);
  execute format('alter table %I.notice_outbox add constraint notice_outbox_channel_check check(channel in (''admin'',''member'',''frontdesk''))',t.runtime_schema);
  execute format('alter table %I.booking_audit_events drop constraint booking_audit_events_actor_role_check',t.runtime_schema);
  execute format('alter table %I.booking_audit_events add constraint booking_audit_events_actor_role_check check(actor_role in (''member'',''admin'',''system'',''frontdesk''))',t.runtime_schema);
 end loop;
end $install$;
create function public.platform_frontdesk_replay(p_actor text,p_tenant_id uuid,p_issued_at timestamptz,p_request_id uuid,p_hash text,p_action text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r platform_private.requests;begin
 perform platform_private.require_merchant_access(p_actor,p_tenant_id,p_issued_at);
 select * into r from platform_private.requests where request_id=p_request_id;
 if not found then return null;end if;
 if r.actor<>p_actor or r.operation<>'frontdesk:'||p_tenant_id||':'||p_action or r.payload_hash<>p_hash then raise exception 'FRONTDESK_REQUEST_CONFLICT';end if;
 return r.result;
end $$;
revoke all on function public.platform_frontdesk_replay(text,uuid,timestamptz,uuid,text,text) from public,anon,authenticated;
grant execute on function public.platform_frontdesk_replay(text,uuid,timestamptz,uuid,text,text) to service_role;
revoke all on function platform_private.frontdesk_tenant(uuid),platform_private.frontdesk_staff_json(platform_private.frontdesk_staff),platform_private.frontdesk_booking_json(text,uuid),
 public.platform_frontdesk_context(text),public.platform_frontdesk_admin(text,uuid,timestamptz,text,jsonb),public.platform_frontdesk_request(uuid,text,text,timestamptz,text,jsonb),public.platform_frontdesk_delivery(uuid,text) from public,anon,authenticated;
grant execute on function platform_private.frontdesk_tenant(uuid),platform_private.frontdesk_staff_json(platform_private.frontdesk_staff),platform_private.frontdesk_booking_json(text,uuid),
 public.platform_frontdesk_context(text),public.platform_frontdesk_admin(text,uuid,timestamptz,text,jsonb),public.platform_frontdesk_request(uuid,text,text,timestamptz,text,jsonb),public.platform_frontdesk_delivery(uuid,text) to service_role;
notify pgrst,'reload schema';
