# Connection efficiency review evidence

Base: `3eaae7005b5952b3f55a001afef2731818d79438` (Integrated-Marketing-Platform). Candidate content is bound to the PR commit/tree; historical evidence is not substituted for final CI.

## Findings and changes

- P2: MemberSystem could coalesce across publishable API keys; both runtimes could coalesce across a live business-context switch. Existing in-flight keys now include the effective business, and MemberSystem also includes the public key. The request body, identity, endpoint, eviction and write behavior remain unchanged.
- P2: Root V2 refresh serialized independent bootstrap and qualification-list requests. Start together, drain both with allSettled, then commit a complete snapshot. A failed or revoked request never partially commits; an early failure cannot unlock overlapping batches.
- P2: Root/merchant polling ignored offline status. Guard the current entry points and use the online event through the existing single-flight path. Hidden merchant pages also pause. Poll periods remain 5/15 seconds.
- Shared assets and platform entry cache versions updated; admin inventory reviewed (only asset query changes, no new or removed workflows).

## Local executed checks

Node `v24.22.1`, synthetic identities and API responses, 2026-10-29 session. No live member mutations, paid environments, database, Edge or dependency changes.

| Command / scope | Actual result |
|---|---|
| Existing connection_efficiency, business_sync_lifecycle, business_sync_revision, realtime_performance | Baseline 69 pass / 0 fail / 0 skip |
| New AC-PERF read-scope cases on baseline | RED: 3 pass / 5 fail / 0 skip |
| New platform concurrency/connectivity cases on baseline | RED: 1 pass / 3 fail / 0 skip |
| Early rejected sibling regression | RED: 0 pass / 1 fail (6 calls instead of 4) |
| Four sync files on candidate | GREEN: 77 pass / 0 fail / 0 skip, exit 0 |
| DOM `node --test --test-name-pattern='AC-PERF|AC-SYNC' MemberWebsocket-dev/tests/integration/merchant_workspace_ui.cjs` | GREEN: 12 pass / 0 fail / 0 skip, exit 0 |
| Original line_settings_workspace.cjs + product_admin_ui.cjs with real handler/PGlite | Baseline and corrected candidate each 3 pass / 0 fail / 0 skip, exit 0 |
| Independent code review | Two P2 findings addressed (early failure overlap and invalid browser fixture config); no remaining patch defect reported; review is not test execution |
| Local Chromium install | Blocked: provider download was not a valid ZIP; local browser checks are not counted as passed |

DOM tests also preserve pending-review snapshots, stable DOM when unchanged, single-flight reads, root revocation, delayed successful sibling after revocation, and hidden merchant recovery. New browser cases exercise real entry HTML and scripts with controlled HTTP; final evidence comes from CI.

## Same-condition comparison

`NODE_PATH=<integration dependencies> node scripts/benchmark-platform-connection.mjs BASELINE_PLATFORM_APP OUTPUT.json`

Real platform JS + JSDOM, same empty V2 data, 40 ms delay per independent API call, 30 samples per version with alternating order. Raw samples: `2026-10-29-platform-connection-benchmark.json`.

| Metric | Baseline | Candidate |
|---|---:|---:|
| Refresh p50 | 81.26 ms | 41.19 ms |
| Refresh p95 | 83.18 ms | 42.20 ms |
| Offline API requests for 12 poll ticks | 24 | 0 |

This is a controlled request/critical-path comparison, not a production latency, throughput, or actual traffic claim. Identical read sharing remains 100 callers to 1 network call; later reads still fetch fresh data.

## Read-only live review

Supabase performance advisor reported 6 unindexed foreign-key INFO findings, 67 unused-index INFO findings, and fixed Auth connection allocation (10). A pg_stat_activity snapshot showed 2 active / 20 idle / 1 other connections. These do not prove saturation, slow queries, or justify dropping indexes. No indexes, Auth settings or schema were changed. Follow-up should use representative query plans and workload evidence. Netlify production remains on master; this candidate targets an integration-branch PR.

## Full verification and recovery

Full exact-SHA GitHub CI (DOM, PostgreSQL, all Chromium shards, Node regression, JS syntax, Edge, wiring, dependency audit, aggregate validation, static build, ticket policy) is required before merge. Consult PR/Actions for final status; this document does not pre-claim success. Real LINE provider and live deployed candidate have not been validated by synthetic tests. Recovery is revert through normal CI; no data migration is involved.

Initial remote CI on c1bbf9acff835171226f9f5627bcc62d35ce7ab3 detected two asset-contract mismatches and a stale inventory hash: the unversioned MemberSystem validation-only imports on platform/merchant workspace now preserve the existing contract; platform app cache revisions append to the established prefix, retaining the member-card rollback marker; the inventory hash is calculated after exact source newline normalization. No test assertion was weakened. PR evidence also adds the required explicit L3 risk heading. Corrected candidate must rerun all baseline checks.

The complete DOM lane exposed two existing journeys blocked by the new visibility guard on an explicit merchant recheck. Narrowed hidden-page gating to automatic online/interval/visibility signals; explicit clicks keep the existing contract. A new behavior case failed (0 instead of 2 reads) and passes after correction. The original real SQL/handler journeys pass again. All four modified inventory-covered sources (including platform/app.js and both workspace entries) are reviewed and exact-byte hashes updated. The JSDOM SQL fixtures log their existing BusinessContext MutationObserver teardown diagnostic; this is recorded separately from assertion results and is not browser or provider acceptance.
