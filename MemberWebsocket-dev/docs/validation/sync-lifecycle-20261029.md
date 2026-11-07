# 同步生命週期優化驗證

基線：`b817bb1439b6549658e9eb05d8558aa130fd8acd`，目標 Integrated-Marketing-Platform Preview。與 #44 相關的最小增量，不宣稱整張卡或真人 LINE 驗收已完成。

## 實際執行

| 項目 | 命令／工具 | 結果 |
|---|---|---|
| 修改前既有同步 | node --test（business_sync_revision、connection_efficiency、realtime_performance） | 55 pass / 0 fail / 0 skip |
| 新案例 RED | node --test MemberWebsocket-dev/tests/business_sync_lifecycle.test.js | 3 pass / 11 fail / 0 skip；失敗均為實際行為斷言 |
| 原修正 GREEN | 新案例＋上述既有三檔 | 69 pass / 0 fail / 0 skip |
| 獨立審查修正 RED | lifecycle 的返回前景 probe-count 斷言 | 12 pass / 2 fail / 0 skip，預期2實際3 |
| 審查修正 GREEN | lifecycle＋revision | 20 pass / 0 fail / 0 skip |
| 完整 Node regression | node --test MemberWebsocket-dev/tests/*.test.js | 1154 pass / 0 fail / 0 skip |
| 全部 scripts | TMPDIR=<workspace temp> node --test scripts/*.test.mjs | 137 pass / 0 fail / 0 skip；首次預設 /tmp 不存在，改測試環境後通過 |
| 建置 | node scripts/build-site.mjs | exit 0 |
| 本機 Chromium | npx playwright test business-sync-lifecycle.spec.cjs business-sync.spec.cjs --workers=1 | 3 個案例受阻，缺少 Chromium 1194 執行檔；未視為通過 |
| 比較 | node scripts/benchmark-sync-lifecycle.mjs BASELINE_DIRECTORY REPORT.json | member、booking 各120批；240→120 probes，完整刷新各1次；受控時鐘與API，非真實網路p95 |

## 審查與邊界

獨立 read-only reviewer：0 Critical、1 Important（上述 queued 邊界已以 RED→GREEN 修正）、0 Minor。審查未代替 Chromium 或完整 CI。保留全部舊測試、10秒檢查、120秒補查、錯誤退避、API/DB/RLS/LINE收件者契約；沒有資料庫、Edge、套件與正式會員資料變更。

本機結果為候選檔案的證據；API 建立提交後須核對 tree 與本機相同。最終遠端 SHA 的完整 CI、PostgreSQL、Chromium、Edge、安全 audit、Netlify native deploy 與 smoke 以 PR/Actions 實際執行紀錄為準，不能由本文件預先宣稱成功。

回復：revert 本 PR 並走同一完整 CI 與 native branch preview 發布；無資料遷移或資料回復操作。
