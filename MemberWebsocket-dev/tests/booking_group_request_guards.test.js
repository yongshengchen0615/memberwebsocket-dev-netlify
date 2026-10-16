const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../supabase/functions');
const groupApi = fs.readFileSync(path.join(root, 'booking-group-api/index.ts'), 'utf8');
const slotApi = fs.readFileSync(path.join(root, 'booking-group-slots-api/index.ts'), 'utf8');
const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/test-memberwebsocket-dev.yml'), 'utf8');

test('group booking APIs use the shared streaming request guard', () => {
  for (const [name, source] of [['booking-group-api', groupApi], ['booking-group-slots-api', slotApi]]) {
    assert.match(source, /import \{ readJsonObject \} from "\.\.\/_shared\/request-body\.ts";/, name);
    assert.match(source, /readJsonObject\([^\n]+MAX_REQUEST_BYTES[^\n]+ApiError\)/, name);
    assert.doesNotMatch(source, /await (?:req|request)\.text\(\)/, name);
  }
});

test('group booking endpoints consume the shared per-identity rate limit before expensive routing', () => {
  assert.match(groupApi, /consume_api_rate_limit/);
  assert.match(groupApi, /WRITE_ACTIONS\.has\(action\)/);
  assert.match(groupApi, /await consumeRateLimit\(supabase,identity,action\);[\s\S]*?await route\(supabase,identity,clientType,action,body\)/);

  assert.match(slotApi, /consume_api_rate_limit/);
  assert.match(slotApi, /p_is_write:\s*false/);
  assert.match(slotApi, /await consumeRateLimit\(supabase, lineUserId\);[\s\S]*?await activeMember\(supabase, lineUserId\)/);
});

test('CI type-checks both group booking Edge Functions', () => {
  assert.match(workflow, /deno check[\s\\]+[\s\S]*MemberWebsocket-dev\/supabase\/functions\/booking-group-api\/index\.ts/);
  assert.match(workflow, /deno check[\s\\]+[\s\S]*MemberWebsocket-dev\/supabase\/functions\/booking-group-slots-api\/index\.ts/);
});
