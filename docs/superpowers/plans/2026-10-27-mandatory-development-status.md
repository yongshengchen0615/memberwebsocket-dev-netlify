# Mandatory development Status implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver reusable development-readiness checks and a safe rollout for 規範確認.

**Architecture:** Extend existing PR #131 and its risk/evidence CLI. Keep default-branch Project synchronization in a separate narrow PR; enable that change only after the live field exists.

**Tech Stack:** Node built-in test runner, GitHub Actions, existing GraphQL Status updater.

**Spec:** ../specs/2026-10-27-mandatory-development-status-design.md and GitHub #56.

## Global Constraints

- Preserve all existing functional, security, CI and deployment contracts; no production changes.
- Main and Integrated-Marketing-Platform retain separate histories; no broad cross-branch merge.
- Never equate text evidence, mocked API tests or an open PR with enforced branch protection.
- New Status not live yet: do not break the active nine-option updater.
- Keep ≤2 actively modified PRs; use existing #131 for its existing governance scope.

## Review Focus

- Markdown comments/fences must not satisfy required evidence.
- Duplicate headings or another heading level must not hide empty required sections.
- Ordinary documentation retains its no-runtime evidence exemption.
- Old nine Status transitions remain valid after support for the tenth is added.
- Unavailable live field/admin permissions cannot be reported as successful configuration.

### Task 1: Extend existing readiness evidence gate

**Files:** Modify scripts/pr-change-risk.mjs, scripts/pr-change-risk.test.mjs, .github/PULL_REQUEST_TEMPLATE.md, AGENTS.md, docs/DEVELOPMENT_GUARDRAILS.md, docs/AGILE_DEVELOPMENT.md.

**Interfaces:** Consumes classifyChangeSet(files), evaluateEvidence(risk, body); preserves signatures and {passed, missing}. Adds required headings 需求與驗收條件、基線與目標環境、資安與資料邊界、測試與驗收、回退方案 for code/governance alongside existing regression/quality fields.

- [ ] Add failing behavior tests for each missing field, comments, fenced examples, duplicate headings, raw template and CLI exit codes.
- [ ] Run node --test scripts/pr-change-risk.test.mjs; confirm new tests fail for missing behavior.
- [ ] Implement minimal extraction and validation; update template and current daily rules, retaining full test/security gates and real-configuration caveats.
- [ ] Run targeted suite and local Node regression/build suites. Expected zero failures/skips.
- [ ] Commit and update existing PR #131; run full candidate CI.

### Task 2: Prepare the main Status updater change

**Files:** Modify main:scripts/project-v2-status.mjs, scripts/project-v2-status.test.mjs, .github/workflows/project-v2-status.yml; add rollout instructions.

**Interfaces:** Consumes existing resolveRequest/checkProjectHealth/changeProjectStatus; adds project-status/spec-check → 規範確認. Preserves all original label restrictions, identity checks, concurrency protection and write read-back.

- [ ] Run existing Status tests on unchanged main; expected success.
- [ ] Write failing tests for manual/label 規範確認, unchanged existing transitions, conflicting labels and live field missing the tenth option.
- [ ] Add the option/label/workflow choice, update old count fixtures to ten, run all Status tests. Expected zero failures/skips.
- [ ] Create narrow main PR with final-SHA checks; keep draft until actual Project field creation/read-back.

### Task 3: Review and live rollout

**Files:** Existing #56/#39 reports and GitHub Project/repository settings only when usable.

**Interfaces:** Task 1 readiness verdict + Task 2 tested candidate; live field and Required Checks are separate facts.

- [ ] Fresh independent whole-branch review; fix important issues with RED→GREEN.
- [ ] Verify candidate full CI on exact SHA, including build/policy; preserve relevant evidence links.
- [ ] Apply/read back Project option if authenticated and capable; otherwise preserve candidate and report actual blocker, with no speculative workaround or token expansion.
- [ ] Apply/read back required PR/review/check protection only through an authorized available administration surface; never claim enforcement from a template or green job.
- [ ] Update #56/#39 with actual completed/blocked work and recovery instructions. All remaining AC stay unchecked.

### Task 4: Prevent required-check deadlock and synchronize activation rules

**Files:** .github/workflows/test-memberwebsocket-ticket-policy.yml, scripts/governance-workflow.test.mjs, scripts/check-preview-ci.test.mjs, scripts/netlify-publish-workflow.test.mjs, AGENTS.md, docs/DEVELOPMENT_GUARDRAILS.md, docs/AGILE_DEVELOPMENT.md.

**Interfaces:** Existing unit-and-regression required check must report for every PR, including ordinary docs; preserve push filters and all test commands. Real Project tenth option and main PR161 write/readback are now verified facts.

- [ ] Extend existing governance trigger contract to both required product workflows; observe RED on Ticket Policy PR path filters.
- [ ] Remove only Ticket Policy pull_request path filters, preserve push scopes/jobs; synchronize ten-Status daily guidance and remove obsolete Draft/migration-state claims.
- [ ] Run risk/governance suite, full final-SHA candidate CI and fresh review; then merge the narrow follow-up to the integration branch and validate merge CI/Preview.
- [ ] Only after the checks can run for ordinary PRs, activate the prepared ruleset and prove rejection on an isolated branch; remove the temporary test target after verification.

Rationale: this is necessary to keep the newly mandatory checks from preventing valid documentation/governance delivery. It does not lower any test, review or deployment gate.

Task4 verification clarification: preserve publisher→Ticket Policy push-path coverage, and update both pre-existing release-trigger contracts to assert unfiltered PR coverage rather than requiring PR filters. Both old contracts were observed RED; the same full93-test build suite must be GREEN.
