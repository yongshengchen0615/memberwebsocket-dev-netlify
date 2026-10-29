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
Files: functions/_shared/request-ingress.mjs (new), business-runtime.ts, platform-handler.mjs; tests/request_ingress_security.test.js (new).
- [ ] Write behavior tests exercising both real ingress paths with Web Streams and a controlled clock; record baseline failures.
- [ ] Implement readRequestBytes(request,maxBytes,timeoutMs=10000) and RequestIngressError; enforce cumulative bytes, absolute timeout and nonblocking cancellation.
- [ ] Replace duplicate vulnerable readers; business consumes once and replays bytes; terminal ingress errors never fall through.
- [ ] Run focused tests and existing regression; compare identical 32KB read workload and replay bytes before/after without claiming network latency improvements.

## Task 2: Review and verify
- [ ] Scan public source for secret patterns without printing values; inspect database grants/RLS/views/storage and dependency audit.
- [ ] Execute all established GitHub Actions lanes on the final candidate, plus build/static tests locally.
- [ ] Independent code review for reader cleanup, timeout, memory, CORS and byte replay behavior.
- [ ] Create PR with exact evidence, integration/Preview status, remaining blockers and rollback (revert code / redeploy prior function bundle).

No schema or credential changes. Real LINE login acceptance requires a real user session; synthetic tests cannot claim this verification. Supabase advisory pg_net in public is a warning requiring extension compatibility assessment, not justification to relocate a live extension blindly.
