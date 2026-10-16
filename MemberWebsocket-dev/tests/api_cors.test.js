const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '../supabase/functions/api/index.ts'),
  'utf8'
);
const start = source.indexOf('function env(name: string): string {');
const end = source.indexOf('function json(origin: string | null,');
assert.ok(start >= 0 && end > start, 'Production CORS helper boundaries must exist');

const sourceHelpers = source.slice(start, end)
  .replace('function env(name: string): string', 'function env(name)')
  .replace('function allowedOrigins(): Set<string>', 'function allowedOrigins()')
  .replace('function corsHeaders(origin: string | null): HeadersInit', 'function corsHeaders(origin)');

function createCors(configured = '') {
  const context = {
    Deno: { env: { get: (name) => name === 'ALLOWED_ORIGINS' ? configured : '' } },
    Set
  };
  return vm.runInNewContext(sourceHelpers + '\n({ allowedOrigins, corsHeaders })', context);
}

const githubPages = 'https://yongshengchen0615.github.io';
const production = 'https://memberwebsocket-dev-netlify.netlify.app';
const develop = 'https://develop--memberwebsocket-dev-netlify.netlify.app';

test('AC-API-CORS-001: recognized GitHub Pages, production and develop origins get a CORS response', () => {
  const { allowedOrigins, corsHeaders } = createCors();
  for (const origin of [githubPages, production, develop]) {
    assert.equal(allowedOrigins().has(origin), true, origin);
    assert.equal(corsHeaders(origin)['Access-Control-Allow-Origin'], origin);
  }
});

test('AC-API-CORS-002: extra configured origins preserve the deployed frontend origins', () => {
  const extra = 'https://approved.example';
  const { allowedOrigins, corsHeaders } = createCors(' ' + extra + ' , ');
  for (const origin of [githubPages, production, develop, extra]) {
    assert.equal(allowedOrigins().has(origin), true, origin);
    assert.equal(corsHeaders(origin)['Access-Control-Allow-Origin'], origin);
  }
});

test('AC-API-CORS-003: OPTIONS preflight includes required headers and methods', () => {
  const headers = createCors().corsHeaders(develop);
  const response = new Response(null, { status: 204, headers });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), develop);
  const methods = response.headers.get('access-control-allow-methods').split(',');
  for (const method of ['POST', 'GET', 'OPTIONS']) assert.ok(methods.includes(method));
  const accepted = response.headers.get('access-control-allow-headers').split(',').map(s => s.trim());
  for (const header of ['content-type', 'apikey']) assert.ok(accepted.includes(header));
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('AC-API-CORS-004: unapproved, lookalike and insecure origins stay forbidden', () => {
  const { allowedOrigins, corsHeaders } = createCors();
  for (const origin of [
    'http://develop--memberwebsocket-dev-netlify.netlify.app',
    'https://develop--memberwebsocket-dev-netlify.netlify.app.attacker.example',
    'https://arbitrary--memberwebsocket-dev-netlify.netlify.app',
    'null'
  ]) {
    assert.equal(allowedOrigins().has(origin), false, origin);
    assert.equal(corsHeaders(origin)['Access-Control-Allow-Origin'], '', origin);
  }
  assert.equal(allowedOrigins().has('*'), false);
  assert.equal(corsHeaders(null)['Access-Control-Allow-Origin'], '');
});

test('AC-API-CORS-005: the API still rejects unrecognized browser origins before handling requests', () => {
  assert.match(source, /if\s*\(origin\s*&&\s*!allowedOrigins\(\)\.has\(origin\)\)\s*throw\s+new ApiError\(403,\s*"ORIGIN_NOT_ALLOWED"/);
  assert.match(source, /if\s*\(request\.method\s*===\s*"OPTIONS"\)\s*return\s+new Response\(null,\s*\{\s*status:\s*204,\s*headers:\s*corsHeaders\(origin\)/);
});
