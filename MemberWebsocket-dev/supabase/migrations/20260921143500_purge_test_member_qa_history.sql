create or replace function public.purge_test_member_qa_history()
returns trigger
language plpgsql
set search_path = 'public'
as $function$
begin
  if old.is_test_account is true then
    delete from public.automation_test_runs as run
     where coalesce(run.summary ->> 'source', '') = 'member-client'
       and exists (
         select 1
           from public.automation_test_cases as test_case
          where test_case.run_id = run.id
            and test_case.member_id = old.id
       );

    delete from public.automation_test_cases
     where member_id = old.id;
  end if;

  return old;
end;
$function$;

revoke all on function public.purge_test_member_qa_history() from public, anon, authenticated;
grant execute on function public.purge_test_member_qa_history() to service_role;

drop trigger if exists purge_test_member_qa_history_before_delete on public.members;
create trigger purge_test_member_qa_history_before_delete
before delete on public.members
for each row execute function public.purge_test_member_qa_history();
