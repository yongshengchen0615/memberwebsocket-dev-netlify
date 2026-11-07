# #124 LINE capability / #60 booking risk design

Source baseline: `5255c347b6748b7df7371c2ad574735b11d3b2ba`, Integrated-Marketing-Platform.
Authority: the user requested implementation of existing issues #124 and #60. Their AC and business contracts remain binding; this document records implementation decisions, not new user requirements.

| Concern | Decision / invariant |
|---|---|
| Goal | Approved merchants can configure a valid per-feature LINE Login/LIFF without unused Messaging credentials; booking managers can safely review policies, events, restrictions and appeals. |
| Identity | Preserve verified LINE identity, qualification and explicit merchant context. No client-provided role establishes authorization. |
| Permission | Preserve SQL row locking, feature grants, tenant suspension/expiry, private schemas, service-role-only RPCs and transaction guards. |
| State | LIFF readiness is independent of messaging readiness. Policy activation is explicit; default remains disabled. Replying to an appeal does not release a restriction. |
| Data | Preserve existing encrypted credentials, module scope, request IDs, version checks, event history, policy snapshots and expiry dates. |
| Limits | No production frontend release, no destructive remote tests, no real LINE sends. Use existing test project only for reviewed additive deployment and read-only smoke. |
| Failure | Reject cross-merchant/module writes; never imply notification readiness without verified credentials. Conflict requires explicit refresh; no silent resubmission. |

## Approaches

1. **Selected implementation decision:** extend existing validator, handler, module-line RPC and UI; use existing dialog/confirmation patterns and return only the minimal risk record context required by the UI. This keeps current isolation and migration/test machinery.
2. Split authentication/messaging into new services and rebuild risk management. Rejected: unnecessary architecture, migration and regression cost for these existing features.

## Acceptance mapping

- #124 AC-001/002: all LIFF features accept matched Login Channel + feature LIFF without Messaging credentials; calendar has no push capability; notification save/test remains fail closed without valid verified channel.
- #124 AC-003/004: cross-tenant/module, revocation, bad versions and changed-payload replays remain rejected; legacy envelopes and notification routes survive updates.
- #124 AC-005: isolated SQL/PGlite/PG17, 390/1280 Chromium and complete exact-SHA CI. Real Provider delivery is separately reported, never inferred.
- #60 AC-RISK-UX-001/002/003: blank disabled policy, validated live summary and explicit enable/disable confirmation; no backfill or snapshot changes.
- #60 AC-RISK-UX-004/005/006: readable minimal member/booking/time context, distinct revoke/release/reply confirmations with reason and cancel; server idempotency/audit preserved.
- #60 AC-RISK-UX-007/008/009: safe version refresh, revoked/foreign access denied, existing booking/ticket/notification baseline, responsive keyboard/focus/status checks.

## Validation

Run existing workflow commands and new tests, then review the immutable diff. Capture RED/GREEN logs, final full-suite results and CI run links. Missing native PostgreSQL/Chromium/Deno locally must be supplied by exact-SHA CI or reported blocked. Deploy SQL/Edge before frontend where compatibility permits; check remote catalog, deployment identity, public bundle digests and protected HTTP behavior. Roll back by reverting code and redeploying through the established pipeline; never delete credential or risk history.
