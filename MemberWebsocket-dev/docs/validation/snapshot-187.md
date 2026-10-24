# #187: snapshot receipt signed-upload path

Trello: https://trello.com/c/RpM2g3wI
PR: https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/pull/28
Baseline: `7b13a825c6cff533f8235a6c1657bf10da2935f9` on `Integrated-Marketing-Platform`.

## Scope and root cause

The existing snapshot mode is the booking page's receipt capture/upload flow, not a database backup. An active member can submit a receipt without an advance booking. Administrator review remains the settlement boundary.

A confirmed defect affects business-scoped snapshot and normal-booking receipt uploads. `storageAdapter` signs `tenantUUID/memberUUID/.../image.jpg`; `prepare` returned its database-relative `memberUUID/.../image.jpg`. The browser's unscoped `uploadToSignedUrl` consequently targets a different object from the token's signed path. Legacy requests without a business prefix do not exhibit this mismatch. The original report supplied no device/session/steps; this reproducible defect is established by executing production functions, not attributed to a specific production member or device.

Minimal reproduction: open an active business booking page, enter snapshot mode with an allowed location policy, capture/select a receipt, then submit. A prepare response without the business prefix cannot be uploaded using its signed token. The same mismatch affects a normal booking receipt.

## Decision and invariants

Return the Storage SDK's `data.path` with its token. Reject missing path/token as signing failure. Keep database paths relative: the existing adapter must still prefix finalize downloads, signed views and cleanup exactly once. This avoids duplicating namespace logic in the browser or changing persistent rows. No schema, grant, account, policy, credentials or frontend change is required.

- Server identity, active membership, tenant lifecycle, feature gates and receipt ownership remain authoritative.
- No public bucket, RLS relaxation, upsert, ticket settlement or automatic administrator grant is introduced.
- Replays of `awaiting_review`/`bound` do not receive an overwrite token.
- A failed replacement leaves the prior submitted receipt intact under the existing transaction rules.

## Acceptance and evidence

| Acceptance | Executable evidence |
| --- | --- |
| AC-187-001 reproducible original failure | `node --test MemberWebsocket-dev/tests/snapshot_signed_upload.test.js`: before fix, 4 fail / 5 pass / 0 skip; two businesses × snapshot/normal fail, legacy succeeds. Red CI commit `5355cd88997b94c6e881240f886ffb99ffab0091`, run https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/actions/runs/39266704128 |
| AC-187-002 correct upload and review boundary | Same regression, plus Chromium `receipt-location.spec.cjs` business snapshot/booking cases run production prepare + namespace adapter through a token/path-checking transport; asserts one upload, one finalize, awaiting-review state and camera release |
| AC-187-003 authorization/isolation | Real pinned Supabase SDK in `business-runtime_test.ts`: signed-path substitution and overwrite rejected; legacy/A/B objects distinct. Established lifecycle, SQL receipt ownership and tenant ACL suites remain required |
| AC-187-004 failure/replay/recovery | Signing failure and submitted/bound replay cases; established receipt integrity, location, retry, replacement and transaction suites |
| AC-187-005 full regression and release | All existing Test MemberWebsocket Dev lanes, Test Netlify build and Ticket Policy UI required on the final branch commit; linked PR checks contain commands, timestamps, counts and logs. Publish workflow waits for these three workflows on the exact merged SHA |
| AC-187-006 recovery | Disable affected upload entry or fix forward the API while retaining schema/data. Do not restore the faulty relative upload response. Redeploy from the verified commit; do not restore/delete production receipts |

Local final-code regression: 990 pass, 0 fail, 0 skip, Node v24.19.0. Local targeted prepare/integrity: 15 pass, 0 fail, 0 skip. Remote CI is required for remaining checks: local Chromium crashes at startup (SIGSEGV, including single-process attempt), and Deno execution is blocked by missing `/proc/self/exe`; those executions are not passes. Local Deno typecheck remains usable.

Only the database/Storage/LINE transports in the new tests are synthetic. They are not evidence of a real LINE LIFF camera permission flow or a production authenticated member upload. Existing isolated PostgreSQL state/transaction tests and real Chromium flows remain part of the full baseline. No destructive tests or synthetic accounts are written to production.

## Release

Deploy only `booking-receipt-api` with its exact relative dependency closure after all checks pass, preserving its existing `verify_jwt=false` custom LINE verification. Database migration is not applicable because persistent structures and paths are unchanged. Merge to `Integrated-Marketing-Platform`; its established publish workflow updates the stable alias only after exact-SHA CI succeeds. Verify function ACTIVE/version, untrusted/unauthenticated requests rejected, allowed-origin/no-store headers, and deployed HTML commit markers. Actual release IDs, final checks and post-deploy smoke evidence are recorded on the Trello card.
