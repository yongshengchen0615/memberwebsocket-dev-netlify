# Integrated Marketing Platform — 開發代理與協作者規則

適用本 repository 全部目錄；產品範圍與卡片狀態依 [Project #5 Charter / Issue #39](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/issues/39)；完整操作規格見 [docs/DEVELOPMENT_GUARDRAILS.md](docs/DEVELOPMENT_GUARDRAILS.md)。

## 一、第一性原理：先定義不變條件，再修改實作

1. **目標**：這次要修正或交付什麼可觀察行為？不做什麼？
2. **身分／授權／歸屬**：誰可對誰的資料操作？後端如何驗證？權限變動後舊憑證何時失效？
3. **狀態／資料**：合法狀態轉移、資料唯一性、交易、冪等與失敗回復是什麼？
4. **相容性**：列出會被這次修改直接、間接影響的既有流程、API、SQL、LINE 通知、UI 與部署。
5. **驗收**：建立編號的 Given / When / Then 條件（AC-001 起），逐條對應測試、命令與證據。
6. **限制**：優先沿用現有設計與功能；不得以「優化」之名擅自重寫商業規則、移除功能或更改正式資料。
7. **決策**：重大架構變更至少比較維持現況小修與替代方案；優先採最小可回復的變更。

**不得假定沒有出現在對話中的程式或設定就不存在。** 先讀取相關 GitHub 檔案、既有測試、Issue、PR、工作流程與可用環境，區分事實、推論、假設及待驗證事項。

## 二、不可破壞的既有行為（最小保護清單）

- **Platform / Admin / Member**：一般管理員申請後待總管理員核准；總管理員依功能授權；一般管理員只能管理自身獲准功能與商家資料；會員不得越權讀寫。前端隱藏按鈕不代表後端已授權。
- **帳號權限**：未登入、停權、降權、跨商家、跨會員及舊 session/token 必須按現行授權規則拒絕；不能由用戶改寫自己的角色或停權狀態。
- **預約與 LINE**：會員建立預約通知對應管理端；管理端確認或實際變更，通知對應會員端。多人預約、取消、改期、無故未到、重試、outbox 冪等與通知對象不得被反向改壞。
- **點數／票券**：0 可用點數不可轉贈；已預約點數不視為可用；票券與多筆預約遵守既有足額／預留／釋放／核銷規則；併發下不得超額、重複扣點或跨商家使用。
- **會員卡／活動／日曆／好友**：原有門檻、期限、QR、可見／可用權限與已發放紀錄不因新功能被意外重算。
- **快照／收據／Storage**：安全上傳連結、資源擁有權、歷史記錄、跨帳號隔離及失敗恢復不得退化。
- **Supabase**：RLS、Edge Server authorization、RPC 權限、migration 與商家隔離必須維持；已發佈 migration 不得無證據覆寫，禁止直接刪除正式會員資料。
- **同步／發布**：前後端版本、快取、跨端即時同步及斷線復原保留既有語意；Preview 不代表 Production；不能在測試失敗時繞過 CI 發布。

以上是必查邊界，**不是宣稱所有行為目前正確或已測過**。若新發現既有問題，須先建立可重現測試並記錄基線失敗。

## 三、每次變更固定流程

1. **盤點基線**：記錄 source/target branch、HEAD SHA、工作樹、關聯 Issue、現有 CI 狀態與原功能測試。
2. **列出影響矩陣**：修改路徑 → 受影響 API/DB/UI/功能 → 可能回歸 → 既有與新增測試。高風險影響需涵蓋相鄰模組。
3. **先寫失敗測試**：修缺陷先 Red；證明根因再以最小修復 Green；不得只增加 timeout/retry、改弱斷言或刪除有效測試。
4. **分支／PR 開發**：小步可回復提交，使用 `.github/PULL_REQUEST_TEMPLATE.md`；不覆寫他人的無關變更。
5. **測試**：開發時執行相關單元、整合、資料庫、瀏覽器與安全負向測試；交付前執行本版**全部驗收 + 全專案既定完整 CI 基線**。修改交付物後需在最終 SHA 重新驗證。
6. **證據**：每項測試保留 SHA、環境、執行命令、時間、exit code、pass/fail/skip、報告連結；必要檢查 skipped/cancelled/timed_out/未執行不可視為通過。
7. **審查／發布**：先核對原功能，再合併與部署；精確綁定同一 SHA 的 CI、遷移／Edge 版本、Netlify deploy ID、Smoke 和回復點。未取得實際授權不部署正式環境。

既有測試基線：`.github/workflows/test-memberwebsocket-dev.yml`（含 regression、integration、PostgreSQL、Chromium、syntax、Edge、wiring、dependency audit 和 aggregate validate）；搭配 `test-netlify-build.yml`、`test-memberwebsocket-ticket-policy.yml`。**這些是現有管道，不能只挑一個通過就宣稱全綠。**

## 四、交付狀態用詞

僅在全部必要驗收與既有基線於交付 SHA 實際通過、無安全／資料阻擋時稱「已驗證完成」。否則明確標「驗證失敗」或「部分完成且受阻」，列出未跑或失敗項及原因。Project 狀態必須按 #39 進出條件移動，不能憑程式已提交推進 Done。

**目前已知阻擋**：Issue [#40](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/issues/40) 記錄整合分支 Chromium E2E 失敗；不可忽略它或假稱全套 CI 已通過。此規範本身不代表問題已修復。
