# 櫃檯 LINE 預約功能：開發交付與驗證紀錄

## 1. 本輪結果

**部分完成且受阻。** 各商家獨立櫃檯入口、逐人審核、兩種權限、通知通道與預約確認／拒絕已實作並完成下列本機驗證。必要完整 CI、實體 PostgreSQL 及真實 LINE 收件尚未完成，因此不宣稱已驗證完成或可上線；尚未合併或部署此功能。

基準分支：`Integrated-Marketing-Platform`；基準 SHA：`45978b9b8a0d393297d14f739cbbbd3a0c47bc88`。
工作分支：`feat/frontdesk-line-booking-20261118`。
主要實作與審查修復提交：`566ac5e`、`b3894bf`、`cfae915`、`d3c64d9`；最後的介面對比修正及文件提交另見分支最新 HEAD。
核對的開發 Supabase：MemberWebsocket-test，`bmwhojszsnxliekkhrka`。資料庫只進行唯讀結構盤點；新遷移只在本機隔離資料庫測試，未套用遠端。

## 2. 第一性原理與決策

| 項目 | 決策及不變條件 |
|---|---|
| 目標 | 經核准櫃檯收到與管理員相同資訊的預約通知，由商家逐人授權 |
| 身分 | 專用 LINE Login／LIFF；ID token audience 由商家可信設定決定；申請時以已驗證 sub 向設定的 OA 查驗可達性 |
| 權限 | `notify_only` 僅收訊息；`review` 可確認／拒絕本商家的 pending 預約；不加入完整管理員角色 |
| 狀態 | pending／approved／rejected／suspended；撤銷在交易內生效，舊待送通知永久 skipped |
| 資料 | 私有人員資料、用途綁定加密憑證、商家內通知訂閱投影、版本與 request ID；不由前端提供 actor 或 schema |
| 原功能 | 管理端 owner-only 保留；首次櫃檯設定保留既有共用 Login 及通知憑證；既有會員通知與預約狀態規則保留 |
| 範圍 | 開發環境；正式變更未獲授權。LINE 真實通道／測試收件者尚未提供，不能把 provider stub 當實收 |

使用者已確認「各商家獨立櫃檯入口、逐人授權」。沿用現有通知與預約框架，沒有新增套件、通用 RBAC、另一套預約系統、固定 sleep 或新輪詢。

## 3. 變更內容

- `frontdesk/`：獨立的申請、本人狀態、待處理預約、確認／拒絕介面；支援手機、桌機及暗色外觀。只有通知權限時不查詢預約清單。
- `admin/frontdesk-settings.js`：掛在預約 LINE 設定，設定本商家櫃檯官方帳號、提供入口網址、逐人審核與權限設定；結果不明時只允許重試同一操作。
- `frontdesk-api`、`_shared/frontdesk-*`：受限 API、LINE 身分及設定 OA 的 profile 查核、輸入限制、速率限制、CORS、錯誤分類與秘密遮罩。
- `20261118122150_frontdesk_booking_access.sql`：私有 `frontdesk_staff`、service-role-only RPC、同交易授權／狀態更新、稽核及冪等；現有與新建商家的通知及 outbox 約束同步。
- 既有通知 dispatcher 新增 `frontdesk` 通道，使用獨立加密 token；送出前重查權限，保持原 LINE retry key 與租約。沒有設定時不回落到會員／管理員通道。
- 靜態建置、明確 Edge 部署清單及 CI 納入新入口與測試，包含實體 PostgreSQL lane 的明確檔名。

遷移未發佈，因此本分支內的修正未覆寫任何已部署 migration。此版本不需要 Webhook，沒有收集或新增使用 Channel secret；不以 bot/info 取得成功推定 Login／OA 全域綁定。

## 4. 驗收對照

以下「通過」均指所列隔離測試，不能替代完整部署驗收。

| AC | 實際涵蓋 | 本輪結果 |
|---|---|---|
| 001、003、004、007 | 設定、申請去重、預設僅收通知、逐人核准及偽造 actor／role 防護 | SQL／API／瀏覽器通過 |
| 002、006 | 可信 audience、無效身分與跨商家拒絕、anon／authenticated 無 RPC 權限 | Node／SQL 及沿用 verifier 回歸通過 |
| 005、008、011 | 確認與拒絕、降權後舊頁面拒絕、版本衝突、相同 request ID 重送 | SQL／API／瀏覽器通過；外部 LINE 待驗 |
| 009、016 | 商家停用、期限、booking grant、個人停用、舊通知不因重新核准復活；明確拒絕後清除畫面 | SQL／DOM 通過；實體交易排序待執行 |
| 010 | 已新增雙實體連線競爭、撤權排序、回滾及還原案例並接入 CI | 未執行實體 PostgreSQL；原管理員 HTTP＋櫃檯的完整競爭驗收仍待補 |
| 012、013 | 會員建立／變更／取消申請的通知格式與 fanout；待取消預約的櫃檯操作拒絕且整筆預約不變 | SQL 通過；含真實票券預留的專項驗收仍待補 |
| 014、015、017 | 不跨用途回落、Flex 入口按權限顯示、既有通知重試與 provider 故障語意 | Node／Deno 通過；真實第三通道實收待驗 |
| 018 | 既有商家升級、模板新建商家、舊憑證保留 | PGlite 通過；實體 PostgreSQL／遠端遷移待執行 |
| 019 | 390px 暗色與 1280px、重送與降權、逐人權限、首次設定重試、無橫向溢出與連結對比 | Chromium／DOM 通過；完整既有瀏覽器基線待 CI |
| 020、021 | 真實 OA／LIFF／測試人員收件、全部 CI、同 SHA SQL→Edge→Netlify | 受阻，未執行，不能計為通過 |

## 5. 測試報告

原始證據在本次工作區 `evidence/`；沒有摘要退出碼或必要案例未跑的項目不列為通過。

| 檢查／層級 | 命令／工具 | 實際結果 | 通過／失敗／跳過 | 證據檔 |
|---|---|---|---|---|
| 全應用 Node 回歸 | `node --test MemberWebsocket-dev/tests/*.test.js` | exit 0 | 1,571／0／0 | `frontdesk-head-node.tap`；最後文件提交後另跑 same-tree 檢查 |
| SQL／API／DOM 與相鄰通知 | `node --test MemberWebsocket-dev/tests/integration/frontdesk_*.cjs .../notification_routes.cjs .../booking_notification_events.cjs` | exit 0 | 16／0／0 | `frontdesk-fixed-integrations.tap` |
| Edge 業務與通知測試 | Deno 2.9.6：`deno test --node-modules-dir=manual .../_shared/*_test.ts .../delivery_test.ts` | exit 0 | 56／0／0 | `frontdesk-head-edge.log` |
| 修改入口型別檢查 | `deno check`：frontdesk-api、platform-api、booking-line-notifications | exit 0 | 3 入口 | `frontdesk-fixed-typecheck.log` |
| Chromium | `playwright test frontdesk-booking.spec.cjs notification-settings.spec.cjs` | exit 0；含審查修復與連結對比案例 | 6／0／0 | `frontdesk-final-browser.log` |
| 部署／環境／治理合約 | `node --test`：branch-environment、supabase-release、supabase-release-sql、netlify-publish-workflow、runtime-quality、governance-workflow | exit 0 | 62／0／0 | `frontdesk-final-safe-contracts.tap` |
| 建置／格式／計時器 | `node scripts/build-site.mjs`、`git diff --check`、`node scripts/runtime-quality.mjs --base 45978b9...` | exit 0；timer 新增／修改 0 | 無失敗 | 工具執行紀錄及 `frontdesk-build.log` |
| 相依套件安全 | `npm audit --prefix .../tests/integration --audit-level=low` 及 browser | exit 0 | 兩份皆 0 vulnerabilities | `frontdesk-integration-audit.log`、`frontdesk-browser-audit.log` |
| 開發資料庫結構預檢 | Supabase 唯讀 SQL | 通知函式替換錨點均 true；兩個待擴充約束名稱存在 | 非遷移執行證據 | 工具回應 |
| 必要完整 CI／實體 PostgreSQL／所有既有 Chromium／退役端點外部檢查 | 未完成 | 受阻 | 不計 pass | 見第 6 節 |
| LINE 真實收件／遠端遷移與部署 | 未執行 | 受阻 | 不計 pass | 尚無遠端發佈版本 |

環境說明：初次使用舊 Deno 2.2.7 曾出現既有套件 interval sanitizer 錯誤；改用與 CI `v2.x` 相符的 Deno 2.9.6 後原測試不變、56 項通過。初次治理測試因沙箱沒有可用 `/tmp` 失敗；指定工作區 TMPDIR 後原測試不變並通過。

效能：同一隔離 PGlite、同一資料、每階段 5 次暖機＋30 次測量，每次清除合成預約與其測試 ephemera。候選 SQL SHA-256 為 `ef37cf03e1c1b5e34454e5a70201462108d56a2df6a08189826cb7284514dc22`。

| 指標 | 基準模板 | 候選 SQL | 解讀 |
|---|---:|---:|---|
| 建立預約 p50 | 6.28 ms | 5.64 ms | 本機量測，未觀察到未啟用櫃檯時的退化 |
| 建立預約 p95 | 8.51 ms | 7.51 ms | 不能當作 hosted API／外網提速證據 |
| 每筆既有通知列 | 1 | 1 | 沒有增加既有管理員／會員通知 fanout |

量測指令：`node scripts/benchmark-frontdesk.cjs`；證據 `frontdesk-head-benchmark.json`。初步未清除 ephemera 的比較被判定資料不一致，不作前後效能結論。

## 6. 已知問題與阻礙

| 等級 | 狀況 | 解除方式 |
|---|---|---|
| 發布阻擋 | 完整既定腳本包含對正式 Supabase 五個已退役端點的 GET／OPTIONS／POST 無效 JSON 檢查；自動審查拒絕，理由是正式環境連線超出本次開發授權 | 取得使用者對此無資料寫入 410 檢查的明確授權，再執行原完整 CI；不改弱、刪除或 mock 取代此必要檢查 |
| 發布阻擋 | 本機沒有 Docker／實體 PostgreSQL；新增競爭／回復案例尚未實跑 | 授權後在既有 disposable PostgreSQL CI job 執行，核對實際結果 |
| 外部驗收阻擋 | 沒有新櫃檯 OA／LIFF 實際設定及核可測試收件者 | 在商家自己的櫃檯設定完成通道與 LIFF Endpoint，再以合成人員／預約取得 LINE 實收證據 |
| 待補驗收 | 原管理員 HTTP 與櫃檯真正競爭、含真實票券預留的待取消負向案例 | 發布前補足 API／實體 DB 證據，不以目前 SQL 回歸代替 |
| Minor | LINE bot profile 401／403 與 404 的訊息尚未完全區分 | 目前皆拒絕申請，後續可改善設定失效與好友狀態的診斷文案 |
| Minor | 待處理列表最多 50 筆，未提供分頁；個別通知連結仍可直接開啟指定預約 | 補充分頁後擴充 UI／權限測試，不能宣稱清單已涵蓋全部紀錄 |

已透過唯讀 Supabase 管理工具確認正式五個退役函式的現行原始碼只有固定回傳 410，沒有認證、資料庫或外部服務操作；這不把自動拒絕當作已解除，也不算外部檢查通過。受阻檢查沒有被移除；草稿提交若包含 skip-CI 標記，只用來避免在取得授權前間接觸發被拒絕的連線，不作合併或發布依據。

獨立審查的六個 Important 問題都已補 RED→GREEN：舊憑證繼承、OA 驗證與設定競爭、停用後舊 outbox 失效、首次設定重試、授權拒絕清除畫面、實體 PostgreSQL CI 接線。手機暗色連結對比亦有重現與修復案例。

## 7. 執行與回復

先按 repository 原本流程安裝 integration／browser 鎖定依賴，執行第 5 節命令。`frontdesk/` 已納入 `node scripts/build-site.mjs` 的產物；端點需要同版 `frontdesk-api`、`platform-api`、通知 dispatcher 與新 migration。

沒有遠端部署，無須回復線上功能。若開發驗收後發布，功能可先關閉櫃檯入口與通知、停用人員，再以 revert commit 經原 CI 修正前進部署；保留稽核與人員資料，不自動反轉已合法確認／拒絕的預約，不刪除會員資料。

## 8. 下一步與本輪裁定

1. 使用者明確授權既有正式退役端點的無資料寫入 410 檢查後，移除草稿的 skip-CI 條件，以新提交啟動原完整 CI。
2. 補完實體 PostgreSQL、所有必要原基線與尚缺驗收；有任何 failed／skipped／未執行均保持未完成。
3. 通過後只合併至 Integrated-Marketing-Platform，對帳同 SHA 開發 SQL→Edge→Netlify，完成新 OA 實收及開發站 smoke；正式環境另需明確授權。

本輪裁定：使用此任務新 clone 的獨立 feature 分支；通知人員採交易內同步的商家本地投影，保留既有 provisioning 禁止 private schema 參照的規則；個人 OA 可達性透過已驗證 ID-token sub 與設定 bot 的 profile 查核，並以通道及設定 revision 防競爭；不推論全域 Login／OA 綁定。代價分別是投影同步必須維持交易契約、外部綁定仍須真實驗收。保留所有必要 CI，發布在阻擋解除前停止。
