const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./helpers/edge-test-fs.cjs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the production CORS helpers in a sandbox instead of mirroring their logic.
const source = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'test-mode-api', 'index.ts'),
  'utf8'
);
const start = source.indexOf('function env(name: string): string {');
const end = source.indexOf('function reply(origin: string | null,');
assert.ok(start !== -1 && end > start, 'CORS helper source range must exist');

const snippet = source.slice(start, end)
  .replace('function env(name: string): string', 'function env(name)')
  .replace('function allowedOrigins(): Set<string>', 'function allowedOrigins()')
  .replace('function corsHeaders(origin: string | null): HeadersInit', 'function corsHeaders(origin)');

function loadCors(allowedOriginsEnv = '') {
  const context = {
    Deno: { env: { get: (key) => key === 'ALLOWED_ORIGINS' ? allowedOriginsEnv : '' } },
    Set
  };
  return vm.runInNewContext(snippet + '\n({ allowedOrigins, corsHeaders })', context);
}

const github = 'https://yongshengchen0615.github.io';
const netlify = 'https://memberwebsocket-dev-netlify.netlify.app';
const develop = 'https://develop--memberwebsocket-dev-netlify.netlify.app';

test('AC-001: GitHub Pages and exact Netlify production/develop origins are allowed', () => {
  const { allowedOrigins, corsHeaders } = loadCors();
  for (const origin of [github, netlify, develop]) {
    assert.ok(allowedOrigins().has(origin), origin);
    assert.equal(corsHeaders(origin)['Access-Control-Allow-Origin'], origin);
  }
});

test('AC-002: an additional ALLOWED_ORIGINS value does not remove deployed Netlify origins', () => {
  const extra = 'https://another-allowed.example';
  const { allowedOrigins, corsHeaders } = loadCors('  ' + extra + ' , ');
  for (const origin of [github, netlify, develop, extra]) {
    assert.ok(allowedOrigins().has(origin), origin);
    assert.equal(corsHeaders(origin)['Access-Control-Allow-Origin'], origin);
  }
});

test('AC-003: unknown and lookalike origins are not allowed', () => {
  const { corsHeaders, allowedOrigins } = loadCors();
  for (const origin of [
    'https://develop--memberwebsocket-dev-netlify.netlify.app.attacker.example',
    'https://other--memberwebsocket-dev-netlify.netlify.app',
    'http://develop--memberwebsocket-dev-netlify.netlify.app',
    'null'
  ]) {
    assert.equal(corsHeaders(origin)['Access-Control-Allow-Origin'], '', origin);
    assert.equal(allowedOrigins().has(origin), false, origin);
  }
  assert.equal(corsHeaders(null)['Access-Control-Allow-Origin'], '');
  assert.equal(allowedOrigins().has('*'), false);
});

test('AC-004: preflight response returns required methods, requested headers, and Vary', () => {
  const { corsHeaders } = loadCors();
  const response = new Response(null, { status: 204, headers: corsHeaders(develop) });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), develop);
  assert.equal(response.headers.get('access-control-allow-methods'), 'POST,OPTIONS');
  const requestHeaders = response.headers.get('access-control-allow-headers');
  for (const header of ['content-type', 'apikey']) {
    assert.ok(requestHeaders.split(',').map((v) => v.trim()).includes(header), header);
  }
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
