-- PostgREST can retain a stale RPC signature after membership terms migrations.
-- Keep the Data API schema cache synchronized so member registration can call
-- public.accept_membership_terms immediately after deployment.
NOTIFY pgrst, 'reload schema';
