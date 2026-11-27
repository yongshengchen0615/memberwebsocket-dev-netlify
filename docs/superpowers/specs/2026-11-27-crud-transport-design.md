# CRUD 傳輸安全與單筆回讀

基線：`Integrated-Marketing-Platform` @ `0b5d2485`。目標相同分支；測試專案 `bmwhojszsnxliekkhrka`。本輪不變更正式設定、SQL、LINE 或憑證。

## 已確認事實與不變條件

- `MemberSystem` 以寫入清單排除重試／合併，漏列 `admin.tickets.delete`、`admin.service-grants.add`、`admin.member.force-logout` 及兩種 snapshot cancellation。新增寫入動作若漏登記也會走讀取路徑。
- `admin.calendar-items.save` 的 SQL 交易完成後讀完整日曆，再以回傳 ID 挑選一筆。列表可能受 Data API 筆數上限影響。
- 已執行基線相關測試 98 pass / 0 fail / 0 skip；timer quality gate 通過。
- 身分、跨會員／商家邊界、SQL 交易、請求 ID、通知與 API 回傳格式保持原契約。

## 決策與範圍

方案 A：補齊寫入清單。變更小，但日後漏列會再次自動重送。
方案 B（採用）：明列允許重試的已知讀取，其餘操作採單次寫入語意。沿用原 transport，不新增框架、依賴或持久快取。session status 仍是讀取，但不得合併新舊檢查。

後端保留 `calendarItems` 映射函式，增加可選單筆 ID 篩選；僅單筆儲存回讀使用該篩選。批次與列表維持完整回傳。

## 驗收

| AC | Given / When / Then | 測試與證據 |
|---|---|---|
| AC-001 | Given 新增／修改／刪除與未知動作，When 斷線、逾時、無效回應或同時送出，Then 每次呼叫最多送一次，不共用寫入，回應不確定時顯示 API_RESPONSE_UNCERTAIN | connection_transport_regression，桌機／手機 Chromium |
| AC-002 | Given 舊讀取仍進行，When 寫入開始及結束，Then 新讀取不共用舊請求；已知讀取維持 in-flight 去重與身分／商家隔離 | connection_transport_regression、connection_efficiency |
| AC-003 | Given 有多筆日曆資料，When 儲存一筆，Then DB 查詢只取 SQL 回傳 ID；同樣映射新增／修改結果；列表／批次仍完整；DB 失敗仍拒絕 | api_performance |
| AC-004 | Given 最終候選，When 執行既定完整 CI，Then 全部必要 lane 有實際執行結果；受阻不視為通過 | 原三個產品 workflow、runtime-quality、inventory |

## 測試影響與回復

前端：會員、點數、票券、日曆、管理端 CRUD 與 session status；後端：日曆單筆新增／修改回讀。API/SQL 權限與 schema 不改，既定 DB 遷移／併發／權限與瀏覽器全基線仍必跑。LINE 實際發送沒有變更，不發測試通知給真人。

同環境以合成資料比較受影響寫入故障時請求數、並行寫入數、日曆回讀筆數／bytes；不把 fixture 數據說成真實網路延遲。回復為 revert 本輪提交；無 DB 資料回復或遷移。

待查：Supabase connector 回 Unknown tool；Projects API 403。需以既有 CI／發布工具或其他可用連線查驗，不推定線上測試已完成。

## 測試契約修正依據

既有 `client_security` 用不存在的 `read` action 模擬讀取；本輪已知讀取清單改為拒絕未知動作的重試與合併，因此將 fixture 換成各 surface 真正的 bootstrap，原身分隔離、請求合併、回應斷言全部保留。`event_ticket_friend_transfer` 原以寫入 action 字串存在判斷不會重試；替換為執行真實 transport 的斷線案例，檢查 API_RESPONSE_UNCERTAIN 與實際請求僅一次，沒有弱化驗收。
