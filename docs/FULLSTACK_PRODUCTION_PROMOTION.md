# Full-stack production promotion: master → MemberWebsocket-main

**Status: protected implementation, not enabled until one-time migration reconciliation and release baseline authorization.** This document does not authorize production writes.

## Purpose and invariants

- An accepted `Integrated-Marketing-Platform` release must update the production **database schema, RPC/RLS/triggers, Supabase Edge Functions, and Netlify frontend** before being called complete.
- `master` is the **production release branch** although the repository's GitHub default branch is `main`; `Integrated-Marketing-Platform` remains connected to `MemberWebsocket-test`.
- No production member, merchant, booking, credit, voucher, auth session, Storage object or provider secret may be copied from test or overwritten by promotion.
- All release components use one Git SHA and a recorded `production-fullstack` baseline; a failed backend promotion must not publish the frontend.
- A live project migration ledger is authoritative only after reconciling existing history; migration file timestamps and remote history cannot be equated by filename alone.

## First-principles and decisions

| Element | Confirmed and required |
| --- | --- |
| Goal | Test acceptance → reviewed merge → production SQL/Edge/frontend updates |
| Identity | GitHub Actions on exact `master` SHA; production tokens in Actions Secrets |
| Authorization | Workflow runs only on production ref; merge permissions and required checks must be configured in GitHub UI |
| State | `baseline checked → full CI → migrations → affected Edge Functions → Netlify → smoke → advance baseline`; every failure stops |
| Data | Only schema/code migration SQL; no test data or secrets transferred |
| Constraints | Production has 341 migration history entries, checked-in master has 309 SQL files; many versions differ; test has a cloned baseline with 19 history entries |
| Decision | **Fail closed until a one-time audited migration reconciliation**, then use Supabase CLI migration history; do not execute the entire SQL folder as raw `psql` |
| Alternative rejected | Blind `supabase db push --include-all`, wholesale schema clone or blanket Edge deployment: high data, rights and regression risk |

## Read-only baseline findings (2026-11-16 UTC)

- Repository `master`: **309** checked-in SQL migrations; live `MemberWebsocket-main` ledger: **341** entries. **125** migration timestamp IDs match; **184** checked-in SQL filenames are absent under their source timestamp in the production ledger and **216** production ledger timestamps do not occur in the Git tree. The history may reflect imported/re-stamped migrations, not 184 necessarily missing schema changes. Never interpret these counts as a command to replay SQL.
- Production and test `public` each contain 64 tables/734 columns/341 functions. `platform_private` and `line_config` column signatures also match. Of the **383** compared function signatures in `public`, `maintenance`, and `platform_private`, **7** source-definition fingerprints differ: five `maintenance.*sandbox*` reset helpers, `public.maintenance_sql_reset_claim`, and `public.sync_fixed_ticket_calendar_item`.
- The exact single differing line inside `public.sync_fixed_ticket_calendar_item` contains an environment-specific activity-ticket URL: production points to the existing public GitHub Pages event site and testing to the Integrated Netlify branch. These must **not** be blindly synchronized as identical SQL bodies. Confirm the intended production event domain with actual business and LINE links before any URL change.
- `master` currently has `protected=false`, and the `production-fullstack` release tag does not exist. These are **blockers**, not assumptions. Repository ruleset and approved baseline bootstrapping are necessary to provide an enforceable release gate.
- This release planner blocks new SQL containing the known testing project ref, testing branch URL, test project name, and SQL reset confirmation marker. It does not prove that all possible unsafe migrations have been detected.

## Release procedure

1. **Testing acceptance**: Verify the Integrated branch against `MemberWebsocket-test`: all existing CI, Postgres, browser E2E, LINE/LIFF and Bird OTP sandbox where applicable. Confirm new migration SQL has really run on the isolated testing database (cloned testing migration version numbers differ from production).
2. **Migration baseline reconciliation (one-time, production read-only first)**: Export and compare the live schemas, roles/grants, RLS, functions, triggers, constraints, indexes, migration checksums, and current migration ledger against the repository SQL files. Establish exactly which files are already reflected in production. Do not automatically mark 309 files as applied, replay 341 historical migrations, or copy the testing ledger. A reviewed reconciliation procedure must be approved and verified by a database owner.
3. **Release baseline (one-time, after independent verification)**: Confirm the exact `master` commit already represented by the currently deployed **production frontend and backend**. Create lightweight `production-fullstack` Git tag pointing to that audited commit. Never infer this merely from a Netlify deploy title. Verify the tag exists and that `git merge-base --is-ancestor` holds for the next release.
4. **Secrets**: Add `SUPABASE_PRODUCTION_ACCESS_TOKEN` (Supabase Personal Access Token authorized for the production project) and `SUPABASE_PRODUCTION_DB_PASSWORD` (production project database password) to **GitHub Repository → Settings → Secrets and variables → Actions**. Keep `NETLIFY_AUTH_TOKEN` as already required. Never expose values in logs, JSON, Netlify public variables, PR text or repo files. Ideally use a GitHub `production` Environment with manual reviewers / scoped credentials.
5. **Pull request**: Review SQL additions only (modifying an old SQL is rejected), affected Edge entrypoints and transitive `_shared` dependencies, retirement manifest and production config separation. GitHub required checks must include all three existing full product CI workflows and the PR risk gate; make sure branch protection really enforces them.
6. **Merge to master**: After the exact-SHA master CI passes, `.github/workflows/publish-netlify.yml` computes the delta from `production-fullstack`. New SQL is preflighted with `supabase db push --linked --dry-run` and then applied with `--yes` **only after history alignment**. Changed non-retired Edge functions and proven shared dependents are individually deployed. The existing Netlify production bundle is then published and its public assets verified. Only then the tag advances to the published SHA.
7. **Acceptance evidence**: Archive the Git SHA, GitHub workflow/run and CI results, migration preflight/application output, function slugs/versions, Netlify deploy identity, and read-only release smoke results. A listed Edge function is not proof that login, RLS, merchant isolation or provider integration succeeds; these require separately recorded, authorized production smoke tests.

## What this PR protects and what it does not yet establish

- Current release pipeline **will stop** without a `production-fullstack` tag. This is deliberate: its creation must not be guessed because production and test migration ledgers have diverged.
- The migration preflight will block a new SQL migration while Supabase's production migration ledger is unreconciled. CLI dry-run is not proof of SQL semantic safety; destructive operations, data backfills and high-risk migrations still require human review, backups, and an explicit recovery plan.
- Source-only changes to Supabase `config.toml` or the retired-function manifest block this automated path for separate security review. Changed retired QA implementations never get blanket deployed.
- Environment secrets, LINE channels, Bird approval and funded balances, scheduled external integrations, data backfills and live manual provider settings do **not** merge via Git. These need an explicit per-environment readiness checklist.
- A failed post-DB Netlify deployment cannot automatically reverse every schema modification. Prefer expand/migrate/contract migrations and backwards-compatible Edge APIs; record a verified forward-fix plan plus database restore point before hazardous releases.
- On a release already at the baseline SHA, the pipeline intentionally does not republish. If the tag update fails after a successful publication, investigate and reconcile it before another merge.

## Acceptance conditions and evidence

| ID | Given / When / Then | Verification |
| --- | --- | --- |
| AC-001 | Given a new SQL migration / When planning / Then it is scheduled once | `node --test scripts/fullstack-release-plan.test.mjs` |
| AC-002 | Given edited/deleted/renamed historical SQL / When planning / Then fail closed | Same |
| AC-003–005 | Given changed canonical/shared function / When planning / Then only proven dependents included or block | Same |
| AC-006–007 | Given retired QA or Supabase auth/retirement config changes / When planning / Then block | Same |
| AC-008–010 | Given frontend-only, unknown or malformed changes / When planning / Then no backend writes, explicit failure where needed | Same |
| AC-011–016 | Given `master` release / When reviewing workflow / Then baseline, production identity, ordering, credential scope and smoke-before-tag enforced | `node --test scripts/fullstack-release-workflow.test.mjs` |
| AC-017 | Given test CI on PR and push / When running / Then full project baseline executes | GitHub `Test MemberWebsocket Dev`, `Test Netlify Build`, ticket policy and PR risk runs |
| AC-018 | Given a production release / When executing / Then migration, Edge version, website SHA and authorized real-client flows verified | **Not yet executed**; needs reconciled baseline, credentials, approval and an actual release |

## Recovery

- Before any schema change, produce and verify a production backup/restoration plan outside this workflow; never run destructive tests against production.
- If backend publication fails: stop, leave existing Netlify production assets published, diagnose drift and rerun same SHA only after verifying partial effects.
- If frontend publication fails after database/Edge deployment: retain existing frontend, use compatible expand-first changes and fix forward; do not assume old application code supports a destructive migration.
- If frontend succeeds but the tag push fails: do not guess the release state, reconcile actual SHA, function and migration states before retagging.
- Disabling this gate or manually moving the release tag without evidence **is not** a repair.

## Operational note

The Supabase CLI v3 introduced hosted-command behavior changes in November 2026. This workflow pins the **v2 stable channel** until the repository is deliberately migrated, and always verifies the remote command help and dry-run behavior. See the Supabase deployment docs and its v3 CLI breaking-change changelog before changing the pin.
