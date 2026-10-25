# 一鍵重置可重複執行：已清除後 LINE 再登入（2026-10-24）

## 根因（已用唯讀 Supabase 證據確認）

測試專案 `dbuquirnaskrwcamdxki` 的完整清除 Job `1099df6d-eee9-448d-9a40-51026b9e37d7` 在 2026-10-23T13:45:45Z 回報 `completed`，移除 9,957 筆應用資料、142 張資料表範圍，當時 Auth/Storage 皆已清空。之後新的 Platform LINE 登入在 2026-10-24T01:14:36Z 建立一筆 `super_admins.enabled=false` 候選人。舊的 `request_full_reset_from_sql` 與 `execute_sandbox_database_reset` 都將 `root_bootstrap_required=true` 視為禁止再次清除，造成新候選人無法透過 SQL Editor 一鍵再次清除。

`root_bootstrap_required` 應是每次重置後的狀態，而非「只能清除一次」的限制。SQL Editor 的專用入口**可以重複執行**；即使沒有先建立任何最高管理員，也能清除當下重新產生的 LINE 身分、商家、會員、應用資料。

## 操作與驗收

開啟 [測試專案 SQL Editor](https://supabase.com/dashboard/project/dbuquirnaskrwcamdxki/sql)，以 DBA 角色執行：

```sql
select maintenance.request_full_reset_from_sql(
  'RESET MEMBERWEBSOCKET TEST DATA'
);
```

回傳 `submitted=true` 只代表 Edge 工作**已送出**；需要另外確認：

```sql
select maintenance.latest_full_reset_status();
```

只有最新工作 `state=completed`、`result.databaseReset=true` 且下列人員、業務、Auth 與 Storage 物件殘留均為零，才是清除完成：

```sql
select
 (select count(*) from public.admins) admins,
 (select count(*) from public.members) members,
 (select count(*) from platform_private.super_admins) super_admins,
 (select count(*) from platform_private.platform_access_requests) old_platform_requests,
 (select count(*) from platform_private.tenants) businesses,
 (select count(*) from auth.users) auth_users,
 (select count(*) from storage.objects) storage_files,
 (select count(*) from cron.job where active) active_cron;
```

**注意**：此專案的新行為是每次有 LINE 使用者再次登入 Platform，就會建立新的待開通 `super_admins` 紀錄。因此驗收零殘留應在清除成功後、任何人重新登入前完成；不要把清除後新建立的紀錄誤認為前次清除失敗。

## 安全性與測試

這次 migration 僅移除「等待第一位管理員初始化則禁止再次清除」的兩個判斷，保留 DBA 角色限制、正確確認文字、專案白名單、交易式清理、資料指紋防止誤刪、Cron 停止、Auth/Storage 透過官方 API 清理的必要前置。

- AC-CLR-050：已有 `root_bootstrap_required=true` 且存在新 LINE pending 身分，仍可建立新的清除工作。
- AC-CLR-051：清除 pending 身分、維持 root bootstrap 狀態，可以重複清除。
- AC-CLR-052：Auth/Storage 或排程未清理時，資料庫清除必須拒絕。
- AC-CLR-053：錯誤確認、錯誤專案、非 DBA 仍然拒絕。

隔離資料庫測試為合成資料。對線上真實資料的破壞性測試未執行時不得宣稱真實跨服務清除已驗證。若 SQL 成功回傳 `submitted`，不代表工作已完成；必須檢查狀態與上述資料表。
