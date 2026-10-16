# Grant notification scheduling / calendar bonus deployment

Deploy the database migrations, Edge Functions, and admin frontend together so the UI never points at a missing backend.

## 1. Apply both database migrations

Apply in order:

1. `migrations/20260910_add_grant_notification_schedule_calendar_bonus.sql`
2. `migrations/20260910_setup_grant_message_dispatch.sql`

They add:

- `calendar_items.bonus_points_enabled`
- `calendar_items.bonus_points`
- `scheduled_grant_messages`
- `save_calendar_item_with_bonus(...)`
- `grant_member_benefits_with_event_bonus(...)`
- `claim_due_grant_messages(...)`
- `get_grant_dispatch_secret()`
- Supabase Vault dispatcher secret + project URL
- `pg_net` / `pg_cron`
- once-per-minute `dispatch-scheduled-grant-messages` Cron job

The scheduled-message table has RLS enabled and direct `anon` / `authenticated` access revoked. All new `SECURITY DEFINER` RPCs are executable only by `service_role`.

The dispatcher secret is generated inside Supabase Vault by the migration. Do not copy it into GitHub, `config.json`, browser JavaScript, logs, or analytics.

## 2. Deploy both Edge Functions

Deploy these functions with gateway JWT verification disabled because each function implements its own authentication boundary:

```bash
supabase functions deploy grant-automation --no-verify-jwt
supabase functions deploy scheduled-grant-messages --no-verify-jwt
```

`grant-automation` verifies the Admin LIFF ID token against LINE and then checks the `admins` table server-side before allowing protected operations.

`scheduled-grant-messages` validates the `x-dispatch-secret` value against the Vault-backed dispatcher secret before claiming or sending queued notifications.

No manual dispatcher secret configuration is required. `GRANT_MESSAGE_DISPATCH_SECRET` remains supported as an optional Edge Function environment override, but the default deployment reads the generated secret through the service-role-only `get_grant_dispatch_secret()` RPC.

## 3. Verify the dispatcher

The second migration creates this Cron job automatically:

- job: `dispatch-scheduled-grant-messages`
- schedule: `* * * * *`
- target: `/functions/v1/scheduled-grant-messages`

Verify it is active:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname='dispatch-scheduled-grant-messages';
```

Verify recent HTTP responses:

```sql
select id, status_code, content, timed_out, error_msg, created
from net._http_response
order by created desc
limit 10;
```

With an empty queue the expected response is HTTP 200 with:

```json
{"ok":true,"claimed":0,"sent":0,"failed":0}
```

## Expected behavior

- **Immediate**: points/service time are written first, then LINE is pushed immediately.
- **Scheduled**: points/service time are written immediately; the final notification text is stored in the queue and sent at the selected Taiwan time.
- **No message**: points/service time are written with no LINE push.
- **Calendar event bonus**: active event bonus points are determined server-side using the event date range and the member tier before the current grant. The bonus is added once to every point card selected in that grant. Multiple active events stack.
- A repeated grant `requestId` does not duplicate the point/service-time transaction. A scheduled queue entry is unique by `request_id`.

## Verification checklist

1. Save an event with bonus disabled; grant points and confirm only base points are added.
2. Save an active event for today with +2 bonus; grant 3 points and confirm the entry/balance increases by 5.
3. Create two active events (+2 and +3); grant 3 points and confirm 8 total points are added to each selected card.
4. Grant service time only; confirm no event bonus is created.
5. Select **不傳送**; confirm grant succeeds and LINE receives nothing.
6. Select **立即傳送**; confirm LINE message includes base points, event bonus, service time, tier, and currently usable tickets when available.
7. Select **預約傳送** for a future time; confirm grant is immediate, one queue row is `pending`, and the dispatcher changes it to `sent` after delivery.
8. Retry the same `requestId`; confirm no duplicate point/service-time entry is created.
9. Use an invalid or unauthorized Admin LINE identity and confirm the automation endpoint rejects protected writes.