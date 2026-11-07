# 一般管理員自動申請與功能權限流程

初次驗證結果（2026-10-18 08:47 UTC）：**部分完成且受阻，當時未合併、未部署**。後續狀態以 PR #17 與對應提交的驗證報告為準。基底為 `84b58a1218b64a0c1775507753c85beb2e581ee5`；來源 SHA-256 與實際執行紀錄見 [results.json](validation/admin-application-20261018/results.json)。

## 第一性原理摘要

| 項目 | 已確認規則與決策 |
| --- | --- |
| 目標 | 一般管理員開啟 `/admin/`、完成 LINE 驗證後首次自動申請；總管理員在 `/platform/` 勾選功能並核准；一般管理員在 admin 已開通功能頁設定 LINE。 |
| 身分 | 一般管理員使用固定 Login Channel `2010791619`；總管理員使用專屬 `2012065297`。Channel 由伺服器選擇，忽略請求中的角色或申請人。 |
| 權限與不變條件 | 一般管理員不能核准自己、變更功能授權或修改其他商家；未核准或停用者不能儲存 LINE；未開通功能的 LIFF 不可修改。 |
| 狀態 | 不存在申請 → pending → approved；重整與併發首次進入只保留一筆。核准功能後仍保留原有資料隔離閘門。 |
| 資料 | 沿用 actor 唯一約束與交易鎖；首次名稱取自驗證過的 LINE profile，代碼由伺服器隨機產生。憑證加密保存，不回傳。 |
| 限制 | 本次只完成申請、授權與設定控制平面。新商家的業務資料隔離、Realtime、Storage 與業務 API 尚未接入，不將 pending_provisioning 改成 active。 |
| 工作假設 | 首次不要求另填商家名稱與代碼；共用 Channel／Messaging 憑證集中設定，各開通功能設定 LIFF；整合、測試與紀錄沿用共用 LINE。 |

沿用既有控制平面，比重新建立註冊／授權系統容易驗證，也避免影響原有會員資料。保留不同 LINE Channel 的驗證器，比接受任意前端指定 Channel 更能維持總管理員邊界。

## 變更

- `productizedAdmin` 啟用時，`/admin/` 在業務資料請求前導向 `/admin/workspace.html`，保留原 URL 查詢參數。
- `platform.application.ensure` 根據 LINE 驗證身分建立首次申請。重送、重整、併發與核准後重進保持原申請；既有 rejected 不會自動重新申請。
- admin 與 platform 共用已測試的介面程式，但使用不同工作區、LIFF 與後端驗證器。一般管理員不再在 platform 申請。
- 一般管理員可手動刷新申請與權限；每 15 秒及返回可見分頁時同步。版本與狀態未變時保留未儲存欄位，停用後隱藏設定區。
- 納入基底分支既有的總管理員功能授權編輯器、申請人身分顯示、功能分頁、未開通 LIFF 修改拒絕與增量設定。
- admin 新工作區納入建置版本標記及資產檢查；新 DOM 測試加入既有 CI，審閱清單記錄新旅程。
- 無新增套件、正式資料修改或新增本輪資料表。前置分支的 `20261018012500_platform_feature_grants_only.sql` 尚未套用至遠端。

## 驗收對照

| 編號 | Given / When / Then | 證據與狀態 |
| --- | --- | --- |
| AC-017 | Given 已驗證的一般管理員且尚無申請；When 首次或併發進入 admin；Then 自動產生唯一 pending 申請，名稱來自 LINE，不讀取舊業務工作台。 | 單元與真實 handler／SQL、DOM 通過；Chromium 入口導向尚未執行成功。 |
| AC-016 / AC-018 | Given pending 申請；When 總管理員只勾選功能並核准；Then 核准成功且不要求 LINE 憑證。 | 真實 DOM／handler／SQL 通過。 |
| AC-012 / AC-018 | Given 已核准；When 一般管理員刷新 admin；Then 只出現已開通功能，能先存共用資料、再存各功能 LIFF，憑證不回填。 | DOM／SQL 通過；Chromium 視覺與原生表單驗證受阻。 |
| AC-013 / AC-017 | Given 一般管理員、停用或未核准申請、錯誤 Channel；When 嘗試總管理員操作或儲存不允許的設定；Then 後端拒絕。 | 單元、SQL 負向案例通過；真實 LINE OAuth 尚未驗收。 |

## 測試報告

環境：Node 24.19.0、Deno 2.9.6、PGlite 0.3.14、JSDOM 26.1.0、Playwright 1.56.1。原始日誌都位於 [validation/admin-application-20261018](validation/admin-application-20261018/)。LINE provider 使用合成回應；PGlite 不等於遠端 PostgreSQL 多連線驗證。

| 檢查 | 實際命令／工具 | 結果 | 通過／失敗／跳過 | 日誌 |
| --- | --- | --- | --- | --- |
| 單元／全專案回歸 | `node --test MemberWebsocket-dev/tests/*.test.js` | exit 0 | 959 / 0 / 0 | regression-final.log |
| 本輪 SQL／DOM 整合 | `node --test MemberWebsocket-dev/tests/integration/product_platform.cjs MemberWebsocket-dev/tests/integration/product_admin_ui.cjs` | exit 0 | 15 / 0 / 0 | platform-integration-final.log |
| 完整整合嘗試 | `node --test --test-concurrency=2 MemberWebsocket-dev/tests/integration/*.cjs` | exit 1；此紀錄先於最後共用介面提示文案修改，本輪平台案例另已重跑，不能代表最終完整整合通過 | 406 / 3 / 0；2 個葉案例及其父層失敗 | integration.log |
| Edge 型別 | `deno check --node-modules-dir=manual MemberWebsocket-dev/supabase/functions/*/index.ts` | 全部 entrypoints exit 0；相同鎖定 Supabase 套件透過 npm 取得供本機解析 | 全部通過 | edge-check-final.log |
| Edge 業務邏輯 | `deno test --node-modules-dir=manual MemberWebsocket-dev/supabase/functions/_shared/*_test.ts MemberWebsocket-dev/supabase/functions/booking-line-notifications/delivery_test.ts` | exit 0 | 25 / 0 / 0 | edge-test-final.log |
| 建置與既有 API 冒煙 | `COMMIT_REF=84b58a1218b64a0c1775507753c85beb2e581ee5 node --test scripts/deploy.test.mjs scripts/netlify-publish-workflow.test.mjs` | exit 0；工作樹測試標記使用基底識別，未宣稱已部署本輪提交 | 15 / 0 / 0 | build-final.log |
| 靜態語法／架構 | `node --check` 與現有 CI wiring 四個步驟 | exit 0；保留原本斷言 | 4 wiring 通過 | wiring-results.json |
| 相依安全 | browser、integration 各執行 `npm audit --json` | exit 0 | 0 vulnerabilities | results.json |
| Chromium | 標準啟動及環境用 single-process 啟動均嘗試 `PLATFORM_APPLY` | page 建立前 Chromium SIGTRAP；0 個 UI 驗收成功執行 | 受阻，不算通過 | browser-single-process.log |
| 缺陷重現 | 相同新增自動申請案例配修改前 handler | exit 1，回 403；修改後同案例通過 | 已證明原缺口 | reproduction-before.log |

## 已知問題與解除方式

1. 發布阻擋：完整 Chromium 無法在目前執行環境啟動，兩種啟動方式均 SIGTRAP。須由可啟動 Chromium 的 runner 完成全部 Playwright 基線與本輪案例；不可把 DOM 視為瀏覽器證據。
2. 發布阻擋：完整 DOM 整合失敗於 `BOOKING_RESOURCE_SETTINGS`（設定刷新後勾選狀態）及 `LOTTERY_EDITOR_template`（刪除後仍有兩列）。單獨重跑目前版本兩者仍失敗；還原修改前 admin/app.js、admin/index.html、config.json 後，抽獎案例仍失敗，預約案例通過。抽獎缺陷先於本輪；預約案例原因與穩定性仍待定位，不宣稱已證明與本輪無關。未增加重試、延長期限或弱化斷言。
3. CI：基底 GitHub Actions 工作在 1–2 秒內失敗，Regression job 回傳 `steps: []`；沒有執行證據，不能視為通過。新 PR 需另檢查實際 job 狀態。
4. 新 API／SQL 尚未部署；目前遠端只有舊 `platform_submit_application`，尚無 `platform_update_tenant_features`。因此新流程目前不能宣稱已在公開站可使用。
5. 真人 LINE OAuth、登入回跳、Provider UID 關係與推播未執行；不對正式會員進行破壞性測試。新商家業務資料隔離依然未完成。

## 執行、部署與回復

本機依 browser／integration 既有 lockfile 安裝套件，依上表及 `.github/workflows/test-memberwebsocket-dev.yml` 執行完整基線。套件解析、瀏覽器執行環境的本機輔助設定未納入產品或依賴變更。

所有必要檢查通過後，才套用前置功能授權 migration、發布 `platform-api`、將 PR 合併至 `feature/productization-super-admin`，由既有 verified preview 流程發布固定 alias；再檢查 admin、platform、資產、版本與 API 權限，最後進行真人 LINE 驗收。本輪沒有執行任何遠端寫入，無須資料回復。若後續版本有問題，以 revert 提交修正並重跑 CI；不刪除申請或會員資料。

下一步先定位兩個既有 DOM 失敗並取得可執行 Chromium 的 runner，完成全基線後再部署；不以未完成測試換取發布。

## 依指定分支繼續完成（2026-10-18）

使用者已指定完成後合併至 `feature/productization-super-admin`，PR #17 已改為此目標。

兩項失敗已確認涉及寫入尚未完成即執行下一操作：票券儲存回應會重新建立獎項列，覆蓋期間的刪除；預約設定儲存與手動刷新同時發生時可能讀到舊值。已在寫入期間停用獎項欄位及刪除／新增／平衡按鈕，重建的獎項列也維持停用；預約設定寫入期間停用刷新，待寫入與讀取皆結束才恢復。沿用原有驗收斷言，加入受控延遲回應，先重現缺陷，再驗證鎖定與結果。

`races-red.log` 記錄兩案例在修正前對新增的 disabled 斷言失敗；`races-fixed.log` 記錄兩案例與父層共 3 項通過。

為取得可執行 Chromium 的第二個環境，PR 17 的 Netlify Deploy Preview 改用 `scripts/verify-preview.mjs`：從既有 CI 擷取回歸、完整整合、語法、Edge 與 wiring 命令，另執行完整 Chromium、票券瀏覽器基線、audit 與正式建置檢查。任一命令失敗、必要案例為零或案例跳過均令建置失敗。只有全部通過才產生含精確 `COMMIT_REF` 的 `validation-report.json`；靜態部署 ready 本身不能代表驗證通過，必須比對該報告。此額外驗證只對 PR 17 啟用，正式建置與既有 GitHub 發布門檻未變更。


後續完整 DOM 嘗試另發現 `LOCATION_template` 在儲存尚未完成時修改地點，會被回應覆蓋。已將整張票券表單於寫入及刷新期間設為原生 `inert`，並保留獎項控制項停用。DOM harness 同步遵守原生不可互動區域，未刪除原有結果斷言。`location-lock-red.log` 記錄新增鎖定斷言先失敗；`location-lock-fixed.log` 記錄地點、抽獎及預約設定五個葉案例與父層共 6 項通過。此前以所有整合檔並行的非 CI 命令另有 startup 子程序逾時；後續依原有 CI 分組命令執行，不修改期限。最終全套結果仍須以精確提交報告為準。


第一輪 Netlify 真實 Chromium 全套完成 242 項通過、1 項失敗，失敗建置 `6ad48ff29b830f0ed10e1c58` 已正確阻擋發布。`PLATFORM_MANAGER_SETUP` 已完成 LINE 共用／功能資料儲存後，仍以舊的手動商家代碼 `self-service-b` 查詢，因此讀到空列；已改以核准回應的商家 ID 查詢，保留原本功能、憑證、佈建與 LINE 斷言，另加入申請人歸屬檢查。錯誤節錄見 `chromium-first-run-failure.log`。下一輪先執行全部平台瀏覽器案例，再執行完整 Chromium 與其他既有基線，仍不允許跳過或失敗。DOM harness 的 disabled 斷言保留原生 `:disabled` 語意，僅互動動作另檢查 inert，避免混淆原生可用性斷言。
