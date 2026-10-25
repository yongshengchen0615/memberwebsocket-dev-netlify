# #97 Coordinated Merchant Rollout

> **For agentic workers:** Use executing-plans and test-driven-development. UI and backend have distinct file ownership and the interfaces below; dispatching-parallel-agents applies. One whole-branch review before coordinated release.

**Goal:** User can accept qualification, independently reviewed multiple merchants, selecting each existing admin workspace, scoped LINE writes and revocation on Integrated-Marketing-Platform.
**Architecture:** Existing private qualification/application/tenant schema and four explicit merchant APIs. Explicit-context SQL writers and metadata RPC add authoritative qualification/current-token checks. Existing UI remains for legacy config; merchantApprovalVersion=2 in real deployed config selects coordinated journey with its own full tests.
**Tech Stack:** Existing JS/TS, PostgreSQL17, PGlite, Deno, Playwright, Supabase, Netlify.
**Spec:** #97 original AC-001–010; previous qualification/merchant designs and user continuation explicitly requests integration/deployment for acceptance.

## Global constraints
- No alternate auth protocol, credentials in frontend, automatic approval, tenant resource copying, deletion/reset or Production frontend promotion.
- Account list/get/submit and qualification APIs use fixed applicant Channel; review uses Platform Channel. Neither accepts business routing.
- Business-selected settings use existing platform.application.bootstrap + business slug; backend resolves exactly one owned approved merchant, current qualification and valid issuedAt.
- SQL/settings APIs reject other owners, unqualified states, suspended/expired tenants and stale tokens even on replay. Per-tenant grants and current row state govern writes.
- Qualification suspension restricts the owner's administrative access; tenant suspension/expiry independently restricts all tenant clients. Member access does not inherit owner token freshness.
- No partial rollout. Verify final full CI, apply missing candidate SQL and coordinated backend, merge to integration and verify exact-SHA Preview. Real LINE interaction remains human acceptance, never stub proof.

## Interfaces
- Existing qualification bootstrap/submit/list/review and platform.merchant list/get/submit/review unchanged.
- UI config `merchantApprovalVersion: 2` enables new journey. Merchant bootstrap first reads qualification, lists applications only if approved. Root loads platform.bootstrap + platform.qualification.list. State/poll refresh must never recreate or auto-select an application.
- Selected LINE workspace: /admin/workspace.html?business=slug; existing business bootstrap/save/notification actions carry slug, now scoped by backend. All existing /admin/?business=slug admin modules reused.
- Fresh fixture `tests/integration/fixtures/merchant-http.cjs` will export setup({origins?:string[],...}) returning real handler, db, root/owner/other synthetic tokens manager/root/other, qualify/submit/review SQL helpers. Only LINE HTTP and limiter are stubbed.
- Explicit-context metadata `platform_business_context_v2(p_actor text,p_slug text)` returns original tenant plus authoritative qualification status and admin cutoff. The runtime only uses original token subject as a routing hint; actual LINE verification still required for admin actions, including cutoff.
- New `_for_merchant` SQL writer signatures take actor + tenant ID + issuedAt + original arguments; application context RPC takes actor+slug+issuedAt. Browser roles cannot execute them.

## Review focus
1. Same owner A/B has distinct schema/grants/settings; request replay cannot cross tenants.
2. Suspension and old verified token after resume deny every admin endpoint, including action-less admin wrappers.
3. Public/member lookups do not expose qualification/private metadata or inherit admin cutoff.
4. Approval races and migration backfill preserve legacy records and reviewer permissions.
5. Account routing cannot be contaminated by BusinessContext or cached selected merchant.

### Task 1: SQL, runtime and handler (primary)
- [x] Write/run RED scoped LINE/notification/bootstrap, qualification suspension and stale-token tests.
- [x] Generate migration via CLI; implement explicit invoker functions, fixed search_path and service-only ACL; keep legacy writers fail closed on ambiguity.
- [x] Add current qualification metadata and server-verified admin freshness across endpoint wrappers; scoped handler RPCs and business routing exceptions.
- [x] Export shared actual SQL/handler fixture; physical PostgreSQL tests for authorization races and final rows (execution remains required in CI).

### Task 2: Portal UI (independent worker)
- [x] TDD new config version: explicit qualification submit/pending/reject/resubmit; approved qualification sees My Merchants + independent new merchant submit/reject/resubmit.
- [x] Approved merchant card links existing /admin/?business=slug; pending/rejected/suspended/expired no management links; selected workspace supports LINE settings and return to list.
- [x] Root separates qualification list/review from merchant review with exact versions, rejection reasons and eight grants; existing grant/status/expiry controls retained.
- [x] Add mobile/accessibility/error/replay/revocation cases and new real-handler browser journey; retain legacy baseline tests as compatibility coverage (Chromium execution pending CI).

### Task 3: Verification and release (primary)
- [ ] Full Node, DOM/SQL, physicalPG, Deno, all Playwright, build, static wiring, dependency audit on final commit.
- [ ] Independent whole-branch review; fix Important via RED→GREEN and full CI.
- [ ] Compare live schema/source; apply only missing non-destructive SQL to approved MemberWebsocket-dev, deploy every affected existing endpoint with its existing JWT policy.
- [ ] Integrate latest tested tree into Integrated-Marketing-Platform, exact-SHA CI + Netlify ready + 21-path smoke; verify new config and assets remotely.
- [ ] Update #97/#39/#41 with exact evidence and manual steps; do not claim real LINE completion.

## Ledger
- Source 2e69cda; integration base 2e66ffb; isolated task-local branch feat/merchant-rollout-97-20261024.
- Ruling: user requests actual integration, so previous no-partial-publish restriction is resolved by completing the coordinated journey, not by publishing earlier partial API.
- Ruling: version flag is rollout compatibility, not authorization. SQL/Edge gates always enforce current authority. Existing tests cover legacy config; new tests must explicitly cover real v2 config before it becomes enabled in deployment.
- SQL context5/0/0 and handler3/0/0 after RED; two route-isolation Node tests RED→GREEN. UI12/0/0 includes real handler/SQL and BusinessContext A/B writes; existing compatibility14/0/0 after legitimate fixture migration. The mocked verifier fixtures now include issuedAtMs; cross-business error contract is non-enumerating404; original stale-identity401 assertion retained.
- Runtime RED7/8→GREEN13/13; full Edge business/delivery40/40 using actual production TS modules/SDK through a scratch Node native-TS compatibility runner. Deno typecheck succeeds, but local Deno execution panics because /proc/self/exe is unavailable. No runtime assertion/authorization fallback was added for this environment; Deno CI is required.
- Local Chromium installed but exits SIGTRAP before any case with /proc unavailable. Two real browser journeys remain mandatory in CI, not counted locally.
- Ruling: migrated singleton clients without an explicit business parameter still run the new qualification and issuedAt gate using their unique SQL-selected application. Legacy pre-upgrade schema is identified by absence of the server-produced qualificationId; once upgraded every returned application has that ID. Multiple merchants always require selection. Cost if SQL contract drifts: a request fails or a pre-upgrade compatibility branch could persist; coordinated schema/version inspection is required before release.
- Additional RED→GREEN: selected merchant LINE settings previously initialized the fixed account LIFF instead of the trusted custom merchant LIFF. Configure selected business before LIFF init; keep fixed account and Platform channels on their own entrances. Existing six fresh-entry negatives retained.
- 2026-10-25: Preserve concurrent integration #123 per-feature LINE forms. Upgrade BUSINESS_APPROVAL_ACTIVATES to the actual qualification → merchant review → explicit manage journey, retaining its scoped module/LINE/mobile assertions. Notification browser verifier now includes the real verifier's issuedAt contract. Prior candidate Chromium failures were these outdated fixtures, while both new v2 journeys passed.
- Whole-branch independent review found an Important runtime revocation race after LINE verification. Added a fourth migration with a service-identity-bound PostgREST pre-request guard: each marked admin write holds current qualification/tenant shared locks through its own table/RPC transaction. Readonly requests validate without row locks; unmarked member/jobs retain existing authentication. Scoped SDK transport overwrites internal markers using verified claims, never caller values. Physical transaction race tests cover direct UPDATE and existing tenant RPC in both commit orderings. LINE/storage mutations recheck before dispatch; already-dispatched external operations can complete, since external providers do not share a Postgres transaction. Runtime transport tests were observed RED before the fix and then GREEN; final full CI remains required.
- Candidate9886954 passed full CI11/11: Node1050, DOM544, PostgreSQL35, Chromium288, Edge43 and build91. Coordinated backend deployment preserved existing tenant/application/root and all29 JWT policies. Live HTTP then exposed cold anonymous compilation of private composite types in the public hook (42501 before its early-return branch). A fifth forward migration separates the built-in-types-only public wrapper from the unchanged service-only private validation/locking helper; never grant browser roles private schema access. Added fresh TCP anon/authenticated-first-call cases, with exact PT403 forged-marker rejection. This demonstrates why SQL warm-session success alone is not live PostgREST activation proof; frontend merge waits for the fixed final CI and live HTTP verification.
