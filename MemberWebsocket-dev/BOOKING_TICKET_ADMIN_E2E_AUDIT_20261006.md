# 預約票券與管理端 E2E 實作／驗證對照（2026-10-06）

對應 [預約票券主卡](https://trello.com/c/KOxWjquJ) 與 [管理端 E2E 主卡](https://trello.com/c/rAnvrQp1)。基準為 main `6bdfab21aba643b24828a6d77318649961508562`。這份紀錄區分分支實作、隔離測試、既有正式環境歷史證據；尚未部署的變更不視為正式驗收完成。

## 本次行為

- 未綁定的集點卡／活動票券，會員使用時必須指定本人「管理員已確認、尚未完成」的預約，並符合該筆預約的任一／全部指定項目。多筆符合資格時需選擇；批次只提供所有票券共同符合的預約。
- 已保留在預約的票券沿用完成服務自動核銷；送出或修改預約不會提前扣點。
- 改約交易完成後，對最終的一般／多人服務項目重驗資格。只將失效的 pending 選取改為 cancelled，記錄 `booking_services_changed`；保留持有票券、點數與仍符合的選取。已核銷票券不回復可用；其必要服務不可移除。
- 新的 service-only RPC 在交易內鎖定預約、會員及票券後再驗證。LINE 身分只從 Edge 驗證結果取得；不接受 body 中的 memberId／lineUserId。點數、效期、張數、定位等沿用原核銷函式。
- 使用請求以會員與 requestId 保存不可變的 booking／kind／ticket refs。相同請求回讀，變更內容拒絕；重送不重複扣點。已直接核銷的選取記為 redeemed，後續完成服務會略過再次用券。
- 會員預約、管理端預約與無障礙歷史顯示「項目變更，已解除綁定」。票券表與集點卡／活動頁顯示資格不足的原因。

## 功能 → case key → 測試資料／證據

六模組完整清單仍由 `tests/browser/admin-human-coverage.json` 管理（47 個功能、99 個管理操作案例）；inventory 測試會拒絕無對照案例或未重新審查的 UI 版本。這次新增 7 個案例，沿用已存在的功能流程，沒有新增虛構的線上 runner 節點。

| 範圍 | Case／測試檔 | 測試資料與斷言 |
| --- | --- | --- |
| 會員、條款 | `MEMBER_*`、`RUNNER_ADMIN_TERMS_EDITOR_JOURNEY` | 隔離測試會員、條款草稿／啟用／唯讀、資料修改與重載 |
| 集點卡 | `POINT_*`、`LIMIT_points_*`、`SERVICE_RULE_any/all` | 卡片、票券節點、0／2／50 張邊界與具體服務條件 |
| 活動票券 | `EVENT_*`、`FIXED_*`、`LIMIT_event_*` | 票券種類、受眾、配額、效期、固定發券與定位編輯 |
| 營運日曆 | `CALENDAR_*` | 新增／修改／刪除／批次、加贈、受眾與重載 |
| 整合中心 | `INTEGRATION_*` | 篩選、通知與審計顯示、實際目的頁導航 |
| 一般預約 | `BOOKING_STATUS_*`、`BOOKING_ITEMS`、`BOOKING_BENEFITS`、`BOOKING_PARTICIPANTS`、`BOOKING_CANCELLATION_*` | 實際管理畫面確認／修改／取消／完成、票券增減與多人項目 |
| 無障礙正常審核 | `BOOKING_ACCESSIBLE_register/dismiss/BENEFITS/EXISTING` | 測試 SVG 收據、實際表單項目／分鐘／點數額度／已有預約、完成紀錄 |
| 無障礙寫入拒絕 | `BOOKING_ACCESSIBLE_FAILURE_BOOKING_CONFLICT/ADMIN_REQUIRED/API_RESPONSE_UNCERTAIN` | 未寫入的明確故障；收據與表單保留，無結算，原 payload 重試 |
| 已寫入但回應遺失 | `BOOKING_ACCESSIBLE_UNCERTAIN_REPLAY` | transport 在結算後回報 uncertain；同收據只結算一次，60 分鐘／2 測試點，重載後仍有一筆紀錄 |
| 連續提交／關閉 | `BOOKING_ACCESSIBLE_DOUBLE_SUBMIT` | held transport 讓請求未完成；連續 submit 只送一次、aria-busy、關閉鎖定、收到成功才關窗 |
| 選項載入失敗 | `BOOKING_ACCESSIBLE_READ_FAILURE` | 讀取失敗時審核禁用；重新開啟取得資料；關閉清除收據 URL |
| 解除綁定原因 | `BOOKING_RELEASED_TICKET` | 管理預約及無障礙唯讀歷史都顯示解除原因 |
| 選擇實際預約 | `ticket_booking_choice.cjs`（8 項） | 批次交集、多筆需選擇、busy 鎖定、失效選項移除、文字防注入 |
| Edge 身分／資格 | `api_performance.test.js` 新案例 | authenticated identity 與選定 booking 傳入 RPC；缺 booking 不產生核銷；資格查詢失敗不回傳部分成功 |
| 真實資料庫交易 | `booking_ticket_consistency.cjs` | 空 PGlite 載入正式函式、觸發器、約束與票券領域 partial indexes，套用本次 migration；本人／非本人、保留量、any/all、改約、失效 payload、重選、效期、點數不足、批次回滾、重送、完成略過已用券、PUBLIC 執行權限 |
| GPS／會員收據 | `receipt-location.spec.cjs` | 假相機產生 JPEG／收據快照、定位拒絕及超範圍；核銷 payload 含 bookingId，定位重試保留 requestId |

隔離 UI transport 明確替換認證與 persistence，其固定「2 點」只是畫面證據，不作為正式 SQL 結算證明。PGlite 使用正式函式／觸發器而非重寫核銷 mock；Promise.all 重送仍由單一資料庫連線序列執行，不能宣稱多連線 PostgreSQL 鎖競爭已實跑。

## 與本輪其他主卡的驗收對照

| 變更主題 | 現有案例／下一步 |
| --- | --- |
| 預約票券 | 本文件上述新 SQL／UI 案例；部署後補 live 多連線改約／取消／完成競爭 |
| 主要技師 | `BOOKING_TECHNICIAN`、`BOOKING_RESOURCE_SETTINGS`、`BOOKING_PARTICIPANTS`；其主卡修改後需更新 inventory 指紋及案例 |
| 通知時間／停用 | `BOOKING_SHARED_SETTINGS`、`MEMBER_GRANT_*`、`FIXED_*`；實際 LINE 投遞需另存正式 outbox／送達證據 |
| 複製 | `booking_copy.cjs`、既有 runner 複製流程；新格式需登錄新斷言 |
| 預約模式／教學 | `booking_startup.cjs`、`member_first_use_tour.cjs`、`e2e_feature_nodes.cjs`；新模式需補正常／缺資料／失敗畫面 |
| 背景進度與恢復 | `e2e_background_startup/sync.cjs`、`e2e-refresh.spec.cjs`；測試維持 passed／failed／skipped／blocked 各自終態 |
| 一次安全清理 | `qa_cleanup_boundaries.cjs`、`legacy_schema_cleanup.cjs`；本次新請求表對會員／預約使用 cascade，正式清理仍須部署後驗證 |

## 執行狀態與界線

- 本地 unit 基準：662 passed，0 failed。
- 本地整合基準：117 passed，0 failed；最後擴充的票券交易檔另跑 10 / 10 通過（新增集點卡實際 modal 案例後，CI 合併為 124 項）。
- 本地管理操作：99 個流程 + 1 suite，100 passed，0 failed；這是 DOM integration，不能稱作 Chromium 或 live Supabase E2E。
- 追加 API 回歸：無障礙歷史與選項帶回 cancellationReason，且不曝露原始核銷 metadata。
- 初輪原生 GPS 案例發現活動清單誤引用 claim，已移除誤放的 modal 建立程式，另補持有／未領活動票券的整頁 DOM 載入與使用測試；最終以修正後 SHA 的 CI 為準。
- Native Playwright inventory：110 個案例；本地 Chromium 下載受環境限制未完成，原生驗證交由 PR 的 `browser-e2e` job 執行。
- 所有 case payload 會保存到 `admin-interaction-evidence`；新增無障礙／解除原因案例另附成功終態 screenshot；失敗保留 screenshot／trace。GitHub run ID／commit SHA 及 artifact 為這輪原生證據。
- Supabase 只做 schema／ACL／既有 run 查核，尚未部署本分支 migration／Edge，沒有操作正式會員、票券或客戶影像。
- 部署後 live UI 與多連線競爭尚未執行，標記 **待驗證**；兩张主卡維持進行中。

查核時最新既有 run（本次變更之前，不能替新功能背書）：

| Run code | 結果 | 解讀 |
| --- | --- | --- |
| `UE2E-MUW1BEH8-51E3AFA0` | 36 / 36 passed；2026-10-06 02:00–02:03 UTC | 既有會員流程基準，非本分支新規則驗證 |
| `QA-20261006-0CC0E569` | 9 passed、1 skipped、0 failed | `MEMBERSHIP_TERMS_READY` skipped，不得報為 10 / 10 通過 |

## 發布順序

確認 PR CI 後，先套用 migration `20261006023020`，再協調部署 api、pointcard-extension-api、event-ticket-extension-api、booking-api、booking-group-api、booking-admin-operations、booking-receipt-api 與版本更新的前端。新版 Edge 會拒絕沒有 bookingId 的舊票券使用請求，因此需同步刷新舊頁面。完成後才執行隔離測試帳號 live 回歸、清理與多連線競爭驗證，補 run／case 證據，再勾完整驗收。
