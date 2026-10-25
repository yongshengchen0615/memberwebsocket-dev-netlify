# BrowserAct Netlify 即時測試監控站

- 獨立站：https://memberwebsocket-browseract-monitor.netlify.app/
- 與既有會員網站及 Supabase 會員資料隔離。
- 網站登入頁可公開存取，監控 API、遠端畫面與操作必須先輸入管理金鑰（Bearer 驗證）。金鑰只存於 Netlify Functions 與目前瀏覽器分頁記憶體。

## 設定（Netlify 專案 → Environment variables）

函式必須具有下列設定；新增或修改後需重新部署：

| 變數 | 用途 |
| --- | --- |
| BROWSERACT_MONITOR_ACCESS_TOKEN | 至少 32 字元的隨機管理金鑰（已另外設定；請勿放 GitHub） |
| BROWSERACT_API_KEY | BrowserAct → Integrations & API → API Keys；需由帳號擁有者設定 |
| BROWSERACT_WORKFLOW_ID | BrowserAct 已發布的 Bot ID；需由帳號擁有者設定 |
| BROWSERACT_BASE_URL | https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/ |
| BROWSERACT_ALLOWED_ORIGINS | https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app |
| BROWSERACT_HUMAN_HANDOFF_ENABLED | 預設 false；先配置 BrowserAct Human Interaction 才設 true |

## 操作

1. 登入公開網址，輸入監控台管理金鑰。
2. BrowserAct Key / Workflow ID 設妥後，按「啟動真實瀏覽器測試」。
3. 網頁每三秒查詢工作流程結果並顯示 Live View、步驟、截圖和驗收斷言。
4. 接管不是任何時刻強制暫停。先在 BrowserAct Bot 設置 Human Interaction 節點，讓輸入參數 handoff_mode=human 時在預期節點暫停。Bot 狀態 paused 時，在 Live View 或 BrowserAct Dashboard Task Control 完成人工操作，再按「交還自動化」恢復。
5. BrowserAct Workflow API 沒有公開的 pause running task 端點；running 時只觀看，不提供虛構的接管按鈕。

Workflow 輸入需要 base_url、scenario_id，啟用交接時再增加 handoff_mode。完成後需輸出嚴格 JSON，例如：
{"scenario_id":"AC-001","passed":true,"checks":[{"name":"未登入拒絕管理資料","passed":true}]}
此範例僅為格式，絕不是已執行的驗收證據。

## 測試與部署

- node --test scripts/browseract/test/*.test.mjs
- node --check scripts/browseract/monitor/functions/browseract-monitor.mjs
- node --check scripts/browseract/monitor/public/app.js
- GitHub Actions：Deploy BrowserAct Monitor（只部署獨立 Netlify 站）。

未設定 BrowserAct 帳號憑證時，前端可部署但不會有真實遠端瀏覽器畫面。完整安全與 LINE 真人驗收仍須在隔離測試資料環境執行。

回退：停用獨立站，或 revert 本修改並重新執行部署。金鑰洩漏時立即輪換並重新部署。
