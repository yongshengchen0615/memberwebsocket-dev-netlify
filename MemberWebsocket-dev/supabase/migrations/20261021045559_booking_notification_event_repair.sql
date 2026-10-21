begin;
-- Update the immutable template and every existing tenant, keeping its own queue.
create function platform_private.repair_booking_event_sql(def text) returns text
language plpgsql immutable set search_path='' as $repair$
begin
 if position('FUNCTION public.notice_enqueue(' in def)>0 then
  def:=replace(def,'''BOOKING_UPDATED'',''BOOKING_ITEMS_UPDATED''','''BOOKING_UPDATED'',''BOOKING_ITEMS_UPDATED'',''BOOKING_PARTICIPANT_TECHNICIANS_UPDATED''');
  def:=replace(def,$old$mod_actor_role = 'admin' and mod_action = 'BOOKING_ITEMS_UPDATED'$old$, $new$mod_actor_role = 'admin' and mod_action in ('BOOKING_UPDATED','BOOKING_ITEMS_UPDATED','BOOKING_PARTICIPANT_TECHNICIANS_UPDATED')$new$);
 elsif position('FUNCTION public.admin_update_booking_participant_technicians_request(' in def)>0 then
  def:=replace(def,'v_primary_technician_id := public.validate_group_booking_technicians(p_participants);',
   $patch$if v_before = (select jsonb_agg(jsonb_build_object('position',(x->>'position')::integer,'technicianId',coalesce(x->>'technicianId','')) order by (x->>'position')::integer) from jsonb_array_elements(p_participants) x) then return b; end if;
  v_primary_technician_id := public.validate_group_booking_technicians(p_participants);$patch$);
 elsif position('FUNCTION public.admin_update_booking_participant_items_request(' in def)>0 then
  def:=replace(def,'  select sum(bi_store.unit_duration_minutes * bi_store.quantity)::integer',
   $patch$  if (select jsonb_agg(jsonb_build_object('position',bp.position,'items',(select jsonb_agg(jsonb_build_object('serviceId',pi.service_id,'quantity',pi.quantity) order by pi.service_id) from public.booking_participant_items pi where pi.participant_id=bp.id)) order by bp.position) from public.booking_participants bp where bp.booking_id=b.id)
   = (select jsonb_agg(jsonb_build_object('position',(requested_person.person_json->>'position')::integer,'items',(select jsonb_agg(jsonb_build_object('serviceId',(requested_item.item_json->>'serviceId')::uuid,'quantity',(requested_item.item_json->>'quantity')::integer) order by (requested_item.item_json->>'serviceId')::uuid) from jsonb_array_elements(requested_person.person_json->'items') requested_item(item_json))) order by (requested_person.person_json->>'position')::integer) from jsonb_array_elements(p_participants) requested_person(person_json))
  then return b; end if;
  select sum(bi_store.unit_duration_minutes * bi_store.quantity)::integer$patch$);
 end if;
 -- Existing tenants are upgraded from a control-plane search_path. Preserve
 -- the tenant row type explicitly instead of resolving unqualified public types.
 def:=regexp_replace(def,'\mRETURNS bookings\M','RETURNS public.bookings');
 return def;
end $repair$;
revoke all on function platform_private.repair_booking_event_sql(text) from public,anon,authenticated,service_role;
do $install$ declare v_snapshot jsonb;fn jsonb; functions jsonb:='[]';t record;begin
 select b.snapshot into strict v_snapshot from platform_private.business_templates b where version='business-v1-20261019' for update;
 for fn in select value from jsonb_array_elements(v_snapshot->'functions') loop
  if fn->>'name' in ('notice_enqueue','admin_update_booking_participant_technicians_request','admin_update_booking_participant_items_request') then
   fn:=jsonb_set(fn,'{definition}',to_jsonb(platform_private.repair_booking_event_sql(fn->>'definition')));
   for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
    execute platform_private.business_sql(fn->>'definition',t.runtime_schema);
   end loop;
  end if;
  functions:=functions||jsonb_build_array(fn);
 end loop;
 update platform_private.business_templates set snapshot=jsonb_set(v_snapshot,'{functions}',functions) where version='business-v1-20261019';
end $install$;
-- Called after the authenticated booking handler has committed. pg_net sends
-- only after this transaction commits. The existing minute cron remains recovery.
create function public.platform_dispatch_booking(p_tenant_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare t platform_private.tenants;due boolean;project_url text;secret text;
begin
 select * into t from platform_private.tenants where id=p_tenant_id and status='active'
  and runtime_schema is not null and features->>'booking'='true'
  and (expires_at is null or expires_at>clock_timestamp());
 if not found then return false;end if;
 if not (t.credentials_configured or coalesce((t.module_line->'booking'->>'credentialsConfigured')::boolean,false)
  or exists(select 1 from jsonb_each(coalesce(t.module_line->'booking'->'notifications','{}')) n where n.value->>'mode' in ('custom','disabled'))) then return false;end if;
 if not pg_try_advisory_xact_lock(hashtextextended(t.id::text||':booking-dispatch',0)) then return false;end if;
 execute format('select exists(select 1 from %I.notice_outbox where status in (''pending'',''sending'') and next_attempt_at<=now())',t.runtime_schema) into due;
 if not due then return false;end if;
 select decrypted_secret into project_url from vault.decrypted_secrets where name='project_url' order by updated_at desc limit 1;
 select decrypted_secret into secret from vault.decrypted_secrets where name='BOOKING_NOTIFICATION_DISPATCH_SECRET' order by updated_at desc limit 1;
 if nullif(project_url,'') is null or nullif(secret,'') is null then return false;end if;
 perform net.http_post(url:=rtrim(project_url,'/')||'/functions/v1/booking-line-notifications',headers:=jsonb_build_object('Content-Type','application/json','x-dispatch-secret',secret),body:=jsonb_build_object('business',t.slug),timeout_milliseconds:=10000);
 return true;
end $$;
revoke all on function public.platform_dispatch_booking(uuid) from public,anon,authenticated;
grant execute on function public.platform_dispatch_booking(uuid) to service_role;
notify pgrst,'reload schema';
commit;
