import { writeFile, mkdir } from 'node:fs/promises';
import { createBrowserActClient, publicTask, validateScenario, validateTarget } from './core.mjs';

export async function executeAcceptance({ client, workflowId, baseUrl, scenarioId, timeoutMs = 600000, intervalMs = 3000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log }) {
  scenarioId = validateScenario(scenarioId);
  baseUrl = validateTarget(baseUrl, [new URL(baseUrl).origin]);
  const started = await client.start({ workflowId, baseUrl, scenarioId });
  log(`BrowserAct task ID: ${started.id}`);
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '', lastCount = -1;
  while (Date.now() < deadline) {
    const task = publicTask(await client.get(started.id), scenarioId);
    if (task.status !== lastStatus || task.steps.length !== lastCount) {
      log(`BrowserAct status=${task.status} steps=${task.steps.length} verdict=${task.verdict}`);
      lastStatus = task.status;
      lastCount = task.steps.length;
    }
    if (['finished','failed','canceled'].includes(task.status)) return task;
    await pause(intervalMs);
  }
  return { id: started.id, verdict: 'blocked', reason: '等待 BrowserAct 完成逾時；未擅自停止遠端任務', status: 'timeout', steps: [] };
}

if (process.argv[1]?.endsWith('/run-ci.mjs')) {
  const workflowId = process.env.BROWSERACT_WORKFLOW_ID;
  const baseUrl = process.env.BROWSERACT_BASE_URL;
  const scenarioId = process.env.BROWSERACT_SCENARIO_ID || 'AC-001';
  let result = { verdict: 'blocked', reason: '未執行', status: 'not_started' };
  try {
    if (!process.env.BROWSERACT_API_KEY || !workflowId || !baseUrl) throw new Error('缺少 BrowserAct Secrets / Variables');
    const client = createBrowserActClient({ apiKey: process.env.BROWSERACT_API_KEY });
    result = await executeAcceptance({ client, workflowId, baseUrl, scenarioId });
  } catch (error) {
    result = { verdict: 'blocked', reason: String(error.message).slice(0,160), status: 'error' };
  }
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/browseract-acceptance.json', JSON.stringify({
    id: result.id || null, scenarioId, status: result.status, verdict: result.verdict,
    reason: result.reason, stepCount: result.steps?.length || 0,
    checks: result.checks || [], commit: process.env.GITHUB_SHA || null,
    executedAt: new Date().toISOString()
  }, null, 2));
  console.log(`Acceptance: ${result.verdict.toUpperCase()} (${result.reason})`);
  if (result.verdict !== 'pass') process.exitCode = 1;
}
