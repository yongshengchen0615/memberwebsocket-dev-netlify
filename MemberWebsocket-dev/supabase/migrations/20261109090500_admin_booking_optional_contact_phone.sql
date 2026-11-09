-- Allow counter staff to register bookings without collecting a customer's phone.
-- Keep the original RPC signature, request-id prefix, overlap locks and audit trail.
-- Derive the next function version from the currently installed definition so that
-- later changes (including booking price context) are not overwritten.
do $booking_optional_phone$
declare
  v_signature constant text := 'public.admin_create_phone_booking_request(text,text,date,time without time zone,text,text,text,jsonb,text)';
  v_original text;
  v_updated text;
  v_schema text;
  v_template_updates integer;
begin
  v_original := pg_get_functiondef(v_signature::regprocedure);
  if v_original is null then
    raise exception 'ADMIN_BOOKING_FUNCTION_MISSING';
  end if;

  if strpos(v_original, $old_init$v_phone text := regexp_replace(btrim(coalesce(p_contact_phone,'')),'[()[:space:]-]','','g');$old_init$) = 0
    or strpos(v_original, $old_guard$or v_phone !~ '^\+?[0-9]{8,15}$'$old_guard$) = 0 then
    raise exception 'ADMIN_BOOKING_PHONE_CONTRACT_CHANGED';
  end if;

  -- Empty/missing phones are NULL, not a synthetic phone number.
  v_updated := replace(
    v_original,
    $old_init$v_phone text := regexp_replace(btrim(coalesce(p_contact_phone,'')),'[()[:space:]-]','','g');$old_init$,
    $new_init$v_phone text := nullif(regexp_replace(btrim(coalesce(p_contact_phone,'')),'[()[:space:]-]','','g'),'');$new_init$
  );
  v_updated := replace(
    v_updated,
    $old_guard$or v_phone !~ '^\+?[0-9]{8,15}$'$old_guard$,
    $new_guard$or (v_phone is not null and v_phone !~ '^\+?[0-9]{8,15}$')$new_guard$
  );
  if v_updated = v_original then raise exception 'ADMIN_BOOKING_PHONE_UPDATE_NOOP'; end if;

  execute v_updated;

  -- Keep newly provisioned merchants consistent with the current RPC.
  update platform_private.business_templates t
  set snapshot = jsonb_set(
    t.snapshot,
    '{functions}',
    (
      select jsonb_agg(
        case
          when f.value->>'name' = 'admin_create_phone_booking_request'
            then jsonb_set(f.value, '{definition}', to_jsonb(v_updated), true)
          else f.value
        end
        order by f.ordinality
      )
      from jsonb_array_elements(t.snapshot->'functions') with ordinality as f(value, ordinality)
    ),
    true
  )
  where t.version = 'business-v1-20261019'
    and exists (
      select 1 from jsonb_array_elements(t.snapshot->'functions') f
      where f->>'name' = 'admin_create_phone_booking_request'
    );
  get diagnostics v_template_updates = row_count;
  if v_template_updates <> 1 then
    raise exception 'ADMIN_BOOKING_TEMPLATE_UPDATE_FAILED: %', v_template_updates;
  end if;

  -- Reinstall the updated function in each tenant, preserving per-tenant schema isolation.
  for v_schema in
    select runtime_schema from platform_private.tenants
    where runtime_schema ~ '^business_[0-9a-f]{32}$'
  loop
    execute platform_private.business_sql(v_updated, v_schema);
  end loop;

  perform pg_notify('pgrst', 'reload schema');
end;
$booking_optional_phone$;
