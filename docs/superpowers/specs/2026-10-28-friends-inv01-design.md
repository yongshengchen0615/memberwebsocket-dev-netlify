# 好友功能首批設計：INV-01 既有好友保護與入口辨識

日期：2026-10-28（Asia/Taipei）
狀態：待使用者核准；尚未實作產品程式。
工作卡：[#149](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/issues/149)，回歸 [#51](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/issues/51)；總目標 [#148](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/issues/148)。

## 1. 本批目的與範圍

讓會員清楚識別「會員好友」與「邀請優惠」，保護會員好友的完整舊流程，並驗證更換商家／帳號或會員資格失效時，不顯示上一個身分的好友資料。這是 #149 的第一個可回復增量，不代表 #149 全卡或 #148 Epic 完成。

使用者已要求開始推進好友功能。推進順序問題未收到選項答案，因此以下為代理建議的預設範圍，並非使用者已核准的產品設計。

本批包括：

- 沿用現有兩個 dialog，不重建另一套好友系統。會員卡入口清楚標示「我的好友」，好友頁說明這是已註冊會員之間同意建立的關係。
- 保留會員編號、好友 QR、圖片／相機掃描、查找後再次確認、接受／婉拒、撤回、封鎖／解除與代好友預約。
- 「邀請優惠」保留現有會員編號優惠流程，明確標為既有方式；不得用現有 `#reward=<memberCode>` 假扮新客專屬邀請。
- 先以失敗案例查明商家／帳號切換、資格失效、遲到回應、讀取失敗、跨分頁重開的資料處理，再做必要局部修正。僅把靜態觀察寫成待驗證風險，不先宣稱漏洞成立。
- 空資料、載入、錯誤與重試、焦點回復、鍵盤及 390px／1280px 驗收。

尚不在本批：新客邀請 token／歸因、首次入會判定、shareTargetPicker、推薦自動發券、成果人數、活動管理與正式發布。這些仍按 #151 → #152、#150 → #153 銜接；#149 完整邀請畫面亦須等待其正式契約，不能提早結案。

## 2. 真實基線

來源及未來 PR 目標：`Integrated-Marketing-Platform`。本輪取得的 HEAD 為 `12e62fb12edc0b606f5c7123c3ba292c2837d11a`。本地 clone 初始工作樹乾淨；本批設計分支為 `docs/friends-inv01-design-20261028`。實作前需重查目標 HEAD，若變動則更新證據。

實際讀取結果：

| 位置 | 已觀察行為 | 對本批的影響 |
|---|---|---|
| `MemberWebsocket-dev/friends.js` | 已建立獨立好友 dialog；好友與推薦操作分開；`ready` 的帳號變更判斷比較 `lineUserId` | 避免重做分流；驗證同一 LINE 身分切店及資格失效後的資料清除 |
| `MemberWebsocket-dev/member/member-growth.js` | 邀請優惠仍是會員編號／QR 綁定舊獎勵；share helper 未形成新客流程 | 保留舊 API／紀錄，只更清楚說明；不啟用不可信新客連結 |
| `member-system.js`、`business-context.js` | 好友請求路由至 `member-growth-api`；BusinessContext 為請求及同源入口帶 business | 本批沿用路由；不可把客戶端 business 當成後端授權 |
| `_shared/business-runtime.ts`、`member-growth-api/index.ts` | 商家 Context／runtime schema 包裝、LINE token、會員 active／條款及 RPC | 維持全部伺服器檢查；本批預設不改 Edge／SQL |
| `tests/integration/friends_ui.cjs` | 已驗證好友／推薦不互寫、跨帳號遲到回應及代約選單 | 新案例補空缺，不移除或改弱舊斷言 |
| `tests/browser/member-p2.spec.cjs`、`ui-layout.spec.cjs` | 已有掃描、相機權限、入口分離及版型案例 | 沿用並補商家／資格失效、鍵盤及錯誤重試 |

Node v24.22.1 本地現有產品回歸：1112 pass / 0 fail / 0 skip，exit 0。原始日誌及 metadata 在 `evidence/friends-20261028/`（gitignored 工作證據）。現有 SHA 的遠端 push CI 三條 workflow 均 completed/success，見本輪報告；不作為未來修改版的通過證據。

環境限制：本地沒有 integration 所需 jsdom／PGlite／pg，沒有已安裝的 Chromium、Deno、psql、Docker 或 Supabase CLI。Supabase `MemberWebsocket-dev` 專案可讀，`list_branches` 回傳空陣列；這只代表未列出開發分支，不代表其他沙盒一定不存在。未核准使用遠端會員資料做測試。看板 views 可讀，但 project／items／fields REST API 回 403，無法確認目前卡片欄位或寫後讀回。

## 3. Approaches：候選與取捨

| 方案 | 可觀察成果 | 代價及限制 |
|---|---|---|
| A：先 #149 的入口辨識與舊功能保護（建議） | 會員好友用途清楚，切換／失效／錯誤的原功能可獨立驗收 | 新客邀請及發券仍待後端契約；不能宣稱整卡完成 |
| B：先 #151／#152 的歸因與發券 | 先交付可信邀請交易核心，再接分享 UI | 需先確認歸因競爭政策、入會生命週期與隔離 PG 交易證據；變更及資料風險較大 |

本設計提出 A 為預設，因現有 #148／#149 允許好友保護先行，而目前已存在的入口分離可以直接沿用。兩方案皆維持既有架構。不得將未回答的選項視為核准。

## 4. 行為與安全契約

### 好友與舊優惠

會員好友僅顯示後端此次授權回傳的資料；pending、accepted、blocked 的文字與可操作按鈕維持原語意。好友查找或掃 QR 只填入／查找，不自動送出好友邀請或推薦綁定。舊 `#friend`、`#reward`、`#invite` 各依原測試保持用途，歷史獎勵不追溯重算。

### Context／資格與非同步

使用現有 session config／BusinessContext 的商家識別，與會員身分共同判斷目前畫面 context；具體內部 key 由實作者依現有事件與測試決定。客戶端 key 只負責防止舊畫面及遲到回應，不能取代伺服器授權。

在取得不同 context 或無有效會員資料時，清空好友名單、代約紀錄、搜尋欄位與待確認資料、身份分享連結及暫存服務對象，關閉 scanner／相關 dialog，禁止舊回應重新填入。完整有效的新 context 才重新載入。本人仍維持相同 context 的正常更新不應任意清掉正在操作的欄位。

發生 authentication／membership／terms 的失效回應時，清除敏感舊狀態並提供原有重新登入／同意條款路徑；不得保留可送出操作的舊資料。一般暫時性網路錯誤顯示錯誤及重試，不把錯誤當作成功空名單。是否保留一般網路錯誤前的純顯示資料，由實作者選擇安全且明確的呈現，但不可讓失效的代約對象成為可提交的授權依據。

跨分頁回來或背景恢復時重新查後端；同帳號另一頁已解除／封鎖的關係，重新取得後不可再當有效好友提交「新增代約」。新增代約由後端依現有好友資格規則拒絕失效關係。

既有預約的修改／取消維持目前 `booking-group-api` 的預約擁有權與狀態規則，不因本批好友解除／封鎖而新增禁止操作條件。編輯時仍鎖定原服務對象，不能因名單重查而換人；已有預約也不因解除好友而自動取消或改寫受服務者。本批不把新增代約的好友資格檢查套用到既有預約管理。

前端無法處理的後端權限缺陷若被重現，停止相應驗收並另評估最小修正；不能用隱藏按鈕把它宣稱修好。

### 資料與依賴

本批不新增資料表、RPC、migration、套件、快取或 LINE 權限；不修改既有票券、點數、會員及交易資料。測試只用本地合成資料和現有測試 fixture，不發真實 LINE 訊息。

## 5. 影響矩陣與檔案界線

| 預計檔案 | 改動／原功能影響 | 必跑保護 |
|---|---|---|
| `MemberWebsocket-dev/friends.js` | 會員好友文案、畫面 context、失效及重新取得；booking 共用 | lookup／request／accept／remove／block、遲到回應、掃描停止、本人／代約／編輯鎖定 |
| `MemberWebsocket-dev/member/member-growth.js` | 舊優惠方式的用途辨識、相同 context 清除（若案例證明必要） | 舊推薦 API、QR、requestId、重試與已領結果；不能觸發新客發券 |
| `MemberWebsocket-dev/friends.css`（必要時） | 描述／狀態及響應式局部樣式 | 390／1280、亮暗色、鍵盤及焦點、無水平溢出 |
| 既有 integration／browser tests | 補本輪負向和恢復案例 | 所有舊案例仍執行，不刪除有效斷言 |

`member/app.js`／`member-system.js`／`business-context.js` 僅先讀取追蹤事件；若需改事件契約，需在實作計畫記錄並擴展測試。共用 Edge／SQL 預設不在本增量修改。

## 6. 驗收對照（全為待實作／待測）

| 編號 | Given / When / Then | 層級與既有入口 |
|---|---|---|
| AC-F149-001 | Given 有效會員，When 開我的好友，Then 明確顯示會員好友用途及正確狀態，與舊優惠入口分離 | friends_ui、member-p2、ui-layout |
| AC-F149-002 | Given 編號或合法／非法 QR，When 查找、改輸入或關閉 scanner，Then 保留二次確認、相機釋放且不觸發推薦 | friends_ui、friend_qr_scanner、member-p2 |
| AC-F149-003 | Given A/B 商家與相同或不同 LINE 身分，When 切換且 A 舊回應遲到，Then B 不見 A 名單／搜尋／連結／代約資料 | 新 DOM cases + browser + 既有 business runtime／權限 fixture |
| AC-F149-004 | Given 名單已載入或有待確認操作，When 會員資格失效／session失效／需重同意條款，Then 清除並禁止舊操作；有效重登入可重載 | 新 DOM／browser；後端負向案例 |
| AC-F149-005 | Given 好友接受／婉拒／封鎖／解除，When 重整或跨分頁回來，Then 讀回後端一致狀態；新增代約僅可選 accepted；既有預約編輯不換人，修改／取消沿用原擁有權與狀態規則 | friends_ui、member_p2_features、member-p2、相關 booking tests |
| AC-F149-006 | Given 舊 reward／invite 連結及歷史推薦，When 使用舊優惠，Then 沿用原結果且不建立好友／新客歸因 | referral_current_rule_sql、既有 referral Node tests、member-p2 |
| AC-F149-007 | Given 空資料／載入／API錯誤及 390/1280 畫面，When 操作、重試、Escape／Tab，Then 狀態可辨識、無溢出、焦點可回復 | friends_ui、dialog_accessibility、ui-layout、member-p2 |
| AC-F149-008 | Given 最終候選 SHA，When 執行完整基線，Then 全部必要測試及指定 Preview 驗收有證據，無未解決安全或舊功能回歸 | 三條既定 CI + Preview 同版 smoke；整卡仍依 #151/#152 補邀請 AC |

## 7. 可執行測試計畫

實作後依序執行，先新增會在基線失敗的案例，確認根因，再最小修正；每次只修相關失敗，穩定候選再跑完整基線。

```sh
# 依既有 lockfile 安裝測試工具；設計核准後才執行
npm ci --ignore-scripts --no-audit --no-fund --prefix MemberWebsocket-dev/tests/integration
npm ci --ignore-scripts --no-audit --no-fund --prefix MemberWebsocket-dev/tests/browser

# 首批針對性 DOM／SQL
node --test MemberWebsocket-dev/tests/integration/friends_ui.cjs MemberWebsocket-dev/tests/integration/friend_qr_scanner.cjs MemberWebsocket-dev/tests/integration/member_p2_features.cjs MemberWebsocket-dev/tests/integration/referral_current_rule_sql.cjs MemberWebsocket-dev/tests/integration/dialog_accessibility.cjs

# Node 舊功能；此命令本輪基線已執行
node --test MemberWebsocket-dev/tests/*.test.js

# 裝好 Chromium 後；需使用 repo 鎖定 Playwright 1.56.1
npm test --prefix MemberWebsocket-dev/tests/browser -- member-p2.spec.cjs ui-layout.spec.cjs
```

完整基線依 `.github/workflows/test-memberwebsocket-dev.yml` 所有 jobs（regression／DOM／PG17／Chromium／syntax／Edge／wiring／audit／validate）及 `test-netlify-build.yml`、`test-memberwebsocket-ticket-policy.yml`。需 Node22 的 DOM／SQL／browser 按現有 CI 使用 Node22；本地 Node24 不冒充該環境。

角色資料：訪客、A/B 商家有效會員、待完成會員、停權會員、不同會員、過期／撤銷 session；pending/accepted/blocked 好友、既有代約及舊推薦均為合成 fixture。外部 LINE stub 僅覆蓋錯誤，不宣稱真人驗收；原生分享／新客發券真人測試在後續卡才適用。

品質檢查只限修改範圍：錯誤處理、重複 refresh、事件監聽／相機釋放、舊回應及 busy 狀態。效能同條件比較基線與候選的 JS/CSS bytes、同一操作的請求次數，必要時測重查延遲；不引入額外常駐輪詢。不拿本輪文件聲稱 runtime 提速。

證據必記：命令、環境及版本、最終 SHA、時間、exit code、pass/fail/skip、日誌／CI URL。未執行、0 cases、必要 skip、失敗、逾時不得記成功。

## 8. 交付、回復與下一階段

設計核准後依 Superpowers writing-plans 產出實作計畫，再以獨立程式分支／PR 交付；不直推目標分支。WIP 最多兩條主動程式 PR，本批先一條。

回復候選方式：未合併時關閉或保留 draft；合併後以 `git revert <本批merge或commit SHA>` 另開 PR，通過完整 CI 後修正前進。沒有本批 DB migration 或資料回復操作。不操作 Netlify 舊 deploy 還原，不發布 Production。

後續 #151 另需確認「多個邀請競爭時何時鎖定歸因」；建議首次有效註冊開始鎖定只是提案，不在本批默認成業務事實。其契約成立後接 #152 的交易型發券與 #150 的官方分享，再 #153 成果／設定及 LINE 真人驗收。未取得後端契約及真實資源不阻止本批可獨立工程工作，但阻擋相應整卡結案。
