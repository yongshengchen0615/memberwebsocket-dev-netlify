# 會員系統風險診斷與操作體驗修正

日期：2026-10-03。分析起點：`8349c60`；交付整合基準：`0b5b04a`。
範圍：GitHub Pages 六個主要入口、共用前端、31 個 Supabase Edge Functions、資料庫權限與 advisors、私人收據／測試儲存桶、既有 CI 與相關交易流程。

## 核心判斷

優先處理收據內容完整性、非同步操作競態與服務時間統計一致性。這些問題會造成重複操作、錯誤提示、相機未釋放或會員等級顯示失準。現有 LIFF → 伺服器身分驗證 → 管理權限／會員資格 → 所有權 → SQL 交易的架構可保留。

本輪完成五類修正：收據安全替換、相機與提交生命週期、轉贈收件人／欄位／餘額同步、資料庫服務時間加總、六個入口的 SDK 版本與完整性固定。未以大規模改版或更換框架代替問題修復。

這是有範圍的程式與線上設定檢查，不能視為完整滲透測試、實機驗收或容量認證。

## 已確認事實

- FACT：前端為 GitHub Pages 靜態頁。會員透過 LIFF 取得 LINE ID token；後端驗證 issuer、audience、expiry，再查詢管理員／會員狀態。前端 membership tier 不作為管理權限。
- FACT：公開 schema 的 53 張資料表全部啟用 RLS；未查到可由 anon／authenticated 執行的 public SECURITY DEFINER 函式。新增的統計與收據 RPC 僅允許 service_role 執行。
- FACT：`booking-receipts` 與 `e2e-failure-artifacts` 都是私人儲存桶，有大小與 MIME 限制。匿名 Data API 讀取會員、預約以及呼叫新增統計 RPC 均回傳 HTTP 401／SQL 42501。
- FACT：檢查時未發現負點數或終止／完成預約仍保留 pending 票券選擇的資料。
- FACT：當時 `automation_test_runs`、`booking_receipts` 與 `service_time_entries` 沒有資料。不能把空結果當成實際會員流程、快照或大量歷史資料已驗收的證據。
- FACT：Supabase security advisors 有 52 個「RLS 已啟用、沒有政策」資訊提示，以及 1 個 `pg_net` 位於 public 的警告。此架構透過後端高權限 client 存取，多數無政策資料表是刻意拒絕直接用戶存取；不能為消除提示加入全面開放政策。
- FACT：performance advisors 列出 4 個未使用索引。它們可能服務低頻功能；本輪未依單次「未使用」觀測刪除索引。
- FACT：PostgreSQL 版本為 17.6。官方 2026-09-25 changelog 記載 17.11 的安全與相容性更新；本輪沒有執行可能中斷服務的資料庫升級。

## 問題、原因與修正

| 優先級 | 已確認的原因 | 影響／推論 | 本輪處理與證據 |
| --- | --- | --- | --- |
| P1 | 收據 prepare 使用 `upsert:true`，不同上傳重用同一資料列與 object path | INFERENCE：仍有效的舊上傳 token 可改寫送審檔案；舊 finalize 可能作用於新內容 | 每次嘗試建立獨立 receipt 與檔案，簽名上傳禁止覆寫；已送審／完成的 prepare 重播不取得新 token。SQL 與 API 行為測試通過 |
| P1 | 收據重新上傳一開始就清掉原來的 awaiting_review 狀態 | 網路／格式／版本驗證失敗時，管理員原本可看的收據也消失 | 上傳期間保留原快照；全部驗證成功才在同一 SQL 交易中切換，舊物件加入既有清理佇列。錯誤大小、版本衝突、替換失敗測試保留原圖 |
| P1 | prepare 先鎖 booking 再鎖 receipt；finalize 原本反向鎖定 | INFERENCE：交錯請求有死鎖風險 | finalize 統一先取得 booking 鎖，再重新讀取並鎖定 receipt。測試包含兩個交錯的上傳嘗試與舊 receipt 拒絕；未宣稱已完成正式多連線壓測 |
| P1 | 收據成功排程關閉視窗後，finally 立刻把 busy 與按鈕解鎖 | 900ms 成功提示期間可再次送出；上傳中仍可重新拍攝 | 成功後保持鎖定直到關閉；上傳中停用重新拍攝。DOM 測試確認一次 prepare／一次 upload，成功提示期間也不能再次提交 |
| P1 | getUserMedia、toBlob 與 FileReader 完成時沒有檢查操作是否已過期 | 視窗關閉／切換／離開頁面後，晚到回覆仍能啟動相機或恢復照片 UI | 加入相機與照片操作序號，過期串流立即 stop；pagehide 釋放相機，過期照片回覆不再修改 UI。DOM 測試涵蓋延遲權限、導頁及延遲照片讀取 |
| P1 | 會員／管理列表與發放通知下載 service_time_entries 明細後在 Edge 加總 | INFERENCE：資料增加、超過 Data API 回傳上限時，時間與等級可能低估。當時線上沒有明細，並非已重現的線上錯帳 | 新增 `member_service_minute_totals(uuid[])`，在 Postgres 加總，最多 100 個會員／次；主 API、會員 API、即時及排程發放通知共用。1,501 筆測試得到完整 1,501 分鐘，排除其他會員資料 |
| P2 | 轉贈收件人查詢回來後直接覆蓋 state，未比較輸入版本 | 先查 A 再查 B，晚到的 A 可蓋過 B，造成畫面顯示與目前輸入不一致 | 查詢序號在改輸入、關閉與重查時失效，舊回覆不套用。DOM 測試讓 A 晚於 B 回覆，畫面仍顯示 B |
| P2 | 轉贈提交只鎖確認／關閉按鈕，會員編號、點數及查詢仍可操作 | 提交內容與畫面輸入不同；可能重設重試的識別碼 | 提交期間鎖住相關欄位與查詢，完成／失敗後恢復；相同內容的未確認結果重試保持原 requestId。後端原有扣點與去重仍為安全邊界 |
| P2 | 轉贈選項刷新只更新內部餘額，不更新已開視窗的 max 與提示 | 即時更新後，視窗仍顯示舊的可轉贈點數 | 每次選項刷新同步更新 max、摘要及提示；DOM 測試確認轉贈後 20 → 18 點立即反映 |
| P2 | 六個入口以 `supabase-js@2` 載入浮動 CDN 版本 | 未修改 repository 也可能載入不同 SDK，難以重現與回復 | 固定既有後端採用的 2.57.0 UMD 檔，加入 SHA-384 SRI 與 crossorigin；下載的 CDN bytes 與同版本 npm 檔逐位元組相同。此項不等於所有依賴已完成漏洞掃描 |

## 收據狀態與安全邊界

原快照 `awaiting_review` 在新嘗試 `pending_upload` 期間仍可查看。新照片 MIME、大小、所有權、預約版本與狀態驗證成功後，才把新嘗試改成 `awaiting_review`，原快照標記替換並排入清理。管理端完成服務仍使用既有結算流程，收據最終進入 `bound`。

每次嘗試使用新 receipt ID 與 object path，保留 requestId 重播與內容衝突檢查。新 prepare 可取代未完成的舊上傳，但舊 finalize 不可套用到新嘗試。已送審的同一 prepare 重播不再發上傳 token；一般會員不可直接執行這些 RPC。

上傳授權有效期仍為 Storage 既有的兩小時，不能宣稱瞬間撤銷所有已發 token。本輪檢查時沒有舊收據資料；獨立物件與禁止覆寫使舊 token 無法改寫新快照。遲到的舊上傳可能留下無引用檔案，後續應補物件與資料列對帳清理；目前不把佇列清理視為完整物件生命週期保證。

## 剩餘風險與處理順序

| 順序 | FACT／INFERENCE | 建議與驗收標準 |
| --- | --- | --- |
| 1 | FACT：DB 17.6；已安裝 pgcrypto、btree_gist。官方發布較新安全更新 | 先在可復原環境核對 extension／索引相容性與備份，安排 17.11 或平台支援版本升級；驗收排程、預約排他約束、點數交易與通知。現有版本資訊不能單獨證明本專案可被特定 CVE 利用 |
| 2 | FACT：pg_net 位於 public，advisors 有警告 | 核對 extension 的 relocation 支援及 booking_notifications／排程／Vault 相依後處理；不得直接搬移或刪除。參考 [Supabase remediation](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public) |
| 3 | FACT：共用 LINE 驗證 fetch 沒有明確外部等待期限 | 補後端驗證期限與一致的可重試錯誤，覆蓋所有引用函式；驗證逾時時無業務寫入，不能以放寬身分驗證換取可用性 |
| 4 | FACT：部分歷史票券／收據列表仍有回傳筆數上限或明細讀取；本輪只修正服務時間加總 | 為歷史列表加入分頁，為會決定可用數量的統計逐項改 SQL aggregate。用超過 API 上限資料驗證，避免只改首頁筆數 |
| 5 | FACT：管理端直接引用的本地 JS 約 0.88 MB，預約約 0.47 MB，都是原始未壓縮大小 | 量測 LINE WebView 的首屏、互動等待及每次操作請求數，再按功能拆分。已有 lazy E2E loader，下一輪需保留登入後必需資料與測試啟動順序；檔案大小不能代替實測效能結論 |
| 6 | FACT：多個功能透過 DOM observer 與擴充模組修飾同一頁面 | 逐步使用明確的渲染事件取代 DOM 推測，驗收未儲存輸入、焦點、展開狀態與慢回覆。保留既有即時刷新排程與權限邊界 |
| 7 | FACT：本輪沒有真實登入、實機相機與 LINE 收件驗收 | 使用兩個獨立 Session 驗證最後一張票券、重複結算、上傳途中取消／管理端完成；iOS／Android LINE WebView 驗證相機、鍵盤、返回頁面與重連。不得用 DOM／SQL 測試取代這些驗收 |

## 驗證與發布

- 589 項 Node 回歸：全部通過。
- 63 項 DOM／SQL 整合：全部通過，包含新增交易生命週期與收據完整性測試。
- 63 個正式瀏覽器 JavaScript：語法檢查通過；git diff whitespace 檢查通過。
- 5 個修改的 Edge Functions：Deno 型別檢查通過。
- PGlite 驗證所有權、requestId 衝突、過期／被替換的收據、交易原子性、完成後拒絕替換、單次 audit，以及 1,501 筆統計。
- 線上已套用 `receipt_integrity_and_service_totals` migration，統計空輸入正常；RPC 的 anon／authenticated execute 皆為 false、service_role 為 true。匿名會員／預約讀取及新增 RPC 呼叫皆拒絕。
- 線上已部署 api v59、member-profile-api v24、booking-receipt-api v7、grant-automation v13、scheduled-grant-messages v14。五個函式均保留既有自訂 LINE／管理員／排程 secret 驗證方式。
- 本輪整合最新電話品質、會員自行傳送預約聊天訊息及管理端收據即時同步修正，未覆蓋它們。前端與新增測試隨本 commit 的 main CI／GitHub Pages 發布，結果須以該 commit 的 Actions 為準。
- 本輪未執行會員扣點、領券、完成真實預約、清除資料或傳送 LINE 訊息。線上 unauthenticated 拒絕檢查未產生業務交易。

重現：

```bash
node --test MemberWebsocket-dev/tests/*.test.js
npm ci --prefix MemberWebsocket-dev/tests/integration --ignore-scripts --no-audit --no-fund
node --test MemberWebsocket-dev/tests/integration/*.cjs
deno check MemberWebsocket-dev/supabase/functions/api/index.ts \
  MemberWebsocket-dev/supabase/functions/member-profile-api/index.ts \
  MemberWebsocket-dev/supabase/functions/booking-receipt-api/index.ts \
  MemberWebsocket-dev/supabase/functions/grant-automation/index.ts \
  MemberWebsocket-dev/supabase/functions/scheduled-grant-messages/index.ts
```

本機 Deno 連線 npm registry 受執行環境限制，型別驗證採 npm 預先安裝既有 2.57.0 套件，再以 `--node-modules-dir=manual` 執行；沒有提交測試用 node_modules 或新增正式套件依賴。

## 回復與相容性

Migration 沒有刪除會員／預約資料或變更既有 API 欄位。新的統計函式是附加能力；收據 prepare／finalize 保持參數與回應契約，已送審重播不再回傳 upload token。前端新版本與舊版本一般新 requestId 上傳皆相容。

若需回復前端，revert 本輪 commit 並重新發布。後端若需回復統計讀取，可先部署原查詢版本，保留新的附加 RPC。收據不可單純恢復舊的覆寫實作：新流程允許有效快照與待上傳替換同時存在，回復前須先盤點這些資料，保持新物件隔離與禁止覆寫，避免重新引入內容完整性問題。

參考：[Supabase Changelog](https://supabase.com/changelog)、[Signed upload URL](https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl)、[Data API security](https://supabase.com/docs/guides/api/securing-your-api)。
