# LIFF environment routing repair

**Goal:** Publish each environment's editable config and keep its account LINE channel verification consistent.

**Baseline:** master `4f9950d621d942331ffd595e92c19854f25fa45d`; Integrated-Marketing-Platform `c1ae97fd9e42a0169c4250b5aa507c0f00c5830f`.

**Confirmed root cause:** master changed adminLiffId, but product_admin_ui.cjs compared against a retired literal. Full CI failed and the publish gate correctly retained deploy 6af9606872499fff17c99263 / commit 48ccf8b, which uses the testing admin LIFF. Public LINE launch responses confirm the old admin LIFF points to the testing site and the new one to production.

**Constraints:** Keep scoped config/production and config/testing as build inputs. Preserve LINE server verification, tenant configuration and full CI. Do not create or guess LINE apps or alter business data. Existing shared points/event/calendar/booking IDs require separate LINE apps before both sites can use those features independently.

## Acceptance and affected boundaries

| AC | Given / When / Then | Verification |
|---|---|---|
| AC-001 | Given either editable profile, when admin/root starts, then initialize that role's configured LIFF, not an old literal | real DOM + handler/SQL product_admin_ui.cjs for both profiles |
| AC-002 | Given environment-specific LIFFs and registered Endpoints, when LINE login starts, then preserve native SDK endpoint behavior including the legacy testing root path | existing product-platform browser and platform_login_ui.cjs baseline; public LINE launch smoke |
| AC-003 | Given a LIFF field changes in either config, when both builds run, then only its selected environment changes | branch-environment.test.mjs: all seven LIFF IDs |
| AC-004 | Given the fixed exact SHA passes full CI, when merged/published, then live config matches the built profile and admin LIFF launch points to its own site | GitHub complete baseline + Netlify deploy + live config/LINE launch smoke |

## Task 1: Repair configurable role selection and callback

- [x] Reproduce original DOM failure before changing tests: evidence/product-admin-red.log.
- [x] Check real LINE Endpoints and retain SDK native redirects: testing root uses legacy /admin/platform/ and a forced /platform/ callback would violate LINE prefix rules.
- [x] Replace obsolete environment literal in product_admin_ui.cjs with assertions against the profile delivered to the real application; run the retained entire journey for both profiles, retaining all SQL and permission assertions.
- [x] Retain existing client login behavior and browser assertions; correct environment selection at the actual config/publication source.
- [x] Extend existing build mutation test to all seven LIFF IDs; verify isolation and published output.
- [ ] Run related suites, full local regression and full remote established CI.

## Expanded identity boundary (confirmed during investigation)

Both deployed platform-api bundles still verify account/root channels with the legacy constants 2010791619 / 2012065297, while production config uses 2011356226. Config-only frontend publication would therefore reject valid production LINE tokens. Chosen solution: pin one HTTPS config origin per server-owned Supabase URL, validate project/API identity, coalesce concurrent fetches and cache at most 60 seconds; fail closed on expiry or provider failure. This lets future config edits update platform-api verification without requiring extra deployment credentials. Alternative: bake channels into each Edge bundle; rejected for this request because every future JSON edit would need a second manual backend release and could drift again. Tenant channels still come from trusted database records. New AC-ROUTING-005..008 cover exact audience checks, cross-project/unknown inputs, cache expiry, coalescing, outage and existing tenant channel behavior. No cryptographic protocol, role or DB change.

## Task 2: Delivery and limits

- [x] Record exact profile paths, LINE endpoint requirements and remaining shared app IDs in operator documentation.
- [ ] Review diff and verify final SHA; merge only after required CI succeeds. Keep each branch's unrelated config changes.
- [ ] Verify both exact release SHAs and deployment smoke; document any blocked provider login. Roll back by reverting the scoped patch or restoring the prior verified Netlify deploy; no DB migration is needed.

**Quality/performance:** No frontend runtime change or new dependency/DB change. Account verification adds a bounded cached read of a pinned deployment config. Integration expectations assert role-to-profile behavior rather than immutable operator values.

## Verification ledger

- Original CI failure independently reproduced locally (product-admin-red.log). Optional explicit callback was evaluated and withdrawn before merge because the live testing root Endpoint uses /admin/platform/; native SDK behavior is retained.
- Local full Node regression: 1482 pass / 0 fail / 0 skip. All scripts: 174 pass / 0 fail / 0 skip. Related DOM/handler/SQL: 51 pass; expanded real handler/SQL suite: 18 pass; actual merchant/root login DOM: 13 pass.
- Local first browser attempt was blocked by absent Chromium; installed pinned Chromium 1194 into ignored evidence/browsers and reran (final outcome recorded in release PR/CI). No browser test skipped or weakened.
- Final checkout bytes: platform/app.js remains 88492 (no frontend runtime change); platform-auth.mjs 2413 → 4942 (+2529). Server config fetch coalesces three concurrent verifications into one request and reads once per 60-second window (AC-ROUTING-006); no latency improvement claimed.
- Main deployed dependency request-ingress.mjs predates the source-controlled bounded-buffer fix. Release will use the exact complete repository dependency set tested by full CI, not an untested hybrid. No API behavior or DB change is added by that existing buffer correction.
- Review minor deferred: during an immediate config-provider outage, sequential invalid-token requests can each refetch config after the prior attempt fails; concurrent requests coalesce. A brief negative-cache cooldown is separate resilience work; failure remains closed and no expired channel is accepted.

- Ruling: retain SDK default Endpoint redirect rather than forcing current pathname. Evidence: actual testing root LIFF launch response uses legacy /admin/platform/ and LINE requires redirectUri to be at/below its registered Endpoint. This preserves existing behavior; only correct LIFF/profile selection is necessary to fix cross-environment routing.
