import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'MemberWebsocket-dev');
const output = path.join(root, 'dist');
const publicDirectories = new Set(['admin', 'booking', 'calendar', 'event', 'member', 'points', 'vendor']);
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
console.log('Built static frontend in dist; database source, tests and internal documentation excluded.');
