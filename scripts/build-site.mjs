import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatBuildVersion } from './build-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'MemberWebsocket-dev');
const output = path.join(root, 'dist');
const publicDirectories = new Set(['admin', 'platform', 'booking', 'calendar', 'event', 'member', 'points', 'vendor', 'v2']);
const publicFile = /\.(?:html|css|js|json|svg|png|jpe?g|webp|gif|ico|txt|woff2?)$/i;

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (entry.isDirectory() ? publicDirectories.has(entry.name) : publicFile.test(entry.name)) {
    await cp(path.join(source, entry.name), path.join(output, entry.name), {
      recursive: true,
      filter: async (file) => !path.basename(file).startsWith('.') && ((await stat(file)).isDirectory() || publicFile.test(file)),
    });
  }
}

const siteVersion = formatBuildVersion(
  new Date(),
  process.env.DEPLOY_ID || process.env.BUILD_ID || randomBytes(6).toString('hex'),
);
const commit = /^[a-f\d]{7,40}$/i.test(process.env.COMMIT_REF || '')
  ? process.env.COMMIT_REF.slice(0, 7).toLowerCase()
  : 'local';
const entryPages = [
  'index.html',
  'admin/index.html',
  'admin/workspace.html',
  'platform/index.html',
  'member/index.html',
  'points/index.html',
  'event/index.html',
  'calendar/index.html',
  'booking/index.html',
  'booking/admin/index.html',
  'v2/index.html',
  'v2/admin/index.html',
  'v2/platform/index.html',
];
for (const entry of entryPages) {
  const page = path.join(output, entry);
  const relative = path.relative(path.dirname(page), output).split(path.sep).join('/');
  const base = relative ? `${relative}/` : './';
  const html = await readFile(page, 'utf8');
  if (!html.includes('</head>') || !html.includes('</body>')) {
    throw new Error(`Missing HTML head or body: ${entry}`);
  }
  // Render during the build, not after DOMContentLoaded: works in restrictive
  // mobile WebViews without script execution or unsafe-inline CSP exemptions.
  const stylesheet = `  <link rel="stylesheet" href="${base}version-badge.css?v=${siteVersion}">`;
  const badge = `  <small id="site-build-version" class="site-build-version" role="note" aria-label="網站部署版本 ${siteVersion}" data-commit="${commit}">${siteVersion}</small>`;
  await writeFile(
    page,
    html.replace('</head>', `${stylesheet}\n</head>`).replace('</body>', `${badge}\n</body>`),
  );
}
console.log(`Built static frontend in dist (version ${siteVersion}); database source, tests and internal documentation excluded.`);
