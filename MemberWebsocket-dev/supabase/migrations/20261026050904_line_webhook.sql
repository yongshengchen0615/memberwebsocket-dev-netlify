-- #144: terminal event receipts only; no business dispatch or member mutation.
begin;
create table platform_private.line_channel_owners(
 channel_id text primary key check(channel_id ~ '^[0-9]{5,30}$'),
 tenant_id uuid not null references platform_private.tenants(id) on delete cascade
);
create table platform_private.line_webhook_bindings(
 channel_id text primary key references platform_private.line_channel_owners(channel_id) on delete cascade,
 tenant_id uuid not null references platform_private.tenants(id) on delete cascade,
 feature text not null check(feature in ('membership','points','events','calendar','booking')),
 destination text not null unique check(destination ~ '^U[0-9a-f]{32}$'),
 revision text not null,
 api_verified_at timestamptz not null default clock_timestamp(),
 last_signature_at timestamptz,last_event_at timestamptz,
 rate_minute timestamptz,rate_count integer not null default 0
);
create table platform_private.line_webhook_receipts(
 channel_id text not null references platform_private.line_webhook_bindings(channel_id) on delete cascade,
 event_id text not null check(event_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 event_type text not null,provider_timestamp bigint not null check(provider_timestamp between 0 and 8640000000000000),
 redelivery boolean not null,state text not null check(state in ('observed','ignored')),
 received_at timestamptz not null default clock_timestamp(),primary key(channel_id,event_id)
);
alter table platform_private.line_channel_owners enable row level security;
alter table platform_private.line_webhook_bindings enable row level security;
alter table platform_private.line_webhook_receipts enable row level security;
revoke all on platform_private.line_channel_owners,platform_private.line_webhook_bindings,platform_private.line_webhook_receipts from public,anon,authenticated;
grant all on platform_private.line_channel_owners,platform_private.line_webhook_bindings,platform_private.line_webhook_receipts to service_role;

-- Synchronize every settings entry point, including direct administrative edits.
-- A global transactional lock orders claims; the PK is the final concurrent fence.
create function platform_private.sync_line_channel_owners(p_tenant_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare channels text[];channel text;
begin
 perform pg_advisory_xact_lock(hashtextextended('platform:line-channel-owners',0));
 select array_agg(distinct id order by id) into channels from (
  select line_config->>'messagingChannelId' id from platform_private.tenants where id=p_tenant_id
  union all select m.value->'line'->>'messagingChannelId' from platform_private.tenants t cross join lateral jsonb_each(t.module_line) m where t.id=p_tenant_id
  union all select channel_id from platform_private.module_notification_routes where tenant_id=p_tenant_id and mode='custom'
 ) c where id ~ '^[0-9]{5,30}$';
 foreach channel in array coalesce(channels,array[]::text[]) loop
  insert into platform_private.line_channel_owners as existing(channel_id,tenant_id) values(channel,p_tenant_id)
   on conflict(channel_id) do update set tenant_id=excluded.tenant_id where existing.tenant_id=excluded.tenant_id;
  if not found then raise exception 'LINE_CHANNEL_IN_USE';end if;
 end loop;
 delete from platform_private.line_channel_owners where tenant_id=p_tenant_id and not(channel_id=any(coalesce(channels,array[]::text[])));
end $$;
create function platform_private.line_channel_owner_trigger()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_table_name='tenants' then
  perform platform_private.sync_line_channel_owners(new.id);
 elsif tg_op='DELETE' then
  perform platform_private.sync_line_channel_owners(old.tenant_id);
 else
  perform platform_private.sync_line_channel_owners(new.tenant_id);
 end if;
 return null;
end $$;
-- Fail the upgrade atomically if legacy settings claim a Channel across tenants.
do $$declare t record;begin for t in select id from platform_private.tenants order by id loop perform platform_private.sync_line_channel_owners(t.id);end loop;end $$;
create trigger line_channel_owner_tenant after insert or update of line_config,module_line on platform_private.tenants for each row execute function platform_private.line_channel_owner_trigger();
create trigger line_channel_owner_route after insert or update or delete on platform_private.module_notification_routes for each row execute function platform_private.line_channel_owner_trigger();

-- Service-only encrypted material. This function is never a browser response.
create function platform_private.line_webhook_material(p_tenant_id uuid,p_feature text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants;s platform_private.module_secrets;envelope jsonb;scope text;channel text;
begin
 select * into t from platform_private.tenants where id=p_tenant_id;
 if not found or t.status<>'active' or t.expires_at<=clock_timestamp()
  or t.isolation_verified_at is null or not coalesce((t.features->>p_feature)::boolean,false)
  or not exists(select 1 from platform_private.admin_qualifications q where q.applicant_line_user_id=t.owner_line_user_id and q.status='approved')
  or not exists(select 1 from platform_private.applications a where a.tenant_id=t.id and a.status='approved') then return null;end if;
 channel:=coalesce(t.module_line->p_feature->'line',t.line_config)->>'messagingChannelId';
 if not coalesce(channel ~ '^[0-9]{5,30}$',false) then return null;end if;
 select * into s from platform_private.module_secrets where tenant_id=t.id and feature=p_feature for share;
 if found and t.module_line->p_feature->>'credentialsConfigured'='true' then envelope:=s.envelope;scope:=s.credential_scope;
 elsif not(t.module_line ? p_feature) and t.credentials_configured then
  select ts.envelope into envelope from platform_private.tenant_secrets ts where tenant_id=t.id for share;scope:='tenant';
 end if;
 if envelope is null then return null;end if;
 return jsonb_build_object('tenantId',t.id,'channelId',channel,'feature',p_feature,'scope',scope,'envelope',envelope,
  'revision',md5(envelope::text||':'||scope||':'||channel));
end $$;
create function public.platform_line_webhook_prepare(p_actor text,p_tenant_id uuid,p_issued_at timestamptz,p_feature text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants;
begin
 t:=platform_private.require_merchant_access(p_actor,p_tenant_id,p_issued_at);
 if p_feature is null or p_feature not in ('membership','points','events','calendar','booking')
  or not coalesce((t.features->>p_feature)::boolean,false) then raise exception 'PLATFORM_FEATURE_DISABLED';end if;
 return platform_private.line_webhook_material(t.id,p_feature);
end $$;
create function public.platform_line_webhook_status(p_actor text,p_tenant_id uuid,p_issued_at timestamptz,p_feature text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c jsonb;b platform_private.line_webhook_bindings;current_binding boolean;total bigint;
begin
 c:=public.platform_line_webhook_prepare(p_actor,p_tenant_id,p_issued_at,p_feature);
 select * into b from platform_private.line_webhook_bindings where tenant_id=p_tenant_id and channel_id=c->>'channelId' and feature=p_feature;
 current_binding:=b.revision is not null and b.revision=c->>'revision';
 select count(*) into total from platform_private.line_webhook_receipts where channel_id=b.channel_id;
 return jsonb_build_object('configurationState',case when c is null then 'optional' else 'configured' end,
  'channelId',c->>'channelId','apiState',case when current_binding then 'accepted' else 'pending' end,
  'ingressState',case when current_binding and b.last_signature_at is not null then 'verified' else 'pending' end,
  'humanState','pending','apiVerifiedAt',case when current_binding then b.api_verified_at end,
  'lastSignatureAt',case when current_binding then b.last_signature_at end,'lastEventAt',case when current_binding then b.last_event_at end,'eventsReceived',coalesce(total,0));
end $$;
create function public.platform_line_webhook_bind(p_actor text,p_tenant_id uuid,p_issued_at timestamptz,p_feature text,p_channel_id text,p_destination text,p_revision text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c jsonb;
begin
 c:=public.platform_line_webhook_prepare(p_actor,p_tenant_id,p_issued_at,p_feature);
 if c is null or c->>'channelId' is distinct from p_channel_id or c->>'revision' is distinct from p_revision then raise exception 'LINE_WEBHOOK_STALE';end if;
 if p_destination is null or p_destination !~ '^U[0-9a-f]{32}$' then raise exception 'PLATFORM_INVALID_INPUT';end if;
 insert into platform_private.line_webhook_bindings as b(channel_id,tenant_id,feature,destination,revision)
 values(p_channel_id,p_tenant_id,p_feature,p_destination,p_revision)
 on conflict(channel_id) do update set feature=excluded.feature,destination=excluded.destination,revision=excluded.revision,api_verified_at=clock_timestamp(),
  last_signature_at=case when b.revision=excluded.revision and b.feature=excluded.feature and b.destination=excluded.destination then b.last_signature_at end,
  last_event_at=case when b.revision=excluded.revision and b.feature=excluded.feature and b.destination=excluded.destination then b.last_event_at end
 where b.tenant_id=excluded.tenant_id;
 if not found then raise exception 'LINE_CHANNEL_IN_USE';end if;
 insert into platform_private.audit_events(actor,tenant_id,action,detail) values(p_actor,p_tenant_id,'LINE_WEBHOOK_CHECKED',jsonb_build_object('feature',p_feature,'result','api_accepted'));
 return public.platform_line_webhook_status(p_actor,p_tenant_id,p_issued_at,p_feature);
end $$;
create function public.platform_line_webhook_candidate(p_destination text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare b platform_private.line_webhook_bindings;c jsonb;
begin
 select * into b from platform_private.line_webhook_bindings where destination=p_destination;
 if not found then return null;end if;
 c:=platform_private.line_webhook_material(b.tenant_id,b.feature);
 if c->>'revision' is distinct from b.revision or c->>'channelId' is distinct from b.channel_id then return null;end if;
 return c;
end $$;
create function public.platform_line_webhook_ingest(p_channel_id text,p_revision text,p_events jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare b platform_private.line_webhook_bindings;t platform_private.tenants;c jsonb;e jsonb;accepted integer:=0;n integer;minute timestamptz:=date_trunc('minute',clock_timestamp());
begin
 -- Lock qualification, tenant, secrets and binding in merchant-write order.
 perform 1 from platform_private.admin_qualifications q join platform_private.tenants tt on tt.owner_line_user_id=q.applicant_line_user_id
  join platform_private.line_webhook_bindings bb on bb.tenant_id=tt.id where bb.channel_id=p_channel_id for share of q;
 -- Lock tenant before binding, matching merchant configuration transactions.
 select tt.* into t from platform_private.tenants tt join platform_private.line_webhook_bindings bb on bb.tenant_id=tt.id where bb.channel_id=p_channel_id for update of tt;
 select * into b from platform_private.line_webhook_bindings where channel_id=p_channel_id for update;
 c:=platform_private.line_webhook_material(b.tenant_id,b.feature);
 if c is null or p_revision is null or c->>'revision' is distinct from p_revision or b.revision is distinct from p_revision
  or c->>'channelId' is distinct from p_channel_id then raise exception 'LINE_WEBHOOK_STALE';end if;
 if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events)>100 then raise exception 'LINE_WEBHOOK_INVALID_EVENT';end if;
 if b.rate_minute=minute and b.rate_count>=120 then raise exception 'LINE_WEBHOOK_RATE_LIMIT';end if;
 for e in select value from jsonb_array_elements(p_events) loop
  if jsonb_typeof(e) is distinct from 'object' or exists(select 1 from jsonb_object_keys(e) k where k not in ('eventId','type','timestamp','redelivery'))
   or not coalesce(e->>'eventId' ~ '^[A-Za-z0-9_-]{1,128}$',false)
   or e->>'type' is null or e->>'type' not in ('message','follow','unfollow','join','leave','memberJoined','memberLeft','postback','beacon','accountLink','things','unsend','videoPlayComplete','other')
   or jsonb_typeof(e->'timestamp') is distinct from 'number' or not coalesce(e->>'timestamp' ~ '^[0-9]+$',false)
   or (e->>'timestamp')::numeric>8640000000000000 or jsonb_typeof(e->'redelivery') is distinct from 'boolean'
   then raise exception 'LINE_WEBHOOK_INVALID_EVENT';end if;
  insert into platform_private.line_webhook_receipts(channel_id,event_id,event_type,provider_timestamp,redelivery,state)
   values(p_channel_id,e->>'eventId',e->>'type',(e->>'timestamp')::bigint,(e->>'redelivery')::boolean,case when e->>'type'='other' then 'ignored' else 'observed' end)
   on conflict(channel_id,event_id)do nothing;
  get diagnostics n=row_count;accepted:=accepted+n;
 end loop;
 update platform_private.line_webhook_bindings set last_signature_at=clock_timestamp(),
  last_event_at=case when accepted>0 then clock_timestamp() else last_event_at end,
  rate_minute=minute,rate_count=case when rate_minute=minute then rate_count+1 else 1 end where channel_id=p_channel_id;
 return jsonb_build_object('accepted',accepted);
end $$;
create function public.platform_line_webhook_denied(p_actor text)
returns void language sql security invoker set search_path='' as $$
 insert into platform_private.audit_events(actor,action,detail) values(p_actor,'LINE_WEBHOOK_ACCESS_DENIED','{"result":"denied"}'::jsonb);
$$;

do $$declare fn record;begin
 for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='public' and p.proname like 'platform_line_webhook_%')
  or (n.nspname='platform_private' and p.proname in ('sync_line_channel_owners','line_channel_owner_trigger','line_webhook_material')) loop
  execute 'revoke all on function '||fn.signature||' from public,anon,authenticated';
  execute 'grant execute on function '||fn.signature||' to service_role';
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
