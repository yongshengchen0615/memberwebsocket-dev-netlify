# #82 — MemberWebsocket-dev 真正整站資料重置（測試環境限定）

**實際專案**：Supabase `dbuquirnaskrwcamdxki`。這是使用者核准的測試環境，毋須再建立另一個 Supabase 專案。其他專案不可套用此工具。

**重置的定義**：清除一般管理員、總管理員授權、會員、全部商家以及其預約、點數、票券、通知佇列與動態 `business_*` schema；將 `auth.users` 交由 Admin API 刪除，Storage 實體檔案透過 Storage API 清空。保留表結構、RLS、函式、資料庫 migration、`platform_private.business_templates`、`line_config.settings`、`vault`、Storage buckets、`maintenance` 的最小操作證據；資料庫階段重新產生必要的服務設定，且只能經 DBA 一次性重新建立首位總管理員。

## 第一性原理與不可變條件

| 面向 | 驗收規則 |
|---|---|
| 身分 | 必須是 DB 的 `postgres` 身分及持有測試專案服務金鑰的操作人，SQL 管理 RPC 永遠不授權 anon / authenticated / service_role |
| 範圍 | 只允許 `dbuquirnaskrwcamdxki`；如果錯專案、漏表、版本指紋過期，直接失敗 |
| 安全 | 先通過可解密的加密 DB/Storage 備份、獨立 DB 還原、Storage 上傳下載 SHA-256 驗證、外部 LINE webhook 停發聲明及 cron=0 |
| 原子性 | DB 事務完整清除或完整 rollback；Storage/Auth API 與 DB 不是同一 transaction，API 中途失敗時保留備份並停止，必須依紀錄補償 |
| 帳號 | reset 後 admin/member/tenant/root grant=0；重新初始化 root 只能在可信成功 epoch 之後由 DBA 執行一次 |
| 可觀察性 | 印出本輪動作統計，不列印服務金鑰、會員個資、LINE ID、原始檔名、資料值 |

## 操作方式

此命令必須在安裝 Node.js 22+、PostgreSQL 17 `pg_dump`/`pg_restore` 的受控操作環境執行。執行前在 `MemberWebsocket-dev/tests/integration` 以 `npm ci` 安裝版本固定的 `pg`。不要把任何密鑰寫在 Git 或 shell history。

1. 取得本測試專案 **postgres 連線 URI**（`RESET_DB_URL`）、`SUPABASE_URL`、管理端的 `SUPABASE_SERVICE_ROLE_KEY`，以及一把隨機 32-byte AES 金鑰（base64 格式，`RESET_BACKUP_KEY_B64`）；全部經安全的秘密管理器注入。
2. 啟動獨立、預先建立的本機 PostgreSQL 17 **隔離還原資料庫**，名稱必須是 `reset_restore_<32 lowercase hex>`、Host 只允許 `127.0.0.1`、`localhost` 或 `::1`。啟動時應禁止這個容器向外連線，避免被還原的排程和 webhook 對外送出。依資料庫使用的擴充功能選擇相容的 Supabase Postgres 17 映像；如果 `pg_restore` 不成功，整個重置拒絕執行。
3. 先透過 Supabase SQL Editor 查看，不改資料：
   ```sql
   select maintenance.sandbox_reset_status();
   select maintenance.plan_sandbox_database_reset();
   ```
4. 驗證 LINE/外部 webhook 不會實際外發；在獨立記錄核可後，設定 `RESET_PROVIDER_ISOLATION_ATTESTATION=DISPATCH_DISABLED_AND_EXTERNAL_WEBHOOKS_ISOLATED`。**僅設此變數不是外部服務已停發的技術證明；需要真人檢查通道與接收方。**
5. 預覽：
   ```sh
   node MemberWebsocket-dev/tests/integration/full-reset-operator.cjs --plan
   ```
   必須設定 `RESET_DB_URL`。
6. 執行時另外提供 `RESET_CONFIRM=RESET MEMBERWEBSOCKET TEST DATA`、`RESET_BACKUP_DIR`（新建空目錄、限制權限）、`RESET_RESTORE_DB_URL`（上述 loopback 隔離資料庫）、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`RESET_BACKUP_KEY_B64`、`RESET_PROVIDER_ISOLATION_ATTESTATION`。
   ```sh
   node MemberWebsocket-dev/tests/integration/full-reset-operator.cjs --execute
   ```
7. 程式驗證資料庫備份可以還原，並完成每一個 Storage 物件的加密本機備份及 Storage API 暫存 bucket 還原檢驗；停用所有 `cron.job`；使用 Admin API 清除 Auth users、Storage API 清空 bucket 物件；確認 `auth.users`、`storage.objects` 和 active cron 全為零；才向 SQL 維護函式提交**最新資料內容指紋**和 UUID，一次交易清除所有應用帳號與商家資料。
8. SQL 成功後，備份加密檔案由操作人自行安全保存，所有 cron 保持停用，不會自動恢復外發。手動確認無殘留：
   ```sql
   select maintenance.preview_full_reset();
   select maintenance.sandbox_reset_status();
   select (select count(*) from public.admins) admins,
          (select count(*) from public.members) members,
          (select count(*) from platform_private.super_admins) roots,
          (select count(*) from platform_private.tenants) tenants,
          (select count(*) from auth.users) auth_users,
          (select count(*) from storage.objects) objects;
   ```
9. 在必要時由 DBA 使用已核可 LINE User ID，做**一次性**第一位 root 建立：
   ```sql
   select maintenance.bootstrap_sandbox_root(
     '<實際首位總管理員的 LINE user ID>',
     'RESTORE ROOT AFTER VERIFIED SANDBOX RESET'
   );
   ```
   再檢查 `public.platform_is_super_admin(...)`，完成第一位管理員登入與申請新商家旅程、會員註冊、預約流程、RLS 以及通知核可驗證之後，才視需要另行恢復排程及 LINE webhook。

## 失敗／復原

- DB 交易失敗：TRUNCATE/商家 schema drop/基線重建全部回滾，`maintenance.sandbox_reset_epoch` 不被更新。
- Auth/Storage API 部分刪除：**不進行 DB SQL 清除**，停在受阻狀態；從已驗證 AES-GCM 備份使用支援的 API 恢復 Storage 檔案。需要時依獨立備份還原 DB 身分，禁止把 SQLTRUNCATE 當作 Storage 還原。
- PostgreSQL 整庫還原失敗、測試 Storage 回傳非 2xx、同名資料表更動、cron 未停止、未知 truncation trigger、沒有 LINE 外發隔離確認：全部阻止最終資料庫刪除。
- 不能把同一個 Supabase 專案內的其他商家／會員資料視為合成資料。**這是不可逆的全測試專案重置，不是單一商家刪除。**
- CLI 執行期間因外部錯誤終止可能留下已停用 cron 或部分已刪除的 Auth/Storage；不要立即恢復通知，先確認狀態並依加密備份補償。絕不可宣稱跨服務原子交易。
- 若只有 Supabase MCP 連線而沒有資料庫連線 URI、服務金鑰、可驗證的 Storage 實體備份及隔離還原環境，則程式雖可安裝，**不得宣稱已執行完整重置**。

## 測試

- `tests/integration/sandbox_database_executor.cjs`：AC-CLR-016～021，真實 SQL 版本：資料清冊、權限、過期指紋、DB FK 原子清除、故障 rollback、設定保留、tenant schema 移除。
- `tests/integration/full_reset_operator_security.cjs`：AC-CLR-022～024，備份加密防竄改、錯誤專案／還原目的地拒絕、Storage API 失敗拒絕。
- `tests/integration/postgres/full-reset.cjs`：PostgreSQL 17、真正 pg_dump + pg_restore、併發與初始 root。
- 新舊全部必要測試均納入 `.github/workflows/test-memberwebsocket-dev.yml`，以最終提交 SHA 的 GitHub Actions 證據為準。

**功能邊界：** Supabase Auth/Storage 管理 metadata、Supabase 系統歷史日誌及雲端備份不會因 SQL 刪除而全部消失；如果業務要求連 Supabase 托管歷史也清除，需另外採服務商支援流程核實，不能以 SQL 誤稱零殘留。
