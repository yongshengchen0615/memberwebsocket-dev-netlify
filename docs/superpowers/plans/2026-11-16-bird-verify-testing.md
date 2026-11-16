# Bird Verify testing implementation plan

**Goal:** Use Bird Verify for first enrollment and phone changes on `Integrated-Marketing-Platform` / `MemberWebsocket-test`.
**Baseline:** `c165868c2f72a88ffa63bc5d67f75a1656bb8570`; 1,500 Node regressions pass, no skips.
**Architecture:** Extend the existing phone OTP provider call in `member-profile-api`. Retain LINE authentication, per-member/destination rate limits, existing database transaction and unique phone binding. Keep Twilio compatibility for environments without the new provider setting. No new dependencies or schema changes.
**Decision:** A provider selection inside the existing handler is smaller and safer than replacing enrollment, introducing Supabase Auth phone identities, or storing/generating OTP ourselves. Server-only `PHONE_VERIFY_PROVIDER=bird`, `PHONE_VERIFY_REQUIRED=true`, `PHONE_VERIFY_ALLOWED_COUNTRY_CODES=+886`, and `BIRD_API_KEY`; missing new flags fall back to existing Twilio flags. Both entry points must enforce the same required flag.

| AC | Given / When / Then | Evidence |
|---|---|---|
| AC-001 | Given Bird configuration, when SMS is requested, then only Bird's key-derived regional host receives the normalized phone and no code/credential reaches the client. | Provider handler tests; live approved phone |
| AC-002 | Given a pending member or changed phone, when Bird returns success=false, expires, throttles, fails or returns malformed JSON, then no verified binding or activation is written. | Handler tests; PostgreSQL baseline |
| AC-003 | Given success=true, when saving, then existing atomic RPC binds the phone; duplicate/conflicting claims remain rejected and unchanged verified phones send no additional SMS. | Handler/DB/browser baseline |
| AC-004 | Given required OTP, when calling the legacy API, then enrollment and phone changes cannot bypass verification. | Existing legacy guard plus new flag tests |
| AC-005 | Given missing/invalid Bird credentials or provider, when requesting verification, then fail closed with no Twilio fallback or network retries. | Handler tests |
| AC-006 | Given testing-only settings, when deploying, then production settings stay unchanged and all required same-version CI passes before deployment. | GitHub CI, Netlify/Edge evidence |

## Work

- [x] Add Bird transport/contract and negative tests, run RED.
- [x] Implement regional HTTPS JSON calls, strict success check and provider-neutral flags in both APIs; run GREEN.
- [x] Document exact server-only setup and update deployment/test evidence.
- [ ] Run final regression, build, integration, database, browser, Edge and audit baseline through existing CI. Compare provider call count and frontend asset bytes against baseline; do not claim live latency improvement without a comparable measurement.
- [ ] Create PR targeting testing branch; merge and deploy only after required checks pass.
- [ ] Configure Bird SMS destination and scoped key, store key only in test Edge Secrets, validate an approved real test phone, then enable the gate. Key creation, data transmission and any payment require the applicable explicit approval.

## Review focus / recovery

Reject unknown provider, invalid regional key, unexpected check success types, network failures and upstream auth failures. Provider checks must never interpret `status=verified` alone as approval. Preserve legacy Twilio behavior. Do not automatically retry paid sends or consume-once checks. No database migration is required; rollback code by reverting the commit while retaining phone verification columns and records. Keep verification required during provider outages; restore a working provider rather than silently bypassing OTP.

Live SMS delivery, balance, credential setup and end-to-end LINE enrollment remain unverified until actually executed. User selected Taiwan (+886) first.

Review found and reproduced a whitespace-only flag mismatch in the legacy entry point; both operands now trim before fallback. Dedicated RED/GREEN evidence includes pending enrollment and active phone-change guard cases.
