# #144 review, validation and rollout

Implementation PR: https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/pull/145

## Independent review and decisions

An independent read-only reviewer reproduced three important defects in the initial patch. Regression tests cover their corrections:

1. Unverified optional Channel IDs no longer claim cross-merchant ownership. Claims require a stored complete credential configuration (or a verified custom notification route), preserving LIFF-only saves.
2. Channel ownership is shared within one merchant, while bindings are keyed by Channel and feature. Checking another module does not overwrite prior verification; the receiver can try the bounded set of currently valid module candidates. Receipt uniqueness and signed rate limits remain per Channel.
3. Credential revision includes tenant and administrator-qualification revocation epochs. Suspension followed by reapproval cannot revive an old binding or in-flight verification. Fresh LINE checks are required.

The review's draft/check UI finding was treated as important: checking old saved credentials while a new credential draft is visible could mislead an administrator. Both immediate control disabling and an invocation guard are tested. A local JSDOM diagnostic journey additionally caught and corrected use of a nonexistent control-lock helper; the existing `lock()` now governs these controls.

No minor finding remains deferred. The existing notification browser journey selected all top-level `details`; the added diagnostic section made that selector ambiguous. The selector now explicitly contains the intended admin notification form; all original behavioral assertions remain.

The reviewer declined to certify exact-SHA CI and external Provider delivery. CI certification is assessed independently using the PR checks. External LINE delivery, Console ownership and deployed ingress remain outstanding release gates, not inferred from synthetic HTTP transport.

## Executable validation

The established `.github/workflows/test-memberwebsocket-dev.yml` runs all original lanes plus:

- `tests/line_webhook.test.js`: original UTF-8 HMAC, signature/body limits, empty events, sanitization, timeouts and failed persistence.
- `tests/integration/line_webhook_sql.cjs`: legacy migration conflict, verified claims, module sharing, current grants, revocation epochs, roles, rate limits, rollback and deduplication.
- `tests/integration/line_webhook_api.cjs`: real handler + isolated SQL, read-only LINE transport, secret redaction, foreign/disabled/revoked access, audit and signed receipt ingress.
- `tests/integration/line_webhook_ui.cjs`: existing UI status/check and unsaved-credential guard in JSDOM.
- `tests/integration/postgres/line-webhook.cjs`: the same SQL cases on PostgreSQL 17, plus physical transaction races for redelivery, competing Channel claims and in-flight revocation.
- `tests/browser/line-webhook.spec.cjs`: Chromium at 390/1280, copy, explicit check, optional LIFF, dirty drafts and width.
- `deno check` includes `functions/line-webhook/index.ts`; full established Deno tests and dependency audits remain required.

Exact commit IDs, execution times, pass/fail/skip counts and downloadable diagnostics are recorded in the PR's GitHub Actions checks and final PR description. Local Chromium cannot start (SIGTRAP) and local Deno test crashes because `/proc/self/exe` is unavailable. Neither local result counts as passing; GitHub CI must actually execute those lanes. Node/SQL fixture and browser transport results never establish real LINE delivery.

## Release gates and recovery

The Netlify PR preview is a static frontend only; it does not deploy the new Supabase function or migration. Its configured shared backend does not yet provide these diagnostic actions. Preview availability therefore does not establish an operational Webhook endpoint.

Before controlled backend deployment: identify an isolated Supabase environment, audit duplicate claims, apply the migration there, deploy `line-webhook` with its `verify_jwt=false` function configuration and updated `platform-api`, then test signed ingress and current grants. Run advisors and verify service-only grants/RLS. The new code uses explicit service-role grants, independent of default Data API grant changes.

Use an approved non-production LINE Channel only after confirming ownership and existing callback usage. Provider acceptance and human receipt evidence belong to #36; #33 remains the production release gate. Do not overwrite a live Console URL, rotate credentials, send to real people or modify production member data as part of this PR.

Recovery before deployment is closing/reverting the feature PR. After an isolated deployment, revert the code via the original CI pipeline and disable the test Channel callback; preserve receipt evidence until reviewed. Do not drop receipt tables or change production callbacks as an automatic rollback.
