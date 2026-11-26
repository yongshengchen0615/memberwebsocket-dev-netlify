# 管理端 Google 日曆版面

關聯 #481；基線 `8cb6b6920cc5db94a91cdb52d51cc960317d8368`；來源及目標 Integrated-Marketing-Platform，測試專案 bmwhojszsnxliekkhrka。

| 項目 | 事實／決策 |
|---|---|
| 目標 | 依使用者提供 Google 日曆月份 UI，管理端三個日曆統一工具列、迷你月份、連續七欄日期、精簡事件列與溢出入口 |
| 身分／權限 | 沿用 LINE 管理員與商家功能授權，後端資源隔離不變；預約撤權立即清除可見資料 |
| 狀態 | 月／日／選取日期是前端狀態，日期導覽不寫入；取消編輯不保存 |
| 資料 | 沿用已授權 snapshots、原表單 CRUD 與日期 ISO 契約；三個日曆不混資料 |
| 限制 | 日期 1000–9999，台北今日、週日開頭保留既有規則；手機保留滑動／月快速切換／＋入口 |
| 工作假設 | 使用者要管理端設計調整，並非 Google 帳號資料同步；Google UI 僅唯讀參考 |
| 方案 | 擴充既有 calendar-navigation.js/CSS 可維持 API 和無依賴；替換第三方日曆需重接 CRUD、權限與手機操作，成本較高，本輪採既有元件 |

## 驗收與測試

| AC | Given / When / Then | 測試／命令 |
|---|---|---|
| AC-001 | 三種授權日曆；桌機開啟；統一今天、前後月、年月與月／日選單、迷你日曆 | admin-google-calendar.spec.cjs、原 navigation/workflow、人類工作流 |
| AC-002 | 跨年／閏年／年份邊界；月份顯示；42格連續有效日期，鄰月較淡可點，超出支援年留空不可點 | admin_calendar_navigation.test.js + Google 瀏覽器案例 |
| AC-003 | 同日 >3筆；點另有 N 筆；全部顯示且保留原項目操作 | Google overflow；原 CRUD/跨日/重疊／scope案例 |
| AC-004 | 320/390/1440px、亮暗色；導覽新增取消；七欄及數字不溢出，鍵盤焦點、滑動保留 | Google dimensions + 原 navigation + 全瀏覽器 |
| AC-005 | 撤銷 booking；接收殘留 snapshot；月／日不留預約內容，僅保留已授權休假管理 | Google revoke + 原 revoke/stale snapshot + API隔離基線 |

改動影響：app.js 月份渲染 → 前後月日期／溢出；navigation.js/CSS → 工具列／迷你月曆／月日切換／主題；index.html → 資產版本；coverage manifest → 現有工作流契約的實際複核。無新增 API/Edge/SQL/依賴/LINE 通知，資料庫升降級屬本輪無結構變更；既定 PG/Edge 全 CI 仍需執行。

先跑基線與新增案例 RED，再實作 GREEN；完整 `node --test MemberWebsocket-dev/tests/*.test.js scripts/*.test.mjs`、DOM journeys、Chromium 及 GitHub 三套既定 CI + risk gate 全部對最終 SHA 取證。效能固定 Chromium/1280px/合成快照、40次前後月測請求數及同步操作 p50/p95、資產 bytes；不以單次測量宣稱提速。回復為 revert 本 PR，完整 CI 後重新發布測試分支；不需資料還原。Project 欄位讀取受連接器權限限制，尚未寫入/讀回。
