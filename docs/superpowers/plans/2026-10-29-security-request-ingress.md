# Request ingress security repair plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bound unauthenticated request body resource use without changing business authorization or data.

**Architecture:** Share a bounded byte reader between the two vulnerable ingress paths. Consume the business request once and replay its bytes to the existing downstream validator, avoiding an unbounded tee queue. Keep all existing endpoint payload limits and authorization checks.

**Tech Stack:** Deno Edge Functions, Web Streams, Node test runner, existing GitHub Actions.

**Spec:** User security repair request; repository AGENTS.md and docs/DEVELOPMENT_GUARDRAILS.md.

## Global constraints
- Base/target: Integrated-Marketing-Platform, 82cd1e60d90b114cbac75ec106a4662dc3c0f9d2.
- No paid resources, production member mutations, credential output, migration or authorization redesign.
- Existing full CI must pass before integration; Preview is the authorized acceptance target from project context.
- Keep platform 32000-byte and business 8000000-byte upper bounds; downstream smaller limits remain active.

## Review focus
- Body stalls before any authentication: absolute 10000ms deadline, 408, no handler/DB side effect.
- Slow trickle: does not reset deadline.
- Understated Content-Length: actual bytes enforce limit.
- Cancellation never resolves: rejection still finishes with 413/408.
- Replay: valid and malformed payloads retain downstream validation, metadata, CORS and authorization behavior.

## Acceptance
- AC-001 Given an unfinished body, When the absolute deadline expires, Then 408 returns and no authorization/database/handler runs.
- AC-002 Given oversized bytes or declared length, When read, Then 413 returns without awaiting cancellation.
- AC-003 Given a complete valid or malformed body, When routed, Then existing identity, business isolation and validation behavior is preserved.
- AC-004 Given a stream that emits small chunks continuously, When the original deadline expires, Then the request ends, releasing its reader.
- AC-005 Given final candidate SHA, When existing full CI and build execute, Then every required lane passes without skipped checks.

## Task 1: Reproduce and repair ingress resource exhaustion
Files: functions/_shared/request-ingress.mjs (new), business-runtime.ts, platform-handler.mjs, request-body.ts; tests/request_ingress_security.test.js (new).
- [x] Write behavior tests exercising both real ingress paths with Web Streams and a controlled clock; record baseline failures.
- [x] Implement readRequestBytes(request,maxBytes,timeoutMs=10000) and RequestIngressError; enforce cumulative bytes, absolute timeout and nonblocking cancellation.
- [x] Replace duplicate vulnerable readers; business consumes once and replays bytes; terminal ingress errors never fall through.
- [x] Run focused tests and existing regression; compare identical 32KB read workload and replay bytes before/after without claiming network latency improvements.

## Task 2: Review and verify
- [x] Scan public source for secret patterns without printing values; inspect database grants/RLS/views/storage and dependency audit.
- [ ] Execute all established GitHub Actions lanes on the final candidate, plus build/static tests locally.
- [x] Independent code review for reader cleanup, timeout, memory, CORS and byte replay behavior.
- [ ] Create PR with exact evidence, integration/Preview status, remaining blockers and rollback (revert code / redeploy prior function bundle).

No schema or credential changes. Real LINE login acceptance requires a real user session; synthetic tests cannot claim this verification. Supabase advisory pg_net in public is a warning requiring extension compatibility assessment, not justification to relocate a live extension blindly.

## Review resolution
Independent review identified per-chunk Promise.race reactions retaining memory until the deadline settles. Reproduced in the new byte reader and pre-existing JSON reader with 200000 one-byte chunks: 72609408 and 76980536 retained bytes. Both now race the complete consume operation once. Two heap-budget tests (under 32MiB in isolated Node24 processes) pass; focused ingress + existing request-security 30/30. Original authorization/replay/CORS checks unchanged.

## Actual local verification
Node regression final candidate: 1167 tests expected; actual result recorded in PR after execution. Scripts 137/137, no skips, with TMPDIR set to workspace because host /tmp is unavailable. Browser/integration npm audit: zero known vulnerabilities. Static build, syntax and diff whitespace passed. One process alternating 500 requests each with 150 warmups: baseline platform p50/p95 0.0731/0.1902ms vs first candidate 0.0798/0.2380ms; local microbenchmark only, no production speed claim.

## Review scope limits
Real Supabase/Deno chunk aggregation and client disconnect propagation require deployed checks; do not assert attack severity from Node heap numbers alone. Full CI and Preview acceptance remain required. Real LINE login, provider delivery and full-system absence of vulnerabilities are not proven by this repair. No authorization, data or notification behavior was changed.
