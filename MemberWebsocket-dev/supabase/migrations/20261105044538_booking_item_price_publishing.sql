-- Per-item effective prices. Existing callers remain on base prices until
-- the isolated -preview Edge sets a trusted PostgREST price context.
-- Caller body flags cannot select or disable the price context.
create or replace function platform_private.install_booking_item_prices(p_schema text)
returns void language plpgsql security definer set search_path='' as $installer$
declare cols text; f record; definition text;
begin
 if p_schema <> 'public' and (p_schema !~ '^business_[a-f0-9]{32}$'
   or not exists(select 1 from platform_private.tenants where runtime_schema=p_schema)) then
  raise exception 'BUSINESS_SCHEMA_INVALID';
 end if;
 if to_regclass(format('%I.booking_services',p_schema)) is null then raise exception 'BOOKING_PRICE_SCHEMA_MISSING';end if;
 execute format($ddl$
  alter table %1$I.booking_services add column if not exists price_base_version uuid not null default gen_random_uuid();
  alter table %1$I.booking_services add column if not exists price_base_at timestamptz not null default '-infinity';
  create table if not exists %1$I.booking_service_price_publications(
   id uuid primary key default gen_random_uuid(),
   service_id uuid not null references %1$I.booking_services(id) on delete cascade,
   price_amount integer not null check(price_amount between 0 and 10000000),
   publish_at timestamptz not null check(isfinite(publish_at)),
   publish_mode text not null check(publish_mode in ('immediate','scheduled')),
   request_id text not null unique check(length(request_id) between 1 and 100),
   actor_line_user_id text not null,
   created_at timestamptz not null default clock_timestamp(),
   updated_at timestamptz not null default clock_timestamp(),
   cancelled_at timestamptz,
   cancel_request_id text unique,
   cancelled_by text,
   cancellation_reason text
  );
  create unique index if not exists booking_price_live_time_idx on %1$I.booking_service_price_publications(service_id,publish_at) where cancelled_at is null;
  alter table %1$I.booking_service_price_publications enable row level security;
  revoke all on %1$I.booking_service_price_publications from public,anon,authenticated;
  grant select,insert,update on %1$I.booking_service_price_publications to service_role;

  create or replace function %1$I.booking_price_context_time() returns timestamptz
  language plpgsql volatile security invoker set search_path='' as $body$
  declare v text; at_time timestamptz;
  begin
   if current_setting('transaction_read_only')<>'on' then
    perform pg_advisory_xact_lock(hashtextextended('booking-prices:%1$I',0));
   end if;
   v:=nullif(current_setting('booking_prices.%1$I',true),'');
   if v is not null then return v::timestamptz;end if;
   -- A transaction-local SQL clock is useful to isolated DB tests. The API
   -- has no setter or input for this setting.
   at_time:=coalesce(nullif(current_setting('app.booking_price_at',true),'')::timestamptz,clock_timestamp());
   perform set_config('booking_prices.%1$I',at_time::text,true);
   return at_time;
  end $body$;

  create or replace function %1$I.booking_price_resolve(p_service_id uuid) returns jsonb
  language plpgsql volatile security invoker set search_path='' as $body$
  declare svc %1$I.booking_services; price %1$I.booking_service_price_publications; t timestamptz; upcoming timestamptz;
  begin
   t:=%1$I.booking_price_context_time();
   select * into svc from %1$I.booking_services where id=p_service_id;
   if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND';end if;
   select * into price from %1$I.booking_service_price_publications
    where service_id=p_service_id and cancelled_at is null and publish_at<=t and publish_at>=svc.price_base_at
    order by publish_at desc,id desc limit 1;
   select min(publish_at) into upcoming from %1$I.booking_service_price_publications
    where service_id=p_service_id and cancelled_at is null and publish_at>t;
   return jsonb_build_object('priceAmount',coalesce(price.price_amount,svc.price_amount),
    'priceVersion',coalesce(price.id,svc.price_base_version)::text,'nextPriceAt',upcoming);
  end $body$;

  create or replace function %1$I.booking_price_require_admin(p_actor text,p_at timestamptz default null) returns void
  language plpgsql security invoker set search_path='' as $body$
  declare t platform_private.tenants; q jsonb;
  begin
   perform 1 from %1$I.admins a where line_user_id=p_actor and status='active' and coalesce(to_jsonb(a)->>'role','admin')='admin' for share;
   if not found then raise exception 'ADMIN_REQUIRED';end if;
   if '%1$I'<>'public' then
    select * into t from platform_private.tenants where runtime_schema='%1$I' and owner_line_user_id=p_actor for share;
    if not found or t.status<>'active' or coalesce(t.features->>'booking','false')<>'true'
     or t.expires_at<=clock_timestamp() or (p_at is not null and p_at>=t.expires_at) then raise exception 'ADMIN_REQUIRED';end if;
    if to_regclass('platform_private.admin_qualifications') is not null then
     select to_jsonb(a) into q from platform_private.admin_qualifications a where applicant_line_user_id=p_actor for share;
     if q is null or q->>'status'<>'approved' then raise exception 'ADMIN_REQUIRED';end if;
    end if;
   end if;
  end $body$;

  create or replace function %1$I.booking_price_event_client(p %1$I.booking_service_price_publications) returns jsonb
  language sql stable security invoker set search_path='' as $body$
   select jsonb_build_object('id',p.id,'serviceId',p.service_id,'priceAmount',p.price_amount,
    'publishAt',p.publish_at,'mode',p.publish_mode,'updatedAt',p.updated_at,'createdAt',p.created_at,
    'status',case when p.cancelled_at is not null then 'cancelled' when p.publish_at<=statement_timestamp() then 'published' else 'scheduled' end,
    'actor',p.actor_line_user_id,'cancellationReason',p.cancellation_reason)
  $body$;

  create or replace function %1$I.booking_price_publish(p_service_id uuid,p_price integer,p_publish_at timestamptz,p_request_id text,p_actor text,p_expected_version text)
  returns jsonb language plpgsql security invoker set search_path='' as $body$
  declare old %1$I.booking_service_price_publications; result %1$I.booking_service_price_publications; now_at timestamptz; mode text;
  begin
   if p_service_id='00000000-0000-4000-8000-000000000010'::uuid then raise exception 'BOOKING_SYSTEM_SERVICE_IMMUTABLE';end if;
   if p_price is null or p_price<0 or p_price>10000000 then raise exception 'INVALID_SERVICE_PRICE';end if;
   if p_request_id is null or length(p_request_id) not between 1 and 100 then raise exception 'INVALID_PRICE_REQUEST';end if;
   now_at:=%1$I.booking_price_context_time();
   perform %1$I.booking_price_require_admin(p_actor,p_publish_at);
   mode:=case when p_publish_at is null then 'immediate' else 'scheduled' end;
   select * into old from %1$I.booking_service_price_publications where request_id=p_request_id;
   if found then
    if old.service_id<>p_service_id or old.price_amount<>p_price or old.publish_mode<>mode
     or old.actor_line_user_id<>p_actor or (mode='scheduled' and old.publish_at is distinct from p_publish_at) then
     raise exception 'BOOKING_PRICE_REQUEST_CONFLICT';end if;
    return %1$I.booking_price_event_client(old);
   end if;
   if p_publish_at is not null and (not isfinite(p_publish_at) or p_publish_at<=clock_timestamp()
    or date_trunc('minute',p_publish_at)<>p_publish_at) then raise exception 'INVALID_PRICE_PUBLISH_TIME';end if;
   perform 1 from %1$I.booking_services where id=p_service_id and deleted_at is null;
   if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND';end if;
   if p_expected_version is null or (%1$I.booking_price_resolve(p_service_id)->>'priceVersion')<>p_expected_version then raise exception 'BOOKING_PRICE_CHANGED';end if;
   if exists(select 1 from %1$I.booking_service_price_publications where service_id=p_service_id and publish_at=p_publish_at and cancelled_at is null) then
    raise exception 'BOOKING_PRICE_TIME_CONFLICT';end if;
   insert into %1$I.booking_service_price_publications(service_id,price_amount,publish_at,publish_mode,request_id,actor_line_user_id)
    values(p_service_id,p_price,coalesce(p_publish_at,now_at),mode,p_request_id,p_actor) returning * into result;
   insert into %1$I.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
    values(p_actor,'admin','BOOKING_PRICE_PUBLISHED','booking_service',p_service_id::text,'success',
     jsonb_build_object('publicationId',result.id,'priceAmount',p_price,'publishAt',result.publish_at,'mode',mode));
   return %1$I.booking_price_event_client(result);
  end $body$;

  create or replace function %1$I.booking_price_cancel(p_id uuid,p_expected_updated_at timestamptz,p_actor text,p_request_id text)
  returns jsonb language plpgsql security invoker set search_path='' as $body$
  declare p %1$I.booking_service_price_publications;
  begin
   perform %1$I.booking_price_context_time();
   perform %1$I.booking_price_require_admin(p_actor);
   select * into p from %1$I.booking_service_price_publications where id=p_id for update;
   if not found then raise exception 'BOOKING_PRICE_NOT_FOUND';end if;
   if p.cancel_request_id=p_request_id and p.cancelled_by=p_actor then return %1$I.booking_price_event_client(p);end if;
   if p.cancelled_at is not null or p.updated_at is distinct from p_expected_updated_at then raise exception 'BOOKING_PRICE_CONFLICT';end if;
   if p.publish_at<=clock_timestamp() then raise exception 'BOOKING_PRICE_ALREADY_EFFECTIVE';end if;
   if p_request_id is null or length(p_request_id) not between 1 and 100 then raise exception 'INVALID_PRICE_REQUEST';end if;
   update %1$I.booking_service_price_publications set cancelled_at=clock_timestamp(),updated_at=clock_timestamp(),cancelled_by=p_actor,
    cancel_request_id=p_request_id,cancellation_reason='admin_cancelled' where id=p_id returning * into p;
   insert into %1$I.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
    values(p_actor,'admin','BOOKING_PRICE_CANCELLED','booking_service',p.service_id::text,'success',jsonb_build_object('publicationId',p.id));
   return %1$I.booking_price_event_client(p);
  end $body$;

  create or replace function %1$I.booking_price_reschedule(p_id uuid,p_expected_updated_at timestamptz,p_price integer,p_publish_at timestamptz,p_request_id text,p_actor text,p_expected_version text)
  returns jsonb language plpgsql security invoker set search_path='' as $body$
  declare p %1$I.booking_service_price_publications; replay %1$I.booking_service_price_publications;
  begin
   perform %1$I.booking_price_context_time();
   perform %1$I.booking_price_require_admin(p_actor,p_publish_at);
   select * into p from %1$I.booking_service_price_publications where id=p_id for update;
   if not found then raise exception 'BOOKING_PRICE_NOT_FOUND';end if;
   select * into replay from %1$I.booking_service_price_publications where request_id=p_request_id;
   if found then
    if p.cancel_request_id is distinct from p_request_id||':cancel' or p.cancelled_by is distinct from p_actor then raise exception 'BOOKING_PRICE_REQUEST_CONFLICT';end if;
    return %1$I.booking_price_publish(p.service_id,p_price,p_publish_at,p_request_id,p_actor,p_expected_version);
   end if;
   if p_publish_at is null then raise exception 'INVALID_PRICE_PUBLISH_TIME';end if;
   perform %1$I.booking_price_cancel(p_id,p_expected_updated_at,p_actor,p_request_id||':cancel');
   return %1$I.booking_price_publish(p.service_id,p_price,p_publish_at,p_request_id,p_actor,p_expected_version);
  end $body$;

  create or replace function %1$I.booking_price_catalog(p_service_id uuid default null) returns jsonb
  language sql stable security invoker set search_path='' as $body$
   select coalesce(jsonb_agg(%1$I.booking_price_event_client(p) order by p.publish_at desc,p.created_at desc),'[]'::jsonb)
   from (select * from %1$I.booking_service_price_publications where p_service_id is null or service_id=p_service_id
    order by publish_at desc,created_at desc limit 200) p
  $body$;

  create or replace function %1$I.booking_price_before_statement() returns trigger
  language plpgsql security invoker set search_path='' as $body$
  begin perform pg_advisory_xact_lock(hashtextextended('booking-prices:%1$I',0));return null;end $body$;
  drop trigger if exists booking_prices_lock on %1$I.booking_services;
  create trigger booking_prices_lock before update or delete on %1$I.booking_services for each statement execute function %1$I.booking_price_before_statement();

  drop trigger if exists booking_prices_admin_lock on %1$I.admins;
  create trigger booking_prices_admin_lock before update or delete on %1$I.admins for each statement execute function %1$I.booking_price_before_statement();
  create or replace function %1$I.booking_price_admin_revoke() returns trigger
  language plpgsql security invoker set search_path='' as $body$
  begin
   if tg_op='DELETE' or new.status is distinct from 'active' or coalesce(to_jsonb(new)->>'role','admin')<>'admin' or new.line_user_id is distinct from old.line_user_id then
    update %1$I.booking_service_price_publications set cancelled_at=clock_timestamp(),updated_at=clock_timestamp(),cancelled_by='system',cancellation_reason='authority_revoked'
     where actor_line_user_id=old.line_user_id and cancelled_at is null and publish_at>clock_timestamp();
   end if;
   return coalesce(new,old);
  end $body$;
  drop trigger if exists booking_prices_admin_revoke on %1$I.admins;
  create trigger booking_prices_admin_revoke after update or delete on %1$I.admins for each row execute function %1$I.booking_price_admin_revoke();

  create or replace function %1$I.booking_price_check_quote(p_service_id uuid,p_actual jsonb) returns void
  language plpgsql security invoker set search_path='' as $body$
  declare h jsonb; quote jsonb; expected jsonb;
  begin
   h:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}'::jsonb);
   if h->>'x-booking-price-preview' is distinct from '1' or h->>'x-booking-price-check' is distinct from '1' then return;end if;
   begin
    quote:=coalesce(nullif(h->>'x-booking-price-quote','')::jsonb,'[]'::jsonb);
    if jsonb_typeof(quote)<>'array' then raise exception 'BOOKING_PRICE_CHANGED';end if;
    select value into expected from jsonb_array_elements(quote) where value->>'serviceId'=p_service_id::text;
    if expected is null or expected->>'priceVersion' is distinct from p_actual->>'priceVersion'
     or (expected->>'priceAmount')::integer is distinct from (p_actual->>'priceAmount')::integer then raise exception 'BOOKING_PRICE_CHANGED';end if;
   exception when invalid_text_representation then raise exception 'BOOKING_PRICE_CHANGED';end;
  end $body$;

  create or replace function %1$I.booking_price_base_change() returns trigger
  language plpgsql security invoker set search_path='' as $body$
  begin
   if new.id='00000000-0000-4000-8000-000000000010'::uuid then return new;end if;
   if coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'x-booking-price-preview','0')='1' then
    perform %1$I.booking_price_check_quote(old.id,%1$I.booking_price_resolve(old.id));
    if new.deleted_at is not distinct from old.deleted_at and new.price_amount is distinct from (%1$I.booking_price_resolve(old.id)->>'priceAmount')::integer then
     raise exception 'BOOKING_PRICE_USE_PUBLISHING';
    end if;
    -- Preview metadata edits must never promote a preview price to main.
    new.price_amount:=old.price_amount;
   elsif new.price_amount is distinct from old.price_amount then
    new.price_base_at:=clock_timestamp();new.price_base_version:=gen_random_uuid();
   end if;
   if old.deleted_at is null and new.deleted_at is not null then
    update %1$I.booking_service_price_publications set cancelled_at=clock_timestamp(),updated_at=clock_timestamp(),
     cancelled_by='system',cancellation_reason='service_deleted'
     where service_id=old.id and cancelled_at is null and publish_at>clock_timestamp();
   end if;
   return new;
  end $body$;
  drop trigger if exists booking_prices_base on %1$I.booking_services;
  create trigger booking_prices_base before update on %1$I.booking_services for each row execute function %1$I.booking_price_base_change();

  create or replace function %1$I.booking_price_snapshot_guard() returns trigger
  language plpgsql security invoker set search_path='' as $body$
  declare h jsonb; actual jsonb; expected jsonb; quote jsonb;
  begin
   h:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}'::jsonb);
   if new.service_id='00000000-0000-4000-8000-000000000010'::uuid then return new;end if;
   if h->>'x-booking-price-preview' is distinct from '1' or h->>'x-booking-price-check' is distinct from '1' then return new;end if;
   actual:=%1$I.booking_price_resolve(new.service_id);
   perform %1$I.booking_price_check_quote(new.service_id,actual);
   new.unit_price_amount:=(actual->>'priceAmount')::integer;
   return new;
  end $body$;
  drop trigger if exists zz_booking_price_publication_snapshot on %1$I.booking_items;
  create trigger zz_booking_price_publication_snapshot before insert or update of service_id,unit_price_amount on %1$I.booking_items
   for each row execute function %1$I.booking_price_snapshot_guard();
  drop trigger if exists zz_booking_price_publication_snapshot on %1$I.booking_participant_items;
  create trigger zz_booking_price_publication_snapshot before insert or update of service_id,unit_price_amount on %1$I.booking_participant_items
   for each row execute function %1$I.booking_price_snapshot_guard();
 $ddl$,p_schema);
 if to_regprocedure(format('%I.notify_booking_realtime_change()',p_schema)) is not null then
  execute format('drop trigger if exists realtime_booking_service_prices_change on %I.booking_service_price_publications',p_schema);
  execute format('create trigger realtime_booking_service_prices_change after insert or update or delete on %I.booking_service_price_publications for each statement execute function %I.notify_booking_realtime_change()',p_schema,p_schema);
 end if;
 select string_agg(case when attname='price_amount' then '(p.price->>''priceAmount'')::integer as price_amount' else 'bs.'||quote_ident(attname) end,',' order by attnum)
 into cols from pg_attribute where attrelid=to_regclass(format('%I.booking_services',p_schema)) and attnum>0 and not attisdropped;
 execute format('create or replace view %1$I.booking_services_priced with(security_invoker=true) as select %2$s,p.price->>''priceVersion'' as price_version,p.price->>''nextPriceAt'' as next_price_at from %1$I.booking_services bs cross join lateral(select %1$I.booking_price_resolve(bs.id) price offset 0)p',p_schema,cols);
 execute format('revoke all on %I.booking_services_priced from public,anon,authenticated;grant select on %I.booking_services_priced to service_role',p_schema,p_schema);
 -- Acquire the same price lock before any canonical volatile runtime RPC
 -- takes member, receipt, booking or service locks (including nested wrappers). Appending a snapshot trigger alone would invert the lock order
 -- against ordinary service edits. Preserve each canonical function body,
 -- signature, authorization and grants; install the one entry guard once.
 for f in
  with recursive funcs as (
   select p.oid,p.proname,p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    join pg_language l on l.oid=p.prolang
    where n.nspname=p_schema and l.lanname='plpgsql' and p.provolatile='v'
     and p.prorettype<>'trigger'::regtype and p.proname not like 'booking_price_%'
  ), affected as (
   select * from funcs where prosrc ilike '%booking_services%' or prosrc ilike '%booking_items%' or prosrc ilike '%booking_participant_items%'
   union
   select caller.* from funcs caller join affected callee on caller.prosrc ~ ('\m'||callee.proname||'\M')
  ) select distinct oid from affected
 loop
  definition:=pg_get_functiondef(f.oid);
  if position(format('%I.booking_price_context_time()',p_schema) in definition)=0 then
   definition:=regexp_replace(definition,'\mBEGIN\M',format(E'BEGIN\n  PERFORM %I.booking_price_context_time();',p_schema),'i');
   execute definition;
  end if;
 end loop;
 for f in select p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname=p_schema and p.proname like 'booking_price_%'
 loop
  execute format('revoke all on function %I.%I(%s) from public,anon,authenticated',p_schema,f.proname,f.args);
  execute format('grant execute on function %I.%I(%s) to service_role',p_schema,f.proname,f.args);
 end loop;
end $installer$;
revoke all on function platform_private.install_booking_item_prices(text) from public,anon,authenticated;
grant execute on function platform_private.install_booking_item_prices(text) to service_role;

select platform_private.install_booking_item_prices('public');
do $upgrade$ declare t record;begin
 for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
  perform platform_private.install_booking_item_prices(t.runtime_schema);
 end loop;
end $upgrade$;

-- Preserve every existing provisioning step, then install into new merchants.
do $wrap$ begin
 if to_regprocedure('public.platform_provision_business_before_prices(uuid)') is null then
  alter function public.platform_provision_business(uuid) rename to platform_provision_business_before_prices;
 end if;
end $wrap$;
create or replace function public.platform_provision_business(p_tenant_id uuid) returns void
language plpgsql security definer set search_path='' as $provision$
declare s text;begin
 perform public.platform_provision_business_before_prices(p_tenant_id);
 select runtime_schema into strict s from platform_private.tenants where id=p_tenant_id;
 perform platform_private.install_booking_item_prices(s);
end $provision$;
revoke all on function public.platform_provision_business(uuid),public.platform_provision_business_before_prices(uuid) from public,anon,authenticated;
grant execute on function public.platform_provision_business(uuid),public.platform_provision_business_before_prices(uuid) to service_role;

-- Revocation cancels only future events; an already effective price never
-- rolls back merely because the operator later loses access.
create or replace function platform_private.cancel_future_booking_prices() returns trigger
language plpgsql security definer set search_path='' as $revoke$
declare t record; o jsonb:=to_jsonb(old);n jsonb:=to_jsonb(new); cancel_all boolean; cutoff timestamptz;
begin
 if tg_op='DELETE' then n:=o;end if;
 if tg_table_name='admin_qualifications' then
  cancel_all:=(n->>'status' is distinct from 'approved') or (n->>'access_revoked_before')::timestamptz>coalesce((o->>'access_revoked_before')::timestamptz,'-infinity');
 else
  cancel_all:=n->>'status' is distinct from 'active' or n->>'owner_line_user_id' is distinct from o->>'owner_line_user_id'
   or coalesce(n->'features'->>'booking','false')<>'true'
   or (n->>'access_revoked_before')::timestamptz>coalesce((o->>'access_revoked_before')::timestamptz,'-infinity');
  cutoff:=(n->>'expires_at')::timestamptz;
 end if;
 if tg_op='DELETE' then cancel_all:=true;end if;
 if not coalesce(cancel_all,false) and cutoff is null then return new;end if;
 for t in select runtime_schema from platform_private.tenants where runtime_schema is not null
  and ((tg_table_name='admin_qualifications' and owner_line_user_id=n->>'applicant_line_user_id')
   or (tg_table_name='tenants' and id=(n->>'id')::uuid))
 loop
  if to_regclass(format('%I.booking_service_price_publications',t.runtime_schema)) is null then continue;end if;
  perform pg_advisory_xact_lock(hashtextextended('booking-prices:'||t.runtime_schema,0));
  execute format('update %I.booking_service_price_publications set cancelled_at=clock_timestamp(),updated_at=clock_timestamp(),cancelled_by=''system'',cancellation_reason=''authority_revoked'' where cancelled_at is null and publish_at>clock_timestamp() and ($1 or publish_at>=$2)',t.runtime_schema)
   using coalesce(cancel_all,false),cutoff;
 end loop;
 return new;
end $revoke$;
revoke all on function platform_private.cancel_future_booking_prices() from public,anon,authenticated,service_role;
create or replace function platform_private.booking_price_authority_lock() returns void
language plpgsql security definer set search_path='' as $locks$
declare s text;begin
 for s in select schema_name from (select 'public'::text schema_name,0 priority union select runtime_schema,1 from platform_private.tenants where runtime_schema is not null) schemas order by priority,schema_name loop
  perform pg_advisory_xact_lock(hashtextextended('booking-prices:'||s,0));
 end loop;
end $locks$;
revoke all on function platform_private.booking_price_authority_lock() from public,anon,authenticated;
grant execute on function platform_private.booking_price_authority_lock() to service_role;
create or replace function platform_private.booking_price_authority_before_statement() returns trigger
language plpgsql security definer set search_path='' as $statement$
begin perform platform_private.booking_price_authority_lock();return null;end $statement$;
revoke all on function platform_private.booking_price_authority_before_statement() from public,anon,authenticated;
grant execute on function platform_private.booking_price_authority_before_statement() to service_role;
drop trigger if exists booking_prices_authority_lock on platform_private.tenants;
create trigger booking_prices_authority_lock before update or delete on platform_private.tenants for each statement execute function platform_private.booking_price_authority_before_statement();
drop trigger if exists cancel_future_booking_prices on platform_private.tenants;
create trigger cancel_future_booking_prices after update or delete on platform_private.tenants for each row execute function platform_private.cancel_future_booking_prices();
do $qual$ begin
 if to_regclass('platform_private.admin_qualifications') is not null then
  drop trigger if exists booking_prices_authority_lock on platform_private.admin_qualifications;
  create trigger booking_prices_authority_lock before update or delete on platform_private.admin_qualifications for each statement execute function platform_private.booking_price_authority_before_statement();
  drop trigger if exists cancel_future_booking_prices on platform_private.admin_qualifications;
  create trigger cancel_future_booking_prices after update or delete on platform_private.admin_qualifications for each row execute function platform_private.cancel_future_booking_prices();
 end if;
end $qual$;

-- PostgREST authorization must take the price lock BEFORE the qualification
-- and tenant SHARE locks. A statement trigger is too late for pre-request.
do $pre_request$
declare definition text;begin
 if to_regprocedure('platform_private.require_runtime_admin_request(jsonb)') is not null then
  definition:=pg_get_functiondef('platform_private.require_runtime_admin_request(jsonb)'::regprocedure);
  if position('booking-prices:' in definition)=0 then
   definition:=regexp_replace(definition,'\mif readonly then\M',E'if not readonly then perform pg_advisory_xact_lock(hashtextextended(''booking-prices:''||profile,0));end if;\n if readonly then','i');
   execute definition;
  end if;
 end if;
end $pre_request$;
-- Platform management RPCs can explicitly lock authority rows before UPDATE.
-- Acquire the global (public then sorted tenant) lock order at entry, including
-- wrappers, preserving original signatures, authorization, grants and bodies.
do $control_guards$
declare f record;definition text;begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  join pg_language l on l.oid=p.prolang where n.nspname='public' and l.lanname='plpgsql'
   and p.provolatile='v' and p.prorettype<>'trigger'::regtype and p.proname like 'platform_%'
   and p.proname<>'platform_business_pre_request'
 loop
  definition:=pg_get_functiondef(f.oid);
  if position('platform_private.booking_price_authority_lock()' in definition)=0 then
   definition:=regexp_replace(definition,'\mBEGIN\M',E'BEGIN\n PERFORM platform_private.booking_price_authority_lock();','i');
   execute definition;
  end if;
 end loop;
end $control_guards$;
notify pgrst,'reload schema';
