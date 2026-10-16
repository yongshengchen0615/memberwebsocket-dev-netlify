create index if not exists automation_test_cases_failure_diagnostics_idx
  on public.automation_test_cases (failure_code, created_at desc)
  where status = 'failed';
