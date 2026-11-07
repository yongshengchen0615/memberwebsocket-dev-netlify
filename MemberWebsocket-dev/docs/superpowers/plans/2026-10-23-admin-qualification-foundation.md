# Admin Qualification Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver #97's independently testable SQL qualification foundation in a Draft PR.
**Architecture:** Add a private, versioned qualification ledger and service-only invoker RPCs without switching legacy merchant behavior. Transactions and request locks prevent duplicate transitions.
**Tech Stack:** PostgreSQL 17, existing PGlite 0.3.14, Node test runner, GitHub Actions.
**Spec:** `../specs/2026-10-23-admin-qualification-foundation-design.md`

## Global Constraints
- Keep existing merchant applications, tenants, features and business data unchanged.
- Do not connect Edge/UI or deploy this partial foundation to Supabase/Netlify.
- No new runtime dependency, no root auto-grant, no public RPC access.
- Final exact-SHA CI must pass; #97 remains in progress.

## Review Focus
- Absent or malformed actors must not become approved or expose another applicant.
- Idempotent retries after suspension must not return stale approval.
- Concurrent review/version conflicts must not duplicate approvals/audits.
- Backfill must preserve approved/pending/rejected meanings and original rows.
- Direct anon/authenticated access and non-root reviews must fail.

### Task 1: Versioned qualification SQL and regression integration

**Files:**
- Create: CLI-generated `supabase/migrations/*_admin_qualification_foundation.sql`
- Create: `tests/integration/admin_qualification.cjs`
- Create: `tests/integration/postgres/admin-qualification.cjs` (three real two-session races)
- Modify: `.github/workflows/test-memberwebsocket-dev.yml`

**Interfaces:**
- Consumes: existing `platform_is_super_admin(text)`, private requests/audit tables, platform fixture.
- Produces: the four SQL RPC signatures in the spec; none are called by existing Edge/UI yet.

- [x] Write SQL behavior tests covering pure reads, explicit submission, root review, illegal transitions, rejection/resubmission, suspension/retry, version/request conflicts, privileges, backfill and atomic rollback.
- [x] Run `node --test MemberWebsocket-dev/tests/integration/admin_qualification.cjs`; expect RED because the qualification RPCs do not exist.
- [x] Generate migration with Supabase CLI and implement the specified SQL.
- [x] Run the new suite plus `product_platform.cjs`; expect all pass, zero fail/skip.
- [ ] Wire the suite into required CI, run full project checks at final SHA, and commit.
- [ ] Require PostgreSQL 17 Q010–Q012 in CI: concurrent submissions, conflicting decisions and identical approval retries. No synthetic single-session substitute.

### Task 2: Independent review and evidence delivery

**Files:**
- Modify: this plan's completion record, Draft PR and Issue #97 progress (preserve existing history).

**Interfaces:**
- Consumes: Task 1's SQL and test results.
- Produces: reviewable Draft PR with exact-SHA CI evidence and explicit remaining #97 scope.

- [x] Obtain independent code review; fix material findings with RED→GREEN regression evidence. No material findings.
- [ ] Push isolated branch, open Draft PR targeting `Integrated-Marketing-Platform`, and verify required final SHA workflows.
- [ ] Read back PR/Issue updates; leave #97 in progress and leave deployed systems untouched.

## Current evidence and remaining gate
Code commit `ecdb87508140b4377c26652d2ecef1724f7ce5cb`: Node 1031/1031, full DOM/SQL 461/461, build/release 89/89, syntax/wiring pass, integration dependency audit 0 vulnerabilities. Independent review found no Critical/Important/Minor findings. See `../../validation/admin-qualification-20261023.md`.

Automatic approval review rejected the isolated feature-branch push because source-code publication to the GitHub destination was not explicitly authorized. No alternate write route was used. No remote branch/PR or exact-SHA CI exists yet. PostgreSQL 17 races, Chromium and Edge CI remain unverified for this candidate; do not claim full #97 acceptance or deploy this foundation alone.
