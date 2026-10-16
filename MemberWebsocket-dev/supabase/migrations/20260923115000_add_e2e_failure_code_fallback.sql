create or replace function public.classify_automation_test_failure_code()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  message_text text := lower(coalesce(new.failure_message, ''));
begin
  if new.status = 'failed'
     and (new.failure_code is null or new.failure_code in ('BROWSER_E2E_FAILED', 'UI_E2E_FAILED')) then
    new.failure_code := case
      when message_text ~ '(rate.?limit|too many requests|(^|[^0-9])429([^0-9]|$)|過於密集|稍後再試)'
        then 'E2E_RATE_LIMIT'
      when message_text ~ '(timeout|timed out|time out|deadline exceeded|允許時間|逾時|超時)'
        then 'E2E_TIMEOUT'
      when message_text ~ '(forbidden|permission denied|authorization|權限不足|無權限|不允許)'
        then 'E2E_AUTHORIZATION'
      when message_text ~ '(unauthenticated|authentication|invalid token|expired token|session expired|登入資訊|登入失效|重新登入|session required)'
        then 'E2E_AUTHENTICATION'
      when message_text ~ '(realtime|websocket|channel error|subscribe|subscription|即時同步)'
        then 'E2E_REALTIME'
      when message_text ~ '(failed to fetch|networkerror|network error|offline|connection reset|connection refused|網路)'
        then 'E2E_NETWORK'
      when message_text ~ '(service unavailable|internal server error|database|資料庫暫時|服務暫時)'
        then 'E2E_BACKEND'
      when message_text ~ '(window.error|unhandledrejection|typeerror|referenceerror|syntaxerror)'
        then 'E2E_CLIENT_ERROR'
      else 'E2E_ASSERTION'
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists automation_test_cases_failure_code_trigger
on public.automation_test_cases;

create trigger automation_test_cases_failure_code_trigger
before insert or update of status, failure_code, failure_message
on public.automation_test_cases
for each row
execute function public.classify_automation_test_failure_code();
