import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prefix = 'MemberWebsocket-dev/supabase/';
const functionPrefix = prefix + 'functions/';
const migrationPrefix = prefix + 'migrations/';
const shaPattern = /^[a-f\d]{40}$/;

function fail(message) { throw new Error('Production promotion blocked: ' + message); }

export function parseNameStatus(buffer) {
  const tokens = buffer.toString('utf8').split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) fail('invalid git diff status');
    const oldPath = tokens[i++];
    const renamed = status.startsWith('R') || status.startsWith('C');
    const filename = renamed ? tokens[i++] : oldPath;
    if (!filename || (renamed && !oldPath)) fail('incomplete git diff');
    changes.push({ status: status[0], path: filename, originalPath: renamed ? oldPath : undefined });
  }
  return changes;
}

function relativeImports(source) {
  const pattern = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  const matches = [];
  for (const match of source.matchAll(pattern)) {
    const name = match.slice(1).find(Boolean);
    if (name?.startsWith('.')) matches.push(name);
  }
  return matches;
}

function dependenciesFor(entry, functionRoot, seen = new Set()) {
  const real = path.resolve(entry);
  if (seen.has(real) || !existsSync(real) || !statSync(real).isFile()) return seen;
  // Only follow files from the checked-in functions source tree.
  if (!real.startsWith(path.resolve(functionRoot) + path.sep)) fail('function import escapes source tree');
  seen.add(real);
  const source = readFileSync(real, 'utf8');
  for (const spec of relativeImports(source)) {
    const candidate = path.resolve(path.dirname(real), spec);
    for (const filename of [candidate, candidate + '.ts', candidate + '.mjs', candidate + '.js',
      path.join(candidate, 'index.ts')]) {
      if (existsSync(filename) && statSync(filename).isFile()) {
        dependenciesFor(filename, functionRoot, seen);
        break;
      }
    }
  }
  return seen;
}

export function makePromotionPlan(changes, { root = repoRoot, base = '', head = '' } = {}) {
  if (!Array.isArray(changes)) fail('changes must be an array');
  const functionRoot = path.join(root, functionPrefix);
  const retirementFile = path.join(root, prefix, 'retirement/retired-endpoints.json');
  const retired = new Set(JSON.parse(readFileSync(retirementFile, 'utf8')).retiredFunctions);
  const active = readdirSync(functionRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== '_shared' &&
      existsSync(path.join(functionRoot, d.name, 'index.ts')) && !retired.has(d.name))
    .map(d => d.name);
  const migrations = [];
  const affected = new Set();
  const shared = [];
  for (const entry of changes) {
    const filename = entry.path;
    const status = entry.status;
    if (typeof filename !== 'string' || typeof status !== 'string') fail('malformed changed path');
    if (filename.startsWith(migrationPrefix)) {
      if (status !== 'A' || !/^\d{14}_[a-z0-9_]+\.sql$/.test(filename.slice(migrationPrefix.length)))
        fail('historical migration modified, removed, renamed, or invalid: ' + filename);
      migrations.push(filename);
    } else if (filename.startsWith(functionPrefix)) {
      const remainder = filename.slice(functionPrefix.length);
      const functionName = remainder.split('/')[0];
      if (functionName === '_shared') shared.push(filename);
      else if (retired.has(functionName)) fail('retired function requires a separately approved tombstone release: ' + functionName);
      else if (active.includes(functionName)) affected.add(functionName);
      else fail('changed function has no deployable entrypoint: ' + filename);
    } else if (filename.startsWith(prefix) && !/\.(md|txt)$/i.test(filename)) {
      // No unclassified Supabase configuration, seed, type, or runtime changes
      // may be treated as a frontend-only production release.
      fail('Supabase runtime/security or retirement configuration requires separate review: ' + filename);
    }
  }
  if (shared.length) {
    const deps = new Map(active.map(name => [
      name,
      dependenciesFor(path.join(functionRoot, name, 'index.ts'), functionRoot),
    ]));
    for (const item of shared) {
      const absolute = path.join(root, item);
      let found = false;
      for (const [name, files] of deps) {
        if (files.has(path.resolve(absolute))) { affected.add(name); found = true; }
      }
      if (!found) fail('shared dependency cannot be proven to be deployed: ' + item);
    }
  }
  return { base, head, environment: 'production', migrations: [...new Set(migrations)].sort(),
    functions: [...affected].sort() };
}

export function collectPromotionPlan(base, head, root = repoRoot) {
  if (!shaPattern.test(base) || !shaPattern.test(head) || base === head)
    fail('expected two distinct 40-character commit IDs');
  const output = execFileSync('git', ['diff', '--name-status', '-z', '--find-renames', base, head], {
    cwd: root, maxBuffer: 10 * 1024 * 1024,
  });
  return makePromotionPlan(parseNameStatus(output), { root, base, head });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const plan = collectPromotionPlan(process.argv[2], process.argv[3]);
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
