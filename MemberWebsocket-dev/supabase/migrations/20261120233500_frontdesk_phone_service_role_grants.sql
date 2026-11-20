-- AC-FR-005/006: dedicated server-only execute grants for frontdesk read helpers.
-- The authenticated frontdesk RPC checks tenant, LINE token age and approved
-- reviewer permission first; anon/authenticated must not invoke raw schema helpers.
grant execute on function platform_private.frontdesk_phone_catalog(text) to service_role;
grant execute on function platform_private.frontdesk_phone_slots(text,jsonb) to service_role;
revoke all on function platform_private.frontdesk_phone_catalog(text) from public,anon,authenticated;
revoke all on function platform_private.frontdesk_phone_slots(text,jsonb) from public,anon,authenticated;
