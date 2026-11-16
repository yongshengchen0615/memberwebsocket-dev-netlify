# Global LIFF cleanup implementation plan

> Execution: implement inline with superpowers:executing-plans; review the whole change once.

**Goal:** Remove five global feature LIFF settings from both environments without changing management identities.

**Architecture:** Keep existing deployment profiles and merchant discovery. Require only two global management IDs; merchant discovery supplies feature IDs and clears absent values.

**Tech Stack:** Static JavaScript, Node tests, JSDOM/PGlite, Playwright, existing GitHub/Netlify release pipelines.

**Spec:** docs/superpowers/specs/2026-11-16-global-liff-config-design.md

## Global constraints

- Retain each branch's management IDs and database routing.
- No migration, provider configuration edit, credential import or notification.
- No weakening existing assertions except updating the explicitly replaced seven-field contract to two fields.
- Missing feature configuration must not initialize LINE with a stale global ID.

## Review focus

- Production and testing management IDs differ; preserve each branch's existing value.
- Legacy Channel 2010787602 must no longer retain a stale feature ID.
- Partial feature responses must clear absent IDs without replacing the account management fallback.
- Refresh responses must not replace feature-scoped authentication identity.
- Unscoped member pages must report merchant setup instructions rather than initialize an undefined ID.

## Task 1: coordinated profile and discovery cleanup

**Files:** config/{production,testing}/config.json, scripts/preview-member-runtime.mjs,
business-context.js, member-system.js, booking/common.js, tests/business_context_routing.test.js,
scripts/branch-environment.test.mjs, tests/browser/merchant-workspace-v2.spec.cjs,
.github/workflows/test-memberwebsocket-dev.yml, README.md.

**Interfaces:** buildMemberRuntime(env) -> public config with two management LIFFs;
BusinessContext.configure(config) -> merchant-scoped feature IDs; existing signIn APIs unchanged.

- [x] Update profile contract tests to exactly two management IDs and retain isolation/mutation checks for both.
- [x] Add discovery cases for all five surfaces, missing IDs with the legacy Channel and tenant/account admin fallback; run RED.
- [x] Remove five JSON fields and adjust schema; clear absent merchant feature IDs.
- [x] Improve missing-ID instructions using existing error codes; keep validation before LINE initialization.
- [x] Update wiring to reject reintroduced global feature IDs and require both management IDs; update operator documentation.
- [x] Run related suites, full local Node/script baseline, DOM/handler/SQL and Chromium; record environmental limitations.
- [ ] Review and commit; open one PR per release branch preserving unrelated differences.
- [ ] Require established full CI, merge authorized changes, verify exact published config and protected API smoke on both sites.

## Execution ledger

- Baseline testing branch: e9daa87c4d8ff36b210889ce2d03fee8120a916c; application regression 1491 pass, 0 fail/skip.
- Baseline all-script invocation hit unavailable /tmp; rerun with workspace TMPDIR, without changing tests.
- Scope ruling: no merchant backfill because LINE ownership and Endpoints are not verified; expose missing setup clearly.

- Local final application regression: 1494 pass / 0 fail / 0 skip. Script baseline: 174 pass / 0 fail / 0 skip with workspace TMPDIR.
- Related real DOM/handler/PGlite suites: 23 pass / 0 fail / 0 skip. Chromium GLOBAL_LIFF production/testing: 2 pass / 0 fail / 0 skip.
- Same-format public config measurement: production and testing 634 -> 427 bytes (editor notes excluded); no added discovery request, no latency claim.
- Admin workflow inventory reviewed and only changed source digests refreshed; existing journey mappings and assertions retained.
- Full established remote CI, final branch review and both releases remain pending.
