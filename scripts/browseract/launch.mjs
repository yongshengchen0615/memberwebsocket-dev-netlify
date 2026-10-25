import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { createBrowserActClient } from './core.mjs';
import { createViewerServer } from './live-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENV_PATH = join(ROOT, '.env.browseract.local');
const DEFAULT_URL = 'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/';

export function loadLocalConfig(file = ENV_PATH, exists = existsSync, load = loadEnvFile) {
  if (exists(file)) load(file);
  return exists(file);
}

export function openBrowser(url, platform = process.platform, spawnImpl = spawn) {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawnImpl(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch { return false; }
}

export function launchViewer({ env = process.env, clientFactory = createBrowserActClient, listen = true, open = openBrowser, silent = false } = {}) {
  const port = Number(env.BROWSERACT_VIEWER_PORT || '4173');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BROWSERACT_VIEWER_PORT 必須是有效的連接埠');
  const baseUrl = env.BROWSERACT_BASE_URL || DEFAULT_URL;
  const allowedOrigins = (env.BROWSERACT_ALLOWED_ORIGINS || new URL(baseUrl).origin).split(',').map(x => x.trim());
  const ready = Boolean(env.BROWSERACT_API_KEY && env.BROWSERACT_WORKFLOW_ID);
  const client = env.BROWSERACT_API_KEY ? clientFactory({ apiKey: env.BROWSERACT_API_KEY }) : {
    start: async () => { throw new Error('尚未設定 BROWSERACT_API_KEY'); },
    get: async () => { throw new Error('尚未設定 BROWSERACT_API_KEY'); },
    stop: async () => { throw new Error('尚未設定 BROWSERACT_API_KEY'); },
    resume: async () => { throw new Error('尚未設定 BROWSERACT_API_KEY'); }
  };
  const server = createViewerServer({ client, workflowId: ready ? env.BROWSERACT_WORKFLOW_ID : undefined, defaultUrl: baseUrl, allowedOrigins });
  if (listen) server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    if (!silent) {
      console.log(`BrowserAct 即時驗收監控台：${url}`);
      console.log(ready ? '已設定 API Key 與 Workflow ID，可以啟動遠端測試。' : '設定尚未齊全；先展示監控台。請依 README 設定 BrowserAct 後重新啟動。');
    }
    if (!env.BROWSERACT_NO_OPEN && !process.argv.includes('--no-open')) open(url);
  });
  return { server, ready };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  loadLocalConfig();
  launchViewer();
}
