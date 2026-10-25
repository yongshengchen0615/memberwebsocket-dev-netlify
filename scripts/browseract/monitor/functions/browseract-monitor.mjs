import { createHash, timingSafeEqual } from 'node:crypto';
import { createBrowserActClient, publicTask, validateScenario, validateTarget, validateTaskId } from '../../core.mjs';

const SITE_DEFAULT = 'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/';
const METHODS = new Map([['config', 'GET'], ['task', 'GET'], ['start', 'POST'], ['stop', 'POST'], ['resume', 'POST']]);
const asJson = (body, status = 200) => Response.json(body, { status, headers: {
  'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
}});

export function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length < 32) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
function readToken(request) {
  const auth = request.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}
function originMatches(request) {
  const origin = request.headers.get('origin');
  return origin === new URL(request.url).origin;
}
async function parseBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('JSON_CONTENT_TYPE');
  const raw = await request.text();
  if (raw.length > 8192) throw new Error('BODY_TOO_LARGE');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('INVALID_JSON'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('INVALID_JSON');
  return parsed;
}
function settings(env) {
  return {
    accessToken: env('BROWSERACT_MONITOR_ACCESS_TOKEN'),
    apiKey: env('BROWSERACT_API_KEY'),
    workflowId: env('BROWSERACT_WORKFLOW_ID'),
    baseUrl: env('BROWSERACT_BASE_URL') || SITE_DEFAULT,
    allowedOrigins: (env('BROWSERACT_ALLOWED_ORIGINS') || new URL(SITE_DEFAULT).origin).split(',').map(s => s.trim()).filter(Boolean),
    humanEnabled: env('BROWSERACT_HUMAN_HANDOFF_ENABLED') === 'true',
  };
}

export function createMonitorHandler({ env = key => globalThis.Netlify?.env?.get(key) || process.env[key], clientFactory = createBrowserActClient } = {}) {
  return async function monitor(request) {
    const target = new URL(request.url);
    const action = target.searchParams.get('action') || '';
    if (!METHODS.has(action)) return asJson({ error: 'UNKNOWN_ACTION' }, 404);
    if (request.method !== METHODS.get(action)) return asJson({ error: 'METHOD_NOT_ALLOWED' }, 405);
    const s = settings(env);
    if (!s.accessToken || s.accessToken.length < 32) return asJson({ error: 'ACCESS_NOT_CONFIGURED' }, 503);
    if (!tokenMatches(readToken(request), s.accessToken)) return asJson({ error: 'UNAUTHORIZED' }, 401);
    if (request.method !== 'GET' && !originMatches(request)) return asJson({ error: 'INVALID_ORIGIN' }, 403);
    if (action === 'config') {
      return asJson({ configured: Boolean(s.apiKey && s.workflowId), baseUrl: s.baseUrl, handoffEnabled: s.humanEnabled, humanModeRequiresCheckpoint: true });
    }
    if (!s.apiKey || !s.workflowId) return asJson({ error: 'BROWSERACT_NOT_CONFIGURED' }, 503);
    try {
      const client = clientFactory({ apiKey: s.apiKey });
      if (action === 'start') {
        const body = await parseBody(request);
        const scenarioId = validateScenario(body.scenarioId);
        const baseUrl = validateTarget(body.baseUrl || s.baseUrl, s.allowedOrigins);
        const handoffMode = body.handoffMode === 'human' ? 'human' : 'auto';
        if (body.handoffMode != null && !['human', 'auto'].includes(body.handoffMode)) throw new Error('INVALID_HANDOFF_MODE');
        if (handoffMode === 'human' && !s.humanEnabled) return asJson({ error: 'HUMAN_HANDOFF_NOT_CONFIGURED' }, 409);
        const result = await client.start({ workflowId: s.workflowId, baseUrl, scenarioId, handoffMode });
        return asJson({ id: validateTaskId(result.id), handoffMode }, 201);
      }
      const id = validateTaskId(target.searchParams.get('id'));
      const task = await client.get(id);
      if (action === 'task') return asJson(publicTask(task));
      if (action === 'resume' && task.status !== 'paused') return asJson({ error: 'TASK_NOT_PAUSED' }, 409);
      if (action === 'stop' && !['created', 'running', 'pausing', 'paused'].includes(task.status)) return asJson({ error: 'TASK_NOT_RUNNING' }, 409);
      await client[action](id);
      return asJson({ ok: true, action });
    } catch (err) {
      if (/^(INVALID_JSON|BODY_TOO_LARGE|JSON_CONTENT_TYPE|INVALID_HANDOFF_MODE)$/.test(err.message) || /無效|格式|不在允許|必須/.test(err.message)) return asJson({ error: 'INVALID_INPUT' }, 400);
      console.error('BrowserAct monitor upstream failure', { name: err.name, code: 'UPSTREAM_FAILURE' });
      return asJson({ error: 'BROWSERACT_UNAVAILABLE' }, 502);
    }
  };
}
export default createMonitorHandler();
export const config = { rateLimit: { action: 'rate_limit', aggregateBy: 'ip', windowSize: 60, windowLimit: 90 } };
