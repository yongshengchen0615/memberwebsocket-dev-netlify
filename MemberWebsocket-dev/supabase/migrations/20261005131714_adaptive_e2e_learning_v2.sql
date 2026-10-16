create table if not exists public.e2e_case_learning_state (
  case_key text primary key check (case_key ~ '^[A-Z0-9_]+$'),
  executions bigint not null default 0 check (executions >= 0),
  pass_count bigint not null default 0 check (pass_count >= 0),
  fail_count bigint not null default 0 check (fail_count >= 0),
  skip_count bigint not null default 0 check (skip_count >= 0),
  failure_rate double precision not null default 0 check (failure_rate between 0 and 1),
  failure_ewma double precision not null default 0 check (failure_ewma between 0 and 1),
  flaky_score double precision not null default 0 check (flaky_score between 0 and 1),
  avg_duration_ms bigint not null default 0 check (avg_duration_ms >= 0),
  p95_duration_ms bigint not null default 0 check (p95_duration_ms >= 0),
  risk_score double precision not null default 0 check (risk_score between 0 and 1),
  preferred_tester_profile text not null default '' check (preferred_tester_profile in ('','deliberate','impatient','exploratory','skeptical')),
  profile_stats jsonb not null default '{}'::jsonb,
  last_status text not null default '' check (last_status in ('','passed','failed','skipped')),
  last_failure_code text not null default '',
  last_failure_fingerprint text not null default '',
  last_failed_at timestamptz,
  last_passed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.e2e_case_learning_state enable row level security;
revoke all on table public.e2e_case_learning_state from public, anon, authenticated;
grant select, insert, update, delete on table public.e2e_case_learning_state to service_role;

create index if not exists e2e_case_learning_risk_idx
  on public.e2e_case_learning_state (risk_score desc, updated_at desc);

create or replace function public.admin_refresh_e2e_case_learning(p_run_id uuid default null)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_case_key text;
  v_executions bigint;
  v_pass bigint;
  v_fail bigint;
  v_skip bigint;
  v_failure_rate double precision;
  v_failure_ewma double precision;
  v_flaky double precision;
  v_avg_duration bigint;
  v_p95_duration bigint;
  v_last_status text;
  v_last_failure_code text;
  v_last_failure_fingerprint text;
  v_last_failed_at timestamptz;
  v_last_passed_at timestamptz;
  v_recency double precision;
  v_risk double precision;
  v_profile_stats jsonb;
  v_preferred_profile text;
  v_refreshed integer := 0;
begin
  for v_case_key in
    select distinct c.case_key
    from public.automation_test_cases c
    where c.case_key is not null
      and c.case_key <> ''
      and (p_run_id is null or c.run_id = p_run_id)
  loop
    select
      count(*)::bigint,
      count(*) filter (where c.status = 'passed')::bigint,
      count(*) filter (where c.status = 'failed')::bigint,
      count(*) filter (where c.status = 'skipped')::bigint,
      coalesce(round(avg(c.duration_ms) filter (where c.duration_ms is not null)), 0)::bigint,
      coalesce(
        percentile_disc(0.95) within group (order by c.duration_ms)
          filter (where c.duration_ms is not null),
        0
      )::bigint,
      max(c.created_at) filter (where c.status = 'failed'),
      max(c.created_at) filter (where c.status = 'passed')
    into
      v_executions, v_pass, v_fail, v_skip, v_avg_duration, v_p95_duration,
      v_last_failed_at, v_last_passed_at
    from public.automation_test_cases c
    where c.case_key = v_case_key
      and c.status in ('passed','failed','skipped');

    v_failure_rate := case
      when v_executions <= 0 then 0
      else (v_fail::double precision + 1.0) / (v_executions::double precision + 2.0)
    end;

    with recent as (
      select
        c.status,
        row_number() over (order by c.created_at desc, c.id desc) as rn
      from public.automation_test_cases c
      where c.case_key = v_case_key
        and c.status in ('passed','failed','skipped')
      order by c.created_at desc, c.id desc
      limit 50
    )
    select coalesce(
      sum((case when status = 'failed' then 1.0 else 0.0 end) * power(0.85::double precision, rn - 1))
      / nullif(sum(power(0.85::double precision, rn - 1)), 0),
      0
    )
    into v_failure_ewma
    from recent;

    with recent as (
      select c.status, c.created_at, c.id
      from public.automation_test_cases c
      where c.case_key = v_case_key
        and c.status in ('passed','failed')
      order by c.created_at desc, c.id desc
      limit 30
    ),
    transitions as (
      select status, lag(status) over (order by created_at asc, id asc) as previous_status
      from recent
    )
    select coalesce(
      avg(case when previous_status is null then null
               when previous_status <> status then 1.0 else 0.0 end),
      0
    )
    into v_flaky
    from transitions;

    select coalesce(c.status, '')
    into v_last_status
    from public.automation_test_cases c
    where c.case_key = v_case_key
      and c.status in ('passed','failed','skipped')
    order by c.created_at desc, c.id desc
    limit 1;

    select
      coalesce(c.failure_code, ''),
      coalesce((
        select s.actual #>> '{diagnosis,fingerprint}'
        from public.automation_test_steps s
        where s.case_id = c.id
          and s.step_key = 'failure-trace'
        order by s.step_order desc, s.created_at desc
        limit 1
      ), '')
    into v_last_failure_code, v_last_failure_fingerprint
    from public.automation_test_cases c
    where c.case_key = v_case_key
      and c.status = 'failed'
    order by c.created_at desc, c.id desc
    limit 1;

    v_last_status := coalesce(v_last_status, '');
    v_last_failure_code := coalesce(v_last_failure_code, '');
    v_last_failure_fingerprint := coalesce(v_last_failure_fingerprint, '');

    with evidence as (
      select
        c.status,
        coalesce(
          nullif(s.actual #>> '{humanInteraction,professionalTester,profile}', ''),
          nullif(s.actual #>> '{professionalTester,profile}', '')
        ) as profile,
        nullif(coalesce(
          s.actual #>> '{humanInteraction,professionalTester,score}',
          s.actual #>> '{professionalTester,score}'
        ), '')::double precision as score
      from public.automation_test_steps s
      join public.automation_test_cases c on c.id = s.case_id
      where c.case_key = v_case_key
        and s.step_key in ('human-ui','browser')
    ),
    agg as (
      select
        profile,
        count(*)::bigint as executions,
        count(*) filter (where status = 'failed')::bigint as failures,
        coalesce(avg(score), 0)::double precision as avg_score
      from evidence
      where profile in ('deliberate','impatient','exploratory','skeptical')
      group by profile
    )
    select
      coalesce((
        select jsonb_object_agg(
          profile,
          jsonb_build_object(
            'executions', executions,
            'failures', failures,
            'detectionRate', round(((failures + 1.0) / (executions + 4.0))::numeric, 4),
            'avgScore', round(avg_score::numeric, 2)
          )
        )
        from agg
      ), '{}'::jsonb),
      coalesce((
        select profile
        from agg
        order by
          ((failures + 1.0) / (executions + 4.0)) + least(0.20, avg_score / 500.0) desc,
          executions desc,
          profile
        limit 1
      ), '')
    into v_profile_stats, v_preferred_profile;

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
        0.35 * coalesce(v_failure_rate, 0)
        + 0.30 * coalesce(v_failure_ewma, 0)
        + 0.20 * coalesce(v_flaky, 0)
        + 0.15 * coalesce(v_recency, 0)
      )
    );

    insert into public.e2e_case_learning_state (
      case_key, executions, pass_count, fail_count, skip_count,
      failure_rate, failure_ewma, flaky_score,
      avg_duration_ms, p95_duration_ms, risk_score,
      preferred_tester_profile, profile_stats,
      last_status, last_failure_code, last_failure_fingerprint,
      last_failed_at, last_passed_at, updated_at
    )
    values (
      v_case_key, v_executions, v_pass, v_fail, v_skip,
      coalesce(v_failure_rate, 0), coalesce(v_failure_ewma, 0), coalesce(v_flaky, 0),
      v_avg_duration, v_p95_duration, v_risk,
      coalesce(v_preferred_profile, ''), coalesce(v_profile_stats, '{}'::jsonb),
      v_last_status, v_last_failure_code, v_last_failure_fingerprint,
      v_last_failed_at, v_last_passed_at, now()
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
        updated_at = excluded.updated_at;

    v_refreshed := v_refreshed + 1;
  end loop;

  return v_refreshed;
end;
$$;

revoke all on function public.admin_refresh_e2e_case_learning(uuid) from public, anon, authenticated;
grant execute on function public.admin_refresh_e2e_case_learning(uuid) to service_role;

select public.admin_refresh_e2e_case_learning(null);
