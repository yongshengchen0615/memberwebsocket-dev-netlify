-- Read-only deployment gate. Any returned row means the API must not be released.
-- Covers literal RPC dependencies in api/index.ts and functions/_shared/*.ts.
with required(name) as (values
  ('accept_membership_terms'),('activate_membership_terms'),('apply_calendar_batch'),
  ('claim_event_ticket'),('consume_api_rate_limit'),('copy_admin_settings'),
  ('delete_point_card'),('event_ticket_claim_counts'),('get_line_messaging_token'),
  ('grant_member_benefits'),('has_current_membership_terms_consent'),
  ('issue_eligible_point_tickets'),('issue_eligible_point_tickets_for_member'),
  ('member_service_minute_totals'),('member_ticket_booking_options'),
  ('redeem_member_tickets_for_booking_request'),('reorder_point_cards'),
  ('save_membership_terms_draft'),('save_point_card_service_items'),('save_tier_settings')
)
select name as missing_rpc from required r
where not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname=r.name
)
order by name;
