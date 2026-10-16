import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, ['scripts/build-site.mjs'], { cwd: root });
const output = path.join(root, 'dist');

test('all seven application entry pages are published', () => {
  for (const surface of ['', 'admin', 'member', 'points', 'event', 'calendar', 'booking']) {
    assert.ok(fs.existsSync(path.join(output, surface, 'index.html')), surface || 'home');
  }
});

test('published HTML references resolve to files inside the frontend', () => {
  let checked = 0;
  for (const name of fs.readdirSync(output, { recursive: true })) {
    if (!name.endsWith('.html')) continue;
    const file = path.join(output, name);
    const html = fs.readFileSync(file, 'utf8');
    for (const [, value] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) continue;
      const relative = decodeURIComponent(value.split(/[?#]/)[0]);
      if (!relative) continue;
      const target = path.resolve(relative.startsWith('/') ? output : path.dirname(file), relative.replace(/^\//, ''));
      assert.ok(target === output || target.startsWith(output + path.sep), `${name}: outside output ${value}`);
      assert.ok(fs.existsSync(target), `${name}: missing ${value}`);
      checked++;
    }
  }
  assert.ok(checked > 100, `Expected real asset validation; checked ${checked}`);
});

test('server source, migrations, tests and local deployment state are not published', () => {
  for (const excluded of ['supabase', 'tests', 'docs', '.git', '.netlify', '.env']) {
    assert.equal(fs.existsSync(path.join(output, excluded)), false, excluded);
  }
  assert.equal(fs.readdirSync(output, { recursive: true }).some(name => /\.(?:sql|ts|md)$/.test(name)), false);
});

test('frontend backend settings are copied without changing identity or project', () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'config.json'))), JSON.parse(fs.readFileSync(path.join(root, 'MemberWebsocket-dev/config.json'))));
});
