import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDate, formatBuildVersion } from './build-version.mjs';
import { buildMemberRuntime } from './preview-member-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'MemberWebsocket-dev');
const output = path.join(root, 'dist');
const publicDirectories = new Set(['admin', 'platform', 'booking', 'frontdesk', 'calendar', 'event', 'member', 'points', 'vendor']);
const publicFile = /\.(?:html|css|js|json|svg|png|jpe?g|webp|gif|ico|txt|woff2?)$/i;
const retiredPublicQaAssets = new Set([
  'test-mode-client.js', 'test-mode.css', 'user-test-control.js',
  'user-test-control.css', 'e2e-feature-coverage.js',
  'e2e-scenario-graph.js', 'e2e-professional-tester.js',
]);
const retiredAdminAssets = new Set([
  'test-mode.js','test-mode.css','test-control.js','test-control.css',
  'test-workspace-tabs.js','test-workspace-tabs.css','e2e-control.js',
  'e2e-control.css','e2e-control-loader.js','e2e-flow-visualizer.js',
  'e2e-flow-visualizer.css',
]);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (entry.isDirectory() ? publicDirectories.has(entry.name) : publicFile.test(entry.name) && entry.name !== 'config.json') {
    await cp(path.join(source, entry.name), path.join(output, entry.name), {
      recursive: true,
      filter: async (file) => !path.basename(file).startsWith('.')
        && !(path.dirname(file) === source && retiredPublicQaAssets.has(path.basename(file)))
        && !(path.relative(source,file).startsWith(`admin${path.sep}`) && retiredAdminAssets.has(path.basename(file)))
        && ((await stat(file)).isDirectory() || publicFile.test(file)),
    });
  }
}

// This is the only deployed configuration source; do not read/copy the
// legacy top-level MemberWebsocket-dev/config.json, even for local builds.
const publishedRuntime = buildMemberRuntime(process.env);
const serializedRuntime = JSON.stringify(publishedRuntime, null, 2) + '\n';
const runtimeConfigPath = path.join(output, 'config', 'config.json');
await mkdir(path.dirname(runtimeConfigPath), { recursive: true });
await writeFile(runtimeConfigPath, serializedRuntime);
// Compatibility for older clients still requesting /config.json; all new
// application reads use /config/config.json. Both contain identical values.
await writeFile(path.join(output, 'config.json'), serializedRuntime);
const runtimeConfig = publishedRuntime;

// A stale config or a reintroduced switch must fail the release build, even
// when the current source config would leave that branch dormant.
const retiredApiRoute = /\/functions\/v1\/(?:[\w-]+-preview|test-mode-api|test-control-api|user-test-api|e2e-artifact-api|e2e-artifact-retention)\b/;
const publishedConfig = publishedRuntime;
for (const [key, value] of Object.entries(publishedConfig)) {
  if (typeof value === 'string' && retiredApiRoute.test(value)) {
    throw new Error(`Retired API routing in runtime config: ${key}`);
  }
}
for (const file of await readdir(output, { recursive: true })) {
  if (!/\.(?:js|html)$/i.test(file)) continue;
  const contents = await readFile(path.join(output, file), 'utf8');
  if (retiredApiRoute.test(contents) || /\b(?:bookingPreviewApis|previewApiFunctionUrl)\b/.test(contents)) {
    throw new Error(`Retired API routing in public asset: ${file}`);
  }
}

const siteVersion = formatBuildVersion(
  buildDate(process.env),
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
  'frontdesk/index.html',
  'booking/admin/index.html',
];
for (const entry of entryPages) {
  const page = path.join(output, entry);
  const relative = path.relative(path.dirname(page), output).split(path.sep).join('/');
  const base = relative ? `${relative}/` : './';
  // Receipt images must be allowed from the same project as the built API.
  // A merged config.json can contain the other project's URL. Normalize
  // both known project origins in CSP and receipt HTML to the selected build.
  const html = (await readFile(page, 'utf8'))
    .replaceAll(runtimeConfig.supabaseUrl, publishedConfig.supabaseUrl)
    .replace(/https:\/\/(?:dbuquirnaskrwcamdxki|bmwhojszsnxliekkhrka)\.supabase\.co/g, publishedConfig.supabaseUrl);
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
// Fail the whole build if a stale frontend asset still points at the
// opposite database, even if the generated /config.json is correct.
const forbiddenRef = publishedConfig.supabaseUrl.includes('dbuquirnaskrwcamdxki')
  ? 'bmwhojszsnxliekkhrka' : publishedConfig.supabaseUrl.includes('bmwhojszsnxliekkhrka')
    ? 'dbuquirnaskrwcamdxki' : null;
if (forbiddenRef) {
  for (const file of await readdir(output, { recursive: true })) {
    if (!/\.(?:html|js|json|css)$/i.test(file)) continue;
    const content = await readFile(path.join(output, file), 'utf8');
    if (content.includes(`https://${forbiddenRef}.supabase.co`)) {
      throw new Error(`Cross-environment Supabase URL in published asset: ${file}`);
    }
  }
}

console.log(`Built static frontend in dist (version ${siteVersion}); database source, tests and internal documentation excluded.`);

