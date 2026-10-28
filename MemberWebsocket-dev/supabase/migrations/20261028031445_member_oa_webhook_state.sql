-- #158: signed observations only. Registration and rewards retain their
-- existing server-side friendship verification and first-activation authority.
begin;
create table platform_private.member_oa_webhook_state(
 tenant_id uuid not null references platform_private.tenants(id) on delete cascade,
 channel_id text not null references platform_private.line_channel_owners(channel_id) on delete cascade,
 feature text not null check(feature='membership'),
 revision text not null,
 line_user_id text not null check(line_user_id ~ '^U[0-9a-f]{32}$'),
 friendship_state text not null check(friendship_state in ('follow','unfollow')),
 provider_timestamp bigint not null check(provider_timestamp between 0 and 8640000000000000),
 observed_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,channel_id,feature,revision,line_user_id)
);
comment on table platform_private.member_oa_webhook_state is 'Private OA follow/unfollow observations scoped to a verified membership binding revision; never activation authority.';
alter table platform_private.member_oa_webhook_state enable row level security;
revoke all on platform_private.member_oa_webhook_state from public,anon,authenticated;
grant all on platform_private.member_oa_webhook_state to service_role;

create or replace function public.platform_line_webhook_ingest(p_channel_id text,p_feature text,p_revision text,p_events jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare b platform_private.line_webhook_bindings;o platform_private.line_channel_owners;t platform_private.tenants;c jsonb;e jsonb;accepted integer:=0;n integer;minute timestamptz:=date_trunc('minute',clock_timestamp());
begin
 -- Lock qualification, tenant, secrets and binding in merchant-write order.
 perform 1 from platform_private.admin_qualifications q join platform_private.tenants tt on tt.owner_line_user_id=q.applicant_line_user_id
  join platform_private.line_webhook_bindings bb on bb.tenant_id=tt.id where bb.channel_id=p_channel_id and bb.feature=p_feature for share of q;
 -- Lock tenant before binding, matching merchant configuration transactions.
 select tt.* into t from platform_private.tenants tt join platform_private.line_webhook_bindings bb on bb.tenant_id=tt.id where bb.channel_id=p_channel_id and bb.feature=p_feature for update of tt;
 select * into b from platform_private.line_webhook_bindings where channel_id=p_channel_id and feature=p_feature for update;
 c:=platform_private.line_webhook_material(b.tenant_id,b.feature);
 if c is null or p_revision is null or c->>'revision' is distinct from p_revision or b.revision is distinct from p_revision
  or c->>'channelId' is distinct from p_channel_id then raise exception 'LINE_WEBHOOK_STALE';end if;
 if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events)>100 then raise exception 'LINE_WEBHOOK_INVALID_EVENT';end if;
 select * into o from platform_private.line_channel_owners where channel_id=p_channel_id for update;
 if o.tenant_id is distinct from b.tenant_id or o.destination is distinct from b.destination then raise exception 'LINE_WEBHOOK_STALE';end if;
 if o.rate_minute=minute and o.rate_count>=120 then raise exception 'LINE_WEBHOOK_RATE_LIMIT';end if;
 for e in select value from jsonb_array_elements(p_events) loop
  if jsonb_typeof(e) is distinct from 'object' or exists(select 1 from jsonb_object_keys(e) k where k not in ('eventId','type','timestamp','redelivery','sourceUserId'))
   or not coalesce(e->>'eventId' ~ '^[A-Za-z0-9_-]{1,128}$',false)
   or e->>'type' is null or e->>'type' not in ('message','follow','unfollow','join','leave','memberJoined','memberLeft','postback','beacon','accountLink','things','unsend','videoPlayComplete','other')
   or jsonb_typeof(e->'timestamp') is distinct from 'number' or not coalesce(e->>'timestamp' ~ '^[0-9]+$',false)
   or (e->>'timestamp')::numeric>8640000000000000 or jsonb_typeof(e->'redelivery') is distinct from 'boolean'
   or (e ? 'sourceUserId' and (e->>'type' not in ('follow','unfollow') or jsonb_typeof(e->'sourceUserId') is distinct from 'string' or not coalesce(e->>'sourceUserId' ~ '^U[0-9a-f]{32}$',false)))
   then raise exception 'LINE_WEBHOOK_INVALID_EVENT';end if;
  insert into platform_private.line_webhook_receipts(channel_id,event_id,event_type,provider_timestamp,redelivery,state)
   values(p_channel_id,e->>'eventId',e->>'type',(e->>'timestamp')::bigint,(e->>'redelivery')::boolean,case when e->>'type'='other' then 'ignored' else 'observed' end)
   on conflict(channel_id,event_id)do nothing;
  get diagnostics n=row_count;accepted:=accepted+n;
  -- Receipt insertion is the terminal dedup fence. Never apply a duplicate,
  -- including a redelivery altered to carry a newer timestamp or other type.
  -- The HMAC-selected audience must itself be the current membership binding;
  -- events authenticated for a different module are receipts only.
  if n=1 and b.feature='membership' and e->>'type' in ('follow','unfollow') and e ? 'sourceUserId' then
   insert into platform_private.member_oa_webhook_state as current_state
    (tenant_id,channel_id,feature,revision,line_user_id,friendship_state,provider_timestamp)
   values(b.tenant_id,b.channel_id,b.feature,b.revision,e->>'sourceUserId',e->>'type',(e->>'timestamp')::bigint)
   on conflict(tenant_id,channel_id,feature,revision,line_user_id) do update
    set friendship_state=excluded.friendship_state,provider_timestamp=excluded.provider_timestamp,observed_at=clock_timestamp()
    where excluded.provider_timestamp>current_state.provider_timestamp
     or (excluded.provider_timestamp=current_state.provider_timestamp and excluded.friendship_state='unfollow' and current_state.friendship_state<>'unfollow');
  end if;
 end loop;
 update platform_private.line_webhook_bindings set last_signature_at=clock_timestamp(),
  last_event_at=case when accepted>0 then clock_timestamp() else last_event_at end where channel_id=p_channel_id and feature=p_feature;
 update platform_private.line_channel_owners set rate_minute=minute,rate_count=case when rate_minute=minute then rate_count+1 else 1 end where channel_id=p_channel_id;
 return jsonb_build_object('accepted',accepted);
end $$;
revoke all on function public.platform_line_webhook_ingest(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.platform_line_webhook_ingest(text,text,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
