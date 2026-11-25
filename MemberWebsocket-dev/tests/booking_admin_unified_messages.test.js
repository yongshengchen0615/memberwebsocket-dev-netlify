const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ui = read('admin/booking-panel-core.js');
const api = read('supabase/functions/booking-admin-api/index.ts');
const css = read('admin/booking-panel.css');

const messagePanelStart = ui.indexOf('<section id="bookingAdminMessagesPanel"');
const riskPanelStart = ui.indexOf('<section id="bookingAdminRiskPanel"', messagePanelStart);
const messagePanel = ui.slice(messagePanelStart, riskPanelStart);
const settingsPanel = ui.slice(ui.indexOf('<section id="bookingAdminSettingsPanel"'), messagePanelStart);
const messagesHandler = api.slice(api.indexOf('async function messagesSave('), api.indexOf('async function settingsSave('));
const sharedHandler = api.slice(api.indexOf('async function settingsSave('), api.indexOf('function normalizeRewardRule('));

test('AC-BMSG-001: message settings is a separate accessible booking subtab', () => {
  assert.ok(messagePanelStart > 0 && riskPanelStart > messagePanelStart);
  assert.match(ui, /id="bookingAdminMessagesSubtab"[^>]+role="tab"[^>]+aria-controls="bookingAdminMessagesPanel"/);
  assert.match(messagePanel, /id="bookingAdminMessagesPanel"[^>]+role="tabpanel"[^>]+aria-labelledby="bookingAdminMessagesSubtab"/);
  assert.match(ui, /const allowed = \['technicians', 'services', 'settings', 'messages', 'risk', 'queue'\]/);
  assert.match(ui, /messages: \[els\.bookingAdminMessagesSubtab, els\.bookingAdminMessagesPanel\]/);
  assert.match(css, /booking-admin-messages-layout/);
});

test('AC-BMSG-002: the four texts share one form and submit button', () => {
  assert.equal((messagePanel.match(/<form id="bookingAdminMessagesForm"/g) || []).length, 1);
  assert.equal((messagePanel.match(/type="submit"/g) || []).length, 1);
  assert.equal((messagePanel.match(/id="bookingAdminMessagesSave"/g) || []).length, 1);
  for (const id of ['bookingAdminNotice', 'bookingAdminOnsiteEditMessage', 'bookingAdminPendingMessage', 'bookingAdminReminderMessage']) {
    assert.match(messagePanel, new RegExp('id="' + id + '"'));
    assert.doesNotMatch(settingsPanel, new RegExp('id="' + id + '"'));
  }
  assert.doesNotMatch(messagePanel,/bookingAdminRejectionMessage|預約未通過訊息/);
  assert.doesNotMatch(messagePanel, /id="bookingAdminPendingMessageSave"|id="bookingAdminRejectionMessageSave"|id="bookingAdminReminderMessageSave"/);
  assert.match(ui, /els\.bookingAdminMessagesForm\.addEventListener\('submit', saveMessages\)/);
  assert.match(ui, /manageRequest\('admin\.booking\.messages\.save'/);
  assert.match(ui, /\.\.\.fields,\s*expectedUpdatedAt: state\.messagesDraftVersion/);
});

test('AC-BMSG-003: one API operation validates message texts before a single CAS database update', () => {
  assert.match(api, /action === "admin\.booking\.messages\.save"\) return await messagesSave\(supabase, identity, body\)/);
  assert.match(api, /await authorizeAdmin\(supabase, identity\)/);
  assert.match(api, /await consumeRateLimit\(supabase, identity/);
  for (const [key, column] of [
    ['bookingNotice', 'booking_notice'],
    ['pendingMessage', 'pending_message'],
    ['reminderMessage', 'reminder_message'],
  ]) {
    assert.match(messagesHandler, /typeof body\[key\] !== "string"/);
    assert.match(messagesHandler, new RegExp(column + ': ' + key));
  }
  assert.equal((messagesHandler.match(/\.update\(/g) || []).length, 1);
  assert.match(messagesHandler, /\.eq\("id", 1\)\.eq\("updated_at", expectedUpdatedAt\)/);
  assert.match(messagesHandler, /if \(!result\.data\) throw new ApiError\(409, "BOOKING_SETTINGS_CONFLICT"/);
  assert.match(messagesHandler, /if \(!pendingMessage\.trim\(\) \|\| pendingMessage\.length > 400\)/);
  assert.match(messagesHandler,/REJECTION_SETTINGS_MOVED/);
  assert.doesNotMatch(messagesHandler,/rejection_message:\s*rejectionMessage/);
  assert.doesNotMatch(ui,/bookingAdminRejectionMessage/);
  assert.match(messagesHandler, /if \(!reminderMessage\.trim\(\) \|\| reminderMessage\.length > 400\)/);
  assert.match(messagesHandler, /BOOKING_MESSAGES_UPDATED/);
  assert.match(messagesHandler, /onsite_edit_message: onsiteEditMessage/);
  assert.match(messagesHandler, /INVALID_ONSITE_EDIT_MESSAGE/);
  assert.match(messagesHandler, /hasOnsiteEditMessage \? \{ onsite_edit_message/);
  assert.match(ui, /const MESSAGE_INPUT_IDS = \['bookingAdminNotice','bookingAdminOnsiteEditMessage'/);
});

test('AC-BMSG-004: unsaved drafts and concurrent updates cannot silently overwrite message text', () => {
  assert.match(ui, /if \(state\.messagesDirty && !force\)/);
  assert.match(ui, /state\.messagesDraftVersion = String\(settings\.updatedAt \|\| ''\)/);
  assert.match(ui, /state\.messagesDirty = currentMessagesSignature\(\) !== state\.messagesBaseline/);
  assert.match(ui, /els\.bookingAdminMessagesDiscard\.addEventListener\('click'/);
  assert.match(ui, /state\.messagesSaving = true/);
  assert.match(ui, /state\.messagesSaving = false/);
  assert.match(ui, /本頁草稿已保留/);
  assert.match(sharedHandler, /body\.bookingNotice === undefined/);
  assert.match(sharedHandler, /String\(legacyReminder\.data\.booking_notice \|\| ""\)/);
  assert.match(sharedHandler, /p_booking_notice: bookingNotice/);
  assert.doesNotMatch(ui.slice(ui.indexOf('async function saveSettings('), ui.indexOf('window.addEventListener(\'member-admin:features-updated\'')), /bookingNotice,/);
});
