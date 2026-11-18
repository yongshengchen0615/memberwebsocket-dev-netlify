# 櫃檯 LINE 入口、預約通知與商家授權

狀態：使用者已確認各商家獨立櫃檯入口、逐人授權；開發版本及本機測試已完成，必要完整 CI、外部驗收與部署仍受阻。實際紀錄見 `docs/frontdesk-line-booking-20261118-report.md`。

## 1. 需求與第一性原理

使用者要求：新增櫃檯官方帳號入口；會員預約時，經審核的櫃檯人員由櫃檯官方帳號收到比照一般管理員的預約通知；櫃檯入口可確認與拒絕預約。使用者另明確補充：商家管理員可以設定櫃檯權限，允許確認／拒絕，或只接收預約訊息。

| 項目 | 定義 |
|---|---|
| 目標 | 商家將通知與預約審核交給經核准的櫃檯人員，並可逐人控制操作權限 |
| 身分 | 櫃檯從該商家設定的櫃檯 LIFF 登入；伺服器向 LINE 驗證指定 Login Channel 的 ID token，不接受前端傳入的 LINE User ID 作為授權 |
| 權限 | 商家擁有者負責審核、停用及設定每位櫃檯人員的權限；櫃檯僅有本商家預約的明確授權 |
| 狀態 | 人員：pending → approved／rejected；approved → suspended；管理員可將 rejected／suspended 重新核准。預約：僅 pending → confirmed／rejected |
| 資料 | 每位櫃檯身分綁定 tenant_id、Login Channel 與 LINE sub；人員審核、權限、版本與撤權時間可追蹤 |
| 限制 | 沿用既有 LINE 驗證、加密憑證、商家隔離、outbox、通知格式與測試；開發僅限開發分支、測試 Supabase 與開發站 |
| 失敗 | 跨商家、未審核、降權後舊頁面、偽造角色、重複操作、併發確認／拒絕、通知重試與外部故障均須明確處理 |

不變條件：櫃檯不是商家管理員；僅收通知者即使直接呼叫 API，也無法確認／拒絕預約。人員停用、商家停用／過期、擁有者資格撤銷或預約功能撤銷後，相關存取必須由後端拒絕。

## 2. 已確認事實與尚待外部驗證事項

基準：`Integrated-Marketing-Platform`，`45978b9b8a0d393297d14f739cbbbd3a0c47bc88`。

已確認：

- 程式碼及測試專案 `bmwhojszsnxliekkhrka` 尚無櫃檯人員／審核資料表。
- `_shared/business-runtime.ts` 的 `assertBusinessAdmin()` 將管理操作限定為經 LINE 驗證的商家擁有者；不得放寬此條件讓櫃檯進入所有 admin API。
- `_shared/notification-routes.mjs` 與 `platform_private.module_notification_routes` 現僅有 `admin`、`member` 兩種通知用途。
- `booking-line-notifications/index.ts`／`delivery.ts` 已有 outbox 領取、租約、固定 LINE retry key、通知關閉及測試會員阻擋；可沿用。
- `booking-api/index.ts:adminStatusUpdate()` 已檢查預約版本、合法狀態與待審取消申請；櫃檯須遵守相同商業規則。
- `booking-line-notifications/booking-actions.ts` 的既有管理員連結含預設 LIFF；櫃檯連結須從實際商家設定產生，包含商家與預約識別，不得複製硬編碼管理入口。
- 基準 Node 回歸實際執行 1,567 項，全部通過；runtime-quality 檢查新增／修改 timer 0 個。
- GitHub 同一基準 SHA 的 Test MemberWebsocket Dev、Test Netlify build、Ticket Policy UI、Publish verified platform preview 都已回傳 success。這些只代表基準版，不能當作未來櫃檯功能的驗證結果。
- Project #5 items API 回傳 403，無法確認或更新看板卡片；不以此推斷 repository 無權限。

工作假設／本提案決策（不是使用者已逐項指定）：

1. 每個商家設定自己的櫃檯官方帳號與 LIFF，與會員／管理員入口分開。
2. 每位櫃檯各自申請，由所屬商家管理員審核；預設「僅收通知」。
3. 權限為兩種簡明模式，不新增通用角色系統：`notify_only`、`review`。
4. 初次設定櫃檯身分通道後，不在一般設定頁任意更換 Login Channel；避免現有人員身分錯接。若需遷移另行處理。
5. 新核准人員僅收核准後的新事件，不補送過去預約通知。

待外部驗證：櫃檯官方帳號是否已存在、對應 Login Channel／LIFF／Messaging Channel 的實際設定、同 Provider 與 OA 綁定關係，以及核可的合成測試接收者。這些不從會員或管理員的既有設定推定。

## 3. 方案比較

| 方案 | 相容性與成本 | 授權與可驗證性 | 判斷 |
|---|---|---|---|
| 把櫃檯加入既有 admins 並共用完整管理端 | 表面改動少，但會影響既有 owner-only 權限、身分與通知選取 | 很難確保僅收通知與最小操作權限，不符合本次需求 | 不採用 |
| 獨立櫃檯身分與受限入口，沿用預約狀態規則、通知格式及 outbox | 需要專用人員資料與 API，但保留原管理端契約 | 能逐人審核、撤權、隔離商家並測試資料庫交易 | 建議採用，待確認 |
| 複製一整套預約／通知系統 | 維護與回歸成本高，容易狀態分歧 | 相同預約出現兩套邏輯與稽核 | 不採用 |

## 4. 使用流程與權限矩陣

管理端新增「櫃檯人員」區塊；LINE 設定的預約區新增「櫃檯官方帳號／入口」與通知設定。顯示可複製的加入官方帳號、櫃檯登入與待審核入口網址。

櫃檯人員加入官方帳號，從 LIFF 登入後送出申請。待審核、拒絕與停用狀態只顯示本人狀態，不暴露其他人員或預約。商家管理員核准時，選擇權限並可日後修改。

| 能力 | 商家管理員 | 已核准：僅收通知 | 已核准：可確認／拒絕 | 未核准／停用 |
|---|---|---|---|---|
| 設定櫃檯官方帳號 | 自己的商家 | 否 | 否 | 否 |
| 審核人員／修改權限／停用 | 自己的商家 | 否 | 否 | 否 |
| 接收對應的預約通知 | 保留既有管理員路線 | 是 | 是 | 否 |
| 查詢待處理預約及必要詳情 | 保留既有流程 | 否 | 自己的商家 | 否 |
| 確認／拒絕待處理預約 | 保留既有流程 | 否 | 自己的商家 | 否 |
| 改價／改服務／改期／結算／取消審核／會員管理 | 保留既有流程 | 否 | 否 | 否 |

「可確認／拒絕」頁面顯示待審預約列表及處理結果；通知提供「查看／處理預約」入口。點擊通知只開啟頁面，不以 GET、URL 參數或 LINE 連結直接執行狀態變更。操作前顯示目前資料，使用者再次按確認或拒絕；原狀態已更新時說明結果並重新整理。

「僅收通知」訊息不提供操作按鈕；本人入口顯示「目前權限：僅接收預約訊息」。舊的操作連結仍須重新授權，不能以訊息生成當下的權限放行。

## 5. 身分與資料邊界

- 在 `platform_private` 新增商家櫃檯人員資料，開啟 RLS 並撤銷 anon／authenticated 直接存取。沿用既有 Edge 伺服器與 service-role-only RPC 模式，不將 service role 放到前端。
- 最少欄位：id、tenant_id、login_channel_id、line_user_id、display_name、status、permission_mode、version、access_revoked_before、requested_at、reviewed_at、reviewed_by、updated_at。相同商家／身分通道／sub 唯一；權限與狀態有 CHECK。
- 管理員變更走現有商家擁有者驗證與資格／租期／功能檢查。櫃檯申請及操作走專用 action namespace 與 audience 驗證，不走既有 owner-only `admin.*` 授權的例外分支。
- 每次預約讀寫檢查：商家狀態、租期、擁有者資格、預約授權、人員狀態、目前權限、身分通道與 token 有效性／撤銷時間。前端提交的 role、actor、schema、recipient 或 permission 一律不能成為授權來源。
- 狀態寫入必須在同一 DB 交易內鎖定商家授權與人員列，再檢查並條件更新預約。撤權與審核操作因此有明確先後順序；不能只在 Edge 查一次再另行寫入。
- 原管理員更新與櫃檯更新競爭時，預約版本／狀態條件必須使其中一方成功，另一方得到明確 conflict。無條件覆寫禁止。
- 記錄操作者為櫃檯，保留確認／拒絕者及時間；沿用並擴充既有稽核，不偽裝商家擁有者，也不新增相同內容的第二套稽核系統。
- 既有尚未審核取消申請、已確認／完成／拒絕／取消預約不得由櫃檯錯誤轉移。拒絕所需的預留／票券釋放及會員通知沿用既有交易規則。
- 寫入 request ID 與 payload 必須綁定商家、已驗證人員、操作與預約；同一合法重送返回已套用結果，不重複寫入或通知。不同 payload 不得共用同一 request ID。

## 6. LINE 與通知設計

櫃檯設定包含 Login Channel ID、LIFF ID、Messaging Channel ID、加密保存的 access token／channel secret，以及伺服器確認的 OA 基本資料；一般回應與日誌不含秘密。

新增獨立 `frontdesk` 通知用途。沿用現有儲存、驗證、加密與測試操作，不另造憑證庫。櫃檯設定只允許獨立已驗證通道或關閉；未設定／損壞時不得回落到管理員或會員 token。

Login 與 Messaging Channel 必須正確綁定、位於相容的 Provider，不能用 bot/info 或 token 驗證成功推定兩者已綁定。啟用前以可信設定證據及已登入測試者的 OA／好友檢查驗證；缺少證據時保持未就緒，不假裝可以收通知。開發站不得修改正式 LINE 設定。

通知沿用會員事件原本通知管理端的事件範圍與資訊格式，包括建立、變更與取消申請等現有管理端通知；櫃檯不因自己確認／拒絕而再次收到新預約通知。新增事件時直接對當時符合資格的人員建立唯一 frontdesk outbox row，不依賴先有 admin 收件人，也不按管理員數量複製。

既有 outbox 需擴充通道約束、claim、delivery guard、token 選擇、Flex 入口及 dispatch 醒送條件。領取與實際送出前均重新確認人員／商家可通知狀態；停用或撤銷功能的待送列標為 skipped 並留原因。任何已經送到 LINE 的訊息無法收回，但其操作連結始終以目前權限決定。

僅核准且符合目前通知狀態的人員收件；通知重試使用穩定 UUID，沿用 bounded concurrency 與既有 cron recovery，不新增輪詢排程或固定 sleep。單一收件人失敗不能讓已提交的會員預約變成失敗，也不能阻斷其他通道。

LINE API 回傳 accepted 只代表 LINE 受理，不代表使用者實際收到；真實驗收須核可測試者在 LINE 中實際確認。封鎖／未加好友與通道設定錯誤須有對應診斷，不將 HTTP 200 當作已讀或送達證據。

## 7. 相容性與影響矩陣

| 路徑／模組 | 影響 | 必須保留的原契約 |
|---|---|---|
| `admin/business-line-settings.*`、管理頁掛載 | 櫃檯設定與人員管理入口 | 既有 LINE 共用登入、功能 grants、儲存冪等與秘密遮罩 |
| 新 `frontdesk/` 頁與專用 Edge handler | 申請、本人狀態、受限待審預約與操作 | 不載入完整管理端，不讀取額外會員／點數／票券資料 |
| `_shared/business-runtime.ts`、`business-policy.mjs` | 明確櫃檯 action 路由、商家與功能限制 | 既有管理員 owner-only 與會員 audience 不放寬 |
| 平台商家設定 RPC／通知憑證／Webhook 綁定 | 設定入口、秘密及必要的可信 OA 狀態 | 不覆寫 admin／member 路線；通道歸屬不能跨商家混用 |
| `booking-line-notifications/*`、`notice_outbox` | 第三通道、收件人與連結 | 原管理員／會員通知內容、retry key、租約與失敗分類 |
| 預約狀態、資料庫遷移與既有商家 runtime | 櫃檯交易授權、狀態與稽核 | 原預約／多人預約／取消申請／預留釋放不變；既有與新建商家均生效 |
| CI、Edge 部署清單與靜態建置 | 納入新測試／頁面／函式 | 完整基線、不復活退役 API，不自動切至正式環境 |

## 8. 驗收與可執行測試規劃

以下為計畫，均尚未宣稱通過。新增測試檔名為擬定名稱，實作計畫可依現有測試編排調整，不得削減涵蓋範圍。

| AC | Given／When／Then | 案例／層級 |
|---|---|---|
| AC-001 | Given 已開通預約的商家管理員，When 儲存櫃檯 LINE 設定，Then 產生該商家專屬入口且原管理員／會員設定不變 | frontdesk settings：API／DOM／SQL |
| AC-002 | Given 錯誤 audience、過期 token 或未登入，When 申請／讀取／操作，Then 拒絕且不新增授權 | auth：Edge／安全負向 |
| AC-003 | Given 合法櫃檯身分，When 首次與重複申請，Then 僅一筆待審資料且沒有自行核准 | application：SQL／併發 |
| AC-004 | Given 待審人員，When 本商家管理員核准為僅收通知，Then 開始接收後續事件且預約 API 拒絕操作 | notify-only：API／SQL／瀏覽器 |
| AC-005 | Given 可審核櫃檯，When 處理本商家 pending 預約，Then 可確認或拒絕並記錄真實操作者，原會員通知依規則產生 | review：API／SQL／瀏覽器 |
| AC-006 | Given 其他商家管理員或櫃檯，When 更換 business／bookingId／staffId，Then 不讀寫外商家資料 | tenant isolation：SQL／安全負向 |
| AC-007 | Given 僅收通知或未核准人員，When 偽造 role／permission 或呼叫 admin API，Then 無法升權且資料不變 | privilege escalation：Edge／SQL |
| AC-008 | Given review 降為 notify_only，When 使用舊通知／舊頁面確認或拒絕，Then 立即由後端拒絕；仍接收新通知 | downgrade：SQL／瀏覽器 |
| AC-009 | Given 人員停用、商家停用／過期、owner 資格撤銷或 booking grant 撤銷，When 查詢、寫入或排程送訊，Then 拒絕／跳過且無新增副作用 | revocation：SQL／Edge／dispatch |
| AC-010 | Given 同預約兩名人員或管理員＋櫃檯同時處理，When 分別確認／拒絕，Then 只有一個合法結果、一次相應通知及一致稽核 | race：真實 PostgreSQL 併發 |
| AC-011 | Given 同 request ID 重送與 ID 對應不同 payload，When 執行，Then 前者返回同結果，後者 conflict；無重複通知 | idempotency：SQL／API |
| AC-012 | Given 非 pending 預約或待審取消申請，When 櫃檯確認／拒絕，Then 拒絕並保留預留與狀態 | transitions：SQL／回歸 |
| AC-013 | Given 會員建立／變更／提出取消等管理端事件，When outbox 入列，Then 所有且僅當時核准櫃檯收一次相同資訊；不依賴 admin 人數 | notification events：SQL／integration |
| AC-014 | Given frontdesk 憑證缺少、無效或關閉，When dispatch，Then 不使用其他用途 token，既有管理員／會員通知仍正常 | routing failure：Edge／回歸 |
| AC-015 | Given LINE 故障、逾時、重試及 finish 失敗，When 重送，Then retry UUID 固定、租約正確且會員預約不回退 | delivery：stub／Edge／SQL |
| AC-016 | Given 已入列但送出前人員停用，When claim／send guard，Then 當前未送列 skipped；舊訊息不能再操作 | queued revocation：SQL／Edge |
| AC-017 | Given 僅收通知與 review 權限，When 產生 Flex 與開啟入口，Then 前者無操作按鈕，後者開啟正確商家頁；連結本身不改狀態 | flex：單元／瀏覽器 |
| AC-018 | Given 既有商家與全新商家，When 遷移與開通，Then 新表／RPC／outbox 契約一致，舊資料及通知不被改寫 | migration／provisioning／回復 |
| AC-019 | Given mobile／desktop、深色模式、鍵盤操作與慢連線，When 申請與處理，Then 狀態清楚、按鈕可辨識、不重複提交；舊回應不覆蓋新身分 | Chromium／DOM／失敗恢復 |
| AC-020 | Given 真實核可測試 OA、測試櫃檯及合成預約，When 全流程執行，Then 實際收件可確認，review 成功、notify_only 拒絕；stub 不替代此外部證據 | LINE 沙盒／測試 Supabase／人工收件證據 |
| AC-021 | Given 最終交付 SHA，When 全專案既定 CI、建置與開發部署完成，Then run／Edge／migration／Netlify deploy ID 與 smoke 同版可核對 | 完整基線／部署驗收 |

實作後執行入口：

```sh
node scripts/runtime-quality.mjs --base 45978b9b8a0d393297d14f739cbbbd3a0c47bc88
node --test MemberWebsocket-dev/tests/*.test.js
node --test MemberWebsocket-dev/tests/integration/frontdesk_*.cjs
npm test --prefix MemberWebsocket-dev/tests/browser -- frontdesk-booking.spec.cjs
node scripts/build-site.mjs
```

新增 Deno／真實 PostgreSQL 案例需納入既有 CI matrix 並使用 workflow 指定的 disposable PostgreSQL，不對線上會員資料跑破壞測試。完整基線為 `.github/workflows/test-memberwebsocket-dev.yml` 所有必要 jobs，加上 Netlify build 與適用 Ticket Policy CI；不是只執行上述局部命令。

## 9. 品質、效能、部署與回復

實作前量測固定合成 fixture 下的原預約 API 請求數、入列耗時及 dispatcher 查詢／LINE 呼叫數；候選版在相同資料與環境比較。既有管理員／會員事件不得因 staff 數量產生重複通知；新增對核准 staff 的獨立發送屬需求成本，另列人數與 API 次數。沒有前後實測不得宣稱提速。

優先使用單一進行中請求、明確狀態、既有事件與 outbox；不新增固定 sleep、輪詢、框架、依賴、通用 RBAC 或重複預約系統。所有取消、重入、切換商家／身分、失敗與停止後資源釋放均列案例。

確認設計後先產出實作計畫，分成資料與交易授權、LINE 路由、櫃檯／管理端 UI、完整測試及部署的小步提交。PR 目標只用 Integrated-Marketing-Platform；未取得全部適用驗收與完整 CI，不合併或部署功能。正式環境另需明確授權。

遷移採新增與向後相容方式；既有商家套用與新商家 provisioning contract 必須同時補齊，不修改已發佈歷史 migration。將實際 Edge 函式及相依檔明列，禁止 blanket deploy。LINE 設定缺少或尚無核可測試接收者時，標記外部驗收受阻，不聲稱通知已可用。

回復：關閉 frontdesk 通知路線並停用櫃檯入口，保留已寫入稽核與人員資料；必要時以 revert commit 走原 CI 修正前進部署。已合法確認／拒絕的預約不可因功能回復而自動反轉。保留舊版管理員／會員路線相容性，不刪除線上資料。

## 10. 文件與證據來源

- LINE Login Provider／Channel 身分規則：https://developers.line.biz/en/docs/line-login/getting-started/
- LINE push 條件與受理／實際送達差異：https://developers.line.biz/en/reference/messaging-api/#send-push-message
- Supabase RLS：https://supabase.com/docs/guides/database/postgres/row-level-security
- 基準完整 CI：https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/actions/runs/44284825602
- 基準 Netlify build：https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/actions/runs/44284825692
- 基準 Ticket Policy：https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/actions/runs/44284825580
- 基準 Preview：https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/actions/runs/44284825700

本文件是待確認設計，不是已實作或已驗證完成的功能報告。

## 11. 本輪盤點與文件檢查紀錄

本輪只新增本設計文件，產品程式、資料庫、LINE 設定與部署皆未變更；因此不存在可驗收的櫃檯候選功能版本。執行期效能前後比較不適用於本輪文件，實作時仍必須執行第 9 節計畫。

| 檢查 | 實際結果 | 證據／說明 |
|---|---|---|
| 基準應用 Node 回歸 | exit 0；1,567 pass、0 fail、0 skip | `node --test --test-reporter=tap MemberWebsocket-dev/tests/*.test.js`；工作區 `evidence/baseline-node.tap` |
| runtime-quality | exit 0；新增／變更 timer 0、未說明 0 | `node scripts/runtime-quality.mjs --base 45978b9b8a0d393297d14f739cbbbd3a0c47bc88` |
| 治理與品質檢查測試 | exit 0；14 pass、0 fail、0 skip | `TMPDIR=<workspace>/tmp node --test scripts/governance-workflow.test.mjs scripts/runtime-quality.test.mjs`；`evidence/design-governance-workspace-temp.tap`。第一次因沙箱無可用 `/tmp` 失敗；指定工作區暫存位置後原測試不變並通過 |
| 測試資料庫盤點 | 唯讀查詢成功 | 查詢 information_schema 與 pg_proc，確認目前通知用途、商家結構及相關 RPC；沒有資料寫入 |
| 設計獨立檢視 | 未提出重大未解問題 | 僅檢視設計的身分、權限、資料與範圍；不是功能或安全測試通過 |
| 櫃檯專屬 AC-001～021 | 未執行 | 功能尚未實作，不能計為 pass |
| 新功能完整 CI／DB／Chromium／真實 LINE／部署 | 未執行 | 設計待確認；基準 CI success 不能替代新功能同版驗收 |
