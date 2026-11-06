const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'admin/app.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'supabase/functions/api/index.ts'), 'utf8');
const tabs = fs.readFileSync(path.join(root, 'admin/member-workspace-tabs.js'), 'utf8');

test('activity timeline moves from Member 360 modal to usage workspace, retaining categories', () => {
  const modal = html.slice(html.indexOf('id="memberRecordsModal"'), html.indexOf('id="grantModal"'));
  const panel = html.slice(html.indexOf('id="memberUsagePanel"'), html.indexOf('id="memberTierSettingsPanel"'));
  assert.doesNotMatch(modal, /id="memberRecordsList"/);
  assert.match(modal, /id="memberRecordsOpenUsage"/);
  assert.match(panel, /id="memberRecordsList"/);
  for (const category of ['all','presence','pointCards','eventTickets','calendar','bookings']) {
    assert.match(panel, new RegExp('data-record-filter="' + category + '"'));
  }
});

test('member usage picker supports kinds, filtered API pagination and selecting a member', () => {
  for (const id of ['memberUsageSearch','memberUsageSelect','memberUsagePrev','memberUsageNext','memberUsagePageStatus']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(app, /memberPageSize: 100, memberQuery: usage\.query, memberKind: 'real'/);
  assert.doesNotMatch(html, /id="memberUsageKind"/);
  assert.match(app, /state\.memberUsage\.members\.find\(\(item\) => item\.lineUserId === els\.memberUsageSelect\.value\)/);
  assert.match(app, /openMemberRecordsModal\(member, false\)/);
});

test('history and roster reject stale responses during rapid member switches or search', () => {
  assert.match(app, /const requestVersion = \+\+state\.memberRecords\.requestVersion/);
  assert.match(app, /requestVersion !== state\.memberRecords\.requestVersion/);
  assert.match(app, /const requestVersion = \+\+usage\.requestVersion/);
  assert.match(app, /if \(requestVersion !== usage\.requestVersion\) return/);
  assert.match(app, /clearMemberUsageHistory\(\)/);
  assert.match(tabs, /window\.MemberWorkspaceTabs = Object\.freeze/);
});

test('usage requests retain server-side administrator authorization', () => {
  assert.match(app, /'admin\.members\.list'/);
  assert.match(app, /'admin\.member-records\.list'/);
  const auth = api.indexOf('const admin = await authorizeAdmin(supabase,identity);');
  const roster = api.indexOf('action === "admin.members.list"');
  const history = api.indexOf('action === "admin.member-records.list"');
  assert.ok(auth >= 0 && roster > auth && history > auth);
  assert.match(api, /return await adminMemberRecords\(supabase,requireText\(body\.lineUserId/);
});
