# Platform LINE 登入 → Supabase super_admins 授權

**權限真實來源只有 `platform_private.super_admins`，總管理員不必在 Platform 提交申請，Supabase 擁有者也不必執行 SQL 指令。**

1. 使用者在 [Platform](https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/platform/) 使用**Platform 專用 LINE Login** 完成身分驗證。
2. 後端以驗證過的 LINE `sub` 自動將 `line_user_id`、`display_name`、`first_seen_at`、`last_seen_at` 寫入 `platform_private.super_admins`。預設 `enabled=false`、`singleton=NULL`、`admin_id=NULL`；未開通時顯示等待管理者授權，工作台不開放。
3. **Supabase 專案擁有者**開啟 [MemberWebsocket-dev Table Editor](https://supabase.com/dashboard/project/dbuquirnaskrwcamdxki/editor)，切換 schema 至 `platform_private`，選 `super_admins`，比對使用者真實 LINE ID 與顯示名稱，在該筆資料**只將 `enabled` 改為 `true`**，按 Save。
4. 管理員重新登入 Platform 即可使用商家申請審核、功能權限及商家管理。若撤權，Supabase 擁有者將同一欄 `enabled` 改回 `false`，下一次受保護請求立即拒絕。
5. 可從 `platform_private.audit_events` 查看 `PLATFORM_SUPABASE_ACCESS_GRANTED` / `PLATFORM_SUPABASE_ACCESS_REVOKED` 事件；在 Supabase SQL 管理連線下事件中的 `actor` 可能只能指出 PostgreSQL 身分，**無法保證辨識實際 Dashboard 人員**。

此流程允許多筆候選人，但保留既有 `singleton=true` 舊版 root grant 以相容清除後初始化。root grant 仍要求對應 `public.admins` 帳號啟用；一般 Platform 總管理員只要求 `super_admins.enabled=true`，不會自動插入 `public.admins` 或成為商家管理員。

## 驗收條件

- **AC-PLAT-201**：首次 LINE 登入在 `super_admins` 有唯一待審資料，重複登入不升權
- **AC-PLAT-202**：Supabase 修改 `enabled=true` 後可操作；改回 false 立即拒絕舊 LINE token
- **AC-PLAT-203**：Platform 前端及 API 皆無總管理員互相核准能力
- **AC-PLAT-204**：請求偽造 `line_user_id`、角色、顯示名稱無法升權；錯誤 LINE Channel 不得進入
- **AC-PLAT-205**：`anon`、`authenticated`、`service_role` 都無權直接更新 enabled；資料庫稽核可讀取異動記錄
- **AC-PLAT-206**：多位登入使用者各有獨立候選人紀錄，授權隔離
- **AC-PLAT-207**：Chromium 實際走過 LINE → DB pending → DBA 直接開通 → 可使用 → 停用 → 拒絕

## 限制及回復

此變更會調整 `super_admins` 原先的單筆主鍵結構，先維持 `singleton=true` root 的唯一性；保留 `platform_access_requests` 舊資料但**不再拿它當授權依據**。Schema 回退前，必須妥善匯出或移除多筆新增候選人資料，否則無法恢復原單例主鍵；操作應限制在授權測試專案。

**已核准登入不等於已取得權限**；必須由 Supabase 管理者核對 LINE 身分並明確修改 `enabled`。Edge service role 僅允許寫入候選人身分與最後登入時間欄位，不能寫入 enabled。
