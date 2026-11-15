# Testing Platform login grant repair

## Goal and confirmed cause

Testing only: restore verified LINE visit registration without granting Platform access. Baseline branch Integrated-Marketing-Platform, commit 046cf2f68edd33cddbb1d2b32013b979ff227504.

Live testing logs at 2026-11-15 12:30–12:37 UTC correlate platform-api 503 with PostgreSQL 42501 in public.platform_record_access_request INSERT/ON CONFLICT on platform_private.super_admins. The deployed function is SECURITY INVOKER and the testing service_role had SELECT only. Production retains all four intended column grants, so no production repair is authorized or needed. Existing migration 20261023235000 already defines these exact grants.

| Boundary | Contract |
|---|---|
| Identity | LINE-verifier supplied actor/name may create a pending identity or update display metadata |
| Privilege | service_role cannot write enabled, admin_id or singleton; anon/authenticated cannot execute the internal registration RPC |
| Data | No existing identity or approval state is changed by the migration; repeated visits do not duplicate an identity |
| Empty reset table | First verified visit records pending only; no automatic root bootstrap or approval |
| Scope | Apply to bmwhojszsnxliekkhrka through the testing connection only; no production DB/Edge/config change |

## Acceptance and implementation

| AC | Given / When / Then | Evidence |
|---|---|---|
| LOGIN-GRANTS-001 | Missing column grants / login then repair / reproduce 503, restore approved-root read, pending user remains 403 | platform_access_registration.cjs; RED 503 != 200 captured before adding GRANT content |
| LOGIN-GRANTS-002 | Real PostgreSQL 17 and two physical sessions / concurrent registration after repair / one pending row, protected writes denied | postgres/admin-qualification.cjs in existing CI |
| LOGIN-GRANTS-003 | Empty reset table or already-correct privileges / apply repair / migration creates no identities, login remains pending and existing approvals unchanged | platform_access_registration.cjs |
| LOGIN-GRANTS-004 | Live testing DB / role-scoped registration and negative checks in a transaction / success with enabled=false, forbidden approval write, complete rollback | live SQL before and after repair |

The migration adds exactly INSERT(line_user_id,display_name) and UPDATE(display_name,last_seen_at). It does not add SECURITY DEFINER, table-level mutation privileges, roles, policies, dependencies or UI changes. Reapplying it is idempotent. No broad refactor or speculative failure-retry mechanism is introduced.

Supabase CLI generated the new migration initially as 20261115124308. The server apply_migration tool recorded version 20261115124713; the unpublished local file and test references were renamed to the actual server version before commit, avoiding duplicate pending history.

## Verification ledger

- RED: the new integration case reproduces the exact 503 when expected grants are absent, then fails 503 != 200 against an empty repair file.
- GREEN: initial related suite 7/7; complete Node regression 1482/1482, no skips. Final expanded suite and remote full-baseline results are recorded in PR/Actions.
- Live pre-apply rollback probe used only two GRANT statements inside one outer transaction, never nested BEGIN/COMMIT from the migration. Pending registration and denial of enabled UPDATE passed; readback confirmed original ACL remained absent and the synthetic identity was removed.
- Applied only the testing migration. Post-apply rollback probe passed: four intended capabilities true, enabled/admin_id/singleton modification false, synthetic identity fully rolled back.
- Testing super_admins was empty following reset. No real user was inserted or enabled by this repair. Human validation may correctly show pending approval; changing that state requires the existing explicit Supabase administration process.
- Independent review found no implementation security defect; requested explicit empty-table and already-correct upgrade coverage, now added. Full CI and migration history alignment remain release gates.

## Performance and recovery

Frontend/Edge source and request algorithms are unchanged (zero added frontend bytes and zero new API calls). A failed permission check versus a successful registration is not a valid latency comparison; no speedup is claimed. The existing performance regression baseline remains required.

Restore the pre-repair testing ACL with REVOKE INSERT(line_user_id,display_name), UPDATE(display_name,last_seen_at) ON platform_private.super_admins FROM service_role, if the repair must be reversed. This restores the diagnosed error and must not be used as a way to grant or revoke a user's approval. The source patch can be reverted independently; no data rollback or schema-object deletion is needed.
