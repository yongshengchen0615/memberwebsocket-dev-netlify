# Feature dependencies — validation and release record

Baseline: `Integrated-Marketing-Platform` at `4d51998967a0b7df7148490426465e843788ada4`.
Candidate: `fix/feature-dependencies-20261030`; exact candidate/CI identity is recorded by its PR.

## Result before CI

Partial, not released. Local Node regression: **1202 pass / 0 fail / 0 skip**.
The broad parallel script run reported one existing shared-dist build race (duplicate calendar build badge; 136 pass / 1 fail). All 137 assertions are being re-run serially with `TMPDIR` set to the writable workspace: `node --test --test-concurrency=1 scripts/*.test.mjs`. CI/build checks remain required. No assertion or timeout was weakened.
Adjacent DOM/SQL tests: **33 pass / 0 fail / 0 skip**.
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

Same-host uncompressed asset-byte comparison over the eight modified browser JS/CSS sources: **587,944 → 591,802 bytes (+3,858 bytes)**. Baseline fixed at the SHA above. This is an asset-size measurement, not an API latency improvement claim. Stored-dependency queries run only on affected operations when relevant grants are absent; fully granted settlements retain their original query path.

## Release and recovery

All required regression, integration, Chromium, PostgreSQL, Edge, wiring, dependency-audit, build and ticket-policy lanes must pass for the candidate. Do not deploy while any required check is failed/skipped/pending.

After approval by existing task authority and green CI: apply the additive scheduler migration to MemberWebsocket-dev; deploy affected Edge bundles from this exact source; merge to Integrated-Marketing-Platform and verify the CI-gated Netlify preview identity and smoke. These actions are not claimed by this pre-CI record.

Recovery: fix forward by reverting the reviewed frontend/Edge commit and redeploying the previous compatible bundles; scheduler modification changes only dispatch gating and preserves all rows. Do not delete merchant data or rewrite past migrations.

Browser correction: the first Chromium run rejected Playwright toBeDisabled on an option despite its native disabled/hidden properties. The updated assertion checks the native property and actual keyboard/selection behavior. Revoking an already-selected service grant now resets the mode and hides its entire dependent section; its DOM test reproduced the missing reset before the fix. Full CI is re-run on the new candidate.

Deployment routing check: BookingSystem still sent benefits/claims/profile/presence to the production API despite previewApiFunctionUrl. A behavioral test reproduced the wrong destination. The client now honors the existing override and retains the legacy URL when absent; this avoids overwriting production member APIs for preview acceptance.

Disabled point/event overview counters also follow the same grant map; a DOM RED/GREEN assertion covers the point-card and daily-points tiles.

GitHub automated review findings 4423828799/4423828808 were verified and reproduced (three RED tests). The fixed-calendar fetch wrapper now omits a withheld setting and the server preserves an omitted stored flag on edits; forged enables still require calendar. Calendar bonus preflight now matches event type, dates and the target member tier using the existing current_tier_key RPC; VIP-only rules no longer block unrelated ordinary-member point grants. Related suite: 31 pass/0 fail/0 skip. Full candidate CI must run again before release.

## 2026-11-06 latest-base integration (supersedes the historical candidate above)

Baseline: `13fb3b1695bc36b3f1b61a16f5a39557c5539d15`. Reused PR #206 and merged the latest base, preserving phone verification, price publication, themes and expiry features. Only the reviewed source checksum manifest conflicted; both journeys and actual final digests were retained.

Current local evidence (Node v24.22.1): full Node regression **1307 pass / 0 fail / 0 skip**, adjacent DOM/isolated SQL **20 pass / 0 fail / 0 skip**, static build exit 0. Browser and integration dependency audits report zero vulnerabilities. Target-base RED: four dependency cases failed as expected; the candidate passes those cases.

Independent review found five Important issues. Behavioral RED/GREEN fixes cover normalized/unknown benefit kinds, standalone fixed templates in mixed tenants, unchanged withheld booking restrictions and forged clears, actual nested booking responses with preserved RPC selections, and service-type write-response filtering. The nested ticket action disappears with no ticket grant and returns for either grant. New scheduler fixture executes mixed templates, repeat migration, revocation/re-enable and independent tenant jobs in isolated SQL.

Ruling: retain the existing backend architecture and authenticated request adapter; compare hidden persisted rules against trusted tenant data, retain omitted fields and pin optimistic versions. No new permission is derived from a browser flag. A renamed point/event ticket preserves its hidden booking rules; an attempted clear is rejected. Scheduled issuance skips linked templates individually instead of pausing all templates in a tenant.

Same-host raw bytes for the eight modified frontend sources: **589,540 → 593,600 (+4,060)**. No extra browser API request is added. Preservation queries run only for revoked dependencies on the relevant writes; ordinary requests retain their previous path. This measures payload size and makes no latency improvement claim.

Local limitations: Chromium downloaded but process startup failed with SIGTRAP (2 browser cases not executed); the scripts suite ran 138 pass / 1 timeout because the live retired-endpoint HTTP test cannot reach Supabase from this sandbox. Neither is counted as passed; exact-candidate GitHub CI must supply Chromium, PostgreSQL, Deno, live HTTP and all remaining baselines before merge/deployment. No new Supabase migration or Edge deployment was performed during this local verification.

Adjacent baseline finding: phone.send audience routing differs from shared profile bootstrap for merchants using separate LINE channels; it exists in the target base, and real LINE/SMS validation was not performed in this change. This task does not claim to resolve or externally verify that separate flow.
