create or replace function public.consume_api_rate_limit(
  p_principal_hash text,
  p_is_write boolean,
  p_cost integer default 1,
  p_read_limit integer default 90,
  p_write_limit integer default 30
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_bucket timestamptz := date_trunc('minute', now());
  v_qa_mode boolean := false;
  v_multiplier integer := 1;
  v_effective_principal_hash text := p_principal_hash;
  v_type text := case when p_is_write then 'write' else 'read' end;
  v_limit integer;
  v_count integer;
begin
  if p_cost < 1 or p_cost > 20 then
    return false;
  end if;

  select coalesce(settings.enabled, false) and coalesce(settings.maintenance_enabled, false)
    into v_qa_mode
  from public.test_mode_settings as settings
  where settings.id = true;

  v_qa_mode := coalesce(v_qa_mode, false);
  if v_qa_mode then
    v_multiplier := 8;
    v_effective_principal_hash := 'qa:' || p_principal_hash;
  end if;

  v_limit := greatest(
    1,
    (case when p_is_write then p_write_limit else p_read_limit end) * v_multiplier
  );

  insert into public.api_rate_limits(principal_hash, bucket_at, bucket_type, request_count)
  values(v_effective_principal_hash, v_bucket, v_type, p_cost)
  on conflict(principal_hash, bucket_at,bucket_type)
  do update set request_count = public.api_rate_limits.request_count + excluded.request_count
  returning request_count into v_count;

  delete from public.api_rate_limits
  where bucket_at < now() - interval '2 hours';

  return v_count <= v_limit;
end;
$function$;
