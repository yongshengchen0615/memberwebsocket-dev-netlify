-- One-click clear is an operational reset, not a legal-record eraser.
-- Preserve real member identities together with the exact published terms and
-- immutable consent evidence they accepted. Virtual/test members are still
-- removed so QA can start from a clean test-account sequence.
--
-- The postgres-only maintenance.clear_public_data() remains the explicit
-- full-environment reset path. This migration only narrows the service-role
-- one-click clear surface.

create or replace function maintenance.clear_non_admin_data(confirm_clear boolean default false)
returns table(truncated_table_count integer)
language plpgsql
set search_path = ''
as $function$
declare
  table_list text;
  table_count integer;
  v_test_member_ids uuid[];
begin
  if confirm_clear is distinct from true then
    raise exception 'Refusing to clear data: call maintenance.clear_non_admin_data(true) to confirm';
  end if;

  loop
    select coalesce(array_agg(batch.id order by batch.id), array[]::uuid[])
      into v_test_member_ids
      from (
        select id
          from public.members
         where is_test_account is true
         order by id
         limit 200
      ) as batch;

    exit when cardinality(v_test_member_ids) = 0;

    perform 1
      from public.admin_delete_test_accounts(v_test_member_ids);
  end loop;

  select
    string_agg(format('%I.%I', schemaname, tablename), ', ' order by schemaname, tablename),
    count(*)::integer
  into table_list, table_count
  from pg_catalog.pg_tables
  where schemaname in ('public', 'booking_notifications')
    and not (
      schemaname = 'public'
      and tablename in ('admins', 'members', 'membership_terms', 'membership_consents')
    );

  if table_list is not null then
    execute 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY';
  end if;

  if pg_catalog.to_regclass('public.test_member_sequence') is not null
     and not exists (select 1 from public.members where is_test_account is true) then
    perform pg_catalog.setval('public.test_member_sequence'::regclass, 1, false);
  end if;

  perform maintenance.ensure_required_system_baseline();

  if exists (
    select 1
      from public.membership_consents c
      left join public.members m on m.id = c.member_id
      left join public.membership_terms t on t.id = c.terms_id
     where m.id is null or t.id is null
  ) then
    raise exception 'PRESERVED_MEMBERSHIP_CONSENT_INTEGRITY_FAILED';
  end if;

  return query select coalesce(table_count, 0);
end;
$function$;
