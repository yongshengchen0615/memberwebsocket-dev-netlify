# LINE settings simplification — review and acceptance

PR: https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/pull/146

Jasper approved the proposed simple/advanced design and explicitly requested
integration into `Integrated-Marketing-Platform` for acceptance. Production and
fixed admin/member OA account consolidation are outside this UI change.

## Resulting operation

The existing business workspace and the selected-merchant settings shell reuse
the same per-feature renderer. Paste a feature LIFF ID or its exact LINE URL;
the Login Channel is derived and remains inspectable. Initial administrator
identity is requested only when missing. A configured feature normally shows
one entry input; Messaging credentials, notification purposes and Webhook
diagnostics remain explicit disclosures/actions. Nothing is enabled or sent by
opening a disclosure.

Existing encrypted secrets remain blank on load/save and are retained under
the existing API contract. Each notification purpose keeps its existing mode
and channel. There is no schema/Edge deployment, credential migration, rotation,
Console callback change or real message send in this branch.

## Independent review and corrections

One independent whole-branch review found no Critical issue and three Important
issues, all reproduced before correction:

1. Native form validation prevented `submit` from firing for an invalid field
   inside a closed disclosure. Forms now use the existing explicit validator
   for both button and Enter activation; invalid disclosures open and focus the
   affected input. Actual-click JSDOM and real Chromium journeys cover this.
2. Reload restored the saved Login/LIFF pair but retained old custom validity.
   Saved-input updates now recompute pair validity, and deliberate reload clears
   derived draft bookkeeping. Mismatch → reload → actual Save is tested.
3. Retained business-workspace transport left secret drafts after authorization
   failure or suspended bootstrap. Shared revocation handling now clears forms,
   secrets, pending state and late-response generations across operations.
   Transient/uncertain failures still preserve their requestId for retry.

The URL parsing finding was regraded Important: canonicalizing a pasted path
containing `..` can select a different app identifier from the literal path.
Only the exact ID or `https://liff.line.me/<id>` syntax is normalized; misleading
hosts, path segments, queries and fragments, including empty delimiters, fail.
No minor finding remains deferred.

Existing browser failures also exposed ancestor-dependent `has` locators.
Their inner selectors are now relative descendants. Existing behavior and
database assertions remain, including both notification purposes and A/B
merchant isolation. Modern entry assertions inspect `module_line` and the real
public entry API rather than treating the legacy first-seed snapshot as current.

## Latest integration baseline and measured cost

Integrated the concurrently merged governance commit `80c4f1fee091b0b39d8021b3944521d58ba4cc67`; its application assets are unchanged from the original product baseline. Its full-PR CI and R01–R10 requirements are preserved. The application review remains applicable to the same feature code; final CI uses the updated merged baseline.

A measured duplicate initialization was removed: newly created feature views initialize saved values and links once; existing views still refresh and retain draft/version semantics. The focused 39-case suite passed after this adjustment; build/governance contracts passed 100/100.

Measured base `80c4f1fee091b0b39d8021b3944521d58ba4cc67` against candidate application source `43ea87a82b549745bc9686f56ea2f4cf069e3575` using Node22/JSDOM on the same runtime, five configured features, alternating versions, three warmups and 12 measured samples each. Raw samples, environment and per-file source hashes are in `line-settings-59-performance.json`. Reproduce from repository root with `node scripts/measure-line-settings.cjs 80c4f1fee091b0b39d8021b3944521d58ba4cc67` after installing the existing integration dependencies.

| Metric | Base | Candidate | Interpretation |
|---|---:|---:|---|
| Default visible entry inputs | 2 | 1 | Less required manual entry for an already configured merchant |
| Initialization API calls | 1 | 1 | No extra bootstrap query |
| Four affected source assets, bytes | 123294 | 132130 | +8836 raw bytes |
| gzip level9, three identical samples | 33871 | 36371 | +2500 bytes; deterministic source compression, not measured CDN transfer |
| JSDOM initialization p50, ms | 15.07 | 13.7 | Synthetic DOM timing; no native-browser speedup claim |
| JSDOM initialization p95, ms | 21.02 | 21.9 | Shared-runtime/JIT noise applies; raw repeated samples retained |

The bounded asset increase supports shared settings/validation across two actual entry paths. No cache, new dependency, database query or runtime service was introduced. Actual Chromium usability and complete CI remain release requirements.

## Acceptance mapping

| AC | Given / When / Then | Executable evidence |
|---|---|---|
| AC-001 | Given a granted merchant, when a LIFF ID/URL is saved, then matching Login IDs and the own-merchant public entry work without Messaging credentials. | `line_settings_simple.cjs`, `line_settings_workspace.cjs`, `LINE_SIMPLE_WORKSPACE_390/1280`, `LIFF_ONLY_390/1280` |
| AC-002 | Given invalid pasted URLs or mismatched advanced fields, when Save/Enter is used, then no write occurs and the invalid disclosure opens/focuses. | Actual-click JSDOM, strict URL cases, workspace Chromium |
| AC-003 | Given mismatch or another feature draft, when saved values reload or an unrelated feature saves, then validity recovers and draft pairs remain together. | Reload/Save and paired-draft cases in `line_settings_simple.cjs` |
| AC-004 | Given independent admin/member routes, when saved/tested/retried, then mode, recipient, requestId and unrelated settings are preserved. | `notification_routes.cjs`, `notification-settings.spec.cjs`, booking notification regression |
| AC-005 | Given revoked/expired access or merchant switch, when an operation completes, then secret drafts/controls clear and stale results cannot populate the new merchant. | Retained-transport SQL negatives, suspended bootstrap, clear/remount cases, actual workspace revoke |
| AC-006 | Given legacy capability or another merchant, when the UI is used, then the retained contract works and other merchant data stays unchanged. | `product_admin_ui.cjs`, `merchant_workspace_ui.cjs`, V2 browser journey/public API |
| AC-007 | Given final candidate and approved development merge, when deployed, then exact-SHA full CI, native deployment identity/assets and protected API smoke all succeed. | Final PR #146 and issue #59 release evidence; no fixture substitutes for deployed verification |

## Verification and limits

Local final code checks: Node regression **1056 pass / 0 fail / 0 skip**;
focused real-handler/SQL/JSDOM regression **39 pass / 0 fail / 0 skip**;
JavaScript syntax and `git diff --check` pass.

Commands (use the repository's Node22 runtime for PGlite):

```sh
node --test MemberWebsocket-dev/tests/*.test.js
node --test --test-concurrency=2 \
  MemberWebsocket-dev/tests/integration/line_settings_simple.cjs \
  MemberWebsocket-dev/tests/integration/line_settings_workspace.cjs \
  MemberWebsocket-dev/tests/integration/business_line_settings.cjs \
  MemberWebsocket-dev/tests/integration/line_settings_keyboard.cjs \
  MemberWebsocket-dev/tests/integration/line_capabilities_ui.cjs \
  MemberWebsocket-dev/tests/integration/line_webhook_ui.cjs \
  MemberWebsocket-dev/tests/integration/merchant_workspace_ui.cjs \
  MemberWebsocket-dev/tests/integration/product_admin_ui.cjs \
  MemberWebsocket-dev/tests/integration/notification_routes.cjs
cd MemberWebsocket-dev/tests/browser
npm test
```

The complete established CI is still the release gate. Final candidate and
merged SHAs, actual complete CI counts, native Netlify identity and deployed
asset/HTTP evidence are recorded on PR #146 and issue #59. This report does not
substitute focused tests for the complete baseline.

Local Chromium cannot launch (SIGTRAP); its two failed launch attempts are not
passing browser evidence. Initial full local integration at default high
parallelism timed out three `admin_startup` cases; isolated startup was 7/7.
At concurrency 2, the first 439 cases passed, followed by an unchanged
`FIXED_weekly` DOM journey failure. These local failed runs are not counted as
green. The initial remote candidate's full DOM lane succeeded, while its
Chromium lane exposed the locator failures described above. Final-source
Chromium and full CI must succeed before merge.

## Decisions and review boundaries

- Execute the approved plan inline and continue through merge/development
  deployment without another approval round: the user explicitly authorized
  that outcome. Cost if mistaken: a reversible development UI change guarded
  by PR, review and CI.
- Use a sibling isolated worktree to preserve the previous checkout. No product
  behavior or shared ignore policy changes result.
- Apply the already-deployed LINE capability migration to modern merchant test
  fixtures and load the actual renderer script. Otherwise configuration replay
  is absent and the fixture does not represent the current API. Cost if wrong:
  fixture divergence, checked by full API/PostgreSQL lanes.
- Verify modern settings through `module_line` and the public entry response;
  preserve the other merchant's empty configuration. Cost if wrong: an incorrect
  entry would fail the explicit public lookup assertion.
- Reduce only local integration concurrency after timer starvation; retain
  every case/assertion and the existing CI settings. No local failure is hidden.
- Regrade strict URL parsing by its unintended-entry effect and fix it in the
  same reviewed correction pass. Cost if left: saving a different app ID from
  the literal pasted path.
- Real LINE ownership, Provider alignment, login, signed ingress and human
  receipt remain external acceptance under #36. No synthetic result certifies
  them. Actual CI/deployment/layout evidence is checked separately before
  release; the reviewer did not certify these remotely.
- Encryption, migrations and notification-delivery internals are unchanged;
  existing contracts/regression remain required, rather than claiming a fresh
  comprehensive backend audit. Fixed two-OA migration remains #144 work.

## Acceptance and recovery

From the development `/admin/` entry, choose a merchant and open LINE settings.
Verify entry-only setup, advanced account correction/reload, separate booking
administrator/member purposes, saved feature links and explicit Webhook checks.
Repeat at mobile width. Real LINE login/receipt require the approved identities
and Channel ownership evidence; API acceptance alone does not establish receipt.

Recover by reverting this UI integration through the existing CI/native deploy
pipeline. Preserve saved LINE credentials, notification routes and receipts.
