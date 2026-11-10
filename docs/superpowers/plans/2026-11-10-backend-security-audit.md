# Backend error and security repair implementation plan

> **For agentic workers:** Execute inline with superpowers:executing-plans. Use RED → GREEN for each change and an independent whole-branch review.

**Goal:** Fix verified provider-error classification and main API ingress defects; make future server failures traceable without exposing secrets.
**Architecture:** Keep the existing LINE verification, tenant adapter and authorization model. Add optional early ingress constraints to the existing business adapter; opt the main API into its existing origin and 40,000-byte rules. Emit bounded metadata for server errors only.
**Tech Stack:** Deno TypeScript, Node test runner, PostgreSQL 17, GitHub Actions, Supabase Edge Functions, Netlify native branch deploy.
**Spec:** Issue #294 and `docs/DEVELOPMENT_GUARDRAILS.md`.

## Global constraints

- Baseline/target: Integrated-Marketing-Platform `5d0aeaa61ed376c1344196a19756ed9554198a75`.
- No member-data edits, migration rewrites, new dependencies or RLS changes.
- All existing CI is required before merge/release. Stubs do not prove live LINE success.
- Preserve tenant isolation, revocation, point/ticket conservation and notification routing.

## Acceptance and impact

| AC | Given / When / Then | Files and verification |
|---|---|---|
| AC-001 | Given provider 429/5xx, when shared LINE verification runs, then 503 LINE_AUTH_UNAVAILABLE before DB; invalid tokens remain 401 | auth-contract.ts; backend_error_security.test.js; existing auth/tenant/Edge tests |
| AC-002 | Given forbidden Origin or >40,000 bytes, when the deployed main API adapter receives POST, then 403/413 before privileged routing; exact limit, absent Origin, malformed JSON and normal requests keep existing rules | business-runtime.ts + api/index.ts; request_ingress_security.test.js + backend_error_security.test.js |
| AC-003 | Given endpoint or routing 5xx, when an error response is produced, then server-generated correlation ID and safe fixed metadata exist; body/token/PII/raw exception never enter diagnostics | server-errors.mjs + API/runtime; behavioral redaction tests |
| AC-004 | Given final SHA, when all established workflows and build run, then every required job passes; check exact-SHA deployment and read-only smoke separately | full existing CI, build and Supabase/Netlify evidence |

## Review focus

- Provider error bodies may contain plausible claims: HTTP 429/5xx must still fail closed without DB access.
- Unknown or attacker-controlled error codes must not become log fields.
- Declared lengths may lie; streamed actual bytes remain bounded.
- Concurrent failures must receive independent IDs; caller-supplied IDs are ignored.
- Shared adapter defaults must preserve other endpoints' limits and authorization behavior.

### Task 1: Provider classification

- [ ] Add status-table tests using the real verifier with external HTTP responses stubbed; assert literal 503/401 codes and zero downstream authorization work.
- [ ] Run `node --test MemberWebsocket-dev/tests/backend_error_security.test.js` and observe 429/500/503 misclassified as 401.
- [ ] Check provider 429/5xx before parsing claims in `auth-contract.ts`; preserve claim/revocation checks.
- [ ] Run relevant auth tests; commit with the regression test.

### Task 2: Ingress before tenant work

- [ ] Test the actual main API export with the real adapter and forbidden/oversized/exact-limit/absent-Origin requests. Use transport tripwires for unexpected privileged work.
- [ ] Observe unauthorized/oversized requests reaching the database tripwire on the baseline.
- [ ] Add optional `{maxRequestBytes, allowedOrigins}` to businessHandler; main API passes existing constants/callback. Preserve default 8 MB for other adapters and the absolute body deadline.
- [ ] Run ingress + request-body + whole regression; compare routing-call counts on identical invalid requests.

### Task 3: Safe diagnostics and delivery

- [ ] Add tests for endpoint/routing 5xx correlation, caller-ID rejection, concurrency, code allowlist and secret redaction; observe missing diagnostics first.
- [ ] Add a small shared failure metadata helper and use it only for 5xx paths in main API and tenant routing. Never log raw errors or request input.
- [ ] Run full local regression/build, dependency audit and available integration checks; push isolated PR and obtain all required CI results on final SHA.
- [ ] Independent review; fix important findings with RED → GREEN. Merge only with a green gate, then use existing branch deployment workflow and compatible Edge deployment; verify live read-only smoke and retain rollback identities.

## Investigation facts and unresolved items

- Baseline local regression: 1368 passed, 0 failed/skipped; Node v24.22.1.
- Recent main API 503s have no application error code in logs; historical root cause remains unproven.
- Retired endpoints: 4982 observed 410s, node GET/POST/OPTIONS; no evidence of browser misuse or active DB cron (all listed jobs inactive).
- Advisor: pg_net in public WARN; RLS-without-policy INFO mostly intentional server-only access. Do not open policies, move extensions or drop indexes without compatibility proof.
- Project #5 read returned integration 403; repository issue/PR remain available.

## Recovery

Revert this isolated code change and redeploy the previous verified Edge source and Netlify native branch commit. No schema or member-data rollback is needed. Never replace unrelated live function changes; compare deployed source before uploading.
