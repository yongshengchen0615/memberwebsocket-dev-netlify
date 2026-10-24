# #82 CLR-01 Catalog Characterization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this investigation. Steps use checkbox syntax for tracking.

**Goal:** Deliver the existing catalog inventory and demonstrate atomic refusal of legacy remove-all after module FK migrations, without implementing deletion.

**Architecture:** Query remote system catalogs read-only. Execute the unchanged maintenance SQL and real child table DDL in disposable PGlite; only the public cleanup stage remains the existing reduced fixture. Publish the policy proposal for review, without new application endpoints or migrations.

**Tech Stack:** Node.js, node:test, existing pinned PGlite, GitHub Actions.

**Spec:** `MemberWebsocket-dev/docs/superpowers/specs/2026-10-23-data-lifecycle-design.md`; authorized scope: Issue #82 CLR-01/02 design gate.

## Global Constraints

- No deletion, migration, grants, schema resets or secret-value reads on existing Supabase projects.
- Preserve the original AC-022 and QA purge tests; characterize the current failure without turning it into permission to remove the FK.
- Do not claim all AC-CLR acceptance, production safety or provider verification from synthetic SQL.
- Use a task branch from `Integrated-Marketing-Platform@d0906c7a801bf64ed89cfb07172c40a114e345eb`; keep the design approval and sandbox prerequisites open.

## Review Focus

- Empty referencing tables still prevent TRUNCATE; populated-only coverage is insufficient.
- Earlier public-data changes must roll back after the later platform failure.
- Root state, platform audit and request rows must survive the rejected operation.
- Real child DDL must be loaded, rather than a fixture which silently omits the new foreign keys.
- A green characterization test must never be described as successful deletion or a production fix.

### Task 1: Inventory and characterize the existing limitation

**Files:**
- Modify/Test: `MemberWebsocket-dev/tests/integration/platform_remove_all_data.cjs`.
- Create: the Spec above and this plan.

**Interfaces:**
- Consumes: unchanged `maintenance.remove_all_data(text)` migration and the CREATE TABLE statements for `module_secrets` / `module_notification_routes`.
- Produces: four child-table cases asserting SQLSTATE 0A000 and unchanged final fixture data; human-readable data-disposition proposal.

- [ ] Run the original remove-all plus QA cleanup baseline; expected 8 tests pass with no skip.
- [ ] Add four characterization cases (two child tables × empty/populated); preserve AC-022. This is investigation of existing behavior, with no production implementation or RED→GREEN fix claim.
- [ ] Run targeted tests; expect all rollback and privilege assertions to pass.
- [ ] In a disposable COPY, mutate the platform TRUNCATE to CASCADE and rerun; expect the four refusal cases to fail. Never mutate the remote database or deliver the mutant.
- [ ] Restore/confirm original SQL, run the related suite, Node regression and diff check.
- [ ] Open a Draft PR for the design and tests; run all existing required CI on its final SHA, have one fresh reviewer inspect it, and record exact job evidence.
- [ ] Update #82 with completed investigation and open policy/sandbox gates; keep the Issue open. No deletion feature or Production deployment is authorized by this plan.
