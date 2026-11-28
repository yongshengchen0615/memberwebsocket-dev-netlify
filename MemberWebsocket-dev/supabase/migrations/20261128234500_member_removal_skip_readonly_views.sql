-- AC-001/002: finish_member_removal must not UPDATE read-only views.
-- PostgreSQL information_schema.columns includes views (for example
-- booking_services_priced); trying to anonymize their created_by fails with
-- SQLSTATE 55000 after begin_member_removal has already disabled the account.
-- Preserve the removal barrier and retry semantics. Only base/partitioned
-- tables can receive the dynamic actor-column UPDATE. Public, installed tenant
-- schemas, and the next merchant provisioning template must stay in sync.
DO $member_removal_writable_relations$
DECLARE
  v_schema text;
  v_original text;
  v_old constant text := $old$
from information_schema.columns where table_schema=current_schema() and data_type='text' and column_name in ($old$;
  v_new constant text := $new$
from information_schema.columns c
 join pg_namespace n on n.nspname=c.table_schema
 join pg_class rel on rel.relnamespace=n.oid and rel.relname=c.table_name
 where c.table_schema=current_schema() and rel.relkind in ('r','p')
   and c.data_type='text' and c.column_name in ($new$;
  v_count integer;
BEGIN
  FOR v_schema IN
    SELECT nspname FROM pg_namespace
     WHERE nspname='public' OR nspname ~ '^business_[0-9a-f]{32}$'
     ORDER BY nspname
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_original
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname=v_schema AND p.proname='finish_member_removal'
       AND pg_get_function_identity_arguments(p.oid)='p_actor text, p_job_id uuid';
    IF v_original IS NULL THEN
      RAISE EXCEPTION 'MEMBER_REMOVAL_FUNCTION_MISSING: %',v_schema;
    END IF;
    IF strpos(v_original,v_new)=0 THEN
      v_count:=(length(v_original)-length(replace(v_original,v_old,'')))/length(v_old);
      IF v_count<>1 THEN
        RAISE EXCEPTION 'MEMBER_REMOVAL_WRITABLE_RELATION_CONTRACT_CHANGED: %, %',v_schema,v_count;
      END IF;
      -- CREATE OR REPLACE preserves the existing SECURITY DEFINER, search_path,
      -- member-removal transaction, and service_role-only EXECUTE grants.
      EXECUTE replace(v_original,v_old,v_new);
    ELSE
      v_count:=(length(v_original)-length(replace(v_original,v_new,'')))/length(v_new);
      IF v_count<>1 THEN
        RAISE EXCEPTION 'MEMBER_REMOVAL_WRITABLE_RELATION_DUPLICATE_PATCH: %, %',v_schema,v_count;
      END IF;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_count
    FROM platform_private.business_templates t
    CROSS JOIN LATERAL jsonb_array_elements(t.snapshot->'functions') f(value)
   WHERE t.version='business-v1-20261019'
     AND f.value->>'name'='finish_member_removal'
     AND (strpos(f.value->>'definition',v_old)>0
          OR strpos(f.value->>'definition',v_new)>0);
  IF v_count<>1 THEN
    RAISE EXCEPTION 'MEMBER_REMOVAL_WRITABLE_RELATION_TEMPLATE_CHANGED: %',v_count;
  END IF;
  UPDATE platform_private.business_templates t
     SET snapshot=jsonb_set(t.snapshot,'{functions}',(
       SELECT jsonb_agg(
         CASE WHEN f.value->>'name'='finish_member_removal'
                   AND strpos(f.value->>'definition',v_new)=0
              THEN jsonb_set(f.value,'{definition}',to_jsonb(replace(f.value->>'definition',v_old,v_new)),true)
              ELSE f.value END ORDER BY f.ordinality
       )
       FROM jsonb_array_elements(t.snapshot->'functions') WITH ORDINALITY f(value,ordinality)
     ),true)
   WHERE t.version='business-v1-20261019';
END
$member_removal_writable_relations$;
