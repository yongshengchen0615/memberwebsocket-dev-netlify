# Webhook public URL correction — review and rollout

## Result and root cause

User reported `http://dbuquirnaskrwcamdxki.supabase.co/line-webhook` in the receiver field. Base `a5a618dbd39717fd7f37611bab7005cbb9b9538e` resolves `new URL('line-webhook', request.url)`. With gateway URL `http://dbuquirnaskrwcamdxki.supabase.co/platform-api`, this exactly reproduces the reported result. Existing tests had only an external HTTPS `/functions/v1/platform-api` request, missing the deployment boundary.

The trusted public project origin now supplies the endpoint, with explicit `/functions/v1/line-webhook`. The Edge entrypoint uses `SUPABASE_PUBLIC_URL || SUPABASE_URL`; HTTPS origin-only validation occurs after existing authorization and before prepare/Provider/bind. Invalid configuration returns safe503 without leaking the supplied URL. Forwarded host/protocol and request JSON cannot choose the endpoint.

## Impact and acceptance

| Changed path | Existing contract | AC / evidence |
|---|---|---|
| `supabase/functions/_shared/line-webhook-diagnostics.mjs` | Existing read-only Provider check | AC-001/003, origin unit cases; no change to Token/Channel check |
| `_shared/platform-handler.mjs`, `platform-api/index.ts` | Authenticated merchant/feature diagnostics | AC-001/002/003, real handler/PGlite proxy and bad-config cases |
| Webhook HTTP fixture/API/browser tests | Original status/check, LIFF-only, revoked/foreign, signed ingress, copy | AC-004, all old assertions retained; 390/1280 route now models gateway HTTP |
| Development release | Full baseline, same source and Edge function | AC-005, final PR/issue evidence records immutable SHA/run/deploy identities |

No migration, dependency, frontend source, LINE Console, secret rotation or message send. Existing tenant/feature authorization, notification routes, receipt deduplication and signature verification are unchanged. Two-OA topology remains outside this bugfix.

## Review and measured cost

One independent whole-branch reviewer inspected `a5a618d..f258322` read-only: no Critical/Important/Minor finding. Independent Node24 focused unit/actual-handler suite8/8 passed; browser coverage was inspected, not certified as executed by the reviewer. The author observed RED8 cases4pass/4fail before runtime fixes, then focused28/28 and complete Node1058/1058, zero fail/skip. Syntax and diff checks passed.

Code-quality improvement removes request-dependent URL construction at its source, centralizes one small configuration validator, and fails before binding. Evaluated HTTPS-only replacement (loses route), forwarded-header construction (gateway dependency), and frontend rewrite (API still wrong); trusted server origin is the minimum sufficient correction. No new framework or general URL service.

Same-runtime benchmark at Node22.20.0/linux/x64: same seeded PGlite DB, actual `platform.webhook.status` handler, same authorized merchant, rewritten HTTP request, concurrency1. Three warmups each;12 samples each in alternating base/candidate order. Fixture setup excluded, handler and response parse included. Candidate application source `f258322731fe8746fb524bebd6aa2d815f34f4e6`; subsequent edits are documentation only. Source hashes tie the merged/deployed implementation to this measurement.

| Metric | Base a5a618d | Candidate | Interpretation |
|---|---:|---:|---|
| Status RPC calls | 4 | 4 | One each: business_context, consume_api_rate_limit, my_merchant_context, line_webhook_status |
| Status external Provider calls | 0 | 0 | Read status does not send or probe LINE |
| Explicit check Provider calls | 2 | 2 | Existing Token verification + bot/info, asserted by API/browser tests |
| Status p50 ms | 5.123 | 5.060 | Synthetic shared-runtime measurement, no speedup claim |
| Status p95 ms | 5.862 | 6.222 | +0.360ms in12 samples, runtime noise; no added network/RPC |

Raw measured milliseconds (base / candidate, in each version's order):

```text
5.262 / 5.627    5.657 / 4.953    5.123 / 6.222
4.754 / 6.182    4.581 / 5.207    5.613 / 4.906
5.195 / 4.932    5.730 / 4.612    5.071 / 5.627
4.705 / 5.123    4.718 / 4.919    5.862 / 5.060
```

Local commands: `node --test MemberWebsocket-dev/tests/*.test.js`; focused `node --test MemberWebsocket-dev/tests/line_webhook_endpoint.test.js MemberWebsocket-dev/tests/line_webhook.test.js MemberWebsocket-dev/tests/integration/line_webhook_api.cjs MemberWebsocket-dev/tests/integration/line_webhook_sql.cjs MemberWebsocket-dev/tests/integration/line_webhook_ui.cjs MemberWebsocket-dev/tests/integration/notification_routes.cjs`. Full CI remains authoritative; final exact SHA/run/counts are on the PR/issue, not inferred from these local tests.

## Decisions and boundaries

- Continue the authorized development defect correction inline without another design/merge/deploy approval round: required URL behavior is unambiguous. Cost if wrong: a reversible development API presentation change.
- Cloud-skill bookkeeping uses the single committed task and manual ledger; no additional implementation agent. Cost if wrong: traceability gap, not runtime behavior.
- Hosted public configuration is validated as HTTPS origin-only; optional self-hosted public origin takes precedence. Other custom route prefixes are outside this specified Supabase `/functions/v1` contract. Cost if wrong: diagnostics fails503 until its trusted public origin is corrected.
- Full CI/Deno/Chromium and deployed identity are actual release gates, separately executed by the author; static review cannot certify environment values. Cost if unverified: repeat the original deployment-only defect, so do not claim success from fixtures alone.
- Real LINE-console Verify, merchant session and message receipt remain external acceptance. No borrowed/fabricated LINE identity, Console mutation or real send is used to establish them. Cost if omitted: external acceptance remains pending; no false receipt claim.
- Performance measurements certify observed call counts/samples only, not general speed equivalence. Cost if overgeneralized: misleading performance claim.

Before release, all10 deployed platform-api v18 source files matched the base exactly. Existing security advisories: extension_in_public WARN and rls_enabled_no_policy INFO; performance has3 INFO. This source-only fix performs no DDL and does not claim to remediate these unrelated baseline notices. Remediation reference: https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public

Recovery: revert this patch through full CI and deploy the previous compatible platform-api bundle; do not delete data, rotate credentials or restore/publish an unrelated Netlify deployment. Refresh the existing merchant LINE diagnostics to obtain the corrected URL; actual authenticated response/LINE verification evidence is distinguished on the final release record.
