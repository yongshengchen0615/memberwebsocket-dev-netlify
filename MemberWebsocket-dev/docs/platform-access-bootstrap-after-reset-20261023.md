# Platform 清除後的登入紀錄與授權操作

## 經證實的起因

測試專案 `dbuquirnaskrwcamdxki` 完成整站清除後，`public.admins` 和 `platform_private.super_admins` 都是零筆，`maintenance.sandbox_reset_epoch.root_bootstrap_required=true`。原先 `/platform/` 驗證 LINE 後僅核對 root 授權，首次登入不會在 DB 留下候選人紀錄。

## 新版驗收條件

- **AC-PLAT-101**：使用 Platform 專用 LINE Provider 成功驗證後，`platform.bootstrap` 必須在 `platform_private.platform_access_requests` 建立待審紀錄，即使回傳 403。記錄 `line_user_id`、來自 LINE 驗證的顯示名稱、首次／最後登入時間。不能自動變更或建立 `public.admins` 管理員身分，以免阻止第一位 root DBA 初始化。
- **AC-PLAT-102**：已初始化、已啟用的 singleton root 能在 Platform「管理權限審核」區塊核准／撤銷已驗證候選人的操作權限；授權變更與操作者寫入 `platform_private.audit_events`。
- **AC-PLAT-103**：重複登入不覆蓋授權狀態，請求內偽造的名字／角色不得入庫。錯誤 LINE Provider 的 token 拒絕。
- **AC-PLAT-104/105**：普通訪客、管理員、已核准的受委任 Platform 管理員，不得自行核准或撤銷平台管理權；只有 singleton root 可以審核。撤權後舊 LINE token 的下一次請求立即拒絕。
- **AC-PLAT-106**：真實 Chromium /platform 頁面串接伺服器與隔離 PostgreSQL，走完 pending → root 核准 → 進入工作台 → root 撤權 → 無法繼續存取的旅程。

## 先恢復清除後的第一位最高管理員

此步驟必須由授權 DBA 在 [測試專案 SQL Editor](https://supabase.com/dashboard/project/dbuquirnaskrwcamdxki/sql) 執行。**不可以用「誰先登入就自動成為超級管理員」替代。**

1. 先用 Platform 專用 LINE Login 在 `/platform/` 登入，這只會建立待審記錄：
```sql
select line_user_id,display_name,first_seen_at,last_seen_at,access_enabled
from platform_private.platform_access_requests
order by first_seen_at;
```
2. **由 DBA 確認本人平台 LINE 身分後**，在重置完成且 root 尚未初始化的情況下執行一次：
```sql
select maintenance.bootstrap_sandbox_root(
  '<經獨立確認的 Platform 專用 LINE User ID>',
  'RESTORE ROOT AFTER VERIFIED SANDBOX RESET'
);
```
3. 核對：
```sql
select (select count(*) from public.admins where role='admin' and status='active') active_admins,
       (select count(*) from platform_private.super_admins where enabled) root_grants,
       (select root_bootstrap_required from maintenance.sandbox_reset_epoch where singleton) bootstrap_pending;
```
應有 1 位 root 授權、且 `bootstrap_pending=false`。root 再重新登入 Platform，就可透過新的審核區塊管理其他人的權限。

**注意**：`platform_private.platform_access_requests` 是專用 Platform 待審及授權表，不代表用戶已是會員、一般商家管理員或 `public.admins` 帳戶。這避免身分與不同角色混用。所有平台操作都由伺服器再查有效授權，前端隱藏審核按鈕本身不構成安全控制。

## 測試／復原

- `node --test MemberWebsocket-dev/tests/integration/platform_access_registration.cjs`（需先安裝 `MemberWebsocket-dev/tests/integration` 的固定依賴）
- `npx playwright test platform-access.spec.cjs`（在 `MemberWebsocket-dev/tests/browser` 安裝依賴後執行）
- 本項遷移不修改既有 root 或重置完成紀錄；若上線版本退回舊版，新的授權表不應因此直接刪除，先撤銷所有 delegated grant，改回原本 root 專用模式，再審查歷史登入／稽核紀錄的保留。
