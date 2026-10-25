import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { createBrowserActClient, validateTarget } from './core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENV_FILE = join(ROOT, '.env.browseract.local');
const DEFAULT_URL = 'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/';

export async function diagnose({ env = process.env, clientFactory = createBrowserActClient, fetchImpl = fetch } = {}) {
  const results = [];
  const apiKey = env.BROWSERACT_API_KEY;
  const workflowId = env.BROWSERACT_WORKFLOW_ID;
  const url = env.BROWSERACT_BASE_URL || DEFAULT_URL;
  results.push({ name: 'BROWSERACT_API_KEY', ok: Boolean(apiKey), message: apiKey ? '已設定' : '未設定（BrowserAct → Integrations & API → API Keys）' });
  results.push({ name: 'BROWSERACT_WORKFLOW_ID', ok: Boolean(workflowId), message: workflowId ? '已設定' : '未設定（BrowserAct → Bots → 複製 Bot ID）' });
  let target;
  try {
    const allowed = (env.BROWSERACT_ALLOWED_ORIGINS || new URL(url).origin).split(',').map(x => x.trim());
    target = validateTarget(url, allowed);
    results.push({ name: '測試網站 HTTPS / Allowlist', ok: true, message: new URL(target).origin });
  } catch (e) { results.push({ name: '測試網站 HTTPS / Allowlist', ok: false, message: e.message }); }
  if (target) {
    try {
      const response = await fetchImpl(target, { method: 'GET', signal: AbortSignal.timeout(12000) });
      results.push({ name: 'Netlify 預覽站', ok: response.ok, message: `HTTP ${response.status}` });
    } catch (e) { results.push({ name: 'Netlify 預覽站', ok: false, message: `無法連線（${e.name || 'network'}）` }); }
  }
  if (apiKey && workflowId) {
    try {
      const info = await clientFactory({ apiKey }).getWorkflow(workflowId);
      const names = new Set((info.input_parameters || []).map(p => p.name));
      results.push({ name: 'BrowserAct Workflow 可查詢', ok: true, message: info.name || '已取得 Workflow' });
      results.push({ name: 'BrowserAct Workflow 已發布', ok: Boolean(info.publish_at), message: info.publish_at ? '已發布' : '未發布' });
      const missing = ['base_url', 'scenario_id'].filter(n => !names.has(n));
      results.push({ name: 'Workflow 輸入參數', ok: missing.length === 0, message: missing.length ? `缺少：${missing.join(', ')}` : 'base_url、scenario_id 已設定' });
    } catch (e) { results.push({ name: 'BrowserAct API / Workflow', ok: false, message: `連線或授權失敗：${e.message}` }); }
  }
  return { ok: results.length > 0 && results.every(x => x.ok), results };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (existsSync(ENV_FILE)) loadEnvFile(ENV_FILE);
  const { ok, results } = await diagnose();
  for (const result of results) console.log(`${result.ok ? 'PASS' : 'BLOCKED'} | ${result.name} | ${result.message}`);
  process.exitCode = ok ? 0 : 1;
}
