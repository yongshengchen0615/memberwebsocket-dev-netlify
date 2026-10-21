# #180 / #190 resource inventory and decision worksheet

Read-only metadata and aggregate counts from project `dbuquirnaskrwcamdxki`, 2026-10-21. This is planning, not a reset dry-run, approved disposition policy, backup export or permission to delete production data. No independent synthetic Supabase project has been identified. The unrelated CalendarSystem project is outside this work.

## Observed scope

| Namespace / resource | Aggregate observation | Dependency |
| --- | --- | --- |
| public | 62 tables, all 62 RLS | Legacy business data and platform RPCs coexist; never truncate the whole schema. |
| platform_private | 9 tables, all 9 RLS; 1 business | Applications, tenants, super-admin grants, audit and encrypted credentials must be treated separately. |
| Active business namespace | 69 tables, all 69 RLS; 82 foreign keys | Members, bookings, participants, benefits, points, tickets, receipts, sessions, audit and outbox form one dependency graph. |
| Supabase Auth | 27 managed tables; 0 users, identities and sessions at observation | App identity uses LINE; deleting only Auth users would not revoke LINE or application sessions. Do not modify managed schema structure. |
| Supabase Storage | 8 managed tables, all 8 RLS; 2 buckets, 25 objects | Database receipt paths and tenant prefixes must be reconciled with objects. Counts are not proof that files are disposable. |
| Scheduler | `platform-business-runtime`, active every minute | Dispatch must be disabled in an approved sandbox before reset/restore tests. Production scheduler remains active. |
| Business notification outbox | 7 admin / 9 member rows, all accepted at observation | Accepted does not prove human receipt. Restoring a queue must not replay messages to real recipients. |
| New risk policy | Disabled; 0 counted events / 0 appeals | A reset plan must preserve policy decisions and the intended audit retention independently. |

Counts are point-in-time observations on an active system and can change during normal use. No names, contact details, LINE IDs, object paths, secret values or backup contents were retrieved for this worksheet.

## Proposed disposition groups — all await #180 owner decisions

| Resource group | Proposed safe default | Decision needed before sandbox execution |
| --- | --- | --- |
| Infrastructure, migrations, functions, RLS, indexes | Retain | Confirm immutable sandbox project reference and deployment owner. |
| Netlify / Edge configuration and secret names | Retain configuration; review ownership manually | Identify required settings and which provider credentials need rotation after account/owner changes. Never copy live values into a synthetic fixture. |
| Member profile and LINE/application session state | Hold | Choose delete/anonymize/retain, define session cutoff and verify old provider and app credentials cannot access the reset business. |
| Bookings, participants, reservations, benefits and cancellation state | Hold | Approve exact sandbox tables and FK-safe ordering, pending operations and idempotency treatment. |
| Points, tickets, transfers, claims, settlements and service history | Hold | Decide accounting/legal retention and consistency rules; no blanket cascade approval. |
| Admins, super-admin grants and tenant ownership | Manual | Identify the authorized DBA/owner for first-admin restoration; no public self-grant endpoint. |
| Risk events, restrictions, appeals and all audit records | Retain pending retention decision | Specify retention period and whether synthetic-only history can be cleared. |
| Auth users/identities/sessions | Managed procedure only | Document revoke/sign-out behavior and access-token lifetime; Auth deletion alone is insufficient. |
| Storage buckets/objects and receipt references | Hold | Classify approved synthetic prefixes, checksum inventory and recover both object bytes and metadata. |
| Outbox, jobs, webhooks, LINE OA and external ownership | Manual | Stop dispatch in sandbox, block real recipients/providers, decide queue discard/replay and verify channel ownership. |
| Database/object backups and existing recovery points | Retain, encrypted and access restricted | Define full-system recovery point, expiration, checksum and verified restoration. CI SQL backups do not cover managed Auth, object bytes or provider state. |

## Entry criteria and recovery sequence

1. #180 records a named decision owner and a disposition for every resource group above; identify the independent synthetic sandbox reference. Production and any other project remain denied.
2. Prove server-side environment allowlist and reauthentication. Verify ordinary admins, wrong projects and expired authorization cannot invoke the operation.
3. Disable all sandbox dispatch/schedulers; remove routes to real LINE recipients and external webhooks. Validate no production job or credential changed.
4. Build a read-only resource manifest and fingerprint, without row contents or secrets. A real dry-run must demonstrate identical fingerprints before/after and list every unclassified resource as a blocker.
5. Export encrypted, access-controlled DB/object backups; verify checksums and restore to a separate sandbox. Test member/admin login and rejection of old sessions after the intended cutoff. Keep provider ownership and secrets recovery as explicit manual work.
6. Only after those proofs and the approved scope exist, implement the sandbox reset job with per-resource checkpoints, failure injection and a tested recovery path. No production reset button is part of #190.

No destructive command or bootstrap grant is supplied by this worksheet. The CI PostgreSQL fixture uses synthetic-only databases named `ci_booking_*`, accepts only its local CI container and cannot take a Supabase URL or real credentials.
