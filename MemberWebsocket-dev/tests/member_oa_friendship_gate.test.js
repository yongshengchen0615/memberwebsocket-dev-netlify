const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const verifier = import(pathToFileURL(path.join(__dirname, '../supabase/functions/_shared/member-oa-friendship.mjs')).href);
const uid = 'U' + 'a'.repeat(32);
const channel = '2010787602';
const token = 'only-for-synthetic-test';
const ok = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
function harness(overrides = {}) {
  const requests = [];
  const fixtures = [ok({client_id:channel,scope:'openid profile',expires_in:100}), ok({userId:uid}), ok({friendFlag:true})];
  const fetchImpl = async (url, opts) => {
    requests.push({url:String(url),opts});
    if (overrides.throwAt === requests.length) throw Error('synthetic network outage');
    const item = overrides.at?.[requests.length - 1];
    return item || fixtures[requests.length - 1];
  };
  return { requests, run: (extra = {}) => verifier.then(v => v.verifyMemberOaFriendship({expectedChannelId:channel,expectedLineUserId:uid,memberOaLinked:true,accessToken:token,fetchImpl,...extra})) };
}
async function rejected(run, code, status) {
  await assert.rejects(run, error => {assert.equal(error.code,code);assert.equal(error.status,status);assert.doesNotMatch(error.message,/only-for-synthetic-test/);return true;});
}
test('FJG01: verified tenant/channel, user ID and linked member OA permit friendship', async () => {
  const h = harness();
  assert.equal(await h.run(),true);
  assert.equal(h.requests.length,3);
  assert.match(h.requests[0].url,/^https:\/\/api\.line\.me\/oauth2\/v2\.1\/verify\?/);
  assert.equal(h.requests[1].url,'https://api.line.me/v2/profile');
  assert.equal(h.requests[2].url,'https://api.line.me/friendship/v1/status');
  assert.equal(h.requests[2].opts.headers.Authorization,'Bearer '+token);
});
test('FJG01: missing link or client config fails closed before LINE requests', async () => {
  const h = harness();
  await rejected(h.run({memberOaLinked:false}),'MEMBER_OA_CONFIG_INCOMPLETE',503);
  await rejected(h.run({expectedChannelId:''}),'MEMBER_OA_CONFIG_INCOMPLETE',503);
  assert.equal(h.requests.length,0);
});
test('FJG01: server-verified identity is required, no client-supplied friendFlag can bypass', async () => {
  const h = harness();
  await rejected(h.run({expectedLineUserId:'other-provider-id',friendFlag:true}),'AUTH_INVALID',401);
  assert.equal(h.requests.length,0);
});
test('FJG01: token belongs to another channel or lacks profile scope', async () => {
  for (const bad of [{client_id:'2010787603',scope:'openid',expires_in:100},{client_id:channel,scope:'openid',expires_in:100},{client_id:channel,scope:'profile',expires_in:0}]) {
    const h=harness({at:[ok(bad)]});
    await rejected(h.run(),'LINE_CHANNEL_OR_SCOPE_MISMATCH',401);
    assert.equal(h.requests.length,1);
  }
});
test('FJG01: mismatched profile sub never reaches friendship status', async () => {
  const h=harness({at:[null,ok({userId:'U'+'b'.repeat(32)})]});
  await rejected(h.run(),'LINE_IDENTITY_MISMATCH',401);
  assert.equal(h.requests.length,2);
});
test('FJG01: not a friend or blocked OA denies registration', async () => {
  const h=harness({at:[null,null,ok({friendFlag:false})]});
  await rejected(h.run(),'MEMBER_OA_FRIENDSHIP_REQUIRED',403);
});
test('FJG01: malformed friendship response and LINE rate limit fail closed', async () => {
  for(const reply of [ok({}),ok({},429),ok({},503)]) {
    const h=harness({at:[null,null,reply]});
    await rejected(h.run(),'LINE_FRIENDSHIP_UNAVAILABLE',503);
  }
});
test('FJG01: invalid or expired token, network failure and missing token fail closed', async () => {
  const unauthorized=harness({at:[ok({},401)]});
  await rejected(unauthorized.run(),'LINE_ACCESS_TOKEN_INVALID',401);
  const outage=harness({throwAt:2});
  await rejected(outage.run(),'LINE_FRIENDSHIP_UNAVAILABLE',503);
  const missing=harness();
  await rejected(missing.run({accessToken:''}),'LINE_ACCESS_TOKEN_REQUIRED',401);
});
