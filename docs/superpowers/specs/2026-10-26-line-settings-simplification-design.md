# LINE settings simplification — proposed design

Status: proposed; awaiting Jasper's design choice and approval. No product code,
stored credentials, LINE configuration, database or deployment is changed by this document.

Source baseline: `Integrated-Marketing-Platform@3be0c0e7a06414e0fb706395aca05fbb2724480d`.
User request: simplify LINE setup while preserving all existing LINE functions.
Related issues: #59 (UX), #80 (single entry), #123/#124 (feature capabilities),
#144 (Webhook), #36 (external acceptance).

## Intent and observed problem

An authorized merchant administrator should configure a feature by its purpose,
without first understanding every LINE resource. Existing settings and working
login, feature entry, notification and Webhook behavior must continue to work.

Two implementations currently expose different workflows:

- `/admin/workspace.html` uses `platform/app.js` and the legacy
  `#merchantLineForm`. `/admin/` also mounts this shell through
  `admin/productized-workspace.js`. A selected merchant still has the legacy
  shared-first path: four identity/Channel fields plus two Messaging secrets,
  and feature saves are blocked by `onboarding.commonMissing`.
- The business workspace uses `admin/business-line-settings.js`, already backed
  by per-feature saves, optional Messaging credentials, purpose-specific
  notification routes and Webhook diagnostics. Its inputs and technical
  explanations remain dense. Existing tests for this component alone do not
  establish that the selected-merchant settings entry exposes the same behavior.

This work must cover both real merchant entry paths, not merely restyle the
component served by isolated browser fixtures.

## Approaches

1. **Recommended proposal: simple task flow with advanced disclosure, reusing
   existing feature APIs and renderer.** Align the selected-merchant settings
   path with the existing per-feature capability model. Show entry setup and
   notification purposes first; expand technical configuration when required.
   No new LINE account data model or credential migration. This directly reduces
   unnecessary entry while keeping existing configurations compatible.
2. **Centralize each merchant's fixed admin/member OA accounts now.** This can
   remove repeated Messaging credentials across features, but requires defining
   canonical account ownership, migrating legacy/module/custom routes and
   validating all existing notification senders and Webhook audiences. Keep it
   as the explicitly unfinished #144 work, rather than silently introducing it
   as a UI optimization.
3. **Hide the old shared form behind an accordion only.** Smallest visual change,
   but leaves compulsory Messaging setup and shared-first blocking unchanged.
   Rejected because it does not resolve the observed workflow problem.

These are implementation proposals, not choices already approved by the user.

## Proposed user flow

One existing LINE settings entry, within the selected merchant. Only granted
features that actually use LINE appear. Keep existing feature names and
keyboard-accessible navigation.

### 1. Feature entry

- Lead with feature purpose, saved entry status and the relevant LIFF ID.
- Accept a LIFF ID or a strictly validated `https://liff.line.me/<id>` paste;
  normalize only this exact host/path with no credentials, query or fragment.
- Offer the corresponding Login Channel ID as an automatically filled,
  inspectable value under account details, using the prefix rule already
  enforced by the backend. This is a convenience, not ownership verification.
  Keep manual correction available and reject inconsistent pairs before save.
- Ask for merchant administrator Login/LIFF only when the existing backend
  binding is missing. Explain it once as merchant-wide identity; preserve
  existing immutable bindings. First setup may therefore still require an
  administrator LIFF in addition to the feature LIFF.
- Show the exact merchant-scoped Endpoint and saved LIFF launch link alongside
  the input, with copy/open actions. Draft values must not be labelled saved.
- Use a clear `儲存入口設定` action. No Messaging token or secret is necessary
  to save an otherwise valid LIFF-only feature through the existing feature API.

### 2. Notifications when needed

- Show human-readable purposes: booking administrator notification and booking
  member notification remain separate; other supported features show their
  existing member purpose. Calendar has no fabricated push capability.
- Show current saved state first. Existing enabled, inherited, custom and
  disabled routes retain their exact values; opening the page never changes
  modes or enables/disables notification delivery.
- Each purpose offers the existing choices in plain language: use this
  feature's account, use another account, or disable this purpose.
- Reveal Messaging Channel/token/secret only when editing an account that needs
  them. A custom notification route still requests the existing Channel+token
  contract; do not add a secret requirement to a token-only route.
- Secrets remain blank after load/save; blank means retain wherever the existing
  contract supports it. Changing Channel requires the existing credential checks.
- Keep explicit save and explicit test actions. Testing retains the current
  authenticated administrator recipient and requestId behavior; it never
  silently targets members. No live test is sent during development without
  the existing authorized sandbox/recipient acceptance.

### 3. Advanced connection details

- Keep Webhook health, read-only connection check and Endpoint copy under a
  concise advanced disclosure. Reuse #144 APIs; do not create a second receiver.
- Distinguish saved configuration, LINE API acceptance, verified Webhook ingress
  and human receipt. No inferred green success or automatic real-message test.
- A dirty credential draft disables connection checks against older saved
  credentials, retaining both the UI control and execution guard.
- Move long Console instructions and recovery explanations to contextual help.
  A collapsed required/invalid field must open and receive focus on validation.

## Integration and invariants

Reuse the existing feature renderer with an explicit authenticated request/
bootstrap adapter for the productized merchant shell. Keep the existing
MemberAdminSession transport for the business workspace. Never synthesize a
second login, global token store or cross-merchant credential cache merely to
mount the renderer. The adapter must use the current verified idToken and
explicit selected merchant context already owned by `platform/app.js`.

For the modern `moduleLine` capability, use the per-feature `platform.line.save`
path, preserving the other feature snapshots. Retain legacy compatibility
behind its existing capability detection; do not call the module RPC on an
unsupported backend. Do not remove the legacy form's required DOM contract
without updating its callers and fallback tests.

Maintain API authorization, current qualification/grants, tenant expiry and
revocation, immutable administrator identity, secret encryption/redaction,
requestId retry and version-conflict behavior. Preserve drafts only within their
merchant/feature/purpose. On merchant switch, logout or revoked access, clear
secret drafts, pending requests and diagnostic state; stale async responses
must not populate the newly selected merchant. Pending uncertain operations
remain retryable with the original payload and requestId.

No database migration, credential backfill or account consolidation is proposed.
No LINE Console callback, token rotation, notification scheduling or business
mutation is part of this UI change. Fixed two-OA account topology remains valid
as a separate unfinished requirement; the UI must not mislabel Login Channels
or LIFF apps as official accounts.

Builder decisions: exact component extraction, adapter signature, CSS spacing,
copy wording and file organization may be chosen during implementation. Prefer
small changes and existing styles/dependencies. No generic wizard framework,
new UI library or parallel settings page.

## Acceptance and verification

- Actual `/admin/` selected-merchant route and `/admin/workspace.html` support
  LIFF-only setup through the real handler and isolated SQL; no shared Messaging
  prerequisite. Saved feature public entry remains usable.
- Initial administrator identity appears only when missing; configured merchant
  settings are not rewritten automatically. LIFF normalization and mismatched
  Channel/LIFF fail visibly and safely.
- Existing module-specific Login and Messaging values and custom admin/member
  notification routes survive load, edit, save and reload unchanged unless that
  exact setting is explicitly edited.
- Save/retry/conflict, keyboard focus, disclosure validation, secret redaction,
  disabled/expired grants, merchant A/B switch and stale async response coverage.
- Real application-shell browser journeys at 390 and 1280 widths; isolated
  renderer fixtures supplement rather than substitute for them. Check no
  horizontal overflow and reduced default visible fields on a configured shop.
- Retain established Node, DOM/PGlite, PostgreSQL, Edge, Chromium, syntax, wiring,
  build and dependency audit lanes on the final SHA, with actual pass/fail/skip
  counts. Update existing human-journey coverage rather than weaken assertions.
- Development release on `Integrated-Marketing-Platform` only after all required
  CI and review. Verify exact deployed source/assets and protected API smoke.
  Report real Provider login/receipt separately, using existing #36 evidence.
- Recovery: revert the UI integration commit and rebuild through the existing
  pipeline. Existing saved LINE credentials and receipts are preserved.

## Approval boundary

This document is the concrete proposal for approval. Implementation and any
development deployment follow only after the design choice is confirmed.
