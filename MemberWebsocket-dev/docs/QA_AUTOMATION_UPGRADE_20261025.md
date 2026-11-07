# Playwright / GitHub Actions QA upgrade (2026-10-25)

## Objective and accepted boundaries
Preserve every existing Node, DOM, PostgreSQL, Edge Function and browser fixture test. Add failure evidence and an independent browser check **after** Netlify's exact-SHA preview verification. No production business or Supabase schema changes.

| Acceptance | Given / When / Then | Automated evidence |
| --- | --- | --- |
| QA-PREVIEW-001 | Given a published Integrated-Marketing-Platform preview with matching SHA, when Chromium opens the real landing page, then navigation and release marker are present. | `preview-smoke.test.cjs` |
| QA-PREVIEW-002 | Given an unauthenticated browser, when it opens the real platform entry, then no management workspace or legacy login gate is exposed. | `preview-smoke.test.cjs` |
| QA-PREVIEW-003 | Given an invalid URL, wrong branch host, production host, query, credentials or invalid SHA, when a preview smoke is prepared, then it fails before network access. | `scripts/preview-target.test.mjs` |
| QA-REGRESSION | Given any code change, when standard CI runs, then all established test lanes still execute and evidence is collected. | `test-memberwebsocket-dev.yml`, `test-netlify-build.yml` |
| QA-API | Given a published exact-SHA Preview, when unauthenticated API/CORS checks execute, then protected endpoints reject anonymous access. | Existing `scripts/verify-platform-preview.mjs` |

## Architecture
- Fixture Playwright baseline: `MemberWebsocket-dev/tests/browser/*.spec.cjs` (three shards, local simulated LINE and database as applicable).
- Release Chromium check: `preview-smoke.test.cjs` via a *separate* `preview.playwright.config.cjs`. This test is not silently skipped in baseline; it is run explicitly only after a matching preview deploy.
- The release browser lane refuses any target except `integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app` and blocks every non-GET/HEAD and cross-origin browser request, preventing modification of real Supabase records or LINE OAuth. This lane is **not a claim of successful real LINE sign-in**.
- Existing Preview HTTP verification tests exact commit assets, API CORS, and 401 without auth; it remains a mandatory preceding step.
- Standard Playwright produces JUnit, HTML and failed trace/screenshot/video. GitHub Actions stores artifacts for 7 days.

## Commands
```sh
node --test scripts/preview-target.test.mjs
npm ci --ignore-scripts --no-audit --no-fund --prefix MemberWebsocket-dev/tests/browser
(cd MemberWebsocket-dev/tests/browser && npx playwright install chromium)
(cd MemberWebsocket-dev/tests/browser && npx playwright test)
# For local visual debugging with a visible browser on a desktop:
(cd MemberWebsocket-dev/tests/browser && npx playwright test --ui)
# Release preview check, only after the exact commit was deployed:
(cd MemberWebsocket-dev/tests/browser && PREVIEW_BASE_URL=https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app COMMIT_REF=<40-character-sha> npx playwright test --config=preview.playwright.config.cjs)
```

## Remaining independent acceptance gates (NOT covered by this change)
1. **LINE real sign-in / callback / WebView:** requires approved test LIFF endpoints and accounts, and explicit human-controlled LINE authorization. Fixture sign-in never counts as real LINE acceptance.
2. **Live Supabase CRUD / tenant isolation / concurrency:** requires a dedicated disposable project or test branch with synthetic merchant, member A/B, pending and suspended accounts, plus transaction/rollback and cleanup evidence. Do not use the existing shared Supabase project for destructive runs.
3. **Secrets / deployment:** service-role keys, OAuth codes, ID tokens, and complete member data may not enter screenshots, videos, artifacts or repository files. Use protected CI secrets and synthetic accounts.
4. **Release protection:** required GitHub status checks/branch protection should be configured after stable CI check names are known; this change does not modify repository protection settings.
5. **Netlify account verification:** publishing depends on the configured CI GitHub secret and Netlify site access; no new external deployment credentials were created here.

## Failure and recovery
A failed, timed-out or skipped required lane is not a pass. Investigate the exact SHA's Actions logs, JUnit, HTML, trace and videos; fix the regression and rerun the entire baseline. Revert the QA change commit if necessary; no database migration is required. Do not publish a new preview if any existing mandatory CI lane fails.
