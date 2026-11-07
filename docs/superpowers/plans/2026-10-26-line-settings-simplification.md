# LINE Settings Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify both actual merchant LINE settings entries while retaining working login, scoped feature links, notifications and Webhook diagnostics.

**Architecture:** Reuse `BusinessLineSettings` for modern per-feature capabilities. Add a scoped authenticated adapter for the productized merchant shell; preserve the legacy transport/capability fallback. Simplify entry fields and disclose advanced operations without changing saved configuration automatically.

**Tech Stack:** Existing browser JavaScript/CSS, JSDOM, PGlite/PostgreSQL, Playwright and GitHub Actions. No new dependencies or database changes.

**Spec:** `docs/superpowers/specs/2026-10-26-line-settings-simplification-design.md` (approved by the user's request to merge the implementation into Integrated-Marketing-Platform for acceptance).

## Global Constraints

- Only granted LINE-capable features; no new settings page or login session.
- Blank secrets retain existing values under existing contracts; never refill them.
- Preserve merchant/feature/purpose scope, requestId retry and expectedVersion.
- Keep notification saves, tests and Webhook checks explicit; no live sends in development.
- Separate configuration, Provider acceptance, signed ingress and human receipt.
- No database migration, credential consolidation or fixed two-OA migration.
- Existing APIs and complete CI remain required before integration/deployment.

## Review Focus

- A stale async result must not repopulate a cleared or newly mounted merchant.
- Collapsed invalid fields must become visible and focused before blocking save.
- A LIFF URL paste must reject misleading hosts, queries and mismatched manual Channel values.
- Existing custom notification routes and unsaved drafts survive unrelated feature saves.
- The actual selected-merchant shell must use feature saves without a shared Messaging prerequisite, while legacy capability remains usable.

---

### Task 1: Simple feature renderer and scoped lifecycle

**Files:** Modify `MemberWebsocket-dev/admin/business-line-settings.js` and `.css`; test `MemberWebsocket-dev/tests/integration/line_settings_simple.cjs`.

**Interfaces:** Consume existing bootstrap tenant/features and API responses. Produce `BusinessLineSettings.mount({root,request,data,onUpdate,onSelect})`, `clear()`, retained `apply(data)` and `select(feature)`; adapter request resolves response data and owns authentication/business context.

- [ ] Add real-handler/PGlite/JSDOM tests for LIFF-only entry, exact LIFF URL normalization, manual mismatch, first administrator setup, advanced-field focus, preserved notification configuration/drafts and stale result after clear/remount.
- [ ] Run `node --test MemberWebsocket-dev/tests/integration/line_settings_simple.cjs` on Node22 and observe expected missing behavior.
- [ ] Implement simple purpose-first layout, scoped roots/IDs and generation-fenced asynchronous operations. Preserve existing payload construction, retry and secret handling.
- [ ] Run the new tests plus existing business_line_settings, line_capabilities_ui, line_webhook_ui and line_settings_keyboard suites; expect all pass.
- [ ] Commit renderer and tests; ledger actual commands/results.

### Task 2: Actual merchant shell integration

**Files:** Modify `MemberWebsocket-dev/platform/app.js`, `admin/workspace.html`, `admin/productized-workspace.js` if needed; extend `line_settings_simple.cjs` and existing merchant integration tests.

**Interfaces:** Consume Task1 mount/clear API. Adapter uses the shell's current verified idToken and explicit selectedBusiness through existing request(); onUpdate updates merchant/version. Existing legacy form remains available only when `moduleLine` capability is absent.

- [ ] Add actual workspace DOM + real handler/SQL cases proving fresh LIFF-only setup, shared-first gate removal, saved feature public entry, notification/Webhook reachability, revocation clearing and legacy fallback.
- [ ] Observe RED before shell changes.
- [ ] Load the existing renderer/CSS on workspace, mount it for modern merchant capabilities and clear it on authorization loss. Update readiness/checklist/navigation for feature capability without inventing Provider success.
- [ ] Run all focused cases and existing merchant_workspace_ui/product_admin_ui integration; expect all pass.
- [ ] Commit shell integration and ledger evidence.

### Task 3: Full application browser acceptance and release

**Files:** Extend browser specs for actual merchant workspace and simple renderer; update existing browser journeys for deliberate disclosure/labels; update `tests/admin-human-coverage.json` and required CI wiring.

**Interfaces:** Consume Tasks1/2 actual HTML/JS and existing isolated handler/SQL fixture.

- [ ] Add 390/1280 real workspace browser journeys for LIFF URL entry with no Messaging credentials, correct public feature URL, advanced validation focus, existing notification purposes and no overflow.
- [ ] Run focused browser cases where the environment permits; actual GitHub Chromium remains mandatory if local browser launch is blocked.
- [ ] Run established Node, DOM/PGlite, PostgreSQL, Edge, Chromium, syntax, wiring, build and audits on the final candidate. Do not weaken existing behavioral assertions.
- [ ] Obtain one independent whole-branch review, fix Important findings with RED→GREEN and rerun applicable/full required gates.
- [ ] Open PR targeting Integrated-Marketing-Platform, confirm exact-SHA CI, merge as explicitly authorized, and verify merged CI plus native Netlify deployment, source/assets and read-only smoke. Record real LINE acceptance separately.
- [ ] Update #59 with exact evidence and acceptance path; retain pending external/fixed-account scope. Report the development URL and recovery by reverting the UI commit through CI.
