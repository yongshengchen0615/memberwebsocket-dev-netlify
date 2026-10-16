import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { formatBuildVersion } from './build-version.mjs';

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


test('deployment versions are valid and change for each new deployment', () => {
  const fixed = new Date('2026-10-16T07:45:23.000Z');
  const first = formatBuildVersion(fixed, 'deploy-ABC123');
  const second = formatBuildVersion(fixed, 'deploy-XYZ789');
  assert.equal(first, 'v261016.074523-abc123');
  assert.equal(second, 'v261016.074523-xyz789');
  assert.notEqual(first, second);
  assert.notEqual(first, formatBuildVersion(new Date('2026-10-16T07:45:24.000Z'), 'deploy-ABC123'));
  assert.throws(() => formatBuildVersion(new Date('not-a-date'), 'deploy-ABC123'), TypeError);
  assert.throws(() => formatBuildVersion(fixed, 'oops'), TypeError);
});

test('every published entry has the same build version and correctly linked badge assets', () => {
  const pages = ['index.html', 'admin/index.html', 'member/index.html', 'points/index.html', 'event/index.html', 'calendar/index.html', 'booking/index.html', 'booking/admin/index.html'];
  const versions = new Set();
  for (const page of pages) {
    const html = fs.readFileSync(path.join(output, page), 'utf8');
    const match = html.match(/<script src="([^"]*version-badge\.js\?v=([^"]+))" data-site-version="([^"]+)" data-commit="([^"]+)" defer><\/script>/);
    assert.ok(match, `${page}: badge script not injected`);
    const [, source, queryVersion, attributeVersion, commit] = match;
    assert.equal(queryVersion, attributeVersion, `${page}: version mismatch`);
    assert.match(attributeVersion, /^v\d{6}\.\d{6}-[a-z0-9]{6}$/);
    assert.match(commit, /^(?:local|[a-f0-9]{7})$/);
    const badgeAsset = path.resolve(output, path.dirname(page), source.split('?')[0]);
    assert.equal(badgeAsset, path.join(output, 'version-badge.js'));
    const css = html.match(/<link rel="stylesheet" href="([^"]*version-badge\.css\?v=([^"]+))">/);
    assert.ok(css, `${page}: badge stylesheet not injected`);
    assert.equal(css[2], attributeVersion);
    assert.equal(path.resolve(output, path.dirname(page), css[1].split('?')[0]), path.join(output, 'version-badge.css'));
    versions.add(attributeVersion);
  }
  assert.equal(versions.size, 1, 'all entrypoints must use the exact same deployment version');
  const css = fs.readFileSync(path.join(output, 'version-badge.css'), 'utf8');
  assert.match(css, /position:\s*fixed/);
  assert.match(css, /pointer-events:\s*none/);
  assert.match(css, /safe-area-inset-bottom/);
});

test('badge is rendered once after DOM readiness with a text-only version', () => {
  const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  const version = html.match(/data-site-version="([^"]+)"/)[1];
  const script = fs.readFileSync(path.join(output, 'version-badge.js'), 'utf8');
  const nodes = [];
  let onReady;
  const document = {
    currentScript: { getAttribute: name => name === 'data-site-version' ? version : null },
    readyState: 'loading',
    body: { appendChild: node => nodes.push(node) },
    getElementById: id => nodes.find(node => node.id === id),
    createElement: tagName => ({ tagName, setAttribute(name, value) { this[name] = value; } }),
    addEventListener(name, cb, opts) { assert.equal(name, 'DOMContentLoaded'); assert.equal(opts.once, true); onReady = cb; },
  };
  runInNewContext(script, { document });
  assert.equal(nodes.length, 0, 'the script should wait for DOM readiness');
  onReady();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].textContent, version);
  assert.equal(nodes[0].className, 'site-build-version');
  assert.equal(nodes[0].tagName, 'small');
  onReady();
  assert.equal(nodes.length, 1, 'never produce duplicate badges');
});
