# Connection regression and efficiency implementation plan

> Execute inline with superpowers:executing-plans. Keep RED/GREEN logs and request-count evidence.

**Goal:** Reduce duplicate booking reads and prevent unsafe automatic mutation replay while preserving authentication, merchant isolation and fresh reads.
**Architecture:** Reuse BookingSystem's existing scoped in-flight read map for group booking instead of maintaining a second HTTP implementation. Use one member mutation predicate for both deduplication and retry decisions. No new dependencies, database changes, response cache or business rules.
**Tech stack:** Existing browser JavaScript, Node 24 regression, Node 22 DOM/PGlite, Playwright Chromium and established GitHub Actions.
**Baseline / target:** `092afa8` / `Integrated-Marketing-Platform`; work branch `perf/connection-regression-20261111`.

## Facts, assumptions and decisions

- Baseline application regression: 1,423 passed, 0 failed/skipped (local Node).
- Group booking currently bypasses shared reads and mutation invalidation. Member `user.member.card.open` is a write in the outer request wrapper but a retryable read in the sender; `user.member.invitation.claim` is already protected (confirmed by the new passing control tests).
- Live DB snapshot: 9 idle / 1 active client connection, health advisor empty. These observations do not prove sustained capacity.
- Compare retaining two transports and adding another map against reusing the existing one: choose reuse to avoid two copies of timeout, error, revocation and mutation invalidation logic.
- Working assumption: optimize the existing integrated development environment and preserve canonical API endpoints; production master and live member records are outside this change.
- Entire established CI baseline remains mandatory. Full LINE authentication cannot be proven by synthetic fixtures. No schema migration is introduced; existing SQL/concurrency/recovery baseline still runs.

## Acceptance and impact matrix

| AC | Given / When / Then | Paths / tests |
|---|---|---|
| AC-001 | Given 100 identical concurrent group slot reads, when sent with the same endpoint/key/business/identity/payload, then one HTTP request is made; after settlement the next read is fresh. | booking/common.js, group-booking.js; connection_efficiency, browser transport tests |
| AC-002 | Given differing identities, merchants, API keys or slot payloads, when requests overlap, then results remain separate. | connection_efficiency; existing auth/tenant baseline |
| AC-003 | Given a group mutation and an earlier read, when create/update settles, then subsequent reads are fresh; writes remain independent and never automatically replay on network failure. | connection_efficiency, canonical_development_api |
| AC-004 | Given member card open/invitation claim, when a response is lost, malformed or times out, then a single request returns API_RESPONSE_UNCERTAIN; concurrent writes are independent. | member mutation transport behavior |
| AC-005 | Given revoked access during group transport, when it completes, then protected access closes and late successful responses cannot restore data. | connection_efficiency, Chromium; existing revoked-session tests |
| AC-006 | Given final candidate, when all established test lanes and static build run, then every result is recorded; failures, missing lanes and external auth remain explicit blockers. | authoritative CI workflows |

## Review focus

- A rejected shared read must leave the map so recovery can issue a new request.
- Mutation completion must not let an old read evict a newer in-flight read.
- Same request scope may be shared only until settlement, never cached afterward.
- Price snapshots, participant notes and canonical group endpoints must remain intact.
- Offline/hidden lifecycle polling, 429 refusal and uncertain mutations must not produce automatic writes.

## Task 1: Centralize group request transport

- [x] Add failing group read deduplication, scope separation, mutation invalidation, errors and revocation tests using actual browser runtime code.
- [x] Run RED and preserve failure log.
- [x] Extend existing BookingSystem route/read/write sets for group actions; have groupRequest delegate with the existing payload/price preparation.
- [x] Update fixture seams and structural assertions to verify the same canonical endpoint contract through the shared transport; retain all behavioral assertions.
- [x] Run focused Node/DOM/Chromium tests and compare baseline/candidate HTTP counts for identical workloads.

## Task 2: Unify member mutation classification

- [x] Add failing card.open / invitation.claim single-send and uncertain-result cases.
- [x] Use one mutation predicate in request and sendRequest, including card.open; preserve invitation.claim as an existing control.
- [ ] Run targeted tests and all established regression, integration, PostgreSQL, browser, syntax, Edge, wiring, audit and build lanes on the final candidate.
- [ ] Request independent whole-branch review, fix findings with RED/GREEN evidence, and create a reviewable PR with exact version/evidence and rollback.

## Recovery and delivery

Revert this PR through normal CI. No database or Edge deployment is required for these client transport changes. Preserve the current integrated frontend as rollback point; do not bypass required checks or overwrite unrelated changes. GitHub Project connector returned 403 during inventory; card status cannot be claimed updated.

## Execution ledger

- Task 1: runtime and focused verification complete; HTTP burst comparison 3,000 → 30, with 30 fresh reads in both versions.
- Task 2: mutation predicate and fault matrix complete. Independent review found no production defect; requested explicit controlled timeout and protected DOM revocation cases. Both added, 35/35 Node and 4/4 Chromium pass.
- Review fixes: baseline source copy reproduces 14 failing / 21 passing / 0 skipped cases; candidate 35/0/0. Timeout tests assert actual abort, exactly one HTTP send, uncertainty and timer cleanup.
- Ruling: invitation.claim was already protected; retain it as a control, fix only the reproduced card.open mismatch. Cost if wrong is incomplete mutation coverage; fault/timeout/refusal controls now run for both.
- Ruling: use the connected GitHub Git Data API because local git push has no credentials. Upload the complete verified tree on an independent feature branch with expected-head protection. No shared history rewritten.
- Ruling: direct Deno npm fetch failed; use the same pinned Supabase SDK installed via npm with Deno manual node_modules resolution. Local Edge typecheck and 55 tests pass; normal GitHub Edge lane remains required.
- PR #303 tracks final full CI and release status: https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/pull/303 . No full-completion claim is made by this ledger.
