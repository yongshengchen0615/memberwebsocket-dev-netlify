# LINE capability and booking risk implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issues #124 and #60 on the existing integration branch, preserve security/business invariants and provide a tested preview.

**Architecture:** Extend existing LINE module configuration and booking-risk components. No new services or authentication system. Independent implementation domains may run in parallel under dispatching-parallel-agents; final review and verification are shared.

**Tech Stack:** Existing JavaScript/Deno Edge, PostgreSQL 17, PGlite/JSDOM, Playwright Chromium, Netlify Git branch deployment.

**Spec:** `docs/superpowers/specs/2026-10-25-line-capabilities-booking-risk-design.md` plus GitHub #124/#60 (all existing AC).

## Global Constraints

- Policy default disabled, no retroactive penalties, only new online bookings restricted.
- LINE identity, explicit merchant context, private credentials, server grants and transaction checks remain enforced.
- Preserve reason-required audit, request idempotency, optimistic versions, legacy encrypted scope and existing notification routes.
- Do not send real LINE messages or perform destructive shared-database tests.
- Final CI must include all established jobs with no necessary skips; real Provider checks remain separate.

## Review Focus

- LIFF-only public bootstrap must work even when messaging readiness is false.
- A changed Messaging Channel must never silently retain credentials for another channel.
- A SQL replay/version race must not corrupt other modules or merchants.
- A cancelled confirmation must cause no write and preserve the user's inputs/focus.
- A version conflict must not silently retry or discard a draft before explicit reload.

### Task 1: LINE capability separation (#124)

**Files:** `platform-policy.mjs`, `platform-handler.mjs`, `business-line-settings.js`, minimal readiness/notification consumers, a new additive migration, existing LINE integration/browser/PG fixtures and new capability tests.
**Interfaces:** Consume existing `platform.line.save`; preserve its response shape and scoped credential contract. Produce valid per-module LIFF configuration with `credentialsConfigured=false` when secrets do not exist.

- [ ] Add failing validator/real handler+SQL tests for first LIFF-only calendar and other features, bad Login/LIFF, rejected messaging send, legacy/replay/version/scope preservation.
- [ ] Run and record expected RED failures, implement minimal capability distinction, retain messaging validation and cross-merchant checks.
- [ ] Update only necessary UI required fields/help/readiness; add real browser checks for no-credential save at 390/1280.
- [ ] Run task integration/security tests, record GREEN, review migration upgrade/fresh/replay behavior and commit.

### Task 2: Safe booking risk operations (#60)

**Files:** `admin/booking-risk.js`, `admin/booking-panel.css`, affected risk SQL projection migration only if existing fields lack safe context, `tests/integration/booking_risk_ui.cjs`, `booking_risk_workspace_ux.cjs`, `tests/browser/booking-risk*.spec.cjs` and fixture context.
**Interfaces:** Consume existing `mount(container,{data,request})`; preserve get/save/revoke/release/resolve payloads. Extend only safe display projection if needed.

- [ ] Add failing DOM cases for policy and action confirmations/cancel, field errors, target context, expired/conflict state and focus recovery.
- [ ] Implement explicit enable/disable and per-record reason/target confirmation using existing platform patterns; precise success/failure text and safe refresh.
- [ ] Render available safe member/booking/time/status information without invented values; keep three actions and their effects distinct.
- [ ] Update existing assertions only where confirmation adds an intentional user step, add 390/1280 keyboard flows, run task tests and commit.

### Task 3: Integrate, review, validate and deploy

**Files:** existing workflow test registration, human-journey manifest, versioned evidence/acceptance docs; deployment source only as required.
**Interfaces:** Consume tasks 1/2 unchanged contracts; publish verified exact-SHA preview through existing CI gate.

- [ ] Register all new necessary tests in existing CI, run complete local baseline and build/audits; use pinned Node 22 for PGlite where available.
- [ ] Fresh whole-branch review; fix material findings with RED/GREEN, then rerun all affected checks and final baseline.
- [ ] Push feature branch and create PR to Integrated-Marketing-Platform; require exact-head CI before integration.
- [ ] Apply reviewed additive migration/Edge to authorized dev project, verify catalog and no-auth negative smoke. Integrate through PR and verify exact merge-SHA CI and Netlify branch deploy/digests.
- [ ] Report AC outcomes and actual counts, remaining Provider/human gaps, acceptance URL and revert path. Keep issues open until all required external AC are satisfied; update evidence/status without claiming unperformed checks.
