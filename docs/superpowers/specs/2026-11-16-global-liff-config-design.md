# Platform-only global LIFF configuration

User instruction: remove unnecessary LIFF configuration in both production and testing.
The preceding proposal identifies the five member-facing fields for removal; retain
`platformLiffId` and `adminLiffId`. This is the approved scope, not a LINE app deletion.

## Goal and boundaries

Both environment JSON files and published configurations contain only the two
platform/account LIFF IDs. Feature LIFF IDs remain in merchant LINE settings.
Keep each branch's existing admin/root values, Supabase routing and feature flags.
No database migration, credential backfill, LINE Console edit or Edge release.

Identity/authorization remains server-owned. Configuration is public routing data,
not evidence of permission. Merchant/admin/member authorization, revocation,
transactions and notification recipients retain their existing contracts.

## Approaches

Deleting JSON fields alone fails the seven-ID build contract and leaves stale
client fallback behavior. Choose coordinated removal: update the existing build
schema and clear missing merchant feature IDs when applying merchant discovery.
No new configuration service or abstraction is needed.

## Acceptance

| AC | Given / When / Then | Evidence |
|---|---|---|
| AC-001 | Given either environment, when built, then only adminLiffId/platformLiffId are published; invalid or missing admin/root IDs still reject the build | branch-environment tests, both builds |
| AC-002 | Given a merchant feature, when public configuration loads, then its own saved ID replaces any stale global value; missing IDs become empty regardless of legacy Channel | business_context_routing unit tests |
| AC-003 | Given actual production/testing profiles, when management pages load, then each uses its retained role ID and supports existing approval/settings workflows | product_admin_ui DOM/handler/SQL, Chromium baseline |
| AC-004 | Given a merchant missing a feature ID or an unscoped member URL, when sign-in starts, then show a clear setup/merchant-entry instruction before calling LINE | existing missing-ID validation plus browser cases |

## Known deployment preconditions

Read-only Supabase audit on 2026-11-16 found one active merchant in each environment
with all five feature IDs missing. Those features require merchant LINE setup;
do not silently copy legacy IDs because ownership/Endpoint correctness is unproven.
Both management login IDs remain available to complete setup.

## Recovery and verification

Revert this change and rebuild the appropriate branch; no data recovery required.
Run related tests first and the full established product/Netlify/ticket-policy CI
on each final release SHA. Provider login requires a real authorized LINE user;
fixtures cannot establish that external login is verified.
