delete from public.test_execution_leases
 where expires_at <= clock_timestamp()
    or last_heartbeat_at < clock_timestamp() - interval '90 seconds';

create or replace function public.admin_purge_all_test_data_converged()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb := '{}'::jsonb;
  v_pass jsonb := '{}'::jsonb;
  v_pass_deleted integer := 0;
  v_retry_deleted integer := 0;
  v_passes integer := 0;
  v_remaining integer := 0;
begin
  perform pg_advisory_xact_lock(2026092001);
  perform pg_advisory_xact_lock(2026092202);

  delete from public.test_execution_leases
   where expires_at <= clock_timestamp()
      or last_heartbeat_at < clock_timestamp() - interval '90 seconds';

  v_result := public.admin_purge_all_test_data();

  for v_passes in 1..4 loop
    v_pass := public.admin_purge_extended_qa_artifacts();
    v_pass_deleted := coalesce((v_pass ->> 'deletedExtendedQaArtifacts')::integer, 0);
    v_retry_deleted := v_retry_deleted + v_pass_deleted;
    exit when v_pass_deleted = 0;
  end loop;

  select
      (select count(*) from public.point_cards pc where public.is_qa_test_provenance(pc.created_by))
    + (select count(*) from public.ticket_templates tt where public.is_qa_test_provenance(tt.created_by))
    + (select count(*) from public.fixed_ticket_templates f where public.is_qa_test_provenance(f.created_by))
    + (select count(*) from public.calendar_items c where public.is_qa_test_provenance(c.created_by))
    + (select count(*) from public.event_tickets e
         where public.is_qa_test_provenance(e.created_by)
            or exists (
              select 1 from public.fixed_ticket_templates f
               where f.id = e.fixed_ticket_template_id
                 and public.is_qa_test_provenance(f.created_by)
            ))
  into v_remaining;

  return v_result || jsonb_build_object(
    'convergencePasses', v_passes,
    'deletedConvergenceRows', v_retry_deleted,
    'remainingQaArtifacts', v_remaining,
    'cleanupComplete', v_remaining = 0
  );
end
$function$;

revoke all on function public.admin_purge_all_test_data_converged()
  from public, anon, authenticated;
grant execute on function public.admin_purge_all_test_data_converged()
  to service_role;

comment on function public.admin_purge_all_test_data_converged() is
  'Reclaims stale full-E2E leases, runs full test-data purge and bounded convergence passes, then reports whether QA artifacts remain.';
