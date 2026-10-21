# Booking notifications and no-show policy — 2026-10-21

## Scope and invariants

Target branch: `Integrated-Marketing-Platform`. Baseline: `381044a8cd100ec6cd1ac723008b2fa6cede6b22`.

| Concern | Contract |
| --- | --- |
| Goal | New member booking creates an admin notification; confirmation and effective admin changes notify that booking's member. |
| Identity | Existing LINE verification and active admin/member checks remain mandatory. Caller recipient/token/actor never select the dispatch scope. |
| Ownership | Existing private business schemas isolate policies, bookings, events, restrictions and appeals. |
| State | A committed booking survives dispatch failure. One effective no-show event per booking; expiry uses an absolute UTC timestamp. |
| Data | No historical no-show backfill. Policy starts disabled with no invented thresholds. Enabling starts a new recording window. |
| Restrictions | New regular online bookings are blocked in a DB trigger while a restriction is active. Existing booking changes, login, points, tickets and receipt registration remain available. |
| Policy changes | Existing restrictions keep the duration and policy snapshot from their creation; disabling the policy suspends enforcement. Manual release retains counted events, so a later new no-show may reach the threshold again. |
| Revocation | Keep the original no-show booking history, revoke the counted event, recalculate active restrictions against their original snapshot, and retain audit. |
| Appeals | One appeal per restriction. A review response records an outcome; revocation or manual release restores eligibility separately. |

## Root cause and notification flow

`notice_enqueue` recognized `BOOKING_ITEMS_UPDATED` but omitted `BOOKING_PARTICIPANT_TECHNICIANS_UPDATED` and admin `BOOKING_UPDATED`. The isolated red test proves the missing member notification after a technician change. The report that creation waits until confirmation has **not** been reproduced against a real LINE account; existing live admin/member outbox rows were accepted and cron was healthy during read-only inventory.

Booking request → authenticated tenant handler → database commit + deferred notification trigger → durable tenant `notice_outbox` → best-effort `platform_dispatch_booking` wake → secret-authenticated Edge dispatcher → module/purpose token → server-selected recipient → `finish_booking_notification`.

The existing one-minute cron recovers a lost wake. Modifications retain the existing 15-second coalescing window. Claim leases and the same outbox UUID/LINE retry key survive retries. No-op participant service/technician updates return the unchanged booking. This does not assert provider-level exactly-once delivery or real end-user receipt.

## Migrations and recovery

Apply, in order:

1. `20261021045559_booking_notification_event_repair.sql`: update current tenants and the future-business template; service-role-only wake RPC.
2. `20261021045611_booking_no_show_policy.sql`: additive private tables/functions/triggers, disabled policy for existing and newly approved businesses.

No business records, Auth users, Storage objects, secrets or super-admin grants are deleted or replaced.

For policy rollback, use the authorized management UI to disable the policy; retain events, restrictions and appeals for audit. For a bad published frontend/Edge version, revert the code commit and redeploy the prior source through CI. Keep additive DB objects so old code remains compatible. Database errors abort each migration transaction. Do not drop business schemas or run a global reset as recovery.

## Acceptance and verification

| AC | Tests / evidence source |
| --- | --- |
| AC-188-001–004 | `tests/integration/booking_notification_events.cjs`: create, confirm, effective technician change, no-op, cancellation and recipient checks. |
| AC-188-005–008 | Same suite: rollback, wrong actor, tenant wake gating, leases, retry/backoff, stale worker; `booking_notification_wake.test.js` and existing Deno LINE delivery fault tests. |
| AC-173-001–008 | `tests/integration/booking_no_show_policy.cjs`: disabled/blank defaults, invalid policy, atomic duplicate mark, threshold, blocked creation, appeal replay, exact expiry boundary, revoked count/audit and anon/authenticated denial. |
| AC-173 UI | `booking_risk_ui.cjs`; `tests/browser/booking-risk.spec.cjs`, widths 390/1280, SQL-backed component journeys. |
| Existing isolation | `tests/integration/business-runtime.cjs`: 69 RLS tables (65 existing + 4 risk tables), 257 private functions (251 existing + 6 risk functions), foreign admins/FKs/storage boundaries. |
| Full baseline | `.github/workflows/test-memberwebsocket-dev.yml`: regression, DOM/PGlite, real Chromium fixtures, syntax, Deno, wiring and dependency audit. All existing cases remain required. |
| Deployment | `.github/workflows/publish-platform-preview.yml`: waits for three exact-SHA CI workflows, publishes the integrated alias, verifies commit badge/assets and protected API. |

Historical cache-version tests were updated to require the new exact suffix; structural tests were updated for the four additional RLS tables and six additional isolated functions. No assertions or legacy behavior tests were removed.

Baseline executed locally before changes: Node 1,011 pass / 0 fail / 0 skip; DOM/PostgreSQL snapshot integration 439 pass / 0 fail / 0 skip. Local Chromium could not launch (SIGTRAP); GitHub Chromium results are required. PGlite is real embedded PostgreSQL using the repository's canonical snapshot, **not** a complete fresh managed Supabase stack or multi-session concurrency proof.

## External acceptance still required

- Approved LINE OA/member test accounts and de-identified actual receipt evidence; mocks and accepted outbox state do not prove a person received a message.
- A dedicated disposable Supabase project/branch for full empty-database migration, upgrade, parallel-session race and backup/restore exercises. No production destructive tests.
- Business-selected no-show threshold/window/period/grace/contact values before enabling any live restriction. The deployment leaves all policies disabled.

## #190 / #180 sandbox-reset blocker

#180 has not supplied a resource disposition decision or named an isolated synthetic sandbox. #190 only authorizes planning/inventory until those dependencies exist. No reset endpoint, dry-run against production, production delete, backup export or manual super-admin grant is performed in this release.

Read-only schema inventory observed: public 62 tables/62 RLS; business namespace 65/65 before this release; platform_private 9/9; auth 27 tables (managed by Supabase); storage 8/8. The existing `platform-business-runtime` cron is active each minute. Reset planning must separately classify Auth users/identities/sessions, business tables/FKs, legal/audit records, Storage objects, outbox/schedulers, LINE ownership and encrypted credentials. Infrastructure, deployment configuration and secret names/values need an explicit preserve/rotate decision. No secret values are included here.

Required next steps for #190: decide per-resource delete/anonymize/retain/manual treatment in #180; identify approved sandbox reference; prove dispatch is disabled; build read-only fingerprints and a verified encrypted backup; rehearse restoration before any reset implementation or execution. Production reset stays outside this card's authorization.
