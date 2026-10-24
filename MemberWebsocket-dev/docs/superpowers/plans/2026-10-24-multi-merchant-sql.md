# Multi-Merchant SQL Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and test-driven-development; one independent whole-branch review before delivery.

**Goal:** A qualified owner can submit and independently review multiple merchants without reusing an earlier approval or an implicit first merchant.
**Architecture:** Extend the existing applications table with qualification ownership and optimistic versions. Introduce explicit merchant RPCs; stop legacy mutations and fail closed on ambiguous legacy owner lookups. Reuse the real tenant provisioner and per-tenant grants. This is the next already-authorized #97 batch, not an independently deployable rollout.
**Tech Stack:** Existing PostgreSQL 17, SQL, PGlite, Node, GitHub CI; no new application dependencies.
**Spec:** #97 AC-002/003/004/006/008/009; exact batch contract below. Qualification design is `../specs/2026-10-24-admin-qualification-api-design.md`.

## Global Constraints and batch contract
- Continue existing Draft PR #102; merge Integrated-Marketing-Platform@8ecaa54 into its feature branch first. Do not merge or deploy the partial journey, change remote Supabase, clear data, or change LINE settings.
- Service-only SECURITY INVOKER RPCs, empty search_path, existing private-table RLS. Actor is supplied only by the already verified server identity; browser roles have no EXECUTE/table access.
- Preserve existing applications, tenant ownership, private business rows and grants. Replace applicant UNIQUE with a qualification-owner FK plus indexed nonunique owner lookup; keep slug and tenant uniqueness.
- `platform_submit_merchant_application(p_actor text,p_name text,p_slug text,p_request_id uuid,p_application_id uuid default null,p_expected_version integer default null) -> jsonb`: new creates pending; explicit rejected resubmission needs ID/version. No implicit resubmission or approval.
- `platform_my_merchant_applications(p_actor text) -> setof jsonb` and `platform_get_merchant_application(p_actor text,p_application_id uuid) -> jsonb`: qualified owner only; explicit ID may never select someone else's application. Return ID/name/slug/status/version/review metadata and its own tenant.
- `platform_review_merchant_application(p_actor text,p_application_id uuid,p_expected_version integer,p_decision text,p_reason text,p_features jsonb,p_request_id uuid) -> jsonb`: current Platform super admin only. pending -> approved/rejected, reason required for rejection, exact complete feature map required only for approval; approval provisions one new tenant in the same transaction.
- Request IDs bind actor/operation/canonical payload; retries recheck current qualification/root permission and return current application, not stale approval. Lock request -> qualification -> application -> tenant; row locks serialize against qualification suspension.
- Old 3-arg submit and 4-arg approval must reject with PLATFORM_MERCHANT_API_REQUIRED. Legacy my_application/settings/context must reject ambiguous ownership with PLATFORM_BUSINESS_SELECTION_REQUIRED. Preserve single-merchant read/settings contracts; all remaining runtime/handler/UI qualification gates are the next batch.
- Do not infer every endpoint's access from these RPC tests. Direct root tenant creation / feature operations and data-plane qualification revocation are not complete in this batch and block rollout.

## Review Focus
1. Retry after qualification suspension/root revocation must not grant prior authority.
2. Concurrent same request, slug and opposing reviews must produce one consistent final row/audit/request set.
3. Rejected resubmission needs the exact owner's ID and current version; no approved application is repurposed.
4. Provisioning or audit failure rolls back application, tenant, schema, grants and request together.
5. Legacy LINE/notification/context operations must not select an arbitrary owner row; existing single-merchant values and expiry guards remain.

### Task 1: Persistence, explicit RPCs and legacy safety

**Files:** generated `supabase/migrations/*_merchant_application_multi_owner.sql`; `tests/integration/merchant_applications.cjs`; shared fixture `tests/integration/fixtures/merchant-applications.cjs`; this plan.
**Interfaces:** consumes existing qualification table, requests/audit and real platform_provision_business; produces the four explicit RPCs above.

- [x] Write M001–M013 for independent B pending/A unchanged, qualification states, request conflicts/replay, duplicate slug, own-list/foreign ID, rejected resubmit/version, root-only review, per-merchant grants/provisioning, audit/provision rollback, legacy ambiguity/expiry, browser-role denial, upgrade and migration rollback.
- [x] Observe RED against current baseline; add minimal SQL; observe GREEN. Never replace real provisioning with a success stub.
- [x] Wire the new SQL suite into required CI; run qualification/platform/runtime regressions and full Node baseline.

### Task 2: Physical PostgreSQL races, restore and final review

**Files:** `tests/integration/postgres/merchant-applications.cjs`; existing PostgreSQL CI job.
**Interfaces:** consumes Task 1 RPCs; use existing disposable database harness and two distinct TCP sessions.

- [x] Test M014 same request concurrent submission, M015 same slug competing owners, M016 same-version approve/reject, M017 suspension vs submit, M018 pg_dump/pg_restore preserves two merchants, isolation, constraints and permissions.
- [ ] Confirm actual Lock wait and final rows/audits; run all required CI on the final tree, including existing physical baseline and Chromium.
- [ ] Independent review; fix Important/Critical via RED→GREEN, then full CI; update Draft PR #102 and #97 with exact SHA, counts, failures and remaining rollout gaps.

## Execution ledger
- Fresh branch base before sync: 7b50509. Integrated baseline 8ecaa54 merged without conflicts; qualification/API baseline 25/0/0 on Node24.22.1.
- Ruling: existing task-local clone/feature branch is isolated enough; no new worktree or unrelated checkout changes. Wrong choice could overwrite shared work; no force push and expected-head ref updates prevent that.
- Ruling: versioned explicit RPCs replace blind legacy writers; incomplete UI may fail until rollout, so the whole PR remains Draft and cannot deploy independently. That temporary incompatibility is intentionally contained to the candidate branch.
- Ruling: use qualified-owner locks and preserve original tenant provisioning; the current runtime's complete endpoint revocation remains a named follow-up, never an implicit claim from SQL tests.

- Task 1: migration created by Supabase CLI 2.79.0 as 20261024091504_merchant_application_multi_owner.sql. Current CLI crashed at startup in this container; the pinned prior CLI successfully generated the file without contacting a project.
- Task 1: all 13 acceptance tests failed against the empty migration (0 pass/13 fail/0 skip), then 13/0/0 passed with real provisioner/schema/audit rollback on Node22. The first implementation run was 11/2/0 because snapshots compared JSON timestamp strings with PGlite typed Date rows; captured the original typed rows before migration instead, preserving exact before/after assertions. No production logic changed to satisfy that representation mismatch.
- Task 1: full Node baseline 1031/0/0, syntax and diff checks passed. Additional legacy expiry and successful notification-save behavior, non-singleton Platform reviewer and browser table denial are covered.
- Task 2: seven distinct-TCP PostgreSQL cases M014–018 are required in CI; no local Docker/psql service exists, so they are pending, never counted passing.
- Ruling: legacy settings acquire request lock before the exclusive qualification lock, preventing request/qualification inversion; exclusive qualification lock serializes ambiguous-owner checks against new merchant approval. Routing-only business_context takes one SQL snapshot and never grants access.
- Ruling: direct root tenant writes and full data-plane qualification revocation remain rollout gaps, explicitly outside this batch; no partial remote deployment may expose those gaps.
