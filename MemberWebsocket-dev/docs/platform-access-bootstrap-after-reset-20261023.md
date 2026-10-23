# Platform 清除後的登入紀錄與授權操作

> **更新：2026-10-23 — 最高管理員改由 Supabase Table Editor 開通。** 原本「先到 SQL Editor 執行 `maintenance.bootstrap_sandbox_root`」的程序不再是建議流程。請改用 [Supabase Table Editor 總管理員核准與撤權操作](./supabase-table-editor-super-admin-approval-20261023.md)：完成 Platform LINE 驗證後，核對 `platform_private.super_admins` 候選帳號的 `line_user_id`，由 Supabase 專案管理者將 `enabled` 勾選為 `true` 並儲存，系統自動開通相應 `public.admins` 帳號。不需要執行 SQL 指令。


## 經證實的起因

測試專案 `dbuquirnaskrwcamdxki` 完成整站清除後，`public.admins` 和 `platform_private.super_admins` 都是零筆，`maintenance.sandbox_reset_epoch.root_bootstrap_required=true`。原先 `/platform/` 驗證 LINE 後僅核對 root 授權，首次登入不會在 DB 留下候選人紀錄。

## 新版驗收條件

- **AC-PLAT-101**：使用 Platform 專用 LINE Provider 成功驗證後，`platform.bootstrap` 必須在 `platform_private.platform_access_requests` 建立待審紀錄，即使回傳 403。記錄 `line_user_id`、來自 LINE 驗證的顯示名稱、首次／最後登入時間。不能自動變更或建立 `public.admins` 管理員身分，以免阻止第一位 root DBA 初始化。
- **AC-PLAT-102**：已初始化、已啟用的 singleton root 能在 Platform「管理權限審核」區塊核准／撤銷已驗證候選人的操作權限；授權變更與操作者寫入 `platform_private.audit_events`。
- **AC-PLAT-103**：重複登入不覆蓋授權狀態，請求內偽造的名字／角色不得入庫。錯誤 LINE Provider 的 token 拒絕。
- **AC-PLAT-104/105**：普通訪客、管理員、已核准的受委任 Platform 管理員，不得自行核准或撤銷平台管理權；只有 singleton root 可以審核。撤權後舊 LINE token 的下一次請求立即拒絕。
- **AC-PLAT-106**：真實 Chromium /platform 頁面串接伺服器與隔離 PostgreSQL，走完 pending → root 核准 → 進入工作台 → root 撤權 → 無法繼續存取的旅程。

## 清除後的第一位總管理員操作

由預定總管理員先使用 Platform 專用 LINE 完成登入，系統會建立 `super_admins.enabled=false` 候選紀錄。Supabase 專案管理者登入 Table Editor、切換 `platform_private` schema、打開 `super_admins`，核對候選 LINE User ID，勾選 `enabled=true` 並儲存。系統透過資料庫觸發器同步將管理員設成 `role=admin`、`status=active`，結束清除後的 root 初始化需求。未核准、錯誤身分或撤權者都不得存取 Platform。

## 測試／復原

- `node --test MemberWebsocket-dev/tests/integration/platform_access_registration.cjs`（需先安裝 `MemberWebsocket-dev/tests/integration` 的固定依賴）
- `npx playwright test platform-access.spec.cjs`（在 `MemberWebsocket-dev/tests/browser` 安裝依賴後執行）
- 本項遷移不修改既有 root 或重置完成紀錄；若上線版本退回舊版，新的授權表不應因此直接刪除，先撤銷所有 delegated grant，改回原本 root 專用模式，再審查歷史登入／稽核紀錄的保留。
