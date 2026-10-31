# Webhook friends and new LINE invitations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. The user explicitly requested continuous implementation through Integrated-Marketing-Platform acceptance; do not pause for routine design/plan reconfirmation.

**Goal:** Deliver merchant-scoped OA friendship observations, add/unblock/recheck signup guidance, and server-issued LINE invitations that reward only verified first membership activation, to the Integrated-Marketing-Platform Preview.

**Architecture:** Extend existing signed Webhook ingress, business-scoped growth/profile APIs and tenant installer. Keep realtime server friendship verification as the activation authority. Preserve existing member friends/QR/legacy referral/booking semantics and existing reward RPC transaction constraints.

**Tech Stack:** Existing plain JS/LIFF 2, Deno/Supabase functions, PostgreSQL17, Node24 regression/Node22 SQL/browser CI, JSDOM/Playwright pinned lockfiles.

**Spec:** Existing Issues #158/#157/#151/#152/#150/#149/#153 and #154/#148, plus AGENTS.md and docs/DEVELOPMENT_GUARDRAILS.md. User steering supersedes the previous #149-only proposed scope in PR171.

## Global Constraints

- Target `Integrated-Marketing-Platform` Preview only; preserve Production endpoints, tenant data, secrets and LINE Console settings.
- `follow`, `unfollow`, share result and URL click never create/activate members or issue rewards. Only server-verified first activation can settle an invitation.
- Existing member friendships, QR, legacy `bind_member_referral`, booking edits/recipient ownership and historical claims are unchanged.
- No raw LINE tokens in storage/logs. New invitation tokens use cryptographically random 32 bytes, hash-only database storage and 7-day TTL.
- Ruling: lock the first valid authenticated pending-member claim, never overwrite it; reject self, active members, cross-tenant/expired/suspended sources. This chooses the existing #151 recommendation and can be reversed before release if its tests reveal a contract conflict.
- Reuse current tenant/schema authorization, terms/first-activation gate, existing referral campaign templates and quota/idempotency. Join gift stays independent.
- Full same-SHA established CI, independent review and Preview source/Edge/DB/deploy smoke are required. Real LINE acceptance is reported separately; no mocks-as-Provider claim.
- Do not install new product dependencies. Supabase CLI latest crashes in this container; verified executable fallback is `npx --yes supabase@2.81.3`, use its `migration new` to generate migration names.

## Review Focus

- Same LINE user in A/B shops: no invitation claim or OA observation crosses tenant/channel/feature.
- Equal timestamps, old revisions and redelivery: no resurrection from unfollow to follow or double effects.
- Two concurrent invitation claims/activation: one attribution and one reward, retries preserve quota and original member profile.
- Disabled/expired/exhausted campaign or revoked inviter: no false success; safe retry does not repeat reward.
- LIFF cancel/unsupported/closed window, expired session and shop switch: truthful statuses, copy fallback and no stale account data.

### Task 1: Webhook friendship observations (#158)

**Files:** `_shared/line-webhook.mjs`, new additive migration generated `member_oa_webhook_state`, tests `line_webhook.test.js`, integration `line_webhook_sql.cjs` and existing fixture/postgres cases as appropriate. Prefix product paths `MemberWebsocket-dev/supabase/functions/` and migrations/tests accordingly.

**Interfaces:** Existing `platform_line_webhook_ingest(p_channel_id,p_feature,p_revision,p_events)` remains signature compatible. Sanitized follow/unfollow events may add validated `sourceUserId`; missing source on old receipts remains accepted without a state update. Produce private service-only per tenant/channel/feature/revision/user observations, never registration authority. Membership observations must derive from the currently verified membership binding, not an arbitrary user-supplied audience; other module events remain receipts only.

- [ ] Add RED cases for signed source sanitization, duplicate/old/equal timestamps, wrong tenant/channel/revision and missing/non-user source.
- [ ] Run tests, record actual RED.
- [ ] Extend atomic ingestion and minimal private state with deterministic same-timestamp unfollow precedence, dedup before update, no member/reward writes; deny browser roles and use invoker/service-only functions.
- [ ] Run focused Node/SQL/PG cases; preserve current webhook tests and receipts contract.
- [ ] Self-review, commit owned files only; independent task review.

### Task 2: Trusted invitation attribution and reward backend (#151/#152)

**Files:** new tenant installer migration; focused shared invitation helper if necessary; `member-growth-api/index.ts`, `member-profile-api/index.ts`, matching legacy api action if reachable; business policy action allowlist; focused Node/SQL/PG/HTTP tests. No frontend edits in this task.

**Interfaces:** Produce `member.invitation.create` -> `{ invitationUrl, expiresAt, campaign }`; `member.invitation.summary` -> `{ joinedCount, rewardedCount, pendingCount, rewards }`; `member.invitation.retry` retries only current actor's pending eligible rewards. Signup action `user.member.invitation.claim` with `{ invitationToken }` locks attribution for the verified pending member and never activates. URL uses same merchant member entry with `business` and `invitation` query state, no member-code privilege. Coordinate exact response names before frontend task.

- [ ] Inspect original tenant installer, referral tables/reward RPC and first-activation RPC/trigger. Confirm reuse is schema-correct; do not replace the legacy RPC semantics.
- [ ] Add RED cases for mint/claim/first lock/self/active/cross-tenant/expiry, activation transaction, campaign quota, duplicate/retry and original referral preservation.
- [ ] Implement hash-only invitation and attribution records with explicit RLS/revokes, per-tenant uniqueness and installer compatibility for existing/new tenants.
- [ ] Tie settlement to the trusted activation lifecycle; only activated attribution may call existing schema-scoped legacy reward transaction with inviter as reward recipient. Failed campaign settlement leaves explicit retriable outcome and cannot duplicate claims.
- [ ] Expose authenticated rate-limited actions, validate full input types/length, derive tenant/actor/channel from trusted runtime. Return truthful campaign/summary without private invitees or raw hash/token.
- [ ] Run focused SQL/HTTP plus real PG17 concurrency in required CI; self-review and commit; independent task review.

### Task 3: OA signup guidance and native LINE invitations (#157/#150/#149/#153 member slice)

**Files:** `member/app.js`, `member/index.html`, member styles, `member/member-growth.js`, `member-system.js`, `friends.js` only where context cleanup is required; focused DOM/browser tests and workflow wiring owned by root.

**Interfaces:** Consume Task2 actions. Expose server-trusted OA add-friend URL/status through existing profile bootstrap if needed; no browser guesses of OA identity. Preserve existing active-member entry. New invitation UI is separate from the old code-based compatibility section.

- [ ] RED DOM/browser tests: signup nonfriend, Full-window requestFriendship -> getFriendship recheck, cancel/error/unsupported copy fallback, old active members, shop/session change, new invite create/share/summary/claim.
- [ ] Show add/unblock/recheck at first signup; window close never means success. Submit still invokes existing server OA gate. Use trusted HTTPS OA fallback; no automatic popup loop.
- [ ] Native `liff.shareTargetPicker(messages,{isMultiple:true})` on explicit user click using server URL; undefined result is cancelled; no recipient count/list or reward from share. Copy/system share fallback handles failures truthfully.
- [ ] Capture incoming `invitation` through normal LIFF redirect safely, claim only while authenticated pending; do not persist tokens beyond necessary scoped current-page flow. Successful registration reads real summary.
- [ ] Preserve friends/QR/old referral and action IDs/assertions unless intentionally extending copy tests; run focused 390/1280 and adjacent member/booking regression.
- [ ] Self-review/commit and independent task review.

### Task 4: Full verification, integration and Preview acceptance

**Files:** existing CI wiring, source preparation/build/deploy scripts only as required; evidence report in docs/superpowers.

- [ ] Run full established local feasible lanes and all required remote CI at exact candidate SHA; inspect every failure and fix cause without weak assertions/skips/timeouts.
- [ ] Whole-branch independent review; resolve material findings and rerun affected/full final checks.
- [ ] Confirm additive migration against read-only live schema, deploy preview-specific Edge import graphs without overwriting Production functions; run advisors and rejection smoke.
- [ ] Merge reviewed PR to Integrated-Marketing-Platform only after complete required CI; verify exact merge SHA CI and existing Preview publisher.
- [ ] Read back deploy ID/page/config/asset hashes, API unauth/CORS/no-store; provide live member/admin entry and concrete acceptance steps.
- [ ] Real LINE Console/consenting accounts missing means the corresponding Provider AC remains blocked, with exact resource needed; finish all independent engineering and never mark those AC passed.

## Recovery

Revert this increment through reviewed commits/full CI and redeploy forward; no automatic old Netlify deploy restore, no data wipe or unreviewed DROP. Keep new additive data until a separate retention decision. Do not configure Console, rotate secrets or send unsolicited LINE notifications.
