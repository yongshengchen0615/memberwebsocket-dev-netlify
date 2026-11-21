-- AC-FR-DURATION-004: newly provisioned tenant schemas must inherit the same
-- narrow duration-only bundle rule, without a cross-schema function dependency.
-- The legacy business template version is deliberately selected by the existing
-- provisioner; update only the named function definition, never user data.
do $patch$
declare
 t record;
 d text;
 v_old text;
 v_new text;
 v_template_def text;
 v_snapshot jsonb;
 v_existing text;
 v_entries jsonb;
 v_count integer;
begin
 for t in select runtime_schema from platform_private.tenants loop
  if t.runtime_schema !~ '^business_[0-9a-f]{32}$' then
   raise exception 'FRONTDESK_BUNDLE_BAD_SCHEMA';
  end if;
  select pg_get_functiondef((format('%I.assert_booking_item_bundle()',t.runtime_schema))::regprocedure)
   into strict d;
  if position('FRONTDESK_DIRECT_DURATION_VERIFIED' in d)=0 then
   raise exception 'FRONTDESK_BUNDLE_PREDECESSOR_MISSING';
  end if;
  v_old:=format('platform_private.frontdesk_paired_phone_source(%L,to_jsonb(b)) is not null',t.runtime_schema);
  v_new:=format($verified$
  exists(
    select 1 from %1$I.bookings original
    where original.id=substring(coalesce(b.admin_note,'')
      from '^原預約 ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) 拒絕後的現場／電話預約$')::uuid
      and original.id<>b.id
      and original.status='rejected' and original.rejection_reason='unrecorded_phone_booking'
      and original.rejected_by ~ '^U[0-9a-f]{32}$'
      and original.booking_date=b.booking_date
      and original.rejected_at is not null
      and exists(
        select 1 from %1$I.booking_audit_events phone_audit
        join %1$I.booking_audit_events reject_audit
         on reject_audit.created_at=phone_audit.created_at
        and reject_audit.actor_line_user_id=phone_audit.actor_line_user_id
        where phone_audit.target_type='booking'
          and phone_audit.target_id=b.id::text
          and phone_audit.action='BOOKING_PHONE_CREATED'
          and phone_audit.actor_role='frontdesk'
          and phone_audit.actor_line_user_id=original.rejected_by
          and reject_audit.target_type='booking'
          and reject_audit.target_id=original.id::text
          and reject_audit.action='BOOKING_REJECTED'
          and reject_audit.actor_role='frontdesk'
      )
  )$verified$,t.runtime_schema);
  if position(v_old in d)>0 then
   d:=replace(d,v_old,v_new);
   execute d;
  elsif position('platform_private.frontdesk_paired_phone_source' in d)>0 then
   raise exception 'FRONTDESK_BUNDLE_UNKNOWN_SOURCE_CALL';
  end if;
  if position('FRONTDESK_DIRECT_DURATION_VERIFIED' in d)=0
    or position('platform_private.frontdesk_paired_phone_source' in d)>0 then
    raise exception 'FRONTDESK_BUNDLE_SOURCE_UNVERIFIED';
  end if;
  if v_template_def is null then
   v_template_def:=replace(d,t.runtime_schema,'public');
  end if;
 end loop;

 -- All existing tenants were patched above. Use one audited function body as
 -- the source of truth for future tenant provisioning by business_sql().
 if v_template_def is null then
  raise exception 'FRONTDESK_BUNDLE_TEMPLATE_SOURCE_MISSING';
 end if;
 if position('platform_private.' in v_template_def)>0
   or position('FRONTDESK_DIRECT_DURATION_VERIFIED' in v_template_def)=0 then
  raise exception 'FRONTDESK_BUNDLE_TEMPLATE_UNSCOPED';
 end if;
 select snapshot into strict v_snapshot
 from platform_private.business_templates
 where version='business-v1-20261019' for update;
 select count(*)::integer,max(x->>'definition')
 into v_count,v_existing
 from jsonb_array_elements(v_snapshot->'functions') x
 where x->>'name'='assert_booking_item_bundle';
 if v_count<>1 then raise exception 'FRONTDESK_BUNDLE_TEMPLATE_NOT_UNIQUE';end if;
 if position('FRONTDESK_DIRECT_DURATION_VERIFIED' in v_existing)>0 then
   if position('platform_private.' in v_existing)>0 then
     raise exception 'FRONTDESK_BUNDLE_TEMPLATE_INVALID';
   end if;
   return;
 end if;
 if position('v_store_count <> 1 or v_visible_count < 1 or v_invalid_store_count <> 0' in v_existing)=0 then
   raise exception 'FRONTDESK_BUNDLE_TEMPLATE_CONTRACT_CHANGED';
 end if;
 select jsonb_agg(
   case when x->>'name'='assert_booking_item_bundle'
     then jsonb_set(x,'{definition}',to_jsonb(v_template_def))
     else x end order by ord)
 into v_entries
 from jsonb_array_elements(v_snapshot->'functions') with ordinality as a(x,ord);
 update platform_private.business_templates
 set snapshot=jsonb_set(v_snapshot,'{functions}',v_entries)
 where version='business-v1-20261019';
end $patch$;
