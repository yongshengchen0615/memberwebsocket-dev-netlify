# GitHub ↔ Supabase production reconciliation — 2026-10-23

## Confirmed inventory
- GitHub main: 268 SQL migration files. Remote Supabase project dbuquirnaskrwcamdxki: 291 recorded applied migrations.
- Migration version IDs shared: 122. GitHub-only: 146. Remote-only: 169. Names and timestamps are sometimes different; do not assume unmatched versions require re-execution.
- Production has 32 Edge Functions. 31 index.ts entrypoints match GitHub main; fixed-ticket-automation/index.ts differs.
- The fixed-ticket-automation remote bundle also differs in _shared/business-scope.ts, _shared/business-runtime.ts, _shared/business-policy.mjs and _shared/platform-policy.mjs. Checking index.ts alone is insufficient to prove parity.
- New GitHub migration versions absent from remote history: 20261021060609_booking_risk_appeal_resolution.sql and 20261021061400_booking_risk_member_lock.sql. These edit the installer for tenant booking-risk logic.

## Production safety gates
1. Do not run automatic db push, migration repair, db reset, or bulk Function deployment until migration history AND semantic schema drift have been reconciled.
2. Make and restore-test a production backup in an isolated environment. Check schema, triggers, RLS, RPC bodies and grants. Version equality alone does not verify SQL content.
3. Inspect every same-name/different-version migration and remote-only entry individually. Never mark migrations as applied without verifying their actual DDL effects.
4. Verify all 32 bundled Function sources, including _shared dependencies and verify_jwt configurations.
5. Use separate staging Supabase environment for develop, and CI + reviewed main SHA + release approval for production. CalendarSystem is not a staging replacement.
6. Test auth, booking, member, admin, LINE and rollback before production release.
7. Record the published Git SHA, database migration history, function versions and test evidence.

## Implemented (read-only)
- GitHub Actions: .github/workflows/supabase-sync-audit.yml
- Comparison: scripts/check-supabase-sync.mjs
- Tests: scripts/check-supabase-sync.test.mjs
- Setup: ONE repository Actions secret `SUPABASE_ACCESS_TOKEN` (project-scoped, **Migrations: Read** only). No database password is required or stored. No secrets in files or logs.
- Actions may be manually invoked; on main, the audit also runs on selected code changes and daily schedule.
- The remote audit should fail in its current state by design: it prevents false declarations of sync. The workflow never modifies Supabase.

This is a reconciliation and release-safety plan, not confirmation that production has been updated.

## 設定唯讀連線（供儲存庫管理員操作）

1. 開啟 https://supabase.com/dashboard/account/tokens 建立 Scoped Personal Access Token。
2. Resources 選 **MemberWebsocket-dev** 專案，Project ref 為 `dbuquirnaskrwcamdxki`。權限僅開啟 **Migrations: Read**；可設定期限，並規劃到期前更換。
3. GitHub → Repository Settings → Secrets and variables → Actions → New repository secret，Name 為 `SUPABASE_ACCESS_TOKEN`，Secret value 為剛建立的 Token。不要貼到 Issue、PR、Log、前端程式碼或聊天。
4. PR #101 自動測試通過、完成審核後合併至 `main`，才可在 Actions → Supabase migration drift audit → Run workflow 執行正式稽核。
5. History mismatch 的檢查結果預期會標記 Failed，代表版本不同、**不代表 Token 設定失敗**。若出現 HTTP 401/403，先檢查 Token 是否過期或是否具有 Migrations Read 權限。
6. 稽核只使用 Supabase 官方 `GET /v1/projects/{ref}/database/migrations`，**不連線 Postgres**，不需要 `SUPABASE_DB_PASSWORD`、service_role key 或 SQL 寫入權限。

## 驗證與安全

- 無權限／過期 Token：期待 HTTP 401/403，CI 不應顯示機密值。
- 遠端 API 格式異常：CI 要安全失敗。
- 有不同版本：CI 要失敗，摘要顯示版本差異，且不得執行修改。
- 無不同版本：CI 可通過，但仍不能證明 SQL、RLS、RPC 或 Edge Functions 內容一致。
- 正式資料庫部署必須另外經過備份、測試環境、核准與驗證，不可把這個只讀 Token 升級成寫入權限。
