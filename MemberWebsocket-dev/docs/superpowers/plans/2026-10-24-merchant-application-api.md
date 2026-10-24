# Merchant Application API Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and test-driven-development.

**Goal:** Expose independent per-merchant application operations through verified LINE identity.
**Architecture:** Existing platform handler delegates to the four explicit merchant RPCs. SQL retains authoritative authorization and transaction checks; publicTenant projects tenant responses.
**Tech Stack:** Existing JavaScript modules, Node24/22, PostgreSQL17, PGlite, GitHub CI.
**Spec:** `../specs/2026-10-24-merchant-application-api-design.md` and #97 AC-002/003/004/006/008.

## Global Constraints
- Keep Draft #102; no partial deploy or merge, no remote SQL or LINE writes.
- Account-level merchant actions reject business routes and client-supplied identity.
- Current service-role SQL functions remain authority; no new dependencies or grants.
- Unicode SQL limits, positive int32 versions and exact eight boolean grants.

## Review Focus
- Business/channel spoofing must never select a different identity verifier.
- Suspended qualification or revoked reviewer denies retries of old requests.
- Raw tenant internals must not escape list/get/submit/review responses.
- Malformed selectors/versions and review grants fail before a writer RPC.
- Approving B cannot reuse A's grants/schema or change A's application.

### Task 1: End-to-end handler contract
Files: `tests/integration/merchant_application_api.cjs`; `supabase/functions/_shared/platform-handler.mjs`; `.github/workflows/test-memberwebsocket-dev.yml`.
Consumes four SQL RPCs from `20261024091504_merchant_application_multi_owner.sql`.
Produces `platform.merchant.list/get/submit/review` with `data.applications` or `data.application`.
- [x] Add tests using the real handler, real LINE verifier, real SQL and provisioner; stub only LINE HTTP and the separately tested limiter.
- [x] Run new suite and observe missing-route failures; preserve RED evidence.
- [x] Add minimal validation/routing/sanitization/error mapping; observe GREEN.
- [x] Wire suite into required CI and run related qualification/merchant baseline.

### Task 2: Full verification and handoff
- [ ] Full Node/DOM/SQL/build/syntax locally; all existing PG17/Chromium/Edge/audit lanes on exact-SHA CI.
- [ ] Whole-branch review; fix important defects with RED→GREEN.
- [ ] Update Draft #102 and #97/#39 with exact SHA/evidence and remaining context/UI gaps.

## Ledger
- Base feature SHA 0dd1c8e; merged latest integration 2e66ffb without conflicts.
- Ruling: task-local fresh clone/feature branch preserves isolation; no extra worktree or main-branch edits.
- Ruling: user requested ongoing implementation; preserve the existing approved #97 architecture, do not repeat design approvals for this follow-up batch.
- Baseline and final evidence live under `/workspace/scratch/61a204b07d59/evidence` during execution; durable test results will be in GitHub Actions.
- Task 1 baseline: qualification SQL/API and merchant SQL 39 pass, 0 fail/skip. RED new HTTP suite 1 pass/10 fail/0 skip (missing route fell through to Platform role denial); GREEN 11 pass/0 fail/0 skip with actual provisioner and audit rollback. Existing Node baseline 1047/0/0. Full final CI pending, no rollout claim.
- Environment ruling: this sandbox lacks `/tmp`; unchanged build tests failed mkdtemp with ENOENT. Rerun using workspace TMPDIR, without changing product code or assertions.
- Independent review found an inherited integration regression: the new root application SQL includes raw tenant rows, and bootstrap forwarded them unchanged. HTTP-012 reproduces a raw runtime_schema in the response (RED). Project all nested application tenants through publicTenant and preserve root reviewer applicantLineUserId/tenantId. Full final verification follows this fix; earlier full runs do not represent the fixed candidate.
- Independent review also reproduced a migration-gap race: legacy submissions/reviews can commit after foundation backfill. M022 RED failed NOT NULL and M023 RED retained a pending qualification after legacy approval. Catch up missing/untouched legacy qualifications under the application ALTER lock, preserving explicit or version>1 decisions; add physical two-TCP M024 to verify actual lock wait and final state. Remote SELECT confirmed neither migration is applied, so this edits an unreleased candidate only.
