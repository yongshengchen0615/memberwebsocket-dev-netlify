-- AC-ADMIN-WALKIN-BUNDLE-001..004
-- A duration-only on-site replacement stores a synthetic booking-item snapshot.
-- The existing assert_booking_item_bundle() exception previously recognized only
-- the frontdesk label, even after the admin-admin audit pair was supported.
-- As a result a legitimate admin-created replacement was rejected as
-- INVALID_BOOKING_ITEMS. Keep the normal service-item minimum for all other rows.
--
-- Each permitted provenance tuple is exact:
--   frontdesk audit + "櫃檯人員"  OR  admin audit + "管理端".
-- A paired BOOKING_REJECTED audit, identical actor/timestamp and linked original
-- with the proper rejected reason are still required by the original function.
-- Apply to existing merchant functions and the new-merchant provisioning template.
-- This migration intentionally does not mutate bookings, users, or role grants.

do $provenance$
declare
 tenant record;
 source text;
 original_snapshot jsonb;
 entries jsonb;
 prior_surname constant text := 'b.contact_source=''custom'' and b.contact_surname=''櫃檯人員''';
 new_surname constant text := 'b.contact_source=''custom'' and b.contact_surname in (''櫃檯人員'',''管理端'')';
 prior_audit constant text := 'phone_audit.actor_role in (''frontdesk'',''admin'')';
 new_audit constant text := '((phone_audit.actor_role=''frontdesk'' and b.contact_surname=''櫃檯人員'') or (phone_audit.actor_role=''admin'' and b.contact_surname=''管理端''))';
 occurrence_surname integer;
 occurrence_audit integer;
 template_definition text;
begin
 for tenant in select runtime_schema from platform_private.tenants loop
  if tenant.runtime_schema !~ '^business_[0-9a-f]{32}$'
  then raise exception 'ADMIN_WALKIN_BUNDLE_SCHEMA_INVALID';end if;
  select pg_get_functiondef(
   (format('%I.assert_booking_item_bundle()',tenant.runtime_schema))::regprocedure
  ) into strict source;
  occurrence_surname := (length(source)-length(replace(source,prior_surname,'')))/length(prior_surname);
  occurrence_audit := (length(source)-length(replace(source,prior_audit,'')))/length(prior_audit);
  if occurrence_surname<1 or occurrence_surname<>occurrence_audit
   or strpos(source,'reject_audit.actor_role=phone_audit.actor_role')=0
   or strpos(source,'raise exception ''INVALID_BOOKING_ITEMS''')=0
  then raise exception 'ADMIN_WALKIN_BUNDLE_CONTRACT_CHANGED: %',tenant.runtime_schema;end if;
  execute replace(replace(source,prior_surname,new_surname),prior_audit,new_audit);
 end loop;

 select snapshot into strict original_snapshot
 from platform_private.business_templates
 where version='business-v1-20261019'
 for update;
 select x->>'definition' into strict template_definition
 from jsonb_array_elements(original_snapshot->'functions') x
 where x->>'name'='assert_booking_item_bundle';

 occurrence_surname:=(length(template_definition)-length(replace(template_definition,prior_surname,'')))/length(prior_surname);
 occurrence_audit:=(length(template_definition)-length(replace(template_definition,prior_audit,'')))/length(prior_audit);
 if occurrence_surname<1 or occurrence_surname<>occurrence_audit
  or strpos(template_definition,'reject_audit.actor_role=phone_audit.actor_role')=0
  or strpos(template_definition,'raise exception ''INVALID_BOOKING_ITEMS''')=0
 then raise exception 'ADMIN_WALKIN_TEMPLATE_CONTRACT_CHANGED';end if;
 select jsonb_agg(
  case when entry->>'name'='assert_booking_item_bundle'
   then jsonb_set(entry,'{definition}',
     to_jsonb(replace(replace(entry->>'definition',prior_surname,new_surname),prior_audit,new_audit)))
   else entry end order by ord
 ) into entries
 from jsonb_array_elements(original_snapshot->'functions') with ordinality as rows(entry,ord);
 update platform_private.business_templates
 set snapshot=jsonb_set(original_snapshot,'{functions}',entries)
 where version='business-v1-20261019';
end $provenance$;
