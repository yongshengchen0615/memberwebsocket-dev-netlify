# GitHub ↔ Supabase production reconciliation — 2026-10-23

## Confirmed inventory
- GitHub main: 268 SQL migration files. Remote Supabase project dbuquirnaskrwcamdxki: 291 recorded applied migrations.
- Migration version IDs shared: 122. GitHub-only: 146. Remote-only: 169. Names and timestamps are sometimes different; do not assume unmatched versions require re-execution.
- Production has 32 Edge Functions. 31 index.ts entrypoints match GitHub main; fixed-ticket-automation/index.ts differs.
- The fixed-ticket-automation remote bundle also differs in _shared/business-scope.ts, _shared/business-runtime.ts, _shared/business-policy.mjs and _shared/platform-policy.mjs. Checking index.ts alone is insufficient to prove parity.
- New GitHub migration versions absent from remote history: 20261021060609_booking_risk_appeal_resolution.sql and 20261021061400_booking_risk_member_lock.sql. These edit the installer for tenant booking-risk logic.

## Production safety gates
1. Do not run automatic db push, migration repair, db reset, or bulk Function deployment until migration history AND semantic schema drift have been reconciled.
2. Make and restore-test a production backup in an isolated environment. Check schema, triggers, RLS, RPC bodies and grants. Version equality alone does not verify SQL content.
3. Inspect every same-name/different-version migration and remote-only entry individually. Never mark migrations as applied without verifying their actual DDL effects.
4. Verify all 32 bundled Function sources, including _shared dependencies and verify_jwt configurations.
5. Use separate staging Supabase environment for develop, and CI + reviewed main SHA + release approval for production. CalendarSystem is not a staging replacement.
6. Test auth, booking, member, admin, LINE and rollback before production release.
7. Record the published Git SHA, database migration history, function versions and test evidence.

## Implemented (read-only)
- GitHub Actions: .github/workflows/supabase-sync-audit.yml
- Comparison: scripts/check-supabase-sync.mjs
- Tests: scripts/check-supabase-sync.test.mjs
- Setup: repository secrets SUPABASE_ACCESS_TOKEN and SUPABASE_DB_PASSWORD. No secrets in files or logs.
- Actions may be manually invoked; on main, the audit also runs on selected code changes and daily schedule.
- The remote audit should fail in its current state by design: it prevents false declarations of sync. The workflow never modifies Supabase.

This is a reconciliation and release-safety plan, not confirmation that production has been updated.
