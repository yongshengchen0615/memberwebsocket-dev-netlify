begin;

revoke all on function public.issue_membership_join_ticket_after_activation() from public, anon, authenticated;

commit;
