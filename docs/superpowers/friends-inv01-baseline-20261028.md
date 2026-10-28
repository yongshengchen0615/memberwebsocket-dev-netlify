# 好友功能開工與基線報告

日期：2026-10-28（Asia/Taipei）  
相關工作：#148、#149、#150、#151、#152、#153、#51。  
設計：[首批 INV-01 設計](specs/2026-10-28-friends-inv01-design.md)。

## 1. 本輪結果：部分完成且受阻

已取得實際程式庫、需求與原測試，完成既有 Node 基線，提出首批可審閱設計。尚未實作或修正產品程式；設計待使用者核准。產品功能、DB、LINE 與 Netlify 本輪未變更；沒有完成整卡或新版本部署宣告。

## 2. 第一性原理摘要

- 目標：會員能分清會員好友與邀請優惠；保護 QR、好友狀態、代約及舊獎勵。
- 不變條件：LINE 私人好友名單不會被匯入；查找不自動加好友／發獎；跨店、失效會員不得讀寫；舊推薦與票券不重算。
- 事實：現有雙入口已存在，優惠仍為舊會員編號模式；分支 HEAD 為 `12e62fb12edc0b606f5c7123c3ba292c2837d11a`。
- 假設／建議：首批先做 #149 的用途辨識與回歸保護，為未回答推進順序問題後採用的預設；不是核准完成的設計。
- 限制：Projects items／fields 403；本地完整 DOM／DB／browser／Edge 工具未備齊；未獲可重置遠端資料沙盒與真人 LINE 測試身分。
- 決策：沿用既有 JS、Edge 及商家 runtime；不新增平行會員庫或擅定 #151 歸因政策。

## 3. 變更內容

本輪只新增本報告及設計文件，沒有修改功能、資料模型、相依套件或執行設定。設計列出未來可能觸及的 `friends.js`、`member/member-growth.js`、必要 CSS 及原測試；尚未執行。文件不在產品執行路徑，runtime 效能比較本輪不適用，沒有提速宣告。

設計經獨立 builder check 提出一項重要歧義：新增代約的好友資格檢查，是否會錯套到既有預約修改／取消。已回讀 `booking-group-api/index.ts`，按「保留既有行為」釐清：僅新增代約依現行好友資格；既有預約管理沿用原擁有權與狀態規則，編輯鎖定原受服務者，不因解除好友自動取消或加設限制。這是現有相容契約的澄清，沒有改動後端。

## 4. 驗收對照

| 需求 | 本輪可查證成果 | 尚待驗收 |
|---|---|---|
| #149／#51：先盤點原 UI／API／測試 | 已讀 friends／growth／MemberSystem／BusinessContext／business-runtime／Edge 及好友、推薦、代約測試；Node 基線 1112/1112 | 本設計 AC-F149-001～008 的新增或擴充案例與產品實作 |
| #150：LINE 原生分享 | 已確認既有 share helper 不等同新客分享 | #151 可信 URL、LIFF 官方分享與 iOS／Android 真人驗收 |
| #151／#152：歸因與發券 | 已識別舊 `bind_member_referral` 的相容界線 | 歸因政策、後端與 PG17 交易／併發、負向、額度守恆及 Provider 驗收 |
| Project #5 / view 3 | views 查詢成功並識別開發看板 | project／items／fields 因 403 未確認或修改；沒有重建卡片 |

## 5. 測試報告

本輪本地基線時間：2026-10-28 **10:49:44～10:49:49 +08:00**（原 metadata：02:49:44.317323～02:49:49.404705 UTC）。環境：Linux 工作容器，Node v24.22.1；SHA `12e62fb12edc0b606f5c7123c3ba292c2837d11a`。

| 檢查或測試層級 | 命令／工具 | 實際結果 | 通過／失敗／跳過數 | 證據 |
|---|---|---|---|---|
| 現有 Node 產品回歸 | `node --test MemberWebsocket-dev/tests/*.test.js` | exit 0；1112 tests，4942.645719 ms | 1112／0／0 | 本地 `evidence/friends-20261028/node-baseline.log`、`node-baseline.json` |
| 文件／PR 治理檢查首次執行 | `node --test scripts/pr-change-risk.test.mjs scripts/governance-workflow.test.mjs` | exit 1；容器 `/tmp` 不存在，`mkdtemp` 回 ENOENT | 37／1／0 | `evidence/friends-20261028/docs-governance.log`；屬環境失敗，未修改測試 |
| 文件／PR 治理檢查環境修正 | 同命令，`TMPDIR` 指向本地已建立的 evidence 子目錄 | exit 0；10:55:47 +08:00 重跑，354.294019 ms；未改產品或測試邏輯 | 38／0／0 | `evidence/friends-20261028/docs-governance-tmpdir.log`、`docs-governance-tmpdir.json` |
| 本地 DOM／PGlite／PG 客戶端 | `require.resolve` 與工具探測 | jsdom、PGlite、pg 未安裝；未執行套件 | 未執行，無案例統計 | 工具探測輸出；依原 lockfile 待安裝 |
| 本地 browser | Playwright 版本與 Chromium executable 探測 | 共用 runtime Playwright 1.62.1 可讀，Chromium 路徑不存在；未執行 browser cases | 未執行，無案例統計 | Repo 鎖定版本為 1.56.1，後續依 repo 安裝，不混用 |
| 本地 Edge／PG17 | `command -v deno psql docker supabase` | 未找到上述工具；未執行相關測試 | 未執行，無案例統計 | 環境探測 |
| Supabase 開發分支盤點 | `list_branches`，project `dbuquirnaskrwcamdxki` | 回傳 `branches: []`；無資料寫入 | 非測試；不填案例數 | 連接器實際回傳 |
| 新 AC／真人 LINE／新版本 Preview | 尚未執行 | 設計／產品尚未進入實作；不得算通過 | 未執行 | 設計第 6、7 節 |

同基線 SHA 已有遠端 **push** workflow 紀錄，這是本輪查詢而非本輪重新觸發：

| Workflow | 實際狀態 | 證據 |
|---|---|---|
| Test MemberWebsocket Dev | completed / success | [40538783715](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/actions/runs/40538783715) |
| MemberWebsocket Ticket Policy UI Tests | completed / success | [40538783644](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/actions/runs/40538783644) |
| Test Netlify build | completed / success | [40538783340](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/actions/runs/40538783340) |
| Publish verified platform preview | completed / success | [40538783990](https://github.com/yongshengchen0615/memberwebsocket-dev-netlify/actions/runs/40538783990) |

未讀取各 job 的完整測試案例統計、exit code 或當下公開站資產，不填造數據；workflow success 不取代本批候選／真人／線上驗收。既有 Preview 發布紀錄也不代表本輪發佈了新功能。

## 6. 已知問題與解除條件

| 嚴重度／性質 | 影響／原因 | 修復或解除方式 |
|---|---|---|
| 流程阻擋：設計待核准 | 使用者指定的 Superpowers brainstorming 明文要求設計核准後才開始產品程式 | 核准連結中的首批設計；其後進 writing-plans、RED→GREEN 及完整回歸 |
| 管理限制：Project API 403 | 卡片最新 Status／Priority 未查證，無法安全寫後讀回 | 修復相應 GitHub Projects 權限後再讀寫；目前保留原狀 |
| 驗收環境限制 | 本地 DOM／PG17／browser／Deno 不完整，缺核可真人資源 | 設計核准後安裝鎖定測試工具；完整基線用既有 CI／獨立合成 fixture；真人驗收取得相應核可沙盒 |
| 待驗證風險，尚未定漏洞嚴重度 | `friends.js`／growth 的 reset 主要比較 LINE 身分，商家／會員失效及遲到回應需補案例 | 先重現再判定；不能用靜態觀察宣稱已發生外洩或已修復 |

## 7. 執行與回復方式

現有回歸於 repo 根執行 `node --test MemberWebsocket-dev/tests/*.test.js`；後續安裝與 DOM／browser 命令已寫在設計第 7 節。設計未核准前不執行產品實作、安裝新測試依賴或建立 DB schema。

此文件分支無 migration／Edge／Production 操作；不採用此設計可關閉對應 draft PR。若文件已合併，以 `git revert <文件commit>` 另開 PR；不變更線上資料或復原舊 deploy。

## 8. 下一步

請使用者核准首批設計後進入實作計畫。優先重現商家／帳號／會員失效的資料清除與舊回應案例，再做 #149 最小功能增量；保留全部舊回歸及同 SHA 完整 CI。之後確認 #151 歸因政策，循 #151 → #152、#150 → #153 交付其餘邀請功能；沒有驗收證據不結案。
