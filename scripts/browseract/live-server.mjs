import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createBrowserActClient, publicTask, validateTarget, validateTaskId, validateScenario } from './core.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BROWSERACT_VIEWER_PORT || '4173');
const DEFAULT_URL = process.env.BROWSERACT_BASE_URL || 'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/';

function respond(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}
async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('只接受 application/json');
  let size = 0, content = '';
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error('請求資料過大');
    content += chunk.toString();
  }
  return JSON.parse(content);
}

export function createViewerServer({ client, workflowId, defaultUrl = DEFAULT_URL, allowedOrigins = [new URL(defaultUrl).origin], port = PORT } = {}) {
  if (!client) throw new Error('缺少 BrowserAct Client');
  const scenarios = new Map();
  const contentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src https:; frame-src https:; base-uri 'none'; form-action 'self'";
  return createHttpServer(async (req, res) => {
    const host = req.headers.host;
    const actualPort = req.socket.localPort;
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) return respond(res, 403, { error: '禁止非本機來源' });
    res.setHeader('Content-Security-Policy', contentSecurityPolicy);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const isWrite = ['POST', 'PUT'].includes(req.method);
    if (isWrite && req.headers.origin !== `http://${host}`) return respond(res, 403, { error: '來源驗證失敗' });
    try {
      if (req.method === 'GET' && pathname === '/api/config') {
        return respond(res, 200, { configured: Boolean(workflowId), baseUrl: defaultUrl });
      }
      if (req.method === 'POST' && pathname === '/api/tasks') {
        if (!workflowId) return respond(res, 503, { error: '尚未設定 BROWSERACT_WORKFLOW_ID' });
        const body = await readJson(req);
        const scenarioId = validateScenario(body.scenarioId);
        const baseUrl = validateTarget(body.baseUrl || defaultUrl, allowedOrigins);
        const task = await client.start({ workflowId, scenarioId, baseUrl });
        scenarios.set(task.id, scenarioId);
        return respond(res, 201, { id: task.id });
      }
      const match = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(stop|resume))?$/);
      if (match) {
        const id = validateTaskId(decodeURIComponent(match[1]));
        if (req.method === 'GET' && !match[2]) {
          const task = await client.get(id);
          return respond(res, 200, publicTask(task, scenarios.get(id)));
        }
        if (req.method === 'PUT' && (match[2] === 'stop' || match[2] === 'resume')) {
          await client[match[2]](id);
          return respond(res, 200, { ok: true });
        }
      }
      if (req.method === 'GET' && (pathname === '/' || pathname === '/app.js' || pathname === '/style.css')) {
        const name = pathname === '/' ? 'index.html' : pathname.slice(1);
        const file = await readFile(join(ROOT, 'public', name));
        res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(file);
      }
      return respond(res, 404, { error: '找不到資源' });
    } catch (error) {
      const message = String(error.message || '操作失敗');
      const badInput = /無效|必須|只接受|過大|不在允許|Unexpected token|JSON/.test(message);
      return respond(res, badInput ? 400 : 502, { error: message.slice(0, 160) });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const allowedOrigins = (process.env.BROWSERACT_ALLOWED_ORIGINS || new URL(DEFAULT_URL).origin).split(',').map(x => x.trim());
  const client = createBrowserActClient({ apiKey: process.env.BROWSERACT_API_KEY });
  createViewerServer({ client, workflowId: process.env.BROWSERACT_WORKFLOW_ID, allowedOrigins, port: PORT })
    .listen(PORT, '127.0.0.1', () => {
      console.log(`BrowserAct Live Viewer: http://127.0.0.1:${PORT}`);
      console.log('所有 BrowserAct API 呼叫均由本機伺服器處理；請勿公開監控台網址。');
    });
}
