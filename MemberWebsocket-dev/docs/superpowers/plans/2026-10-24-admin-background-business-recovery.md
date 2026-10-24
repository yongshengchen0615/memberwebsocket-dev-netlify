# Background Merchant Recovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this single task; use test-driven-development and one independent whole-branch review.

**Goal:** A background admin runner whose merchant disappears must stop, retaining merchant scope, instead of navigating to an unscoped data plane.
**Architecture:** Keep the PR #119 ordinary-entry recovery. Exclude background runners from `recoverMissingBusinessEntry(error)` and use the existing boot error UI.
**Tech Stack:** Existing JavaScript, Node/JSDOM, Chromium, GitHub CI and Netlify verified branch deploy.
**Spec:** #41 resource isolation and #119 config recovery contract; the design and acceptance below define this bounded fix.

## Design and constraints
- Base: `fa4d7d0f38e7601c602449111b919fb6faf5d167`; continue the user's authorized integration/Preview work in a new branch of this task-local clone.
- A background URL carries `e2eBackgroundRunner=1` and a nonempty `e2eRunId`; it inherits a verified parent session. BusinessContext injects the URL's merchant into requests; `config.business` alone does not supply request scope.
- An ordinary missing-merchant entry may navigate to the unscoped authenticated application entry. A background runner must keep its URL, show the original error, remain not-ready, and make no unscoped retry.
- Alternatives: clearing background parameters would start an unrelated interactive login flow; retaining parameters while dropping business recreates the defect. Fail closed is the smallest compatible choice.
- No server authorization, LINE configuration, database, dependencies or merchant provisioning changes.

## Review focus
1. Background missing-business response: no navigation, one scoped bootstrap, no ready signal.
2. Ordinary missing-business response: original single navigation remains.
3. Valid background handoff: existing successful startup remains.
4. Permission/network errors: no new recovery or implicit retry.
5. Cache revision and human coverage digest: final built script is the reviewed script.

### Task 1: Keep failed background sessions scoped

**Files:** `admin/app.js`, `admin/index.html`, `tests/integration/admin_startup.cjs`, `tests/browser/product-platform.spec.cjs`, `tests/browser/admin-human-coverage.json` (under MemberWebsocket-dev).
**Interface:** `recoverMissingBusinessEntry(error)` returns false for `isBackgroundE2ERunner()`; existing caller displays `handleBootError(error)`.

- [x] Add the background missing-business regression; assert zero navigation, one bootstrap, no realtime/ready state and visible original error. Observe RED against base.
- [x] Add only the runner guard; preserve ordinary recovery. Observe GREEN with existing startup/background tests.
- [ ] Add Chromium transport coverage proving no business-less bootstrap after the missing-merchant response; update asset revision and coverage digest.
- [ ] Run final full established CI (all required jobs), build/policy and independent review. No skipped check counts as passing.
- [ ] Merge to Integrated-Marketing-Platform after same-SHA checks and review; inspect merged-SHA CI and exact Netlify deploy, then run 21-check smoke and read back Project status.

## Execution ledger
- Baseline read: PR #119 same-head full CI 11/11 success; Node 1031, DOM/SQL 464, PostgreSQL 11, Chromium 285, build 91; all zero failed/skipped. These are pre-fix evidence only.
- Ruling: use this clean task-local clone and a new feature branch; no unrelated user checkout is present. Cost if wrong: shared branch work could be overwritten, avoided by expected-head/fast-forward checks and no force-push.
- Ruling: a runner failure must stay terminal rather than restarting interactive LINE login. This preserves the existing runner error contract; changing that UX would need separate acceptance.

- Task 1: RED at base: background fixture navigated once instead of zero; exit 1. After guard, startup/background tests 17 passed / 0 failed / 0 skipped; Node regression 1031 / 0 / 0; syntax and diff checks passed.
- Local Chromium: installation completed the browser payload but ancillary download/lock failed; direct Chromium launch in this restricted container exits SIGTRAP before opening either page. Both targeted browser cases are blocked locally, not passing. Required GitHub Chromium must exercise the final tests before merge. No test or deadline was weakened.
- Baseline build single run failed because /tmp is absent; unchanged tests passed 91 / 0 / 0 with TMPDIR inside scratch. Use that environment for subsequent local build checks.
- Initial Node regression while coverage hashes were stale failed its integrity assertion. Refreshed both reviewed source digests and reran the entire Node suite: 1031 / 0 / 0.
