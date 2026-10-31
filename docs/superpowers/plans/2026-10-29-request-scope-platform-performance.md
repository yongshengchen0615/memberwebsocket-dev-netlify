# Request scope and platform polling implementation plan

> Use Superpowers executing-plans for inline implementation; obtain one independent review after verification.

**Goal:** Reduce platform refresh latency and offline traffic while keeping in-flight reads isolated by credentials and business.
**Base:** Integrated-Marketing-Platform `3eaae7005b5952b3f55a001afef2731818d79438`, related #44. Target is a reviewable PR against that branch.
**Architecture:** Keep the current authenticated APIs and polling periods. Complete independent root reads together before rendering; use existing request queues with complete scope keys. No new dependencies, backend, schema, cache, or business rules.

## Design and alternatives

Choose local changes over a new WebSocket/broadcast coordinator: current code already has revision polling, deduplication and lifecycle controls; replacement has no measured justification. Offline polling is suppressed and online triggers the existing single-flight refresh. Frequency remains 5 seconds for root and 15 seconds for merchant. Failed or revoked reads cannot partially commit either list.

| Concern | Invariant / acceptance |
|---|---|
| Goal | Root and merchant see current authorized state with fewer unnecessary requests. |
| Identity / rights | Existing LINE ID token, test session, server authorization and tenant isolation remain authoritative. |
| State / data | No data mutations added; no response cache; completed/failed reads are evicted. |
| Constraints | Node 24, full existing CI; no paid environments or destructive live tests. |
| AC-001 | Given identical concurrent reads, when identity/key/business matches, then one network call; any differing scope has independent responses. |
| AC-002 | Given two independent root reads, when refreshed, then both start before either completes and neither list commits until both succeed. |
| AC-003 | Given offline root/merchant, when poll/focus/visibility fires, then zero API calls; online resumes one refresh. |
| AC-004 | Given failed/revoked/obsolete responses, when parallel calls settle, then private UI stays closed and current review state is preserved. |

## Task 1: complete existing read coalescing keys

- [x] Add behavior cases in `tests/connection_efficiency.test.js` for API keys, config business, live BusinessContext changes, and identical reads in both runtimes.
- [x] Run RED; add endpoint key/business scope to MemberSystem and business scope to BookingSystem keys; run GREEN and existing 69-case sync baseline.

## Task 2: platform independent reads and connectivity

- [x] Add DOM tests to `tests/integration/merchant_workspace_ui.cjs` for concurrent start, atomic success/failure, revocation, offline gating and single-flight recovery.
- [x] Run RED; use allSettled in platform refresh to drain both parallel calls on failure, offline guards at refresh entry points, online handler through existing refresh functions. Keep explicit recheck behavior; suppress hidden automatic signals at their event source.
- [x] Update platform/app.js asset query in both entry pages; add Chromium coverage using synthetic API responses.
- [x] Compare same controlled pair delays and offline workload at baseline/candidate; retain raw counts, not claims about production p95.

## Verification and recovery

Run local changed behavior/DOM/browser checks, then exact-SHA full GitHub Actions (regression, DOM, PostgreSQL, Chromium shards, syntax, Edge, wiring, dependency audit, aggregate validation, static build, ticket policy). Independent review before merge. Final status remains partial if any required gate is unavailable. Revert the PR through normal CI; no database recovery needed. Production master is outside this increment.

Review focus: failed sibling request, delayed approval snapshot, revocation while another read succeeds, live merchant context changes, repeated online events while a refresh is active.

Execution ruling: source fetched at immutable SHA through GitHub because direct clone is unavailable; local focused checks plus remote full-suite CI provide evidence. No remote branch is overwritten.
