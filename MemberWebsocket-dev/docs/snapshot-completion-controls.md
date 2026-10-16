# Snapshot tickets and completed-order corrections

Trello: #148, #147, #144, #149. Supabase project: `dbuquirnaskrwcamdxki`.

## Business rules

- Snapshot ticket registration means an intention to use an already held points/event ticket. Upload and finalization do not reserve or consume it. Only administrator approval settles benefits through the existing completion transaction. Reject, withdraw or replace leaves benefits untouched. GPS-restricted tickets continue to use their existing location-verified redemption flow.
- Global `ticket_booking_required` defaults to true. A member must choose their own confirmed, unfinished booking with compatible services. Turning it off permits explicit `no-booking` direct use for unrestricted tickets. Service-restricted direct redemption still requires actual booking service evidence. Snapshot review may verify those services from the administrator's recorded service items. Expiry, membership tier, ownership, GPS, point budgets and usage limits still apply. Settings changes serialize with ticket writes and old clients cannot overwrite the new flag.
- Completed-order correction permits only each existing participant's service items, quantity (1–2), and actual unit minutes (1–720), plus a mandatory reason. Booking owner, recipient, technicians, dates and status cannot be changed through this endpoint. All-zero eligible service time is supported while preserving the system store item.
- Corrections append signed point/service-time deltas and retain the original completion settlement. Historical snapshot prices and classifications stay attached to retained items. New items use catalog metadata. Previously redeemed service-restricted benefits cannot lose their required services. Insufficient current/reserved points reject a reduction atomically; issued ticket records remain subject to current balance checks.
- New completions preserve reward rates and primary technician context. Historical completions are editable only if the original eligible technician can be uniquely reconstructed; a historical new rewarded service type without a recorded original rate is rejected with `CORRECTION_CONTEXT_REQUIRED`. No historical rate is guessed.
- Preview runs the same transactional validations and rolls back all writes. Apply requires matching booking version and exact server preview. Request ID replay returns the prior result once; different content under the same ID is rejected. Delegated bookings correct service-recipient rewards and booking-owner friend rewards separately.

## Deployment and verification

1. Require application regression, database/DOM integration, Deno checks and Chromium journeys to pass for the PR commit.
2. Apply `20261010084712_membership_snapshot_and_completion_controls.sql`. Its DDL and function replacements are transactional, and new tables/functions remain service-role only.
3. Deploy `api`, `booking-admin-api`, `booking-admin-operations`, `booking-receipt-api`, `pointcard-extension-api`, and `event-ticket-extension-api` from the same commit, including relative shared dependencies. Existing custom LINE authentication and verify_jwt settings remain in place.
4. Merge main and verify the GitHub Pages deployment and loaded cache versions. Verify new schema ACLs and RPC definitions, unauthenticated write rejection, and receipt PostgREST relationship resolution.

## Recovery

If migration application fails, its transaction leaves the prior schema and balances intact. Do not manually continue a partial migration.
After any applied correction, do not drop adjustment rows, signed ledger entries or restore historical balances from snapshots. Restore service by retaining the additive schema and validated API relationship hints, switching the booking policy back on through administrator settings, and disabling the correction UI/endpoints in a follow-up commit if necessary. Revert affected frontend behavior while retaining backward-compatible schema/API fields. All receipt-to-booking queries must retain explicit `booking_receipts_booking_id_fkey` relationship hints after the second booking foreign key is added. Reconcile any disputed correction by another reviewed delta using the correction workflow, preserving the audit trail.

## Automated evidence

`tests/integration/snapshot_completion_controls.cjs` executes production PostgreSQL functions with real constraints: policy authorization/version/replay, ownership, expiry, GPS, snapshot withdraw/reject/resubmit/approve, positive/negative/zero deltas, historical pricing, exhausted points, rollback on write failure, and competing stale-version writes.
Chromium journeys cover setting save/reload, snapshot held-ticket selection, completed-order preview/apply/readback, cancellation clipboard behavior on phone/desktop widths and a December-to-January overnight interval. Existing camera, upload integrity, receipt replay and admin review journeys remain required by CI. DOM journeys are supplementary and are not labeled as browser evidence.
