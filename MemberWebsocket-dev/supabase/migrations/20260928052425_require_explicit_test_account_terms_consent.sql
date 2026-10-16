-- Test accounts are provisioned directly as active members, so joined_at cannot prove legal consent.
create or replace function public.has_current_membership_terms_consent(p_member_id uuid)
returns boolean
language sql
stable
set search_path to ''
as $function$
  select coalesce((select
    not t.reconsent_existing
    or (
      m.is_test_account is not true
      and coalesce(m.joined_at,m.created_at) >= t.activated_at
    )
    or exists(
      select 1
      from public.membership_consents c
      where c.member_id=m.id
        and c.terms_id=t.id
    )
  from public.members m
  cross join public.membership_terms t
  where m.id=p_member_id
    and t.status='active'),true);
$function$;
