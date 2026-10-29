# 會員系統專用 E2E 外掛與隔離環境設計草案

日期：2026-10-29（Asia/Taipei）

狀態：**待設計核准與非零資源費用同意；不是實作完成或上線證明。**

## 1. 目的與第一性原理

讓維護者從 ChatGPT／Codex 呼叫本專案專用外掛，檢查測試環境、執行既有完整基線與新增真實環境 E2E、定位失敗、取得可追溯證據。測試使用獨立 Git 分支、Netlify site、Supabase 環境與合成資料。

| 面向 | 本輪設計 |
|---|---|
| 目標 | 可重複執行會員／管理員／總管理員的適用旅程，報告實際資料結果與版本 |
| 身分 | 外掛沿用已連接 GitHub／Netlify／Supabase；產品繼續使用既有 LINE 與伺服器工作階段驗證 |
| 權限 | 只有專用 E2E 環境可 seed／cleanup／寫入；正式與現行整合環境拒絕測試寫入 |
| 狀態 | preflight → baseline → deploy → identity-check → seed → test → evidence → cleanup；任何必要階段失敗即不放行 |
| 資料 | 合成商家 A/B、會員 A/B、待審／已啟用／停權角色；run ID 與資源歸屬綁定；不複製真實會員與 LINE 金鑰 |
| 限制 | 現有前端固定 DB URL、缺少部分初始 migration 原始檔、真實 LINE 測試身分與 CI 管理憑證尚未確認 |
| 驗收 | 見 AC-001 至 AC-012；skipped／blocked／0 cases 不計通過 |
| 失敗 | 錯環境、過期憑證、跨商家、併發、斷線、部分部署、清理失敗、證據洩漏均需明確拒絕或保留阻塞 |

核心不變條件：

- 任何 E2E 寫入、清理及部署不能以 `dbuquirnaskrwcamdxki` 或現有 Netlify site 為目標。
- 會員 A／商家 A 不得讀寫會員 B／商家 B 的私人資料。
- 測試不能新增正式可用的登入後門、跳過後端驗證、放寬 RLS 或重開已移除的管理端測試中心。
- 重送與併發不得造成超額扣點、重複核銷、錯誤通知或資料錯置。
- 部署的前端、Edge、migration、實際測試與報告必須可對帳至同一候選版本；舊版成功不代表新版已通過。

## 2. 已確認事實與證據

來源 repository：`yongshengchen0615/memberwebsocket-dev-netlify`。

來源分支：`Integrated-Marketing-Platform`。盤點 SHA：`82cd1e60d90b114cbac75ec106a4662dc3c0f9d2`。

1. `AGENTS.md` 與 `docs/DEVELOPMENT_GUARDRAILS.md` 要求保留完整 CI、後端授權、跨商家隔離與精確版本證據。
2. `MemberWebsocket-dev/tests/browser/package.json` 固定 Playwright `1.56.1`；既有 Chromium 測試已有 JUnit、HTML、失敗截圖／影片／trace。
3. `product-platform.spec.cjs` 使用真實頁面與處理器，但以 fixture 和攔截請求替代認證及持久化。不可將其描述為真實 Supabase／LINE 全鏈路成功。
4. `preview-smoke.test.cjs` 刻意阻擋跨來源及非 GET/HEAD；屬線上唯讀冒煙，不能代替寫入旅程。
5. `MemberWebsocket-dev/config.json` 固定連向 `dbuquirnaskrwcamdxki`；只新增 Git 分支或 Netlify 網址不會隔離資料。
6. `scripts/preview-member-runtime.mjs` 只對整合分支改用 preview function；沒有新 E2E 環境注入契約。
7. `scripts/build-site.mjs` 明確排除已退役管理端測試中心資產；本需求不改此決策。
8. 連接的 Supabase 組織為 `nwesgkhckmpapprltpoq`，Pro；目前列出兩個 project，會員專案無 development branch。
9. 現行 Supabase 有 315 筆 migration 紀錄，repository 有 283 個 migration 檔，含 `native_membership` 等早期初始化來源未見於 repo；不能假設從 repo 的 migrations 目錄直接重播即可還原完整空資料庫。兩邊命名格式不同，數量差不等於已逐一確認少了 32 個 migration。
10. Netlify 現有 site ID 為 `196e1d2c-8216-4ba8-aeb9-1706660adc2b`，team slug 為 `yongshengchen0615`；E2E 必須新建 site。

盤點時遠端同 SHA 證據（本輪讀取既有結果，未重跑）：

| 工作流程 | 結果 | 證據 |
|---|---|---|
| 完整產品 CI | success；包含 3 個 Chromium shard 與 aggregate validate | https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/actions/runs/40837932633 |
| Netlify build | success | https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/actions/runs/40837932743 |
| Ticket Policy | success | https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/actions/runs/40837932640 |
| Preview 發布驗證 | success | https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/actions/runs/40837925810 |

本輪本機 Node `v24.22.1` 實跑基線：

- `node --test --test-reporter=junit --test-reporter-destination=evidence/e2e-baseline-regression.xml MemberWebsocket-dev/tests/*.test.js`：exit 0，Node runner 摘要 1,154 pass、0 fail、0 skip；4,486.237412 ms。JUnit 為 1,153 個 testcase 與一個含子測試的父 testsuite，並非遺失或跳過案例。
- `node scripts/build-site.mjs`：exit 0，靜態建置成功。
- 本機 `node --test scripts/*.test.mjs` 首跑 137 項，117 pass／20 fail／0 skip，exit 1。20 個失敗均在 `mkdtemp('/tmp/...')` 產生 ENOENT，尚未進入相關斷言；此環境沒有可用 `/tmp`。以 workspace 內 TMPDIR 重跑的結果另記，保留首跑證據，不改弱測試。
- `TMPDIR="$PWD/evidence/tmp" node --test --test-reporter=junit --test-reporter-destination=evidence/e2e-baseline-tooling-workspace-tmp.xml scripts/*.test.mjs`：exit 0，137 pass／0 fail／0 skip；24,128.215604 ms。只變更執行環境暫存位置，未修改 repository 的程式、設定或測試。
- 本輪沒有重新執行本機 Chromium／PostgreSQL／Edge／dependency audit；以上遠端結果只適用盤點 SHA，不能當新增外掛版本的測試。

## 3. 方案比較與工作假設

### 外掛形式

| 方案 | 可驗證性／安全性 | 維護與相容性 | 決策 |
|---|---|---|---|
| 私有專案操作外掛：技能＋參考資料，協調既有 GitHub Actions | 可查驗實際 CI／部署／artifact；不新增持有管理金鑰的伺服器 | 最大程度沿用現有 Playwright／CI | 建議；未收到選擇回覆，作為草案工作假設，尚非使用者已核准 |
| 獨立雲端 MCP＋報告介面 | 可提供對話內直接操作，但需新認證、服務與權限管理 | 額外 hosting、工具與報告儲存維護 | 本版不採用；若使用者指定此操作方式，需改設計 |

第一版是具有專案規則與實際執行流程的私有外掛，不會把文字說明宣稱為已實作的 MCP 工具。外掛執行仰賴現有連接或受權 CLI；工具缺少 workflow dispatch 能力時，報告具體阻塞或使用已受權的 GitHub Actions 網頁操作，不宣稱已觸發。

### Supabase 環境

| 方案 | 成本盤點 | 取捨 |
|---|---|---|
| 現行 project 的 data-less E2E branch | 工具報價每小時 USD 0.01344；720 小時約 USD 9.68，另計其他用量 | 有獨立 URL／金鑰，避免匯入會員資料；需驗證 migration 完整性與持久性 |
| 全新獨立 E2E project | 工具報價 USD 10／月，另計實際用量與方案規則 | 生命週期更獨立，但需可靠且去秘密化的 schema bootstrap；目前初始 migration 缺件 |
| 只用目前 project 的測試帳號 | 無新增 compute 環境費用，但與現行資料共用 | 不符合本需求的隔離目標，不採用 |

建議先用 data-less branch，命名 `e2e`，目標為長期環境；建立後須讀回確認 project ref、獨立 credentials 與 persistence。現有 MCP create_branch 不暴露 persistent 選項；需用受權 CLI／提供者設定將其設為 persistent 並驗證。若無法做到，標記受阻，不把 ephemeral branch 宣稱為永久專用環境，也不自行改建另一個付費 project。

費用依 2026-10-29 盤點；資源建立前重新核實並走提供者費用同意。Supabase 官方 pricing： https://supabase.com/docs/guides/platform/manage-your-usage/branching 。額外流量、Storage 與其他項目不包含於 compute 估算。Netlify／GitHub Actions 的實際用量也需追蹤，不能保證額外用量皆免費。

## 4. 預設交付範圍

1. GitHub `e2e` 長期測試分支，從當時已核實的整合分支 SHA 建立；產品修改仍透過 PR。測試分支不自動回併正式／整合環境。
2. 全新 Netlify site，建議名稱 `memberwebsocket-e2e`；以實際建立回傳 ID／URL 為準，不復用目前 site、不改目前網址。
3. Supabase `e2e` data-less branch，有獨立 URL／publishable key／server credentials／Storage／Realtime／Edge。
4. 私有 `member-system-e2e` 外掛，可支援「檢查環境」、「執行完整 E2E」、「針對失敗重現」、「查看版本與證據」四種工作。
5. 新增一條隔離環境 pipeline，保留既有完整 CI；桌機與手機 Chromium、後端資料讀回、安全負向、清理結果納入證據。
6. 實際 LINE 授權與真實訊息驗收獨立列出；缺少專用 LINE 帳號／Channel／LIFF 或有效登入憑證時標記 Blocked。

不包含：重新增加管理工作台測試中心、改寫會員／點數／預約業務、正式資料重設、升級產品框架、公開發布外掛、另建 MCP 伺服器或通用測試 SaaS。

### 第一版 live lane 的固定案例範圍

以下是本草案採用的工程決策，尚非使用者另行承諾的需求；它補上「適用旅程」的具體範圍。保留全部既有 browser specs，不要求把每個 fixture 斷言逐項改寫成 live；新增 live lane 必須逐項驗證下列跨層契約。

| 案例群組 | 第一版必要旅程／最終結果 |
|---|---|
| LIVE-IDENTITY | 訪客受保護 API 拒絕；有效會員資料讀改與登出；停權／降權後舊憑證按既有規則失效 |
| LIVE-MEMBERSHIP | 新合成會員依既有入會門檻加入、條款同意、個資修改、重新讀取；另一會員不能讀改 |
| LIVE-PLATFORM | 一般管理員申請→總管理員即時看到→核准→指定功能可用；未授權功能拒絕；撤權後舊頁面不能操作 |
| LIVE-POINTS-TICKETS | 發放／領取／點數轉贈／票券預留與核銷；零點數、重送、同時消耗時帳本與預留守恆 |
| LIVE-CALENDAR-BOOKING | 營運日曆限制影響可預約時段；會員預約→管理員確認／修改→取消；多人／併發／爽約限制按既有規則 |
| LIVE-FRIENDS-NOTIFY | 合成好友邀請與 webhook 重送冪等；通知 outbox 對象、內容邊界與重試一致；自動 lane 不向真實帳號 push |
| LIVE-STORAGE | 合成收據上傳、讀取、重整／歷史恢復；跨商家簽署 URL 與資源讀寫被拒絕 |
| LIVE-RECOVERY | 雙端 Realtime、離線／重連、回應遺失重送與設定更新；資料結果一致，無重複訂閱或交易 |

只測試專用合成商家已啟用的上述模組；每個模組至少涵蓋成功、錯誤與邊界。刪除功能不重新啟用。缺角色／外部設定的必要案例保留在 manifest 並列 Blocked，不用條件 skip 讓 aggregate 變綠。

### LINE 登入的操作假設

第一版採「人工準備專用 LINE 測試登入，再自動跑產品旅程」，**不承諾無人值守完成 LINE 真人授權**。已登入旅程使用專用測試身分取得的有效短期憑證，仍由產品後端驗證；憑證只存在受權 runner 的暫存／secret，不入 repo 或 artifacts。過期時由操作員重新登入後執行，不能增加重試掩蓋認證失敗。

真實 LINE 登入、加入官方帳號好友及實際訊息送達是另列的外部驗收；必須用專用 Channel／LIFF／測試帳號人工或核可方式驗證。只有 API 已登入流程成功，不可宣稱 LINE 登入旅程已測通。若日後要求完全無人值守，需要另行設計 provider 身分介面與憑證生命週期。

## 5. 執行與信任邊界

### 預檢與 build

- 維護一份不含秘密的 E2E identity manifest：repository、精確 branch、Netlify site ID／origin、Supabase project ref、環境標記、schema／Edge／seed 版本。
- 初次佈建時先檢查新資源為空／隔離，再寫入環境標記；後續每次寫入前同時核對提供者 metadata 與資料庫標記。不能只信任環境變數 `E2E=true`。
- build 只在 E2E pipeline 對產物注入專用 URL／publishable key／functions URL；不修改 repository 的正式預設 `config.json`。
- 驗證所有前端 URL 與 runtime function 衍生 URL。含任何現行 project ref、目前 Netlify site 或正式 LINE LIFF 即擋下 E2E 發布。
- service_role、DB 密碼、LINE token、platform encryption key 只放 server／GitHub E2E environment secrets，不能進 dist、plugin、trace 或 repo。
- E2E site 採與原發布分離的明確目標；測試可使用 pinned immutable deploy URL，報告保存實際 deploy ID 與完整 SHA。

### schema／functions／外部副作用

- 先確認 data-less branch 建立與 migrations 是否成功；比對必要 schemas、RPC、RLS、extensions、Storage 及 migrations。
- 若初始 schema 缺件導致分支建立失敗，停止重播；以受權 schema-only export 或找回 migration 原始來源形成乾淨 baseline。不能複製資料／vault／真實憑證、偽造 migration 成功或修改已發布 migration。
- 部署候選版本必要 Edge Functions 與共享檔案；既有 preview function 差異也必須列進版本清單。deploy manifest 保存入口、hash／版本及 migration 清單。
- Supabase branch secrets 不假設會繼承。新建專用 encryption key；LINE 設定只使用專用測試 Channels／LIFF。
- 在任何 seed／通知事件前，移除或停用新環境內會向現行環境送出的 cron／webhook／外部通知；逐一驗證 endpoint 與排程目標。禁止複製正式 notification tokens。
- 普通自動測試觀察隔離 outbox 與資料一致性，禁止向真實會員傳訊。故障路徑 provider stub 與真實測試 LINE delivery 分開報告。

### 身分與權限

- 產品維持 LINE 伺服器驗證；測試不得新增 production 可啟用的 auth bypass，也不把預置角色資料當作身分驗證通過。
- 成員測試可沿用既有 test session 機制，前提是在專用環境啟用並驗證伺服器支援；它不能冒充真實 LINE 登入驗收，也不能冒充管理員／總管理員。
- 管理員、總管理員與真實 LINE 流程使用專用測試身分；憑證過期要明確阻塞。若要新增完全自動的 identity provider adapter，屬另一個需審查的變更，第一版不偷偷加入。
- 未登入、跨商家、停權／降權舊憑證與自行升權，必須觀察後端拒絕且資料不變。

### 合成資料與清理

- 每輪使用唯一 run ID；資料、Storage path 與測試商家均記錄 provenance。
- seeding 需冪等、可交易回復；記錄建立前後清單。兩輪不能共享未鎖定帳號或任意清除另一輪資料。
- 同一專用環境以並發鎖序列化有副作用的 run；取消時完成 evidence／cleanup，下一輪先檢查殘留。
- cleanup 僅限本輪登記的合成資源；先核對環境身分，不提供無範圍 truncate／全庫清除。
- 成功、失敗與取消均先保存最少去秘密證據，再清理本輪合成 fixture；第一版不提供刻意保留 fixture 的 debug hold，避免與環境鎖衝突。
- artifact 保留 7 天；涉及真實認證的 lane 停用原始 trace／HAR／storageState 上傳，以允許欄位的結構化診斷取代，截圖只含合成資料。
- 清理失敗為整輪失敗且環境進入需恢復狀態，不蓋掉原始測試失敗；下一輪先核實身分並清除已登記殘留，成功後才開放新 seed。不得並行繼續使用污染環境。

## 6. CI 與外掛契約

新增 workflow 的建議觸發為 `e2e` 分支 push 與受限 `workflow_dispatch`；不接受任意 URL／site ID／project ref／shell command 作為輸入。

流程：驗證 ref／SHA → 現有完整 CI → 隔離資源預檢 → migrations／functions → build 與 scan → E2E site 部署 → 核對 immutable deploy → seed → live E2E → evidence → cleanup → aggregate。

需要在變更 PR 與最終分支 SHA 分別檢查完整基線。沿用既有 workflow 原有 jobs、斷言與 aggregate；不因新增 live lane 而減弱原 CI。fork PR 不取得 E2E secrets，不用 `pull_request_target` 執行不受信任的 PR 程式。

外掛採 portable `plugin.json`＋`skills/project-e2e/SKILL.md`＋必要 references；不內嵌金鑰。套件保留在專案版本控制，以 Plugin Creator 儲存到帳號；安裝成功與測試實際跑通分別查證。

Project #5 若需更新狀態，只沿用使用者指定的 **GitHub Actions＋GraphQL** 管道；本輪 Projects connector 讀取回傳 403，未移動卡片。workflow 的 dispatch 權限／PAT 不假設存在；沒有可用管道即列阻塞，不能改用無法操作卡片的方式冒充成功。

## 7. 編號驗收與測試計畫

| AC | Given／When／Then | 驗證與證據 |
|---|---|---|
| AC-001 | Given 現行 URL／偽造 E2E 標記，When 執行預檢／seed／cleanup，Then 拒絕且無網路寫入 | 單元負向、network spy、環境 metadata |
| AC-002 | Given 正確獨立資源，When build／部署，Then 產物與所有 API 指向 E2E；現行環境發布 ID 不變 | config contract、dist scan、provider 前後快照 |
| AC-003 | Given 專用空資料庫與候選 schema，When migration／functions 初始化，Then 必需 RPC／RLS／Storage 存在，重播／升級按既有規則驗證 | 隔離 DB migration／升級測試、清單與版本 |
| AC-004 | Given 合成 A/B 及 run ID，When seed 重送／失敗／併發，Then 無重複或跨輪修改，rollback 結果正確 | 實際 DB 查詢、交易與併發測試 |
| AC-005 | Given 有效專用身分，When 會員／管理員／總管理員執行適用旅程，Then UI 與實際後端資料一致 | 桌機／手機 Playwright、DB 讀回；缺身分不得 pass |
| AC-006 | Given 管理員待審，When 總管理員開啟頁面後申請送審，Then 無重新整理即可出現；重連恢復正確且不重複訂閱 | 雙 browser context、Realtime、最終申請狀態 |
| AC-007 | Given 跨商家／未登入／停權／降權舊憑證，When 呼叫受保護 API，Then 後端拒絕且無資料副作用 | live API／RLS 負向、角色資料讀回 |
| AC-008 | Given 點數／票券／預約，When 同時消耗、取消、重送，Then 餘額／預留／核銷／outbox 守恆 | 既有基線＋live transaction 結果 |
| AC-009 | Given API timeout／離線／部分部署／取消，When 重試或恢復，Then 不重複寫入，版本不一致被擋 | controlled faults、重連、版本負向測試 |
| AC-010 | Given 本輪合成資源及其他輪資料，When cleanup，Then 只刪本輪資源並回讀確認；失敗不視為通過 | DB／Storage 前後清單、cleanup report |
| AC-011 | Given 測試結束或失敗，When 產出證據，Then 有完整 SHA／環境／deploy／Edge／migration／命令／時間／exit／pass-fail-skip-blocked，且秘密已移除 | JSON／JUnit／HTML／artifact 檢查；auth 狀態不入檔 |
| AC-012 | Given 任一必要案例未跑／失敗／跳過或舊功能回歸，When 外掛判斷結果，Then 報告未完成，無正式合併／發布 | aggregate 與外掛行為演練 |

完整既有基線仍以 `.github/workflows/test-memberwebsocket-dev.yml`、`test-netlify-build.yml`、`test-memberwebsocket-ticket-policy.yml` 為準。

新增案例的具體命令／檔名在設計核准後寫入 implementation plan；計畫不會把未存在的命令描述成已可執行。既有可執行入口：

```sh
node --test MemberWebsocket-dev/tests/*.test.js
node --test scripts/*.test.mjs
node scripts/build-site.mjs
npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/browser
npm ci --ignore-scripts --prefix MemberWebsocket-dev/tests/integration
npm test --prefix MemberWebsocket-dev/tests/browser
```

PostgreSQL、Edge、wiring 與 audit 按權威 CI 中的完整命令執行，不用縮減子集替代。真實 LINE test channel 與有效登入缺件時，對應案例列 Blocked；不以 stub 視為 provider 成功。沒有本輪 final SHA 完整基線及上述 AC 證據，不標「已驗證完成」。

## 8. 改動影響、品質與效能

| 預計修改範圍 | 影響 | 保護方式 |
|---|---|---|
| E2E build wrapper／identity manifest | config／API 路由、Netlify 發布目標 | 正常／錯 ref／混用 endpoint 負向；原 build contract 全保留 |
| E2E workflow | credentials、migration、deploy、artifact | 最少 permissions、固定目標、拒絕未通過 CI、同 SHA 對帳 |
| 合成資料工具與 live tests | 測試環境商家、交易、Storage、Realtime | 環境雙重檢查、run scoped cleanup、並發鎖、實際 DB 驗證 |
| 外掛技能／references | 日常測試操作、失敗判讀 | 格式驗證與獨立任務演練；不誇大工具能力 |

已評估最小方案：沿用 Playwright 與 CI，不重建一般化測試平台、不新增產品資料表或管理 UI。現階段只有設計文件，不改產品 runtime，runtime benchmark 不適用。實作時需量測測試時間、部署時間、cleanup 時間、請求數與 compute 用量；沒有數據不宣稱效能提升。

## 9. 待解除依賴與回復

開始建立付費資源前：設計核准與費用同意。實作時核實：

- Supabase 分支可初始化且能設定 persistent；若工具能力不足，以受權 CLI／提供者設定處理，不自行改建付費 project。
- GitHub E2E environment／secrets 與 Actions dispatch 的管理管道；不在聊天索取或輸出 token。
- 專用 LINE Channels／LIFF／測試身分；目前未檢查或取得，不能宣稱真人流程可自動執行。
- migrate／seed 需要的初始 schema 缺件，以及 clone 分支中的 cron／webhook／秘密殘留風險。

回復：停用新 E2E workflow，保留 evidence，撤銷 E2E credentials；可獨立刪除 E2E Netlify site 與 Supabase branch。刪除會讓合成資料消失，須另確認是否有要保留的失敗案例。不得動現行 site、現行 Supabase、正式 LINE 設定或真實會員。

本草案尚未建立遠端 `e2e` 分支、新 Netlify site、Supabase branch 或可安裝外掛；所有資源名稱都是提案。核准後先讀 writing-plans，產出可分步驗證的實作計畫，再執行建立、測試與交付。

## 10. 獨立實作審閱

2026-10-29 的獨立 builder check 提出三項實質問題：live 覆蓋範圍、LINE 人工／無人值守界線、失敗 fixture 的保留與環境鎖。已在第 4、5 節具體補上：固定八組 live 契約、人工準備登入／自動產品旅程、所有結果均清理並保留 7 天去秘密證據。這三項為工程建議，交付草案讓使用者一併確認；沒有將其寫成已取得的同意。

更新後第二次獨立審閱回覆：「沒有仍需先釐清、會影響實作計畫的重大未決事項。」這是設計完整性審閱，並非程式碼、外掛或真實環境測試成功。

## 11. 本輪交付狀態與下一步

本輪結果：**部分完成且受阻**。完成來源盤點、設計草案、獨立審閱及上述本機基線；未實作或安裝外掛、未建立遠端 E2E 分支／付費資源，AC-001～012 均是待實作驗收，不能計為通過。

| 本輪檢查 | 實際結果 | 證據 |
|---|---|---|
| Node 產品回歸 | exit 0；Node summary 1,154 pass／0 fail／0 skip | `evidence/e2e-baseline-regression.xml` |
| Node 部署／治理工具首跑 | exit 1；117 pass／20 fail／0 skip；`/tmp` ENOENT | `evidence/e2e-baseline-tooling.xml` |
| 相同工具測試改用 workspace TMPDIR | exit 0；137 pass／0 fail／0 skip | `evidence/e2e-baseline-tooling-workspace-tmp.xml` |
| 靜態 build | exit 0 | 本輪命令紀錄；`dist/` 為可重建產物 |
| 新外掛／live Supabase／新 Netlify | 未執行，尚未建立 | 無成功證據 |
| 全專案本輪新版本回歸 | 未執行；無產品新版本，只有設計文件 | 遠端舊基線另列，不能替代新版本驗證 |

已知限制與解除方式：

- P1／開工依賴：設計尚未核准、付費 Supabase 資源未取得費用同意；核准後依 writing-plans 推進。
- P1／live 驗收依賴：真實測試 LINE 身分、CI 憑證與 persistent 管道待核實；缺件時保留 Blocked。
- P1／初始化風險：早期 schema 來源缺件；分支初始化後實際核對，必要時找回 schema-only baseline。
- 環境限制：本機預設 `/tmp` 不存在；使用 `$PWD/evidence/tmp`，未改產品。回復只需移除該次命令的 TMPDIR 設定。

本輪只新增此文件；產品、DB schema、後端權限及現行部署皆無本輪寫入。文件回復為移除這一文件提交；正式 runtime 效能不適用。下一步是取得這份具體設計與費用同意，再產出實作計畫、建立隔離資源、開發外掛與 live tests，最後對同一交付版本執行全部必要驗收與原 CI。
