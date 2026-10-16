# LINE 預約摘要、一般預約未到與中文稽核

對應 Trello：5MhrVN4Z、Nga9rL5A、HafcUSud、yxAgAJGO。

## 行為與權限

會員預約確認 LINE 僅保留狀態、實際日期／時間與服務摘要，移除可用票券推薦與會員階級。LINE 不支援原生收合；一般預約及快照聊天提供現有 booking LIFF 連結，登入後在會員頁以各筆獨立 details 查看本筆明細。一般預約聊天移除營業日字樣並保留實際預約日期。既有歷史 LINE 訊息不能回溯修改。

一般明細的 bookingId 與快照 receiptId 只是資源參照，URL 不攜帶 Token 或聯絡資料。一般預約 Bootstrap 的延伸查詢及快照收據列表的延伸查詢均在後端以目前登入 member_id 篩選；不因連結參數接受他人身分。舊記錄可超出原列表分頁範圍載入，取消或改期後回傳最新狀態。

管理員新預約 LINE 使用 booking-copy-text.js 的同一 formatter 產生 Clipboard Action。超過 1000 字改導至登入後的管理頁複製，不截斷原內容；每則訊息另外保留管理頁複製入口。確認預約按鈕導向現有管理頁，沒有自動 mutation、沒有將群組收件人視為管理員的 webhook。登入後仍由既有 active admin 授權及版本比較執行確認。

待確認一般預約新增 no_show 狀態。API 沿用 admin.booking.status.update，status=no_show，交易 RPC admin_mark_booking_no_show 再驗證 active admin、指定 booking、待確認、非快照、未待取消、updated_at 版本及 Asia/Taipei end_at 已過。前端再次核對會員、時間與待確認狀態，必要勾選人工確認。RPC 鎖定管理角色與 booking，重送已 no_show 回傳 alreadyApplied，不重複成功稽核。僅釋放本筆 pending 票券保留與排程；不扣點、不核銷、不結算、不懲處、不新增會員 LINE 通知。

現有系統管理權限為全域 active admin，尚無門市範圍模型；本次維持此邊界，沒有用會員階級代替權限。

## 稽核來源與隱私

沿用 audit_logs、booking_audit_events 與既有 365 天分批清理，不新增稽核表。會員卡只在首次顯示的頁面送開啟紀錄，後端按會員與 15 分鐘時間區間去重；同頁重繪與背景重連不重複送。會員資料儲存與成功稽核改為同一 RPC 交易，只記實際變更的欄位名稱；無變更重試不重複成功事件。

轉點來源本已在交易中記錄，擴充既有稽核查詢納入該來源，以已提交 point_transfers 回讀轉出／轉入遮罩識別、卡名與數量；兩方會員篩選均能查詢。票券批次核銷以已提交票券名稱回讀，預約選票與核銷事件中文標籤分開。UI 使用中文名稱與白名單明細，不顯示原始 JSON；未知或缺欄位事件安全顯示其他操作／未提供明細。

新 RPC 僅授權 service_role；anon/authenticated 無執行權。既有登入／session 撤銷與身份驗證、限流保留。

## 驗證

本地完整 regression 825 項與相關 integration 21 項通過；另新增 3 項 LINE 複製、會員摘要與 IDOR 合約測試通過。相關 Edge Functions 的 Deno typecheck 通過。隔離 PostgreSQL 驗證未到時間、非管理員／撤權、快照／終止狀態、重送、稽核失敗回滾、票券保留及點數不變；驗證轉點雙方篩選及敏感資料白名單。

DOM 測試檢查一般明細初始收合、唯讀、多筆／外部ID、中文稽核舊資料，以及未到按鈕時區判定。管理端既有瀏覽器 journey 增加手機／桌機 no_show 的必要人工勾選、單次 mutation、列表與待確認數量回讀；修改 AUDIT_QUERY 期望為中文與結構化欄位。GitHub CI 執行真實 Chromium 與 Deno tests；本地隔離執行環境沒有 /proc，無法執行 Chromium／Deno runtime tests，本地 LINE helper tests 另以 Node 24 實際執行。

所有測試採隔離資料與假 transport，沒有傳送測試 LINE 至真實會員、沒有核銷真實票券。LINE iOS／Android 原生 Clipboard 與 LIFF 真機操作需真人驗收，不能將 CI payload 驗證宣稱為真機驗證。

## 發布與回退

1. 確認 GitHub CI。
2. 套用 booking_notifications_noshow_readable_audit migration（擴充既有 booking status constraint、兩個標記欄位、交易 RPC 及白名單稽核查詢）。
3. 部署 api、booking-api、member-profile-api、booking-receipt-api、booking-line-notifications；沿用現有 verify_jwt=false 與各函式內的 LINE／dispatch-secret 驗證。
4. 合併 main，確認 GitHub Pages、線上檔案、函式版本、RPC ACL 與無認證的負向 smoke。

程式回退可還原前端與 Edge；DB 相容擴充必須保留，不能將既有 no_show 資料改成取消或刪除稽核。誤判未到目前沒有無痕撤銷按鈕；需提交指定 booking 的人工更正，核對排程及票券再以具授權的更正交易處理，留下原狀態、新狀態、理由、操作者與時間的 BOOKING_NO_SHOW_CORRECTED 紀錄。不得直接刪除原 no_show 稽核或替會員自動扣點。

資料庫 advisors 的既有 pg_net public-schema 警告與 service-role-only 表的「RLS 無 policy」提示為既有架構項目，不擴大本次 schema 變更；新 RPC 保持最小 grant。

## 正式後端部署紀錄

2026-10-14 已套用 `20261014043730_booking_notifications_noshow_readable_audit`，版本與正式 migration history 對齊。Edge Functions：api v84、booking-api v44、member-profile-api v29、booking-receipt-api v32、booking-line-notifications v17 均為 ACTIVE；維持原自訂認證。前端與 main 等待最新 CI 通過後發布。
