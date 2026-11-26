# 管理端 Google 日曆實作與驗收

目標及 AC 見 `../specs/2026-11-26-admin-google-calendar-design.md`，關聯 #481。沿用 calendar-navigation 與原本 CRUD，不新增依賴、後端或資料表。

1. **基線與 RED**：記錄來源 `8cb6b692`、乾淨獨立分支及測試站；執行 runtime-quality、Node、原日曆 Chromium 基線；新增月份模型及三端管理日曆介面的失敗案例。
2. **月份資料與溢出**：共用42格月份日期模型，支援鄰月與年界；三種月曆限制前三筆並加入可鍵盤點擊的完整當日入口。回歸原資料 scope 與 CRUD。
3. **共用導覽與版面**：桌機工具列／迷你月曆、手機月份列／＋、月日選擇器、主題 tokens。保留原日期焦點、滑動與撤權處理。更新瀏覽器測試以操作新的月日選擇器，保留全部結果斷言。
4. **品質與回歸**：固定資料／viewport／Chromium 量測基線及候選 p50/p95、請求數與資產 bytes；完整 Node／DOM／瀏覽器；獨立程式碼審查後修復問題，更新實際複核的 coverage hashes，完整 CI 以最終 SHA 取證。
5. **交付**：PR 目標 Integrated-Marketing-Platform；同版必要 CI 通過才合併。核對合併 SHA 的 push CI、既有發布工作流、Netlify test deploy ID 與穩定／固定網址 SHA-256 smoke；提供 AC、命令、統計、限制與 revert 回復證據。
