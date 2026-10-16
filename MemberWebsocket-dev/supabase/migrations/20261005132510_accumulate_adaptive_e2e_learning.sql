alter table public.e2e_case_learning_state
  add column if not exists last_learned_run_id uuid;

create or replace function public.admin_accumulate_e2e_case_learning(p_run_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_case record;
  v_existing public.e2e_case_learning_state%rowtype;
  v_old_exec bigint;
  v_new_exec bigint;
  v_pass bigint;
  v_fail bigint;
  v_skip bigint;
  v_failure_rate double precision;
  v_failure_ewma double precision;
  v_flaky double precision;
  v_avg_duration bigint;
  v_p95_duration bigint;
  v_last_failed_at timestamptz;
  v_last_passed_at timestamptz;
  v_recency double precision;
  v_risk double precision;
  v_profile_stats jsonb;
  v_preferred_profile text;
  v_profile text;
  v_profile_score double precision;
  v_profile_exec bigint;
  v_profile_fail bigint;
  v_profile_avg double precision;
  v_profile_new_exec bigint;
  v_profile_new_fail bigint;
  v_profile_new_avg double precision;
  v_fingerprint text;
  v_applied integer := 0;
begin
  if p_run_id is null then
    raise exception 'run id is required';
  end if;

  if not exists (
    select 1 from public.automation_test_runs r where r.id = p_run_id
  ) then
    raise exception 'unknown automation test run';
  end if;

  for v_case in
    select c.id, c.case_key, c.status, c.failure_code, c.duration_ms,
           coalesce(c.completed_at, c.started_at, c.created_at) as observed_at
      from public.automation_test_cases c
     where c.run_id = p_run_id
       and c.case_key is not null
       and c.case_key <> ''
       and c.status in ('passed','failed','skipped')
     order by c.case_order, c.id
  loop
    select *
      into v_existing
      from public.e2e_case_learning_state
     where case_key = v_case.case_key;

    if found and v_existing.last_learned_run_id = p_run_id then
      continue;
    end if;

    v_old_exec := coalesce(v_existing.executions, 0);
    v_new_exec := v_old_exec + 1;
    v_pass := coalesce(v_existing.pass_count, 0) + case when v_case.status = 'passed' then 1 else 0 end;
    v_fail := coalesce(v_existing.fail_count, 0) + case when v_case.status = 'failed' then 1 else 0 end;
    v_skip := coalesce(v_existing.skip_count, 0) + case when v_case.status = 'skipped' then 1 else 0 end;
    v_failure_rate := (v_fail::double precision + 1.0) / (v_new_exec::double precision + 2.0);

    if v_case.status = 'skipped' then
      v_failure_ewma := coalesce(v_existing.failure_ewma, 0);
    elsif v_old_exec = 0 then
      v_failure_ewma := case when v_case.status = 'failed' then 1.0 else 0.0 end;
    else
      v_failure_ewma := 0.85 * coalesce(v_existing.failure_ewma, 0)
        + 0.15 * case when v_case.status = 'failed' then 1.0 else 0.0 end;
    end if;

    if v_case.status not in ('passed','failed')
       or coalesce(v_existing.last_status, '') not in ('passed','failed') then
      v_flaky := coalesce(v_existing.flaky_score, 0);
    else
      v_flaky := 0.85 * coalesce(v_existing.flaky_score, 0)
        + 0.15 * case when v_existing.last_status <> v_case.status then 1.0 else 0.0 end;
    end if;

    v_avg_duration := case
      when v_case.duration_ms is null then coalesce(v_existing.avg_duration_ms, 0)
      when v_old_exec = 0 then greatest(0, v_case.duration_ms)
      else round(
        (
          coalesce(v_existing.avg_duration_ms, 0)::numeric * v_old_exec
          + greatest(0, v_case.duration_ms)
        ) / v_new_exec
      )::bigint
    end;
    v_p95_duration := greatest(
      coalesce(v_existing.p95_duration_ms, 0),
      greatest(0, coalesce(v_case.duration_ms, 0))
    );

    select
      coalesce(
        nullif(s.actual #>> '{humanInteraction,professionalTester,profile}', ''),
        nullif(s.actual #>> '{professionalTester,profile}', '')
      ),
      nullif(coalesce(
        s.actual #>> '{humanInteraction,professionalTester,score}',
        s.actual #>> '{professionalTester,score}'
      ), '')::double precision
      into v_profile, v_profile_score
      from public.automation_test_steps s
     where s.case_id = v_case.id
       and s.step_key in ('human-ui','browser')
     order by s.step_order
     limit 1;

    v_profile_stats := coalesce(v_existing.profile_stats, '{}'::jsonb);
    if v_profile in ('deliberate','impatient','exploratory','skeptical') then
      v_profile_exec := coalesce((v_profile_stats -> v_profile ->> 'executions')::bigint, 0);
      v_profile_fail := coalesce((v_profile_stats -> v_profile ->> 'failures')::bigint, 0);
      v_profile_avg := coalesce((v_profile_stats -> v_profile ->> 'avgScore')::double precision, 0);
      v_profile_new_exec := v_profile_exec + 1;
      v_profile_new_fail := v_profile_fail + case when v_case.status = 'failed' then 1 else 0 end;
      v_profile_new_avg := (
        v_profile_avg * v_profile_exec + coalesce(v_profile_score, 0)
      ) / greatest(1, v_profile_new_exec);
      v_profile_stats := jsonb_set(
        v_profile_stats,
        array[v_profile],
        jsonb_build_object(
          'executions', v_profile_new_exec,
          'failures', v_profile_new_fail,
          'detectionRate', round(((v_profile_new_fail + 1.0) / (v_profile_new_exec + 4.0))::numeric, 4),
          'avgScore', round(v_profile_new_avg::numeric, 2)
        ),
        true
      );
    end if;

    select coalesce(key, '')
      into v_preferred_profile
      from jsonb_each(v_profile_stats)
     where key in ('deliberate','impatient','exploratory','skeptical')
     order by
       coalesce((value ->> 'detectionRate')::double precision, 0)
       + least(0.20, coalesce((value ->> 'avgScore')::double precision, 0) / 500.0) desc,
       coalesce((value ->> 'executions')::bigint, 0) desc,
       key
     limit 1;
    v_preferred_profile := coalesce(v_preferred_profile, coalesce(v_existing.preferred_tester_profile, ''));

    v_fingerprint := '';
    if v_case.status = 'failed' then
      select coalesce(s.actual #>> '{diagnosis,fingerprint}', '')
        into v_fingerprint
        from public.automation_test_steps s
       where s.case_id = v_case.id
         and s.step_key = 'failure-trace'
       order by s.step_order desc
       limit 1;
    end if;

    v_last_failed_at := case
      when v_case.status = 'failed' then v_case.observed_at
      else v_existing.last_failed_at
    end;
    v_last_passed_at := case
      when v_case.status = 'passed' then v_case.observed_at
      else v_existing.last_passed_at
    end;

    v_recency := case
      when v_last_failed_at is null then 0
      else exp(
        -greatest(0, extract(epoch from (now() - v_last_failed_at)) / 86400.0) / 30.0
      )
    end;
    v_risk := least(
      1.0,
      greatest(
        0.0,
        0.35 * v_failure_rate
        + 0.30 * v_failure_ewma
        + 0.20 * v_flaky
        + 0.15 * v_recency
      )
    );

    insert into public.e2e_case_learning_state (
      case_key, executions, pass_count, fail_count, skip_count,
      failure_rate, failure_ewma, flaky_score,
      avg_duration_ms, p95_duration_ms, risk_score,
      preferred_tester_profile, profile_stats,
      last_status, last_failure_code, last_failure_fingerprint,
      last_failed_at, last_passed_at, last_learned_run_id, updated_at
    )
    values (
      v_case.case_key, v_new_exec, v_pass, v_fail, v_skip,
      v_failure_rate, v_failure_ewma, v_flaky,
      v_avg_duration, v_p95_duration, v_risk,
      v_preferred_profile, v_profile_stats,
      v_case.status,
      case when v_case.status = 'failed'
        then coalesce(v_case.failure_code, '')
        else coalesce(v_existing.last_failure_code, '')
      end,
      case when v_case.status = 'failed'
        then coalesce(v_fingerprint, '')
        else coalesce(v_existing.last_failure_fingerprint, '')
      end,
      v_last_failed_at, v_last_passed_at, p_run_id, now()
    )
    on conflict (case_key) do update
    set executions = excluded.executions,
        pass_count = excluded.pass_count,
        fail_count = excluded.fail_count,
        skip_count = excluded.skip_count,
        failure_rate = excluded.failure_rate,
        failure_ewma = excluded.failure_ewma,
        flaky_score = excluded.flaky_score,
        avg_duration_ms = excluded.avg_duration_ms,
        p95_duration_ms = excluded.p95_duration_ms,
        risk_score = excluded.risk_score,
        preferred_tester_profile = excluded.preferred_tester_profile,
        profile_stats = excluded.profile_stats,
        last_status = excluded.last_status,
        last_failure_code = excluded.last_failure_code,
        last_failure_fingerprint = excluded.last_failure_fingerprint,
        last_failed_at = excluded.last_failed_at,
        last_passed_at = excluded.last_passed_at,
        last_learned_run_id = excluded.last_learned_run_id,
        updated_at = excluded.updated_at;

    v_applied := v_applied + 1;
  end loop;

  return v_applied;
end;
$$;

revoke all on function public.admin_accumulate_e2e_case_learning(uuid) from public, anon, authenticated;
grant execute on function public.admin_accumulate_e2e_case_learning(uuid) to service_role;

comment on table public.e2e_case_learning_state is
  'Durable derived QA memory. Ordinary test-data purge may remove raw E2E runs, but this aggregate learning state is intentionally retained.';
comment on function public.admin_accumulate_e2e_case_learning(uuid) is
  'Idempotently folds one persisted E2E run into durable per-case risk and professional-tester learning.';
