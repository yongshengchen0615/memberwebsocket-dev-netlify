# FJG-02 PostgreSQL acceptance increment

Spec: Issue #156 AC-002/003/005 and docs/LINE_MEMBER_OA_ACTIVATION_GATE.md.
Base: PR #167, 8a6ff3e6a07189360a72d851c8bb094e632acd84.

1. Reuse the disposable PostgreSQL 17 service and existing business-runtime installers. Add real two-session races for both public RPC forms, assert lock contention, committed state, unique consent, one first-activation audit and replay stability.
2. Add rollback recovery, two-shop consent isolation and validation failure cases. Use synthetic non-test members to exercise the production consent trigger. No live Supabase writes or dependency changes.
3. Wire the new suite into the required PostgreSQL job. Run the final SHA through full regression, DOM, PostgreSQL, Chromium, syntax, Edge, wiring, dependency audit, Netlify build and ticket policy.
4. Record actual evidence on #156/#167. Keep the draft and development Status until LINE binding, direct Edge acceptance and referral reward races are verified. No merge or deployment in this increment.

Quality/performance: test/CI-only change; product runtime and performance are unchanged. No runtime benchmark applies. A DB pass does not verify the LINE gate, service-role misuse resistance, every historical migration, or referral reward issuance.

Review focus: physical sessions and actual lock contention; no bypassed triggers; rollback releases waiting requests; final data counts rather than only RPC responses; CI must execute the file; cleanup on failure.
