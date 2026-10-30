# Feature dependencies — validation and release record

Baseline: `Integrated-Marketing-Platform` at `4d51998967a0b7df7148490426465e843788ada4`.
Candidate: `fix/feature-dependencies-20261030`; exact candidate/CI identity is recorded by its PR.

## Result before CI

Partial, not released. Local Node regression: **1200 pass / 0 fail / 0 skip**.
All script/build contract tests: **137 pass / 0 fail / 0 skip** (`TMPDIR` set to the writable workspace; the host has no `/tmp`).
Adjacent DOM/SQL tests: **32 pass / 0 fail / 0 skip**; feature/benefit/notification tests: **39 pass / 0 fail / 0 skip**.
Static frontend build executed successfully. Local Chromium and Deno/PostgreSQL execution are unavailable; the existing exact-SHA GitHub CI remains mandatory, including the new Chromium and PostgreSQL tests. Real LINE login and delivery are not claimed by isolated transport tests.

## Contracts and evidence

| AC | Contract | Evidence |
|---|---|---|
| AC-001 | Membership without points hides nested point grants/history; independent service-time grants remain | feature_dependencies.test.js; integration/feature_dependencies.cjs; browser/feature-dependencies.spec.cjs |
| AC-002 | Booking benefits and notification enrichment skip disabled point/event/calendar modules; events-only reservations remain locked | booking_benefits.test.js; notification_entitlement_behavior.test.js; feature_dependencies.test.js |
| AC-003 | Cross-feature writes require their dependency, including legacy service-type payloads and truthy calendar flags | feature_dependencies.test.js; integration/feature_dependencies.cjs |
| AC-004 | Previously stored selections, automatic point rules, historical correction context, fixed calendar links and calendar bonuses cannot bypass revocation | feature_dependencies.test.js; business-runtime_test.ts; integration/feature_dependencies.cjs; integration/postgres/feature-dependencies.cjs |
| AC-005 | Existing behavior and deployment remain gated by all established CI lanes | PR exact-SHA CI; not yet asserted here |

RED evidence was executed for missing dependency checks, unfiltered responses, nested/late UI, disabled enrichment, event reservation regression, immutable correction rules, fixed issuance, bonus grants, and scheduler dispatch. The scheduler test was replayed with the migration temporarily empty: unauthorized tenant A was dispatched before the fix and suppressed after restoring the migration. No production rows were modified by these tests.

## Review and decisions

Independent server review identified six Important issues, all addressed with behavior tests: event reservations, historical correction rules, manual/scheduled fixed calendar issuance, stored calendar point bonuses, legacy requiredServiceTypes, and calendar flag coercion.

Conservative behavior: a completion containing a revoked automatic reward rule is rejected even if a particular service would earn zero points. Historical correction rules are also guarded before calculating/applying adjustments. This intentionally keeps that integration unavailable and preserves stored rules; restoring the grant restores its availability.

Scheduled fixed issuance is paused for a tenant with active calendar-linked templates while calendar is disabled. Independent tenant jobs and tenants with standalone templates continue. Existing templates and historical records are retained.

The migration replaces only the known fixed-issuance branch of `platform_tick_businesses`, preserving expiry, credentials, reminders and notifications in the deployed function. A changed scheduler contract aborts the migration. Reapplication is idempotent. Supabase CLI scaffolding was attempted but its bundled Bun process crashed; the migration was timestamped locally and must be applied through the connected migration API only after CI. No new function privileges or tables are introduced.

## Quality and performance

Existing policies and workspace are extended; no framework, package, subscription or paid test environment is added. Late integration observation annotates descendants without remounting LINE settings. Optional disabled calendar calls are skipped. Hidden booking point settings are omitted from unrelated type edits, retaining stored rules.

Same-host uncompressed asset-byte comparison over the seven modified browser JS/CSS sources: **578,540 → 582,174 bytes (+3,634 bytes)**. Baseline fixed at the SHA above. This is an asset-size measurement, not an API latency improvement claim. Stored-dependency queries run only on affected operations when relevant grants are absent; fully granted settlements retain their original query path.

## Release and recovery

All required regression, integration, Chromium, PostgreSQL, Edge, wiring, dependency-audit, build and ticket-policy lanes must pass for the candidate. Do not deploy while any required check is failed/skipped/pending.

After approval by existing task authority and green CI: apply the additive scheduler migration to MemberWebsocket-dev; deploy affected Edge bundles from this exact source; merge to Integrated-Marketing-Platform and verify the CI-gated Netlify preview identity and smoke. These actions are not claimed by this pre-CI record.

Recovery: fix forward by reverting the reviewed frontend/Edge commit and redeploying the previous compatible bundles; scheduler modification changes only dispatch gating and preserves all rows. Do not delete merchant data or rewrite past migrations.

Browser correction: the first Chromium run rejected Playwright toBeDisabled on an option despite its native disabled/hidden properties. The updated assertion checks the native property and actual keyboard/selection behavior. Revoking an already-selected service grant now resets the mode and hides its entire dependent section; its DOM test reproduced the missing reset before the fix. Full CI is re-run on the new candidate.

Deployment routing check: BookingSystem still sent benefits/claims/profile/presence to the production API despite previewApiFunctionUrl. A behavioral test reproduced the wrong destination. The client now honors the existing override and retains the legacy URL when absent; this avoids overwriting production member APIs for preview acceptance.
