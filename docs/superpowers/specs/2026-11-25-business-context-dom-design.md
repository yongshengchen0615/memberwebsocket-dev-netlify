# 商家入口 DOM 與權限更新效率

基準 `81de73c5b4f8772449649967f02a06f6a5abcfd5`；工作／PR 目標為 `Integrated-Marketing-Platform`。僅測試環境；不更動 API、LINE 身分、後端授權、資料模型或正式設定。

## 問題與最小決策

`business-context.js` 的 MutationObserver 每批 childList 變動都掃描整份文件。讀取相同設定的多個消費端雖共用 HTTP，仍重複掃描與改寫頁面品牌。將既有 gate/retain 接受一個 DOM root，變動時只處理仍在頁面的新增元素；權限／商家改變仍完整處理。相同品牌、連結及權限不重複寫入。

比較方案：A 保留現有模組並縮小掃描與冪等更新，可直接以 DOM 與既有測試驗證；B 拆出新的狀態管理／渲染框架，需要修改所有呼叫端，且沒有數據證明有必要。採 A，不新增依賴、快取或 timer。

不變條件：權限預設拒絕；新插入的子樹及其根元素都會套用權限；撤權／復權立即涵蓋既存節點；不同商家設定與連結隔離；後端仍獨立授權。Observer 不發送 HTTP，不改寫商家切換／workspace／外部連結。

## 驗收與測試

| AC | Given / When / Then | 證據 |
|---|---|---|
| AC-001 | Given 1,000 個既存連結；When 100 批局部文字／元素更新；Then 不重新查詢整份文件，新增根及其後代仍有正確連結與 gate | JSDOM、Chromium、同條件 benchmark |
| AC-002 | Given points 關閉；When 新增根元素、巢狀群組、dialog、各 benefit、all/any 條件或會員連結；Then 正確拒絕，保留既有規則優先順序 | DOM 正負向、桌機／手機 |
| AC-003 | Given 已套用權限的頁面；When 撤權、復權或 A→B；Then 既存與新元素依最新權限、導航依目前商家，舊回應不得重新授權 | DOM、既有 routing/connection/grant suites |
| AC-004 | Given 100 個相同 configure 與未變更 refresh；When 同一結果抵達；Then 仍只有一個進行中 HTTP，品牌／gate 不重複改寫，失敗及 deadline 清理維持 | DOM、既有 connection suite、benchmark |
| AC-005 | Given 同批重疊插入與移除節點；When observer 執行；Then 子樹只處理一次、已移除元素不處理，不自觸發無限更新 | DOM、Chromium |
| AC-006 | Given 最終候選；When 執行完整 CI；Then regression、DOM、PostgreSQL、Edge、Chromium、wiring、audit、建置及 ticket policy 全部有實際結果 | 同 SHA GitHub Actions |

## 限制、驗證與回復

驗收測試使用 1,000 連結／100 批更新與 100 次初始化；重複量測另固定 200 連結／20 消費端／20 批更新、交錯順序五輪，避免把測試規模與量測規模混為一談。記錄 document selector 次數、href 寫入、HTTP、耗時重複樣本；不把 JSDOM 時間當作真實手機或外網 p95。SQL／API 無修改，live DB 僅唯讀盤點；現有完整資料庫與認證回歸仍跑，新增電子郵件／密碼流程不適用既有 LINE 系統。真實 LINE 登入／通知不受修改，不以 stub 宣稱重新驗證。

獨立審查補充：觀察既存 anchor 的 href 變更以保留活動頁重用連結的復權行為；根元素必須仍屬於目前觀察的 document，不能只用 isConnected。兩項先重現 RED，再修正與執行 JSDOM／Chromium；路由改寫冪等，新增 href 觀察不能自觸發無限更新。all/any/route 同元素衝突遵循原規則優先順序。

回復：revert 本工作分支變更並重跑同版 CI；無資料遷移或資料回復。Project #5 連接器 403，無法宣稱卡片已移動。
