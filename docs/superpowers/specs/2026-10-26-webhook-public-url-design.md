# Webhook public URL correction

The user reports the diagnostic receiver URL as `http://dbuquirnaskrwcamdxki.supabase.co/line-webhook`. The deployed handler constructs it with `new URL('line-webhook', request.url)`. A gateway request rewritten to `http://<host>/platform-api` reproduces that exact result. Existing tests supplied only the unrevised external HTTPS request.

## Chosen minimum correction

Use the trusted server public Supabase project origin and the explicit `/functions/v1/line-webhook` path. Pass `SUPABASE_PUBLIC_URL || SUPABASE_URL` from the Edge entrypoint, validate HTTPS/origin-only configuration, and fail the diagnostic operation with a safe 503 when it is unavailable. Request URL, forwarded headers and JSON input must never select the endpoint. Check configuration before preparing/binding a Channel.

Alternatives evaluated: changing only HTTP to HTTPS leaves the missing path; trusting forwarded host/protocol depends on gateway headers; a frontend rewrite leaves other API consumers wrong. The server configuration correction fixes the source without a new service, dependency, schema or UI.

Authorization, merchant/feature checks, encrypted credentials, explicit Provider check, receipts, notification routing and real LINE acceptance keep their existing contracts. The development merge/deployment authorization from this conversation covers this defect correction. No extra design/approval round is necessary for this unambiguous bug.

## Acceptance

- AC-001: authorized status/check behind a rewritten HTTP gateway returns the configured HTTPS origin plus `/functions/v1/line-webhook`.
- AC-002: attacker-controlled request URL, forwarded headers and body cannot change the returned origin/path.
- AC-003: invalid/missing public configuration returns a non-leaking 503 before Provider calls or Channel binding.
- AC-004: real browser read/check/copy uses the corrected URL at 390/1280; existing tenant/revocation/notification/ingress negatives remain.
- AC-005: exact final source full CI, reviewed deployed Edge source and native development deployment/smoke match. Actual merchant/LINE-console acceptance is separately identified.

Recovery: revert this patch through CI and redeploy the previous compatible function source; no data rollback, Channel URL/token change or new message send.
