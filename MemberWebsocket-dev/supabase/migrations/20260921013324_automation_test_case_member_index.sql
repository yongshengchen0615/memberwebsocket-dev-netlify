create index if not exists automation_test_cases_member_id_idx
  on public.automation_test_cases (member_id)
  where member_id is not null;