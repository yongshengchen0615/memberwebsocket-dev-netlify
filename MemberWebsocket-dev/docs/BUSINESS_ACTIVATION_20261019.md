# 核准即開通

| 項目 | 實作契約 |
| --- | --- |
| 目標 | 核准交易同時建立獨立業務空間，管理員立即使用核准功能，取得專屬用戶連結。 |
| 身分 | 平台總管理員採獨立 LINE Channel；一般管理員以申請時驗證的 LINE UID 綁定商家擁有人，不自行升權。 |
| 權限 | 每次業務請求重新讀取商家狀態及八項權限；未知操作拒絕；撤銷、停用適用既有 token。 |
| 狀態 | 審核失敗維持 pending；核准與隔離佈建同一交易完成為 active，沒有第二次人工開通。 |
| 資料 | 每商家 private schema，64 個業務／通知資料表、251 個函式；獨立序列、FK、觸發器、通知佇列。原商家資料不複製。 |
| LINE | 未完成自有 LINE 設定時沿用平台登入；完整保存後切換自有入口。Messaging token 僅後端解密，未設定時不借用原商家 token。 |
| 用戶端 | `/member/`、`/points/`、`/event/`、`/calendar/`、`/booking/` 以 `business` 代碼定位；不能用代碼取得管理員權限。 |
| 限制 | 會員、集點、活動、日曆、預約共享會員加入及條款基礎；卡片管理仍按核准功能開放。商家需自行保存業務內容及發佈會員條款。 |
| 驗收 | AC-201–211；SQL 隔離、真實 request adapter、Chromium 核准→入口→管理工作台，以及原有完整基線。 |

業務 API 使用 request-local AsyncLocalStorage。只把 URL／token subject 作路由提示，原有 LINE Verify 與私有 schema 的管理員／會員驗證仍必須通過。一般管理員的跨商家請求在原 handler 執行前拒絕，避免舊 pending 管理員登記造成跨商家寫入。

所有業務 schema 僅 service_role 可查詢／執行，表均啟用 RLS。瀏覽器取得的是公開商家名稱、核准功能及可用的 LIFF 設定，不取得資料庫 schema、憑證或密文。檔案的路徑強制加上商家 UUID 前綴；資料庫清理函式透過同一前綴的 Storage view 尋找檔案。前端改用已驗證的定期讀取，不訂閱共享 Realtime 頻道。

業務模板為既有 schema 的 metadata 快照，沒有會員、預約或憑證資料。通知 schema 一併納入，來源 Vault getter 不複製成全域秘密讀取權；各商家使用自己的加密憑證。新商家從空白業務內容與預設設定開始。模板生成、namespace 結構檢查及真實會員寫入驗證都在核准交易內執行，失敗會回復整筆核准。

`platform-business-runtime` 每分鐘處理各商家自己的固定票券、提醒與通知佇列；未保存該商家 LINE 憑證時不發送其通知。既有原商家排程保留。

操作測試僅使用合成帳號、PGlite 及隔離瀏覽器資料。LINE HTTP provider 在測試中替代；不得將此解讀為各商家真實 LINE Developers 設定或真實推播已驗證。

## 部署與復原

1. 完整 CI 通過後套用 `20261019024033_business_runtime.sql`，佈建先前已核准且未停用的商家。
2. 部署使用 business adapter 的 Edge Functions，保留原有函式自身的 LINE／dispatch-secret 驗證。
3. 發布 `Integrated-Marketing-Platform` 的既有 Netlify alias，核對提交版本、公開商家設定與未授權拒絕。
4. 若需修正版本，先停用受影響商家，再修正並重新部署；不要刪除已產生會員資料的業務 schema。原控制平面 rollback 腳本不適用此版本。

後續業務 SQL 變更必須產生新模板版本並提供已存在 business schema 的升級遷移，不可只修改 public 讓商家維持舊版本。部署後以 template version、表／函式數量與排程狀態驗證，避免混合版本。
