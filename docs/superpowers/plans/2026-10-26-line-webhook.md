# LINE Webhook Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. Steps use checkbox syntax.

**Goal:** Implement #144 secure event receipts and own-merchant diagnostics without business side effects.

**Architecture:** Supabase Edge ingress uses Web Crypto and private SQL receipts. Existing platform handler and LINE settings expose authorized diagnostics and explicit read-only Provider checks.

**Tech Stack:** Node 24, JavaScript modules, Deno, Supabase, PostgreSQL 17, PGlite, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-26-line-webhook-design.md`

## Global Constraints

- Reuse existing AES credential scopes and current merchant authorization.
- No direct business mutation, sends, Console changes or production deployment. Reuse the test project approved in #48 after exact-source reconciliation.
- Keep LIFF-only configuration optional; use existing LINE settings tab.
- Unverified/blocked checks do not count as passed.

## Review Focus

- Untrusted destination must never establish tenant identity or poison its health.
- Credential rotation/revocation between verification and commit must reject ingestion.
- Same Channel across modules is allowed; cross-merchant claims race safely.
- Failed persistence must return retryable failure, including empty provider verification requests.
- Diagnostics must not reveal envelopes, token, secret, message bodies or foreign merchant data.

### Task 1: Ingress contract and private persistence

**Files:** `_shared/line-webhook.mjs`, `line-webhook/index.ts`, `supabase/config.toml`, generated `*_line_webhook.sql`, `tests/line_webhook.test.js`, integration fixture/cases and PostgreSQL counterpart.

**Interfaces:** `createLineWebhookHandler({db,encryptionKey}) -> Request handler`; service-only candidate and ingest RPCs; `platform_line_webhook_status/check` RPCs return allowlisted JSON.

- [ ] Write receiver tests: valid HMAC over original UTF-8 bytes, zero events, bad/duplicate signatures, limits, missing IDs, unknown type, timeout, storage failure, rotation.
- [ ] Run Node test and observe missing module failure.
- [ ] Write SQL cases: channel uniqueness, direct roles, authorized bind/status, duplicate receipts, current qualification, expiry, rotation and atomic rollback.
- [ ] Run and observe missing migration/function failure.
- [ ] Implement minimal terminal receipt receiver and migration.
- [ ] Run targeted Node/PGlite and physical PostgreSQL CI tests.

### Task 2: Authorized diagnostics and existing settings

**Files:** `_shared/platform-handler.mjs`, `_shared/line-webhook-diagnostics.mjs`, `admin/business-line-settings.js`, API integration and browser tests.

**Interfaces:** `platform.webhook.status/check` consumes feature/business + verified identity; check uses existing token verification + GET bot/info. Returns configuration/API/ingress/human states + endpoint and minimal health.

- [ ] Write real-handler SQL tests for own merchant success, revoked/foreign/disabled denial, redaction, API failure and no sends.
- [ ] Observe failure before implementing diagnostics.
- [ ] Implement service-only authorization and summary, then compact existing-tab controls.
- [ ] Add Chromium 390/1280 tests for check/status/copy, LIFF optional state and width.
- [ ] Run targeted API/UI tests and record evidence.

### Task 3: Full baseline and delivery

**Files:** established CI test lanes, validation report and rollout notes.

- [ ] Wire every new Node/PGlite/PostgreSQL/Edge/browser case into established CI.
- [ ] Run full baseline + build + security dependency audits against final code; inspect failures.
- [ ] Whole-branch review and fix important findings with regression tests.
- [ ] Commit/push feature branch; create draft PR to Integrated-Marketing-Platform and inspect exact-SHA CI/Preview status.
- [ ] Record AC results, remaining isolated deployment/Provider gates, SHA, commands and recovery by reverting the feature commit.
