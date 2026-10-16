const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/scheduled-grant-messages/index.ts'), 'utf8');
const code = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, ''));
const row = { id: '11111111-1111-4111-8111-111111111111', member_id: 'fixture-member', line_user_id: 'fixture-line', request_id: 'FIXED-fixture', schedule_id: 'fixture', message_text: '固定票券', attempt_count: 1 };

function fixture({ url = '', status = 200, acceptedId = '', testMember = false, rows = [row], delivery = {action:'send'}, deliveryError = false } = {}) {
  const calls = [];
  const updates = [];
  let handler;
  const db = {
    async rpc(name) {
      if (name === 'fixed_ticket_notification_delivery') return { data:delivery, error:deliveryError ? new Error('fixture failure') : null };
      if (name === 'claim_due_grant_messages') return { data: rows, error: null };
      if (name === 'get_line_messaging_token') return { data: 'fixture-channel-token', error: null };
      if (name === 'get_line_setting') return { data: url, error: null };
      if (name === 'member_service_minute_totals') return { data: [{ member_id:row.member_id,total_minutes:0 }], error:null };
      throw new Error(name);
    },
    from(table) {
      let value = [];
      if (table === 'members') value = { is_test_account: testMember };
      if (table === 'membership_tier_settings') value = [{ tier_key: 'general', tier_label: '一般會員', required_service_minutes: 0 }];
      const query = {
        select() { return query; }, eq() { return query; }, order() { return query; }, maybeSingle() { return query; },
        insert() { return query; },
        update(patch) { updates.push(patch); return query; },
        then(resolve, reject) { return Promise.resolve({ data: value, error: null }).then(resolve, reject); },
      };
      return query;
    },
  };
  vm.runInNewContext(code, {
    Deno: { env: { get: (key) => key === 'GRANT_MESSAGE_DISPATCH_SECRET' ? 'fixture-secret' : 'fixture-config' }, serve: (value) => { handler = value; } },
    createClient: () => db,
    buildLineFlexNotice: () => ({ type: 'flex', contents: { header: { backgroundColor: '#315D50' }, body: { type: 'box', contents: [] }, footer: { type: 'box', contents: [] } } }),
    replaceCurrentGrantSections: (text) => text,
    buildLatestAvailableOffersSection: async () => '',
    TextEncoder, Request, Response, Headers, AbortSignal, crypto: webcrypto,
    fetch: async (_input, init) => {
      calls.push({ retryKey: new Headers(init.headers).get('X-Line-Retry-Key'), body: JSON.parse(init.body), signal: init.signal });
      return new Response('', { status, headers: acceptedId ? { 'x-line-accepted-request-id': acceptedId } : {} });
    },
  });
  const dispatch = () => handler(new Request('https://fixture.test', { method: 'POST', headers: { 'x-dispatch-secret': 'fixture-secret' } }));
  return { calls, updates, dispatch, handler };
}

test('scheduled fixed-ticket dispatch uses the configured LINE URL and completes without a runtime reference error', async () => {
  const { calls, updates, dispatch } = fixture({ url: 'https://liff.line.me/fixture-liff' });
  const response = await dispatch();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sent, 1);
  assert.equal(calls[0].body.messages[0].contents.footer.contents[0].action.uri, 'https://liff.line.me/fixture-liff');
  assert.equal(calls[0].retryKey, row.id);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(updates.at(-1).status, 'sent');
});

test('fixed-ticket send checks disabled, changed, deferred and failed eligibility without pushing LINE', async () => {
  for (const options of [
    {delivery:{action:'cancel',reason:'FIXED_NOTIFICATION_DISABLED'}},
    {delivery:{action:'cancel',reason:'FIXED_MEMBER_INELIGIBLE'}},
    {delivery:{action:'skip',reason:'FIXED_NOTIFICATION_CHANGED'}},
    {delivery:{action:'defer',scheduledFor:'2099-01-01T10:00:00Z'}},
    {deliveryError:true},
  ]) {
    const {calls,updates,dispatch}=fixture(options);
    const body=await (await dispatch()).json();
    assert.equal(calls.length,0);
    assert.equal(body.sent,0);
    if (options.delivery?.action==='cancel') assert.equal(updates.at(-1).status,'cancelled');
    if (options.delivery?.action==='defer') assert.equal(updates.at(-1).scheduled_for,options.delivery.scheduledFor);
    if (options.deliveryError) assert.equal(body.failed,1);
  }
});

test('an empty LINE URL setting keeps the existing LIFF fallback', async () => {
  const { calls, dispatch } = fixture();
  await dispatch();
  assert.equal(calls[0].body.messages[0].contents.footer.contents[0].action.uri, 'https://liff.line.me/2010787602-tuapstY3');
});

test('scheduled retries keep the same job UUID, and LINE 409 acceptance finishes the job', async () => {
  const first = fixture({ status: 503 });
  const second = fixture({ status: 409, acceptedId: 'original-accepted' });
  assert.equal((await (await first.dispatch()).json()).failed, 1);
  assert.equal((await (await second.dispatch()).json()).sent, 1);
  assert.equal(first.calls[0].retryKey, second.calls[0].retryKey);
  assert.equal(second.updates.at(-1).line_request_id, 'original-accepted');
});

test('a plain LINE 409 cannot be reported as delivered', async () => {
  const { updates, dispatch } = fixture({ status: 409 });
  assert.equal((await (await dispatch()).json()).failed, 1);
  assert.equal(updates.at(-1).status, 'pending');
});

test('test accounts never reach LINE, and empty queues return without sending', async () => {
  for (const options of [{ testMember: true }, { rows: [] }]) {
    const { calls, dispatch } = fixture(options);
    assert.equal((await dispatch()).status, 200);
    assert.equal(calls.length, 0);
  }
});

test('scheduled dispatcher rejects a missing dispatch secret before claiming work', async () => {
  const { calls, handler } = fixture();
  const response = await handler(new Request('https://fixture.test', { method: 'POST' }));
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});
