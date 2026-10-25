# Integrated Marketing Platform｜第一性原理開發、相容性與回歸驗收規範

**適用範圍：** `memberwebsocket-dev-netlify`、GitHub [Project #5](https://github.com/users/yongshengchen0615/projects/5) 工作卡、由該 repository 交付的 Platform / Admin / Member / Booking / LINE / Points / Tickets / Storage / Supabase / Netlify。  
**原則：** 保護既有行為 > 最小修改 > 擴展功能；嚴禁為通過測試而放寬安全或移除有效驗收。本文件不取代現有業務需求，遇到衝突先用既有契約、實際程式及使用者確認的規則釐清。

## 1. 一次改動必須交付什麼

| 第一性原理項目 | 問題 | 強制產物 |
|---|---|---|
| 目標 | 哪個角色要完成什麼行為？ | 可觀察的完成條件、明確排除範圍 |
| 身分 | LINE/session/憑證如何辨識使用者？ | 身分來源、登入／登出／撤銷路徑 |
| 權限與歸屬 | 哪位管理員／會員對哪個商家／資源有權限？ | 伺服器端授權矩陣與拒絕案例 |
| 狀態 | 申請、核准、停權、預約、票券等如何轉移？ | 合法／非法狀態轉移及撤銷條件 |
| 資料 | 哪些交易、唯一性、冪等性必須守恆？ | 不變條件、遷移相容與回復方案 |
| 限制 | 現有程式與外部系統有哪些不可改的契約？ | 實際讀取的程式路徑、依賴、環境差異 |
| 驗收 | 怎麼證明原流程依然正確？ | AC-001 起的 Given/When/Then、測試映射 |
| 失敗 | 越權、重複請求、併發、逾時、重連會發生什麼？ | 負向測試和可觀察的資料結果 |

大幅重構需比較「最小修復」與「架構替換」的可驗證性、風險、回復成本、相容性；先證明替換必要才採用。尚無充分證據時，不得把猜測寫成根因或已修復。

## 2. 工作開始的必備盤點

- 讀取指定工作卡、相依 Issues、實際運作的 HTML/CSS/JS、Edge Functions、SQL migrations、相關 tests、workflow、Netlify 設定與既有 PR；不依主觀印象推定現有功能。
- 記錄 `base branch`、`target branch`、基線 SHA、變更檔案清單、既有失敗與環境限制。整合工作以 `Integrated-Marketing-Platform` 的當下 HEAD 為準，不假設 `main`／`develop` 同步。
- 修缺陷先以測試固定「改前會失敗」的情境（RED）；若舊版已失敗，明確列為既存缺陷，不把它歸咎於本次改動，也不以此免除回歸責任。
- 對跨模組變更建立 contract map：入口頁面 → 前端事件 → Edge/RPC → transaction/outbox → RLS → 通知／同步。單純畫面正常不能當後端正確。

## 3. 既有功能保護矩陣（最低驗收，不得縮減已存在案例）

| 領域 | 不變條件／檢查重點 | 優先對應既有測試或工作卡 |
|---|---|---|
| 三端啟用、功能授權 | 一般管理員申請後只能等核准；總管理員開通模組即解鎖獲准功能；一般管理員不可誤進平台，會員看不到他店資料 | #34、#41、#49；`product_platform.cjs`、`product-platform.spec.cjs` |
| 停權／權限／工作階段 | 後端拒絕未登入、跨商家、降權舊憑證；角色改變不可由客戶端自改 | #34、#41；Edge/SQL 權限整合與負向測試 |
| 預約／通知路由 | 會員預約 → 管理端 LINE；管理端確認、修改 → 會員 LINE；多參與者、改期、取消與重送冪等 | #31、#36、#43、#52；`notification_routes.cjs`、`booking_notification_events.cjs`、`delivery_test.ts` |
| 點數、票券、活動 | 0 可用點數禁止轉贈，預約點數與可用點數區分；同票券足額多預約／預留釋放／核銷守恆；商家間隔離 | #42、#50、#51；`tests/*.test.js`、`ticket-selection.spec.cjs` |
| 日期、會員階級、活動 | 有效期、時間、階級、GPS、優惠券／日曆仍按既有條件判定 | #50、#45；相關 Event/Calendar/Browser tests |
| 快照／收據／安全上傳 | 已簽署上傳路徑與資料歸屬正確；跨商家拒絕；失敗、重整、歷史資料可恢復 | #37；`receipt_refresh_state.cjs`、receipt/browser 測試 |
| DB / Tenant / 同步 | schema 遷移保留舊資料；唯一性、交易與 RLS 無退化；離線／重連／同步不造成越權或重複 | #35、#44、#48、#53；PostgreSQL 17／SQL fixture |
| 版本與部署 | 客戶端、Supabase Function、DB migration 與 Netlify 同一候選版本相容；Preview 與 Production 分開驗證 | #33、#40、#47；build、publish gate、Smoke |

這些測試名稱是**既有查核入口的例子**；實作前應再查其內容、路徑及實際覆蓋，不能假設該檔名已完整驗證某項不變條件。

## 4. 依修改類型擴展的測試影響矩陣

- **HTML/CSS/JS**：影響頁面 + 相鄰頁面 DOM/鍵盤/手機 Chrome 回歸，相關登入、未授權與瀏覽器核心旅程；修改共享元件時覆蓋所有消費端。
- **Edge/API/授權**：身分驗證、同角色／跨角色、跨商家 A/B、過期／撤權憑證、回應資料不洩漏、CORS、防重放、錯誤回應與重試；再跑受影響端到端流程。
- **SQL/Schema/RPC/RLS**：空 DB、既有資料升級、交易 rollback、唯一性／併發／跨商家、migration 完整性和可逆回復演練；使用隔離 PostgreSQL/測試 Supabase，不對正式會員資料做破壞性測試。
- **LINE/通知/排程**：管理員與會員收件者分流、事件只觸發預期通知、outbox 冪等、錯誤重試與服務故障；Stub 測試不等於真人 Provider 沙盒驗收。
- **Netlify/部署/設定**：建置輸出、路由與資產、commit SHA 對應、未登入 401、跨角色 403、精確 allowlist、預覽 Smoke；沒有受權不得調整正式環境。
- **文件或 PR 模板**：檢查規範與路徑實際一致，跑文件影響檢查；變更 CI／workflow 規則必須以 PR 驗證實際 workflow，維持全部必要工作不被弱化。此類變更不等於原功能已重新通過。

## 4.1 每次開發必做：程式碼品質與效能

此規則適用新功能、缺陷修復、效能調整、重構、前端／Edge／SQL／設定變更，沿用現有模組而不強制全專案重寫。**每次必須評估、在修改範圍內優先做安全的改善；不能要求每個 PR 都憑空增加速度。**

| 品質檢查 | 最低證據 | 不可接受 |
|---|---|---|
| 可維護性 | 指出本次修改觸及的重複邏輯、錯誤處理、模組耦合、無效查詢等；記錄已做的局部改善或沒有合理改善空間的依據 | 無關大重構、改弱檢查或改變既有業務 |
| 功能與相容性 | 變更檔 → 既有功能回歸案例、相鄰模組、安全負向、交易結果 | 只測新頁面就宣稱所有舊功能正常 |
| 效能前後比較 | 記錄基準 SHA、候選 SHA、測量工具與同一量測條件，附原始數據、差異、重複樣本／噪音及結論 | 單次測試、不同資料量／硬體直接比較、沒有數據宣稱提速 |
| 無 runtime 影響 | 具體說明為何不適用前端／API／SQL benchmark，提供文件、CI 或設定的對應驗證 | 虛構 p95、把未量測填成通過 |

**同一量測條件**至少固定執行環境、資料量、並行度與測試步驟，依模組選指標：前端首屏／互動及 JS/CSS bytes，API 呼叫數與 p50/p95，SQL query plan／執行時間，Realtime 重複刷新／流量。比較時需區分量測噪音；沒有實測不得宣稱效能提升。性能改善若造成可重現的顯著退化、安全或功能回歸，即阻擋合併與發布，先以可重現測試排除根因。

**永久不變條件**：會員與商家隔離、權限撤銷、預約狀態、點數／票券守恆、LINE 收件者與冪等、Storage 歸屬及重新登入流程不能因效能優化被改壞。測試採用既有完整 CI + 變更專屬 AC；每次最終 SHA 重跑，不能引用舊版綠燈代替。本要求配合 PR 風險／證據檢查器，治理欄位文字只能做初步篩選，必須以真實測試與人工 Review 判定正確性。

## 4.2 避免過度設計（YAGNI）

核心規則：**先選最小可驗證方案，只有現有需求與實際證據足以支持時才引入新複雜度。** 追求「足以滿足驗收、安全且容易修改」，不追求功能數量、抽象層級或架構新穎度。

| 決策點 | 優先採用 | 需要額外證據才可採用 |
|---|---|---|
| 功能開發 | 先修改現有模組、只完成本輪 AC；保留原 API/資料契約 | 不為假想需求加框架、共用平台、擴充點或跨模組設定 |
| 共用邏輯 | 重複邏輯確實存在、抽取可降低實際維護成本時才抽象化 | 只出現一次的流程就增加工廠、基底類別、泛型配置或多層包裝 |
| 效能 | 先以同條件量測確定瓶頸，優化請求量、SQL 或渲染的直接原因 | 未量測就引入快取、排程、佇列、新服務或複雜同步狀態 |
| 新依賴／資料結構 | 現有成熟組件、資料約束與工具足以解決時繼續沿用 | 無明確必要性即新增套件、資料表、欄位或遷移 |
| 架構替換 | 以小批次可回復變更為預設，沿用原測試基線 | 大重寫／拆 Repo／微服務／換框架必須證明現有做法無法滿足驗收 |

**設計決策紀錄**：一般小改只要在 PR「程式碼品質與效能」欄簡述「已評估最小方案」和採用理由；跨模組或重大架構變更須比較最小方案與替代方案，記錄當下必要性、可驗證性、維護成本、安全性、相容性及回復方式。不要新增平行設計系統或強制每張小卡撰寫長篇 ADR。

**不為假想需求新增抽象**不代表犧牲必要保護：後端授權、RLS、LINE 驗證、商家資料隔離、資料完整性、冪等、錯誤處理及足量測試仍為不可刪減的必要複雜度。

## 5. 可測試驗收條件範本

- **AC-001** Given 原會員流程與合成帳號，When 新版上線前重跑回歸，Then 原有進入、資料讀取、修改與登出結果不變，沒有未授權資料。
- **AC-002** Given 一般管理員待審核，When 進入 admin，Then 僅顯示待審狀態且不能使用未授權模組。
- **AC-003** Given 一般管理員僅獲授權模組 A，When 呼叫模組 B API，Then 後端拒絕、無資料副作用。
- **AC-004** Given 會員建立預約，When 事件送達 outbox，Then 僅指定管理端收預約通知；確認/修改由管理端觸發時僅通知對應會員；重試不重複入列。
- **AC-005** Given 可用點數 0 但存在預約點數，When 嘗試轉贈，Then 前端不可點，且後端拒絕、餘額不變。
- **AC-006** Given 點數／票券被兩請求同時消耗，When 併發送出，Then 不超額、不重複扣帳，最終帳本及預留一致。
- **AC-007** Given 會員 A 與商家 B，When 嘗試讀寫商家 A 的收據／設定／票券，Then 由伺服器拒絕且不洩漏資料。
- **AC-008** Given migration 前既有合成資料，When 執行升級、故障回復，Then 原交易資料及授權不變，不能改寫已部署遷移。
- **AC-009** Given 必要 CI 任一失敗、取消、逾時、跳過或未執行，When 評估 Release Candidate，Then 停留未完成狀態，不得部署或宣稱已通過。
- **AC-010** Given 相同 commit SHA 的所有必要檢查全通過且獲發布核准，When 發布到指定環境，Then 發布 ID、實際資產版本、受保護 API Smoke 及回復點可查證。


- **AC-011** Given 任意程式或設定改動，When 進入 Code Review，Then 留下此次觸及程式的品質檢查、可驗證局部改善或具體不適用理由，不引入無關重構。
- **AC-012** Given 修改可能影響執行效能，When 進入 QA，Then 具有基準 SHA、候選 SHA、同一量測條件、前後數據及差異解釋；沒有實測不得宣稱提升。
- **AC-013** Given 新功能已通過但任何舊功能或既有全套基線失敗／跳過／取消／未執行，When 評估發布，Then 擋下合併與部署，補測同一最終 SHA。
- **AC-014** Given 文件或治理變更無產品執行期影響，When 評估效能要求，Then 說明不適用原因且執行相應文件、治理及 workflow 測試，不能虛構 API p95。
- **AC-015** Given 任一開發 PR，When Code Review 評估設計，Then 已說明最小可驗證方案；若引入新抽象、依賴、資料表、快取或重大重構，必須有目前需求或量測證據、較小替代方案及回復方式，且既有安全和測試不得縮減。

以上 AC 為**專案共用最低契約**；每張工作卡需另寫該次變更專屬 AC，並以實際測試一一對照，不能因預設 AC 列在文件就宣稱已執行。

## 6. 執行命令與現有 CI

以下為目前已有的測試入口（於 repository 根目錄）：

```sh
# Node 行為與回歸
node --test MemberWebsocket-dev/tests/*.test.js

# 靜態站點建置／部署契約
node --test scripts/deploy.test.mjs scripts/netlify-publish-workflow.test.mjs
node scripts/build-site.mjs

# DOM / PostgreSQL / Browser 測試套件依賴
npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/integration
npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/browser

# Chromium E2E（先依既有 workflow 安裝 Playwright browser 與系統依賴）
npm test --prefix MemberWebsocket-dev/tests/browser

# Edge Function：依 CI 列出的入口執行 deno check，及以下測試
deno test MemberWebsocket-dev/supabase/functions/_shared/*_test.ts MemberWebsocket-dev/supabase/functions/booking-line-notifications/delivery_test.ts
```

- **完整基線的權威來源**：`.github/workflows/test-memberwebsocket-dev.yml` 的 regression、integration、browser-e2e、browser-syntax、postgres-integration、edge-functions、wiring、dependency-audit、validate 全部成功，且 `.github/workflows/test-netlify-build.yml` 與適用的 ticket-policy CI 成功。
- 此外若該卡涉及真實外部服務、DB migration、LIVE 授權測試、發布，還須取得相應沙盒或線上**非破壞性**驗收；單元測試不得代替。
- 某項環境無法提供時標記 **Blocked/未執行**，保留理由、待補證據與負責人；不得將 0 tests、skip 或 only mocks 記為 pass。
- 每個失敗案例先分析原因、最小修復並重測該案例；最終修改完成後**重新跑本版全部必要測試**。

**歷史 CI 失敗紀錄（非目前狀態）：** [#40](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/issues/40) 於 2026-10-21 記錄 Chromium `PLATFORM_APPLY` 導覽逾時；2026-10-22 的 PR #84 合併版本已留下分片 Chromium、全套 CI 與 Preview 成功證據。不可將任何舊失敗或舊成功直接套用至新的提交；任何測試異常必須保留實際證據，不能藉增加 retry、略過案例或降低發布門檻掩飾。

## 7. PR 合併與上線閘門

1. 每個 PR 都必須填寫 [PR 範本](../.github/PULL_REQUEST_TEMPLATE.md)：連結 Issue、改前/改後、差異清單、受影響原功能、AC、測試矩陣、實際結果、未執行項與回復方式。
2. Reviewer 必須看 diff 與 API／SQL／授權後果；高風險修改應由熟悉模組及資料界線者審核。禁止直接以改弱測試、略過必要 job、降低 lint 門檻來換綠燈。
3. 合併前確認同一 HEAD SHA 的完整既有 CI 及驗收結果；新提交後舊測試證據作廢。取消、逾時、失敗、未觸發都不是 success。
4. GitHub Branch Protection / Ruleset 應對 `Integrated-Marketing-Platform`、未來正式發布分支設定必需 PR、審查及必要的驗證 Checks；**目前若尚未套用 Ruleset，僅靠文件／範本不能阻止 direct push，需管理員另行啟用並以實際設定驗證**。
5. 進 Preview 前核對指定 SHA 全綠；進 Production 前再檢查權限、安全、資料備份、migration 相容與授權，保留 Netlify deploy ID / Edge 版本 / DB migration 記錄；部署後驗證真實路由與關鍵 API。
6. 發布失敗時回到最後一個已驗證版本；資料庫採事先評估的恢復路徑，不直接反向重跑不安全 SQL 或刪除資料。

## 8. Project #5 Status 的證據規則

`待規劃 → 準備開始 → 開發中 → 程式碼審查 → QA / E2E → 等待部署 → 觀察中 → 已完成`；`已阻塞` 為未完成工作可進入的獨立狀態。這些是 Project #5 實際 Status 選項，不能把英文舊名稱當成可寫入的欄位值。詳細進出條件依 [#39](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/issues/39)。PR 合併不等於 QA；Preview deployed 不等於 Production deployed；沒有實測就不標已完成。

**固定交付報告**：本輪結果（已驗證完成／驗證失敗／部分完成且受阻） → 第一性原理摘要 → 變更檔案與影響 → AC 對照 → 測試報告（命令、環境、SHA、時間、pass/fail/skip、CI/log URL） → 已知問題 → 執行／回復 → 下一步。只填實際取得的證據。
