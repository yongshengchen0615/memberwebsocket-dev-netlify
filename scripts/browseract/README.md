# BrowserAct 即時驗收監控台（首批 MVP）

此工具是**本機即時監控台**，不會把 BrowserAct API Key、LINE 工作階段或 Live View URL 發布到公開 Netlify 網站。沿用現有 Playwright / DOM / SQL CI，BrowserAct 僅新增部署後真實瀏覽器驗收。

## 準備

1. 在 BrowserAct Dashboard 建立**已發布**的 Bot / Workflow。其輸入參數需命名為 `base_url` 與 `scenario_id`。
2. Workflow 必須真的打開 `base_url` 進行案例操作，並在最後輸出**純 JSON 字串**：

```json
{"scenario_id":"AC-001","passed":true,"checks":[{"name":"未登入無法讀取總管理資料","passed":true}]}
```

以上只是輸出格式合約，不是已驗證的測試結果。若未執行必要動作或沒有斷言，不得輸出 passed=true；CLI 對缺少、無效、部分失敗或案例編號不相符的輸出都會判 FAIL。`finished` 不等於 PASS。請讓 BrowserAct 工作流程只使用授權測試帳號，不要在正式資料庫建立破壞性測試。

3. 在本機終端機設定環境變數（請勿寫入 git）：

```bash
export BROWSERACT_API_KEY='由 BrowserAct Dashboard 產生的 API Key'
export BROWSERACT_WORKFLOW_ID='已發布的 Workflow ID'
export BROWSERACT_BASE_URL='https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/'
# 選用：指定可測試的 HTTPS 網域，逗號分隔；預設僅允許 BROWSERACT_BASE_URL 的 origin
export BROWSERACT_ALLOWED_ORIGINS='https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app'
node scripts/browseract/live-server.mjs
```

4. 打開 **http://127.0.0.1:4173**，選擇 AC-001 按「啟動 BrowserAct」。執行期間將顯示 Live View 影格、三秒一次的步驟與截圖。若尚未有 `live_url_info`，顯示等待提示及已有的步驟截圖；任務結束後 Live View 可能失效。瀏覽器位址 `#task=...` 可在同一台電腦重新查看任務；也可把 GitHub Actions 日誌的 Task ID 貼入「查看既有任務」。

**安全性**：HTTP 只綁定 `127.0.0.1`、驗證 Host / 修改請求的 Origin、API Key 只留在後端。不要透過 ngrok、反向代理、連接埠轉發或公開網站直接曝光這個監控台。Live View 和截圖可能包含敏感資料；請使用合成測試帳號並控制分享範圍。

## GitHub Actions（第二個啟動入口）

在 GitHub 專案設定 `Secrets.BROWSERACT_API_KEY` 與 `Variables.BROWSERACT_WORKFLOW_ID`。前往 Actions → **BrowserAct Live Acceptance (manual)** → Run workflow，選擇 `Integrated-Marketing-Platform` 分支並填 `scenario_id`。工作流程會顯示 Task ID、狀態與步驟總數，完成後提供不含畫面 URL 的 JSON 報告；若要**即時觀看影像**，在本機開啟監控台，用相同 API Key 貼上 Task ID 追蹤。GitHub Actions 不會公開 Live View URL，避免讓任何可看 CI 日誌的人看到測試工作階段。

此 MVP 尚未串成全自動部署 gate：因為缺少真實 BrowserAct Workflow、API Key 與 LINE 測試身分，僅提供手動觸發入口，不改動既有部署閘門。完成真人／外部驗證後，才擴充 AC-002..AC-012 與發布阻擋。

## 測試

```bash
node --test scripts/browseract/test/*.test.mjs
node --check scripts/browseract/core.mjs
node --check scripts/browseract/live-server.mjs
node --check scripts/browseract/run-ci.mjs
node --check scripts/browseract/public/app.js
```

所有單元及本機 HTTP API 測試以 fake BrowserAct API 驗證流程與安全負向案例，不能宣稱真實 BrowserAct 或 LINE 驗收已通過。

## 回退

此功能只新增獨立目錄及手動 workflow，不變更現有會員前端、Supabase Schema 或 Netlify 部署；可直接刪除此目錄與 `.github/workflows/browseract-acceptance.yml` 回退。
