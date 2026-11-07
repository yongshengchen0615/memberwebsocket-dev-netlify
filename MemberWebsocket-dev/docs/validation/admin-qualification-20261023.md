# #97 qualification foundation — validation and handoff

Date: 2026-10-23 (Asia/Taipei).

Base: `Integrated-Marketing-Platform@08d90a34af3611bbeea544d40c7ee5cbb49c5ade`.
Code candidate: `ecdb87508140b4377c26652d2ecef1724f7ce5cb`.
Local branch: `feat/admin-multi-merchant-97`.

## Delivered capability
Independent private qualification model; explicit pending submission; root-only review/list; rejection and resubmission; suspension/resumption metadata; version and request conflicts; current-state retry responses; atomic audit/request writes; non-destructive approved/pending/rejected backfill. Four public-schema RPCs are callable only by the trusted service role and use SECURITY INVOKER. No root grant or merchant is created by qualification approval.

## Executed evidence
| Check | Command / environment | Result |
|---|---|---|
| RED before implementation | `node --test MemberWebsocket-dev/tests/integration/admin_qualification.cjs` | 9 expected failures: qualification RPCs did not exist |
| Qualification + legacy platform | `node --test MemberWebsocket-dev/tests/integration/admin_qualification.cjs MemberWebsocket-dev/tests/integration/product_platform.cjs` | 24 pass, 0 fail, 0 skip, exit 0 |
| Original Node suite | `node --test MemberWebsocket-dev/tests/*.test.js`, Node 24.19.0 | 1031 pass, 0 fail, 0 skip, exit 0 |
| Full DOM/SQL workflow list | All entries from the integration job of `.github/workflows/test-memberwebsocket-dev.yml`, Node 22.23.4, `--test-concurrency=2` | 461 pass, 0 fail, 0 skip, exit 0 |
| Build/release workflow list | All ten test scripts from `.github/workflows/test-netlify-build.yml`, Node 24.19.0 | 89 pass, 0 fail, 0 skip, exit 0 |
| Syntax / wiring | All run steps from `browser-syntax` and `wiring` jobs | exit 0 |
| Dependency audit | `npm audit --prefix MemberWebsocket-dev/tests/integration --audit-level=low` | 0 vulnerabilities, exit 0 |
| Independent review | Read-only review of `08d90a3..ecdb875`; reviewer independently reran new qualification tests and `git diff --check` | 9/9; no Critical/Important/Minor findings; suitable for Draft PR |

Build/release tests initially failed because this sandbox has no `/tmp`. Rerun used `TMPDIR=/workspace/scratch/58509175f787/test-tmp` and passed all 89 tests. No assertions or product code were weakened. Supabase CLI 2.122.0 aborted in this environment; version 2.81.3 successfully generated the migration. The timestamp in the filename is the CLI-produced value.

## Not executed / not delivered
- New PostgreSQL 17 Q010–Q012 use distinct physical sessions and actual lock waits, and are required in CI: concurrent submissions, competing decisions, identical approval retries. They have **not executed**. This sandbox has no Docker and disallows switching to a non-root OS identity (`runuser: cannot set groups: Operation not permitted`), so local PG17 could not start. No fabricated CI/container identifier or single-session substitute was used.
- Exact-SHA GitHub Actions, Chromium/Edge CI, and Preview verification have not executed for this candidate. A build test is not a Netlify deployment.
- No shared Supabase SQL, Edge Function, Netlify deploy, LINE configuration, member, account or merchant data was changed.
- Legacy merchant runtime authorization is intentionally unchanged. Qualification suspension metadata is **not yet an access-revocation gate** for those routes. Multi-merchant model/selector, Edge identity transport, all singleton-RPC replacements, API enforcement and the two UIs remain full #97 follow-up work.

## Publication blocker
The attempted push to the isolated feature branch was rejected by automatic approval review: source-code egress to GitHub was not explicitly authorized for this payload/destination. No alternate API/browser write was attempted. A read-only GitHub branch search afterwards returned no matching branch. Draft PR creation and Issue/Project updates therefore remain pending.

After explicit approval: push this isolated branch to `yongshengchen0615/memberwebsocket-dev-netlify`, open a **Draft** PR against `Integrated-Marketing-Platform`, inspect every required workflow for the exact remote SHA, and prepend a factual progress block to existing Issue #97 while preserving its history. Keep #97 in progress. Do not merge or deploy this standalone foundation as the complete feature.

## Review decisions
The reviewer set merchant runtime gating, Edge identity transport, tenant selection and UI outside this phase's review. That scope is retained because the confirmed #97 design requires a coordinated follow-up. The cost of treating this package as a complete release would be unenforced legacy entrypoints; Draft/undeployed status is required until that integration is implemented and verified. No deferred minor findings.
