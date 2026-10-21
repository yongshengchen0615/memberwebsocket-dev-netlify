# GitHub Projects v2 card operations

This CLI manages existing user-owned Project #5:
https://github.com/users/yongshengchen0615/projects/5

It **does not** change the existing ChatGPT GitHub connector. ChatGPT cannot execute this CLI on your machine without a separately authorized execution pathway. It does not affect member authentication, database, Netlify, or production traffic.

## Authentication

Node.js 24 is recommended. Use a user-authorized GitHub token with Projects read/write access. A classic user PAT with the project scope works for a user-owned Project. The repo scope is necessary if it includes items from private repositories. With GitHub CLI, verify that gh auth has the project scope (e.g. gh auth refresh -s project). Pass GH_TOKEN in the process environment; never commit it or paste it in an issue/PR.

~~~bash
GH_TOKEN="$(gh auth token)" node scripts/project-v2.mjs list
~~~

Defaults: owner yongshengchen0615, Project number 5. For a different user-owned project, set GH_PROJECT_OWNER and GH_PROJECT_NUMBER. Organization-owned projects are not supported in this first version.

## Usage and safety

All mutations are **dry-run by default**. Add --apply only after inspecting the plan. The script obtains the current Project node IDs, fields and status option IDs, checks current status before moving, and reads back the resulting value.

~~~bash
# Read full Project snapshot and Project item node IDs (PVTI_...).
GH_TOKEN="$(gh auth token)" node scripts/project-v2.mjs list

# Preview a move; applies no changes:
GH_TOKEN="$(gh auth token)" node scripts/project-v2.mjs move --issue yongshengchen0615/memberwebsocket-dev-netlify#48 --from Ready --to "In Progress"

# Apply ONLY after checking the plan, with default WIP limit 2:
GH_TOKEN="$(gh auth token)" node scripts/project-v2.mjs move --issue yongshengchen0615/memberwebsocket-dev-netlify#48 --from Ready --to "In Progress" --apply

# Set Priority or other SINGLE SELECT field:
GH_TOKEN="$(gh auth token)" node scripts/project-v2.mjs set --issue 48 --field Priority --value P1 --apply

# Update underlying repository Issue/PR title/body, or Project draft:
GH_TOKEN="$(gh auth token)" node scripts/project-v2.mjs edit --issue 48 --title "New title" --apply

# Link existing issue or PR to Project:
GH_TOKEN="$(gh auth token)" node scripts/project-v2.mjs add --issue yongshengchen0615/memberwebsocket-dev-netlify#48 --apply

# Create a draft issue (not a repository Issue):
GH_TOKEN="$(gh auth token)" node scripts/project-v2.mjs draft --title "Release evidence" --body "Notes" --apply

# Archive an item without deleting its linked Issue:
GH_TOKEN="$(gh auth token)" node scripts/project-v2.mjs archive --item PVTI_REPLACE_WITH_REAL_NODE_ID --apply

# REMOVE the Project item only; original Issue/PR persists.
# Requires EXACT Project item node ID confirmation.
GH_TOKEN="$(gh auth token)" node scripts/project-v2.mjs remove --item PVTI_REPLACE_WITH_REAL_NODE_ID --confirm PVTI_REPLACE_WITH_REAL_NODE_ID --apply
~~~

The examples are documentation, **not authorized mutations**. Do not run add/draft/edit/remove against production Project #5 without selecting a real target and reviewing intended consequences.

Removal may discard Project-only field values and has no automatic undo: export a list before acting. Re-add an Issue to restore association; Project fields need separate restoration. Prefer archiving for historical work.

Moves require --from and enforce the configured In Progress WIP limit (default 2). They use the live Status single-select option names. The pre-write read and subsequent write are not atomic, so another user could change the same card concurrently; post-write readback helps detect such conflicts but does not eliminate them.

## Tests

~~~bash
node --check scripts/project-v2.mjs
node --test scripts/project-v2.test.mjs
~~~

Tests are synthetic mock-transport tests, not real GitHub writes. Before merging, run the repository's established CI and perform a real read-only list with a Projects-scoped token. Next, exercise approved CRUD operations against a **disposable test Project**, recording before/after item counts and retained Issue URLs, rather than risking existing 26 board items.

Reference: https://docs.github.com/en/graphql/reference/projects
