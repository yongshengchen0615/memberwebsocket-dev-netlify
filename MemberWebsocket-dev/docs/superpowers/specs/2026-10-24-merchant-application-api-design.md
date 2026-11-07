# #97 Explicit merchant application API

Continue the already authorized #97 two-stage approval design. This batch exposes
the four tested merchant SQL RPCs through the existing LINE-verified handler.
It is candidate-only: SQL, context revocation and both UIs must ship together.

Use `platform.merchant.list/get/submit` with the fixed applicant Channel, and
`platform.merchant.review` with the Platform Channel and current super-admin
check. These actions reject a business route: a client cannot change which
Channel verifies these account-level operations. Actor comes only from verified
LINE identity. List/get are rate-limited reads; writes use the existing limiter.

Submit accepts businessName/slug/requestId, plus a paired applicationId and
expectedVersion only for explicit resubmission. Get takes applicationId; list
takes no selector. Review takes applicationId/expectedVersion/decision/reason/
features/requestId. Approval requires the exact eight boolean feature keys;
rejection requires a nonblank reason and no feature grants. Match existing SQL
limits (100 Unicode code points for names, 500 for reasons, positive int32 version).
SQL owns ownership, qualification, version, idempotency and transaction rules.

Responses expose only application metadata and `publicTenant` output; never raw
tenant rows or encrypted envelopes. Return stable safe errors for qualification,
selection, version, duplicate slug, reviewed state and request conflicts.

Alternative considered: change the legacy single-application actions in place.
Rejected for this batch because the current frontend still depends on them;
explicit actions keep the unfinished rollout contained to Draft #102. No new
dependencies, auth protocol, remote SQL, provider configuration or data changes.

AC-001 qualified owner A can approve merchant A then submit distinct pending B.
AC-002 list/get return only owned applications and sanitized per-merchant grants.
AC-003 only a current Platform reviewer can approve/reject an exact version.
AC-004 malformed input, spoofed actor/Channel, wrong Channel and missing identity
cannot mutate merchant state; current qualification and permissions govern retries.
AC-005 duplicate slug, conflicting request, stale review, rejected resubmission,
rate-limit/provider failure and SQL failure preserve consistent rows and safe output.
Full existing CI remains required; stub LINE results are never real-provider proof.
