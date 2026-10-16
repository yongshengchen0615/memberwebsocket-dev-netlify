-- Expose only whitelisted scheduling metadata; never return cron commands or secrets.
create or replace function public.admin_e2e_automation_health()
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $function$
  with expected(name, grace) as (
    values ('issue-fixed-tickets', interval '36 hours'),
           ('dispatch-scheduled-grant-messages', interval '15 minutes'),
           ('dispatch-booking-line-notifications', interval '5 minutes'),
           ('sync-booking-day-before-reminders', interval '20 minutes'),
           ('prune-e2e-failure-artifacts', interval '36 hours')
  ), jobs as (
    select e.name,j.active,j.schedule,r.status,r.start_time,r.end_time,
      coalesce(r.start_time >= now() - e.grace,false) as fresh
    from expected e left join cron.job j on j.jobname=e.name
    left join lateral (
      select status,start_time,end_time from cron.job_run_details
      where jobid=j.jobid order by start_time desc,runid desc limit 1
    ) r on true
  )
  select jsonb_build_object('checkedAt',now(),'jobs',coalesce(jsonb_agg(jsonb_build_object(
    'name',name,'active',coalesce(active,false),'schedule',schedule,
    'lastStatus',status,'lastStartedAt',start_time,'lastEndedAt',end_time,'fresh',fresh
  ) order by name),'[]'::jsonb)) from jobs;
$function$;
revoke all on function public.admin_e2e_automation_health() from public, anon, authenticated;
grant execute on function public.admin_e2e_automation_health() to service_role;
