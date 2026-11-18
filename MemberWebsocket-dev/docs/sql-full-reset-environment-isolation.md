# Supabase 雙環境 SQL Full Reset 操作契約

> **高風險、不可逆**：以下完整清除會永久移除目標專案中的會員、管理員、商家業務資料與商家 Schema，並清空該 Supabase 專案管理的 Auth / Storage。它不是「清除快取」。
>
> 此操作由資料庫管理員在**正確的 Supabase Project SQL Editor** 執行。系統端不會跨專案轉送重置請求；不應在一般會員後台提供一鍵重置按鈕。正式環境需先完成資料保留、備份還原、外部 LINE/Bird 服務隔離、書面確認與維護視窗。

## 環境與確認字串（不可共用）

| 操作環境 | Supabase Project Ref | 確認字串 | Worker |
|---|---|---|---|
| 正式 `MemberWebsocket-main` | `dbuquirnaskrwcamdxki` | `RESET MEMBERWEBSOCKET MAIN DATA` | `https://dbuquirnaskrwcamdxki.supabase.co/functions/v1/sql-full-reset-worker` |
| 測試 `MemberWebsocket-test` | `bmwhojszsnxliekkhrka` | `RESET MEMBERWEBSOCKET TEST DATA` | `https://bmwhojszsnxliekkhrka.supabase.co/functions/v1/sql-full-reset-worker` |

在正式資料庫部署相容性 migration **之前**，舊的 TEST 字串仍可能被正式環境接受。此文件的 MAIN 新字串不可提前當作已上線功能。必須執行最後的隔離檢查後才准啟用。

### 1. 事前確認專案與系統狀態（唯讀）

```sql
SELECT
  (SELECT project_ref
     FROM maintenance.sandbox_reset_target
    WHERE singleton IS TRUE) AS current_project_ref,
  maintenance.latest_full_reset_status() AS latest_job,
  (SELECT count(*) FROM auth.users) AS auth_users,
  (SELECT count(*) FROM storage.objects) AS storage_objects,
  (SELECT count(*) FROM pg_catalog.pg_namespace
    WHERE nspname ~ '^business_[a-f0-9]{32}$') AS merchant_schemas;
```

先於兩個專案分別執行 `tests/integration/postgres/sql_reset_environment_isolation_check.sql` 的**唯讀**檢查：必須全部通過；不能以環境變數或前端顯示結果取代資料庫查驗。

### 2. 正式環境專用重置（僅限核准維護操作）

只在 Supabase **MemberWebsocket-main** 專案執行，且必須先確認已部署 MAIN 確認字串的 migration：

```sql
SELECT maintenance.request_full_reset_from_sql(
  'RESET MEMBERWEBSOCKET MAIN DATA'
) AS reset_job;
```

### 3. 測試環境專用重置

只在 Supabase **MemberWebsocket-test** 專案執行：

```sql
SELECT maintenance.request_full_reset_from_sql(
  'RESET MEMBERWEBSOCKET TEST DATA'
) AS reset_job;
```

**禁止**在兩個環境共用同一段清除 SQL。錯誤環境的字串應立即回傳 `RESET_EXACT_CONFIRMATION_REQUIRED`，且不得新增 `sql_full_reset_jobs` 工作。

### 4. 兩個環境皆使用的工作狀態與資料盤點（唯讀）

```sql
SELECT maintenance.latest_full_reset_status();
```

`submitted=true` 只表示工作已排入非同步 Worker，不代表資料已清除。必須確認 **`state=completed`、`result.databaseReset=true`、`errorCode=null`**。遇到 `queued`、`running`、`failed` 不可視為完成，也不要重複送件掩蓋失敗。

```sql
SELECT
  plan->>'projectRef' AS project_ref,
  (plan->>'plannedRows')::bigint AS planned_business_rows,
  (plan->>'tableCount')::integer AS target_tables,
  (plan->>'businessSchemas')::integer AS merchant_schemas,
  (SELECT count(*) FROM auth.users) AS auth_users,
  (SELECT count(*) FROM storage.objects) AS storage_objects,
  (SELECT count(*) FROM cron.job WHERE active) AS active_cron_jobs,
  (SELECT count(*) FROM public.realtime_events) AS realtime_events
FROM (SELECT maintenance.plan_sandbox_database_reset() AS plan) AS preview;
```

正常完成後，必須確認會員／管理員／商家、`business_[0-9a-f]{32}` Schema、Realtime 暫存事件、Auth 使用者、Storage 物件、啟用中 Cron 全為 0。原始系統設定 13 筆（會隨 migration 改版）仍必須保留；`planned_business_rows` **不保證為 0**。

## 防呆與環境互不干擾

- SQL request & execute 由 `postgres` DBA-only 控制；Worker RPC 僅 `service_role` 持一次性 256-bit 工作票據使用。不得授權給 `anon`、`authenticated` 或前端。
- 每個環境自身函式寫死所屬 Project Ref 和同一個專案 Worker URL。確認字串依環境不同；若混用則拒絕，不得嘗試自動切換另一環境。
- DB 狀態預覽包含資料快照 fingerprint；與執行時不一致則拒絕。相同 DB 不允許並行完整重置。
- 完整清除**不**會刪除不同 Supabase 專案的資料；**但**外部供應商資源（共用 LINE Channel、Bird 帳號、Webhook、通知 outbox）若共用或未隔離，仍可能產生跨環境影響。這需要在正式重置前分別驗證，不可只靠 Project Ref 宣稱端到端完全隔離。
- 完整清除不會移除 Git migration、Edge Functions、Secrets 或必備系統設定；保留系統架構以利重新開通。
- 過去曾有正式環境 `sandbox_approved=true` 的歷史設定：這是 legacy 重置核准欄位，**不是**正式環境等同 sandbox 的保證，必須由 DBA 保護其操作權限。

## 驗收

1. **AC-001** Given MAIN，When 在正式資料庫使用 TEST 確認字串，Then 立即拒絕且不建立工作。
2. **AC-002** Given TEST，When 在測試資料庫使用 MAIN 確認字串，Then 立即拒絕且不建立工作。
3. **AC-003** Given 正確專案，When 只讀隔離檢查，Then 三個重置階段均指向同一確認字串與 Worker URL。
4. **AC-004** Given 正確 DBA 授權且已備份／隔離外部服務，When 發起重置，Then 只重置該 Supabase 專案；另一個專案的資料量、Schema、hash、Auth、Storage 不變。
5. **AC-005** Given 重置成功，When 重新盤點，Then 業務資料歸零、必要系統設定保留、Realtime 暫存事件 0。
6. **AC-006** Given 失敗、過期或重播票據，When Worker 處理，Then 不得在兩個環境繼續重置並需留下可觀察錯誤。

AC-004／AC-006 的破壞性與跨平台驗收只可在隔離沙盒／備份還原後執行；不得拿正式會員作測試。CI 綠燈不代表正式系統已完成這些外部驗證。
