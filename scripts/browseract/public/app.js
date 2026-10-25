const $ = id => document.getElementById(id);
let taskId = null, liveUrl = null, polling = false, selectedStep = null;
const sleepMs = 3000;

function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').className = error ? 'fail' : '';
}
async function request(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function setImage(steps, selected = null) {
  const step = selected === null ? [...steps].reverse().find(x => x.screenshot) : steps[selected];
  const image = $('step-image');
  if (step?.screenshot) {
    if (image.src !== step.screenshot) image.src = step.screenshot;
    image.hidden = false;
    $('image-empty').hidden = true;
  } else {
    image.hidden = true;
    image.removeAttribute('src');
    $('image-empty').hidden = false;
  }
}
function render(data) {
  $('current-task').textContent = data.id;
  $('status').textContent = data.status;
  $('verdict').textContent = data.verdict.toUpperCase();
  $('verdict').className = data.verdict === 'pass' ? 'pass' : data.verdict === 'fail' ? 'fail' : 'pending';
  $('stop-button').disabled = !['created','running','paused','pausing'].includes(data.status);
  $('resume-button').disabled = data.status !== 'paused';
  $('step-count').textContent = `${data.steps.length} 步`;
  const list = $('steps');
  list.replaceChildren();
  for (const [index, step] of data.steps.entries()) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = `${step.index}. [${step.status}] ${step.goal || '執行中'}`;
    button.disabled = !step.screenshot;
    button.addEventListener('click', () => { selectedStep = index; setImage(data.steps, index); });
    li.append(button);
    if (step.evaluation) {
      const detail = document.createElement('small');
      detail.textContent = step.evaluation;
      li.append(detail);
    }
    list.append(li);
  }
  if (selectedStep !== null && selectedStep >= data.steps.length) selectedStep = null;
  setImage(data.steps, selectedStep);
  if (data.liveUrl !== liveUrl) {
    liveUrl = data.liveUrl;
    $('live-frame').hidden = !liveUrl;
    $('frame-empty').hidden = Boolean(liveUrl);
    if (liveUrl) $('live-frame').src = liveUrl;
    else $('live-frame').removeAttribute('src');
  }
  const checks = $('checks-list');
  checks.replaceChildren();
  for (const check of data.checks || []) {
    const item = document.createElement('li');
    item.textContent = `${check.passed ? 'PASS' : 'FAIL'} · ${check.name}`;
    item.className = check.passed ? 'pass' : 'fail';
    checks.append(item);
  }
  feedback(`${data.reason} · ${data.steps.length} 個步驟`);
  $('refresh-time').textContent = `更新時間 ${new Date().toLocaleTimeString('zh-TW')}`;
}
async function poll() {
  if (!taskId || polling) return;
  polling = true;
  try {
    const data = await request(`/api/tasks/${encodeURIComponent(taskId)}`);
    render(data);
  } catch (error) { feedback(`讀取測試進度失敗：${error.message}`, true); }
  finally { polling = false; }
}
function attach(id) {
  taskId = id;
  selectedStep = null;
  liveUrl = null;
  $('live-frame').removeAttribute('src');
  $('live-frame').hidden = true;
  $('frame-empty').hidden = false;
  location.hash = `task=${encodeURIComponent(id)}`;
  $('current-task').textContent = id;
  poll();
}
$('start-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('start-button').disabled = true;
  try {
    const result = await request('/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: $('base-url').value, scenarioId: $('scenario-id').value.trim() })
    });
    attach(result.id);
  } catch (error) { feedback(`無法啟動測試：${error.message}`, true); }
  finally { $('start-button').disabled = false; }
});
$('attach-form').addEventListener('submit', event => {
  event.preventDefault();
  const id = $('task-id').value.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return feedback('Task ID 格式不正確', true);
  attach(id);
});
for (const action of ['stop','resume']) {
  $(`${action}-button`).addEventListener('click', async () => {
    if (!taskId || (action === 'stop' && !confirm('停止後無法恢復本次任務，確定停止？'))) return;
    try {
      await request(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, { method: 'PUT' });
      await poll();
    } catch (error) { feedback(`操作失敗：${error.message}`, true); }
  });
}
request('/api/config').then(config => {
  $('base-url').value = config.baseUrl;
  $('connection').textContent = config.configured ? 'Workflow 已設定' : '尚未設定 Workflow ID';
  const id = new URLSearchParams(location.hash.slice(1)).get('task');
  if (id && /^[A-Za-z0-9_-]{1,128}$/.test(id)) attach(id);
}).catch(error => feedback(`初始化失敗：${error.message}`, true));
setInterval(poll, sleepMs);
