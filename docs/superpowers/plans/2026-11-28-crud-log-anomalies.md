# CRUD and routing log anomalies implementation plan

**Goal:** Reject uncertain booking mutations and stale merchant responses; remove routing metadata contention demonstrated by the testing-project logs.

**Architecture:** Keep the existing BookingSystem transport, LINE verification, per-tenant SQL authorization and booking price publication locks. Classify only known actions as reads. Restore the original read-only metadata RPC without the global price authority lock that a historical broad migration injected.

**Baseline:** Integrated-Marketing-Platform `ee664851c731`; target MemberWebsocket-test `bmwhojszsnxliekkhrka`. No production changes.

## Acceptance and test mapping

| AC | Given / When / Then | Evidence |
|---|---|---|
| AC-001 | Given booking CRUD or an unknown action, when the response is incomplete, contradictory, disconnected or timed out, then return API_RESPONSE_UNCERTAIN and send once. | connection_transport_regression.test.js; Chromium crud-transport.spec.cjs |
| AC-002 | Given an in-flight request, when the login session or merchant generation changes, then reject its result and do not terminate or reuse another scope. | VM transport and Chromium tests |
| AC-003 | Given a held price authority lock, when routing metadata is read, then return the same metadata without waiting; actual price publication and revocation retain their existing locks and permissions. | PostgreSQL physical-session test plus existing booking-item-prices baseline |
| AC-004 | Given the final SHA, when all established CI and the testing release run, then record test counts, database ledger, Edge version and Netlify deployment with smoke results. | Same-SHA GitHub checks and release evidence |

## Tasks

- [x] Inspect current source, PR #500, logs and advisors; execute 105 existing transport cases.
- [x] Add incomplete response, unknown mutation, scope change and stale maintenance tests. Baseline: 24 expected failures.
- [ ] Fix BookingSystem response validation and scope ownership; preserve independent writes and read sharing.
- [ ] Add physical-session metadata contention test; observe failure before applying a new migration. Check matching output, service-role-only grants, migration replay and rollback.
- [ ] Add real Chromium transport cases for desktop and mobile, run full Node/scripts/DOM/browser/PostgreSQL/Edge/audit/build baseline through established CI.
- [ ] Review the complete diff, merge only after same-version checks pass, verify the testing release and publish a report with remaining external-service observations.

## Decisions, invariants and review focus

- Removing the unrelated lock from metadata is preferable to increasing timeouts or removing price publication/revocation locks. Metadata is routing, not proof of authorization; the verified tenant/LINE and transaction guards remain mandatory.
- Known reads may share an in-flight Promise only within the exact session and merchant generation. Unknown operations remain writes. No new timers, dependencies, persistent cache, tables or authentication protocol.
- Existing transport tests that previously accepted stale metadata must now assert REQUEST_SCOPE_CHANGED; retain their distinct-request-count assertions.
- Review body parsing delays, incomplete success envelopes, explicit permission failures, merchant A→B→A transitions and late maintenance responses.
- Seven-day audit records were all success; SQL division-by-zero rows were release rollback probes. Two LINE HTTP 429 notices remain external delivery failures until accepted; do not delete history or manually replay messages. An isolated 500 without an execution ID has no proven application root cause.
- Rollback uses a reviewed revert of this PR and the existing verified testing-release pipeline; no business data deletion. Restore the previous metadata function definition only if required, preserving privileges.
