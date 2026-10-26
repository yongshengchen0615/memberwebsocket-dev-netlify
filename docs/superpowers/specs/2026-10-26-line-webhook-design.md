# #144 LINE Webhook design

Authority: issue #144, AC-LWH-001–006. Base: `e0b03ab159efcae19ad7a5648ca2be53b8b81b84`.

## Intent and invariants

Authorized merchants diagnose their own module's LINE connection in the existing settings page. Raw request bytes are authenticated with Web Crypto HMAC-SHA256 before events are persisted. Untrusted destination is a lookup hint only. No messages, points, tickets, reservations or member profiles are changed by ingress.

One Messaging Channel belongs to one merchant; multiple modules of that merchant may share it. Channel ownership is enforced transactionally across legacy, module and custom notification settings. A read-only LINE token/bot-info check establishes the bot destination. No Console URL changes or sends are part of this work.

## Approaches

1. Supabase Edge Function + existing platform API + private PostgreSQL inbox (selected implementation decision): reuses encrypted credentials, authorization, RPC and test fixtures; no additional backend or queue infrastructure.
2. Netlify Function proxy + Supabase inbox: adds a second secret boundary and a network hop without improving the existing backend's isolation; rejected for this scope.

## Data and authorization

Private channel ownership (only complete verified credential settings may claim), independent per-module destination bindings and terminal event receipts use RLS and service-only functions. Bindings refer to existing encrypted credentials, including legacy AES associated-data scope. Credential fingerprints include both tenant and qualification revocation epochs; up to five still-valid module candidates may authenticate the same Channel. Credential fingerprints and current merchant qualification/status/expiry/features are checked again inside the ingestion transaction. Rotation or revocation invalidates old bindings until a fresh check. Browser calls must pass verified LINE identity, current qualification, own merchant, fresh token and module grants. Denied diagnostic access emits a minimal audit entry without submitted identifiers or secrets.

Receipts contain only channel, event ID, normalized event type, provider timestamp and redelivery flag. Missing provider event ID is rejected (400); never manufacture an identity from message text/reply tokens. A unique `(channel_id,event_id)` key handles concurrent redelivery. The receipt is terminal `observed`/`ignored`: no worker or business dispatch exists in phase one. ACK follows the committed transaction, so storage failure returns 503 for provider retry. Batch limit 100 events, raw body 256 KiB, read deadline 3s and RPC deadline 5s; signed traffic is limited transactionally per channel. Unknown signatures never affect a merchant's authenticated health indicators.

## Diagnostics and UI

Read status and explicit connection check are separate. The explicit check verifies token ownership, reads bot info and records a binding without changing LINE configuration. Existing LINE tab gains a compact diagnostic section with check, refresh and endpoint copy. LIFF-only modules remain valid and report Messaging as optional. Distinguish local configuration, LINE API acceptance, authenticated ingress and human receipt (always pending until #36 supplies evidence). Expose only allowlisted summary fields.

## Validation and rollout

Node crypto/HTTP negatives; real handler + PGlite migrations/roles/rotation/isolation; disposable PostgreSQL physical concurrency via CI; Chromium 390/1280; full established CI, syntax, Edge, dependency audits and static build. Migration tests cover legacy upgrade, duplicate preflight and all direct-role denials. Feature branch and draft PR target Integrated-Marketing-Platform. No shared database migration, Edge deployment, production publication, Console changes, credential rotation or real sends before isolated environment + #36/#33 gates. Preview frontend availability does not prove deployed receiver availability.
