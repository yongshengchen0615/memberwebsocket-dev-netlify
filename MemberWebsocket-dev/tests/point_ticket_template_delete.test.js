const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('admin/index.html');
const admin = read('admin/app.js');
const api = read('supabase/functions/api/index.ts');
const migration = read('supabase/migrations/20261010130000_admin_delete_point_ticket_template.sql');

test('ticket library delete action only appears after selecting a saved template', () => {
  assert.match(html, /id="deleteTicketButton"[^>]*class="button button-danger hidden"[^>]*disabled/);
  assert.match(admin, /els\.deleteTicketButton\.addEventListener\('click', deleteTicket\)/);
  assert.match(admin, /function loadTicketForm\([\s\S]*?els\.deleteTicketButton\.classList\.remove\('hidden'\)/);
  assert.match(admin, /function resetTicketForm\([\s\S]*?els\.deleteTicketButton\.classList\.add\('hidden'\)/);
  assert.match(admin, /function lockAdminWrites\(\)[^\n]*els\.deleteTicketButton/);
});

test('admin delete uses versioned API request with clear conflict feedback', () => {
  assert.match(admin, /function deleteTicket\(\)[\s\S]*?'admin\.tickets\.delete'/);
  assert.match(admin, /ticketTemplateId, expectedUpdatedAt: els\.ticketExpectedUpdatedAt\.value/);
  assert.match(admin, /preservedTicketCount/);
  assert.match(api, /"admin\.tickets\.delete"/);
  assert.match(api, /if \(action === "admin\.tickets\.delete"\)/);
  assert.match(api, /if \(!action\.startsWith\("admin\."\)\)[\s\S]*?authorizeAdmin\(supabase,identity\)/);
  assert.match(api, /supabase\.rpc\("delete_point_ticket_template"/);
  assert.match(api, /TICKET_TEMPLATE_IN_USE/);
});

test('database deletion is atomic, respects reward links, and preserves issued ticket history', () => {
  assert.match(migration, /security definer/);
  assert.match(migration, /for update/);
  assert.match(migration, /v_template\.updated_at is distinct from v_expected/);
  assert.match(migration, /from public\.point_card_rewards[\s\S]*?ticket_template_id = v_template\.id/);
  assert.match(migration, /TICKET_TEMPLATE_IN_USE/);
  assert.match(migration, /from public\.point_tickets[\s\S]*?ticket_template_id = v_template\.id/);
  assert.match(migration, /delete from public\.ticket_templates where id = v_template\.id/);
  assert.match(migration, /TICKET_TEMPLATE_DELETED/);
  assert.match(migration, /grant execute[\s\S]*to service_role/);
  assert.match(migration, /revoke all[\s\S]*from public, anon, authenticated/);
  assert.doesNotMatch(migration, /delete from public\.point_tickets/);
});
