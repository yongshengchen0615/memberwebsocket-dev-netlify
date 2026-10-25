const API_ROOT = 'https://api.browseract.com';
const TERMINAL = new Set(['finished', 'failed', 'canceled']);

export function validateTaskId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error('無效的 BrowserAct task ID');
  }
  return value;
}

export function validateScenario(value) {
  if (typeof value !== 'string' || !/^AC-[0-9]{3}(?:-[A-Za-z0-9_-]+)?$/.test(value)) {
    throw new Error('案例編號必須符合 AC-001 格式');
  }
  return value;
}

export function validateTarget(value, allowedOrigins) {
  let url;
  try { url = new URL(value); } catch { throw new Error('無效的測試網址'); }
  if (url.protocol !== 'https:' || url.username || url.password || !allowedOrigins.includes(url.origin)) {
    throw new Error('測試網址不在允許的 HTTPS 網域中');
  }
  url.hash = '';
  return url.href;
}

function safeHttps(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function assessTask(task, expectedScenario = null) {
  const status = String(task?.status || 'unknown');
  if (status === 'failed') return { verdict: 'fail', reason: task?.task_failure_info?.message || 'BrowserAct 任務失敗' };
  if (status === 'canceled') return { verdict: 'blocked', reason: 'BrowserAct 任務已取消' };
  if (!TERMINAL.has(status)) return { verdict: 'pending', reason: '測試仍在執行，尚無驗收結論' };

  let result;
  try { result = JSON.parse(task?.output?.string || ''); } catch {
    return { verdict: 'fail', reason: '工作流程未輸出有效的 JSON 驗收結果' };
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { verdict: 'fail', reason: '驗收結果必須是 JSON 物件' };
  }
  const scenario = expectedScenario || result.scenario_id;
  if (!/^AC-[0-9]{3}(?:-[A-Za-z0-9_-]+)?$/.test(scenario || '') || result.scenario_id !== scenario) {
    return { verdict: 'fail', reason: '案例編號不一致或缺少案例編號' };
  }
  if (!Array.isArray(result.checks) || result.checks.length === 0 ||
      result.checks.some(check => !check || typeof check.name !== 'string' || !check.name.trim() || typeof check.passed !== 'boolean')) {
    return { verdict: 'fail', reason: '缺少有效的驗收斷言 checks' };
  }
  const allPassed = result.checks.every(check => check.passed === true);
  if (result.passed !== true || !allPassed) {
    return { verdict: 'fail', reason: '驗收斷言失敗', checks: result.checks.map(x => ({ name: x.name, passed: x.passed })) };
  }
  return { verdict: 'pass', reason: '所有工作流程斷言均通過', checks: result.checks.map(x => ({ name: x.name, passed: true })) };
}

export function publicTask(task, expectedScenario = null) {
  const assessment = assessTask(task, expectedScenario);
  const stepList = Array.isArray(task.steps) ? task.steps.slice(0, 250) : [];
  return {
    id: validateTaskId(task.id),
    status: String(task.status || 'unknown'),
    createdAt: task.created_at || null,
    finishedAt: task.finished_at || null,
    liveUrl: safeHttps(task.live_url_info?.live_url),
    width: Number(task.live_url_info?.width) || null,
    height: Number(task.live_url_info?.height) || null,
    steps: stepList.map((step, index) => ({
      index: index + 1,
      status: String(step.status || 'unknown').slice(0, 30),
      goal: String(step.step_goal || '').slice(0, 1000),
      evaluation: String(step.evaluation_previous_goal || '').slice(0, 1000),
      screenshot: safeHttps(step.screenshots_url)
    })),
    ...assessment
  };
}

export function createBrowserActClient({ apiKey, fetchImpl = fetch, apiRoot = API_ROOT }) {
  if (!apiKey) throw new Error('缺少 BROWSERACT_API_KEY');
  async function send(path, method = 'GET', body) {
    const response = await fetchImpl(new URL(path, apiRoot), {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`BrowserAct API HTTP ${response.status}`);
    if (response.status === 204) return {};
    return response.json();
  }
  return {
    async start({ workflowId, baseUrl, scenarioId }) {
      if (!workflowId) throw new Error('缺少 BROWSERACT_WORKFLOW_ID');
      const task = await send('/v2/workflow/run-task', 'POST', {
        workflow_id: workflowId,
        input_parameters: [{ name: 'base_url', value: baseUrl }, { name: 'scenario_id', value: scenarioId }],
        save_browser_data: false
      });
      return { id: validateTaskId(task.id) };
    },
    get: id => send(`/v2/workflow/get-task?task_id=${encodeURIComponent(validateTaskId(id))}`),
    stop: id => send(`/v2/workflow/stop-task?task_id=${encodeURIComponent(validateTaskId(id))}`, 'PUT'),
    resume: id => send(`/v2/workflow/resume-task?task_id=${encodeURIComponent(validateTaskId(id))}`, 'PUT')
  };
}
