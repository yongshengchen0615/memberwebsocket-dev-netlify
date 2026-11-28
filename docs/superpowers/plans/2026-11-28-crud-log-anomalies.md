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
- [x] Fix BookingSystem response validation and scope ownership; preserve independent writes and read sharing.
- [ ] Add physical-session metadata contention test; observe failure before applying a new migration. Check matching output, service-role-only grants, migration replay and rollback.
- [ ] Add real Chromium transport cases for desktop and mobile, run full Node/scripts/DOM/browser/PostgreSQL/Edge/audit/build baseline through established CI.
- [ ] Review the complete diff, merge only after same-version checks pass, verify the testing release and publish a report with remaining external-service observations.

## Decisions, invariants and review focus

- Removing the unrelated lock from metadata is preferable to increasing timeouts or removing price publication/revocation locks. Metadata is routing, not proof of authorization; the verified tenant/LINE and transaction guards remain mandatory.
- Known reads may share an in-flight Promise only within the exact session and merchant generation. Unknown operations remain writes. No new timers, dependencies, persistent cache, tables or authentication protocol.
- Existing transport tests that previously accepted stale metadata must now assert REQUEST_SCOPE_CHANGED; retain their distinct-request-count assertions.
- Review body parsing delays, incomplete success envelopes, explicit permission failures, merchant A→B→A transitions and late maintenance responses.
- The latest seven-day audit has one line.push.grant failure (HTTP 429); three notice_outbox messages exhausted their existing five attempts with LINE HTTP 429. SQL division-by-zero rows were release rollback probes. These remain external delivery failures until accepted; do not delete history or manually replay messages. An isolated 500 without an execution ID has no proven application root cause.
- Rollback uses a reviewed revert of this PR and the existing verified testing-release pipeline; no business data deletion. Restore the previous metadata function definition only if required, preserving privileges.

## User steering: prevent repeated automatic view reloads

The user explicitly added this requirement while implementation was active. Actual testing-project event aggregation showed approximately 1,450 event-ticket and claim UPDATE invalidations per day; the relevant triggers were AFTER STATEMENT and emitted even for zero affected rows. Independently controlled clocks confirmed unchanged data still forced a full reload after 120 seconds and admin/booking revision checks ran every three seconds.

- AC-005: Given five idle foreground minutes and an unchanged revision, then no timer-based complete reload occurs; private merchant revision checks are bounded to one per 30 seconds, with immediate foreground/online recovery. Background data from another device can take up to 30 seconds to appear; every server operation still rechecks authority.
- AC-006: Given a healthy public Realtime socket, then the existing login check continues without initiating an unrelated complete data reload. Reconnect and actual data events still refresh.
- AC-007: Given maintenance affecting zero rows or only updated_at, then ticket statement triggers emit no invalidation. Real insert/update/delete still emits once per affected surface in the transaction; existing and newly provisioned merchants share this rule.
- AC-008: Given unchanged recurring ticket fields, then UPSERT performs no row UPDATE and preserves optimistic updated_at; real template changes still update tickets, and the existing grant/calendar logic receives the existing ticket row.

Implementation: generated migration `20261128081245_effective_ticket_invalidation.sql`, member-system.js and booking/common.js; no anonymous tenant broadcast or new authentication path. Tests: business_sync_revision/lifecycle, connection_efficiency, real-browser business-sync/feature-grant-sync, effective_ticket_invalidation_sql and fixed_ticket_automation_sql. New tests first failed for two idle reloads, two healthy-socket refreshes, five no-op invalidation cases and one unnecessary row write. Existing timing expectations change from 3/10 to 30 seconds because of the user's explicit new requirement; ownership, revocation, grant-denial and transaction assertions remain.

Review follow-up: the active member-ui cancellation wrapper initially bypassed transport guards; added full-extension VM and Chromium repros, routed it through the common transport, guarded the entire async chain, validated matching cancellation request IDs, and retained uncertain state when acknowledged cancellation cannot be read back. Original direct/approval and calendar UI fixtures now use the real common transport. The physical routing test checks locks inside a transaction and separately verifies actual function/ACL migration rollback.

Removing periodic reloads must retain real time-bound state transitions. Successful bootstraps record the next owned-ticket expiry (offers[].claim.expiresAt) or Taipei midnight as a deadline in a private WeakMap keyed by the immutable login session. Existing 30-second checks consume that deadline once; they do not introduce another timer or store private payloads. Returning after an actual hidden/offline suspension forces one scoped refresh, even with an unchanged database revision. Five controlled-clock RED cases cover relative expiry, day rollover and resume; the repaired deadline/lifecycle/connection suite passed 71 cases. The first implementation attempted to update a frozen session and was interrupted; the WeakMap version preserves session immutability and reran successfully.

Future-merchant transition triggers are serialized with an empty search_path so pg_get_triggerdef includes schema-qualified function names. A real fresh-schema replay test caught an unqualified public-emitter binding, then verified the repair emits two local events and zero public events. The source branch has incorporated the independently merged bronze-membership PR #518 without discarding its UI labels or review notes.

Final review recovery: reproduced and fixed two additional expiry races (a successful bootstrap followed by failed projection, and a response body arriving after the snapshot expiry). Deadline records carry object identity and request-start time; only the same observed deadline is consumed after complete onUpdate success. A new already-due snapshot retains one catch-up. Private and healthy public socket paths are covered: 75 deadline/lifecycle/connection cases passed locally.

Calendar no-op maintenance is included in AC-007: calendar_items transition triggers preserve calendar/member/admin scopes and admin.db event names. The actual sync_fixed_ticket_calendar_item definition from the business snapshot is executed rather than stubbed: two disabled DELETE 0 calls emit zero events, the first real UPSERT emits three, repeated identical content emits zero, and a true title edit emits all three. Public/current-tenant/future-tenant replay plus fixed-ticket automation: 16 cases passed. This requires no new authentication path or additional timer. All complete final-SHA CI and release checks remain required before completion.

Full CI found three remaining member-feature-grants browser expectations tied to the superseded 3/10-second cadence. Their controlled clocks now advance 30 seconds; feature revocation, draft preservation and stale ticket selection assertions are unchanged. The booking startup DOM fixture also replaced the entire BookingSystem and omitted the actual requestGuard contract; it now loads common.js first and delegates cancellation reads through the real transport while retaining synthetic group data. These failures are recorded as failures, not retries or passes; a fresh final-SHA complete CI run is required after the fixture repairs.
