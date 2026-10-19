# 管理員申請與 LINE 設定體驗

## 結果與邊界

本輪完成申請／審核／LINE 設定的引導與狀態檢查。**尚未完成新商家業務功能與用戶端開通**：現有產品化架構只有控制平台，業務 API、Realtime、Storage、排程與通知仍未提供新商家隔離。本輪不把設定保存視為實際開通，不建立會進入舊商家資料的連結。

2026-10-19 唯讀盤點：遠端有一筆 approved 申請、一筆 pending_provisioning 商家；public 有 62 張基礎表沒有 tenant_id。這是架構缺口，無法靠修改 status 或畫面按鈕補齊。正式會員資料未被用於破壞性測試。

來源版本：`1e2a19dd3f2a323dcde16b2f654f0a3ca5f9ad03`。盤點時 `Integrated-Marketing-Platform` 與 `feature/productization-super-admin` 相同。本輪接續目前發布分支 Integrated-Marketing-Platform，使用隔離開發分支提交。

## 第一性原理摘要

| 項目 | 已確認規則／決策 |
| --- | --- |
| 目標 | 一般管理員知道申請進度、LINE 資料來源、設定缺件、何時可使用與下一步由誰負責。 |
| 身分 | 申請與設定沿用平台管理端 LINE Channel；總管理員使用獨立 Channel。商家自填 Channel 不會改變目前登入身分。 |
| 權限 | 後端 LINE 驗證與 SQL 擁有人／總管理員檢查維持不變；一般管理員不能自行核准、授權或啟用。 |
| 狀態 | pending → approved → configuration_required → awaiting_platform。suspended 優先撤銷；沒有假造 ready 狀態。 |
| 資料 | 新增 onboarding 回應投影，只包含缺件欄位名稱、完整度與阻擋代碼。沒有新資料表、遷移或新增憑證副本。 |
| 不變條件 | 設定齊全≠LINE 驗證成功≠業務開通；未隔離商家不進入舊商家資料；憑證不回填、不進複製摘要。 |
| 限制 | 尚無商家專屬運行環境、可用 Endpoint URL 或跨商家業務實測。 |

本輪採既有控制平台新增可驗證狀態與引導，成本低、可回復。完整改造 tenant_id/RLS 或每商家獨立專案屬後續資料平面工作，須包含所有 RPC、Storage、Realtime、通知與登入身分的完整隔離驗收，不能只更改啟用旗標。

## 可觀察的流程

1. 一般管理員首次進入原 `/admin/`，沿用自動申請。頁面顯示送出、等待總管理員、設定 LINE、平台開通實測、分享用戶五個步驟，並說明每 15 秒檢查審核。
2. 總管理員審核時只勾選功能。審核成功訊息及商家卡片說明「一般管理員設定 LINE → 平台開通與實測」，不宣稱用戶端已開通。
3. 一般管理員在同頁看到已授權功能、各欄位的 LINE Console 路徑、完整教學與缺件清單。未核准功能不顯示。
4. 共用設定先儲存；功能頁缺共用前置設定時導回共用頁並說明原因。儲存後清單依伺服器的已儲存版本更新。
5. 設定齊全後顯示由平台負責的下一步，明確說明尚無預定開通時間；不要求重複儲存、不提供失效的用戶連結。
6. 開通摘要可手動複製給平台聯絡人，只含商家名稱／代碼、核准功能、缺件與平台待辦，不自動傳送訊息。
7. 編輯時背景更新保留草稿；發現其他分頁修改會提示明確捨棄草稿後載入。授權撤銷或停用立即套用並清除憑證輸入。
8. 網路中斷造成儲存結果未知時鎖住輸入及功能切換，使用原 requestId 與原內容重試，避免重複更新。

## 驗收對照

| 編號 | Given／When／Then | 執行案例 |
| --- | --- | --- |
| AC-101 | Given 已核准商家缺共用憑證與預約 LIFF，When 查詢，Then 精確列缺件且不回傳憑證內容。 | merchant_onboarding.test.js；product_admin_ui.cjs |
| AC-102 | Given LINE 必填設定完整，When 儲存或手動標記隔離，Then 仍顯示等待平台、不產生可用入口。 | merchant_onboarding.test.js；ONBOARDING_GUIDE |
| AC-103 | Given LIFF 前綴不符／沒有授權／已停用，When 查詢，Then 狀態正確且不可使用。 | merchant_onboarding.test.js；既有 product_platform.cjs 權限案例 |
| AC-104 | Given 產品化管理員，When 系統入口掛載，Then 不提供通往舊商家會員端的入口。 | portal_navigation.test.js；ONBOARDING_GUIDE |
| AC-105 | Given 手機管理員完成送審、核准、共用與功能設定，When 查看開通狀態及教學，Then 顯示官方欄位來源、缺件、負責人且無水平溢位。 | ONBOARDING_GUIDE；既有 PLATFORM_REVIEW／PLATFORM_MANAGER_SETUP |
| AC-106 | Given 尚未儲存的憑證，When 背景更新／另一分頁改設定，Then 草稿保留；停用則立即清除並關閉工作區。 | ONBOARDING_DRAFT |
| AC-107 | Given 伺服器已儲存但回應遺失，When 重試，Then 版本僅增加一次、稽核僅一筆且憑證清空。 | ONBOARDING_LINE_RETRY |
| AC-108 | Given 真實 A／B 商家，When 管理業務與用戶登入、Realtime、Storage、排程與通知，Then 完整隔離且功能可用。 | **未實作／受阻；不可宣稱整條產品流程完成。** |

## 變更與部署

- `admin/workspace.html`：在原管理頁內增加進度、教學、清單與開通狀態。
- `platform/app.js`／`platform.css`：申請與審核狀態、設定清單、行動裝置排版、草稿與重試。
- `admin/productized-workspace.js`／`portal-navigation.js`：產品化模式隱藏舊會員環境入口。
- `_shared/merchant-onboarding.mjs`／`platform-policy.mjs`：後端產生已儲存設定的完整度；不變更授權規則。
- 測試補上上述案例，更新 UI inventory 的來源指紋及新增旅程說明；不刪除既有驗收。

啟動：`node scripts/build-site.mjs`，然後 `python -m http.server 8080 --directory dist`。真實 LINE 登入仍使用已設定的 HTTPS LIFF Endpoint。

相關驗證：`node --test MemberWebsocket-dev/tests/merchant_onboarding.test.js MemberWebsocket-dev/tests/integration/product_admin_ui.cjs`；`npm test --prefix MemberWebsocket-dev/tests/browser -- product-platform.spec.cjs`。

完整測試命令以既有 `.github/workflows/test-memberwebsocket-dev.yml`、`test-netlify-build.yml`、`test-memberwebsocket-ticket-policy.yml` 為準。新功能沒有帳密註冊／電子郵件重設密碼；此輪沿用現有 LINE 流程，相應帳密驗收不適用。資料庫結構未變更；既有全新遷移與 SQL、角色／隔離負向基線照常執行。PGlite 不是遠端 PostgreSQL 多連線併發實測；合成 LINE 回應不是實際 LINE 登入與推播驗證。

後端為向後相容的新增回應欄位，可先部署 platform-api，再發布前端。前端遇到舊 API 無 onboarding 回應時顯示等待確認、保持封鎖。不得將新商家改為 active 來通過驗收。

回復：以 `git revert <本輪提交>` 回復程式並讓原 CI 重新發布，後端部署相應舊版 platform-api。沒有資料庫遷移或會員資料需要回復。

## 真正開通前仍須完成

平台需建置並驗證商家獨立業務資料平面、商家身分綁定、版本化佈建與升級、各項 API 功能授權、Realtime／Storage／排程／LINE 通知隔離，提供商家專屬 HTTPS Endpoint，再用管理員與另一個測試用戶完成實際登入與資料結果驗證。通過後才實作可用連結、分享與正式啟用。本輪沒有提供這些能力，不能作為可上線的新商家會員系統交付。

LINE 資料來源依官方文件核對：
- https://developers.line.biz/en/docs/line-login/getting-started/
- https://developers.line.biz/en/docs/liff/registering-liff-apps/
- https://developers.line.biz/en/docs/messaging-api/getting-started/
