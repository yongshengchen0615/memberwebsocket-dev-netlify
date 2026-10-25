# BrowserAct 即時遠端瀏覽器接手

本模式用於「現場觀看瀏覽器、暫停測試、必要時由人接手」，不是錄影回放或完整持續的 Live View。官方指令：

~~~bash
browser-act --session <session-name> remote-assist --objective "..."
~~~

參考：https://github.com/browser-act/skills/blob/main/docs/remote-assist.md

## 安全前提

- 本專案的 GitHub 儲存庫為 public。Remote Assist URL 相當於臨時遠端操控憑證。**絕對不要**貼在 GitHub Actions logs、PR、Issue、公開 Artifact 或截圖。
- 因此不能把現有公開 GitHub Actions 的測試改成直接列印 Remote Assist URL。
- 只允許明列 Netlify Preview 網域的 HTTPS 根網址。不可操作正式站。
- 不要使用正式 LINE、會員、管理員登入資料。未確認 Preview 與正式 Supabase 完全分離時，僅執行匿名觀察。
- Chrome type 是獨立且空白的本機 Chrome 瀏覽器，**不會**自動匯入現有 Chrome 的 Cookies 或 Profile。
- 腳本不會刪除 BrowserAct browser，避免未經獨立授權的刪除動作；僅在終端機結束時關閉這次 session。
- 若 BrowserAct 顯示額外授權或費用，停止並檢查方案。

## 一次性安裝

需求：可以存取 GitHub 的個人電腦、Git、Bash、Python 3、uv、Python 3.12，以及 BrowserAct CLI。macOS/Linux 可使用 Bash；Windows 建議 WSL。確保電腦有 Chrome。

~~~bash
git clone https://github.com/yongshengchen0615/memberwebsocket-dev-netlify.git
cd memberwebsocket-dev-netlify
git fetch origin
git switch fix/browseract-e2e-bootstrap-20261025
uv tool install browser-act-cli --python 3.12
browser-act --version
~~~

如 CLI 提示需登入 BrowserAct，依 CLI 指示在私人終端機完成登入，勿將 API Key 貼入 GitHub Actions log。

## 啟動即時接手

~~~bash
bash scripts/browseract-live-handoff.sh https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app
~~~

1. 腳本驗證目標為允許的 Preview 網址，並檢查由私人互動終端機執行。
2. 顯示即將建立的空白 Chrome browser 名稱和用途，需要你輸入 CREATE 才會建立。
3. 開啟隔離瀏覽器，執行 BrowserAct Remote Assist。遠端控制連結只印在私人終端機。
4. 用手機或其他電腦開啟連結，觀看同一瀏覽器的畫面；必要時點擊與輸入。
5. 回到原本的終端機，按 Enter 結束工作階段；只關閉 BrowserAct session，保留 browser profile。

注意：remote-assist 是人工接手命令，不是整場 GitHub Actions E2E 的 Live Stream；若要完成手動接手後繼續自動化，還需要另外設計交接完成訊號與後續測試步驟。

已存在隔離測試用 BrowserAct browser 時，可指定 browser ID 重用。切勿指定含正式使用者 Cookies 的 Profile：

~~~bash
bash scripts/browseract-live-handoff.sh https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app <approved-test-browser-id>
~~~

## 防誤操作檢查

~~~bash
bash -n scripts/browseract-live-handoff.sh
bash scripts/browseract-live-handoff.sh https://memberwebsocket-dev-netlify.netlify.app
~~~

第二行必須因為不是允許的 Preview 網域而拒絕。切勿把 Remote Assist URL、Cookies 或 LINE OAuth 查詢字串加入測試工件。

## 已知限制

- ChatGPT 對話視窗不能直接嵌入 BrowserAct CLI 的即時瀏覽器畫面；需從其他瀏覽器開啟私人連結。
- GitHub Actions 的暫時 Runner 隨 Job 結束而消失，不適合長時間真人互動。
- PR #135 的 GitHub Actions 仍只做匿名 E2E 煙霧測試，不負責人工登入或 Live Assist URL 分發。
- 本機腳本的真正 Remote Assist 需要由使用者在自己電腦上實際啟動才能驗證；CI 僅驗證語法及正式網址拒絕。
