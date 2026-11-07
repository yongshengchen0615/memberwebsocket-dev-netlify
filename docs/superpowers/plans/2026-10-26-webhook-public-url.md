# Webhook Public URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Diagnostics returns a correct external HTTPS receiver URL behind Supabase's gateway.
**Architecture:** Resolve the receiver from a trusted public project origin inside the existing diagnostics module; inject the origin from the Edge entrypoint. Reject missing/unsafe configuration before a check mutates bindings.
**Tech Stack:** Existing JavaScript/Deno, Node tests, PGlite, Playwright, Supabase, Netlify.
**Spec:** `docs/superpowers/specs/2026-10-26-webhook-public-url-design.md`

## Global Constraints

- No DB/schema/credential/Console changes or new external messages.
- Preserve authorization, tenant isolation, all existing assertions and CI gates.
- Merge/deploy only to the already authorized development environment.

## Review Focus

- Rewritten HTTP request loses the public path: exercise real handler with that exact request.
- Spoofed host/protocol/body: assert configured origin wins.
- Invalid public origin: assert safe error, zero Provider calls/bindings.
- LIFF-only status and revoked/foreign scopes: retain the existing cases.
- Clipboard consumer: existing 390/1280 browser tests use the gateway-shaped request.

### Task 1: Correct and release diagnostic URL

**Files:** `functions/_shared/line-webhook-diagnostics.mjs`, `functions/_shared/platform-handler.mjs`, `functions/platform-api/index.ts` under `MemberWebsocket-dev/supabase`; existing webhook API/fixture/browser tests and new endpoint unit test.
**Interface:** `createPlatformHandler({...existingOptions, publicSupabaseUrl})`; `lineWebhookEndpoint(publicSupabaseUrl)` returns an HTTPS absolute URL or throws a safe `WEBHOOK_ENDPOINT_UNAVAILABLE` PlatformError.

- [ ] Add unit and real handler gateway/configuration regressions; run and preserve RED.
- [ ] Add trusted origin resolver, entrypoint injection and early diagnostic validation; run GREEN and adjacent regressions.
- [ ] Measure status RPC/provider count and alternating same-runtime timings against a5a618d; record limits, source sizes and raw samples.
- [ ] One independent whole-branch review, fix findings with tests, then exact-SHA full CI.
- [ ] Merge, verify full merged CI, deploy only matching platform-api source, verify readback, native preview identity and smoke; update #144/PR with evidence and remaining real LINE acceptance.
