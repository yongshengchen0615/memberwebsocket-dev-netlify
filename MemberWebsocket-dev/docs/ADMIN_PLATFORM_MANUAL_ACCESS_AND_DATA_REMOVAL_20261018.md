# 管理員入口、資料庫手動總管理員權限與「移除所有資料」

## 入口與權限
- 一般管理員使用 `/admin/`（產品化模式自動進入 `/admin/workspace.html`）提交申請、查看待審核狀態，核准後僅能設定已授權功能的 LINE 資訊。
- 總管理員獨立使用 `/platform/`，LINE token 必須屬於總管理員專用 Channel，且後端核對資料庫 `platform_private.super_admins` 的 `enabled`、綁定 LINE User ID 與 `public.admins` 的 role/status。
- `20261018181500_platform_manual_super_admin_grant.sql` 在套用時會**停用目前已開通的總管理員**，且之後預設為停用。這是要求資料庫手動授權的刻意行為。資料庫管理人員核對 `platform_private.super_admins.admin_id`、`line_user_id` 為正確身分後，才可在 SQL Editor 執行：

```sql
update platform_private.super_admins set enabled=true where singleton=true;
```

## 「移除所有資料」維護程序（不可逆）
新函數 `maintenance.remove_all_data(text)` 僅提供特權資料庫 SQL 維護操作，**沒有一般管理員網頁按鈕或公開 API**。正式使用前必須備份、停機與在測試環境演練，再由資料庫操作員手動執行：

```sql
select * from maintenance.remove_all_data('REMOVE ALL DATA');
```

清理範圍：既有 `maintenance.clear_public_data` 管理的 `public`／`booking_notifications` 業務資料，以及產品化申請、商家、加密 LINE 憑證、請求及稽核紀錄。保留 `public.admins` 與 `platform_private.super_admins` 身分綁定、必要系統設定；執行後總管理員 `enabled=false`，必須由資料庫重新授權。

這不是清空整個 Supabase 專案：Auth 帳號、Storage 物件、外部 LINE 資料不在範圍。舊 `maintenance.clear_public_data` 為既有系統相容而保留，不視作新的完整清除入口。**此回合不對正式資料執行上述刪除。**
