# Member portal navigation #136 implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this single existing bugfix and request one independent review before integration.

**Goal:** Eliminate the proven `insertBefore` exception when the shared portal navigation mounts on a nested member page.
**Architecture:** Retain PR #137's direct-child selector and first-child/empty-body fallbacks. Retarget the existing PR to the current integration branch and exclude unrelated files inherited from its old main base.
**Tech stack:** Vanilla JS, Node tests, existing Playwright Chromium and GitHub Actions.
**Spec:** Issue #136 and the pre-existing fix in PR #137; baseline `99b3866bf32034fb477a14bda29bc117b64f0337`.

## Global constraints
- Navigation is not authorization. Preserve independent LINE and server-side role/tenant checks.
- Preserve merchant, member, booking, friend, points and ticket rules and data.
- No new dependencies, migrations, Edge releases or production publication.
- Run the entire existing CI baseline on the final candidate; no skipped/failed/pending lane is a pass.

## Review focus
- Actual member `<main>` is nested under `#app`.
- Prefer a direct main even if another body child precedes it.
- Empty bodies and DOMContentLoaded initialization must mount safely.
- Re-evaluation must not duplicate navigation or expose other role entrances.
- Deployed smoke must use same-origin GET/HEAD only, without LINE credentials.

## Task 1: Reproduce and integrate the existing narrow fix
Files: `portal-navigation.js`, `tests/portal_navigation.test.js`, `tests/browser/portal-navigation.spec.cjs`, `tests/browser/preview-smoke.test.cjs` (all under `MemberWebsocket-dev/`).
Interfaces: consumes `data-portal-surface`, produces one body-level `#unifiedPortalNav` for member/admin only.

- [x] Run the old 4-case navigation baseline.
- [x] Run PR #137's regression against baseline code: 4 pass / 1 fail, invalid nested reference.
- [x] Merge the current integration source into the existing PR branch; exclude the six unrelated old-main Project V2 files from the final target diff.
- [x] Run the repaired Node navigation regression: 5 pass / 0 fail / 0 skip.
- [ ] Add Chromium coverage with actual member/admin page structures, direct main, empty body and excluded platform; exercise loading/ready timing at 390/1280px, roles and duplicate evaluation.
- [ ] Run the new Chromium test against baseline source (RED) and repaired source (GREEN).
- [ ] Extend the existing deployed read-only smoke with member/admin desktop/mobile assertions.
- [ ] Compare raw/gzip script bytes in the same Node runtime; no speed claim without latency evidence.
- [ ] Commit, obtain independent review, and push the existing PR branch.
- [ ] Confirm complete same-SHA CI/build/policy before merging; then verify complete merge-SHA CI and branch Preview identity/assets/smoke.

## Acceptance mapping
| ID | Given / When / Then | Evidence |
|---|---|---|
| AC-001 | Given nested member main, when navigation mounts, then its direct-body reference is valid and no exception occurs. | Node RED/GREEN + actual-page Chromium |
| AC-002 | Given direct main or empty body, when loading/ready mount runs twice, then insertion order is valid and exactly one nav exists. | Chromium 390/1280 |
| AC-003 | Given member/admin/platform, when mounted, then only the current permitted role entry exists; platform is excluded. | Existing Node + Chromium |
| AC-004 | Given final candidate and integration SHA, when baseline and deployment gates execute, then all required lanes pass and the deployed commit matches. | GitHub Actions + Netlify + deployed read-only smoke |

Recovery: revert the integration merge via a new PR and rerun all CI before Preview publication. There are no database changes to reverse. Real LINE login and protected business journeys remain separate external acceptance under #36/#41, not represented by blocked SDKs or fixtures.
