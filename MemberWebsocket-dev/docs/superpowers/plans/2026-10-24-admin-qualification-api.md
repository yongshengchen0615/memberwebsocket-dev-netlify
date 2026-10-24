# Admin Qualification API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend PR #102 with the independently testable qualification API portion of #97.
**Architecture:** Add explicit actions to the existing handler and reuse qualification SQL RPCs, LINE verifiers and request limits. Keep legacy actions unchanged until the complete multi-merchant rollout.
**Tech Stack:** JavaScript, existing PostgreSQL/PGlite, Node test runner and exact-SHA GitHub CI.
**Spec:** `../specs/2026-10-24-admin-qualification-api-design.md`

## Global Constraints
- Root in this batch means currently enabled Platform total administrator (`platform_is_super_admin`), including approved non-singleton operators; Supabase DBA approval of Platform operators is a separate permission.
- No remote SQL changes, root grants, merchant creation or partial deployment.
- Actor/name come from verified LINE identity; root is rechecked for list and every review/retry.
- No new dependencies; no weakening existing tests or authorization.
- #97 stays in progress and PR #102 stays Draft.

## Review Focus
- Merchant login tokens must not substitute for platform root tokens.
- Client actor, role, display name or business must not alter the trusted qualification identity.
- Replayed requests after suspension/root removal must not restore prior authority.
- Invalid decision/version/UUID/reason must leave state and audit unchanged.
- Missing migration/database failure must fail closed without SQL/token disclosure.

### Task 1: Add and test the qualification API

**Files:** handler `supabase/functions/_shared/platform-handler.mjs`; tests `tests/integration/admin_qualification_api.cjs`; fixture `tests/integration/platform-fixture.cjs`; required CI `.github/workflows/test-memberwebsocket-dev.yml`.

**Interfaces:** existing four `platform_*_admin_qualification` SQL RPCs; actions `platform.qualification.bootstrap/submit/list/review`, returning `{qualification}` or `{qualifications}` in `data`.

- [x] Write AC-MMA-API-001～013 against the production handler/verifiers and real SQL fixture; synthetic LINE HTTP and controlled existing limiter boundary.
- [x] Run the suite and observe expected RED (unknown actions/incorrect Channel/403); invalid scalar-ID/SQL integer regression also failed before correction.
- [x] Add minimal routing, input checks and typed SQL error mapping; use read budgets for bootstrap/list and write budgets for submit/review.
- [ ] Run API + qualification + existing platform suites, all passing with no skips; wire required CI and commit.

### Task 2: Whole-branch review and exact-SHA verification

- [x] Fresh reviewer checks diff against spec and the five review focus items; scalar UUID/integer validation correction verified by RED before fix, GREEN pending final suite.
- [ ] Run required full baseline locally/CI, inspect every job and statistics, record unavailable external checks.
- [ ] Update existing Draft PR and #97 with exact-SHA evidence; verify actual Project status using existing authorized label workflow.

## Execution ledger
- Baseline: merged `Integrated-Marketing-Platform@340d012` into existing `feat/admin-multi-merchant-97`; preserved both sides' required test additions when resolving the sole workflow conflict.
- Ruling: use this fresh task-local clone and existing feature branch instead of creating another worktree; no other user working tree is present.
- Ruling: this additive API batch continues the already requested #97 implementation; it does not relax the full-rollout gate or authorize partial deployment.
- Ruling: qualification review uses the existing current Platform total-administrator permission, including enabled non-singleton operators, matching #97 and merchant review. It does not require the singleton operator-management root; interpreting the historical shorthand otherwise would incorrectly deny authorized total administrators.
- Ruling: fix the reviewer's Minor scalar-ID/SQL integer validation gap in this batch because invalid-input rejection without writes is an explicit acceptance condition; if left open, callers could get misleading 503s or adapter-dependent writes. Four negative tests failed before the fix.
- Review boundaries: live LINE and deployed HTTP are not verified by fixture results; full multi-merchant routing/UI/legacy qualification revocation remains pending, and no partial deployment/merge is allowed. Treating these as complete would expose an incomplete user flow, so PR stays Draft.
- CI reconciliation: first exact-SHA PostgreSQL run failed Q010–Q012 because the newly merged platform fixture migrations require the `maintenance` schema. The PGlite fixture already creates it; the physical-PostgreSQL qualification setup did not. Add the same schema to that disposable setup, preserving all physical-session, state/audit and concurrency assertions. This is a fixture prerequisite correction, not permission relaxation; final CI must rerun all jobs.
