# Supabase Table Editor 開通總管理員（不使用 SQL Editor）

限定測試專案：`MemberWebsocket-dev`，Supabase Project Ref `dbuquirnaskrwcamdxki`。

## 身分與權限

- **Supabase 專案管理者**：可登入 [Supabase Table Editor](https://supabase.com/dashboard/project/dbuquirnaskrwcamdxki/editor) 編輯受保護的資料表；他不是因為登入 Platform 就自動得到 Platform 總管理員身分。
- **Platform 總管理員**：先以 Platform 專用 LINE 登入並完成身分驗證，資料庫會建立一筆 `platform_private.super_admins` 候選紀錄，`enabled=false`。
- **一般管理員／訪客**：無權直接編輯 `super_admins` 或啟用自己；只有 Supabase 專案管理者透過資料庫操作才可開通首位 Platform 總管理員。

## 點選操作（清除後的第一位總管理員）

1. **讓預定要開通的總管理員先開啟** [Platform](https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/platform/)，使用 **Platform 專用 LINE** 登入一次。畫面顯示「尚未核准」是正常的。
2. Supabase 專案管理者開啟 [Table Editor](https://supabase.com/dashboard/project/dbuquirnaskrwcamdxki/editor)；選取 schema `platform_private`，開啟 `super_admins`。
3. **先核對 LINE User ID**：`line_user_id` 必須是預定總管理員的 Platform LINE 身分。清除後表格應出現一筆 `enabled = false` 的候選紀錄。這個欄位不是 LINE Channel ID，也不是 LIFF ID。若它屬於其他人，**不要開啟**；先確認正確候選身分。
4. 確認身分正確後，把唯一候選紀錄的 **`enabled` 勾選為 `true`，按 Save**。由資料庫觸發器同步將其 `public.admins.role` 設為 `admin`、`status` 設為 `active`，並結束清除後的 root 初始化待辦。**不需要執行任何 SQL。**
5. 請總管理員重新登入 Platform：應可以進入管理頁。若 Supabase 管理者將 `enabled` 取消勾選、儲存，舊的 LINE 登入憑證也不能再進入 Platform。

## 安全注意

- **誰第一個完成 Platform LINE 驗證，只會成為停用狀態的候選人，並不會自動得到權限。** 首位候選人不是預定總管理員時，不能直接勾選 `enabled`。這張舊版 singleton 表目前只允許一位 root；需要先由授權的 Supabase 管理者修正候選人綁定，不要用錯誤 LINE ID 開通。
- 一般帳號依然可以留下 `platform_private.platform_access_requests` 待審身分紀錄；此表的 `access_enabled` 和最高管理員的 `super_admins.enabled` 是**不同權限**，勿混淆。
- `super_admins.enabled` 的開通／停用會寫入 `platform_private.audit_events`，資料庫操作者記錄為 `postgres`；個別 Supabase 儀表板操作者的身分需另外結合專案審計紀錄核實。
- 不要將 Supabase 管理員帳號、`service_role` 金鑰或 SQL Editor 的寫入能力提供給一般管理員。

## 驗收規則

| 編號 | Given／When／Then |
|---|---|
| AC-PLAT-107 | Given 清除後無 root；When Platform LINE 驗證成功；Then 自動建立 disabled 候選列，不取得權限；Supabase 啟用後才能使用 |
| AC-PLAT-108 | Given 已授權 root；When Supabase 把 enabled 改為 false；Then 舊 LINE token 後續請求立即被拒絕 |
| AC-PLAT-109 | Given 一般使用者；When 重複登入或嘗試透過 service_role 開通；Then 不得自行啟用 root |
| AC-PLAT-110 | Given 已啟用 root；When 嘗試直接換成其他 LINE 身分；Then 必須先取消啟用，防止靜默變更 |
