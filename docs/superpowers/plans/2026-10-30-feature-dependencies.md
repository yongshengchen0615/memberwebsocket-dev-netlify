# Feature dependency authorization implementation plan

> Execute inline with superpowers:executing-plans; use TDD and one independent final review.

**Goal:** A granted module exposes only integrations whose dependencies are also granted.
**Architecture:** Extend the existing action policy and business workspace. Filter current cross-module reads at the authenticated boundary; retain stored records. No new database, framework, subscription, or paid environment.
**Tech stack:** Existing vanilla JavaScript, Supabase Edge TypeScript, Node tests, JSDOM, Playwright, PostgreSQL CI.
**Spec:** User request in this task: unapproved functions and their integrations cannot be used, including points integrations when points is disabled.

## Baseline and constraints

- Source/target: Integrated-Marketing-Platform, 4d51998967a0b7df7148490426465e843788ada4. Isolated fresh clone and fix/feature-dependencies-20261030 branch.
- Baseline Node regression: 1191 pass, 0 fail, 0 skip. Project #5 API is blocked by 403; do not fabricate card transitions.
- Keep tenant identity, revocation, transactions, historical records, and legacy unscoped behavior.
- Only literal true grants permit an integration. No destructive production testing.
- Compare frontend bytes and fixed-fixture policy throughput before/after; do not claim acceleration.

## Acceptance and impact

| ID | Given / When / Then | Test |
|---|---|---|
| AC-001 | Given membership without points, when opening grants/history, then points controls and current points data are absent; service minutes remain available | policy, DOM, browser |
| AC-002 | Given booking without points/events/calendar, when reading benefits or submitting forged selections, then unavailable benefits are absent and writes reject before dispatch | policy, Edge |
| AC-003 | Given a disabled dependency, when saving automatic point rewards, calendar bonuses, ticket calendar links or ticket booking restrictions, then cross-feature writes are rejected; standalone writes remain available | policy, DOM |
| AC-004 | Given grants revoked/re-enabled and late mounted controls, when the current bootstrap applies, then dependent controls update without losing stored records | DOM, browser |
| AC-005 | Given fully granted or legacy context, when existing journeys run, then established regression/integration/DB/browser/Edge/build/audit CI remains green | complete CI |

## Review focus

- Existing saved integrations after revocation must not silently execute disabled side effects.
- Disabled controls must not be re-exposed by modal reset or late extension mounting.
- Hiding optional controls must not erase stored configuration on unrelated edits.
- Standalone permitted operations must not acquire unrelated module dependencies.
- Nested and unknown benefit types must not bypass fail-closed authorization.

## Tasks

### Task 1: Server dependency contracts

- [ ] Add failing behavioral tests for payload-derived dependencies and filtered cross-module reads.
- [ ] Extend business-policy.mjs and authenticated response routing with minimal dependency checks.
- [ ] Run related Node/Edge tests and record RED/GREEN evidence.

### Task 2: Dependent admin controls

- [ ] Add failing DOM tests using real admin HTML and BusinessWorkspace, covering revocation/re-enable, late controls, and independent operations.
- [ ] Extend existing workspace control gates and payload producers; avoid extra denied optional API calls.
- [ ] Add browser acceptance and execute relevant DOM/browser tests.

### Task 3: Verification and delivery

- [ ] Run complete Node/build checks locally; use exact-SHA CI for all established integration/Postgres/browser/Edge/audit lanes.
- [ ] Independent review, fix blocking findings with RED/GREEN tests.
- [ ] Create PR with actual evidence, remaining limitations and revert path. Merge/deploy only once all necessary checks and release authority are satisfied.

**Recovery:** revert the reviewed commit and let existing CI publish the corrected preview; no data deletion or historical migration rewrite.
