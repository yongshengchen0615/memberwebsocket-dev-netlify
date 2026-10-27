import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CORE_MODULES = new Set(['admin', 'platform', 'booking', 'member', 'points', 'event', 'calendar']);
const EVIDENCE_HEADINGS = ['受影響模組', '測試與驗收', '回退方案'];
const HIGH_EVIDENCE_HEADINGS = ['架構審查', '發布及資料庫相容性'];
const QUALITY_EVIDENCE_HEADINGS = ['既有功能回歸', '程式碼品質與效能'];
const READINESS_HEADINGS = ['需求與驗收條件', '基線與目標環境', '資安與資料邊界', '測試與驗收', '回退方案'];

const normalize = (file) => {
  if (typeof file === 'string') return { filename: file };
  return file;
};
const isDoc = (name) => /^(?:docs\/|README(?:\.|$)|CONTRIBUTING(?:\.|$))/.test(name) || /\.md$/i.test(name);
const isBackendRisk = (name) => /(?:^|\/)supabase\/(?:migrations|functions)\//.test(name)
  || /(?:^|\/)supabase\/config\.toml$/.test(name)
  || /(?:^|\/)(?:auth|permissions|claims|rls|security|roles|admin-session)(?:[.\/-]|$)/i.test(name)
  || /(^|\/)\.env(?:\.|$)/.test(name);
const isDeployRisk = (name) => name === 'netlify.toml'
  || /^\.github\/(?:workflows\/|PULL_REQUEST_TEMPLATE\.md$)/i.test(name)
  || /^scripts\/(?:build-site|netlify-preview-source|verify-preview|check-preview-ci|netlify-native-ci-gate|verify-platform-preview|pr-change-risk(?:\.test)?)\.mjs$/.test(name);
const isShared = (name) => /(?:^|\/)(?:shared|common|api)(?:\/|[.-])/i.test(name)
  || /^MemberWebsocket-dev\/(?!admin\/|platform\/|booking\/|member\/|points\/|event\/|calendar\/|tests\/|supabase\/)[^/]+\.js$/i.test(name);
// Paths are conservative signals only; manual review can raise the risk.
const isSensitiveRuntime = (name) => !isDoc(name) && new RegExp('(?:^|/)(?:business[-_.](?:line|workspace|context|runtime)|merchant[-_.](?:context|permissions|access)|line[-_.]webhook|booking[-_.]notification|notification[-_.](?:routes|events)|(?:points|ticket)[-_.](?:transfer|policy|grant))(?:[./-]|$)', 'i').test(name);
const GOVERNANCE_PATHS = new Set(['AGENTS.md', 'docs/DEVELOPMENT_GUARDRAILS.md', 'docs/AGILE_DEVELOPMENT.md', 'scripts/governance-workflow.test.mjs', 'scripts/netlify-publish-workflow.test.mjs']);
const TIERS = ['L0', 'L1', 'L2', 'L3'];
const LEVEL_NAMES = { L0: '小改', L1: '小改', L2: '中改', L3: '大改' };
const isPlaceholder = (value) => !value || /^(?:-+|n\/a|not applicable|tbd|todo|待補|待確認|無|未執行|尚未執行|稍後補|無需|none|pending)(?:[\s.。！!、，,；;:：-]*)$/i.test(value.trim());

export function classifyChangeSet(rawFiles, { manualTier } = {}) {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) throw new Error('Expected a non-empty GitHub changed-files array');
  const files = rawFiles.map(normalize);
  if (files.some((file) => !file || typeof file.filename !== 'string' || !file.filename.trim())) throw new Error('Invalid changed file entry');
  const names = files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean));
  if (manualTier !== undefined && !TIERS.includes(manualTier)) throw new Error('Invalid manual risk tier');
  const modules = [...new Set(names.map((name) => {
    const match = /^MemberWebsocket-dev\/([^/]+)\//.exec(name);
    return match && CORE_MODULES.has(match[1]) ? match[1] : null;
  }).filter(Boolean))].sort();
  const reasons = [];
  let score = 0;
  let critical = false;
  const docsOnly = names.every((name) => isDoc(name) && !isDeployRisk(name) && !GOVERNANCE_PATHS.has(name));
  if (modules.length >= 3) { score += 6; reasons.push('同時影響至少三個核心模組'); }
  else if (modules.length === 2) { score += 3; reasons.push('同時影響兩個核心模組'); }
  if (names.some((name) => !isDoc(name) && isShared(name))) { score += 3; reasons.push('修改共用程式／API 入口'); }
  if (names.some((name) => !isDoc(name) && isBackendRisk(name))) { score += 3; critical = true; reasons.push('涉及資料庫、Edge Functions、認證或權限相關路徑'); }
  if (names.some((name) => isDeployRisk(name))) { score += 3; critical = true; reasons.push('涉及發佈、CI 或建置路徑'); }
  if (names.some((name) => isSensitiveRuntime(name))) { score += 3; critical = true; reasons.push('涉及商家歸屬、LINE 憑證／Webhook、通知或點數票券敏感路徑'); }
  if (names.some((name) => GOVERNANCE_PATHS.has(name))) { score += 3; critical = true; reasons.push('修改全專案開發治理規範'); }
  const inferredTier = docsOnly ? 'L0' : critical || score >= 6 ? 'L3' : score >= 3 ? 'L2' : 'L1';
  const tier = TIERS[Math.max(TIERS.indexOf(inferredTier), manualTier ? TIERS.indexOf(manualTier) : 0)];
  if (manualTier && tier !== inferredTier) reasons.push('PR 主動提升風險等級：' + manualTier);
  const level = LEVEL_NAMES[tier];
  return { level, tier, score, critical: tier === 'L3', requiresQualityEvidence: names.some((name) => !isDoc(name) || isDeployRisk(name) || GOVERNANCE_PATHS.has(name)), files: files.map((f) => f.filename), modules, reasons, note: 'L0–L3 是最低風險下限；人工只可上調。文字欄位完整不代表測試或安全驗收成功。' };
}

// Only visible top-level sections count; copied examples and duplicate headings
// must not make an empty readiness contract appear complete.
function evidenceSections(prBody) {
  const lines = String(prBody).replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/);
  const sections = new Map();
  let fence = null, current = null;
  const visible = [];
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    visible.push(line);
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = null;
      if (heading[1] === '###') {
        const title = heading[2];
        const bodies = sections.get(title) || [];
        current = [];
        bodies.push(current);
        sections.set(title, bodies);
      }
    } else if (current) current.push(line);
  }
  return { sections, visible: visible.join('\n') };
}

export function evaluateEvidence(risk, prBody = '') {
  const { sections, visible } = evidenceSections(prBody);
  const missing = [];
  if (risk.level !== '小改' && !/^## 變更風險評估\s*$/m.test(visible)) missing.push('變更風險評估');
  const headings = new Set([
    ...(risk.requiresQualityEvidence ? QUALITY_EVIDENCE_HEADINGS : []),
    ...(risk.requiresQualityEvidence ? READINESS_HEADINGS : []),
    ...(risk.level === '小改' ? [] : EVIDENCE_HEADINGS),
    ...(risk.level === '大改' ? HIGH_EVIDENCE_HEADINGS : []),
  ]);
  for (const heading of headings) {
    const matches = sections.get(heading) || [];
    const body = matches.length === 1 ? matches[0].join('\n').replace(/^[\s>*-]+/g, '').trim() : '';
    if (isPlaceholder(body) || body.length < 10) missing.push(heading);
  }
  return { passed: missing.length === 0, missing };
}


/** Optional PR self-escalation: exact tier token on the line after its heading. */
export function extractManualTier(prBody = '') {
  const match = prBody.match(/^### 風險等級覆核[^\r\n]*\r?\n[ \t]*(L[0-3])(?=\s|[：:-]|$)/mi);
  return match?.[1]?.toUpperCase();
}

export function reportMarkdown(risk, evidence, prNumber = '?') {
  const lines = [
    `## Project #5 PR #${prNumber} 變更風險檢查`,
    '',
    `**初步分級：${risk.tier} / ${risk.level}（路徑分數 ${risk.score}）**`,
    `**評估欄位：${evidence.passed ? '完整' : `缺少：${evidence.missing.join('、')}`}**`,
    `**影響模組：${risk.modules.join('、') || '未識別指定模組'}**`,
    '',
    '### 影響原因',
    ...(risk.reasons.length ? risk.reasons.map((reason) => `- ${reason}`) : ['- 未偵測到高風險路徑；仍需人工審核']),
    '',
    `> ${risk.note}`,
    '> 本檢查只驗證 PR 說明欄位，並不代表效能已量測、既有功能已通過回歸、CI、審查或 Preview 已通過。',
  ];
  return lines.join('\n') + '\n';
}

async function fetchFilesFromGitHub(owner, repo, number, token, expectedCount) {
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || !Number.isInteger(number) || number < 1) throw new Error('Invalid GitHub repository or PR number');
  if (!token) throw new Error('GH_TOKEN missing: cannot safely classify files');
  const result = [];
  for (let page = 1; page <= 30; page++) {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw new Error(`GitHub changed-files API failed: HTTP ${response.status}`);
    const current = await response.json();
    if (!Array.isArray(current)) throw new Error('Unexpected changed-files API response');
    result.push(...current);
    if (current.length < 100) break;
    if (page === 30) throw new Error('GitHub changed-files pagination truncated');
  }
  if (Number.isInteger(expectedCount) && expectedCount !== result.length) throw new Error(`Incomplete file list: expected ${expectedCount}, got ${result.length}`);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  let files; let body; let number;
  if (args.length === 1 && args[0] === '--github') {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    number = event.pull_request?.number;
    const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
    files = await fetchFilesFromGitHub(owner, repo, number, process.env.GH_TOKEN, event.pull_request.changed_files);
    body = event.pull_request.body || '';
  } else if (args.length === 4 && args[0] === '--files-json' && args[2] === '--body-file') {
    files = JSON.parse(await readFile(args[1], 'utf8'));
    body = await readFile(args[3], 'utf8');
    number = 'local';
  } else {
    throw new Error('Usage: node scripts/pr-change-risk.mjs --github | --files-json path --body-file path');
  }
  const risk = classifyChangeSet(files, { manualTier: extractManualTier(body) });
  const evidence = evaluateEvidence(risk, body);
  const report = reportMarkdown(risk, evidence, number);
  process.stdout.write(report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
  if (!evidence.passed) { process.stderr.write(`::error::Missing PR risk evidence: ${evidence.missing.join(', ')}\n`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`PR risk assessment failed: ${error.message}\n`); process.exitCode = 1; });
}
