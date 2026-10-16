const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const edgeSource = fs.readFileSync(path.join(__dirname, '../supabase/functions/user-test-api/index.ts'), 'utf8');
const handlerSource = stripTypeScriptTypes(edgeSource.slice(edgeSource.lastIndexOf('Deno.serve(async (request: Request) => {')));

function edgeHandler(identitySurface) {
  let handler;
  let writes = 0;
  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }
  const context = {
    Deno: { serve(fn) { handler = fn; } },
    Response,
    ApiError,
    TestModeAuthError: class extends Error {},
    corsHeaders: () => ({}),
    allowedOrigins: () => new Set(),
    readJsonObject: async (request) => request.body,
    asText: (value) => String(value || ''),
    SURFACES: new Set(['member', 'points', 'event', 'calendar', 'booking']),
    MAX_REQUEST_BYTES: 65536,
    db: () => ({}),
    resolveTestSession: async () => ({ surface: identitySurface, isTestAccount: true }),
    prepareHumanFixture: async () => { writes++; return { fixtureTag: 'TEST' }; },
    reply: (_, payload) => ({ status: payload.status, ...payload }),
    failReply: (_, error) => ({ status: error.status, error: { code: error.code } }),
  };
  vm.runInNewContext(handlerSource, context);
  return { request: (surface) => handler({
    method: 'POST', headers: new Headers(),
    body: { action: 'user.qa.fixture.prepare', surface, testSessionToken: 'valid-session' }
  }), writes: () => writes };
}

test('a valid test session cannot prepare a fixture for a different surface', async () => {
  const edge = edgeHandler('member');
  const result = await edge.request('points');
  assert.equal(result.status, 409);
  assert.equal(result.error.code, 'TEST_SESSION_SURFACE_MISMATCH');
  assert.equal(edge.writes(), 0);
});

test('the same surface still reaches the authorized fixture handler', async () => {
  const edge = edgeHandler('member');
  const result = await edge.request('member');
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.equal(edge.writes(), 1);
});
